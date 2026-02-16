import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const marker = "<!-- desktop-perf-trace-summary -->";
const defaultPerfProjects = [
  {
    id: "perf-project-1",
    cwd: "/tmp/perf/codething-mvp",
    name: "codething-mvp",
  },
  {
    id: "perf-project-2",
    cwd: "/tmp/perf/contracts-bench",
    name: "contracts-bench",
  },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  let postPr = false;
  let seedPath = null;

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--post-pr") {
      postPr = true;
      continue;
    }
    if (arg === "--seed") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--seed requires a file path");
      }
      seedPath = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--seed=")) {
      const value = arg.slice("--seed=".length).trim();
      if (value.length === 0) {
        throw new Error("--seed= requires a non-empty path");
      }
      seedPath = value;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    postPr,
    seedPath,
  };
}

function toMs(us) {
  return us / 1000;
}

function round(n, digits = 3) {
  return Number(n.toFixed(digits));
}

function mb(bytes) {
  return bytes / (1024 * 1024);
}

function summarizeTrace(tracePath) {
  const payload = JSON.parse(fs.readFileSync(tracePath, "utf8"));
  const events = payload.traceEvents;

  const durationByName = new Map();
  const dispatchRows = [];
  const functionRows = [];
  const userTiming = new Map();
  const updateCounters = [];

  for (const event of events) {
    if (event.name === "UpdateCounters" && event.args?.data) {
      const heap = event.args.data.jsHeapSizeUsed;
      if (typeof heap === "number") {
        updateCounters.push(heap);
      }
    }

    if (event.cat === "blink.user_timing" && typeof event.name === "string") {
      userTiming.set(event.name, (userTiming.get(event.name) ?? 0) + 1);
    }

    if (event.ph !== "X" || typeof event.dur !== "number" || typeof event.name !== "string") {
      continue;
    }

    const byName = durationByName.get(event.name) ?? { count: 0, dur: 0, max: 0 };
    byName.count += 1;
    byName.dur += event.dur;
    byName.max = Math.max(byName.max, event.dur);
    durationByName.set(event.name, byName);

    if (event.name === "EventDispatch") {
      const type = event.args?.data?.type ?? "";
      dispatchRows.push({ type, dur: event.dur });
    }

    if (event.name === "FunctionCall") {
      const functionName = event.args?.data?.functionName ?? "(unknown)";
      functionRows.push({ functionName, dur: event.dur });
    }
  }

  const aggregateDispatchType = (type) => {
    const rows = dispatchRows.filter((row) => row.type === type);
    if (rows.length === 0) {
      return {
        count: 0,
        totalMs: 0,
        avgMs: 0,
        maxMs: 0,
      };
    }
    const totalDur = rows.reduce((sum, row) => sum + row.dur, 0);
    const maxDur = rows.reduce((max, row) => Math.max(max, row.dur), 0);
    return {
      count: rows.length,
      totalMs: round(toMs(totalDur)),
      avgMs: round(toMs(totalDur / rows.length)),
      maxMs: round(toMs(maxDur)),
    };
  };

  const aggregateFunction = (name) => {
    const rows = functionRows.filter((row) => row.functionName === name);
    if (rows.length === 0) {
      return {
        count: 0,
        totalMs: 0,
        avgMs: 0,
        maxMs: 0,
      };
    }
    const totalDur = rows.reduce((sum, row) => sum + row.dur, 0);
    const maxDur = rows.reduce((max, row) => Math.max(max, row.dur), 0);
    return {
      count: rows.length,
      totalMs: round(toMs(totalDur)),
      avgMs: round(toMs(totalDur / rows.length)),
      maxMs: round(toMs(maxDur)),
    };
  };

  const topUserTiming = [...userTiming.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, count]) => ({ name, count }));

  const topDurationEvents = [...durationByName.entries()]
    .map(([name, value]) => ({
      name,
      count: value.count,
      totalMs: round(toMs(value.dur), 2),
      avgMs: round(toMs(value.dur / value.count)),
      maxMs: round(toMs(value.max)),
    }))
    .sort((a, b) => b.totalMs - a.totalMs)
    .slice(0, 10);

  const heap = (() => {
    if (updateCounters.length === 0) return null;
    const first = updateCounters[0];
    const last = updateCounters[updateCounters.length - 1];
    const min = Math.min(...updateCounters);
    const max = Math.max(...updateCounters);
    return {
      firstMb: round(mb(first), 1),
      lastMb: round(mb(last), 1),
      minMb: round(mb(min), 1),
      maxMb: round(mb(max), 1),
      deltaMb: round(mb(last - first), 1),
    };
  })();

  const longDispatchCount = dispatchRows.filter((row) => row.dur >= 50_000).length;

  return {
    keypress: aggregateDispatchType("keypress"),
    textInput: aggregateDispatchType("textInput"),
    input: aggregateDispatchType("input"),
    keydown: aggregateDispatchType("keydown"),
    dispatchDiscreteEvent: aggregateFunction("dispatchDiscreteEvent"),
    performWorkUntilDeadline: aggregateFunction("performWorkUntilDeadline"),
    longDispatchCount,
    heap,
    topUserTiming,
    topDurationEvents,
  };
}

function createMarkdownSummary({ tracePath, donePayload, summary, thresholds }) {
  const THREAD_COL_WIDTH = 8;
  const TITLE_COL_WIDTH = 15;
  const pad = (value, width) => String(value).padEnd(width, " ");
  const largeThreadRenderStats = Array.isArray(donePayload.interactions?.largeThreadRenderStats)
    ? donePayload.interactions.largeThreadRenderStats
    : [];
  const formatThreadRenderRow = (stat) => {
    const threadShort =
      typeof stat.threadId === "string" ? stat.threadId.slice(0, THREAD_COL_WIDTH) : "n/a";
    const titleShort =
      typeof stat.threadTitleShort === "string"
        ? stat.threadTitleShort
        : typeof stat.threadId === "string"
          ? stat.threadId.slice(0, 15)
          : "n/a";
    const firstRenderMs =
      typeof stat.firstRenderMs === "number"
        ? stat.firstRenderMs
        : typeof stat.renderMs === "number"
          ? stat.renderMs
          : "n/a";
    const followUpRenderMs = typeof stat.followUpRenderMs === "number" ? stat.followUpRenderMs : "n/a";
    const followUpMinMs = typeof stat.followUpMinMs === "number" ? stat.followUpMinMs : "n/a";
    const followUpMaxMs = typeof stat.followUpMaxMs === "number" ? stat.followUpMaxMs : "n/a";
    const followUpSampleCount =
      typeof stat.followUpSampleCount === "number" ? stat.followUpSampleCount : "n/a";
    const deltaMs =
      typeof stat.deltaMs === "number" ? stat.deltaMs : "n/a";
    const deltaPct = typeof stat.deltaPct === "number" ? stat.deltaPct : "n/a";
    const followUpRange =
      typeof followUpMinMs === "number" && typeof followUpMaxMs === "number"
        ? `${followUpMinMs}-${followUpMaxMs} (${followUpSampleCount}x)`
        : "n/a";
    return `| ${pad(threadShort, THREAD_COL_WIDTH)} | ${pad(titleShort, TITLE_COL_WIDTH)} | ${stat.messageCount} | ${firstRenderMs} | ${followUpRenderMs} | ${followUpRange} | ${deltaMs} | ${deltaPct}% |`;
  };
  const seedSource =
    donePayload.seed?.source === "file"
      ? `file (\`${donePayload.seed?.path ?? "unknown"}\`)`
      : donePayload.seed?.source ?? "generated";
  const lines = [
    marker,
    "## Desktop Dev Perf Trace",
    "",
    `- Command: \`bun dev:desktop\``,
    `- Trace: \`${tracePath}\``,
    `- Started: ${donePayload.startedAt ?? "n/a"}`,
    `- Completed: ${donePayload.completedAt ?? "n/a"}`,
    `- Duration: ${donePayload.durationMs ?? "n/a"} ms`,
    `- Seed source: ${seedSource}`,
    "",
    "### Interaction Run",
    "",
    `- Thread clicks: ${donePayload.interactions?.threadClicks ?? "n/a"}`,
    `- Typed chars: ${donePayload.interactions?.typedChars ?? "n/a"}`,
    `- Model selected: ${donePayload.interactions?.selectedModel ?? "n/a"}`,
    `- Terminal opened by shortcut: ${donePayload.interactions?.terminal?.openedByShortcut ?? "n/a"}`,
    `- Terminal shortcut modifier: ${donePayload.interactions?.terminal?.modifierUsed ?? "n/a"}`,
    `- Terminal splits: ${donePayload.interactions?.terminal?.splitCount ?? "n/a"}`,
    `- Terminal command executed: ${donePayload.interactions?.terminal?.commandFileTouched ?? "n/a"}`,
    `- Terminal output observed: ${donePayload.interactions?.terminal?.commandEchoObserved ?? "n/a"}`,
    `- Terminal marker: ${donePayload.interactions?.terminal?.commandMarker ?? "n/a"}`,
    "",
    "### Benchmark Thread Render",
    "",
    "| Thread | Title (15) | Messages | First Nav (ms) | Follow-up Median (ms) | Follow-up Range | Delta (ms) | Delta (%) |",
    "| --- | --- | ---: | ---: | ---: | --- | ---: | ---: |",
    ...(largeThreadRenderStats.length > 0
      ? largeThreadRenderStats.map((stat) => formatThreadRenderRow(stat))
      : ["| n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |"]),
    "",
    "### Input Event Metrics",
    "",
    "| Event | Count | Avg (ms) | Max (ms) | Total (ms) |",
    "| --- | ---: | ---: | ---: | ---: |",
    `| keypress | ${summary.keypress.count} | ${summary.keypress.avgMs} | ${summary.keypress.maxMs} | ${summary.keypress.totalMs} |`,
    `| textInput | ${summary.textInput.count} | ${summary.textInput.avgMs} | ${summary.textInput.maxMs} | ${summary.textInput.totalMs} |`,
    `| input | ${summary.input.count} | ${summary.input.avgMs} | ${summary.input.maxMs} | ${summary.input.totalMs} |`,
    `| keydown | ${summary.keydown.count} | ${summary.keydown.avgMs} | ${summary.keydown.maxMs} | ${summary.keydown.totalMs} |`,
    "",
    "### Scheduler/Event Hotspots",
    "",
    `- dispatchDiscreteEvent: ${summary.dispatchDiscreteEvent.totalMs}ms total (${summary.dispatchDiscreteEvent.count} calls)`,
    `- performWorkUntilDeadline: ${summary.performWorkUntilDeadline.totalMs}ms total (${summary.performWorkUntilDeadline.count} calls)`,
    `- EventDispatch spikes >= 50ms: ${summary.longDispatchCount}`,
    "",
    "### Threshold Check",
    "",
    `- keypress avg <= ${thresholds.maxKeypressAvgMs}ms: ${
      summary.keypress.avgMs <= thresholds.maxKeypressAvgMs ? "pass" : "fail"
    }`,
    `- keypress max <= ${thresholds.maxKeypressMaxMs}ms: ${
      summary.keypress.maxMs <= thresholds.maxKeypressMaxMs ? "pass" : "fail"
    }`,
    `- long dispatch spikes <= ${thresholds.maxLongDispatchCount}: ${
      summary.longDispatchCount <= thresholds.maxLongDispatchCount ? "pass" : "fail"
    }`,
    "",
  ];

  if (summary.heap) {
    lines.push("### Heap Counters", "");
    lines.push(
      `- first=${summary.heap.firstMb}MB, last=${summary.heap.lastMb}MB, min=${summary.heap.minMb}MB, max=${summary.heap.maxMb}MB, delta=${summary.heap.deltaMb}MB`,
      "",
    );
  }

  lines.push("### Top User Timing Marks", "");
  for (const entry of summary.topUserTiming) {
    lines.push(`- ${entry.count}x ${entry.name}`);
  }
  lines.push("", "### Top Duration Events", "");
  for (const entry of summary.topDurationEvents) {
    lines.push(
      `- ${entry.name}: total=${entry.totalMs}ms, avg=${entry.avgMs}ms, max=${entry.maxMs}ms, count=${entry.count}`,
    );
  }
  lines.push("");

  return lines.join("\n");
}

async function waitForDoneFile(donePath, child, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (fs.existsSync(donePath)) {
      return JSON.parse(fs.readFileSync(donePath, "utf8"));
    }
    if (child.exitCode !== null) {
      throw new Error(`desktop dev process exited early (code ${child.exitCode})`);
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for done marker at ${donePath}`);
}

function tailLogText(logChunks, lineCount = 120) {
  const lines = logChunks.join("").split(/\r?\n/);
  return lines.slice(-lineCount).join("\n").trim();
}

function inferDesktopPerfTimeoutHint(logChunks) {
  const joined = logChunks.join("");
  const lowered = joined.toLowerCase();

  if (lowered.includes("error while loading shared libraries")) {
    return "Electron failed to start due missing Linux shared libraries.";
  }
  if (lowered.includes("no usable sandbox")) {
    return "Electron sandbox failed to initialize in CI.";
  }
  if (lowered.includes("port is already in use")) {
    return "Dev server port collision prevented Electron from loading the renderer.";
  }
  if (!joined.includes("[desktop-perf]")) {
    return "Desktop perf automation never started; Electron likely did not boot successfully.";
  }
  if (joined.includes("[desktop-perf]") && !joined.includes("[desktop-perf] trace recorded")) {
    return "Desktop perf automation started but did not complete trace recording.";
  }

  return "Desktop perf automation timed out before writing the done marker.";
}

async function terminateProcessTree(child) {
  if (child.exitCode !== null) return;

  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      child.kill("SIGTERM");
    }
    return;
  }

  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }

  await sleep(1_500);
  if (child.exitCode === null) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

function detectPrNumber() {
  const githubRef = process.env.GITHUB_REF ?? "";
  const match = githubRef.match(/refs\/pull\/(\d+)\//);
  if (match?.[1]) {
    return match[1];
  }

  return execFileSync("gh", ["pr", "view", "--json", "number", "--jq", ".number"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
}

function postSummaryToPr(summaryPath) {
  const prNumber = detectPrNumber();
  execFileSync(
    "gh",
    ["pr", "comment", prNumber, "--body-file", summaryPath, "--edit-last", "--create-if-none"],
    {
      cwd: repoRoot,
      stdio: "inherit",
    },
  );
}

function prepareDesktopPerfState(stateDir, perfProjects = defaultPerfProjects) {
  fs.mkdirSync(stateDir, { recursive: true });

  for (const project of perfProjects) {
    try {
      fs.mkdirSync(project.cwd, { recursive: true });
    } catch {
      // Some seeded paths may point to unavailable locations in CI; registry entries still work.
    }
  }

  const now = new Date().toISOString();
  fs.writeFileSync(
    path.join(stateDir, "projects.json"),
    JSON.stringify(
      {
        version: 1,
        projects: perfProjects.map((project) => ({
          id: project.id,
          cwd: project.cwd,
          name: project.name,
          createdAt: now,
          updatedAt: now,
        })),
      },
      null,
      2,
    ),
  );
}

function resolveSeedPath(seedPathArg) {
  const candidateArg = seedPathArg ?? process.env.T3CODE_DESKTOP_PERF_SEED_PATH ?? "";
  if (!candidateArg || candidateArg.trim().length === 0) {
    const defaultCandidates = ["scripts/perf-seed.json", "apps/desktop/scripts/perf-seed.json"];
    for (const candidate of defaultCandidates) {
      const resolved = path.resolve(repoRoot, candidate);
      if (fs.existsSync(resolved)) {
        return resolved;
      }
    }
    return null;
  }

  const resolved = path.isAbsolute(candidateArg)
    ? candidateArg
    : path.resolve(repoRoot, candidateArg);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Seed file not found: ${resolved}`);
  }
  return resolved;
}

function extractProjectsFromSeed(seedPath) {
  const raw = JSON.parse(fs.readFileSync(seedPath, "utf8"));
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.projects)) {
    return null;
  }

  const projects = raw.projects
    .map((project) => {
      if (!project || typeof project !== "object") return null;
      const id = typeof project.id === "string" ? project.id : "";
      const cwd = typeof project.cwd === "string" ? project.cwd : "";
      const name = typeof project.name === "string" ? project.name : "";
      if (id.length === 0 || cwd.length === 0 || name.length === 0) return null;
      return { id, cwd, name };
    })
    .filter((project) => project !== null);

  if (projects.length === 0) {
    return null;
  }

  return projects;
}

async function main() {
  const args = parseArgs(process.argv);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const artifactsDir = path.join(os.tmpdir(), "t3code-perf-artifacts", `desktop-dev-${timestamp}`);
  fs.mkdirSync(artifactsDir, { recursive: true });

  const tracePath = path.join(artifactsDir, "trace.json");
  const donePath = path.join(artifactsDir, "done.json");
  const summaryPath = path.join(artifactsDir, "summary.md");
  const logPath = path.join(artifactsDir, "run.log");
  const stateDir = path.join(artifactsDir, "state");
  const seedPath = resolveSeedPath(args.seedPath);
  const seedProjects = seedPath ? extractProjectsFromSeed(seedPath) : null;
  prepareDesktopPerfState(stateDir, seedProjects ?? defaultPerfProjects);

  const maxKeypressAvgMs = Number(process.env.T3CODE_PERF_MAX_KEYPRESS_AVG_MS ?? "12");
  const maxKeypressMaxMs = Number(process.env.T3CODE_PERF_MAX_KEYPRESS_MAX_MS ?? "24");
  const maxLongDispatchCount = Number(process.env.T3CODE_PERF_MAX_LONG_DISPATCH_COUNT ?? "0");
  const timeoutMs = Number(process.env.T3CODE_PERF_TIMEOUT_MS ?? "240000");

  const child = spawn("bun", ["dev:desktop"], {
    cwd: repoRoot,
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      T3CODE_DESKTOP_PERF_AUTOMATION: "1",
      T3CODE_DESKTOP_PERF_TRACE_OUT: tracePath,
      T3CODE_DESKTOP_PERF_DONE_OUT: donePath,
      ...(seedPath ? { T3CODE_DESKTOP_PERF_SEED_PATH: seedPath } : {}),
      T3CODE_DEV_INSTANCE: `desktop-perf-${timestamp}`,
      T3CODE_LOG_WS_EVENTS: "0",
      T3CODE_STATE_DIR: stateDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const logs = [];
  const appendLog = (chunk) => {
    const text = chunk.toString();
    logs.push(text);
    if (logs.length > 1200) {
      logs.splice(0, logs.length - 1200);
    }
    fs.appendFileSync(logPath, text);
    process.stdout.write(text);
  };

  child.stdout.on("data", appendLog);
  child.stderr.on("data", appendLog);

  let donePayload;
  try {
    donePayload = await waitForDoneFile(donePath, child, timeoutMs);
  } catch (error) {
    const baseMessage = error instanceof Error ? error.message : String(error);
    const hint = inferDesktopPerfTimeoutHint(logs);
    const logTail = tailLogText(logs);
    throw new Error(
      [
        baseMessage,
        `Hint: ${hint}`,
        `Artifacts dir: ${artifactsDir}`,
        `Run log: ${logPath}`,
        logTail.length > 0 ? `Recent log tail:\n${logTail}` : "Recent log tail: <empty>",
      ].join("\n"),
    );
  } finally {
    await terminateProcessTree(child);
  }

  if (!donePayload || donePayload.status !== "ok") {
    throw new Error(
      `Desktop perf automation failed. ${donePayload?.error ?? "No completion payload written."}`,
    );
  }

  const summary = summarizeTrace(tracePath);
  const markdown = createMarkdownSummary({
    tracePath,
    donePayload,
    summary,
    thresholds: {
      maxKeypressAvgMs,
      maxKeypressMaxMs,
      maxLongDispatchCount,
    },
  });
  fs.writeFileSync(summaryPath, markdown);

  console.log(`\nPerf summary written to ${summaryPath}\n`);
  console.log(markdown);

  const thresholdFailures = [];
  if (summary.keypress.avgMs > maxKeypressAvgMs) {
    thresholdFailures.push(
      `keypress avg ${summary.keypress.avgMs}ms exceeds ${maxKeypressAvgMs}ms`,
    );
  }
  if (summary.keypress.maxMs > maxKeypressMaxMs) {
    thresholdFailures.push(
      `keypress max ${summary.keypress.maxMs}ms exceeds ${maxKeypressMaxMs}ms`,
    );
  }
  if (summary.longDispatchCount > maxLongDispatchCount) {
    thresholdFailures.push(
      `long EventDispatch count ${summary.longDispatchCount} exceeds ${maxLongDispatchCount}`,
    );
  }

  if (args.postPr) {
    postSummaryToPr(summaryPath);
  }

  if (thresholdFailures.length > 0) {
    throw new Error(`Performance thresholds failed:\n- ${thresholdFailures.join("\n- ")}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("\nDesktop perf trace test failed:\n" + message);
  process.exit(1);
});

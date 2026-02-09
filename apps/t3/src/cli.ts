#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startRuntimeApiServer } from "./runtimeApiServer";

const DEFAULT_BACKEND_PORT = 4317;
const DEFAULT_WEB_PORT = 4318;
const DEFAULT_CLI_VERSION = "0.1.0";

function parseExplicitPort(value: string, key: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid value for ${key}: '${value}'. Expected a positive integer.`);
  }

  return parsed;
}

function parseEnvPort(
  value: string | undefined,
  key: string,
  fallback: number,
): { port: number; locked: boolean } {
  if (!value) {
    return { port: fallback, locked: false };
  }

  return {
    port: parseExplicitPort(value, key),
    locked: true,
  };
}

interface CliOptions {
  backendPort: number;
  webPort: number;
  launchCwd: string;
  noOpen: boolean;
  showHelp: boolean;
  showVersion: boolean;
  backendPortLocked: boolean;
  webPortLocked: boolean;
}

interface StartupErrorShape {
  code?: unknown;
  message?: unknown;
}

function readArgValue(args: string[], index: number, key: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`Missing value for ${key}.`);
  }

  return value;
}

export function formatStartupError(error: unknown, options: CliOptions): string {
  const candidate = error as StartupErrorShape;
  const code = typeof candidate?.code === "string" ? candidate.code : undefined;

  if (code === "EADDRINUSE") {
    return `Port already in use. Try --backend-port ${options.backendPort + 1} --web-port ${options.webPort + 1} or stop the conflicting process.`;
  }

  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  return "Failed to start t3 runtime.";
}

function isPortInUseError(error: unknown): boolean {
  const candidate = error as StartupErrorShape;
  return candidate?.code === "EADDRINUSE";
}

export function parseCliOptions(
  argv: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): CliOptions {
  const backendPortFromEnv = parseEnvPort(
    env.T3_BACKEND_PORT,
    "T3_BACKEND_PORT",
    DEFAULT_BACKEND_PORT,
  );
  const webPortFromEnv = parseEnvPort(env.T3_WEB_PORT, "T3_WEB_PORT", DEFAULT_WEB_PORT);

  let backendPort = backendPortFromEnv.port;
  let webPort = webPortFromEnv.port;
  let backendPortLocked = backendPortFromEnv.locked;
  let webPortLocked = webPortFromEnv.locked;
  let launchCwd = cwd;
  let usedPositionalCwd = false;
  let noOpen = env.T3_NO_OPEN === "1";
  let showHelp = false;
  let showVersion = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) continue;

    if (arg === "--help" || arg === "-h") {
      showHelp = true;
      continue;
    }

    if (arg === "--version" || arg === "-v") {
      showVersion = true;
      continue;
    }

    if (arg === "--no-open") {
      noOpen = true;
      continue;
    }

    if (arg.startsWith("--backend-port=")) {
      backendPort = parseExplicitPort(arg.split("=")[1] ?? "", "--backend-port");
      backendPortLocked = true;
      continue;
    }

    if (arg === "--backend-port") {
      backendPort = parseExplicitPort(
        readArgValue(argv, index, "--backend-port"),
        "--backend-port",
      );
      backendPortLocked = true;
      index += 1;
      continue;
    }

    if (arg.startsWith("--web-port=")) {
      webPort = parseExplicitPort(arg.split("=")[1] ?? "", "--web-port");
      webPortLocked = true;
      continue;
    }

    if (arg === "--web-port") {
      webPort = parseExplicitPort(readArgValue(argv, index, "--web-port"), "--web-port");
      webPortLocked = true;
      index += 1;
      continue;
    }

    if (arg.startsWith("--cwd=")) {
      launchCwd = path.resolve(arg.split("=")[1] ?? cwd);
      continue;
    }

    if (arg === "--cwd") {
      launchCwd = path.resolve(readArgValue(argv, index, "--cwd"));
      index += 1;
      continue;
    }

    if (!arg.startsWith("-")) {
      if (usedPositionalCwd) {
        throw new Error(`Unexpected positional argument: ${arg}`);
      }
      launchCwd = path.resolve(arg);
      usedPositionalCwd = true;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    backendPort,
    webPort,
    launchCwd,
    noOpen,
    showHelp,
    showVersion,
    backendPortLocked,
    webPortLocked,
  };
}

function printHelp(): void {
  process.stdout.write(
    [
      "Usage: t3 [options]",
      "",
      "Options:",
      "  --no-open               Start runtime without opening browser",
      "  --backend-port <port>   Override WebSocket API port (default: 4317)",
      "  --web-port <port>       Override web UI port (default: 4318)",
      "  --cwd <path>            Launch project directory (default: current directory)",
      "  [path]                  Positional shorthand for --cwd <path>",
      "  -v, --version           Print CLI version",
      "  -h, --help              Show this help message",
      "",
      "Environment variables:",
      "  T3_NO_OPEN=1            Disable browser auto-open",
      "  T3_BACKEND_PORT=<port>  Default backend port",
      "  T3_WEB_PORT=<port>      Default web UI port",
      "",
    ].join("\n"),
  );
}

function openBrowser(url: string, noOpen: boolean): void {
  if (noOpen) {
    return;
  }

  const command =
    process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];

  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
  });
  child.on("error", () => {
    // Best-effort browser launch; keep runtime alive even when opener is unavailable.
  });
  child.unref();
}

export function readCliVersion(
  packageJsonPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "package.json",
  ),
  env = process.env,
): string {
  const envVersion = env.npm_package_version;
  if (typeof envVersion === "string" && envVersion.length > 0) {
    return envVersion;
  }

  try {
    const raw = fs.readFileSync(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === "string" && parsed.version.length > 0) {
      return parsed.version;
    }
  } catch {
    // Ignore read/parse failures and return fallback.
  }

  return DEFAULT_CLI_VERSION;
}

async function runCli(options: CliOptions): Promise<void> {
  const runtimeServer = await startRuntimeApiServer({
    port: options.backendPort,
    launchCwd: options.launchCwd,
  });

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const rendererRoot = path.resolve(__dirname, "../../renderer");
  ensureRendererBuild(rendererRoot);

  let staticServer:
    | {
        close: () => Promise<void>;
      }
    | undefined;
  try {
    staticServer = await startStaticWebServer(path.join(rendererRoot, "dist"), options.webPort);
  } catch (error) {
    await runtimeServer.close();
    throw error;
  }

  const wsParam = encodeURIComponent(runtimeServer.wsUrl);
  const appUrl = `http://127.0.0.1:${options.webPort}?ws=${wsParam}`;
  openBrowser(appUrl, options.noOpen);

  process.stdout.write(`CodeThing is running at ${appUrl}\n`);

  let shutdownStarted = false;
  const shutdown = async () => {
    if (shutdownStarted) {
      return;
    }
    shutdownStarted = true;
    await Promise.all([staticServer.close(), runtimeServer.close()]);
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
}

function ensureRendererBuild(rendererRoot: string): void {
  const distPath = path.join(rendererRoot, "dist", "index.html");
  if (fs.existsSync(distPath)) {
    return;
  }

  const bunPath = process.env.BUN_BIN ?? "bun";
  const build = spawnSync(bunPath, ["run", "--cwd", rendererRoot, "build"], {
    stdio: "inherit",
    env: {
      ...process.env,
      PATH: `${process.env.HOME}/.bun/bin:${process.env.PATH}`,
    },
  });
  if (build.status !== 0) {
    throw new Error("Failed to build renderer assets.");
  }
}

function contentTypeFor(filePath: string): string {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  if (filePath.endsWith(".png")) return "image/png";
  if (filePath.endsWith(".jpg") || filePath.endsWith(".jpeg")) return "image/jpeg";
  if (filePath.endsWith(".woff2")) return "font/woff2";
  if (filePath.endsWith(".woff")) return "font/woff";
  return "application/octet-stream";
}

function startStaticWebServer(distRoot: string, port: number) {
  const server = createServer((request, response) => {
    const requestPath = request.url ? request.url.split("?")[0] : "/";
    const normalized =
      requestPath === "/" ? "index.html" : (requestPath ?? "/").replace(/^\/+/, "");
    const safePath = path.normalize(normalized).replace(/^(\.\.[/\\])+/, "");
    const filePath = path.join(distRoot, safePath);

    if (!filePath.startsWith(distRoot)) {
      response.statusCode = 403;
      response.end("Forbidden");
      return;
    }

    const exists = fs.existsSync(filePath);
    const targetPath = exists ? filePath : path.join(distRoot, "index.html");
    fs.readFile(targetPath, (error, content) => {
      if (error) {
        response.statusCode = 404;
        response.end("Not found");
        return;
      }

      response.statusCode = 200;
      response.setHeader("Content-Type", contentTypeFor(targetPath));
      response.end(content);
    });
  });

  return new Promise<{
    close: () => Promise<void>;
  }>((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      resolve({
        close: async () => {
          await new Promise<void>((closeResolve) => {
            server.close(() => closeResolve());
          });
        },
      });
    });
  });
}

async function main() {
  let options: CliOptions;
  try {
    options = parseCliOptions(process.argv.slice(2), process.env, process.cwd());
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Invalid arguments."}\n\n`);
    printHelp();
    process.exit(1);
    return;
  }

  if (options.showHelp) {
    printHelp();
    process.exit(0);
    return;
  }

  if (options.showVersion) {
    process.stdout.write(`${readCliVersion()}\n`);
    process.exit(0);
    return;
  }

  const maxPortRetryAttempts = 10;
  const runWithRetry = async (
    currentOptions: CliOptions,
    attempt: number,
  ): Promise<void> => {
    try {
      await runCli(currentOptions);
      return;
    } catch (error) {
      const canRetryWithNextPorts =
        isPortInUseError(error) &&
        !currentOptions.backendPortLocked &&
        !currentOptions.webPortLocked &&
        attempt < maxPortRetryAttempts - 1;
      if (canRetryWithNextPorts) {
        const nextBackendPort = currentOptions.backendPort + 1;
        const nextWebPort = currentOptions.webPort + 1;
        process.stderr.write(
          `Ports ${currentOptions.backendPort}/${currentOptions.webPort} busy; retrying with ${nextBackendPort}/${nextWebPort}.\n`,
        );
        return runWithRetry(
          {
            ...currentOptions,
            backendPort: nextBackendPort,
            webPort: nextWebPort,
          },
          attempt + 1,
        );
      }

      const wrappedError = new Error("CLI startup failed.");
      (wrappedError as Error & { cause?: unknown }).cause = {
        originalError: error,
        options: currentOptions,
      };
      throw wrappedError;
    }
  };

  try {
    await runWithRetry(options, 0);
  } catch (error) {
    const wrappedCause = (error as Error & { cause?: unknown }).cause as
      | {
          originalError?: unknown;
          options?: CliOptions;
        }
      | undefined;
    const wrapped = wrappedCause ?? {
      originalError: error,
      options,
    };
    const failedOptions = wrapped.options ?? options;
    process.stderr.write(
      `${formatStartupError(wrapped.originalError ?? error, failedOptions)}\n`,
    );
    process.exit(1);
  }
}

const entrypoint = process.argv[1];
const currentFilePath = fileURLToPath(import.meta.url);
if (entrypoint && path.resolve(entrypoint) === currentFilePath) {
  void main();
}

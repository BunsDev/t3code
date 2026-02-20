import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

import { describe, expect, it, afterEach, vi } from "vitest";
import { createServer } from "./wsServer";
import WebSocket from "ws";

import {
  DEFAULT_TERMINAL_ID,
  WS_CHANNELS,
  WS_METHODS,
  type AppSettingsUpdateInput,
  type ProjectAddInput,
  type ProjectRemoveInput,
  type ProjectUpdateScriptsInput,
  type StateCatchUpInput,
  type StateListMessagesInput,
  type ThreadsCreateInput,
  type ThreadsDeleteInput,
  type ThreadsMarkVisitedInput,
  type ThreadsUpdateBranchInput,
  type ThreadsUpdateModelInput,
  type ThreadsUpdateTerminalStateInput,
  type ThreadsUpdateTitleInput,
  type KeybindingsConfig,
  type ResolvedKeybindingsConfig,
  type StateEvent,
  type WsPush,
  type WsResponse,
} from "@t3tools/contracts";
import { compileResolvedKeybindingRule, DEFAULT_KEYBINDINGS } from "./keybindings";
import type {
  TerminalClearInput,
  TerminalCloseInput,
  TerminalEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalSessionSnapshot,
  TerminalWriteInput,
} from "@t3tools/contracts";
import type { TerminalManager } from "./terminalManager";
import { PersistenceService } from "./persistenceService";
import { ProviderManager } from "./providerManager";
import type { ApplyCheckpointRevertInput, StateSyncEngine } from "./stateSyncEngine";
import { LegacyStateSyncEngine } from "./stateSyncEngineLegacy";
import { LiveStoreReadPilotStateSyncEngine } from "./stateSyncEngineLiveStoreReadPilot";
import { ShadowStateSyncEngine } from "./stateSyncEngineShadow";
import { LiveStoreStateMirror } from "./livestore/liveStoreEngine";
import { diffStateSnapshots } from "./livestore/parity";

interface PendingMessages {
  queue: unknown[];
  waiters: Array<(message: unknown) => void>;
}

const pendingBySocket = new WeakMap<WebSocket, PendingMessages>();

class MockTerminalManager extends EventEmitter<{ event: [event: TerminalEvent] }> {
  private readonly sessions = new Map<string, TerminalSessionSnapshot>();

  private key(threadId: string, terminalId: string): string {
    return `${threadId}\u0000${terminalId}`;
  }

  async open(input: TerminalOpenInput): Promise<TerminalSessionSnapshot> {
    const now = new Date().toISOString();
    const terminalId = input.terminalId ?? DEFAULT_TERMINAL_ID;
    const snapshot: TerminalSessionSnapshot = {
      threadId: input.threadId,
      terminalId,
      cwd: input.cwd,
      status: "running",
      pid: 4242,
      history: "",
      exitCode: null,
      exitSignal: null,
      updatedAt: now,
    };
    this.sessions.set(this.key(input.threadId, terminalId), snapshot);
    queueMicrotask(() => {
      this.emit("event", {
        type: "started",
        threadId: input.threadId,
        terminalId,
        createdAt: now,
        snapshot,
      });
    });
    return snapshot;
  }

  async write(input: TerminalWriteInput): Promise<void> {
    const terminalId = input.terminalId ?? DEFAULT_TERMINAL_ID;
    const existing = this.sessions.get(this.key(input.threadId, terminalId));
    if (!existing) {
      throw new Error(`Unknown terminal thread: ${input.threadId}`);
    }
    queueMicrotask(() => {
      this.emit("event", {
        type: "output",
        threadId: input.threadId,
        terminalId,
        createdAt: new Date().toISOString(),
        data: input.data,
      });
    });
  }

  async resize(_input: TerminalResizeInput): Promise<void> {}

  async clear(input: TerminalClearInput): Promise<void> {
    const terminalId = input.terminalId ?? DEFAULT_TERMINAL_ID;
    queueMicrotask(() => {
      this.emit("event", {
        type: "cleared",
        threadId: input.threadId,
        terminalId,
        createdAt: new Date().toISOString(),
      });
    });
  }

  async restart(input: TerminalOpenInput): Promise<TerminalSessionSnapshot> {
    const now = new Date().toISOString();
    const terminalId = input.terminalId ?? DEFAULT_TERMINAL_ID;
    const snapshot: TerminalSessionSnapshot = {
      threadId: input.threadId,
      terminalId,
      cwd: input.cwd,
      status: "running",
      pid: 5252,
      history: "",
      exitCode: null,
      exitSignal: null,
      updatedAt: now,
    };
    this.sessions.set(this.key(input.threadId, terminalId), snapshot);
    queueMicrotask(() => {
      this.emit("event", {
        type: "restarted",
        threadId: input.threadId,
        terminalId,
        createdAt: now,
        snapshot,
      });
    });
    return snapshot;
  }

  async close(input: TerminalCloseInput): Promise<void> {
    if (input.terminalId) {
      this.sessions.delete(this.key(input.threadId, input.terminalId));
      return;
    }
    for (const key of [...this.sessions.keys()]) {
      if (key.startsWith(`${input.threadId}\u0000`)) {
        this.sessions.delete(key);
      }
    }
  }

  dispose(): void {}
}

class MockStateSyncEngine extends EventEmitter<{ stateEvent: [event: StateEvent] }>
  implements StateSyncEngine
{
  readonly loadSnapshotMock = vi.fn<
    () => {
      projects: [];
      threads: [];
      lastStateSeq: number;
    }
  >(() => ({
    projects: [],
    threads: [],
    lastStateSeq: 42,
  }));
  readonly listMessagesMock = vi.fn(() => ({
    messages: [],
    total: 0,
    nextOffset: null,
  }));
  readonly catchUpMock = vi.fn(() => ({
    events: [],
    lastStateSeq: 42,
  }));
  readonly getAppSettingsMock = vi.fn(() => ({
    codexBinaryPath: "",
    codexHomePath: "",
  }));
  readonly updateAppSettingsMock = vi.fn(() => ({
    codexBinaryPath: "",
    codexHomePath: "",
  }));
  readonly createThreadMock = vi.fn(() => ({
    thread: {
      id: "thread-1",
      codexThreadId: null,
      projectId: "project-1",
      title: "Thread",
      model: "gpt-5.3-codex",
      terminalOpen: false,
      terminalHeight: 280,
      terminalIds: ["default"],
      runningTerminalIds: [],
      activeTerminalId: "default",
      terminalGroups: [{ id: "group-default", terminalIds: ["default"] }],
      activeTerminalGroupId: "group-default",
      createdAt: "2026-02-20T00:00:00.000Z",
      updatedAt: "2026-02-20T00:00:00.000Z",
      branch: null,
      worktreePath: null,
      turnDiffSummaries: [],
    },
  }));
  readonly updateThreadTerminalStateMock = vi.fn(() => this.createThreadMock());
  readonly updateThreadModelMock = vi.fn(() => this.createThreadMock());
  readonly updateThreadTitleMock = vi.fn(() => this.createThreadMock());
  readonly updateThreadBranchMock = vi.fn(() => this.createThreadMock());
  readonly markThreadVisitedMock = vi.fn(() => this.createThreadMock());
  readonly deleteThreadMock = vi.fn();
  readonly listProjectsMock = vi.fn(() => []);
  readonly addProjectMock = vi.fn(() => ({
    project: {
      id: "project-1",
      cwd: "/tmp/project",
      name: "project",
      scripts: [],
      createdAt: "2026-02-20T00:00:00.000Z",
      updatedAt: "2026-02-20T00:00:00.000Z",
    },
    created: true,
  }));
  readonly removeProjectMock = vi.fn();
  readonly updateProjectScriptsMock = vi.fn(() => ({
    project: {
      id: "project-1",
      cwd: "/tmp/project",
      name: "project",
      scripts: [],
      createdAt: "2026-02-20T00:00:00.000Z",
      updatedAt: "2026-02-20T00:00:00.000Z",
    },
  }));
  readonly applyCheckpointRevertMock = vi.fn();
  readonly closeMock = vi.fn();

  onStateEvent(listener: (event: StateEvent) => void): () => void {
    this.on("stateEvent", listener);
    return () => {
      this.off("stateEvent", listener);
    };
  }

  emitStateEvent(event: StateEvent): void {
    this.emit("stateEvent", event);
  }

  loadSnapshot() {
    return this.loadSnapshotMock();
  }
  listMessages(_raw: StateListMessagesInput) {
    return this.listMessagesMock();
  }
  catchUp(_raw: StateCatchUpInput) {
    return this.catchUpMock();
  }
  getAppSettings() {
    return this.getAppSettingsMock();
  }
  updateAppSettings(_raw: AppSettingsUpdateInput) {
    return this.updateAppSettingsMock();
  }
  createThread(_raw: ThreadsCreateInput) {
    return this.createThreadMock();
  }
  updateThreadTerminalState(_raw: ThreadsUpdateTerminalStateInput) {
    return this.updateThreadTerminalStateMock();
  }
  updateThreadModel(_raw: ThreadsUpdateModelInput) {
    return this.updateThreadModelMock();
  }
  updateThreadTitle(_raw: ThreadsUpdateTitleInput) {
    return this.updateThreadTitleMock();
  }
  updateThreadBranch(_raw: ThreadsUpdateBranchInput) {
    return this.updateThreadBranchMock();
  }
  markThreadVisited(_raw: ThreadsMarkVisitedInput) {
    return this.markThreadVisitedMock();
  }
  deleteThread(_raw: ThreadsDeleteInput): void {
    this.deleteThreadMock();
  }
  listProjects() {
    return this.listProjectsMock();
  }
  addProject(_raw: ProjectAddInput) {
    return this.addProjectMock();
  }
  removeProject(_raw: ProjectRemoveInput): void {
    this.removeProjectMock();
  }
  updateProjectScripts(_raw: ProjectUpdateScriptsInput) {
    return this.updateProjectScriptsMock();
  }
  applyCheckpointRevert(input: ApplyCheckpointRevertInput): void {
    this.applyCheckpointRevertMock(input);
  }
  close(): void {
    this.closeMock();
  }
}

function connectWs(port: number, token?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const query = token ? `?token=${encodeURIComponent(token)}` : "";
    const ws = new WebSocket(`ws://127.0.0.1:${port}/${query}`);
    const pending: PendingMessages = { queue: [], waiters: [] };
    pendingBySocket.set(ws, pending);

    ws.on("message", (raw) => {
      const parsed = JSON.parse(String(raw));
      const waiter = pending.waiters.shift();
      if (waiter) {
        waiter(parsed);
        return;
      }
      pending.queue.push(parsed);
    });

    ws.once("open", () => resolve(ws));
    ws.once("error", () => reject(new Error("WebSocket connection failed")));
  });
}

function waitForMessage(ws: WebSocket): Promise<unknown> {
  const pending = pendingBySocket.get(ws);
  if (!pending) {
    return Promise.reject(new Error("WebSocket not initialized"));
  }

  const queued = pending.queue.shift();
  if (queued !== undefined) {
    return Promise.resolve(queued);
  }

  return new Promise((resolve) => {
    pending.waiters.push(resolve);
  });
}

async function sendRequest(ws: WebSocket, method: string, params?: unknown): Promise<WsResponse> {
  const id = crypto.randomUUID();
  const message = JSON.stringify({ id, method, ...(params !== undefined ? { params } : {}) });
  ws.send(message);

  // Wait for response with matching id
  while (true) {
    const parsed = (await waitForMessage(ws)) as Record<string, unknown>;
    if (parsed.id === id) {
      return parsed as WsResponse;
    }
  }
}

function compileKeybindings(bindings: KeybindingsConfig): ResolvedKeybindingsConfig {
  const resolved: ResolvedKeybindingsConfig = [];
  for (const binding of bindings) {
    const compiled = compileResolvedKeybindingRule(binding);
    if (!compiled) {
      throw new Error(`Unexpected invalid keybinding in test setup: ${binding.command}`);
    }
    resolved.push(compiled);
  }
  return resolved;
}

async function waitForPush(ws: WebSocket, channel: string): Promise<WsPush> {
  while (true) {
    const message = (await waitForMessage(ws)) as WsPush;
    if (message.type === "push" && message.channel === channel) {
      return message;
    }
  }
}

async function waitForCondition(
  predicate: () => boolean,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 1500;
  const intervalMs = options.intervalMs ?? 20;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  expect(predicate()).toBe(true);
}

const DEFAULT_RESOLVED_KEYBINDINGS = compileKeybindings([...DEFAULT_KEYBINDINGS]);

function mergeWithDefaultsForTest(custom: KeybindingsConfig): ResolvedKeybindingsConfig {
  if (custom.length === 0) {
    return DEFAULT_RESOLVED_KEYBINDINGS;
  }

  const overriddenCommands = new Set(custom.map((binding) => binding.command));
  const retainedDefaults = DEFAULT_KEYBINDINGS.filter(
    (binding) => !overriddenCommands.has(binding.command),
  );
  return compileKeybindings([...retainedDefaults, ...custom].slice(-256));
}

describe("WebSocket Server", () => {
  let server: ReturnType<typeof createServer> | null = null;
  const connections: WebSocket[] = [];
  const tempDirs: string[] = [];
  const injectedPersistenceServices: PersistenceService[] = [];

  function makeTempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  function createTestServer(
    options: {
      cwd?: string;
      devUrl?: string;
      authToken?: string;
      stateDir?: string;
      gitManager?: {
        status: (input: { cwd: string }) => Promise<unknown>;
        runStackedAction: (input: { cwd: string; action: string }) => Promise<unknown>;
      };
      terminalManager?: TerminalManager;
      persistenceService?: PersistenceService;
      stateSyncEngine?: StateSyncEngine;
      syncEngineMode?: "legacy" | "shadow" | "livestore-read-pilot";
    } = {},
  ): ReturnType<typeof createServer> {
    const stateDir = options.stateDir ?? makeTempDir("t3code-ws-state-");
    const persistenceService =
      options.persistenceService ??
      new PersistenceService({
        dbPath: path.join(stateDir, "state.sqlite"),
        legacyProjectsJsonPath: path.join(stateDir, "projects.json"),
      });
    injectedPersistenceServices.push(persistenceService);
    return createServer({
      port: 0,
      cwd: options.cwd ?? "/test/project",
      ...(options.devUrl ? { devUrl: options.devUrl } : {}),
      ...(options.authToken ? { authToken: options.authToken } : {}),
      persistenceService,
      ...(options.stateSyncEngine ? { stateSyncEngine: options.stateSyncEngine } : {}),
      ...(options.syncEngineMode ? { syncEngineMode: options.syncEngineMode } : {}),
      ...(options.gitManager ? { gitManager: options.gitManager as never } : {}),
      ...(options.terminalManager ? { terminalManager: options.terminalManager } : {}),
    });
  }

  afterEach(async () => {
    for (const ws of connections) {
      ws.close();
    }
    connections.length = 0;
    if (server) {
      await server.stop();
    }
    server = null;
    for (const service of injectedPersistenceServices.splice(0, injectedPersistenceServices.length)) {
      service.close();
    }
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it("sends welcome message on connect", async () => {
    server = createTestServer({ cwd: "/test/project" });
    // Get the actual port after listen
    await server.start();
    const addr = server.httpServer.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    expect(port).toBeGreaterThan(0);

    const ws = await connectWs(port);
    connections.push(ws);

    const message = (await waitForMessage(ws)) as WsPush;
    expect(message.type).toBe("push");
    expect(message.channel).toBe(WS_CHANNELS.serverWelcome);
    expect(message.data).toEqual({
      cwd: "/test/project",
      projectName: "project",
    });
  });

  it("logs outbound websocket push events in dev mode", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {
      // Keep test output clean while verifying websocket logs.
    });

    server = createTestServer({
      cwd: "/test/project",
      devUrl: "http://localhost:5173",
    });
    await server.start();
    const addr = server.httpServer.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    expect(port).toBeGreaterThan(0);

    const ws = await connectWs(port);
    connections.push(ws);
    await waitForMessage(ws);

    expect(
      logSpy.mock.calls.some(([message]) => {
        if (typeof message !== "string") return false;
        return (
          message.includes("[ws]") &&
          message.includes("outgoing push") &&
          message.includes(`channel="${WS_CHANNELS.serverWelcome}"`)
        );
      }),
    ).toBe(true);
  });

  it("responds to server.getConfig", async () => {
    const fakeHome = makeTempDir("t3code-home-");
    vi.spyOn(os, "homedir").mockReturnValue(fakeHome);
    server = createTestServer({ cwd: "/my/workspace" });
    await server.start();
    const addr = server.httpServer.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);

    // Consume welcome message
    await waitForMessage(ws);

    const response = await sendRequest(ws, WS_METHODS.serverGetConfig);
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({
      cwd: "/my/workspace",
      syncEngineMode: "legacy",
      keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
    });
  });

  it("includes configured sync engine mode in server.getConfig", async () => {
    const fakeHome = makeTempDir("t3code-home-");
    vi.spyOn(os, "homedir").mockReturnValue(fakeHome);
    server = createTestServer({
      cwd: "/my/workspace",
      syncEngineMode: "livestore-read-pilot",
    });
    await server.start();
    const addr = server.httpServer.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);
    await waitForMessage(ws);

    const response = await sendRequest(ws, WS_METHODS.serverGetConfig);
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({
      cwd: "/my/workspace",
      syncEngineMode: "livestore-read-pilot",
      keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
    });
  });

  it("reads keybindings from ~/.t3/keybindings.json", async () => {
    const fakeHome = makeTempDir("t3code-home-");
    const configDir = path.join(fakeHome, ".t3");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "keybindings.json"),
      JSON.stringify([
        { key: "cmd+j", command: "terminal.toggle" },
        { key: "mod+d", command: "terminal.split", when: "terminalFocus" },
        { key: "mod+n", command: "terminal.new", when: "terminalFocus" },
      ]),
      "utf8",
    );
    vi.spyOn(os, "homedir").mockReturnValue(fakeHome);

    server = createTestServer({ cwd: "/my/workspace" });
    await server.start();
    const addr = server.httpServer.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);

    await waitForMessage(ws);

    const response = await sendRequest(ws, WS_METHODS.serverGetConfig);
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({
      cwd: "/my/workspace",
      syncEngineMode: "legacy",
      keybindings: mergeWithDefaultsForTest([
        { key: "cmd+j", command: "terminal.toggle" },
        { key: "mod+d", command: "terminal.split", when: "terminalFocus" },
        { key: "mod+n", command: "terminal.new", when: "terminalFocus" },
      ]),
    });
  });

  it("warns and ignores invalid keybinding entries", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fakeHome = makeTempDir("t3code-home-invalid-entry-");
    const configDir = path.join(fakeHome, ".t3");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "keybindings.json"),
      JSON.stringify([
        { key: "mod+j", command: "terminal.toggle" },
        { key: "mod+z", command: "invalid.command", when: "terminalFocus" },
      ]),
      "utf8",
    );
    vi.spyOn(os, "homedir").mockReturnValue(fakeHome);

    server = createTestServer({ cwd: "/my/workspace" });
    await server.start();
    const addr = server.httpServer.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);

    await waitForMessage(ws);

    const response = await sendRequest(ws, WS_METHODS.serverGetConfig);
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({
      cwd: "/my/workspace",
      syncEngineMode: "legacy",
      keybindings: mergeWithDefaultsForTest([{ key: "mod+j", command: "terminal.toggle" }]),
    });
    expect(
      warnSpy.mock.calls.some(([message]) =>
        String(message).includes("ignoring invalid keybinding entries"),
      ),
    ).toBe(true);
  });

  it("warns and ignores keybindings with malformed when expressions", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fakeHome = makeTempDir("t3code-home-invalid-when-");
    const configDir = path.join(fakeHome, ".t3");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "keybindings.json"),
      JSON.stringify([{ key: "mod+j", command: "terminal.toggle", when: "terminalFocus && (" }]),
      "utf8",
    );
    vi.spyOn(os, "homedir").mockReturnValue(fakeHome);

    server = createTestServer({ cwd: "/my/workspace" });
    await server.start();
    const addr = server.httpServer.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);

    await waitForMessage(ws);

    const response = await sendRequest(ws, WS_METHODS.serverGetConfig);
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({
      cwd: "/my/workspace",
      syncEngineMode: "legacy",
      keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
    });
    expect(
      warnSpy.mock.calls.some(([message]) =>
        String(message).includes("ignoring invalid keybinding entries"),
      ),
    ).toBe(true);
  });

  it("reads keybindings once at startup and caches the resolved config", async () => {
    const fakeHome = makeTempDir("t3code-home-cached-config-");
    const configDir = path.join(fakeHome, ".t3");
    fs.mkdirSync(configDir, { recursive: true });
    const keybindingsPath = path.join(configDir, "keybindings.json");
    fs.writeFileSync(
      keybindingsPath,
      JSON.stringify([{ key: "cmd+j", command: "terminal.toggle" }]),
      "utf8",
    );
    vi.spyOn(os, "homedir").mockReturnValue(fakeHome);

    server = createTestServer({ cwd: "/my/workspace" });
    await server.start();
    const addr = server.httpServer.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);
    await waitForMessage(ws);

    const firstResponse = await sendRequest(ws, WS_METHODS.serverGetConfig);
    expect(firstResponse.error).toBeUndefined();
    expect(firstResponse.result).toEqual({
      cwd: "/my/workspace",
      syncEngineMode: "legacy",
      keybindings: mergeWithDefaultsForTest([{ key: "cmd+j", command: "terminal.toggle" }]),
    });

    fs.writeFileSync(
      keybindingsPath,
      JSON.stringify([{ key: "cmd+k", command: "terminal.toggle" }]),
      "utf8",
    );

    const secondResponse = await sendRequest(ws, WS_METHODS.serverGetConfig);
    expect(secondResponse.error).toBeUndefined();
    expect(secondResponse.result).toEqual(firstResponse.result);
  });

  it("upserts keybinding rules and updates cached server config", async () => {
    const fakeHome = makeTempDir("t3code-home-upsert-keybinding-");
    const configDir = path.join(fakeHome, ".t3");
    fs.mkdirSync(configDir, { recursive: true });
    const keybindingsPath = path.join(configDir, "keybindings.json");
    fs.writeFileSync(
      keybindingsPath,
      JSON.stringify([{ key: "mod+j", command: "terminal.toggle" }]),
      "utf8",
    );
    vi.spyOn(os, "homedir").mockReturnValue(fakeHome);

    server = createTestServer({ cwd: "/my/workspace" });
    await server.start();
    const addr = server.httpServer.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);
    await waitForMessage(ws);

    const upsertResponse = await sendRequest(ws, WS_METHODS.serverUpsertKeybinding, {
      key: "mod+shift+r",
      command: "script.run-tests.run",
    });
    expect(upsertResponse.error).toBeUndefined();
    expect(upsertResponse.result).toEqual({
      keybindings: mergeWithDefaultsForTest([
        { key: "mod+j", command: "terminal.toggle" },
        { key: "mod+shift+r", command: "script.run-tests.run" },
      ]),
    });

    const persistedConfig = JSON.parse(fs.readFileSync(keybindingsPath, "utf8")) as Array<{
      key: string;
      command: string;
    }>;
    expect(persistedConfig).toEqual([
      { key: "mod+j", command: "terminal.toggle" },
      { key: "mod+shift+r", command: "script.run-tests.run" },
    ]);

    const configResponse = await sendRequest(ws, WS_METHODS.serverGetConfig);
    expect(configResponse.error).toBeUndefined();
    expect(configResponse.result).toEqual({
      cwd: "/my/workspace",
      syncEngineMode: "legacy",
      keybindings: mergeWithDefaultsForTest([
        { key: "mod+j", command: "terminal.toggle" },
        { key: "mod+shift+r", command: "script.run-tests.run" },
      ]),
    });
  });

  it("warns and ignores unsupported keybindings config format", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fakeHome = makeTempDir("t3code-home-unsupported-format-");
    const configDir = path.join(fakeHome, ".t3");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "keybindings.json"),
      JSON.stringify({ "terminal.toggle": "mod+j" }),
      "utf8",
    );
    vi.spyOn(os, "homedir").mockReturnValue(fakeHome);

    server = createTestServer({ cwd: "/my/workspace" });
    await server.start();
    const addr = server.httpServer.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);

    await waitForMessage(ws);

    const response = await sendRequest(ws, WS_METHODS.serverGetConfig);
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({
      cwd: "/my/workspace",
      syncEngineMode: "legacy",
      keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
    });
    expect(
      warnSpy.mock.calls.some(([message]) =>
        String(message).includes("unsupported format; expected array"),
      ),
    ).toBe(true);
  });

  it("warns and ignores malformed keybindings config files", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fakeHome = makeTempDir("t3code-home-invalid-");
    const configDir = path.join(fakeHome, ".t3");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "keybindings.json"), "{not-json", "utf8");
    vi.spyOn(os, "homedir").mockReturnValue(fakeHome);

    server = createTestServer({ cwd: "/my/workspace" });
    await server.start();
    const addr = server.httpServer.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);

    await waitForMessage(ws);

    const response = await sendRequest(ws, WS_METHODS.serverGetConfig);
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({
      cwd: "/my/workspace",
      syncEngineMode: "legacy",
      keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
    });
    expect(
      warnSpy.mock.calls.some(([message]) =>
        String(message).includes("ignoring malformed keybindings config"),
      ),
    ).toBe(true);
  });

  it("returns error for unknown methods", async () => {
    server = createTestServer({ cwd: "/test" });
    await server.start();
    const addr = server.httpServer.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);

    // Consume welcome
    await waitForMessage(ws);

    const response = await sendRequest(ws, "nonexistent.method");
    expect(response.error).toBeDefined();
    expect(response.error!.message).toContain("Unknown method");
  });

  it("responds to providers.listSessions with empty array", async () => {
    server = createTestServer({ cwd: "/test" });
    await server.start();
    const addr = server.httpServer.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);

    // Consume welcome
    await waitForMessage(ws);

    const response = await sendRequest(ws, WS_METHODS.providersListSessions);
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual([]);
  });

  it("persists app settings through appSettings RPC methods", async () => {
    const stateDir = makeTempDir("t3code-ws-app-settings-");
    server = createTestServer({ cwd: "/test", stateDir });
    await server.start();
    const addr = server.httpServer.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);
    await waitForMessage(ws);

    const initial = await sendRequest(ws, WS_METHODS.appSettingsGet);
    expect(initial.error).toBeUndefined();
    expect(initial.result).toEqual({
      codexBinaryPath: "",
      codexHomePath: "",
    });

    const updated = await sendRequest(ws, WS_METHODS.appSettingsUpdate, {
      codexBinaryPath: "  /opt/codex/bin/codex  ",
      codexHomePath: "  /Users/theo/.codex  ",
    });
    expect(updated.error).toBeUndefined();
    expect(updated.result).toEqual({
      codexBinaryPath: "/opt/codex/bin/codex",
      codexHomePath: "/Users/theo/.codex",
    });

    const roundTrip = await sendRequest(ws, WS_METHODS.appSettingsGet);
    expect(roundTrip.error).toBeUndefined();
    expect(roundTrip.result).toEqual({
      codexBinaryPath: "/opt/codex/bin/codex",
      codexHomePath: "/Users/theo/.codex",
    });
  });

  it("supports state bootstrap and ordered catch-up events", async () => {
    const stateDir = makeTempDir("t3code-ws-state-bootstrap-");
    const projectCwd = makeTempDir("t3code-ws-state-project-");
    server = createTestServer({ cwd: "/test", stateDir });
    await server.start();
    const addr = server.httpServer.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);
    await waitForMessage(ws);

    const addedProject = await sendRequest(ws, WS_METHODS.projectsAdd, { cwd: projectCwd });
    expect(addedProject.error).toBeUndefined();
    const projectId = (addedProject.result as { project: { id: string } }).project.id;

    const createdThread = await sendRequest(ws, WS_METHODS.threadsCreate, {
      projectId,
      title: "My Thread",
      model: "gpt-5.3-codex",
    });
    expect(createdThread.error).toBeUndefined();
    const threadId = (createdThread.result as { thread: { id: string } }).thread.id;

    const updatedThread = await sendRequest(ws, WS_METHODS.threadsUpdateTitle, {
      threadId,
      title: "Updated Thread Title",
    });
    expect(updatedThread.error).toBeUndefined();

    const bootstrap = await sendRequest(ws, WS_METHODS.stateBootstrap);
    expect(bootstrap.error).toBeUndefined();
    const snapshot = bootstrap.result as {
      projects: Array<{ id: string }>;
      threads: Array<{ id: string; title: string }>;
      lastStateSeq: number;
    };
    expect(snapshot.projects).toHaveLength(1);
    expect(snapshot.threads).toHaveLength(1);
    expect(snapshot.threads[0]?.title).toBe("Updated Thread Title");
    expect(snapshot.lastStateSeq).toBeGreaterThan(0);

    const catchUp = await sendRequest(ws, WS_METHODS.stateCatchUp, { afterSeq: 0 });
    expect(catchUp.error).toBeUndefined();
    const events = (catchUp.result as { events: StateEvent[] }).events;
    expect(events.length).toBeGreaterThanOrEqual(3);
    for (let index = 1; index < events.length; index += 1) {
      const previous = events[index - 1];
      const current = events[index];
      expect(previous).toBeDefined();
      expect(current).toBeDefined();
      if (!previous || !current) continue;
      expect(current.seq).toBeGreaterThan(previous.seq);
    }
    expect(events.some((event) => event.eventType === "project.upsert")).toBe(true);
    expect(events.some((event) => event.eventType === "thread.upsert")).toBe(true);
  });

  it("uses the injected state sync engine for state routes and pushes", async () => {
    const shadowEngine = new MockStateSyncEngine();
    server = createTestServer({
      cwd: "/test",
      stateSyncEngine: shadowEngine,
    });
    await server.start();
    const addr = server.httpServer.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);
    await waitForMessage(ws);

    const bootstrap = await sendRequest(ws, WS_METHODS.stateBootstrap);
    expect(bootstrap.error).toBeUndefined();
    expect(bootstrap.result).toEqual({
      projects: [],
      threads: [],
      lastStateSeq: 42,
    });
    expect(shadowEngine.loadSnapshotMock).toHaveBeenCalledTimes(1);

    const projects = await sendRequest(ws, WS_METHODS.projectsList);
    expect(projects.error).toBeUndefined();
    expect(projects.result).toEqual([]);
    expect(shadowEngine.listProjectsMock).toHaveBeenCalledTimes(1);

    const mirroredStateEvent: StateEvent = {
      seq: 43,
      eventType: "thread.upsert",
      entityId: "thread-1",
      payload: { threadId: "thread-1" },
      createdAt: "2026-02-20T00:00:01.000Z",
    };
    shadowEngine.emitStateEvent(mirroredStateEvent);
    const pushed = await waitForPush(ws, WS_CHANNELS.stateEvent);
    expect(pushed.data).toEqual(mirroredStateEvent);
  });

  it("keeps a shadow sync engine mirror in parity for websocket mutations", async () => {
    const stateDir = makeTempDir("t3code-ws-shadow-engine-state-");
    const projectCwd = makeTempDir("t3code-ws-shadow-engine-project-");
    const persistenceService = new PersistenceService({
      dbPath: path.join(stateDir, "state.sqlite"),
      legacyProjectsJsonPath: path.join(stateDir, "projects.json"),
    });
    const legacy = new LegacyStateSyncEngine({ persistenceService });
    const mirror = new LiveStoreStateMirror({ storeId: "ws-shadow-engine-parity-test" });
    const shadow = new ShadowStateSyncEngine({
      delegate: legacy,
      mirror,
    });

    try {
      server = createTestServer({
        cwd: "/test",
        stateSyncEngine: shadow,
      });
      await server.start();
      const addr = server.httpServer.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;

      const ws = await connectWs(port);
      connections.push(ws);
      await waitForMessage(ws);

      const addedProject = await sendRequest(ws, WS_METHODS.projectsAdd, { cwd: projectCwd });
      expect(addedProject.error).toBeUndefined();
      const projectId = (addedProject.result as { project: { id: string } }).project.id;

      const createdThread = await sendRequest(ws, WS_METHODS.threadsCreate, {
        projectId,
        title: "Shadow parity thread",
        model: "gpt-5.3-codex",
      });
      expect(createdThread.error).toBeUndefined();
      const threadId = (createdThread.result as { thread: { id: string } }).thread.id;

      const updatedThread = await sendRequest(ws, WS_METHODS.threadsUpdateTitle, {
        threadId,
        title: "Shadow parity thread updated",
      });
      expect(updatedThread.error).toBeUndefined();

      await waitForCondition(() => {
        const expected = legacy.loadSnapshot();
        const mirrored = mirror.debugReadSnapshot();
        return diffStateSnapshots(expected, mirrored).length === 0;
      });

      expect(diffStateSnapshots(legacy.loadSnapshot(), mirror.debugReadSnapshot())).toEqual([]);
    } finally {
      shadow.close();
    }
  });

  it("serves ordered bootstrap and catch-up through the read-pilot sync engine", async () => {
    const stateDir = makeTempDir("t3code-ws-read-pilot-state-");
    const projectCwd = makeTempDir("t3code-ws-read-pilot-project-");
    const persistenceService = new PersistenceService({
      dbPath: path.join(stateDir, "state.sqlite"),
      legacyProjectsJsonPath: path.join(stateDir, "projects.json"),
    });
    const legacy = new LegacyStateSyncEngine({ persistenceService });
    const mirror = new LiveStoreStateMirror({ storeId: "ws-read-pilot-parity-test" });
    const shadow = new ShadowStateSyncEngine({
      delegate: legacy,
      mirror,
    });
    const readPilot = new LiveStoreReadPilotStateSyncEngine({
      delegate: shadow,
      mirror,
    });

    try {
      server = createTestServer({
        cwd: "/test",
        stateSyncEngine: readPilot,
      });
      await server.start();
      const addr = server.httpServer.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;

      const ws = await connectWs(port);
      connections.push(ws);
      await waitForMessage(ws);

      const addedProject = await sendRequest(ws, WS_METHODS.projectsAdd, { cwd: projectCwd });
      expect(addedProject.error).toBeUndefined();
      const projectId = (addedProject.result as { project: { id: string } }).project.id;

      const createdThread = await sendRequest(ws, WS_METHODS.threadsCreate, {
        projectId,
        title: "Read pilot thread",
        model: "gpt-5.3-codex",
      });
      expect(createdThread.error).toBeUndefined();
      const threadId = (createdThread.result as { thread: { id: string } }).thread.id;

      await sendRequest(ws, WS_METHODS.threadsUpdateTitle, {
        threadId,
        title: "Read pilot thread updated",
      });

      await waitForCondition(() => {
        const diffs = diffStateSnapshots(legacy.loadSnapshot(), mirror.debugReadSnapshot());
        return diffs.length === 0;
      });

      const bootstrap = await sendRequest(ws, WS_METHODS.stateBootstrap);
      expect(bootstrap.error).toBeUndefined();
      const snapshot = bootstrap.result as {
        projects: Array<{ id: string }>;
        threads: Array<{ id: string; title: string }>;
        lastStateSeq: number;
      };
      expect(snapshot.projects).toHaveLength(1);
      expect(snapshot.threads).toHaveLength(1);
      expect(snapshot.threads[0]?.title).toBe("Read pilot thread updated");
      expect(snapshot.lastStateSeq).toBeGreaterThan(0);

      const catchUp = await sendRequest(ws, WS_METHODS.stateCatchUp, { afterSeq: 0 });
      expect(catchUp.error).toBeUndefined();
      const events = (catchUp.result as { events: StateEvent[] }).events;
      expect(events.length).toBeGreaterThan(0);
      for (let index = 1; index < events.length; index += 1) {
        const previous = events[index - 1];
        const current = events[index];
        expect(previous).toBeDefined();
        expect(current).toBeDefined();
        if (!previous || !current) continue;
        expect(current.seq).toBeGreaterThan(previous.seq);
      }
      expect(events.some((event) => event.eventType === "project.upsert")).toBe(true);
      expect(events.some((event) => event.eventType === "thread.upsert")).toBe(true);
    } finally {
      readPilot.close();
    }
  });

  it("falls back to legacy reads when the read-pilot mirror fails", async () => {
    const stateDir = makeTempDir("t3code-ws-read-pilot-fallback-state-");
    const projectCwd = makeTempDir("t3code-ws-read-pilot-fallback-project-");
    const persistenceService = new PersistenceService({
      dbPath: path.join(stateDir, "state.sqlite"),
      legacyProjectsJsonPath: path.join(stateDir, "projects.json"),
    });
    const legacy = new LegacyStateSyncEngine({ persistenceService });
    const failingMirror = {
      mirrorStateEvent: vi.fn(async () => undefined),
      dispose: vi.fn(async () => undefined),
      debugReadSnapshot: vi.fn(() => {
        throw new Error("mirror bootstrap failed");
      }),
      debugCatchUp: vi.fn(() => {
        throw new Error("mirror catch-up failed");
      }),
      debugListMessages: vi.fn(() => {
        throw new Error("mirror listMessages failed");
      }),
    } as unknown as LiveStoreStateMirror;
    const readPilot = new LiveStoreReadPilotStateSyncEngine({
      delegate: legacy,
      mirror: failingMirror,
    });

    try {
      server = createTestServer({
        cwd: "/test",
        stateSyncEngine: readPilot,
      });
      await server.start();
      const addr = server.httpServer.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;

      const ws = await connectWs(port);
      connections.push(ws);
      await waitForMessage(ws);

      const addedProject = await sendRequest(ws, WS_METHODS.projectsAdd, { cwd: projectCwd });
      expect(addedProject.error).toBeUndefined();
      const projectId = (addedProject.result as { project: { id: string } }).project.id;

      const createdThread = await sendRequest(ws, WS_METHODS.threadsCreate, {
        projectId,
        title: "Read pilot fallback thread",
        model: "gpt-5.3-codex",
      });
      expect(createdThread.error).toBeUndefined();
      const threadId = (createdThread.result as { thread: { id: string } }).thread.id;

      persistenceService.bindSessionToThread(
        "read-pilot-fallback-session",
        threadId,
        "runtime-thread-fallback",
      );
      persistenceService.persistUserMessageForTurn({
        sessionId: "read-pilot-fallback-session",
        clientMessageId: "msg-fallback-1",
        clientMessageText: "fallback message",
        input: "fallback message",
        attachments: [],
      });

      const bootstrap = await sendRequest(ws, WS_METHODS.stateBootstrap);
      expect(bootstrap.error).toBeUndefined();
      const snapshot = bootstrap.result as {
        projects: Array<{ id: string }>;
        threads: Array<{ id: string; title: string }>;
        lastStateSeq: number;
      };
      expect(snapshot.projects).toHaveLength(1);
      expect(snapshot.threads).toHaveLength(1);
      expect(snapshot.threads[0]?.title).toBe("Read pilot fallback thread");
      expect(snapshot.lastStateSeq).toBeGreaterThan(0);

      const catchUp = await sendRequest(ws, WS_METHODS.stateCatchUp, { afterSeq: 0 });
      expect(catchUp.error).toBeUndefined();
      const events = (catchUp.result as { events: StateEvent[] }).events;
      expect(events.length).toBeGreaterThan(0);
      expect(events.some((event) => event.eventType === "project.upsert")).toBe(true);
      expect(events.some((event) => event.eventType === "thread.upsert")).toBe(true);

      const listMessages = await sendRequest(ws, WS_METHODS.stateListMessages, {
        threadId,
        offset: 0,
        limit: 10,
      });
      expect(listMessages.error).toBeUndefined();
      const messages = (listMessages.result as { messages: Array<{ id: string }> }).messages;
      expect(messages.map((message) => message.id)).toEqual(["msg-fallback-1"]);
    } finally {
      readPilot.close();
    }
  });

  it("returns errors when strict read-pilot mode disables delegate fallback", async () => {
    const stateDir = makeTempDir("t3code-ws-read-pilot-strict-state-");
    const projectCwd = makeTempDir("t3code-ws-read-pilot-strict-project-");
    const persistenceService = new PersistenceService({
      dbPath: path.join(stateDir, "state.sqlite"),
      legacyProjectsJsonPath: path.join(stateDir, "projects.json"),
    });
    const legacy = new LegacyStateSyncEngine({ persistenceService });
    const failingMirror = {
      mirrorStateEvent: vi.fn(async () => undefined),
      dispose: vi.fn(async () => undefined),
      debugReadSnapshot: vi.fn(() => {
        throw new Error("strict mirror bootstrap failed");
      }),
      debugCatchUp: vi.fn(() => {
        throw new Error("strict mirror catch-up failed");
      }),
      debugListMessages: vi.fn(() => {
        throw new Error("strict mirror listMessages failed");
      }),
    } as unknown as LiveStoreStateMirror;
    const readPilot = new LiveStoreReadPilotStateSyncEngine({
      delegate: legacy,
      mirror: failingMirror,
      disableDelegateReadFallback: true,
    });

    try {
      server = createTestServer({
        cwd: "/test",
        stateSyncEngine: readPilot,
      });
      await server.start();
      const addr = server.httpServer.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;

      const ws = await connectWs(port);
      connections.push(ws);
      await waitForMessage(ws);

      const addedProject = await sendRequest(ws, WS_METHODS.projectsAdd, { cwd: projectCwd });
      expect(addedProject.error).toBeUndefined();
      const projectId = (addedProject.result as { project: { id: string } }).project.id;

      const createdThread = await sendRequest(ws, WS_METHODS.threadsCreate, {
        projectId,
        title: "Read pilot strict thread",
        model: "gpt-5.3-codex",
      });
      expect(createdThread.error).toBeUndefined();
      const threadId = (createdThread.result as { thread: { id: string } }).thread.id;

      const bootstrap = await sendRequest(ws, WS_METHODS.stateBootstrap);
      expect(bootstrap.result).toBeUndefined();
      expect(bootstrap.error?.message).toContain("strict mirror bootstrap failed");

      const catchUp = await sendRequest(ws, WS_METHODS.stateCatchUp, { afterSeq: 0 });
      expect(catchUp.result).toBeUndefined();
      expect(catchUp.error?.message).toContain("strict mirror catch-up failed");

      const listMessages = await sendRequest(ws, WS_METHODS.stateListMessages, {
        threadId,
        offset: 0,
        limit: 10,
      });
      expect(listMessages.result).toBeUndefined();
      expect(listMessages.error?.message).toContain("strict mirror listMessages failed");
    } finally {
      readPilot.close();
    }
  });

  it("broadcasts ordered state.event pushes", async () => {
    const stateDir = makeTempDir("t3code-ws-state-events-");
    const projectCwd = makeTempDir("t3code-ws-state-events-project-");
    server = createTestServer({ cwd: "/test", stateDir });
    await server.start();
    const addr = server.httpServer.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const writerWs = await connectWs(port);
    connections.push(writerWs);
    await waitForMessage(writerWs);

    const observerWs = await connectWs(port);
    connections.push(observerWs);
    await waitForMessage(observerWs);

    const addedProject = await sendRequest(writerWs, WS_METHODS.projectsAdd, { cwd: projectCwd });
    expect(addedProject.error).toBeUndefined();
    const firstStatePush = await waitForPush(observerWs, WS_CHANNELS.stateEvent);
    const firstEvent = firstStatePush.data as StateEvent;
    expect(firstEvent.eventType).toBe("project.upsert");

    const projectId = (addedProject.result as { project: { id: string } }).project.id;
    const createdThread = await sendRequest(writerWs, WS_METHODS.threadsCreate, {
      projectId,
      title: "State Event Thread",
      model: "gpt-5.3-codex",
    });
    expect(createdThread.error).toBeUndefined();
    const secondStatePush = await waitForPush(observerWs, WS_CHANNELS.stateEvent);
    const secondEvent = secondStatePush.data as StateEvent;
    expect(secondEvent.eventType).toBe("thread.upsert");
    expect(secondEvent.seq).toBeGreaterThan(firstEvent.seq);
  });

  it("returns unknown-session errors for checkpoint RPCs without an active provider session", async () => {
    server = createTestServer({ cwd: "/test" });
    await server.start();
    const addr = server.httpServer.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);
    await waitForMessage(ws);

    const listResponse = await sendRequest(ws, WS_METHODS.providersListCheckpoints, {
      sessionId: "missing-session",
    });
    expect(listResponse.result).toBeUndefined();
    expect(listResponse.error?.message).toContain("Unknown provider session");

    const revertResponse = await sendRequest(ws, WS_METHODS.providersRevertToCheckpoint, {
      sessionId: "missing-session",
      turnCount: 0,
    });
    expect(revertResponse.result).toBeUndefined();
    expect(revertResponse.error?.message).toContain("Unknown provider session");

    const diffResponse = await sendRequest(ws, WS_METHODS.providersGetCheckpointDiff, {
      sessionId: "missing-session",
      fromTurnCount: 0,
      toTurnCount: 1,
    });
    expect(diffResponse.result).toBeUndefined();
    expect(diffResponse.error?.message).toContain("Unknown provider session");
  });

  it("returns provider revert results even if checkpoint revert persistence fails", async () => {
    const stateDir = makeTempDir("t3code-ws-revert-failure-state-");
    const persistenceService = new PersistenceService({
      dbPath: path.join(stateDir, "state.sqlite"),
      legacyProjectsJsonPath: path.join(stateDir, "projects.json"),
    });

    const revertResult = {
      threadId: "runtime-thread-1",
      turnCount: 0,
      messageCount: 0,
      rolledBackTurns: 1,
      checkpoints: [
        {
          id: "root",
          turnCount: 0,
          messageCount: 0,
          label: "Start of conversation",
          isCurrent: true,
        },
      ],
    };
    vi.spyOn(ProviderManager.prototype, "revertToCheckpoint").mockResolvedValue(revertResult);
    vi.spyOn(persistenceService, "applyCheckpointRevert").mockImplementation(() => {
      throw new Error("persistence write failed");
    });

    server = createTestServer({ cwd: "/test", stateDir, persistenceService });
    await server.start();
    const addr = server.httpServer.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);
    await waitForMessage(ws);

    const response = await sendRequest(ws, WS_METHODS.providersRevertToCheckpoint, {
      sessionId: "sess-1",
      turnCount: 0,
    });
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual(revertResult);
  });

  it("rejects threads.update and keeps threads.updateTerminalState as the canonical route", async () => {
    const stateDir = makeTempDir("t3code-ws-threads-update-state-");
    const projectCwd = makeTempDir("t3code-ws-threads-update-project-");
    server = createTestServer({ cwd: "/test", stateDir });
    await server.start();
    const addr = server.httpServer.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);
    await waitForMessage(ws);

    const addedProject = await sendRequest(ws, WS_METHODS.projectsAdd, { cwd: projectCwd });
    expect(addedProject.error).toBeUndefined();
    const projectId = (addedProject.result as { project: { id: string } }).project.id;

    const createdThread = await sendRequest(ws, WS_METHODS.threadsCreate, {
      projectId,
      title: "Thread Terminal State",
      model: "gpt-5.3-codex",
    });
    expect(createdThread.error).toBeUndefined();
    const threadId = (createdThread.result as { thread: { id: string } }).thread.id;

    const deprecatedResponse = await sendRequest(ws, "threads.update", {
      threadId,
      terminalOpen: true,
    });
    expect(deprecatedResponse.result).toBeUndefined();
    expect(deprecatedResponse.error?.message).toContain('"threads.update" is unsupported');

    const canonicalResponse = await sendRequest(ws, WS_METHODS.threadsUpdateTerminalState, {
      threadId,
      terminalOpen: true,
    });
    expect(canonicalResponse.error).toBeUndefined();
    expect((canonicalResponse.result as { thread: { terminalOpen: boolean } }).thread.terminalOpen).toBe(
      true,
    );
  });

  it("routes terminal RPC methods and broadcasts terminal events", async () => {
    const cwd = makeTempDir("t3code-ws-terminal-cwd-");
    const terminalManager = new MockTerminalManager();
    server = createTestServer({
      cwd: "/test",
      terminalManager: terminalManager as unknown as TerminalManager,
    });
    await server.start();
    const addr = server.httpServer.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);
    await waitForMessage(ws);

    const open = await sendRequest(ws, WS_METHODS.terminalOpen, {
      threadId: "thread-1",
      cwd,
      cols: 100,
      rows: 24,
    });
    expect(open.error).toBeUndefined();
    expect((open.result as TerminalSessionSnapshot).threadId).toBe("thread-1");
    expect((open.result as TerminalSessionSnapshot).terminalId).toBe(DEFAULT_TERMINAL_ID);

    const write = await sendRequest(ws, WS_METHODS.terminalWrite, {
      threadId: "thread-1",
      data: "echo hello\n",
    });
    expect(write.error).toBeUndefined();

    const resize = await sendRequest(ws, WS_METHODS.terminalResize, {
      threadId: "thread-1",
      cols: 120,
      rows: 30,
    });
    expect(resize.error).toBeUndefined();

    const clear = await sendRequest(ws, WS_METHODS.terminalClear, {
      threadId: "thread-1",
    });
    expect(clear.error).toBeUndefined();

    const restart = await sendRequest(ws, WS_METHODS.terminalRestart, {
      threadId: "thread-1",
      cwd,
      cols: 120,
      rows: 30,
    });
    expect(restart.error).toBeUndefined();

    const close = await sendRequest(ws, WS_METHODS.terminalClose, {
      threadId: "thread-1",
      deleteHistory: true,
    });
    expect(close.error).toBeUndefined();

    const manualEvent: TerminalEvent = {
      type: "output",
      threadId: "thread-1",
      terminalId: DEFAULT_TERMINAL_ID,
      createdAt: new Date().toISOString(),
      data: "manual test output\n",
    };
    terminalManager.emit("event", manualEvent);

    const push = (await waitForMessage(ws)) as WsPush;
    expect(push.type).toBe("push");
    expect(push.channel).toBe(WS_CHANNELS.terminalEvent);
    expect((push.data as TerminalEvent).type).toBe("output");
  });

  it("detaches terminal event listener on stop for injected manager", async () => {
    const terminalManager = new MockTerminalManager();
    server = createTestServer({
      cwd: "/test",
      terminalManager: terminalManager as unknown as TerminalManager,
    });
    await server.start();

    expect(terminalManager.listenerCount("event")).toBe(1);

    await server.stop();
    server = null;

    expect(terminalManager.listenerCount("event")).toBe(0);
  });

  it("does not close an injected persistence service on stop", async () => {
    const stateDir = makeTempDir("t3code-ws-injected-persistence-state-");
    const persistenceService = new PersistenceService({
      dbPath: path.join(stateDir, "state.sqlite"),
      legacyProjectsJsonPath: path.join(stateDir, "projects.json"),
    });
    const closeSpy = vi.spyOn(persistenceService, "close");
    server = createServer({
      port: 0,
      cwd: "/test",
      persistenceService,
    });

    await server.start();
    await server.stop();
    server = null;

    expect(closeSpy).not.toHaveBeenCalled();
    persistenceService.close();
  });

  it("closes internally owned persistence service on stop", async () => {
    const stateDir = makeTempDir("t3code-ws-internal-persistence-state-");
    const closeSpy = vi.spyOn(PersistenceService.prototype, "close");
    server = createServer({
      port: 0,
      cwd: "/test",
      stateDbPath: path.join(stateDir, "state.sqlite"),
    });

    await server.start();
    await server.stop();
    server = null;

    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("returns validation errors for invalid terminal open params", async () => {
    server = createTestServer({ cwd: "/test" });
    await server.start();
    const addr = server.httpServer.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);
    await waitForMessage(ws);

    const response = await sendRequest(ws, WS_METHODS.terminalOpen, {
      threadId: "",
      cwd: "",
      cols: 1,
      rows: 1,
    });
    expect(response.error).toBeDefined();
  });

  it("handles invalid JSON gracefully", async () => {
    server = createTestServer({ cwd: "/test" });
    await server.start();
    const addr = server.httpServer.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);

    // Consume welcome
    await waitForMessage(ws);

    // Send garbage
    ws.send("not json at all");

    const response = (await waitForMessage(ws)) as WsResponse;
    expect(response.error).toBeDefined();
    expect(response.error!.message).toContain("Invalid request format");
  });

  it("supports projects list/add/dedupe/remove", async () => {
    const stateDir = makeTempDir("t3code-ws-projects-state-");
    const firstProjectCwd = makeTempDir("t3code-ws-project-a-");

    server = createTestServer({ stateDir, cwd: "/test" });
    await server.start();
    const addr = server.httpServer.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);
    await waitForMessage(ws);

    const emptyList = await sendRequest(ws, WS_METHODS.projectsList);
    expect(emptyList.error).toBeUndefined();
    expect(emptyList.result).toEqual([]);

    const created = await sendRequest(ws, WS_METHODS.projectsAdd, {
      cwd: firstProjectCwd,
    });
    expect(created.error).toBeUndefined();
    expect((created.result as { created: boolean }).created).toBe(true);

    const duplicate = await sendRequest(ws, WS_METHODS.projectsAdd, {
      cwd: firstProjectCwd,
    });
    expect(duplicate.error).toBeUndefined();
    expect((duplicate.result as { created: boolean }).created).toBe(false);

    const listed = await sendRequest(ws, WS_METHODS.projectsList);
    expect(listed.error).toBeUndefined();
    const listedProjects = listed.result as Array<{ id: string; cwd: string }>;
    expect(listedProjects).toHaveLength(1);

    const projectId = listedProjects[0]?.id;
    expect(projectId).toBeTruthy();
    if (!projectId) return;

    const updatedScripts = await sendRequest(ws, WS_METHODS.projectsUpdateScripts, {
      id: projectId,
      scripts: [
        {
          id: "setup",
          name: "Setup",
          command: "bun install",
          icon: "configure",
          runOnWorktreeCreate: true,
        },
      ],
    });
    expect(updatedScripts.error).toBeUndefined();
    const scriptPayload = (
      updatedScripts.result as {
        project: {
          scripts: Array<{
            id: string;
            name: string;
            command: string;
            icon: string;
            runOnWorktreeCreate: boolean;
          }>;
        };
      }
    ).project.scripts;
    expect(scriptPayload).toEqual([
      {
        id: "setup",
        name: "Setup",
        command: "bun install",
        icon: "configure",
        runOnWorktreeCreate: true,
      },
    ]);

    const removed = await sendRequest(ws, WS_METHODS.projectsRemove, {
      id: projectId,
    });
    expect(removed.error).toBeUndefined();

    const afterRemove = await sendRequest(ws, WS_METHODS.projectsList);
    expect(afterRemove.error).toBeUndefined();
    expect(afterRemove.result).toEqual([]);
  });

  it("supports projects.searchEntries", async () => {
    const workspace = makeTempDir("t3code-ws-workspace-entries-");
    fs.mkdirSync(path.join(workspace, "src", "components"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "src", "components", "Composer.tsx"), "export {};", "utf8");
    fs.writeFileSync(path.join(workspace, "README.md"), "# test", "utf8");
    fs.mkdirSync(path.join(workspace, ".git"), { recursive: true });
    fs.writeFileSync(path.join(workspace, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");

    server = createTestServer({ cwd: "/test" });
    await server.start();
    const addr = server.httpServer.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);
    await waitForMessage(ws);

    const response = await sendRequest(ws, WS_METHODS.projectsSearchEntries, {
      cwd: workspace,
      query: "comp",
      limit: 10,
    });
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({
      entries: expect.arrayContaining([
        expect.objectContaining({ path: "src/components", kind: "directory" }),
        expect.objectContaining({ path: "src/components/Composer.tsx", kind: "file" }),
      ]),
      truncated: false,
    });
  });

  it("supports git methods over websocket", async () => {
    const repoCwd = makeTempDir("t3code-ws-git-project-");

    server = createTestServer({ cwd: "/test" });
    await server.start();
    const addr = server.httpServer.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);
    await waitForMessage(ws);

    const beforeInit = await sendRequest(ws, WS_METHODS.gitListBranches, { cwd: repoCwd });
    expect(beforeInit.error).toBeUndefined();
    expect(beforeInit.result).toEqual({ branches: [], isRepo: false });

    const initResponse = await sendRequest(ws, WS_METHODS.gitInit, { cwd: repoCwd });
    expect(initResponse.error).toBeUndefined();

    const afterInit = await sendRequest(ws, WS_METHODS.gitListBranches, {
      cwd: repoCwd,
    });
    expect(afterInit.error).toBeUndefined();
    expect((afterInit.result as { isRepo: boolean }).isRepo).toBe(true);

    const pullResponse = await sendRequest(ws, WS_METHODS.gitPull, { cwd: repoCwd });
    expect(pullResponse.result).toBeUndefined();
    expect(pullResponse.error?.message).toBeDefined();
    expect(pullResponse.error?.message).not.toContain("Unknown method");
  });

  it("responds to git.status via the git manager", async () => {
    const gitManager = {
      status: vi.fn().mockResolvedValue({
        branch: "feature/test",
        hasWorkingTreeChanges: true,
        workingTree: {
          files: [{ path: "src/index.ts", insertions: 7, deletions: 2 }],
          insertions: 7,
          deletions: 2,
        },
        hasUpstream: false,
        aheadCount: 0,
        behindCount: 0,
        openPr: null,
      }),
      runStackedAction: vi.fn(),
    };

    server = createTestServer({ cwd: "/test", gitManager });
    await server.start();
    const addr = server.httpServer.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);
    await waitForMessage(ws);

    const response = await sendRequest(ws, WS_METHODS.gitStatus, {
      cwd: "/test",
    });
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({
      branch: "feature/test",
      hasWorkingTreeChanges: true,
      workingTree: {
        files: [{ path: "src/index.ts", insertions: 7, deletions: 2 }],
        insertions: 7,
        deletions: 2,
      },
      hasUpstream: false,
      aheadCount: 0,
      behindCount: 0,
      openPr: null,
    });
    expect(gitManager.status).toHaveBeenCalledWith({ cwd: "/test" });
  });

  it("returns errors from git.runStackedAction", async () => {
    const gitManager = {
      status: vi.fn(),
      runStackedAction: vi.fn().mockRejectedValue(new Error("Cannot push from detached HEAD.")),
    };

    server = createTestServer({ cwd: "/test", gitManager });
    await server.start();
    const addr = server.httpServer.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);
    await waitForMessage(ws);

    const response = await sendRequest(ws, WS_METHODS.gitRunStackedAction, {
      cwd: "/test",
      action: "commit_push",
    });
    expect(response.result).toBeUndefined();
    expect(response.error?.message).toContain("detached HEAD");
    expect(gitManager.runStackedAction).toHaveBeenCalledWith({
      cwd: "/test",
      action: "commit_push",
    });
  });

  it("prunes missing projects on startup", async () => {
    const stateDir = makeTempDir("t3code-ws-prune-state-");
    const existing = makeTempDir("t3code-ws-existing-project-");
    const missing = path.join(stateDir, "definitely-missing");
    const now = new Date().toISOString();
    const projectsFile = path.join(stateDir, "projects.json");

    fs.writeFileSync(
      projectsFile,
      JSON.stringify(
        {
          version: 1,
          projects: [
            {
              id: "project-existing",
              cwd: existing,
              name: "existing",
              createdAt: now,
              updatedAt: now,
            },
            {
              id: "project-missing",
              cwd: missing,
              name: "missing",
              createdAt: now,
              updatedAt: now,
            },
          ],
        },
        null,
        2,
      ),
    );

    server = createTestServer({ stateDir, cwd: "/test" });
    await server.start();
    const addr = server.httpServer.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);
    await waitForMessage(ws);

    const response = await sendRequest(ws, WS_METHODS.projectsList);
    expect(response.error).toBeUndefined();
    const listed = response.result as Array<{ id: string }>;
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe("project-existing");
  });

  it("rejects websocket connections without a valid auth token", async () => {
    server = createTestServer({ cwd: "/test", authToken: "secret-token" });
    await server.start();
    const addr = server.httpServer.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    await expect(connectWs(port)).rejects.toThrow("WebSocket connection failed");

    const authorizedWs = await connectWs(port, "secret-token");
    connections.push(authorizedWs);
    const welcome = (await waitForMessage(authorizedWs)) as WsPush;
    expect(welcome.channel).toBe(WS_CHANNELS.serverWelcome);
  });
});

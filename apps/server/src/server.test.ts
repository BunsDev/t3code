import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";
import { HttpClient, HttpRouter } from "effect/unstable/http";

import type { ServerConfigShape } from "./config";
import { ServerConfig } from "./config";
import { makeRoutesLayer } from "./httpRouter";

const AppUnderTest = HttpRouter.serve(makeRoutesLayer, {
  disableListenLog: true,
  disableLogger: true,
});

const buildWithTestConfig = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const stateDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-router-test-" });
  const testServerConfig: ServerConfigShape = {
    mode: "web",
    port: 0,
    host: "127.0.0.1",
    cwd: process.cwd(),
    keybindingsConfigPath: path.join(stateDir, "keybindings.json"),
    stateDir,
    staticDir: undefined,
    devUrl: undefined,
    noBrowser: true,
    authToken: undefined,
    autoBootstrapProjectFromCwd: false,
    logWebSocketEvents: false,
  };

  yield* Layer.build(AppUnderTest).pipe(Effect.provideService(ServerConfig, testServerConfig));
});

it.layer(NodeServices.layer)("server router seam", (it) => {
  it.effect("routes GET /health through HttpRouter", () =>
    Effect.gen(function* () {
      yield* buildWithTestConfig;

      const response = yield* HttpClient.get("/health");
      expect(response.status).toBe(200);
      expect(yield* response.json).toEqual({ ok: true });
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("returns 404 for non-health routes (seam preserves fallback ownership)", () =>
    Effect.gen(function* () {
      yield* buildWithTestConfig;

      const response = yield* HttpClient.get("/");
      expect(response.status).toBe(404);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("does not claim websocket-style route paths", () =>
    Effect.gen(function* () {
      yield* buildWithTestConfig;

      const response = yield* HttpClient.get("/ws?token=abc");
      expect(response.status).toBe(404);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );
});

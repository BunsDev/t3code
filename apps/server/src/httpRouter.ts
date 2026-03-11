import type http from "node:http";

import { Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";

const HEALTH_ROUTE_PATH = "/health";

const healthRouteLayer = HttpRouter.add(
  "GET",
  HEALTH_ROUTE_PATH,
  HttpServerResponse.json({ ok: true }),
);

export const makeRoutesLayer = Layer.mergeAll(healthRouteLayer);

export function tryHandleHttpRouterRequest(
  _request: http.IncomingMessage,
  _response: http.ServerResponse,
): boolean {
  // Legacy wsServer path remains in-place during migration.
  // Runtime now serves HttpRouter directly from server.ts.
  return false;
}

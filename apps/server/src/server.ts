import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

import { fixPath } from "./os-jank";
import * as SqlitePersistence from "./persistence/Layers/Sqlite";
import { ProviderHealthLive } from "./provider/Layers/ProviderHealth";
import { makeServerProviderLayer, makeServerRuntimeServicesLayer } from "./serverLayers";
import { ServerLoggerLive } from "./serverLogger";
import { AnalyticsServiceLayerLive } from "./telemetry/Layers/AnalyticsService";
import { OpenLive } from "./open";
import { ServerLayer } from "./wsServer";

export const makeServerLayer = Layer.unwrap(
  Effect.gen(function* () {
    yield* Effect.sync(fixPath);
    return ServerLayer.pipe(
      Layer.provideMerge(makeServerRuntimeServicesLayer()),
      Layer.provideMerge(makeServerProviderLayer()),
      Layer.provideMerge(ProviderHealthLive),
      Layer.provideMerge(SqlitePersistence.layerConfig),
      Layer.provideMerge(ServerLoggerLive),
      Layer.provideMerge(AnalyticsServiceLayerLive),
      Layer.provideMerge(OpenLive),
      Layer.provideMerge(FetchHttpClient.layer),
    );
  }),
);

export const runServer = Layer.launch(makeServerLayer);

import { LangfuseClient } from "@langfuse/client";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { propagateAttributes, startObservation } from "@langfuse/tracing";
import { NodeSDK } from "@opentelemetry/sdk-node";
import type { LangfuseAgentClient } from "./langfuse.js";

export type LangfuseRuntime = LangfuseAgentClient & {
  shutdown(): Promise<void>;
};

/** Keep the pi event observer independent of SDK transport and lifecycle. */
export function createLangfuseAgentClient(client: Pick<LangfuseClient, "score">): LangfuseAgentClient {
  return {
    createScore: (body) => client.score.create({ ...body, dataType: "NUMERIC" }),
    startRun(body) {
      const { name = "agent-run", timestamp, sessionId, ...attributes } = body;
      const propagated = {
        traceName: name,
        ...(sessionId !== undefined ? { sessionId } : {}),
      };
      const root = propagateAttributes(propagated, () =>
        startObservation(name, attributes, {
          asType: "agent",
          ...(timestamp !== undefined ? { startTime: timestamp } : {}),
        }),
      );
      const parentSpanContext = root.otelSpan.spanContext();

      return {
        id: root.traceId,
        update: (update = {}) => root.update(update),
        end: () => root.end(),
        startTool({ name, startTime, ...attributes }) {
          const tool = propagateAttributes(propagated, () =>
            startObservation(name, attributes, {
              asType: "tool",
              parentSpanContext,
              ...(startTime !== undefined ? { startTime } : {}),
            }),
          );
          return {
            id: tool.id,
            event({ name, ...attributes }) {
              // pi delivers events outside the original observation's context.
              propagateAttributes(propagated, () =>
                startObservation(name, attributes, {
                  asType: "event",
                  parentSpanContext: tool.otelSpan.spanContext(),
                }).end(),
              );
            },
            end(update = {}) {
              tool.update(update);
              tool.end();
            },
          };
        },
        startGeneration({ name, startTime, ...attributes }) {
          const generation = propagateAttributes(propagated, () =>
            startObservation(name, attributes, {
              asType: "generation",
              parentSpanContext,
              ...(startTime !== undefined ? { startTime } : {}),
            }),
          );
          return {
            id: generation.id,
            end(update = {}) {
              generation.update(update);
              generation.end();
            },
          };
        },
      };
    },
  };
}

export function createLangfuseRuntime(options: {
  publicKey: string;
  secretKey: string;
  baseUrl: string;
}): LangfuseRuntime {
  const client = new LangfuseClient(options);
  const sdk = new NodeSDK({
    spanProcessors: [new LangfuseSpanProcessor({ ...options, flushInterval: 5 })],
  });
  sdk.start();
  return {
    ...createLangfuseAgentClient(client),
    async shutdown() {
      const results = await Promise.allSettled([sdk.shutdown(), client.shutdown()]);
      const errors: unknown[] = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (errors.length > 0) throw new AggregateError(errors, "Langfuse shutdown failed");
    },
  };
}

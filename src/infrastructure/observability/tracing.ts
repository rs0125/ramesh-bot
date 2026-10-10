/**
 * LangSmith tracing. Full content is recorded on purpose during R&D (see AGENTS.md).
 * Tracing is off unless LANGSMITH_TRACING=true, and it must never change or fail a reply.
 */
import { traceable } from 'langsmith/traceable';
import { RunTree } from 'langsmith/run_trees';
import type {
  ModelRequest,
  TextModel,
  ToolModelSession,
  ToolSessionRequest,
} from '../../modules/assistant/assistant.types.js';
import type { GateEvent } from '../../modules/assistant/failure.js';

export function tracingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LANGSMITH_TRACING === 'true' || env.LANGCHAIN_TRACING_V2 === 'true';
}

/** Root span for one assistant turn. LangGraph node spans nest under it automatically. */
export function traceTurn<T>(
  input: Record<string, unknown>,
  options: { metadata: Record<string, unknown>; tags: string[] },
  run: () => Promise<T>,
  outputs: (value: T) => Record<string, unknown>,
): Promise<T> {
  if (!tracingEnabled()) return run();
  return traceable((_input: Record<string, unknown>) => run(), {
    name: 'ramesh.turn',
    run_type: 'chain',
    metadata: options.metadata,
    tags: options.tags,
    processOutputs: (value) => outputs(value as T),
  })(input);
}

export function traceTool<T>(
  name: string,
  rawArguments: string,
  run: () => Promise<T>,
): Promise<T> {
  if (!tracingEnabled()) return run();
  return traceable((_input: { tool: string; arguments: unknown }) => run(), {
    name: `tool:${name}`,
    run_type: 'tool',
  })({ tool: name, arguments: parseOrRaw(rawArguments) });
}

/** One visible span per check that fired, filterable by name (gate:<CODE>) in LangSmith. */
export function traceGate(event: GateEvent): void {
  if (!tracingEnabled()) return;
  try {
    void Promise.resolve(
      traceable((value: GateEvent) => value, {
        name: `gate:${event.code}`,
        run_type: 'chain',
        metadata: { gate_stage: event.stage, gate_code: event.code, blocking: event.blocking },
        tags: [event.blocking ? 'gate:blocking' : 'gate:degraded'],
      })(event),
    ).catch(() => {});
  } catch {
    // Tracing is diagnostic only.
  }
}

const TRACED = Symbol.for('ramesh.tracedModel');

/** Idempotent: wrapping an already traced model returns it unchanged. */
export function tracedModel(model: TextModel): TextModel {
  if (!tracingEnabled() || (model as unknown as Record<symbol, unknown>)[TRACED]) return model;
  const traced: TextModel & { [TRACED]: true } = {
    [TRACED]: true,
    get toolLoadingMode() {
      return model.toolLoadingMode;
    },
    complete: (request: ModelRequest, signal?: AbortSignal) =>
      traceable((value: ModelRequest) => model.complete(value, signal), {
        name: `model.${request.stage}`,
        run_type: 'llm',
        metadata: {
          stage: request.stage,
          ...(request.jsonSchema ? { schema: request.jsonSchema.name } : {}),
          ...(request.reasoningEffort ? { reasoning_effort: request.reasoningEffort } : {}),
        },
      })(request),
    ...(model.startToolSession
      ? {
          startToolSession: (request: ToolSessionRequest) =>
            tracedSession(model.startToolSession!(request), request),
        }
      : {}),
  };
  return traced;
}

function tracedSession(session: ToolModelSession, request: ToolSessionRequest): ToolModelSession {
  let first = true;
  return {
    next: (remainingCalls, signal, allowedToolNames) => {
      // The session holds the conversation; show the full prompt on its first step only.
      const opening = first
        ? {
            instructions: request.instructions,
            messages: request.messages,
            tools: request.tools.map((tool) => tool.name),
            batchable: request.batchable ?? [],
          }
        : {};
      first = false;
      return traceable(
        (input: { remainingCalls: number; allowedToolNames?: readonly string[] }) =>
          session.next(input.remainingCalls, signal, input.allowedToolNames),
        { name: 'model.worker', run_type: 'llm', metadata: { stage: 'worker' } },
      )({ remainingCalls, allowedToolNames, ...opening });
    },
    accept: (callId, output) => session.accept(callId, output),
    ...(session.revise ? { revise: (feedback: string) => session.revise!(feedback) } : {}),
    get droppedTools() {
      return session.droppedTools;
    },
  };
}

/** Best-effort upload of queued traces at shutdown; bounded so it can never hold the process. */
export async function flushTracing(timeoutMs = 3000): Promise<void> {
  if (!tracingEnabled()) return;
  await Promise.race([
    RunTree.getSharedClient()
      .awaitPendingTraceBatches()
      .catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, timeoutMs).unref()),
  ]);
}

function parseOrRaw(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** Stable failure and gate codes, so a rejected turn says which check fired and where. */
import { ModelFailureError } from './model-failure.js';

/** A deterministic application check rejected the turn. Codes are stable UPPER_SNAKE names. */
export class GateRejection extends Error {
  constructor(
    readonly code: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = 'GateRejection';
  }
}

export interface TurnFailure {
  stage: string;
  family: string;
  code: string;
  detail?: Record<string, unknown>;
}

/** A check that fired. Non-blocking events degrade the turn without ending it. */
export interface GateEvent {
  stage: string;
  code: string;
  blocking: boolean;
  detail?: Record<string, unknown>;
}

const STAGE = Symbol.for('ramesh.failure.stage');

/** Annotate rather than wrap: callers rely on instanceof checks of the original error. */
export function annotateStage(error: unknown, stage: string) {
  if (!error || typeof error !== 'object' || STAGE in error) return;
  Object.defineProperty(error, STAGE, { value: stage, enumerable: false });
}

export function failureStage(error: unknown): string | undefined {
  return error && typeof error === 'object' && STAGE in error
    ? String((error as Record<symbol, unknown>)[STAGE])
    : undefined;
}

export function classifyFailure(error: unknown, fallbackStage = 'unknown'): TurnFailure {
  if (error instanceof ModelFailureError)
    return {
      stage: failureStage(error) ?? error.details.stage,
      family: 'ModelFailureError',
      code: error.details.code,
      ...(error.details.httpStatus ? { detail: { httpStatus: error.details.httpStatus } } : {}),
    };
  const value = (error && typeof error === 'object' ? error : {}) as {
    name?: unknown;
    code?: unknown;
    message?: unknown;
    detail?: unknown;
  };
  const message = typeof value.message === 'string' ? value.message : '';
  const code =
    typeof value.code === 'string' && value.code
      ? value.code
      : /^[A-Z][A-Z0-9_]+$/.test(message)
        ? message
        : // Deadlines and cancellation arrive as DOMExceptions with prose messages.
          value.name === 'TimeoutError'
          ? 'TIMEOUT'
          : value.name === 'AbortError'
            ? 'ABORTED'
            : 'UNCLASSIFIED';
  // Free-text messages are never kept: they can carry provider bodies or user content.
  const detail =
    value.detail && typeof value.detail === 'object' && !Array.isArray(value.detail)
      ? (value.detail as Record<string, unknown>)
      : undefined;
  return {
    stage: failureStage(error) ?? fallbackStage,
    family: typeof value.name === 'string' && value.name ? value.name : 'Error',
    code,
    ...(detail && Object.keys(detail).length ? { detail } : {}),
  };
}

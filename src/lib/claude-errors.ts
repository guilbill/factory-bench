/**
 * Maps errors thrown by the `@anthropic-ai/sdk` client (plus a
 * locally-synthesized refusal error) to a short, human-readable message
 * plus an HTTP status the API route can return. Structurally parallel to
 * the old `gemini-errors.ts`, so `route.ts`'s catch block keeps the same
 * shape (Product invariants 11-15).
 *
 * This module only covers *thrown* errors (auth, network, rate limiting,
 * refusal). A model response that simply can't be turned into valid
 * `EditOperation`s (invalid tool schema, or Claude explicitly reporting an
 * unsupported instruction) is not an error — it's the normal "no edit
 * applied" outcome from Product invariant 7/9, and `route.ts` handles it
 * separately without going through this mapper.
 */

import Anthropic from '@anthropic-ai/sdk';

export type ClaudeErrorKind =
  | 'rate_limited'
  | 'invalid_api_key'
  | 'permission_denied'
  | 'refusal'
  | 'unavailable'
  | 'timeout'
  | 'unknown';

export interface MappedClaudeError {
  /** HTTP status code the API route should respond with. */
  status: number;
  /** Plain-English, user-facing message. Never contains SDK/API internals. */
  message: string;
  /** Machine-readable category, for callers that want to branch on it. */
  kind: ClaudeErrorKind;
  /** Seconds the upstream API suggested waiting before retrying, if known. */
  retryDelaySeconds?: number;
}

/**
 * Thrown by the route when Claude's response has `stop_reason === 'refusal'`
 * (Claude declined for its own content-policy reasons, independent of the
 * app's own "unsupported operation" explanation).
 */
export class ClaudeRefusalError extends Error {
  constructor(explanation: string | null) {
    super(`Content declined by Claude: ${explanation ?? 'no explanation given'}`);
    this.name = 'ClaudeRefusalError';
  }
}

function parseRetryDelaySeconds(headers: Headers | undefined): number | undefined {
  const raw = headers?.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds) : undefined;
}

function retrySuffix(retryDelaySeconds: number | undefined): string {
  if (!retryDelaySeconds) return '';
  const unit = retryDelaySeconds === 1 ? 'second' : 'seconds';
  return ` The API suggested waiting about ${retryDelaySeconds} ${unit} before trying again.`;
}

/**
 * Maps a caught error (or a `ClaudeRefusalError`) to a user-facing
 * status + message. Never includes API keys, credentials, or raw SDK/API
 * payloads in the returned message — those should only go to
 * `console.error` by the caller.
 */
export function mapClaudeError(error: unknown): MappedClaudeError {
  const err = error instanceof Error ? error : new Error(String(error));

  if (err.name === 'ClaudeRefusalError') {
    return {
      status: 400,
      kind: 'refusal',
      message:
        'Claude declined to process this request for its own content-policy reasons. Try a different image, or rephrase your instructions.',
    };
  }

  // Timeouts: an aborted request, or the SDK's own connection-timeout error.
  if (err instanceof Anthropic.APIUserAbortError || err instanceof Anthropic.APIConnectionTimeoutError) {
    return {
      status: 504,
      kind: 'timeout',
      message:
        'The request to Claude timed out. Please try again — a smaller image or a simpler instruction may help.',
    };
  }

  if (err instanceof Anthropic.RateLimitError) {
    const retryDelaySeconds = parseRetryDelaySeconds(err.headers);
    return {
      status: 429,
      kind: 'rate_limited',
      retryDelaySeconds,
      message: `You're sending requests a little too fast, or this demo is temporarily out of Claude API capacity. Please wait a moment and try again.${retrySuffix(retryDelaySeconds)}`,
    };
  }

  if (err instanceof Anthropic.AuthenticationError) {
    return {
      status: 500,
      kind: 'invalid_api_key',
      message: "The image editor isn't configured with a valid Claude API key. Please contact the site owner to fix the configuration.",
    };
  }

  if (err instanceof Anthropic.PermissionDeniedError) {
    return {
      status: 500,
      kind: 'permission_denied',
      message: "Access to the Claude API was denied. Please contact the site owner to check the API key's permissions.",
    };
  }

  if (err instanceof Anthropic.InternalServerError || err instanceof Anthropic.APIConnectionError) {
    return {
      status: 503,
      kind: 'unavailable',
      message: 'Claude is temporarily overloaded or unavailable. Please try again in a moment.',
    };
  }

  return {
    status: 500,
    kind: 'unknown',
    message: 'Something went wrong while processing your image. Please try again in a moment.',
  };
}

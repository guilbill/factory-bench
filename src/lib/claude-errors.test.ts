import assert from 'node:assert/strict';
import { test } from 'node:test';
import Anthropic from '@anthropic-ai/sdk';
import { ClaudeRefusalError, mapClaudeError } from './claude-errors';

test('maps a refusal to a 400 with actionable copy, without leaking the raw explanation', () => {
  const result = mapClaudeError(new ClaudeRefusalError('general_harms'));

  assert.equal(result.status, 400);
  assert.equal(result.kind, 'refusal');
  assert.match(result.message, /content-policy/i);
  assert.doesNotMatch(result.message, /general_harms/);
});

test('maps a refusal with no explanation the same way', () => {
  const result = mapClaudeError(new ClaudeRefusalError(null));

  assert.equal(result.status, 400);
  assert.equal(result.kind, 'refusal');
});

test('maps a rate limit error, surfacing a retry-after header', () => {
  const error = new Anthropic.RateLimitError(
    429,
    { error: { type: 'rate_limit_error', message: 'Rate limited' } },
    'Rate limited',
    new Headers({ 'retry-after': '5' })
  );

  const result = mapClaudeError(error);

  assert.equal(result.status, 429);
  assert.equal(result.kind, 'rate_limited');
  assert.equal(result.retryDelaySeconds, 5);
  assert.match(result.message, /too fast|capacity/i);
});

test('maps a rate limit error with no retry-after header', () => {
  const error = new Anthropic.RateLimitError(
    429,
    { error: { type: 'rate_limit_error', message: 'Rate limited' } },
    'Rate limited',
    new Headers()
  );

  const result = mapClaudeError(error);

  assert.equal(result.status, 429);
  assert.equal(result.retryDelaySeconds, undefined);
});

test('maps an authentication error without leaking SDK internals', () => {
  const error = new Anthropic.AuthenticationError(
    401,
    { error: { type: 'authentication_error', message: 'invalid x-api-key' } },
    'invalid x-api-key',
    new Headers()
  );

  const result = mapClaudeError(error);

  assert.equal(result.status, 500);
  assert.equal(result.kind, 'invalid_api_key');
  assert.match(result.message, /contact the site owner/i);
  assert.doesNotMatch(result.message, /x-api-key/);
});

test('maps a permission-denied error to a permission-denied message', () => {
  const error = new Anthropic.PermissionDeniedError(
    403,
    { error: { type: 'permission_error', message: 'Permission denied' } },
    'Permission denied',
    new Headers()
  );

  const result = mapClaudeError(error);

  assert.equal(result.status, 500);
  assert.equal(result.kind, 'permission_denied');
});

test('maps an internal server error to an overloaded message', () => {
  const error = new Anthropic.InternalServerError(
    529,
    { error: { type: 'overloaded_error', message: 'Overloaded' } },
    'Overloaded',
    new Headers()
  );

  const result = mapClaudeError(error);

  assert.equal(result.status, 503);
  assert.equal(result.kind, 'unavailable');
});

test('maps a connection timeout to a timeout message', () => {
  const error = new Anthropic.APIConnectionTimeoutError();

  const result = mapClaudeError(error);

  assert.equal(result.status, 504);
  assert.equal(result.kind, 'timeout');
});

test('maps a user-abort error to a timeout message', () => {
  const error = new Anthropic.APIUserAbortError();

  const result = mapClaudeError(error);

  assert.equal(result.status, 504);
  assert.equal(result.kind, 'timeout');
});

test('falls back to a generic message for unrecognized errors without leaking internals', () => {
  const result = mapClaudeError(new Error('some obscure internal SDK failure with a stack trace'));

  assert.equal(result.status, 500);
  assert.equal(result.kind, 'unknown');
  assert.doesNotMatch(result.message, /stack trace|SDK/);
});

test('handles non-Error thrown values gracefully', () => {
  const result = mapClaudeError('a plain string was thrown');

  assert.equal(result.status, 500);
  assert.equal(result.kind, 'unknown');
});

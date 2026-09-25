import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseEditOperation, parseEditOperations } from './edit-operations';

test('parses a well-formed crop operation', () => {
  const op = parseEditOperation({ type: 'crop', x: 1, y: 2, width: 3, height: 4 });
  assert.deepEqual(op, { type: 'crop', x: 1, y: 2, width: 3, height: 4 });
});

test('rejects a crop missing required fields', () => {
  assert.equal(parseEditOperation({ type: 'crop', x: 1, y: 2 }), null);
});

test('rejects an unknown operation type', () => {
  assert.equal(parseEditOperation({ type: 'blur_everything' }), null);
});

test('rejects a filter with an unsupported name', () => {
  assert.equal(parseEditOperation({ type: 'filter', name: 'vignette' }), null);
});

test('accepts a filter without an amount (grayscale/sepia/invert have none)', () => {
  const op = parseEditOperation({ type: 'filter', name: 'grayscale' });
  assert.deepEqual(op, { type: 'filter', name: 'grayscale', amount: undefined });
});

test('rejects a shape with an unsupported kind', () => {
  assert.equal(parseEditOperation({ type: 'shape', shape: 'star', x: 0, y: 0, width: 1, height: 1, color: 'red', fill: true }), null);
});

test('rejects a text operation with an empty string', () => {
  assert.equal(parseEditOperation({ type: 'text', text: '', x: 0, y: 0, fontSize: 10, color: 'red' }), null);
});

test('parses a full valid operations array', () => {
  const ops = parseEditOperations([
    { type: 'crop', x: 0, y: 0, width: 10, height: 10 },
    { type: 'rotate', degrees: 90 },
  ]);
  assert.equal(ops?.length, 2);
});

test('rejects an empty operations array', () => {
  assert.equal(parseEditOperations([]), null);
});

test('rejects the whole batch when any single operation is invalid', () => {
  const ops = parseEditOperations([{ type: 'rotate', degrees: 90 }, { type: 'crop', x: 0 }]);
  assert.equal(ops, null);
});

test('rejects non-array input', () => {
  assert.equal(parseEditOperations({ type: 'crop' }), null);
});

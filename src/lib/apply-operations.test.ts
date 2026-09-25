import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { applyOperations, InvalidOperationError } from './apply-operations';
import { MAX_RESIZE_DIMENSION, type EditOperation } from './edit-operations';

async function makeFixture(width = 100, height = 100, background = { r: 200, g: 100, b: 50 }): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background },
  })
    .png()
    .toBuffer();
}

test('crop produces the expected output dimensions', async () => {
  const fixture = await makeFixture(100, 100);
  const { buffer } = await applyOperations(fixture, [{ type: 'crop', x: 10, y: 10, width: 40, height: 20 }]);

  const metadata = await sharp(buffer).metadata();
  assert.equal(metadata.width, 40);
  assert.equal(metadata.height, 20);
  assert.equal(metadata.format, 'png');
});

test('resize scales to the requested pixel dimensions', async () => {
  const fixture = await makeFixture(100, 100);
  const { buffer } = await applyOperations(fixture, [{ type: 'resize', width: 50, height: 25 }]);

  const metadata = await sharp(buffer).metadata();
  assert.equal(metadata.width, 50);
  assert.equal(metadata.height, 25);
});

test('rotate by 90 degrees swaps width and height', async () => {
  const fixture = await makeFixture(100, 60);
  const { buffer } = await applyOperations(fixture, [{ type: 'rotate', degrees: 90 }]);

  const metadata = await sharp(buffer).metadata();
  assert.equal(metadata.width, 60);
  assert.equal(metadata.height, 100);
});

test('grayscale filter removes color saturation', async () => {
  const fixture = await makeFixture(20, 20, { r: 200, g: 50, b: 50 });
  const { buffer } = await applyOperations(fixture, [{ type: 'filter', name: 'grayscale' }]);

  const pixel = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
  const [r, g, b] = pixel.data;
  assert.ok(Math.abs(r - g) <= 1 && Math.abs(g - b) <= 1, `expected r≈g≈b for grayscale, got ${r},${g},${b}`);
});

test('invert filter flips pixel values', async () => {
  const fixture = await makeFixture(10, 10, { r: 10, g: 10, b: 10 });
  const { buffer } = await applyOperations(fixture, [{ type: 'filter', name: 'invert' }]);

  const pixel = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
  const [r, g, b] = pixel.data;
  assert.ok(r > 200 && g > 200 && b > 200, `expected inverted near-white pixel, got ${r},${g},${b}`);
});

test('blur and sharpen filters run without error and preserve dimensions', async () => {
  const fixture = await makeFixture(30, 30);
  const blurred = await applyOperations(fixture, [{ type: 'filter', name: 'blur', amount: 3 }]);
  const sharpened = await applyOperations(fixture, [{ type: 'filter', name: 'sharpen', amount: 1 }]);

  const blurredMeta = await sharp(blurred.buffer).metadata();
  const sharpenedMeta = await sharp(sharpened.buffer).metadata();
  assert.equal(blurredMeta.width, 30);
  assert.equal(sharpenedMeta.width, 30);
});

test('brightness_contrast brightens a dark image', async () => {
  const fixture = await makeFixture(10, 10, { r: 50, g: 50, b: 50 });
  const { buffer } = await applyOperations(fixture, [{ type: 'brightness_contrast', brightness: 2 }]);

  const pixel = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
  assert.ok(pixel.data[0] > 50, `expected brighter pixel, got ${pixel.data[0]}`);
});

test('a crop overhanging the edge is clamped instead of throwing (Product invariant 9)', async () => {
  const fixture = await makeFixture(100, 100);
  const { buffer, regionAdjusted } = await applyOperations(fixture, [
    { type: 'crop', x: 80, y: 80, width: 50, height: 50 },
  ]);

  const metadata = await sharp(buffer).metadata();
  assert.equal(metadata.width, 20);
  assert.equal(metadata.height, 20);
  assert.equal(regionAdjusted, true);
});

test('a shape region overhanging the edge is clamped and reported as adjusted', async () => {
  const fixture = await makeFixture(50, 50);
  const { regionAdjusted } = await applyOperations(fixture, [
    { type: 'shape', shape: 'rectangle', x: 40, y: 10, width: 30, height: 10, color: '#ff0000', fill: true },
  ]);

  assert.equal(regionAdjusted, true);
});

test('a fully in-bounds crop is not reported as adjusted', async () => {
  const fixture = await makeFixture(100, 100);
  const { regionAdjusted } = await applyOperations(fixture, [{ type: 'crop', x: 0, y: 0, width: 50, height: 50 }]);

  assert.equal(regionAdjusted, false);
});

test('a zero-width crop throws InvalidOperationError instead of silently collapsing', async () => {
  const fixture = await makeFixture(100, 100);

  await assert.rejects(
    () => applyOperations(fixture, [{ type: 'crop', x: 10, y: 10, width: 0, height: 20 }]),
    InvalidOperationError
  );
});

test('a resize to 0x0 throws InvalidOperationError', async () => {
  const fixture = await makeFixture(100, 100);

  await assert.rejects(() => applyOperations(fixture, [{ type: 'resize', width: 0, height: 0 }]), InvalidOperationError);
});

test('an extreme resize target is clamped to MAX_RESIZE_DIMENSION instead of reaching sharp unbounded', async () => {
  const fixture = await makeFixture(10, 10);
  const { buffer, regionAdjusted } = await applyOperations(fixture, [
    { type: 'resize', width: 20000, height: 20000 },
  ]);

  const metadata = await sharp(buffer).metadata();
  assert.equal(metadata.width, MAX_RESIZE_DIMENSION);
  assert.equal(metadata.height, MAX_RESIZE_DIMENSION);
  assert.equal(regionAdjusted, true);
});

test('a resize within MAX_RESIZE_DIMENSION is not reported as adjusted', async () => {
  const fixture = await makeFixture(100, 100);
  const { regionAdjusted } = await applyOperations(fixture, [{ type: 'resize', width: 50, height: 25 }]);

  assert.equal(regionAdjusted, false);
});

test('text and shape operations composite without error', async () => {
  const fixture = await makeFixture(100, 100);
  const ops: EditOperation[] = [
    { type: 'text', text: 'DONE', x: 10, y: 20, fontSize: 14, color: '#ffffff' },
    { type: 'shape', shape: 'ellipse', x: 5, y: 5, width: 30, height: 30, color: '#00ff00', fill: false },
    { type: 'shape', shape: 'line', x: 0, y: 0, width: 20, height: 20, color: '#0000ff', fill: false },
  ];

  const { buffer } = await applyOperations(fixture, ops);
  const metadata = await sharp(buffer).metadata();
  assert.equal(metadata.width, 100);
  assert.equal(metadata.height, 100);
});

test('a shape drawn after a crop uses the post-crop canvas frame (Product invariant 4)', async () => {
  const fixture = await makeFixture(100, 100);
  // Crop to a 40x40 region, then draw a shape that would be out of bounds on
  // the *original* 100x100 canvas but is in-bounds on the 40x40 cropped one.
  const ops: EditOperation[] = [
    { type: 'crop', x: 0, y: 0, width: 40, height: 40 },
    { type: 'shape', shape: 'rectangle', x: 5, y: 5, width: 20, height: 20, color: '#ff00ff', fill: true },
  ];

  const { buffer, regionAdjusted } = await applyOperations(fixture, ops);
  const metadata = await sharp(buffer).metadata();
  assert.equal(metadata.width, 40);
  assert.equal(metadata.height, 40);
  assert.equal(regionAdjusted, false);
});

test('text with special characters in text/color does not break SVG compositing', async () => {
  const fixture = await makeFixture(50, 50);
  const ops: EditOperation[] = [{ type: 'text', text: '<script>&"\'', x: 5, y: 10, fontSize: 10, color: 'red' }];

  const { buffer } = await applyOperations(fixture, ops);
  const metadata = await sharp(buffer).metadata();
  assert.equal(metadata.width, 50);
});

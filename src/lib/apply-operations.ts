/**
 * Applies a validated list of `EditOperation`s to real image bytes with
 * `sharp`, independent of Claude so it's unit-testable with fixture images.
 *
 * Operations are applied strictly in array order, and the buffer is
 * re-materialized after every operation so the next operation (and its
 * dimension bookkeeping) always sees the current canvas — this is what lets
 * Product invariant 4 hold for a request like "crop then draw a box around
 * the dog", where the box's coordinates are in the *post-crop* frame.
 */

import sharp from 'sharp';
import {
  BLUR_SIGMA_RANGE,
  BRIGHTNESS_CONTRAST_RANGE,
  MAX_RESIZE_DIMENSION,
  SHARPEN_SIGMA_RANGE,
  type BrightnessContrastOperation,
  type EditOperation,
  type FilterOperation,
  type ShapeOperation,
  type TextOperation,
} from './edit-operations';

/**
 * Thrown when an operation's parameters are unsalvageable even after
 * clamping to the current image bounds (e.g. a zero-width crop, a resize to
 * 0x0). The route treats this the same as an unsupported instruction
 * (Product invariant 9) rather than a crash.
 */
export class InvalidOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidOperationError';
  }
}

export interface ApplyOperationsResult {
  buffer: Buffer;
  /**
   * True if any crop/shape region was clamped to fit inside the image
   * bounds, or a resize target was clamped to `MAX_RESIZE_DIMENSION`.
   * `route.ts` uses this to append the Product invariant 9 "adjusted to
   * fit" note to Claude's summary — Claude writes that summary before this
   * executor runs, so it can't know about clamping in advance.
   */
  regionAdjusted: boolean;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

function clampRegion(region: Region, canvasWidth: number, canvasHeight: number): Region & { adjusted: boolean } {
  const rawX = Math.round(region.x);
  const rawY = Math.round(region.y);
  const rawWidth = Math.round(region.width);
  const rawHeight = Math.round(region.height);

  const x = clampNumber(rawX, 0, Math.max(canvasWidth - 1, 0));
  const y = clampNumber(rawY, 0, Math.max(canvasHeight - 1, 0));
  const width = Math.min(rawWidth, canvasWidth - x);
  const height = Math.min(rawHeight, canvasHeight - y);

  if (width <= 0 || height <= 0) {
    throw new InvalidOperationError(
      `The requested region (x=${region.x}, y=${region.y}, width=${region.width}, height=${region.height}) collapses to nothing once clamped to the current ${canvasWidth}x${canvasHeight} image.`
    );
  }

  const adjusted = x !== rawX || y !== rawY || width !== rawWidth || height !== rawHeight;
  return { x, y, width, height, adjusted };
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function readDimensions(buffer: Buffer): Promise<{ width: number; height: number }> {
  const metadata = await sharp(buffer).metadata();
  if (!metadata.width || !metadata.height) {
    throw new InvalidOperationError('Could not read the current image dimensions.');
  }
  return { width: metadata.width, height: metadata.height };
}

async function applyBrightnessContrast(buffer: Buffer, op: BrightnessContrastOperation): Promise<Buffer> {
  let pipeline = sharp(buffer);
  if (op.brightness !== undefined) {
    const brightness = clampNumber(op.brightness, BRIGHTNESS_CONTRAST_RANGE.min, BRIGHTNESS_CONTRAST_RANGE.max);
    pipeline = pipeline.modulate({ brightness });
  }
  if (op.contrast !== undefined) {
    // Standard linear-contrast formula: output = (input - 128) * contrast + 128.
    const contrast = clampNumber(op.contrast, BRIGHTNESS_CONTRAST_RANGE.min, BRIGHTNESS_CONTRAST_RANGE.max);
    pipeline = pipeline.linear(contrast, 128 * (1 - contrast));
  }
  return pipeline.toBuffer();
}

async function applyFilter(buffer: Buffer, op: FilterOperation): Promise<Buffer> {
  const pipeline = sharp(buffer);
  switch (op.name) {
    case 'grayscale':
      return pipeline.grayscale().toBuffer();
    case 'sepia':
      return pipeline.grayscale().tint({ r: 112, g: 66, b: 20 }).toBuffer();
    case 'invert':
      return pipeline.negate({ alpha: false }).toBuffer();
    case 'blur': {
      const sigma = clampNumber(op.amount ?? 5, BLUR_SIGMA_RANGE.min, BLUR_SIGMA_RANGE.max);
      return pipeline.blur(sigma).toBuffer();
    }
    case 'sharpen': {
      const sigma = clampNumber(op.amount ?? 1, SHARPEN_SIGMA_RANGE.min, SHARPEN_SIGMA_RANGE.max);
      return pipeline.sharpen({ sigma }).toBuffer();
    }
  }
}

async function applyText(buffer: Buffer, op: TextOperation, canvasWidth: number, canvasHeight: number): Promise<Buffer> {
  const fontSize = Math.max(1, Math.round(op.fontSize));
  const svg = `<svg width="${canvasWidth}" height="${canvasHeight}" xmlns="http://www.w3.org/2000/svg">
    <text x="${op.x}" y="${op.y}" font-size="${fontSize}" font-family="sans-serif" fill="${escapeXml(op.color)}">${escapeXml(op.text)}</text>
  </svg>`;
  return sharp(buffer)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .toBuffer();
}

async function applyShape(buffer: Buffer, op: ShapeOperation, region: Region, canvasWidth: number, canvasHeight: number): Promise<Buffer> {
  const color = escapeXml(op.color);
  const strokeWidth = 3;
  const fillAttrs = op.fill ? `fill="${color}"` : `fill="none" stroke="${color}" stroke-width="${strokeWidth}"`;

  let shapeSvg: string;
  switch (op.shape) {
    case 'rectangle':
      shapeSvg = `<rect x="${region.x}" y="${region.y}" width="${region.width}" height="${region.height}" ${fillAttrs} />`;
      break;
    case 'ellipse': {
      const cx = region.x + region.width / 2;
      const cy = region.y + region.height / 2;
      shapeSvg = `<ellipse cx="${cx}" cy="${cy}" rx="${region.width / 2}" ry="${region.height / 2}" ${fillAttrs} />`;
      break;
    }
    case 'line':
      shapeSvg = `<line x1="${region.x}" y1="${region.y}" x2="${region.x + region.width}" y2="${region.y + region.height}" stroke="${color}" stroke-width="${strokeWidth}" />`;
      break;
  }

  const svg = `<svg width="${canvasWidth}" height="${canvasHeight}" xmlns="http://www.w3.org/2000/svg">${shapeSvg}</svg>`;
  return sharp(buffer)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .toBuffer();
}

export async function applyOperations(input: Buffer, operations: EditOperation[]): Promise<ApplyOperationsResult> {
  let buffer = input;
  let regionAdjusted = false;

  for (const op of operations) {
    const { width, height } = await readDimensions(buffer);

    switch (op.type) {
      case 'crop': {
        const region = clampRegion(op, width, height);
        regionAdjusted ||= region.adjusted;
        buffer = await sharp(buffer).extract({ left: region.x, top: region.y, width: region.width, height: region.height }).toBuffer();
        break;
      }

      case 'resize': {
        const rawW = Math.round(op.width);
        const rawH = Math.round(op.height);
        if (rawW <= 0 || rawH <= 0) {
          throw new InvalidOperationError(`Resize target must be a positive size (got ${op.width}x${op.height}).`);
        }
        const w = clampNumber(rawW, 1, MAX_RESIZE_DIMENSION);
        const h = clampNumber(rawH, 1, MAX_RESIZE_DIMENSION);
        regionAdjusted ||= w !== rawW || h !== rawH;
        buffer = await sharp(buffer).resize(w, h).toBuffer();
        break;
      }

      case 'rotate':
        buffer = await sharp(buffer).rotate(op.degrees).toBuffer();
        break;

      case 'brightness_contrast':
        buffer = await applyBrightnessContrast(buffer, op);
        break;

      case 'filter':
        buffer = await applyFilter(buffer, op);
        break;

      case 'text':
        buffer = await applyText(buffer, op, width, height);
        break;

      case 'shape': {
        const region = clampRegion(op, width, height);
        regionAdjusted ||= region.adjusted;
        buffer = await applyShape(buffer, op, region, width, height);
        break;
      }
    }
  }

  const png = await sharp(buffer).png().toBuffer();
  return { buffer: png, regionAdjusted };
}

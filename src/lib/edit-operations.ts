/**
 * The fixed edit vocabulary Claude is allowed to express, matching Product
 * spec invariant 2 (`specs/gh-12/PRODUCT.md`) exactly. All coordinates and
 * dimensions are pixels in the frame of the image *as it exists immediately
 * before that operation* (Product invariant 4) — the executor in
 * `apply-operations.ts` tracks current canvas dimensions across the list.
 *
 * `brightness`, `contrast`, and `filter.amount` are defined here as the
 * units the `sharp` executor actually consumes (TECH.md flagged these as
 * unitless in the original spec): brightness/contrast are multipliers where
 * 1 means "no change", matching `sharp().modulate({ brightness })` and the
 * linear-contrast formula the executor applies. `filter.amount` is a sharp
 * blur/sharpen sigma and is ignored for filters that don't take one
 * (grayscale, sepia, invert).
 */

import type Anthropic from '@anthropic-ai/sdk';

export type FilterName = 'grayscale' | 'sepia' | 'invert' | 'blur' | 'sharpen';
export type ShapeKind = 'rectangle' | 'ellipse' | 'line';

export const BRIGHTNESS_CONTRAST_RANGE = { min: 0.1, max: 3 } as const;
export const BLUR_SIGMA_RANGE = { min: 0.3, max: 100 } as const;
export const SHARPEN_SIGMA_RANGE = { min: 0.3, max: 10 } as const;

export interface CropOperation {
  type: 'crop';
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ResizeOperation {
  type: 'resize';
  width: number;
  height: number;
}

export interface RotateOperation {
  type: 'rotate';
  degrees: number;
}

export interface BrightnessContrastOperation {
  type: 'brightness_contrast';
  /** Multiplier, e.g. 1.4 = 40% brighter. 1 = no change. Range 0.1-3. */
  brightness?: number;
  /** Multiplier, e.g. 1.4 = 40% more contrast. 1 = no change. Range 0.1-3. */
  contrast?: number;
}

export interface FilterOperation {
  type: 'filter';
  name: FilterName;
  /**
   * Blur/sharpen sigma (blur: 0.3-100, sharpen: 0.3-10). Ignored for
   * grayscale/sepia/invert, which have no intensity parameter.
   */
  amount?: number;
}

export interface TextOperation {
  type: 'text';
  text: string;
  x: number;
  y: number;
  fontSize: number;
  color: string;
}

export interface ShapeOperation {
  type: 'shape';
  shape: ShapeKind;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  fill: boolean;
}

export type EditOperation =
  | CropOperation
  | ResizeOperation
  | RotateOperation
  | BrightnessContrastOperation
  | FilterOperation
  | TextOperation
  | ShapeOperation;

const FILTER_NAMES: ReadonlySet<string> = new Set(['grayscale', 'sepia', 'invert', 'blur', 'sharpen']);
const SHAPE_KINDS: ReadonlySet<string> = new Set(['rectangle', 'ellipse', 'line']);

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Validates a single operation parsed from Claude's tool input against the
 * schema above. Returns the narrowed operation, or `null` if `value` isn't a
 * well-formed operation of any known type (Product invariant 16: reject
 * rather than silently coerce).
 */
export function parseEditOperation(value: unknown): EditOperation | null {
  if (!value || typeof value !== 'object') return null;
  const op = value as Record<string, unknown>;

  switch (op.type) {
    case 'crop':
      if (![op.x, op.y, op.width, op.height].every(isFiniteNumber)) return null;
      return { type: 'crop', x: op.x as number, y: op.y as number, width: op.width as number, height: op.height as number };

    case 'resize':
      if (![op.width, op.height].every(isFiniteNumber)) return null;
      return { type: 'resize', width: op.width as number, height: op.height as number };

    case 'rotate':
      if (!isFiniteNumber(op.degrees)) return null;
      return { type: 'rotate', degrees: op.degrees as number };

    case 'brightness_contrast': {
      if (op.brightness !== undefined && !isFiniteNumber(op.brightness)) return null;
      if (op.contrast !== undefined && !isFiniteNumber(op.contrast)) return null;
      return {
        type: 'brightness_contrast',
        brightness: op.brightness as number | undefined,
        contrast: op.contrast as number | undefined,
      };
    }

    case 'filter': {
      if (typeof op.name !== 'string' || !FILTER_NAMES.has(op.name)) return null;
      if (op.amount !== undefined && !isFiniteNumber(op.amount)) return null;
      return { type: 'filter', name: op.name as FilterName, amount: op.amount as number | undefined };
    }

    case 'text':
      if (typeof op.text !== 'string' || !op.text) return null;
      if (![op.x, op.y, op.fontSize].every(isFiniteNumber)) return null;
      if (typeof op.color !== 'string' || !op.color) return null;
      return {
        type: 'text',
        text: op.text,
        x: op.x as number,
        y: op.y as number,
        fontSize: op.fontSize as number,
        color: op.color,
      };

    case 'shape':
      if (typeof op.shape !== 'string' || !SHAPE_KINDS.has(op.shape)) return null;
      if (![op.x, op.y, op.width, op.height].every(isFiniteNumber)) return null;
      if (typeof op.color !== 'string' || !op.color) return null;
      if (typeof op.fill !== 'boolean') return null;
      return {
        type: 'shape',
        shape: op.shape as ShapeKind,
        x: op.x as number,
        y: op.y as number,
        width: op.width as number,
        height: op.height as number,
        color: op.color,
        fill: op.fill,
      };

    default:
      return null;
  }
}

/**
 * Validates a full operations array from Claude's `apply_edit_operations`
 * tool input. Returns `null` (reject the whole batch) if `value` isn't an
 * array of one or more well-formed operations, so a partially-invalid
 * response never results in a partially-applied edit.
 */
export function parseEditOperations(value: unknown): EditOperation[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const operations: EditOperation[] = [];
  for (const item of value) {
    const parsed = parseEditOperation(item);
    if (!parsed) return null;
    operations.push(parsed);
  }
  return operations;
}

/**
 * JSON schema for the `apply_edit_operations` tool input, describing the
 * same vocabulary and units as the types above so Claude's structured
 * output matches what `parseEditOperations` accepts.
 */
export const APPLY_EDIT_OPERATIONS_INPUT_SCHEMA: Anthropic.Tool.InputSchema = {
  type: 'object',
  properties: {
    operations: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['crop', 'resize', 'rotate', 'brightness_contrast', 'filter', 'text', 'shape'],
          },
          x: { type: 'number', description: 'Left edge in pixels, current-canvas frame.' },
          y: { type: 'number', description: 'Top edge in pixels, current-canvas frame.' },
          width: { type: 'number', description: 'Pixels.' },
          height: { type: 'number', description: 'Pixels.' },
          degrees: { type: 'number', description: 'Rotation angle in degrees, clockwise positive.' },
          brightness: {
            type: 'number',
            description: `Brightness multiplier, ${BRIGHTNESS_CONTRAST_RANGE.min}-${BRIGHTNESS_CONTRAST_RANGE.max}. 1 means no change; >1 brighter; <1 darker.`,
          },
          contrast: {
            type: 'number',
            description: `Contrast multiplier, ${BRIGHTNESS_CONTRAST_RANGE.min}-${BRIGHTNESS_CONTRAST_RANGE.max}. 1 means no change; >1 more contrast; <1 less.`,
          },
          name: { type: 'string', enum: ['grayscale', 'sepia', 'invert', 'blur', 'sharpen'] },
          amount: {
            type: 'number',
            description: `Intensity for 'blur' (sigma, ${BLUR_SIGMA_RANGE.min}-${BLUR_SIGMA_RANGE.max}) or 'sharpen' (sigma, ${SHARPEN_SIGMA_RANGE.min}-${SHARPEN_SIGMA_RANGE.max}). Omit for grayscale/sepia/invert.`,
          },
          text: { type: 'string', description: "Caption/label text for a 'text' operation." },
          fontSize: { type: 'number', description: "Font size in pixels for a 'text' operation." },
          color: { type: 'string', description: 'CSS color, e.g. "#ff0000" or "red".' },
          shape: { type: 'string', enum: ['rectangle', 'ellipse', 'line'] },
          fill: { type: 'boolean', description: "Whether a 'shape' operation is filled (true) or outlined (false)." },
        },
        required: ['type'],
      },
    },
    summary: {
      type: 'string',
      description: 'Short, specific description of what was actually changed, e.g. "Cropped to the top half, converted to grayscale, added the text \\"DONE\\"."',
    },
  },
  required: ['operations', 'summary'],
};

export const REPORT_UNSUPPORTED_INSTRUCTION_INPUT_SCHEMA: Anthropic.Tool.InputSchema = {
  type: 'object',
  properties: {
    reason: {
      type: 'string',
      description: "Clear, specific explanation of what part of the instruction isn't supported and why.",
    },
  },
  required: ['reason'],
};

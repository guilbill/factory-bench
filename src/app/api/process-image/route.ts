import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import sharp from 'sharp';
import {
  APPLY_EDIT_OPERATIONS_INPUT_SCHEMA,
  parseEditOperations,
  REPORT_UNSUPPORTED_INSTRUCTION_INPUT_SCHEMA,
} from '@/lib/edit-operations';
import { applyOperations, InvalidOperationError } from '@/lib/apply-operations';
import { ClaudeRefusalError, mapClaudeError } from '@/lib/claude-errors';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY || ''
});

// Claude's current flagship model: vision + tool use, a good default for
// this workload's accuracy/latency/cost tradeoff. Kept as a single constant
// so it's a one-line bump later.
const CLAUDE_MODEL = 'claude-sonnet-5';

const SUPPORTED_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
type SupportedMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

const SYSTEM_PROMPT = `You are the editing engine behind an image editor. You are given an image and a natural-language instruction, and must translate the instruction into a structured list of edit operations from a fixed vocabulary. You never invent or redraw image content yourself.

Supported operations:
- crop: extract a rectangular region (x, y, width, height in pixels).
- resize: scale to a target pixel size (width, height).
- rotate: rotate by a specified or implied angle in degrees (clockwise positive).
- brightness_contrast: adjust brightness and/or contrast as multipliers where 1 means no change.
- filter: grayscale, sepia, invert, blur, or sharpen, applied to the whole image.
- text: render a caption/label at a position with a font size and color.
- shape: draw a rectangle, ellipse, or line, filled or outlined, in a color.

Always call apply_edit_operations with the full list of operations needed (a single instruction can combine multiple operations) and a short, specific "summary" of what was actually changed, written as a completed-action statement (e.g. "Cropped to the top half, converted to grayscale, added the text \\"DONE\\".").

Call report_unsupported_instruction instead whenever any part of the instruction cannot be expressed with the vocabulary above. Do not partially apply just the supported part. This includes:
- Generative edits that invent or materially redraw content (e.g. "add a hat", "remove the person in the background", style transfer).
- Selective/segmentation-based effects that target a semantic subject rather than the whole image or an explicit rectangular region (e.g. "blur just the background", "brighten only his face").
Name specifically what wasn't supported in your "reason".

For vague but in-vocabulary instructions (e.g. "crop it", "make it brighter"), pick a single reasonable, concrete interpretation and apply it — you cannot ask a follow-up question.

When operations depend on each other (e.g. "crop to the left half then draw a box around the dog"), give coordinates for each later operation in the frame of the image as it will exist immediately after the earlier operations in your list have been applied, not the original frame.`;

// The Claude call is awaited synchronously, so the request stays open for
// the whole round trip plus local sharp processing. Run on the Node.js
// runtime (sharp's native bindings and the Anthropic SDK need it) and raise
// the function timeout.
//
// 300s is the maximum duration allowed on Vercel's Hobby plan (and the default
// on Pro/Enterprise, which allow more), so this value is valid on every plan.
// Note: Hobby only reaches 300s with fluid compute, which is enabled by default
// for new projects. On a legacy project with fluid compute disabled the ceiling
// is 60s and the build will reject this value — lower it to 60 if that happens.
export const runtime = 'nodejs';
export const maxDuration = 300;

// Product invariant 7 requires every "not supported" explanation to both name
// what wasn't supported *and* summarize the supported operation categories,
// so callers only need to supply the first half.
const SUPPORTED_CATEGORIES_SUMMARY =
  'Supported edits are: crop, resize, rotate, brightness/contrast, filters (grayscale/sepia/invert/blur/sharpen), text overlay, and simple shapes (rectangle/ellipse/line).';

/**
 * The Product invariant 7/9 "no edit applied, here's why" response: a
 * deliberate outcome, not an infra error, so it gets its own status
 * distinct from `mapClaudeError`'s 429/500/503/504 range.
 */
function unsupportedResponse(reason: string) {
  return NextResponse.json(
    { error: `${reason} ${SUPPORTED_CATEGORIES_SUMMARY}`, errorKind: 'unsupported_instruction' },
    { status: 422 }
  );
}

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get('image') as File;
    const instructions = formData.get('instructions') as string;

    if (!file) {
      return NextResponse.json({ error: 'No image file provided' }, { status: 400 });
    }

    if (!instructions) {
      return NextResponse.json({ error: 'No instructions provided' }, { status: 400 });
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json({ error: 'Claude API key not configured' }, { status: 500 });
    }

    // Get image bytes and convert to base64
    const imageBytes = await file.arrayBuffer();
    const imageSize = imageBytes.byteLength;
    const imageBuffer = Buffer.from(imageBytes);
    const base64Data = imageBuffer.toString('base64');
    const mediaType: SupportedMediaType = SUPPORTED_MEDIA_TYPES.has(file.type)
      ? (file.type as SupportedMediaType)
      : 'image/png';

    // Log to console for debugging
    console.log('User prompt:', instructions);
    console.log('Image size (bytes):', imageSize);
    console.log('Image name:', file.name);
    console.log('Image type:', file.type);

    // Ground Claude's own coordinate estimates in the image's real pixel
    // dimensions (Product invariant 5) before it reasons about crop/text/shape
    // placement.
    const { width, height } = await sharp(imageBuffer).metadata();

    console.log('Calling Claude...');
    const response = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      tool_choice: { type: 'any' },
      tools: [
        {
          name: 'apply_edit_operations',
          description: 'Apply a list of supported edit operations to the image.',
          input_schema: APPLY_EDIT_OPERATIONS_INPUT_SCHEMA,
        },
        {
          name: 'report_unsupported_instruction',
          description: "Report that some part of the instruction can't be expressed with the supported edit operations.",
          input_schema: REPORT_UNSUPPORTED_INSTRUCTION_INPUT_SCHEMA,
        },
      ],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Data } },
            {
              type: 'text',
              text: `Image dimensions: ${width ?? 'unknown'}x${height ?? 'unknown'} pixels.\n\nInstruction: ${instructions}`,
            },
          ],
        },
      ],
    });

    console.log('Claude response received');

    // Claude opts into a 'refusal' stop reason for its own content-policy
    // reasons, independent of the app's own unsupported-operation reporting.
    if (response.stop_reason === 'refusal') {
      throw new ClaudeRefusalError(response.stop_details?.explanation ?? null);
    }

    const toolUseBlock = response.content.find((block) => block.type === 'tool_use');
    if (!toolUseBlock || (toolUseBlock.name !== 'apply_edit_operations' && toolUseBlock.name !== 'report_unsupported_instruction')) {
      return unsupportedResponse("Claude didn't return a recognized response for this instruction. Try rephrasing it.");
    }

    if (toolUseBlock.name === 'report_unsupported_instruction') {
      const input = toolUseBlock.input as { reason?: unknown };
      const reason = typeof input.reason === 'string' && input.reason ? input.reason : null;
      return unsupportedResponse(reason ?? "This instruction isn't supported by the editor's fixed set of operations.");
    }

    const input = toolUseBlock.input as { operations?: unknown; summary?: unknown };
    const operations = parseEditOperations(input.operations);
    const summary = typeof input.summary === 'string' && input.summary ? input.summary : null;
    if (!operations || !summary) {
      return unsupportedResponse("Claude's response couldn't be turned into valid edit operations. Try rephrasing your instruction.");
    }

    try {
      const { buffer: editedBuffer, regionAdjusted } = await applyOperations(imageBuffer, operations);
      const responseText = regionAdjusted
        ? `${summary} (One or more regions were adjusted to fit within the image bounds.)`
        : summary;

      // Return the processed result
      return NextResponse.json({
        success: true,
        message: 'Image processed successfully',
        originalImageSize: imageSize,
        instructions: instructions,
        responseText,
        generatedImage: `data:image/png;base64,${editedBuffer.toString('base64')}`,
      });
    } catch (error) {
      // Unsalvageable parameters even after clamping (Product invariant 9) —
      // treat like an unsupported instruction, not a crash.
      if (error instanceof InvalidOperationError) {
        return unsupportedResponse(`This edit couldn't be applied: ${error.message}`);
      }
      throw error;
    }

  } catch (error) {
    // Always log the full, raw error server-side (visible in Vercel logs) so
    // it stays debuggable - only the response sent to the client is sanitised.
    console.error('Error processing with Claude:', error);

    const { status, message, kind, retryDelaySeconds } = mapClaudeError(error);
    return NextResponse.json(
      { error: message, errorKind: kind, retryDelaySeconds },
      { status }
    );
  }
}

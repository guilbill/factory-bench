# Use Claude instead of Gemini for image edits — Technical spec

Product spec: [`PRODUCT.md`](./PRODUCT.md). GitHub issue: [guilbill/factory-bench#12](https://github.com/guilbill/factory-bench/issues/12).

## Context

The app is a single Next.js API route plus a client page. All image-editing logic lives server-side in one handler that calls Google's `@google/genai` SDK and returns whatever image bytes Gemini generates; the client never touches pixels.

- [`src/app/api/process-image/route.ts` (1-119) @ 6ad04d9](https://github.com/guilbill/factory-bench/blob/6ad04d95b7cf83310a21a102a462d82d016b9bab/src/app/api/process-image/route.ts#L1-L119) — the entire edit pipeline: reads `image`/`instructions` from `FormData`, requires `GOOGLE_GENERATIVE_AI_API_KEY`, base64-encodes the upload, calls `genAI.models.generateContent({ model: 'gemini-2.5-flash-image', contents: [...] })`, pulls a generated image and/or text back out of `response.candidates[0].content.parts`, detects safety blocks via `promptFeedback.blockReason`/`finishReason`, and returns `{ success, originalImageSize, instructions, responseText, generatedImage }` as JSON with the image as a `data:image/png;base64,...` URL.
- [`src/lib/gemini-errors.ts` (1-223) @ 6ad04d9](https://github.com/guilbill/factory-bench/blob/6ad04d95b7cf83310a21a102a462d82d016b9bab/src/lib/gemini-errors.ts#L1-L223) — pure `mapGeminiError(error): MappedGeminiError` that turns `@google/genai`'s `ApiError` (numeric `status` + a JSON-stringified Google error body as `message`) and a locally-thrown `GeminiSafetyBlockError` into `{ status, message, kind, retryDelaySeconds }`, distinguishing daily-quota vs per-minute-quota vs generic-quota, invalid key, permission denied, unavailable, timeout, and unknown, and asserting the user-facing message never leaks raw SDK internals.
- [`src/lib/gemini-errors.test.ts` (1-189) @ 6ad04d9](https://github.com/guilbill/factory-bench/blob/6ad04d95b7cf83310a21a102a462d82d016b9bab/src/lib/gemini-errors.test.ts#L1-L189) — `node --test` coverage for every branch above, driven by verbatim captured Google error payloads (`node --import tsx --test`, see `package.json`'s `test` script).
- [`src/app/page.tsx` (164-318) @ 6ad04d9](https://github.com/guilbill/factory-bench/blob/6ad04d95b7cf83310a21a102a462d82d016b9bab/src/app/page.tsx#L164-L318) — client state machine: posts `FormData` to `/api/process-image`, and on `response.ok` sets `responseText`/`selectedImage`/history from `result.responseText`/`result.generatedImage`; on failure renders `result.error` verbatim via `statusMessage`. This client logic is generic over the response shape and needs **no structural changes** — only literal copy changes (button label, hero text) driven by Product invariant 17.
- [`README.md` (1-241) @ 6ad04d9](https://github.com/guilbill/factory-bench/blob/6ad04d95b7cf83310a21a102a462d82d016b9bab/README.md) and [`.env.example` @ 6ad04d9](https://github.com/guilbill/factory-bench/blob/6ad04d95b7cf83310a21a102a462d82d016b9bab/.env.example) — describe/configure `GOOGLE_GENERATIVE_AI_API_KEY` and the Gemini API integration throughout (Quick Start, Environment Setup, Architecture, API Integration, Vercel deployment steps).
- [`package.json` @ 6ad04d9](https://github.com/guilbill/factory-bench/blob/6ad04d95b7cf83310a21a102a462d82d016b9bab/package.json) — `@google/genai` is the only current AI SDK dependency; there is no image-processing library yet (`sharp` is not installed).

## Proposed changes

### Dependencies

- Remove `@google/genai` from `package.json`.
- Add `@anthropic-ai/sdk` (Claude client) and `sharp` (server-side image processing; not currently a dependency).
- Hand-roll validation of Claude's structured tool output against the operation types below instead of adding a schema library — the operation set is small (7 types) and doesn't justify a new dependency like `zod`.

### Operation schema

Define the operation vocabulary as a discriminated union in a new shared module, e.g. `src/lib/edit-operations.ts`, matching Product invariant 2 exactly:

```ts
type EditOperation =
  | { type: 'crop'; x: number; y: number; width: number; height: number }
  | { type: 'resize'; width: number; height: number }
  | { type: 'rotate'; degrees: number }
  | { type: 'brightness_contrast'; brightness?: number; contrast?: number }
  | { type: 'filter'; name: 'grayscale' | 'sepia' | 'invert' | 'blur' | 'sharpen'; amount?: number }
  | { type: 'text'; text: string; x: number; y: number; fontSize: number; color: string }
  | { type: 'shape'; shape: 'rectangle' | 'ellipse' | 'line'; x: number; y: number; width: number; height: number; color: string; fill: boolean };
```

All coordinates/dimensions are pixels in the frame of the image *as it exists immediately before that operation* (Product invariant 4), which requires the server — not Claude — to track current dimensions across the operation list (see executor below). Grounding Claude's own coordinate estimates in real numbers requires telling it the actual pixel dimensions of the image (via `sharp(...).metadata()`) in the prompt before it reasons about crop/text/shape placement (Product invariant 5).

### Claude integration (`route.ts`)

- Replace the `GOOGLE_GENERATIVE_AI_API_KEY` check with `ANTHROPIC_API_KEY` (Product invariant 11) and construct an `Anthropic` client from `@anthropic-ai/sdk` lazily inside the handler (or at module scope reading `process.env.ANTHROPIC_API_KEY` the same way the current `genAI` client is constructed).
- Read image bytes, get `{ width, height }` via `sharp(imageBytes).metadata()`.
- Call `client.messages.create` with:
  - `model`: a named constant, e.g. `claude-sonnet-5` — Claude's current flagship model with vision + tool use, good default for this workload's accuracy/latency/cost tradeoff. Keep it as a single constant so it's a one-line bump later.
  - An image content block (base64, `media_type` from the upload's MIME type — Claude vision accepts png/jpeg/gif/webp, a superset of what the client already accepts).
  - The user's instruction as text, plus the measured `width`/`height` so Claude's coordinates are grounded.
  - A `system` prompt that enumerates the exact supported vocabulary (mirroring Product invariant 2's list and descriptions) and explicitly lists out-of-scope examples (generative edits, selective/segmentation effects) so Claude's unsupported/supported boundary matches the product's non-goals.
  - Two tools, with `tool_choice: { type: 'any' }` (Claude must call one of them, never respond with plain text):
    - `apply_edit_operations` — input `{ operations: EditOperation[], summary: string }`. `summary` is the short, specific description of what changed (Product invariant 8).
    - `report_unsupported_instruction` — input `{ reason: string }`. Used whenever any part of the instruction falls outside the vocabulary (Product invariant 7); Claude should name what wasn't supported in `reason`.
- After the call, branch on `response.stop_reason`:
  - `'refusal'` → Claude declined for its own policy reasons — map via `claude-errors.ts` to Product invariant 13's message, independent of the two tools above.
  - Otherwise, inspect the tool_use block: `report_unsupported_instruction` → build the Product invariant 7 response; `apply_edit_operations` → validate `operations` against the schema (reject anything that doesn't parse — Product invariant 16) and run the executor below.

### Operation executor

New `applyOperations(buffer: Buffer, ops: EditOperation[]): Promise<Buffer>` (e.g. `src/lib/apply-operations.ts`), independent of Claude so it's unit-testable with fixture images:

- Load with `sharp(buffer)` (no `{ animated: true }`, so multi-frame GIFs are implicitly reduced to their first frame — Product invariant 10) and re-fetch `.metadata()` before each op that needs current bounds.
- For each op, in array order:
  - `crop` → clamp `x/y/width/height` to `[0, metadata.width/height]` (Product invariant 9), then `.extract({ left: x, top: y, width, height })`.
  - `resize` → `.resize(width, height)`.
  - `rotate` → `.rotate(degrees)`.
  - `brightness_contrast` → `brightness` via `.modulate({ brightness })`; sharp has no native "contrast" — implement with `.linear(contrastMultiplier, offset)` (a documented, simple linear-contrast formula) rather than a per-pixel LUT.
  - `filter` → `grayscale` → `.grayscale()`; `sepia` → `.tint({ r, g, b })` with a fixed sepia tint; `invert` → `.negate()`; `blur` → `.blur(sigma)`; `sharpen` → `.sharpen()`.
  - `text` / `shape` → sharp has no native drawing primitives, so build a small SVG string sized to the current image dimensions (`<svg width height><text>...</text></svg>` or `<rect>`/`<ellipse>`/`<line>`) and `.composite([{ input: Buffer.from(svg), top: 0, left: 0 }])`.
- After a geometry-changing op (`crop`/`resize`/`rotate`), re-read dimensions before validating/clamping the next op's parameters, so later ops (e.g. a `shape` after a `crop`) are validated against the *current* canvas, matching how Product invariant 4 expects Claude's own coordinates to be interpreted.
- Any parameter that's unsalvageable even after clamping (zero/negative width or height, NaN, etc.) throws a typed `InvalidOperationError`; the route catches this and maps it to the Product invariant 9/16 "treat as unsupported" response rather than a 500.
- Finish with `.png().toBuffer()` so the output is always a PNG regardless of input format (Product invariant 10), then base64-encode into the existing `generatedImage: data:image/png;base64,...` response field — no client-side change needed.

### Error mapping

Add `src/lib/claude-errors.ts`, structurally parallel to today's `gemini-errors.ts`: a pure `mapClaudeError(error: unknown): MappedClaudeError` covering the branches `@anthropic-ai/sdk` actually throws (`AuthenticationError` → invalid key, `PermissionDeniedError` → permission denied, `RateLimitError` → rate limited, `APIConnectionTimeoutError`/`AbortError` → timeout, `InternalServerError`/`APIConnectionError` → unavailable, anything else → unknown), plus a locally-synthesized case for `stop_reason === 'refusal'` (content-policy decline, Product invariant 13) and one for a tool response that fails schema validation (Product invariant 16). Keep the same contract as `MappedGeminiError` (`status`, `message`, `kind`, optional `retryDelaySeconds`) so `route.ts`'s catch block barely changes shape. Delete `src/lib/gemini-errors.ts` and `gemini-errors.test.ts` once nothing references them.

### Copy and docs

- `page.tsx`: update only literal strings — hero paragraph ("Google's Gemini ... rewrites it" → describes instruction-driven crop/resize/filter/text/shape editing), the processing button label ("Processing with Nano Banana..."), and the "Latest AI Response" panel content now shows the operation summary or the unsupported-instruction explanation (both already flow through existing `responseText`/`result.error` fields, so no new state is needed). Leave the app's own name/branding ("Nano Banana Editor") untouched pending the open question in Product invariant 17.
- `.env.example` and `README.md`: replace every `GOOGLE_GENERATIVE_AI_API_KEY` reference with `ANTHROPIC_API_KEY` (Quick Start, Environment Setup, Vercel env-var steps for Production/Preview/Development), rewrite "Tech Stack", "Architecture", and "API Integration" sections to describe the Claude + `sharp` pipeline instead of Gemini image generation, and add a migration note that existing deployments must add `ANTHROPIC_API_KEY` and may remove `GOOGLE_GENERATIVE_AI_API_KEY` — there is no automatic migration between the two providers.
- Re-evaluate `maxDuration` (currently 300s, set because Gemini's image generation was slow) once real timings exist for a Claude tool-call round trip plus local `sharp` processing, which should be substantially faster. This is a follow-up, not a spec requirement, since it needs empirical data from implementation.

## Testing and validation

- **`src/lib/claude-errors.test.ts`** (new, mirrors `gemini-errors.test.ts`'s structure): one case per branch — invalid key, permission denied, rate limited (with/without `retryDelaySeconds` when the SDK exposes it), timeout, unavailable, refusal, unknown, schema-validation failure — asserting the message never leaks raw SDK error bodies. Validates Product invariants 11-16.
- **`src/lib/apply-operations.test.ts`** (new): deterministic, Claude-independent tests against small fixture buffers (e.g. a generated 100×100 PNG) — crop produces the expected output dimensions, resize/rotate/grayscale/blur/sharpen/invert visibly change expected pixel properties, an out-of-bounds crop/shape is clamped rather than throwing (Product invariant 9), a zero-size op throws `InvalidOperationError`, and a `text`/`shape` op composites without error. A multi-op sequence (crop then shape) is asserted to use post-crop coordinates for the shape (Product invariant 4).
- **Route-level test or manual check with a mocked Claude client**: `report_unsupported_instruction` tool response results in the current image/history staying unchanged and the unsupported message rendering (Product invariant 7); `apply_edit_operations` with a schema-invalid `operations` array is rejected without a 500 (Product invariant 16).
- **Manual verification against a live `ANTHROPIC_API_KEY`** (no CI secret for this exists today, same as Gemini): run one instruction per vocabulary category, one combined multi-op instruction, one clearly generative instruction ("add a hat") and one selective-effect instruction ("blur just the background") and confirm each renders the expected outcome per Product invariants 2-8; confirm the missing-key path (invariant 11) and the existing revert-to-history flow (invariant 1) still work.
- `npm run build` and `npm run lint` to confirm removing `@google/genai` leaves no dangling imports/types, and that the new `sharp`/`@anthropic-ai/sdk` types compile cleanly.

## Parallelization

Not proposed. The change is a small number of tightly-coupled files that all share one new dependency: the `EditOperation` schema. The Claude integration, the operation executor, and the error mapper all need to agree on that schema as it's being designed, so splitting them across agents would mostly produce coordination overhead (re-syncing on schema edits) rather than saved wall-clock time. The copy/README/docs updates are a natural second, low-risk chunk, but they're small enough (a handful of string replacements) that handing them to a second agent isn't worth the handoff cost — doing them last, once the actual behavior is implemented and the copy can be written accurately, is faster in practice than parallelizing. Recommend one agent, sequential: schema → executor → Claude call/route wiring → error mapper → copy/docs → tests.

## Risks and mitigations

- **`sharp` may reject inputs the old pipeline tolerated** (unusual color profiles, corrupt files Gemini happened to accept): any `sharp` decode/processing error is caught and routed through the generic Product invariant 16 message rather than crashing the request.
- **Claude's supported/unsupported classification may be inconsistent** at the margins (e.g. "sharpen the dog's eyes" — partially in-vocabulary, partially selective). Mitigate with an example-rich system prompt (explicit supported and out-of-scope examples drawn from `PRODUCT.md`'s Behavior and Non-goals sections); treat prompt tuning as expected post-launch iteration, not a spec blocker.
- **Existing deployments break until reconfigured**: any environment still set to `GOOGLE_GENERATIVE_AI_API_KEY` only will fail closed with the Product invariant 11 "not configured" message once this ships, since there is no dual-provider fallback. Call this out explicitly in the README's Vercel deployment section as a required manual step at rollout.

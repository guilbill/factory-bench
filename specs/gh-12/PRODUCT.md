# Use Claude instead of Gemini for image edits

GitHub issue: [guilbill/factory-bench#12](https://github.com/guilbill/factory-bench/issues/12)

## Summary

This app currently edits images by sending the upload and a natural-language instruction to Google's Gemini 2.5 Flash Image ("Nano Banana") model, which generates a brand-new edited image. This replaces that mechanic: Anthropic Claude reads the uploaded image and the instruction and returns a structured list of edit operations drawn from a fixed vocabulary (crop, resize, rotate, brightness/contrast, grayscale and other filters, text overlay, simple shapes), and the server applies those operations deterministically to the real pixels with the `sharp` image library. The app needs only `ANTHROPIC_API_KEY`; all Gemini/Google Generative AI configuration and behavior is removed.

## Goals / Non-goals

Goals:
- Every image edit is produced by applying Claude-selected operations from the fixed vocabulary above to the actual uploaded/current image, not by generating a new image from scratch.
- The app runs entirely on `ANTHROPIC_API_KEY`; no Google/Gemini key or SDK is required at runtime.
- The existing upload → describe → process → iterate → revert workflow is preserved unchanged from the user's perspective.
- Instructions that fall outside the supported vocabulary are rejected with a clear, specific explanation instead of being silently ignored or crashing the request.

Non-goals:
- Generative edits that invent or materially redraw image content (e.g. "add a hat", "remove the person in the background", "change her jacket to leather", style transfer) are out of scope — these require image generation, not the operation families below.
- No new direct-manipulation UI (crop handles, color sliders, shape tools). The interaction stays a single free-text instruction box.
- Multi-turn clarification is out of scope — each submission is answered in one round-trip; Claude must commit to an interpretation or reject the instruction, not ask a follow-up question.
- Selective/segmentation-based effects (e.g. "blur just the background", "brighten only his face") are out of scope; filters and adjustments apply to the whole image or to an explicit rectangular region, not to a semantically identified subject.

## Behavior

1. Upload, image history, and revert-to-history behavior are unchanged: the user uploads an image (PNG/JPG/GIF, ≤4MB), types an instruction, and clicks "Process with AI"; on success the result replaces the current image, the pre-edit image is pushed onto the history strip, and the instruction box clears for the next edit. Reverting to a history thumbnail truncates history and restores that image as the current base, exactly as today.

2. The supported edit vocabulary is exactly these operation families:
   - **Crop** — extract a rectangular region of the image (e.g. "crop to just the dog", "crop out the top third").
   - **Resize** — scale the image to a target size or proportion (e.g. "make this half size", "resize to 800px wide").
   - **Rotate** — rotate the image by a specified or implied angle (e.g. "rotate 90 degrees clockwise", "straighten the horizon").
   - **Brightness / contrast** — adjust overall brightness or contrast up or down (e.g. "brighten this up", "increase the contrast").
   - **Grayscale and filters** — grayscale, sepia, color invert, blur, and sharpen, applied to the whole image (e.g. "make it black and white", "sepia tone", "blur it slightly"). **Open question:** confirm this exact filter list covers the intended scope of "other filters" from the issue, or whether more/fewer filters are wanted.
   - **Text overlay** — render a caption or label onto the image at a specified or reasonable position (e.g. "add text at the bottom saying SALE").
   - **Simple shapes** — draw a rectangle, circle/ellipse, or straight line onto the image, filled or outlined, in a specified color (e.g. "draw a red box in the corner"). **Open question:** confirm whether arrows/polygons/freehand should be in scope, or whether these three primitives are sufficient.

3. An instruction can request any combination of operations from the vocabulary in one submission (e.g. "crop to the top half, convert to grayscale, and add a caption that says DONE"); the app applies all of them in one edit and the result reflects every requested change.

4. When an instruction's operations have a natural dependency (a later operation's target region or position depends on the image as it exists after an earlier operation in the same request), the app applies them in a coherent order so the final image matches what a person reading the instruction would expect — e.g. "crop to the left half then draw a box around the dog" draws the box using the cropped image's coordinates, not the original's.

5. Positions and target regions described in relative or descriptive terms ("around the dog", "in the bottom-right corner", "the top third") are resolved by Claude's best interpretation of the image; placement is a reasonable best effort, not guaranteed pixel-exact, since the app has no manual correction step.

6. Vague but in-vocabulary instructions ("crop it", "make it brighter") are not rejected as unsupported; Claude picks a single reasonable, concrete interpretation and applies it, since the app has no follow-up clarification step.

7. When any part of an instruction cannot be expressed with the supported vocabulary — a generative request, a selective/segmentation-based effect, or anything else outside the six operation families — the app applies no edit at all for that submission (it does not partially apply just the supported part), the current image and history are unchanged, and the response area shows a clear, specific explanation naming what wasn't supported and summarizing the supported operation categories, so the user can rephrase.

8. When every part of a multi-part instruction is supported, the response area instead shows a short, specific summary of what was actually changed (e.g. `Cropped to the top half, converted to grayscale, added the text "DONE".`), replacing today's raw Gemini response text.

9. An operation whose parameters fall slightly outside the image bounds (e.g. a crop or shape region that overhangs an edge by a small amount) is clamped to the image bounds and applied; the response summary notes that the region was adjusted to fit. An operation whose parameters are not sensible even after clamping (e.g. a zero-width crop, a resize to 0×0) is treated like an unsupported instruction per invariant 7 — it is not silently dropped and does not crash the request.

10. Regardless of the uploaded format (PNG/JPG/GIF), the edited result is returned and displayed as a PNG, consistent with today's behavior. This app does not do frame-by-frame editing of animated GIFs; an animated GIF is treated as its static first frame, same as it is today under Gemini.

11. If `ANTHROPIC_API_KEY` is not configured on the server, submitting shows a clear message that the image editor isn't configured with a valid API key and to contact the site owner — the request fails immediately without attempting an edit, mirroring today's missing-Google-key behavior.

12. If Claude's API key is invalid or lacks permission, the response is a clear, generic "contact the site owner" message — never the raw API error, key material, or account details.

13. If Claude declines to process the request for its own content-policy reasons (independent of the app's own "unsupported operation" explanation in invariant 7), the response area shows a clear message that the request was declined for policy reasons and suggests trying a different image or instruction — playing the same role as today's Gemini safety-block message, worded for Claude instead of Gemini.

14. If Claude's API is rate-limited or temporarily overloaded, the response area shows a clear "try again shortly" message, distinguishing — when that distinction is available from the API response — between the app having hit a broader usage limit versus the individual user sending requests too fast, same as today.

15. If the request to Claude times out, the response area shows a clear timeout message suggesting a smaller image or simpler instruction, mirroring today's Gemini timeout behavior.

16. Any other unexpected failure (network error, a Claude response that can't be turned into valid operations, an internal error applying an operation) results in a generic "something went wrong, please try again" message — never a stack trace, raw error body, or internal implementation detail shown to the user — and the current image/history are left unchanged.

17. Landing-page copy, the processing-state button label, and any other in-app text that currently names "Gemini", "Google", or describes the app as generating a brand-new image no longer claim that mechanic; they describe editing via a fixed set of operations (crop, resize, rotate, filters, text, shapes) interpreted from the instruction. **Open question:** should the app's own name/branding ("Nano Banana Editor") change too, or is it kept as the app's proper name independent of the underlying model?

18. The 4MB upload size guard and the client-side warning when an iterated result would exceed it are unchanged — they are a Vercel platform constraint independent of which model provider processes the request.

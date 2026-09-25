# 🎨 Claude Pixel Editor

**An AI-Powered Iterative Image Editor using Anthropic's Claude API**

![Next.js](https://img.shields.io/badge/Next.js-15.5.2-000000?style=flat-square&logo=next.js)
![TypeScript](https://img.shields.io/badge/TypeScript-5.0-3178C6?style=flat-square&logo=typescript)
![Tailwind CSS](https://img.shields.io/badge/Tailwind-3.0-38B2AC?style=flat-square&logo=tailwind-css)
![Anthropic](https://img.shields.io/badge/Anthropic-Claude-D97757?style=flat-square)

## ✨ Features

- **🖼️ Smart Image Upload**: Drag & drop or click to upload thumbnails
- **🤖 AI-Powered Editing**: Claude reads the image and your instruction and picks from a fixed set of crop/resize/rotate/filter/text/shape operations, applied deterministically with `sharp`
- **🔄 Iterative Workflow**: Each generated image becomes the new base for further editing
- **📚 Visual History**: Bottom timeline showing all previous versions with click-to-revert
- **⚡ Real-time Processing**: Async API calls with loading states and progress feedback
- **🎨 Modern UI**: Clean, responsive interface built with Tailwind CSS
- **🔒 Secure**: Only `ANTHROPIC_API_KEY` is required; never exposed to the client

## 🚀 How It Works

1. **Upload** a thumbnail image
2. **Describe** your desired changes in natural language
3. **Process** with AI - Claude picks the edit operations and the server applies them to the real pixels with `sharp`
4. **Iterate** - the result becomes your new base image for further edits
5. **Navigate** through your editing history and revert to any previous version

### Example Editing Session:
- Original: Photo of a landscape
- Edit 1: "crop to the top half" → crops the image
- Edit 2: "convert to grayscale" → applies a grayscale filter
- Edit 3: "add a caption at the bottom that says VACATION 2024" → overlays the text
- **Click any thumbnail** to revert to that version and continue editing from there

Instructions have to stay within the supported operation vocabulary (crop, resize, rotate, brightness/contrast, filters, text, shapes) — generative requests like "add a hat" or selective edits like "blur just the background" are explained as unsupported instead of silently ignored. See [`specs/gh-12/PRODUCT.md`](specs/gh-12/PRODUCT.md) for the full behavior spec.

## 🛠️ Tech Stack

- **Framework**: Next.js 15.5.2 with App Router
- **Language**: TypeScript
- **Styling**: Tailwind CSS
- **AI API**: Anthropic Claude ([@anthropic-ai/sdk](https://www.npmjs.com/package/@anthropic-ai/sdk)) for reading the image/instruction and selecting edit operations
- **Image Processing**: [`sharp`](https://www.npmjs.com/package/sharp) applies the selected operations to the real pixels server-side
- **Deployment**: Vercel-ready

## 🏃‍♂️ Quick Start

### Prerequisites
- Node.js 24.x (pinned via `engines.node` in `package.json`; this is also the Node major Vercel builds with)
- An Anthropic account with API access
- Claude API key

### Installation

```bash
# Clone the repository
git clone https://github.com/warpdotdev-demos/nano-banana-editor.git
cd nano-banana-editor

# Install dependencies
npm install

# Set up environment variables
cp .env.example .env.local
# Add your Anthropic API key to .env.local
```

### Environment Setup

Create a `.env.local` file:

```env
# Get your API key from: https://console.anthropic.com/settings/keys
ANTHROPIC_API_KEY=your_api_key_here
```

### Development

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to start editing images!

## 🏗️ Architecture

### Frontend (`/src/app/page.tsx`)
- React hooks for state management (image history, current image, loading states)
- File upload handling with drag & drop support
- Real-time form validation and submission
- Responsive image display with history timeline

### Backend (`/src/app/api/process-image/route.ts`)
- Next.js API route handling image processing requests
- Calls the Claude API with the image and instruction, forcing a tool call into either `apply_edit_operations` or `report_unsupported_instruction` (`src/lib/edit-operations.ts`)
- Applies validated operations to the image with `sharp` (`src/lib/apply-operations.ts`)
- Base64 image encoding/decoding for API communication
- Error handling and response formatting (`src/lib/claude-errors.ts`)

### Key Features Implementation

**Iterative Editing Workflow**:
```typescript
// After successful API response:
setSelectedImage(result.generatedImage);  // Replace current image
setImageHistory(prev => [...prev, previousImage]);  // Save to history
setInstructions("");  // Clear for next edit
```

**History Management**:
```typescript
// Click to revert truncates history (like git reset)
const revertToHistoryImage = (historyItem, index) => {
  setImageHistory(prev => prev.slice(0, index));  // Truncate
  setSelectedImage(historyItem.image);  // Revert
};
```

## 🎯 API Integration

The app integrates with Anthropic's Claude API, forcing a tool call so Claude's output is always one of two validated shapes instead of free text:

```typescript
const response = await anthropic.messages.create({
  model: 'claude-sonnet-5',
  tool_choice: { type: 'any' },
  tools: [
    { name: 'apply_edit_operations', input_schema: APPLY_EDIT_OPERATIONS_INPUT_SCHEMA },
    { name: 'report_unsupported_instruction', input_schema: REPORT_UNSUPPORTED_INSTRUCTION_INPUT_SCHEMA },
  ],
  messages: [{
    role: 'user',
    content: [
      { type: 'image', source: { type: 'base64', media_type: file.type, data: base64Data } },
      { type: 'text', text: `Image dimensions: ${width}x${height} pixels.\n\nInstruction: ${instructions}` },
    ],
  }],
});
```

`apply_edit_operations` returns a validated list of `EditOperation`s (crop, resize, rotate, brightness/contrast, filter, text, shape — see `src/lib/edit-operations.ts`) that `applyOperations` in `src/lib/apply-operations.ts` applies to the real pixels with `sharp`. `report_unsupported_instruction` is used whenever the instruction falls outside that vocabulary.

## 🐛 Debugging Features

This project includes debugging capabilities using the Puppeteer MCP server:
- Live page inspection for UI bugs
- Real-time CSS debugging
- Image rendering diagnostics
- Console log monitoring

## 🌟 Recent Fixes

- **History Thumbnails**: Fixed black square rendering by correcting CSS overlay transparency
- **Stack Behavior**: Fixed history to properly truncate instead of append when reverting
- **Image Handling**: Improved data URL processing with regular `<img>` tags

## 🚀 Deployment

### Vercel (Recommended)

The deploy itself has to be done by you, with your own Vercel account — the repository only ships the configuration needed for that deploy to succeed.

#### 1. Verify the build locally

```bash
npm ci
npm run build
```

Production builds run `next build --turbopack` (see the `build` script). Vercel runs this same command, so a local failure is a deploy failure.

#### 2. Import the project into Vercel

Either import the Git repository from the [Vercel dashboard](https://vercel.com/new) (**Add New… → Project → Import Git Repository**), or link an existing checkout from the CLI:

```bash
npm i -g vercel
vercel link
```

Vercel detects Next.js automatically: no build command, output directory, or install command overrides are needed, and no `vercel.json` is required.

#### 3. Set the environment variable

`ANTHROPIC_API_KEY` must be set for **each** environment you deploy to — Production, Preview, and Development. Without it, `/api/process-image` returns `500 Claude API key not configured`.

In the dashboard: **Project Settings → Environment Variables**. Or from the CLI:

```bash
vercel env add ANTHROPIC_API_KEY production
vercel env add ANTHROPIC_API_KEY preview
vercel env add ANTHROPIC_API_KEY development
```

Migrating an existing deployment: add `ANTHROPIC_API_KEY` to each environment above; `GOOGLE_GENERATIVE_AI_API_KEY` is no longer read and can be removed. There is no automatic migration between the two providers.

See `.env.example` for the local equivalent (`.env.local`). Changing an environment variable requires a redeploy to take effect.

#### 4. Deploy

```bash
vercel --prod
```

Or just push to the default branch once the Git integration is connected.

#### Node.js version

`package.json` pins `engines.node` to `24.x`, which Vercel honors and which overrides the Node.js version selected in **Project Settings → Build and Deployment**. Vercel currently supports the `20.x`, `22.x`, and `24.x` majors; change the pin if you need a different one.

#### Platform limits to be aware of

- **Function timeout.** `src/app/api/process-image/route.ts` exports `maxDuration = 300` (seconds) and `runtime = 'nodejs'`. The Claude tool-call round trip plus local `sharp` processing are awaited synchronously, so the request stays open for the whole operation; this should be substantially faster than the old Gemini image-generation path, but the ceiling is left at 300s pending real production timings. 300s is the maximum allowed on the Hobby plan, and is also valid on Pro and Enterprise (which permit more). Hobby only reaches 300s with fluid compute, which is enabled by default for new projects; on a legacy project with fluid compute disabled the ceiling is 60s and the build rejects a higher value — lower `maxDuration` to `60` if that happens.
- **Request body size.** Vercel rejects function request bodies larger than **4.5 MB** with a `413 FUNCTION_PAYLOAD_TOO_LARGE` before the route handler runs, so the API cannot return a helpful error. The client therefore refuses uploads over **4 MB** (`MAX_IMAGE_BYTES` in `src/app/page.tsx`), leaving headroom for multipart overhead. The same check runs on each iteration, because every edited PNG becomes the next request's input and can be larger than the image it replaced.
- **Response body size.** The 4.5 MB cap applies to the response body too, and the client-side guard **cannot** prevent that side. `/api/process-image` returns the edited image as base64 inside JSON, which is roughly 1.33x the binary size, so the response exceeds the cap once the re-encoded PNG is larger than about 3.3 MB — reachable even when the input was within the 4 MB limit, since re-encoding as PNG (Product invariant 10) can grow the file compared to a more compressed source format like JPEG. When it happens the platform kills the response before any client-side check can run, and the browser reports the generic "Error: Failed to submit form" (the 413 body is not JSON, so parsing the response throws). If you hit this, the fix is a different transport — returning a URL to blob storage instead of inline base64 — not a smaller upload limit.

### Other Platforms

The app is a standard Next.js application and can be deployed to any platform that supports Node.js. The `maxDuration` export and the 4 MB client-side upload guard are Vercel-specific; other hosts may allow larger bodies or longer requests.

## 🤖 Cloud Factory Automation

This repository consumes Cloud Factory skills from the canonical [`warpdotdev-demos/cloud-factory-demo`](https://github.com/warpdotdev-demos/cloud-factory-demo) repository.

To install or refresh the Triage and Implementation skills and workflow templates locally, run:

```bash
./scripts/bootstrap-cloud-factory.sh
```

The bootstrap script uses `npx skills install` to install the canonical skills into this repo and copies the workflow templates from `cloud-factory-demo`. Configure the `WARP_API_KEY` GitHub Actions secret before enabling the workflows.

## 🤝 Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📝 License

MIT License - see [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- Anthropic for the Claude API
- Next.js team for the excellent framework
- Tailwind CSS for the utility-first styling approach

---

**Built with ❤️ by the Warp team**

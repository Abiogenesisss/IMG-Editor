# IMG Editor

IMG Editor is a desktop tool for collecting, inspecting, processing, annotating,
and generating image datasets. It combines an Electron + Vue interface with a
local Python backend for heavier image-processing and model-backed tasks.

## Features

- Collect images from pages, URLs, and local folders.
- Batch process images with resize, crop, format conversion, alpha flattening,
  resolution filtering, and mirroring.
- Build dataset variants with cutout, perspective, blur, and noise transforms.
- Detect duplicates and group images by visual, semantic, or fused features.
- Run local or model-backed upscaling workflows.
- Tag images, filter by aesthetic score, and generate captions.
- Generate images through configured image provider APIs.
- Chain common steps in the workflow canvas.

## Architecture

- `src/main/` contains the Electron main process, window lifecycle, IPC bridge,
  secure API config storage, update handling, and Python backend startup.
- `src/renderer/` contains the Vue application, route views, workflow UI, and
  reusable renderer components.
- `python_backend/server.py` exposes a local HTTP/SSE API that Electron starts
  on demand.
- `python_backend/tasks/` contains first-party image processing, tagging,
  captioning, clustering, augmentation, grab, and upscale task modules.
- `python_backend/nunif/` and `python_backend/waifu2x/` are bundled runtime/model
  helpers used by the local upscaling stack.

## Requirements

- Node.js and npm.
- Python 3.11+ with the packages from `python_backend/requirements.txt`.
- Optional CUDA-capable GPU for accelerated Torch/ONNX workloads.

For Windows packaging, `npm run setup:python` prepares an embedded Python
runtime under `python_backend/python_embed/`.

## Development

Install JavaScript dependencies:

```bash
npm install
```

Install Python dependencies into the Python runtime that will be used by the
desktop app:

```bash
pip install -r python_backend/requirements.txt
```

Start the Electron/Vue development app:

```bash
npm run dev
```

## Build

```bash
# Windows
npm run build:win

# macOS
npm run build:mac

# Linux
npm run build:linux
```

## Useful Scripts

- `npm run dev` starts the Electron/Vite development app.
- `npm run build` builds the Electron app without packaging.
- `npm run setup:python` prepares the embedded Windows Python runtime.
- `npm run lint` runs ESLint.
- `npm run format` formats the project with Prettier.

## Repository Notes

The repository includes both JavaScript/Vue UI code and Python image-processing
code. Some Python directories are bundled third-party runtime helpers and are
marked as vendored in `.gitattributes` so repository language statistics focus on
the first-party application code.

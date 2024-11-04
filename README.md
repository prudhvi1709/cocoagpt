# Cocoa GPT

## Features

## Usage

## Setup

### Prerequisites

- Modern web browser with ES Modules support
- Web server for local development

### Local Setup

1. Clone this repository:

```bash
git clone https://github.com/gramener/cocoagpt.git
cd cocoagpt
```

2. Serve the files using any static web server. For example, using Python:

```bash
python -m http.server
```

3. Open `http://localhost:8000` in your web browser

## Deployment

On [Cloudflare DNS](https://dash.cloudflare.com/2c483e1dd66869c9554c6949a2d17d96/straive.app/dns/records),
proxy CNAME `cocoagpt.straive.app` to `gramener.github.io`.

On this repository's [page settings](https://github.com/gramener/cocoagpt/settings/pages), set

- Source: `Deploy from a branch`
- Branch: `main`
- Folder: `/`

## Technical Details

### Architecture

- Frontend: Vanilla JavaScript with lit-html for rendering
- LLM Integration: Multiple model providers through LLM Foundry API
- Styling: Bootstrap 5.3.3 with dark mode support

### Dependencies

All dependencies are loaded via CDN:

- [lit-html](https://www.npmjs.com/package/lit-html) v3 - Template rendering
- [Bootstrap](https://www.npmjs.com/package/bootstrap) v5.3.3 - UI components
- [marked](https://www.npmjs.com/package/marked) v13 - Markdown parsing
- [asyncllm](https://www.npmjs.com/package/asyncllm) v1 - LLM API integration

## License

[MIT](LICENSE)

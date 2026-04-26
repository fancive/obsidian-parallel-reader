<p align="center">
  <img src="https://img.shields.io/github/v/release/fancive/obsidian-parallel-reader?style=flat-square&color=blue" alt="Release">
  <img src="https://img.shields.io/github/actions/workflow/status/fancive/obsidian-parallel-reader/ci.yml?style=flat-square&label=CI" alt="CI">
  <img src="https://img.shields.io/github/license/fancive/obsidian-parallel-reader?style=flat-square" alt="License">
  <img src="https://img.shields.io/github/stars/fancive/obsidian-parallel-reader?style=flat-square" alt="Stars">
</p>

# Obsidian Parallel Reader

> **[中文文档](./README.zh-CN.md)**

Split-view reading for Obsidian — your original note on the left, AI-generated summary cards on the right, with scroll-sync highlighting.

Inspired by [this reading workflow demo](https://www.bilibili.com/video/BV1FxoGBVETm/).

## Features

- **Adaptive segmentation** — the LLM decides natural topic boundaries. Short sections merge, long ones split. No dependency on markdown headings.
- **Scroll-sync** — scrolling the editor auto-highlights the matching card on the right.
- **Streaming** — real-time SSE streaming for OpenAI Chat and Anthropic APIs, so you see progress as it generates.
- **20+ providers** — Anthropic, OpenAI, Gemini, OpenRouter, Groq, DeepSeek, Moonshot, Ollama, LM Studio, and more. Plus Claude Code CLI and Codex CLI backends.
- **Persistent cache** — summaries are cached by content SHA-1 + settings fingerprint. Reopen a note and cards appear instantly. Edits or config changes show a stale banner.
- **Rich rendering** — cards render through Obsidian's `MarkdownRenderer`, so tables, bold, code, and wikilinks all work natively.
- **Card editing** — right-click any card to copy, edit, delete, or jump to source.
- **Export** — save cards as a Markdown note in your vault, or copy to clipboard.
- **Bilingual UI** — full Chinese and English support for commands, settings, and notices.

## Quick Start

### Install

**Manual** — Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/fancive/obsidian-parallel-reader/releases), place them in `.obsidian/plugins/parallel-reader/`, and enable the plugin in Obsidian settings.

### Configure a Provider

Open plugin settings, pick a provider preset, enter your API key and model ID. Done.

| Provider | Format | Notes |
|----------|--------|-------|
| Anthropic | `anthropic-messages` | Default, recommended |
| OpenAI | `openai-chat` | Chat Completions |
| Google Gemini | `google-generative-ai` | generateContent |
| OpenRouter / Groq / DeepSeek / Moonshot / ... | `openai-chat` | OpenAI-compatible |
| Ollama / LM Studio | `openai-chat` | Local, no API key needed |
| Custom endpoint | Any | Just fill in Base URL |

Model IDs support `provider/model` notation (e.g. `anthropic/claude-sonnet-4-6`) — the matching prefix is stripped automatically.

### CLI Backends (Optional)

Switch backend to **Claude Code CLI** or **Codex CLI** to use your local CLI installation.

Since Obsidian's GUI doesn't inherit your shell `PATH`, enter the absolute CLI path in settings:

```bash
which claude    # Claude Code
which codex     # Codex
```

## Usage

| Action | Effect |
|--------|--------|
| Click a card | Jump editor to that section |
| Right-click a card | Context menu: copy, edit, delete, jump to source |
| Scroll the editor | Right-side card auto-highlights |
| `Alt+↑` / `Alt+↓` | Navigate between cards |
| `Enter` in summary pane | Jump to active card's source line |
| Ribbon icon | Open the parallel reader pane |
| File context menu | Generate / regenerate / clear cache |

## How It Works

The LLM returns structured JSON:

```json
{
  "cards": [
    {
      "title": "Short heading",
      "anchor": "Verbatim quote from source for positioning",
      "gist": "One-sentence lead-in",
      "bullets": ["Supporting detail 1", "Supporting detail 2"]
    }
  ]
}
```

**Anchor** is the key mechanism — a verbatim quote that the plugin locates via `indexOf` with multi-level fallbacks, keeping scroll-sync working without relying on headings.

**Gist + bullets** gives both overview and scannable detail — pure prose felt like a wall of text, pure bullets felt fragmented.

## Development

```bash
npm install
npm run dev       # watch mode
npm run build     # production build
npm run typecheck # TypeScript strict mode
npm run lint      # Biome
npm test          # build + typecheck + tests
```

## Star History

<a href="https://www.star-history.com/#fancive/obsidian-parallel-reader&Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=fancive/obsidian-parallel-reader&type=Date&theme=dark" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=fancive/obsidian-parallel-reader&type=Date" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=fancive/obsidian-parallel-reader&type=Date" />
 </picture>
</a>

## License

[MIT](./LICENSE)

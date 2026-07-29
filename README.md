<h1 align="center">Obsidian Parallel Reader</h1>

<p align="center">
  <em>Split-view reading for Obsidian — your original note on the left, AI-generated summary cards on the right, with scroll-sync highlighting.</em>
</p>

<p align="center">
  <a href="https://github.com/fancive/obsidian-parallel-reader/releases/latest"><img src="https://img.shields.io/github/v/release/fancive/obsidian-parallel-reader?style=flat-square&color=4c1" alt="Latest release"></a>
  <a href="https://github.com/fancive/obsidian-parallel-reader/releases"><img src="https://img.shields.io/github/downloads/fancive/obsidian-parallel-reader/total?style=flat-square&color=4c1" alt="Total downloads"></a>
  <a href="https://github.com/fancive/obsidian-parallel-reader/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/fancive/obsidian-parallel-reader/ci.yml?style=flat-square&label=CI" alt="CI status"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/github/license/fancive/obsidian-parallel-reader?style=flat-square" alt="License"></a>
  <img src="https://img.shields.io/badge/Obsidian-%E2%89%A5%201.8.7-7c3aed?style=flat-square&logo=obsidian&logoColor=white" alt="Obsidian 1.8.7+">
</p>

<p align="center">
  <a href="https://github.com/fancive/obsidian-parallel-reader/stargazers"><img src="https://img.shields.io/github/stars/fancive/obsidian-parallel-reader?style=flat-square" alt="Stars"></a>
  <a href="https://github.com/fancive/obsidian-parallel-reader/issues"><img src="https://img.shields.io/github/issues/fancive/obsidian-parallel-reader?style=flat-square" alt="Open issues"></a>
  <img src="https://img.shields.io/github/last-commit/fancive/obsidian-parallel-reader?style=flat-square" alt="Last commit">
  <img src="https://img.shields.io/badge/TypeScript-strict-3178c6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript strict">
  <img src="https://img.shields.io/badge/code_style-biome-60a5fa?style=flat-square&logo=biome&logoColor=white" alt="Code style: Biome">
  <a href="./README.zh-CN.md"><img src="https://img.shields.io/badge/lang-中文-red?style=flat-square" alt="中文文档"></a>
</p>

<p align="center">
  <b>English</b> · <a href="./README.zh-CN.md">中文</a>
</p>

---

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
- **Multi-language UI and output** — UI supports Auto, Chinese, English, Japanese, Korean, French, German, and Spanish; generated titles, gists, and bullets can use the same fixed languages or follow the source document.

## Quick Start

### Step 1: Install the Plugin

Parallel Reader is in Obsidian's official community plugin registry:

1. Open Obsidian → **Settings** → **Community plugins** → **Browse**
2. Search for **"Parallel Reader"**, then click **Install** and **Enable**

<details>
<summary><b>Manual install (BRAT / beta / pre-release testing)</b></summary>

Use this only if you need a pre-release build, or want to sideload without the community registry. Sideloaded installs don't auto-update, so switch to the registry install above once your build is out.

1. Go to the [Releases page](https://github.com/fancive/obsidian-parallel-reader/releases) and download three files from the release you want: **main.js**, **manifest.json**, **styles.css**
2. Open your vault folder, navigate to `.obsidian/plugins/` (create it if it doesn't exist), and create a new folder called `parallel-reader`
3. Put the three downloaded files into that folder
4. Open Obsidian → **Settings** → **Community plugins** → find **Parallel Reader** → toggle it **on**

> **Tip**: Can't see the `.obsidian` folder? On macOS press `Cmd+Shift+.` in Finder; on Windows enable "Show hidden files" in File Explorer.

</details>

### Step 2: Set Up Your AI Provider

1. In Obsidian, go to **Settings** → **Parallel Reader**
2. Choose a **Provider preset** (e.g. Anthropic, OpenAI, DeepSeek, etc.)
3. Paste your **API Key**
4. (Optional) Change the **Model** if you prefer a different one
5. Click **Test** to verify the connection

That's it! Open any note and run the command **"Parallel Reader: Generate"** from the command palette (`Cmd/Ctrl+P`).

<details>
<summary><b>Supported providers</b></summary>

| Provider | Notes |
|----------|-------|
| **Anthropic** | Default, recommended |
| **OpenAI** | GPT models |
| **Google Gemini** | Gemini models |
| **OpenRouter / Groq / DeepSeek / Moonshot / ...** | OpenAI-compatible |
| **Ollama / LM Studio** | Local models, no API key needed |
| **Custom endpoint** | Any OpenAI or Anthropic compatible API |

</details>

<details>
<summary><b>CLI backends (advanced)</b></summary>

If you have **Claude Code** or **Codex** installed locally, you can use them as backends instead of API keys. Just switch the backend in settings — the plugin automatically detects common install locations. If auto-detection fails, you can manually enter the path in settings.

</details>

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
npm run test:unit
npm run test:component
npm run test:contract
npm run test:e2e  # packaged plugin + disposable Vault smoke
```

For CI / release evidence, run the contract gate:

```bash
bash .e2e/gate.sh --json    # writes .e2e/artifact.json (gitignored)
```

Add `TEST_LIVE=1` to opt into real local Vault / provider checks.

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

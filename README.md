# Obsidian Parallel Reader

An Obsidian plugin that splits any long note into a left/right parallel-reading layout: the original content stays on the left; LLM-generated section summaries appear on the right. Scrolling the source highlights the matching summary card; clicking a summary jumps the source editor.

Inspired by the reading workflow demo in [this Bilibili video](https://www.bilibili.com/video/BV1FxoGBVETm/).

## Features

- **Self-adaptive segmentation** — the LLM decides natural topic boundaries, no need to match markdown headings. Short adjacent sections merge; long ones split.
- **Anchor-based line resolution** — summaries carry a verbatim quote from the source; the plugin finds the line number by `indexOf` (with graceful fallbacks).
- **Scroll-sync highlighting** — scrolling the source editor updates the active card in the summary pane.
- **Right-click → copy** — Markdown / plain text / anchor quote / jump to source, as a native Obsidian context menu.
- **Markdown rendering** — summaries render through Obsidian's official `MarkdownRenderer`, so tables, bold, code, wikilinks all work.
- **Persistent bounded cache** — generated summaries are cached by SHA-1 of source content plus generation settings in a separate `cache.json`. Reopening a note shows the cached view instantly; edits or model changes invalidate the cache (shows a stale banner). The cache has an LRU-style entry limit.
- **Panel actions** — regenerate, copy all Markdown, or export the current comparison note directly from the right pane.
- **Vault lifecycle aware** — cached summaries follow Markdown file renames and are removed when the source note is deleted.
- **Configurable input limit** — default 20,000 characters, adjustable for long-context models and included in the cache fingerprint.
- **Prompt controls** — choose summary language, card count range, and an optional custom system prompt. Prompt settings are included in the cache fingerprint.
- **Multiple model access paths** — Claude Code CLI, Codex CLI, direct provider APIs, and OpenAI/Anthropic-compatible proxies. The API backend follows the same lightweight `provider/model + base URL + protocol` idea as OpenClaw.

## Installation

### Manual install (until this lands in Community Plugins)

1. Clone this repo into `.obsidian/plugins/parallel-reader/` in your vault, or symlink it there:
   ```bash
   ln -s /path/to/obsidian-parallel-reader /path/to/YourVault/.obsidian/plugins/parallel-reader
   ```
2. In Obsidian: **Settings → Community plugins → Installed plugins** → enable **Parallel Reader**.

### Pick a backend

| Backend | Auth | Cost | Notes |
|---------|------|------|-------|
| **Claude Code CLI** | OAuth in macOS Keychain | Included in Claude subscription | ⚠️ Keychain ACL may block Obsidian subprocess reads — may not work from GUI |
| **Codex CLI** | File-based token (`~/.codex/auth.json`) | Included in ChatGPT Plus | ✅ Works from Obsidian GUI; recommended |
| **API / Provider** | API key or local server | Provider billing / local | Supports Anthropic, OpenAI, Gemini, OpenRouter, Groq, DeepSeek, Moonshot, Qianfan, MiniMax, xAI, Mistral, Cerebras, Z.AI, Ollama, LM Studio, and custom compatible endpoints |

### API provider mode

In plugin settings, choose **Backend → API / Provider**, then select a provider preset. Presets fill the protocol, base URL, auth header, and environment variable name; you still control the model ID.

Supported protocol formats:

| Format | Use it for |
|--------|------------|
| `anthropic-messages` | Anthropic API and Anthropic-compatible proxies |
| `openai-chat` | OpenAI-compatible `/chat/completions` providers and local proxies |
| `openai-responses` | OpenAI `/responses` endpoint |
| `google-generative-ai` | Gemini `generateContent` API |

Model IDs accept OpenClaw-style `provider/model` values. If the prefix matches the selected preset, the plugin strips it before the request. For example:

- Preset `anthropic`, model `anthropic/claude-sonnet-4-6` → sends `claude-sonnet-4-6`
- Preset `openrouter`, model `openrouter/anthropic/claude-sonnet-4-5` → sends `anthropic/claude-sonnet-4-5`
- Preset `ollama`, model `llama3.3` → sends `llama3.3`

For Cloudflare AI Gateway or other proxies, use **额外 headers** with either JSON:

```json
{"cf-aig-authorization":"Bearer ..."}
```

or one header per line:

```text
cf-aig-authorization: Bearer ...
```

### Configure the CLI path

Obsidian launched from Finder does **not** inherit your shell `PATH`. Create a stable symlink in `~/bin/` and point the plugin setting at it:

```bash
mkdir -p ~/bin
# Claude Code (Mach-O binary, no Node needed)
ln -sf "$(readlink -f "$(which claude)")" ~/bin/claude
# Codex (Node script — use the wrapper pattern below instead)
cat > ~/bin/codex <<'EOF'
#!/bin/bash
NODE="/path/to/your/node"
CODEX_JS="/path/to/@openai/codex/bin/codex.js"
exec "$NODE" "$CODEX_JS" "$@"
EOF
chmod +x ~/bin/codex
```

Then in the plugin settings, paste `/Users/you/bin/codex` (or `~/bin/claude`) into **CLI 路径**, and click **Test** to verify.

## Commands

| Command | What it does |
|---------|--------------|
| `为当前笔记生成对照笔记（缓存优先）` | Show cached summary if present, otherwise call LLM |
| `强制重新生成（绕过缓存）` | Re-run the LLM even if cache matches |
| `打开对照笔记面板` | Open right-pane view (loads cache if present) |
| `导出当前对照笔记到 Vault` | Save the current comparison note under the configured export folder |
| `复制当前对照笔记 Markdown` | Copy the current comparison note as Markdown |
| `取消当前对照笔记生成` | Mark the active generation job as cancelled |
| `清除当前笔记的缓存` | Drop the cache entry for the active note |
| `清除所有缓存` | Wipe all cached summaries |

## Interaction

| Action | Effect |
|--------|--------|
| Left-click a card body | Scroll source editor to that section |
| Right-click a card | Context menu: Copy Markdown / Copy plain text / Copy anchor / Jump |
| Header icon buttons | Regenerate or cancel / copy all Markdown / export to Vault |
| File context menu | Generate / force regenerate / clear cache for a Markdown file |
| Ribbon icon | Open the comparison pane for the active note |
| Drag to select text | Normal text selection (does not trigger jump) |
| Scroll source editor | Active card gets highlighted on the right |

## Development

```bash
npm install
npm run dev       # watch main.ts + src/**/*.ts and rebuild main.js
npm run build     # production bundle for Obsidian
npm run typecheck
npm test
node --check main.js
```

### Code layout

The plugin keeps `main.js` as the generated Obsidian runtime bundle. Edit `main.ts` and `src/**/*.ts`; esbuild bundles them back into root `main.js`.

| File | Responsibility |
|------|----------------|
| `main.ts` | Obsidian lifecycle, commands, right-pane view, settings tab orchestration |
| `src/settings.ts` | Defaults, provider presets, settings normalization, cache fingerprinting and pruning |
| `src/schema.ts` | JSON extraction, card payload normalization, structured-output schemas |
| `src/providers.ts` | API provider request/response adapters |
| `src/generation-job-manager.ts` | Per-file generation state, cancellation, and error classification |
| `src/markdown.ts` | Card-to-Markdown/plain-text serialization |

## Design notes

The LLM is asked to return JSON with this shape:

```json
{
  "cards": [
    {
      "title": "3-10 character short heading",
      "anchor": "40-80 characters, verbatim from source, used for line resolution",
      "gist": "20-40 character one-line summary serving as a lead-in",
      "bullets": ["3-6 supporting details, 20-50 chars each"]
    }
  ]
}
```

- The **anchor** is the key mechanism that keeps scroll-sync working without relying on markdown headings. It's copied verbatim so `content.indexOf(anchor)` finds the origin line; graceful fallbacks (prefix trimming, whitespace normalization) handle minor LLM drift.
- The **gist + bullets** dual structure was chosen after several iterations — pure prose felt wall-of-text, pure bullets felt fragmented. A one-line lead-in before bullets gives both overview and scannable detail.
- Output is rendered via `MarkdownRenderer.render()` so any tables / bold / code / wikilinks in the LLM response render natively.

## Known limitations

- **Document size cap**: defaults to 20,000 characters. Longer notes are truncated unless you raise **最大输入字符数** in settings.
- **Claude Code CLI auth**: Obsidian subprocess reads of the macOS Keychain `Claude Code-credentials` service may fail due to code-signing ACL. Codex backend doesn't have this issue.
- **No streaming**: generation is a single batch call; expect ~5-15s wait depending on document length and backend.
- **Provider feature gaps**: some OpenAI-compatible providers reject optional fields or use provider-specific model IDs. If a request fails, verify the model ID and switch between `openai-chat`, `openai-responses`, or the provider's native format.
- **Preview mode**: scroll-sync uses Obsidian's `setEphemeralState` which works in reading mode too, but accuracy depends on how CodeMirror resolves line positions.

## License

MIT

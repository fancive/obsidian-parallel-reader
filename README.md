# Obsidian Parallel Reader

An Obsidian plugin that splits any long note into a left/right parallel-reading layout: the original content stays on the left; LLM-generated section summaries appear on the right. Scrolling the source highlights the matching summary card; clicking a summary jumps the source editor.

Inspired by the reading workflow demo in [this Bilibili video](https://www.bilibili.com/video/BV1FxoGBVETm/).

## Features

- **Self-adaptive segmentation** — the LLM decides natural topic boundaries, no need to match markdown headings. Short adjacent sections merge; long ones split.
- **Anchor-based line resolution** — summaries carry a verbatim quote from the source; the plugin finds the line number by `indexOf` (with graceful fallbacks).
- **Scroll-sync highlighting** — scrolling the source editor updates the active card in the summary pane.
- **Right-click → copy** — Markdown / plain text / anchor quote / jump to source, as a native Obsidian context menu.
- **Markdown rendering** — summaries render through Obsidian's official `MarkdownRenderer`, so tables, bold, code, wikilinks all work.
- **Persistent cache** — generated summaries are cached by SHA-1 of source content. Reopening a note shows the cached view instantly; edits invalidate the cache (shows a stale banner).
- **Three backends** — Claude Code CLI, Codex CLI, or Anthropic API. CLI backends reuse your existing subscription and don't need a separate API key.

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
| **Anthropic API (direct)** | API key in plugin settings | Separate billing | Fallback when CLI auth fails |

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
| `清除当前笔记的缓存` | Drop the cache entry for the active note |
| `清除所有缓存` | Wipe all cached summaries |

## Interaction

| Action | Effect |
|--------|--------|
| Left-click a card body | Scroll source editor to that section |
| Right-click a card | Context menu: Copy Markdown / Copy plain text / Copy anchor / Jump |
| Drag to select text | Normal text selection (does not trigger jump) |
| Scroll source editor | Active card gets highlighted on the right |

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

- **Document size cap**: 20,000 characters. Longer notes are truncated.
- **Claude Code CLI auth**: Obsidian subprocess reads of the macOS Keychain `Claude Code-credentials` service may fail due to code-signing ACL. Codex backend doesn't have this issue.
- **No streaming**: generation is a single batch call; expect ~5-15s wait depending on document length and backend.
- **Preview mode**: scroll-sync uses Obsidian's `setEphemeralState` which works in reading mode too, but accuracy depends on how CodeMirror resolves line positions.

## License

MIT

<p align="center">
  <img src="https://img.shields.io/github/v/release/fancive/obsidian-parallel-reader?style=flat-square&color=blue" alt="Release">
  <img src="https://img.shields.io/github/actions/workflow/status/fancive/obsidian-parallel-reader/ci.yml?style=flat-square&label=CI" alt="CI">
  <img src="https://img.shields.io/github/license/fancive/obsidian-parallel-reader?style=flat-square" alt="License">
  <img src="https://img.shields.io/github/stars/fancive/obsidian-parallel-reader?style=flat-square" alt="Stars">
</p>

# Obsidian Parallel Reader

> **[English](./README.md)**

Obsidian 对照阅读插件 — 左边原文、右边 AI 摘要卡片，滚动联动、点击跳转。

灵感来自 [这个 B 站视频](https://www.bilibili.com/video/BV1FxoGBVETm/) 的阅读工作流演示。

## 功能

- **自适应切段** — LLM 自行判断主题边界，不依赖 markdown 标题。短段合并、长段拆分。
- **滚动联动** — 滚动编辑器时，右侧对应卡片自动高亮。
- **流式输出** — 支持 OpenAI Chat 和 Anthropic API 的 SSE 流式响应，生成时实时显示进度。
- **20+ Provider** — Anthropic、OpenAI、Gemini、OpenRouter、Groq、DeepSeek、Moonshot、Ollama、LM Studio 等，还支持 Claude Code CLI 和 Codex CLI。
- **持久化缓存** — 按源文件 SHA-1 + 配置指纹缓存，重新打开秒出。内容或配置变更后显示"已过期"提示。
- **Markdown 渲染** — 通过 Obsidian 的 `MarkdownRenderer` 渲染，表格、加粗、代码、wikilink 均正常显示。
- **卡片编辑** — 右键任意卡片：复制、编辑、删除、跳转原文。
- **导出** — 保存为 Vault 中的 Markdown 文件，或复制到剪贴板。
- **中英双语 UI** — 命令、设置、面板文案全部支持中文和英文。

## 快速开始

### 安装

**手动安装** — 从 [最新 Release](https://github.com/fancive/obsidian-parallel-reader/releases) 下载 `main.js`、`manifest.json`、`styles.css`，放入 `.obsidian/plugins/parallel-reader/`，然后在 Obsidian 设置中启用。

### 配置 Provider

打开插件设置，选择 Provider preset，填入 API Key 和模型 ID 即可。

| Provider | 格式 | 说明 |
|----------|------|------|
| Anthropic | `anthropic-messages` | 默认，推荐 |
| OpenAI | `openai-chat` | Chat Completions |
| Google Gemini | `google-generative-ai` | generateContent |
| OpenRouter / Groq / DeepSeek / Moonshot 等 | `openai-chat` | OpenAI 兼容格式 |
| Ollama / LM Studio | `openai-chat` | 本地模型，无需 API Key |
| 自定义端点 | 任意 | 填写 Base URL 即可 |

Model ID 支持 `provider/model` 写法（如 `anthropic/claude-sonnet-4-6`），匹配当前 preset 时自动剥离前缀。

### CLI 模式（可选）

切换后端为 **Claude Code CLI** 或 **Codex CLI**，通过本地 CLI 调用 LLM。

Obsidian GUI 不继承 shell `PATH`，需要在设置中填写绝对路径：

```bash
which claude    # Claude Code
which codex     # Codex
```

## 使用

| 操作 | 效果 |
|------|------|
| 点击卡片 | 跳转到原文对应位置 |
| 右键卡片 | 上下文菜单：复制、编辑、删除、跳转 |
| 滚动编辑器 | 右侧卡片自动高亮 |
| `Alt+↑` / `Alt+↓` | 在卡片间导航 |
| `Enter`（摘要面板内） | 跳转到当前卡片原文 |
| Ribbon 图标 | 打开对照面板 |
| 文件右键菜单 | 生成 / 重新生成 / 清除缓存 |

## 原理

LLM 返回结构化 JSON：

```json
{
  "cards": [
    {
      "title": "短标题",
      "anchor": "从原文逐字复制的引用，用于定位",
      "gist": "一句话领读",
      "bullets": ["支撑要点 1", "支撑要点 2"]
    }
  ]
}
```

**anchor** 是滚动联动的核心 — 通过 `indexOf` 加多级容错定位行号，不依赖标题。

**gist + bullets** 兼顾概览和细节 — 纯散文太密，纯列表太碎。

## 开发

```bash
npm install
npm run dev       # watch 模式
npm run build     # 生产构建
npm run typecheck # TypeScript strict 模式
npm run lint      # Biome
npm test          # 构建 + 类型检查 + 测试
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

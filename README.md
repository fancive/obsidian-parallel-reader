# Obsidian Parallel Reader

一个 Obsidian 插件：左边原文、右边 AI 摘要卡片，滚动联动、点击跳转。

灵感来自 [这个 B 站视频](https://www.bilibili.com/video/BV1FxoGBVETm/) 的阅读工作流演示。

## 功能

- **自适应切段** — LLM 自行判断主题边界，不依赖 markdown 标题。短段合并、长段拆分。
- **Anchor 定位** — 每张摘要卡片携带原文逐字引用，插件通过 `indexOf` 定位行号（含多级容错回退）。
- **滚动联动** — 滚动编辑器时，右侧对应卡片自动高亮。
- **右键菜单** — 复制 Markdown / 纯文本 / anchor 引用 / 跳转原文 / 编辑 / 删除卡片。
- **Markdown 渲染** — 摘要通过 Obsidian 的 `MarkdownRenderer` 渲染，表格、加粗、代码、wikilink 均正常显示。
- **流式输出** — 支持 OpenAI Chat 和 Anthropic API 的 SSE 流式响应，生成时实时显示进度。
- **持久化缓存** — 生成结果按源文件 SHA-1 + 生成配置缓存在 `cache.json`，重新打开秒出；内容或配置变更后显示"已过期"提示。
- **面板操作** — 重新生成、复制全部 Markdown、导出到 Vault。
- **文件感知** — 缓存跟随文件重命名，源文件删除时自动清理。
- **Prompt 控制** — 可选输出语言、卡片数量范围、自定义 system prompt。
- **中英双语 UI** — 命令、设置、面板文案全部支持中文和英文。
- **多 Provider 支持** — Anthropic、OpenAI、Gemini、OpenRouter、Groq、DeepSeek、Moonshot、千帆、MiniMax、xAI、Mistral、Cerebras、智谱、Ollama、LM Studio 及自定义兼容端点。

## 安装

### 手动安装

1. 下载 [最新 Release](https://github.com/fancive/obsidian-parallel-reader/releases) 中的 `main.js`、`manifest.json`、`styles.css`
2. 在 Vault 的 `.obsidian/plugins/` 目录下创建 `parallel-reader` 文件夹
3. 将三个文件放入该文件夹
4. Obsidian → **设置 → 第三方插件 → 已安装插件** → 启用 **Parallel Reader**

### 配置 Provider

在插件设置中选择一个 Provider preset，填入 API Key 和模型 ID 即可。

| Provider | API 格式 | 说明 |
|----------|----------|------|
| Anthropic | `anthropic-messages` | 默认 preset，推荐 |
| OpenAI | `openai-chat` | Chat Completions |
| Google Gemini | `google-generative-ai` | generateContent |
| OpenRouter / Groq / DeepSeek / Moonshot 等 | `openai-chat` | OpenAI 兼容格式 |
| Ollama / LM Studio | `openai-chat` | 本地模型，无需 API Key |
| 自定义端点 | 任意 | 填写 Base URL 即可 |

Model ID 支持 `provider/model` 写法（如 `anthropic/claude-sonnet-4-6`），匹配当前 preset 时自动剥离前缀。

## 命令

| 命令 | 说明 |
|------|------|
| 为当前笔记生成对照笔记（缓存优先） | 有缓存直接显示，否则调用 LLM |
| 强制重新生成（绕过缓存） | 忽略缓存重新调用 LLM |
| 打开对照笔记面板 | 打开右侧面板 |
| 导出当前对照笔记到 Vault | 保存为 Markdown 文件 |
| 复制当前对照笔记 Markdown | 复制到剪贴板 |
| 取消当前对照笔记生成 | 取消正在进行的生成 |
| `Alt+↑` / `Alt+↓` | 在摘要卡片间切换 |
| `Enter`（在摘要面板内） | 跳转到当前卡片对应的原文位置 |

## 交互

| 操作 | 效果 |
|------|------|
| 点击卡片 | 跳转到原文对应位置 |
| 右键卡片 | 上下文菜单 |
| 滚动编辑器 | 右侧卡片自动高亮 |
| 拖选文字 | 正常选择文本（不触发跳转） |
| 文件右键菜单 | 生成 / 重新生成 / 清除缓存 |
| Ribbon 图标 | 打开对照面板 |

## 开发

```bash
npm install
npm run dev       # 监听 main.ts + src/**/*.ts，自动重新构建
npm run build     # 生产构建
npm run typecheck # TypeScript 类型检查（strict 模式）
npm run lint      # Biome lint
npm test          # 构建 + 类型检查 + 测试
```

### 项目结构

| 文件 | 职责 |
|------|------|
| `main.ts` | 插件生命周期、命令注册、缓存管理、滚动联动 |
| `src/view.ts` | 右侧面板视图、卡片渲染、键盘导航、导出 |
| `src/modal.ts` | 卡片编辑弹窗 |
| `src/settings-tab.ts` | 设置面板 |
| `src/providers.ts` | API 请求/响应适配器（Anthropic、OpenAI、Gemini） |
| `src/streaming.ts` | SSE 流式解析 |
| `src/prompt.ts` | Prompt 构建、语言控制、自定义 prompt 模板 |
| `src/schema.ts` | JSON 提取、卡片数据归一化、结构化输出 schema |
| `src/anchor.ts` | Anchor 到行号的匹配（含容错） |
| `src/settings.ts` | 默认值、Provider preset、缓存指纹 |
| `src/i18n.ts` | 中英文 UI 翻译 |
| `src/cache.ts` / `src/cards.ts` / `src/navigation.ts` / `src/scroll.ts` / `src/vault.ts` / `src/markdown.ts` | 各种纯函数工具模块 |

## 设计

LLM 返回如下 JSON：

```json
{
  "cards": [
    {
      "title": "3-10 字短标题",
      "anchor": "40-80 字，从原文逐字复制，用于定位",
      "gist": "20-40 字一句话领读",
      "bullets": ["3-6 条支撑要点，每条 20-50 字"]
    }
  ]
}
```

- **anchor** 是滚动联动的核心机制，通过 `content.indexOf(anchor)` 定位行号，不依赖 markdown 标题。
- **gist + bullets** 双层结构在多次迭代后确定 — 纯散文太密、纯列表太碎，一句话导读 + bullet 兼顾概览和细节。

## 已知限制

- **文档长度**：默认 20,000 字符，超长笔记会截断（可在设置中调大）。
- **Provider 差异**：部分 OpenAI 兼容 provider 可能不支持某些可选字段，请根据报错切换 API 格式。
- **Preview 模式**：滚动联动在阅读模式下也能工作，但精度取决于 CodeMirror 的行位置计算。

## License

MIT

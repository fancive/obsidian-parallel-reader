<h1 align="center">Obsidian Parallel Reader</h1>

<p align="center">
  <em>Obsidian 对照阅读插件 — 左边原文、右边 AI 摘要卡片，滚动联动、点击跳转。</em>
</p>

<p align="center">
  <a href="https://github.com/fancive/obsidian-parallel-reader/releases/latest"><img src="https://img.shields.io/github/v/release/fancive/obsidian-parallel-reader?style=flat-square&color=4c1" alt="最新版本"></a>
  <a href="https://github.com/fancive/obsidian-parallel-reader/releases"><img src="https://img.shields.io/github/downloads/fancive/obsidian-parallel-reader/total?style=flat-square&color=4c1" alt="累计下载"></a>
  <a href="https://github.com/fancive/obsidian-parallel-reader/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/fancive/obsidian-parallel-reader/ci.yml?style=flat-square&label=CI" alt="CI 状态"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/github/license/fancive/obsidian-parallel-reader?style=flat-square" alt="开源协议"></a>
  <img src="https://img.shields.io/badge/Obsidian-%E2%89%A5%201.4.0-7c3aed?style=flat-square&logo=obsidian&logoColor=white" alt="Obsidian 1.4+">
</p>

<p align="center">
  <a href="https://github.com/fancive/obsidian-parallel-reader/stargazers"><img src="https://img.shields.io/github/stars/fancive/obsidian-parallel-reader?style=flat-square" alt="Star 数"></a>
  <a href="https://github.com/fancive/obsidian-parallel-reader/issues"><img src="https://img.shields.io/github/issues/fancive/obsidian-parallel-reader?style=flat-square" alt="未关闭 issue"></a>
  <img src="https://img.shields.io/github/last-commit/fancive/obsidian-parallel-reader?style=flat-square" alt="最近提交">
  <img src="https://img.shields.io/badge/TypeScript-strict-3178c6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript strict">
  <img src="https://img.shields.io/badge/code_style-biome-60a5fa?style=flat-square&logo=biome&logoColor=white" alt="代码风格 Biome">
  <a href="./README.md"><img src="https://img.shields.io/badge/lang-English-blue?style=flat-square" alt="English README"></a>
</p>

<p align="center">
  <a href="./README.md">English</a> · <b>中文</b>
</p>

---

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
- **多语言 UI 与输出** — UI 支持 Auto、中文、英文、日文、韩文、法文、德文、西班牙文；生成的 title/gist/bullets 也可选择这些固定语言，或跟随原文语言。

## 快速开始

### 第一步：安装插件

1. 打开 [Release 页面](https://github.com/fancive/obsidian-parallel-reader/releases)，下载最新版的三个文件：**main.js**、**manifest.json**、**styles.css**
2. 打开你的 Vault 文件夹，进入 `.obsidian/plugins/`（没有就新建），再创建一个叫 `parallel-reader` 的文件夹
3. 把下载的三个文件放进去
4. 打开 Obsidian → **设置** → **第三方插件** → 找到 **Parallel Reader** → 打开开关

> **找不到 `.obsidian` 文件夹？** macOS 在 Finder 里按 `Cmd+Shift+.` 显示隐藏文件；Windows 在文件资源管理器里勾选「显示隐藏的项目」。

### 第二步：配置 AI 服务

1. 在 Obsidian 中打开 **设置** → **Parallel Reader**
2. 选择一个 **Provider**（比如 Anthropic、OpenAI、DeepSeek 等）
3. 粘贴你的 **API Key**
4. （可选）修改 **模型**
5. 点击 **Test** 验证连接

搞定！打开任意笔记，按 `Cmd/Ctrl+P` 调出命令面板，运行 **「Parallel Reader: 为当前笔记生成对照笔记」** 即可。

<details>
<summary><b>支持的 Provider 一览</b></summary>

| Provider | 说明 |
|----------|------|
| **Anthropic** | 默认推荐 |
| **OpenAI** | GPT 系列 |
| **Google Gemini** | Gemini 系列 |
| **OpenRouter / Groq / DeepSeek / Moonshot 等** | OpenAI 兼容格式 |
| **Ollama / LM Studio** | 本地模型，无需 API Key |
| **自定义端点** | 任何 OpenAI 或 Anthropic 兼容的 API |

</details>

<details>
<summary><b>CLI 模式（进阶）</b></summary>

如果你本地装了 **Claude Code** 或 **Codex**，在设置里切换后端即可，插件会自动找到安装位置。万一自动探测失败，可以手动填写路径。

</details>

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
npm run test:unit
npm run test:component
npm run test:contract
npm run test:e2e  # 打包插件 + 临时 Vault smoke
```

CI / 发布前跑一次 contract gate 留证据：

```bash
bash .e2e/gate.sh --json    # 写出 .e2e/artifact.json（已 gitignore）
```

`TEST_LIVE=1` 可开启真实本地 Vault / provider 检查。

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

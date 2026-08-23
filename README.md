# Solo Learning

<p align="center">
  <img src="public/favicon.svg" width="72" alt="Solo Learning logo" />
</p>

从一个问题开始，用可交互的 SVG 图解和知识画布建立领域认知。

## 功能

- 同时生成文字快答与 SVG 图解
- 在无限画布中组织、缩放和连接知识卡片
- 通过追问持续扩展知识树
- 支持 Codex、Claude Code 和 OpenCode CLI，默认使用 Codex
- 导出可独立浏览的单文件 HTML

## 本地运行

要求：Node.js 18+，并至少安装且登录一个受支持的 Agent CLI。

```bash
npm install
npm run dev
```

打开 <http://localhost:5173>。API 默认监听 `127.0.0.1:8787`。

默认 Agent 是 Codex，也可以显式指定：

```bash
npm run agent -- --agent codex
```

模型、推理强度和速度也可以在启动时指定：

```bash
CODEX_MODEL=gpt-5.6-luna \
CODEX_REASONING_EFFORT=low \
CODEX_SERVICE_TIER=priority \
npm run dev
```

可用环境变量：

| 变量 | 说明 |
| --- | --- |
| `SOLO_DEFAULT_AGENT` | `codex`、`claude` 或 `opencode` |
| `SOLO_API_PORT` | API 端口，默认 `8787` |
| `CODEX_BIN` | Codex CLI 路径 |
| `CODEX_MODEL` | Codex 模型，默认 `gpt-5.6-sol` |
| `CODEX_REASONING_EFFORT` | 推理强度，默认 `medium`；GPT-5.6 支持 `none`、`low`、`medium`、`high`、`xhigh`、`max` |
| `CODEX_SERVICE_TIER` | 速度档位，默认 `priority`；可用值取决于账户，常用 `default`、`priority`，`ultrafast` 需要额外权限 |
| `CLAUDE_BIN` | Claude Code CLI 路径 |
| `OPENCODE_BIN` | OpenCode CLI 路径 |

## 构建

```bash
npm run build
npm run preview
```

运行数据保存在 `server/data/`，该目录不会提交到 Git。

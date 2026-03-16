# Claude-to-IM

Host-agnostic bridge connecting [Claude Code SDK](https://docs.anthropic.com/en/docs/claude-code) to instant messaging platforms.

Chat with Claude Code directly from Telegram, Discord, Feishu (Lark), or QQ — with full tool usage, permission control, and streaming status updates.

## Features

- **Multi-platform adapters** — Telegram, Discord, Feishu, QQ
- **Full Claude Code capabilities** — file editing, bash commands, web search, MCP tools, etc.
- **Permission modes** — `default`, `accept-edits`, `bypass` (auto-approve all tools)
- **Streaming preview** — real-time tool status updates in chat
- **Interactive AskUserQuestion** — inline buttons for single/multi-select questions
- **Daemon self-protection** — prevents accidental self-termination
- **Markdown rendering** — platform-native formatting (HTML for TG, Discord markdown, etc.)
- **SIGUSR2 graceful restart** — zero-downtime daemon reload

## Architecture

```
┌─────────────────────────────────────────────┐
│  IM Platform (Telegram / Discord / Feishu)  │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│  Bridge Layer  (src/lib/bridge/)            │
│  ├── adapters/     Platform-specific I/O    │
│  ├── conversation-engine.ts   Session mgmt  │
│  ├── bridge-manager.ts        Command router│
│  ├── question-broker.ts       AskUserQuestion│
│  └── security/     Permission & validation  │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│  Host Layer  (src/host/)                    │
│  ├── main.ts          Entry point & daemon  │
│  ├── llm-provider.ts  Claude Agent SDK glue │
│  ├── store.ts         Session persistence   │
│  └── config.ts        Environment config    │
└──────────────────┬──────────────────────────┘
                   │
           Claude Code CLI
```

## Quick Start

### Prerequisites

- Node.js >= 20
- Claude Code CLI installed (`npm install -g @anthropic-ai/claude-code`)
- A bot token for your IM platform

### Install & Build

```bash
git clone https://github.com/SipengXie2024/Claude-to-IM.git
cd Claude-to-IM
npm install
npm run build
```

### Configure

Create a `config.env` in your config directory (`~/.claude-to-im/` by default):

```env
# Required: at least one platform
CTI_TG_TOKEN=your-telegram-bot-token

# Optional
CTI_DISCORD_TOKEN=your-discord-bot-token
CTI_FEISHU_APP_ID=your-feishu-app-id
CTI_FEISHU_APP_SECRET=your-feishu-app-secret

# Allowed user IDs (comma-separated)
CTI_TG_ALLOWED_USERS=123456789
CTI_DISCORD_ALLOWED_USERS=123456789

# Working directory for Claude Code
CTI_WORK_DIR=/path/to/your/project

# Default permission mode: default | accept-edits | bypass
CTI_DEFAULT_MODE=default
```

### Run

```bash
# Start as daemon
bash scripts/daemon.sh start

# Check status
bash scripts/daemon.sh status

# Stop
bash scripts/daemon.sh stop
```

### Deploy as Claude Code Skill

```bash
npm run deploy  # builds + copies daemon.mjs to skill directory
```

## Bot Commands

| Command | Description |
|---------|-------------|
| `/start` | Start a new conversation |
| `/compact` | Compact conversation context |
| `/mode <mode>` | Switch permission mode |
| `/cost` | Show token usage |
| `/plan` | Enter plan mode |
| `/status` | Show session status |

## Multi-Instance

Run multiple instances by setting `CTI_HOME`:

```bash
# Instance 1 (default)
bash scripts/daemon.sh start

# Instance 2 with separate config
CTI_HOME=~/.claude-to-im-2 bash scripts/daemon.sh start
```

## Development

```bash
npm run typecheck    # Type check
npm run test:unit    # Run unit tests
npm run test         # typecheck + tests
npm run example      # Run mock host example
```

## License

[MIT](LICENSE)

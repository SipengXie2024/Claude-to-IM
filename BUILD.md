# Build & Deploy

## Prerequisites

- Node.js >= 20
- `@anthropic-ai/claude-agent-sdk` installed (stays external, not bundled)

## Repository Structure

```
src/
├── lib/bridge/        # Bridge layer — adapters, router, engine, types
│   ├── adapters/      # Telegram, Discord, Feishu, QQ
│   ├── bridge-manager.ts
│   ├── conversation-engine.ts
│   ├── channel-router.ts
│   └── ...
├── host/              # Host layer — daemon entry, store, LLM provider
│   ├── main.ts        # Daemon entry point
│   ├── store.ts       # JSON file-based session/binding store
│   ├── llm-provider.ts# Claude SDK wrapper
│   ├── config.ts      # Environment config loader
│   ├── logger.ts
│   └── ...
scripts/
├── build.js           # esbuild bundler (host+bridge → daemon.mjs)
├── daemon.sh          # Start/stop daemon instances
└── ...
```

## Build Commands

```bash
npm run build:lib      # tsc: compile bridge layer → dist/lib/
npm run build:daemon   # esbuild: bundle host+bridge → dist/daemon.mjs
npm run build          # both of the above
npm run deploy         # build + copy daemon.mjs to skill directory
```

## Development Workflow

```bash
# 1. Edit code in src/
vim src/host/store.ts

# 2. Build and deploy
npm run deploy

# 3. Restart daemon to load new code
bash scripts/daemon.sh stop && bash scripts/daemon.sh start

# For instance 2:
CTI_HOME=~/.claude-to-im-2 bash scripts/daemon.sh stop
CTI_HOME=~/.claude-to-im-2 bash scripts/daemon.sh start
```

## How It Works

1. `tsc` compiles `src/lib/bridge/` → `dist/lib/bridge/` (for npm package consumers)
2. `esbuild` bundles `src/host/main.ts` + all bridge imports → `dist/daemon.mjs`
3. `deploy` copies `dist/daemon.mjs` → `~/.claude/skills/claude-to-im/dist/daemon.mjs`
4. Daemon runs: `node dist/daemon.mjs` (launched by `daemon.sh`)

The `@anthropic-ai/claude-agent-sdk` is kept external because it spawns a CLI subprocess and resolves paths relative to its own package location.

## Multi-Instance

Two daemon instances can run simultaneously with different configs:

| Instance | Config Dir | Manage |
|----------|-----------|--------|
| 1 | `~/.claude-to-im/` | `bash scripts/daemon.sh start\|stop\|status` |
| 2 | `~/.claude-to-im-2/` | `CTI_HOME=~/.claude-to-im-2 bash scripts/daemon.sh start\|stop\|status` |

Each instance has its own `config.env`, `data/`, `logs/`, and `runtime/` under its config dir.

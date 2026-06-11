# MiMoCode Telegram Bot

Telegram bot client for [MiMoCode](https://github.com/XiaomiMiMo/MiMo-Code) — control your AI coding agent from your phone.

Send messages via Telegram, get responses from your local MiMoCode agent. Supports session management, model switching, and usage stats.

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) >= 18 or [Bun](https://bun.sh/)
- [MiMoCode](https://github.com/XiaomiMiMo/MiMo-Code) installed (`npm install -g @mimo-ai/cli`)
- A Telegram Bot Token (get from [@BotFather](https://t.me/BotFather))

### Install & Run

```bash
# One-time setup
npx mimocode-telegram-bot

# Or install globally
npm install -g mimocode-telegram-bot
mimocode-telegram-bot
```

### From Source

```bash
git clone https://github.com/user/mimocode-telegram-bot.git
cd mimocode-telegram-bot
npm install
cp .env.example .env
# Edit .env with your tokens
npm start
```

## Configuration

Copy `.env.example` to `.env` and fill in:

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Yes | Bot token from @BotFather |
| `TELEGRAM_ALLOWED_USER_ID` | Yes | Comma-separated Telegram user IDs |
| `MIMO_WORK_DIR` | No | Working directory (default: cwd) |
| `MIMO_API_URL` | No | Attach to an existing MiMoCode server, e.g. `http://127.0.0.1:4096` |
| `SESSION_TIMEOUT_MS` | No | Session timeout (default: 30min) |

### Get Your Telegram User ID

Message [@userinfobot](https://t.me/userinfobot) on Telegram to get your numeric ID.

## Bot Commands

| Command | Description |
|---------|-------------|
| `/start` | Show help & quick actions |
| `/new` | Start a new session |
| `/status` | Connection & session info |
| `/sessions` | List all sessions |
| `/models` | List available models |
| `/stats` | Usage statistics |
| `/export` | Export current session as JSON |
| `/providers` | List AI providers |
| `/agent` | Show current agent |
| `/delete <id>` | Delete a session |
| `/version` | MimoCode version |
| `/cancel` | Cancel running task |

## Architecture

```
Telegram User → Telegram API → Bot (grammY) → mimo run CLI → MiMoCode Agent
```

The bot spawns `mimo run --format json` for each message, parses the JSON stream response, and sends it back via Telegram with Markdown→HTML formatting.

When `MIMO_API_URL` is set, the bot passes `mimo run --attach <MIMO_API_URL> --dir <MIMO_WORK_DIR>` so it reuses an existing MiMoCode server instead of starting a new one.

## Development

```bash
bun install
bun run dev        # Dev with hot reload
bun run typecheck  # Type check
bun run build      # Build for production
```

## License

MIT

# MiMoCode Telegram Bot

Telegram bot client for [MiMoCode](https://mimo.xiaomi.com/mimocode) — control your AI coding agent from your phone.

## Security

This bot lets whitelisted Telegram users drive a coding agent on your host. You **MUST** set `TELEGRAM_ALLOWED_USER_ID` — the bot refuses to start without it. Keep `MIMO_SKIP_PERMISSIONS=false` unless the host is disposable. Never share your bot token.

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) >= 18 or [Bun](https://bun.sh/)
- [MiMoCode](https://mimo.xiaomi.com/mimocode/install) installed (`npm install -g @mimo-ai/cli`)
- A Telegram Bot Token (get from [@BotFather](https://t.me/BotFather))

### 1. Get Your Telegram Bot Token

1. Open Telegram, search for [@BotFather](https://t.me/BotFather)
2. Send `/newbot`
3. Follow the prompts to name your bot
4. Copy the token (looks like `123456789:ABCdefGHIjklMNOpqrSTUvwxYZ`)

### 2. Get Your Telegram User ID

1. Open Telegram, search for [@userinfobot](https://t.me/userinfobot)
2. Send any message
3. Copy your numeric User ID

### 3. Install & Run

```bash
git clone https://github.com/morandot/mimocode-telegram-bot.git
cd mimocode-telegram-bot
bun install
cp .env.example .env
# Edit .env with your tokens
bun run start
```

### 4. Configuration

Create a `.env` file:

```bash
# Required
TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrSTUvwxYZ
TELEGRAM_ALLOWED_USER_ID=123456789

# Optional
MIMO_WORK_DIR=/path/to/your/project
MIMO_API_URL=http://127.0.0.1:4096
MIMO_SKIP_PERMISSIONS=false
```

> `MIMO_SKIP_PERMISSIONS` accepts `true` or `1` to enable.

### 5. Start Chatting

1. Open Telegram and search for your bot
2. Send `/start`
3. Send any message to chat with MiMoCode

## Usage

### Basic Chat

Send a message and MiMoCode responds:

```
You: Fix the bug in src/utils.ts line 42
Bot: [analyzes and fixes the bug]
```

### Switch Modes

```
/use plan      # Read-only analysis
/use compose   # Full workflow: plan → code → test → review
/compose Build a REST API with auth
```

### Switch Model

```
/model                         # List models and current selection
/model xiaomi/mimo-v2.5-pro    # Switch model
```

### Session Management

```
/new          # Start fresh session
/sessions     # List all sessions
/delete       # Delete current session
/export       # Export as JSON file
```

## Commands

| Command | Description |
|---------|-------------|
| `/start` | Show help & quick actions |
| `/help` | Show all commands |
| `/new` | Start a new session |
| `/cancel` | Stop running task |
| `/status` | Connection & session info |
| `/sessions` | List all sessions (reply number to switch) |
| `/model` | Switch model |
| `/use` | Switch agent (build/plan/compose) |
| `/compose` | Run compose mode workflow |
| `/max` | Run with max parallel sampling |
| `/models` | List available models |
| `/stats` | Usage statistics |
| `/export` | Export current session |
| `/providers` | List AI providers |
| `/delete` | Delete a session |
| `/version` | MimoCode version |

## Development

```bash
bun install
bun run dev        # Dev with hot reload
bun run typecheck  # Type check
bun run build      # Build for production
```

## License

MIT

# Calendar Summarizer

Interactive CLI tool that fetches your Google Calendar events and uses Claude AI to generate a "reverse journal" — a first-person narrative summary of your schedule, written in past tense like a diary.

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Create Google Cloud credentials

1. Go to the [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or select an existing one)
3. Enable the **Google Calendar API** and **People API**
4. Create **OAuth 2.0 Client ID** credentials (Desktop app type)
5. Download the JSON and save it as `credentials/credentials.json`

### 3. Configure environment

Copy the example and add your Anthropic API key:

```bash
cp .env.example .env
```

Edit `.env`:

```
ANTHROPIC_API_KEY=sk-ant-...
SUMMARY_QUALITY=standard
```

### 4. Run

```bash
npm start
```

On first run you'll be prompted to add a Google account — a browser window opens for OAuth. Tokens are saved per-account in `credentials/accounts.json`.

## Features

### Multi-account Google Calendar

- Authenticate multiple Google accounts (work + personal) and query them together
- Add/remove accounts interactively on each run
- OAuth 2.0 with automatic token refresh
- Multi-calendar selection grouped by account (primary calendars pre-checked)

### Flexible date ranges

- **Present**: Today, Tomorrow
- **Future**: This week, Next week, Next 7 days, Next 30 days
- **Past**: Last week, Last month, Last quarter
- **Custom past**: Last N weeks/months/quarters

### Event display

- Events grouped by day with colored terminal output (via [chalk](https://github.com/chalk/chalk))
- Badge chips for event types: OOO, Focus, WFH, Birthday, Gmail events
- Status indicators: Tentative, Cancelled
- Shows location, organizer, attendees (grouped by RSVP), Google Meet links, attachments
- Regex-based event filtering (include or exclude by pattern)

### AI-powered reverse journal

Uses Claude to generate a narrative summary of your calendar through a multi-stage map-reduce pipeline:

1. **Compress** — strips raw events to minimal structured data
2. **Analytics** — computes meeting frequency, top contacts, time allocation, recurring patterns, weekly baseline
3. **Week summaries** — structured generation per week (parallel batches of 5)
4. **Month summaries** — aggregates weeks into monthly narratives (for 1+ month ranges)
5. **Quarter summaries** — aggregates months into quarterly arcs (for 3+ month ranges)
6. **Final narrative** — streams a full markdown journal with analytics woven in

Quality tiers:
- **Standard** — Haiku (map) + Sonnet (reduce)
- **Premium** — Sonnet (map) + Opus (reduce)

### Live pipeline UI

A custom terminal dashboard renders real-time progress with:
- Per-stage status indicators (spinner, checkmark, pending)
- Progress bar and week/month grid
- Elapsed time tracking

### Output saving

Each run saves to `output/{dateRange}_{label}/`:
- `narrative.md` — the final journal
- `analytics.json` — computed analytics
- `week-summaries.json`, `month-summaries.json`, `quarter-summaries.json` — intermediate structured summaries
- `compressed-events.json` — the compressed event data

## Tech stack

- **Runtime**: Node.js (ESM, no build step)
- **AI**: [Vercel AI SDK](https://sdk.vercel.ai/) + `@ai-sdk/anthropic` with [Zod](https://zod.dev/) schemas for structured outputs
- **Google APIs**: `googleapis` for Calendar + OAuth2
- **CLI**: `@inquirer/prompts` for interactive prompts, `chalk` for styling, `ora` for spinners

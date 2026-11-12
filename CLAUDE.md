# Arche

Hackathon project (organizer: ParallelOS, a media company running many creator accounts across many phones).
Pitch: **be the creator you want to be.** A user picks or describes an *arche* (a dream creator identity: F1 driver,
Hollywood star, K-pop idol, Michelin chef…). An AI agent drives a real browser, live, to find what's viral right now
that fits that arche, then turns it into playable 9:16 video templates the creator reshoots with their own face.

Audience: picky creatives. Keep the UI uncluttered and high-polish. **Never a dashboard or a landing page.**

## Run

```
npm install
npx agent-browser install      # downloads Chrome once
cp .env.example .env           # set OPENAI_API_KEY (optional OPENAI_MODEL, default gpt-5-mini; OPENAI_BASE_URL for a mock)
npm start                      # http://localhost:5173
npm test                       # node --test: research.test.js
```

No key: the UI works, any agent turn returns an "OPENAI_API_KEY is not set" error.

## Stack and files

Plain Node (ESM, no framework, no build step) and a single HTML page. Only dependency: `agent-browser` (Vercel's Rust
CLI that drives Chrome; run as `node node_modules/agent-browser/bin/agent-browser.js --session X <cmd>`).

- `server.js`: http server, OpenAI tool-calling agent loop, agent-browser wrapper, SSE streaming, JSON-file storage.
- `research.js`: pure functions for deep search (YouTube card parsing, video-page parsing, the date rule, pattern detection). Tested in `research.test.js`.
- `public/index.html`: the whole UI (CSS + markup + script). Code is split by `// ---------- section ----------` comments.
- `data/`: plain JSON files. `personas/` (arches), `accounts/`, `threads/`, `shots/` (step screenshots). Only `data/personas/starter-*.json` is committed.
- `public/posters/`: custom still frames for preset reels.
- `.claude/launch.json`: preview config "adguy" (`npm start`, port 5173).
- `Dockerfile` + `fly.toml`: hosted deploy (Fly app `arche-demo`, region `sin`, volume `/data` via `DATA_DIR`, Chrome with `--no-sandbox`).

## Concepts

- **Arche** (internally still called *persona* everywhere in code, files and API: `personas`, `personaId`, `/api/personas`). User-facing text says "arche".
  Fields: name, tagline, niche, audience, voice, examples (captions), avoid, refs (YouTube ids for its picture), optional `video` (preset reel).
- **Account**: a real handle (name, platform, country) bound to exactly one arche.
- **Thread**: a chat. `accountId` optional, `personaId` set. Items: `user`, `browse` (steps + found videos + trend board), `templates`, `reply`, `persona`, `newpersona`, `error`. `thread.llm` holds the OpenAI history (never sent to the client).
- **Presets**: the four `starter-*` arches (F1 Driver, Hollywood Star, K-Pop Idol, Michelin Chef). Shown as reel tiles on the blank chat; clicking one creates a thread and starts research immediately (no setup screens).
- A thread without an arche: the first message describes one; the agent searches, then calls `create_persona` (shown as a card with its mood board building itself).

## The agent (server.js `turn()`)

OpenAI Chat Completions with tools. Scout tools: `search` (YouTube, upload-date filter today/week/month), `hashtag`
(reach: videos + channels), `inspect` (a Short's tags/description), `judge` (confirm/drop a trend-board pattern),
`browser` (raw allowlisted agent-browser command), `submit_templates`, `reply`, `update_persona`. Creation uses
`CREATE_TOOLS` + `CREATE_SYSTEM`. `MAX_STEPS` defaults to 32.

**Deep search rules** (research.js): every collected video is looked up on its public watch page for the exact
publish time, views, channel and tags. Videos older than 14 days never count as evidence. A pattern needs 3+ fresh
videos found independently: a search is never evidence for its own words, and broad category tags (#fashion, #ootd…)
are ignored. Templates are built only from confirmed patterns.

**Live browser**: agent-browser's WebSocket stream is forwarded over SSE as `frame` events. The UI draws an agent
cursor over it (clicks use `get box`), a shelf of found videos, the trend board, and afterwards a step replay.

## Preset reels (public/index.html "reel players")

Delicate; read before changing. Each preset's YouTube Short (youtube-nocookie embed, JS API via postMessage) loads with
the page and plays muted, **visible** under a `.cover` still frame (browsers pause muted video that is invisible).
Hover fades the cover to reveal the already-playing video (no play command: that makes YouTube flash its buttons).
The tile loops the clip itself (`video.start`/`video.end`) by seeking, and covers the video for ~1.5s after each jump
because YouTube flashes a play icon. The iframe is rendered 140% and cropped (top -16%) so YouTube's Shorts chrome falls
outside the tile while heads stay in frame. Opening a thread pauses all players. Pick vertical, embeddable videos and
judge them **playing in that crop**, not by thumbnail. `video.poster` points to a still in `public/posters/`.

## Conventions and gotchas

- Smallest change that fully works; no new dependencies for a few lines; keep the one-file structure.
- Windows dev box: shell heredocs/`sed` mangle backslashes in regexes. Prefer the Edit tool or a patch file; run `node --check server.js` and parse-check the page script after edits.
- A `//` comment pasted mid-line has silently disabled code before: check edits that touch a line with a comment.
- Mock the model without a key: `OPENAI_BASE_URL=http://127.0.0.1:<port>` pointing at a small script that returns scripted tool calls.
- Delete test threads/personas you create (`DELETE /api/threads/:id`) so `data/` stays clean.
- No CAPTCHA solving, stealth or bot-evasion. TikTok, Instagram and Reddit block the browser; the agent doesn't visit them.
- Celebrity videos/likenesses in presets are demo-only; a public product would need rights.
- Commits end with a Co-Authored-By line; remote is `github.com/ChuuniX-AI/Arche`, branch `main`.

## Known limits

- No auth: anyone with the URL can spend the OpenAI credits.
- Not tested with a real OpenAI key end to end (only a scripted mock).
- Touch devices: reels have no hover, so they only show stills.
- Cloud hosting needs a long-lived server with Chrome and a persistent `data/` volume; YouTube may challenge datacenter IPs.

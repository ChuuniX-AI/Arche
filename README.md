# Ad Guy: what's viral, as templates

An agent drives a real browser (agent-browser) through Google Trends and YouTube for any niche and country,
OpenAI decides where to look, and the result is a set of video templates. Each template plays as a 9:16 reel
(built from the reference videos the agent found, with on-screen text, shot directions and caption) and exports as MP4
for creators to reshoot with their own footage.

## Run

1. `npm install` then `npx agent-browser install` (downloads Chrome once).
2. Copy `.env.example` to `.env` and set `OPENAI_API_KEY` (optionally `OPENAI_MODEL`, default `gpt-5-mini`).
3. `npm start` and open http://localhost:5173

Every run is saved in `runs/`. **Replay last run** plays it back at demo speed, so the stage demo
doesn't depend on live sites. `runs/sample` is a real browse of Google Trends and YouTube, with templates written by hand.

TikTok, Instagram and Reddit block automated browsers (403 / CAPTCHA), so the agent is told to skip them.

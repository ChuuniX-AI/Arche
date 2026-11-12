# Arche: be the creator you want to be

Pick a persona (who you want to be as a creator) and put it on an account. Each account posts as one persona.
In a thread, ask what's viral. The agent drives a real browser (agent-browser) through Google Trends and YouTube
while you watch it live, with a cursor showing what it opens, reads, scrolls, clicks and collects,
and every video it reads (with views and age) lands on a shelf under the browser. Afterwards, the browsing replays like a short video.
It keeps only the trends that fit that persona and lists the ones it skipped and why; videos a template is based on are ringed on the shelf.
Each template plays as a 9:16 reel with on-screen text, shot directions and a caption in the persona's voice, and exports as MP4.
Follow-ups ("make #2 shorter", "we never say bestie") revise the templates, and lasting preferences are saved to the persona.

## Run

1. `npm install` then `npx agent-browser install` (downloads Chrome once).
2. Copy `.env.example` to `.env` and set `OPENAI_API_KEY` (optionally `OPENAI_MODEL`, default `gpt-5-mini`).
3. `npm start` and open http://localhost:5173

## How it finds trends (deep search)

A trend is many creators adopting the same thing right now, so the agent doesn't stop at one search:

1. **Fan out.** 6–10 YouTube searches, each filtered to uploads from this week, mixing the niche with trend shapes ("pov", "ranking", "but make it"…).
2. **Exact numbers.** Every video it collects is looked up on its own public page: exact publish time, views, channel and the creator's tags.
   Views per hour come from that. Anything older than two weeks is greyed out on the shelf and never counts toward a trend.
3. **Patterns.** The server finds hashtags, creator tags and title phrases shared by 3+ fresh videos. A search is never evidence for its own
   words (videos found by searching "outfit check" don't count toward "outfit check"), and broad categories like #fashion aren't trends.
4. **Follow the thread.** For the strongest patterns the agent opens the hashtag page (how many videos and channels use it), checks today's
   uploads, and inspects the fastest video, then marks each pattern confirmed or dropped.
5. **Trend board.** All of this shows live under the browser; templates are built only from confirmed patterns.

`npm test` runs the checks for the parsing and pattern rules (`research.test.js`).

## Personas and accounts

- **A persona** is who you want to be: a name, a one-line "who you want to be", niche, audience, voice, example captions, and what it never posts.
- **Become someone new** by just describing it on the blank chat ("I want to be a brutally honest street food reviewer, Taglish").
  The agent looks at what creators like that post on YouTube in the live browser, takes their formula (never their identity),
  and creates the persona as a card in the chat. From the card: find what's viral now, put it on an account, or edit it.
- **Or tap a preset.** Four arches sit above the composer as reels: The Michelin Chef, The F1 Driver, The Hollywood Star, The K-Pop Idol.
  Each plays a real YouTube Short (muted) while hovered, with a caption styled like a short-video post. Tapping one skips setup and starts the research.
  The videos and their famous faces are for the demo: a public product would need rights to use those likenesses.
  YouTube sometimes adds its own Shorts buttons to embeds, so the tiles zoom the video to keep those outside the frame.
- **A persona's profile** (click its board, or its name in a thread's header) shows its mood board, voice, example captions,
  accounts, and every template made for it so far.
- **An account** is a real handle (name, platform, country) bound to one persona. Choosing a persona that isn't on an account asks which account should post as it.

TikTok and Instagram profiles, and Reddit, block automated browsers, so the agent doesn't visit them.

## Data

Personas, accounts, threads and screenshots are saved as plain files in `data/`. Only the starter personas are checked in.

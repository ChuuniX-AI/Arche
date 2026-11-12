# Persona Studio: be the creator you want to be

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

## Personas and accounts

- **A persona** is who you want to be: a name, a one-line "who you want to be", niche, audience, voice, example captions, and what it never posts.
- **Become someone new** by just describing it on the blank chat ("I want to be a brutally honest street food reviewer, Taglish").
  The agent looks at what creators like that post on YouTube in the live browser, takes their formula (never their identity),
  and creates the persona as a card in the chat. From the card: find what's viral now, put it on an account, or edit it.
- **Or start as one** of the personas above the composer. Each is a mood board of frames from real YouTube Shorts of the kind it makes
  (picked by the agent for personas it creates). Four starters are included. Editing is the only form.
- **A persona's profile** (click its board, or its name in a thread's header) shows its mood board, voice, example captions,
  accounts, and every template made for it so far.
- **An account** is a real handle (name, platform, country) bound to one persona. Choosing a persona that isn't on an account asks which account should post as it.

TikTok and Instagram profiles, and Reddit, block automated browsers, so the agent doesn't visit them.

## Data

Personas, accounts, threads and screenshots are saved as plain files in `data/`. The starter personas, sample account and sample thread are checked in.
The sample thread's browsing and screenshots are real, but its templates were written by hand.

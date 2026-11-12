# Persona Studio: be the creator you want to be

Pick a persona (who you want to be as a creator) and put it on an account. Each account posts as one persona.
In a thread, ask what's viral. The agent drives a real browser (agent-browser) through Google Trends and YouTube
while you watch it live. It keeps only the trends that fit that persona and lists the ones it skipped and why.
Each template plays as a 9:16 reel with on-screen text, shot directions and a caption in the persona's voice, and exports as MP4.
Follow-ups ("make #2 shorter", "we never say bestie") revise the templates, and lasting preferences are saved to the persona.

## Run

1. `npm install` then `npx agent-browser install` (downloads Chrome once).
2. Copy `.env.example` to `.env` and set `OPENAI_API_KEY` (optionally `OPENAI_MODEL`, default `gpt-5-mini`).
3. `npm start` and open http://localhost:5173

## Personas and accounts

- **A persona** is who you want to be: a name, a one-line "who you want to be", niche, audience, voice, example captions, and what it never posts.
  The blank chat shows the persona library. Four starter personas are included.
- **Create a persona** from a description and creators you'd love to be like:
  - A YouTube channel link: the agent opens its Shorts in the live browser and reads the titles.
  - YouTube video links: read through YouTube's public oEmbed.
  - TikTok video links: read through TikTok's public oEmbed. Some videos return no caption; paste those captions instead.

  OpenAI then drafts the persona, taking those creators' formula rather than their identity, and you edit it before saving.
  Without a key, captions are still read, and you fill in the rest yourself.
- **An account** is a real handle (name, platform, country) bound to one persona. Choosing a persona that isn't on an account asks which account should post as it.

TikTok and Instagram profiles, and Reddit, block automated browsers, so the agent doesn't visit them.

## Data

Personas, accounts, threads and screenshots are saved as plain files in `data/`. The starter personas, sample account and sample thread are checked in.
The sample thread's browsing and screenshots are real, but its templates were written by hand.

// Arche: a creator picks who they want to be (a persona), and an agent browses public trend sources with agent-browser
// to find what's viral that fits that persona, then turns it into video templates. OpenAI decides what to do. One file, no framework.
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { CARDS_JS, REACH_JS, parseCard, videoFromHtml, withPageData, patternsOf, videoLine, patternLine, fmt, FRESH_HOURS } from './research.js';

const run = promisify(execFile);
const ROOT = import.meta.dirname;
const DATA = path.join(ROOT, 'data');
const AB = path.join(ROOT, 'node_modules/agent-browser/bin/agent-browser.js');
const MODEL = process.env.OPENAI_MODEL || 'gpt-5-mini';
const MAX_STEPS = Number(process.env.MAX_STEPS || 32); // a deep search takes 20-30 steps
const PORT = Number(process.env.PORT || 5173);
for (const d of ['personas', 'accounts', 'threads', 'shots']) await fs.mkdir(path.join(DATA, d), { recursive: true });

// ---------- storage: one JSON file per persona, account and thread ----------
const ID = /^[\w-]{1,64}$/;
const file = (kind, id) => { if (!ID.test(id)) throw Object.assign(new Error('bad id'), { code: 'ENOENT' }); return path.join(DATA, kind, id + '.json'); };
const load = async (kind, id) => JSON.parse(await fs.readFile(file(kind, id), 'utf8'));
const save = (kind, obj) => fs.writeFile(file(kind, obj.id), JSON.stringify(obj, null, 1));
async function list(kind) {
  const names = (await fs.readdir(path.join(DATA, kind))).filter((n) => n.endsWith('.json'));
  return Promise.all(names.map((n) => load(kind, n.slice(0, -5))));
}
const newId = () => Date.now().toString(36) + crypto.randomBytes(3).toString('hex');

// ---------- browser ----------
// Only page-reading and navigation commands. No eval, cookies, storage or downloads.
const ALLOWED = new Set(['links', 'open', 'snapshot', 'click', 'fill', 'press', 'scroll', 'get', 'back', 'wait', 'find']);

function browser(session, args) {
  if (!Array.isArray(args) || !ALLOWED.has(args[0])) return `Command not allowed. Use one of: ${[...ALLOWED].join(', ')}`;
  if (args[0] === 'open' && !/^https?:\/\//.test(args[1] || '')) return 'open needs an http(s) URL';
  if (args[0] === 'links') return cardsOf(session).then((cs) => cs.map(videoLine).join('\n'));
  return ab(session, args);
}
// The video cards on the current page, read by a fixed script.
const cardsOf = (session) => ab(session, ['eval', CARDS_JS]).then((o) => { try { return JSON.parse(JSON.parse(o)).map((c) => ({ ...parseCard(c), box: c.box })); } catch { return []; } });
// A video's own public page gives its exact publish time, views, channel and the creator's tags.
const pages = new Map(); // shortcut: unbounded in-memory cache, fine for a demo; add eviction if it runs for days
const pageData = (id) => {
  if (!pages.has(id)) pages.set(id, fetch(`https://www.youtube.com/watch?v=${id}`, { headers: { 'accept-language': 'en-US,en;q=0.9' } })
    .then((r) => (r.ok ? r.text() : '')).then(videoFromHtml).catch(() => null));
  return pages.get(id);
};
// Looks up many videos at once, 8 at a time.
async function exact(cards) {
  const out = [...cards];
  let next = 0;
  await Promise.all(Array.from({ length: 8 }, async () => { while (next < out.length) { const i = next++; out[i] = withPageData(out[i], await pageData(out[i].id)); } }));
  return out;
}
// Where an element is on screen, so the cursor can go there before the agent clicks it.
const boxOf = (session, sel) => ab(session, ['get', 'box', sel, '--json']).then((o) => {
  try { const d = JSON.parse(o.match(/\{.*\}/s)[0]).data; const b = d.box || d; return b.width ? { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) } : null; } catch { return null; }
});

// Unrestricted, for the server's own calls.
async function ab(session, args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [AB, '--session', session, ...args.map(String)], { timeout: 45000, maxBuffer: 8e6 });
    return (stdout + stderr).slice(0, 7000) || 'ok';
  } catch (e) {
    return `Error: ${(e.stdout || '') + (e.stderr || e.message)}`.slice(0, 2000);
  }
}

// Starts a browser session and forwards its live viewport (agent-browser's WebSocket stream) to emit().
// Frames only arrive when the page changes, so this adds no wait to the agent.
async function liveBrowser(session, emit) {
  await ab(session, ['set', 'viewport', '1280', '800']);
  let latest = null, ws = null, url = '';
  try {
    const port = JSON.parse((await ab(session, ['stream', 'status', '--json'])).match(/\{.*\}/s)[0]).data.port;
    ws = new WebSocket(`ws://127.0.0.1:${port}/?maxFps=12`);
    ws.onmessage = (m) => {
      const e = JSON.parse(m.data);
      if (e.type === 'frame') { latest = e.data; emit({ type: 'frame', data: e.data }); }
      if (e.type === 'url') { url = e.url; emit({ type: 'url', url: e.url }); }
    };
    ws.onerror = () => {};
  } catch { /* no stream: the agent still works, the user just sees step notes */ }
  return {
    latest: () => latest,
    url: () => url,
    close: async () => { ws?.close(); await ab(session, ['close']); },
  };
}

// ---------- OpenAI ----------
async function openai(messages, tools, tool_choice = 'required') {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set. Add it to .env and restart the server.');
  const res = await fetch(`${process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model: MODEL, messages, tools, tool_choice }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()).choices[0].message;
}
const fn = (name, description, properties, required = Object.keys(properties)) =>
  ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });
const str = (description) => ({ type: 'string', description });
const strs = (description) => ({ type: 'array', items: { type: 'string' }, description });

const TEMPLATE = {
  type: 'object',
  properties: {
    title: str('Short punchy template name, e.g. "POV: tita sees your outfit"'),
    trend: str('What is going viral and the evidence (views, dates, search growth).'),
    fit: str('One line on why this works for THIS persona and how it was adapted to its niche.'),
    momentum: { type: 'string', enum: ['rising', 'peaking', 'saturated'] },
    days_left: { type: 'number', description: 'Rough days before the trend feels overdone.' },
    format: str('e.g. POV skit, reaction, list, before/after, storytime'),
    duration_s: { type: 'number' },
    hook: str('The on-screen line for the first 2 seconds.'),
    beats: { type: 'array', items: { type: 'object', properties: { t: str('e.g. "0-2s"'), shot: str('What the camera sees / what the creator does.'), text: str('On-screen text, empty if none.') }, required: ['t', 'shot', 'text'] } },
    caption: str('Written in the persona\'s voice, like its example captions.'),
    hashtags: strs(''),
    audio: str('Sound suggestion (trending audio name or style).'),
    sources: strs('URLs you saw as evidence.'),
    references: strs('1-3 YouTube video ids (11 characters) this template is based on.'),
    pattern: str('The trend board pattern this template is based on, exactly as written in [brackets].'),
  },
  required: ['title', 'trend', 'fit', 'momentum', 'days_left', 'format', 'duration_s', 'hook', 'beats', 'caption', 'hashtags', 'audio', 'sources', 'references'],
};

const SEARCH_TOOLS = [
  fn('search', 'Search YouTube for Shorts uploaded recently, collect every video with its exact age and views per hour, and update the trend board. Use many different searches.', {
    query: str('What to search, e.g. "pov outfit" or "emergency fit pinoy". Short phrases work best.'),
    when: { type: 'string', enum: ['today', 'week', 'month'], description: 'Upload date filter. Use "week" to discover, "today" to check a pattern is still picking up.' },
    note: str('One short sentence shown to the user.'),
  }),
  fn('hashtag', 'Open a hashtag page: how many videos and channels use it, plus its videos. Use it on promising hashtag patterns.', {
    tag: str('Without the #, e.g. "emergencyfit".'), note: str('One short sentence shown to the user.'),
  }),
  fn('inspect', 'Open one Short and read its description, tags, channel and exact numbers. Use it on the fastest video of a strong pattern.', {
    id: str('The 11-character video id.'), note: str('One short sentence shown to the user.'),
  }),
  fn('judge', 'Mark a trend board pattern as confirmed or dropped, with a plain-language name and a short reason the user sees.', {
    pattern: str('The pattern key exactly as written in [brackets].'),
    status: { type: 'string', enum: ['confirmed', 'dropped'] },
    name: str('What the trend is, in plain words, e.g. "Bag-drop outfit transitions".'),
    reason: str('The evidence in a few words, e.g. "31 creators this week, still rising today" or "Only one creator".'),
  }),
];
const CHAT_TOOLS = [
  ...SEARCH_TOOLS,
  fn('browser', 'Run one agent-browser command. Examples: ["open","https://..."], ["get","text","main"], ["snapshot","-i","-c"], ["click","@e12"], ["scroll","down","1500"], ["back"], ["links"] (YouTube video ids and titles on this page).',
    { note: str('One short sentence shown to the user, e.g. "Checking what Filipinos searched in the last 48 hours".'), args: strs('') }),
  fn('submit_templates', 'Show video templates to the user. Ends your turn.', {
    message: str('One or two sentences to the user, in plain words. Say so plainly if nothing fit today.'),
    templates: { type: 'array', items: TEMPLATE, description: '0 to 4 templates that fit this persona. Empty is fine when nothing fits.' },
    skipped: { type: 'array', items: { type: 'object', properties: { trend: str(''), reason: str('Why it does not fit this persona.') }, required: ['trend', 'reason'] } },
  }),
  fn('reply', 'Answer the user in text, without templates. Ends your turn.', { text: str('') }),
  fn('update_persona', 'Remember a lasting preference about this persona, e.g. when the user says "we never say bestie". Does not end your turn.', {
    note: str('What changed, shown to the user, e.g. "Won\'t use \'bestie\' for Mika again".'),
    avoid: strs('Things to add to the persona\'s avoid list.'),
    voice: str('A replacement voice description, or empty to keep the current one.'),
  }),
];

const PERSONA_FIELDS = {
  name: str('A short persona name, e.g. "Budget fashion big sister". Never a real person’s name.'),
  tagline: str('Who the creator wants to be, in one line, e.g. "the friend who makes 200-peso outfits look expensive".'),
  niche: str('e.g. "budget home cooking"'), audience: str('Who would watch, e.g. "Gen Z students in Metro Manila"'),
  voice: str('How this persona writes: language mix, tone, emoji habits, recurring phrases.'),
  examples: strs('3 to 5 original example captions in this persona’s voice and language.'),
  avoid: strs('Content this persona never does.'),
  refs: strs('2 or 3 YouTube video ids (11 characters) from your search results that best show the kind of content this persona makes. They become its picture.'),
};
const CREATE_TOOLS = [
  SEARCH_TOOLS[0],
  CHAT_TOOLS.find((t) => t.function.name === 'browser'),
  fn('create_persona', 'Create the persona the user described. Ends your turn.', PERSONA_FIELDS),
  CHAT_TOOLS.find((t) => t.function.name === 'reply'),
];
const CREATE_SYSTEM = `You are Arche. The user is telling you what kind of content creator they want to become.
Turn that into a persona they can grow into.

First ground it in what works right now; the user watches the browser live.
Use "search" 2 or 3 times (when: "week") for that niche and its typical formats. If they name a creator or paste a YouTube channel link,
use the browser tool to open its /shorts page and run ["links"].
Then call create_persona, with 2 or 3 of the video ids you saw as its picture. Take what makes those creators work (formats, hooks, voice), never their identity or content.
Write the example captions yourself, in the language and slang the user writes in (e.g. Taglish if they do).
If the description is too vague to make anything good, call reply with one short question instead.
TikTok, Instagram and Reddit block this browser: do not visit them. Never try to get past a CAPTCHA or login wall.`;

function system(a, p) {
  a ||= { region: 'WW', regionName: 'Worldwide' };
  const region = a.region || 'WW', geo = region === 'WW' ? 'US' : region;
  const where = region === 'WW' ? 'worldwide (use US data as the biggest market, and global YouTube)' : a.regionName;
  return `You are Arche's trend scout. A creator has chosen who they want to be (a persona) and posts as that persona on one account.
Your job is to find what's viral right now that THIS persona would post.

Account: ${a.name ? `${a.name} on ${a.platform || 'short video'}` : 'not on an account yet'}
Persona: ${p.name}${p.tagline ? `, ${p.tagline}` : ''}
Niche: ${p.niche || 'not set'}
Audience: ${p.audience || 'not set'}
Voice: ${p.voice || 'not set'}
Country: ${where}
Example captions in this persona's voice (copy this voice):
${(p.examples || []).map((e) => `- ${e}`).join('\n') || '- none yet'}
Never: ${(p.avoid || []).join('; ') || 'nothing listed'}

Find what is going viral RIGHT NOW that THIS persona can actually post, and turn it into ready-to-shoot short-video templates.
Match, don't force. A trend only counts if it fits the persona's niche and audience. A format trend (a POV setup, a sound, a structure)
can work across niches, but then write a NEW idea for this persona, not the original video with different text.
If nothing fits, say so and submit no templates. Put trends you rejected in "skipped" with a short reason.

HOW TO FIND TRENDS: a deep search, not a single search. A trend is many creators adopting the same thing right now.
A single popular video is not a trend, and anything older than two weeks is not evidence of a trend.
1. Fan out: run "search" 6 to 10 times with when: "week". Mix the niche's words with the shapes trends take
   ("pov", "but make it", "ranking", "storytime", "day in my life", "challenge", "trend", "transition", "outfit check", "rate my"),
   in English and in the language this persona posts in. Short queries work best.
2. Read the trend board in each search result: patterns shared by several fresh videos, with videos, creators and views per hour.
3. Follow the thread on the 3 to 5 strongest patterns: "hashtag" for hashtag patterns (how many videos and channels use it),
   "search" with when: "today" to see if it is still picking up, and "inspect" on its fastest video to learn the format and the sound.
4. "judge" each one you followed: confirmed (many creators, fresh, still picking up) or dropped (too old, too small, one creator only, or wrong for this persona).
5. Then submit_templates from the confirmed patterns only, setting "pattern" on each template and using the pattern's videos as references.
   Quote the real numbers in "trend": creators, videos this week, views per hour. Momentum: rising if it is still picking up today,
   peaking if it is big but slowing, saturated if it is everywhere and old.
You also have the "browser" tool for anything else (e.g. Google Trends: https://trends.google.com/trending?geo=${geo}&hours=48, read with "get text main").
TikTok, Instagram and Reddit block this browser: do not visit them. Never try to get past a CAPTCHA or login wall; move on.

For follow-ups ("make #2 shorter", "more like the first one") you usually don't need the browser: revise and call submit_templates again.
When the user states a lasting preference about the persona, call update_persona, then continue.
Each template is a format the creator reshoots with their own face and voice, never a copy of someone's video.
List the YouTube ids it is based on in "references". Write text and captions in the language and slang this persona posts in.`;
}

// ---------- one chat turn: the agent browses and answers ----------
const busy = new Set();
const UPLOADED = { today: 'EgIIAg%253D%253D', week: 'EgIIAw%253D%253D', month: 'EgIIBA%253D%253D' }; // YouTube's upload-date filter
async function turn(thread, text, emit) {
  const account = thread.accountId ? await load('accounts', thread.accountId).catch(() => null) : null;
  let persona = thread.personaId ? await load('personas', thread.personaId).catch(() => null) : null;
  const prompt = () => (persona ? system(account, persona) : CREATE_SYSTEM);
  const shots = path.join(DATA, 'shots', thread.id);
  await fs.mkdir(shots, { recursive: true });
  const session = 't' + thread.id;
  let live = null, browse = null;
  const add = async (item) => { thread.items.push(item); thread.updated = Date.now(); await save('threads', thread); };
  // Each step's screenshot is the live frame, saved again when the next step starts, once the page has settled. Costs no waiting.
  const stamp = Date.now().toString(36); // unique per turn, so later turns don't overwrite earlier screenshots
  const snap = async () => {
    const step = browse?.steps.at(-1), frame = live?.latest();
    if (!step || !frame) return;
    const name = `${stamp}-${browse.steps.length}.jpg`;
    await fs.writeFile(path.join(shots, name), Buffer.from(frame, 'base64'));
    step.shot = `/shots/${thread.id}/${name}`;
  };
  const endBrowse = async () => { if (browse) { await snap(); await add(browse); browse = null; } };
  // One visible step in the live browser. The cursor needs the element's box for clicks, so look it up first.
  const step = async (note, args, run) => {
    if (!browse) { browse = { type: 'browse', steps: [], found: [], board: [] }; emit({ type: 'browse' }); }
    if (!live) live = await liveBrowser(session, emit);
    await snap(); // the previous step's page, now settled
    const [cmd, sel] = args;
    const box = ['click', 'fill'].includes(cmd) && typeof sel === 'string' ? await boxOf(session, sel) : null;
    const st = { note, args, shot: null, ...(box && { box }) };
    emit({ type: 'step', n: browse.steps.length + 1, ...st });
    const out = await run(st);
    st.url = live.url(); browse.steps.push(st);
    return out;
  };
  // Collects the videos on the current page with exact numbers, shows them, and updates the trend board.
  const pool = new Map(); // every video seen this turn
  // `source` is the search or hashtag that surfaced these videos: a search is never evidence for its own words.
  const collect = (note, source = '') => step(note, ['links'], async (st) => {
    let cards = await cardsOf(session);
    for (let i = 0; i < 6 && !cards.length; i++) { await new Promise((r) => setTimeout(r, 500)); cards = await cardsOf(session); } // results still rendering
    st.boxes = cards.filter((c) => c.box).slice(0, 14).map(({ id, box: [x, y, w, h] }) => ({ id, x, y, w, h }));
    const fresh = await exact(cards.filter((c) => !pool.has(c.id)));
    for (const v of fresh) pool.set(v.id, { ...v, via: [] });
    if (source) for (const c of cards) pool.get(c.id)?.via.push(source);
    const items = fresh.map(({ id, title, stats, vph, ageH, views, channel }) => ({ id, title, stats, vph, ageH, views, channel }));
    browse.found.push(...items.slice(0, Math.max(0, 60 - browse.found.length)));
    emit({ type: 'found', items, boxes: st.boxes });
    updateBoard();
    return { cards: cards.map((c) => pool.get(c.id) || c), fresh: fresh.length };
  });
  // What the agent reads after collecting: the fastest fresh videos, then the trend board.
  const listing = ({ cards, fresh }) => {
    const sorted = [...cards].sort((a, b) => (a.ageH > FRESH_HOURS) - (b.ageH > FRESH_HOURS) || (b.vph || 0) - (a.vph || 0));
    return `${cards.length} videos (${fresh} new to you):\n${sorted.slice(0, 14).map(videoLine).join('\n')}\n\nTrend board (patterns across everything you've collected):\n`
      + (board.size ? [...board.values()].map((e) => patternLine(e, e)).join('\n') : '- nothing yet: patterns need 3+ fresh videos. Search more.');
  };
  // The trend board: patterns found so far, and the agent's verdicts on them.
  const board = new Map();
  const mark = (key, change) => { board.set(key, { key, status: 'checking', ...(board.get(key) || {}), ...change }); updateBoard(); };
  function updateBoard() {
    const found = patternsOf([...pool.values()]);
    for (const [key, e] of board) if (e.status === 'checking' && !e.reach && !found.some((p) => p.key === key)) board.delete(key);
    for (const p of found) board.set(p.key, { status: 'checking', ...(board.get(p.key) || {}), ...p });
    // Keep it readable: everything judged, plus the strongest few still being checked.
    const checking = [...board.values()].filter((e) => e.status === 'checking').sort((a, b) => (b.score || 0) - (a.score || 0));
    for (const e of checking.slice(6)) if (!e.reach) board.delete(e.key);
    if (browse) {
      browse.board = [...board.values()].map(({ key, name, status, reason, reach, videos, week, channels, medianVph, ids }) => ({ key, name, status, reason, reach, videos, week, channels, medianVph, ids: (ids || []).slice(0, 4) }));
      emit({ type: 'board', board: browse.board });
    }
  }

  await add({ type: 'user', text });
  if (!thread.llm.length || thread.llm[0].role !== 'system') thread.llm.unshift({ role: 'system', content: '' });
  thread.llm[0].content = prompt(); // always the latest account and persona
  thread.llm.push({ role: 'user', content: text });
  try {
    for (let round = 1; round <= MAX_STEPS; round++) {
      if (round === MAX_STEPS) thread.llm.push({ role: 'user', content: 'Out of time. Call submit_templates or reply now with what you have.' });
      const msg = await openai(thread.llm, persona ? CHAT_TOOLS : CREATE_TOOLS);
      thread.llm.push(msg);
      let ended = false;
      for (const call of msg.tool_calls || []) {
        const input = JSON.parse(call.function.arguments || '{}');
        const name = call.function.name;
        let out = 'Shown to the user.';
        if (name === 'browser') {
          const [cmd] = input.args || [];
          out = cmd === 'links' && Array.isArray(input.args) ? listing(await collect(input.note, live?.url() || 'page')) : await step(input.note, input.args, () => browser(session, input.args));
        } else if (name === 'search') {
          const when = ['today', 'week', 'month'].includes(input.when) ? input.when : 'week';
          const q = String(input.query || '').slice(0, 100);
          await step(input.note || `Searching "${q}"`, ['open', `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&sp=${UPLOADED[when]}`], (st) => browser(session, st.args));
          const got = await collect(`Collecting ${when === 'today' ? "today's" : `this ${when}'s`} videos for "${q}"`, q);
          out = `Searched "${q}" (uploaded ${when === 'today' ? 'today' : 'this ' + when}).\n` + listing(got);
        } else if (name === 'hashtag') {
          const tag = String(input.tag || '').replace(/^#/, '').replace(/[^\p{L}\p{N}_]/gu, '').slice(0, 60);
          await step(input.note || `Opening #${tag}`, ['open', `https://www.youtube.com/hashtag/${encodeURIComponent(tag)}`], (st) => browser(session, st.args));
          const reach = (await ab(session, ['eval', REACH_JS]).then((o) => { try { return JSON.parse(JSON.parse(o)); } catch { return ''; } })).split('\n').find((l) => /videos/.test(l)) || '';
          if (reach) mark('#' + tag.toLowerCase(), { reach });
          const got = await collect(`Reading who uses #${tag}`, tag);
          out = `#${tag}: ${reach || 'no reach shown'}.\n` + listing(got);
        } else if (name === 'inspect') {
          const id = String(input.id || '').slice(0, 11);
          if (!/^[\w-]{11}$/.test(id)) out = 'Give an 11-character video id.';
          else {
            await step(input.note || 'Watching the fastest video', ['open', `https://www.youtube.com/shorts/${id}`], (st) => browser(session, st.args));
            const v = pool.get(id) || withPageData({ id, title: '', views: null, ageH: null }, await pageData(id));
            const page = await pageData(id);
            out = page ? `${videoLine({ ...v, ...withPageData(v, page) })}\nTags: ${page.tags.join(', ') || 'none'}\nDescription: ${page.description || 'none'}` : 'Could not read that video.';
          }
        } else if (name === 'judge') {
          const key = String(input.pattern || '').replace(/^\[|\]$/g, '');
          mark(key, { status: input.status === 'confirmed' ? 'confirmed' : 'dropped', name: String(input.name || '').slice(0, 80), reason: String(input.reason || '').slice(0, 160) });
          out = 'Noted on the trend board.';
        } else if (name === 'update_persona') {
          if (input.avoid?.length) persona.avoid = [...new Set([...(persona.avoid || []), ...input.avoid])];
          if (input.voice) persona.voice = input.voice;
          await save('personas', persona);
          thread.llm[0].content = prompt();
          const item = { type: 'persona', text: input.note };
          await add(item); emit(item);
          out = 'Saved.';
        } else if (name === 'create_persona' && !persona) {
          await endBrowse();
          const lines = (v, n) => (Array.isArray(v) ? v : []).map((x) => String(x).slice(0, 300)).filter(Boolean).slice(0, n);
          persona = { id: newId(), refs: lines(input.refs, 3).filter((r) => /^[\w-]{11}$/.test(r)), starter: false, created: Date.now(), avoid: lines(input.avoid, 12), examples: lines(input.examples, 8),
            ...Object.fromEntries(['name', 'tagline', 'niche', 'audience', 'voice'].map((k) => [k, String(input[k] || '').slice(0, k === 'voice' ? 800 : 300)])) };
          persona.name ||= 'New persona';
          await save('personas', persona);
          thread.personaId = persona.id; thread.title = persona.name;
          thread.llm[0].content = prompt();
          const item = { type: 'newpersona', personaId: persona.id };
          await add(item); emit({ ...item, persona });
          out = 'Created and shown to the user.';
          ended = true; // the card itself asks what's next
        } else if (name === 'submit_templates' || name === 'reply') {
          await endBrowse();
          const item = name === 'reply' ? { type: 'reply', text: input.text }
            : { type: 'templates', message: input.message, templates: input.templates || [], skipped: input.skipped || [] };
          await add(item); emit(item);
          ended = true;
        } else out = 'Unknown tool.';
        thread.llm.push({ role: 'tool', tool_call_id: call.id, content: out });
      }
      if (ended) return;
    }
    throw new Error('The agent ran out of steps without an answer.');
  } catch (e) {
    await endBrowse();
    const item = { type: 'error', text: e.message };
    await add(item); emit(item);
  } finally {
    // Old page dumps only cost tokens on later turns; keep the gist.
    for (const m of thread.llm) if (m.role === 'tool' && m.content.length > 1500) m.content = m.content.slice(0, 1500) + '…';
    await save('threads', thread);
    await live?.close();
  }
}

// ---------- http ----------
const thumbs = new Map(); // shortcut: unbounded in-memory cache, fine for a demo; add eviction if it runs for days
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.svg': 'image/svg+xml' };
function sse(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  return (ev) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(ev)}\n\n`); }; // late live frames can arrive after the turn ends
}
const json = (res, body) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
async function body(req) {
  let s = ''; for await (const c of req) { s += c; if (s.length > 1e5) throw new Error('Body too large'); }
  return JSON.parse(s || '{}');
}
const clip = (v, n = 400) => String(v ?? '').slice(0, n);
const clips = (v, n = 12) => (Array.isArray(v) ? v : []).map((x) => clip(x, 300)).filter(Boolean).slice(0, n);

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname, [, api, kind, id, action] = p.split('/');
  try {
    if (api === 'api' && kind === 'personas' && !id) {
      if (req.method === 'POST') {
        const b = await body(req);
        const persona = {
          id: ID.test(b.id || '') ? b.id : newId(), name: clip(b.name, 80) || 'Untitled persona', tagline: clip(b.tagline, 200),
          niche: clip(b.niche), audience: clip(b.audience), voice: clip(b.voice, 800), examples: clips(b.examples), avoid: clips(b.avoid),
          refs: clips(b.refs, 4).filter((r) => /^[\w-]{11}$/.test(r)), starter: !!b.starter, created: Number(b.created) || Date.now(),
          // a preset's reel: the YouTube Short its tile plays on hover
          ...(/^[\w-]{11}$/.test(b.video?.id || '') && { video: { id: b.video.id, start: Math.max(0, Number(b.video.start) || 0), ...(Number(b.video.end) > 0 && { end: Number(b.video.end) }), ...(/^\/posters\/[\w-]+\.(png|jpe?g)$/.test(b.video.poster || '') && { poster: b.video.poster }), tags: clips(b.video.tags, 4) } }),
        };
        await save('personas', persona);
        return json(res, persona);
      }
      return json(res, (await list('personas')).sort((a, b) => a.starter - b.starter || a.created - b.created));
    }
    if (api === 'api' && kind === 'personas' && id && req.method === 'GET') {
      // A persona's profile: the persona, plus every set of templates made for it, newest first.
      const persona = await load('personas', id);
      const made = (await list('threads')).filter((t) => t.personaId === id).sort((a, b) => b.updated - a.updated)
        .flatMap((t) => t.items.filter((it) => it.type === 'templates' && it.templates.length).reverse()
          .map((it) => ({ threadId: t.id, title: t.title, templates: it.templates })));
      return json(res, { persona, made });
    }
    if (api === 'api' && kind === 'accounts' && !id) {
      if (req.method === 'POST') {
        const b = await body(req);
        await load('personas', b.personaId); // one persona per account, and it must exist
        const account = {
          id: ID.test(b.id || '') ? b.id : newId(), name: clip(b.name, 80) || 'Untitled account', platform: clip(b.platform, 30) || 'TikTok',
          region: /^[A-Z]{2}$/.test(b.region) ? b.region : 'WW', regionName: clip(b.regionName, 60) || 'Worldwide', personaId: b.personaId, sample: !!b.sample,
        };
        await save('accounts', account);
        return json(res, account);
      }
      return json(res, (await list('accounts')).sort((a, b) => a.name.localeCompare(b.name)));
    }
    if (api === 'api' && kind === 'threads') {
      if (!id && req.method === 'POST') {
        const b = await body(req);
        // With an account, the thread scouts for its persona. Without one, the first message describes a new persona.
        const account = b.accountId ? await load('accounts', b.accountId) : null;
        // A preset can start a thread on its own, with no account: research begins right away.
        const preset = !account && ID.test(b.personaId || '') ? await load('personas', b.personaId).catch(() => null) : null;
        const thread = { id: newId(), accountId: account?.id || null, personaId: account?.personaId || preset?.id || null, title: clip(b.title, 80) || 'New thread', created: Date.now(), updated: Date.now(), items: [], llm: [] };
        await save('threads', thread);
        return json(res, thread);
      }
      if (!id) return json(res, (await list('threads')).map(({ llm, items, ...t }) => t).sort((a, b) => b.updated - a.updated));
      if (action === 'bind' && req.method === 'POST') {
        const thread = await load('threads', id), account = await load('accounts', (await body(req)).accountId);
        if (account.personaId !== thread.personaId) throw new Error('That account posts as a different persona.');
        thread.accountId = account.id; await save('threads', thread);
        return json(res, { ok: true });
      }
      if (action === 'say' && req.method === 'POST') {
        const text = clip((await body(req)).text, 2000).trim();
        if (!text) throw new Error('Say something first.');
        if (busy.has(id)) throw new Error('This thread is still working.');
        busy.add(id);
        const emit = sse(res);
        try { await turn(await load('threads', id), text, emit); } finally { busy.delete(id); }
        emit({ type: 'done' });
        return res.end();
      }
      if (req.method === 'DELETE') { await fs.rm(file('threads', id)); await fs.rm(path.join(DATA, 'shots', id), { recursive: true, force: true }); return json(res, { ok: true }); }
      const { llm, ...t } = await load('threads', id);
      return json(res, t);
    }
    if (p === '/api/thumb') {
      // Same-origin YouTube thumbnails, so the reel canvas can be exported as video. Vertical Shorts frame first.
      const vid = url.searchParams.get('id') || '';
      if (!/^[\w-]{11}$/.test(vid)) throw Object.assign(new Error('bad id'), { code: 'ENOENT' });
      if (!thumbs.has(vid)) thumbs.set(vid, (async () => {
        for (const f of ['oar2', 'hq720', 'hqdefault']) {
          const r = await fetch(`https://i.ytimg.com/vi/${vid}/${f}.jpg`);
          if (r.ok) return Buffer.from(await r.arrayBuffer());
        }
        return null;
      })().catch(() => null));
      const img = await thumbs.get(vid);
      if (!img) { thumbs.delete(vid); throw Object.assign(new Error('no thumb'), { code: 'ENOENT' }); }
      res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'max-age=86400' });
      return res.end(img);
    }
    // Static files from public/ and data/shots/, with no path escapes.
    const base = p.startsWith('/shots/') ? DATA : path.join(ROOT, 'public');
    const f = path.join(base, path.normalize(decodeURIComponent(p === '/' ? '/index.html' : p)));
    if (!f.startsWith(base)) throw Object.assign(new Error('bad path'), { code: 'ENOENT' });
    const data = await fs.readFile(f);
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
    res.end(data);
  } catch (e) {
    if (res.headersSent) return res.end(`data: ${JSON.stringify({ type: 'error', text: e.message })}\n\n`);
    res.writeHead(e.code === 'ENOENT' ? 404 : 400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: e.code === 'ENOENT' ? 'Not found' : e.message }));
  }
}).listen(PORT, () => console.log(`Arche on http://localhost:${PORT}`));

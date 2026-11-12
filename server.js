// Persona Studio: a creator picks who they want to be (a persona), and an agent browses public trend sources with agent-browser
// to find what's viral that fits that persona, then turns it into video templates. OpenAI decides what to do. One file, no framework.
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const run = promisify(execFile);
const ROOT = import.meta.dirname;
const DATA = path.join(ROOT, 'data');
const AB = path.join(ROOT, 'node_modules/agent-browser/bin/agent-browser.js');
const MODEL = process.env.OPENAI_MODEL || 'gpt-5-mini';
const MAX_STEPS = Number(process.env.MAX_STEPS || 18);
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

// The fixed page script behind the "links" command: lists the YouTube videos on the current page.
const LINKS_JS = `JSON.stringify([...new Map([...document.querySelectorAll('a[href*="/shorts/"],a[href*="watch?v="]')]
  .map(a => [(a.href.match(/(?:shorts\\/|v=)([\\w-]{11})/) || [])[1], (a.getAttribute('aria-label') || a.title || a.textContent || '').trim().replace(/\\s+/g, ' ')])
  .filter(([id, t]) => id && t.length > 12)).entries()].slice(0, 25).map(([id, t]) => id + ' | ' + t.slice(0, 160)).join('\\n'))`;

function browser(session, args) {
  if (!Array.isArray(args) || !ALLOWED.has(args[0])) return `Command not allowed. Use one of: ${[...ALLOWED].join(', ')}`;
  if (args[0] === 'open' && !/^https?:\/\//.test(args[1] || '')) return 'open needs an http(s) URL';
  if (args[0] === 'links') return links(session);
  return ab(session, args);
}
const links = (session) => ab(session, ['eval', LINKS_JS]).then((o) => { try { return JSON.parse(JSON.parse(o)); } catch { return o; } });

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
  let latest = null, ws = null;
  try {
    const port = JSON.parse((await ab(session, ['stream', 'status', '--json'])).match(/\{.*\}/s)[0]).data.port;
    ws = new WebSocket(`ws://127.0.0.1:${port}/?maxFps=12`);
    ws.onmessage = (m) => {
      const e = JSON.parse(m.data);
      if (e.type === 'frame') { latest = e.data; emit({ type: 'frame', data: e.data }); }
      if (e.type === 'url') emit({ type: 'url', url: e.url });
    };
    ws.onerror = () => {};
  } catch { /* no stream: the agent still works, the user just sees step notes */ }
  return {
    latest: () => latest,
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
  },
  required: ['title', 'trend', 'fit', 'momentum', 'days_left', 'format', 'duration_s', 'hook', 'beats', 'caption', 'hashtags', 'audio', 'sources', 'references'],
};

const CHAT_TOOLS = [
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
  refs: strs('2 or 3 YouTube video ids (11 characters) from your ["links"] output that best show the kind of content this persona makes. They become its picture.'),
};
const CREATE_TOOLS = [
  CHAT_TOOLS[0],
  fn('create_persona', 'Create the persona the user described. Ends your turn.', PERSONA_FIELDS),
  CHAT_TOOLS[2],
];
const CREATE_SYSTEM = `You are Persona Studio. The user is telling you what kind of content creator they want to become.
Turn that into a persona they can grow into.

First take 2 to 5 browser steps to ground it in what works right now; the user watches the browser live.
Search YouTube Shorts in that niche (https://www.youtube.com/results?search_query=<niche>+shorts) and run ["links"],
or, if they name a creator or paste a YouTube channel link, open its /shorts page and run ["links"].
Then call create_persona, with 2 or 3 of the video ids you saw as its picture. Take what makes those creators work (formats, hooks, voice), never their identity or content.
Write the example captions yourself, in the language and slang the user writes in (e.g. Taglish if they do).
If the description is too vague to make anything good, call reply with one short question instead.
TikTok, Instagram and Reddit block this browser: do not visit them. Never try to get past a CAPTCHA or login wall.`;

function system(a, p) {
  a ||= { region: 'WW', regionName: 'Worldwide' };
  const region = a.region || 'WW', geo = region === 'WW' ? 'US' : region;
  const where = region === 'WW' ? 'worldwide (use US data as the biggest market, and global YouTube)' : a.regionName;
  return `You are Persona Studio's trend scout. A creator has chosen who they want to be (a persona) and posts as that persona on one account.
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

You control a real browser with the "browser" tool (agent-browser CLI). The user watches it live, so open real pages. Good public sources:
- Google Trends, trending now: https://trends.google.com/trending?geo=${geo}&hours=48  (read with: get text main)
- YouTube search: https://www.youtube.com/results?search_query=<topic>+shorts${region === 'WW' ? '' : `+${a.regionName.replace(/\s+/g, '+')}`}
  add &sp=CAM%253D to sort by views, or &sp=CAISAhgB for newest uploads. If a page says "No results", drop the filter.
- YouTube hashtag Shorts: https://www.youtube.com/hashtag/<tag>/shorts
TikTok, Instagram and Reddit block this browser: do not visit them. Never try to get past a CAPTCHA or login wall; move on.

Work fast: about 6-12 browser calls for a fresh scout. Prefer "get text main" or "snapshot -i -c" over clicking around.
On YouTube result pages run ["links"] to get video ids and titles. Note view counts and dates as evidence.
For follow-ups ("make #2 shorter", "more like the first one") you usually don't need the browser: revise and call submit_templates again.
When the user states a lasting preference about the persona, call update_persona, then continue.
Each template is a format the creator reshoots with their own face and voice, never a copy of someone's video.
List the YouTube ids it is based on in "references". Write text and captions in the language and slang this persona posts in.`;
}

// ---------- one chat turn: the agent browses and answers ----------
const busy = new Set();
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

  await add({ type: 'user', text });
  if (!thread.llm.length || thread.llm[0].role !== 'system') thread.llm.unshift({ role: 'system', content: '' });
  thread.llm[0].content = prompt(); // always the latest account and persona
  thread.llm.push({ role: 'user', content: text });
  try {
    for (let step = 1; step <= MAX_STEPS; step++) {
      if (step === MAX_STEPS) thread.llm.push({ role: 'user', content: 'Out of time. Call submit_templates or reply now with what you have.' });
      const msg = await openai(thread.llm, persona ? CHAT_TOOLS : CREATE_TOOLS);
      thread.llm.push(msg);
      let ended = false;
      for (const call of msg.tool_calls || []) {
        const input = JSON.parse(call.function.arguments || '{}');
        const name = call.function.name;
        let out = 'Shown to the user.';
        if (name === 'browser') {
          if (!browse) { browse = { type: 'browse', steps: [] }; emit({ type: 'browse' }); }
          if (!live) live = await liveBrowser(session, emit);
          await snap(); // the previous step's page, now settled
          emit({ type: 'step', n: browse.steps.length + 1, note: input.note, args: input.args });
          out = await browser(session, input.args);
          browse.steps.push({ note: input.note, args: input.args, shot: null });
          await snap();
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
        };
        await save('personas', persona);
        return json(res, persona);
      }
      return json(res, (await list('personas')).sort((a, b) => a.starter - b.starter || a.created - b.created));
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
        const thread = { id: newId(), accountId: account?.id || null, personaId: account?.personaId || null, title: clip(b.title, 80) || 'New thread', created: Date.now(), updated: Date.now(), items: [], llm: [] };
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
}).listen(PORT, () => console.log(`Persona Studio on http://localhost:${PORT}`));

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

function system(a, p) {
  const region = a.region || 'WW', geo = region === 'WW' ? 'US' : region;
  const where = region === 'WW' ? 'worldwide (use US data as the biggest market, and global YouTube)' : a.regionName;
  return `You are Persona Studio's trend scout. A creator has chosen who they want to be (a persona) and posts as that persona on one account.
Your job is to find what's viral right now that THIS persona would post.

Account: ${a.name} on ${a.platform || 'short video'}
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
  const account = await load('accounts', thread.accountId);
  const persona = await load('personas', account.personaId);
  const shots = path.join(DATA, 'shots', thread.id);
  await fs.mkdir(shots, { recursive: true });
  const session = 't' + thread.id;
  let live = null, browse = null;
  const add = async (item) => { thread.items.push(item); thread.updated = Date.now(); await save('threads', thread); };

  await add({ type: 'user', text });
  if (!thread.llm.length || thread.llm[0].role !== 'system') thread.llm.unshift({ role: 'system', content: '' });
  thread.llm[0].content = system(account, persona); // always the latest account and persona
  thread.llm.push({ role: 'user', content: text });
  try {
    for (let step = 1; step <= MAX_STEPS; step++) {
      if (step === MAX_STEPS) thread.llm.push({ role: 'user', content: 'Out of time. Call submit_templates or reply now with what you have.' });
      const msg = await openai(thread.llm, CHAT_TOOLS);
      thread.llm.push(msg);
      let ended = false;
      for (const call of msg.tool_calls || []) {
        const input = JSON.parse(call.function.arguments || '{}');
        const name = call.function.name;
        let out = 'Shown to the user.';
        if (name === 'browser') {
          if (!browse) { browse = { type: 'browse', steps: [] }; emit({ type: 'browse' }); }
          if (!live) live = await liveBrowser(session, emit);
          const n = browse.steps.length + 1;
          emit({ type: 'step', n, note: input.note, args: input.args });
          out = await browser(session, input.args);
          const frame = live.latest();
          if (frame) await fs.writeFile(path.join(shots, `${n}.jpg`), Buffer.from(frame, 'base64'));
          browse.steps.push({ note: input.note, args: input.args, shot: frame ? `/shots/${thread.id}/${n}.jpg` : null });
          emit({ type: 'shot', n, src: browse.steps.at(-1).shot });
        } else if (name === 'update_persona') {
          if (input.avoid?.length) persona.avoid = [...new Set([...(persona.avoid || []), ...input.avoid])];
          if (input.voice) persona.voice = input.voice;
          await save('personas', persona);
          thread.llm[0].content = system(account, persona);
          const item = { type: 'persona', text: input.note };
          await add(item); emit(item);
          out = 'Saved.';
        } else if (name === 'submit_templates' || name === 'reply') {
          if (browse) { await add(browse); browse = null; }
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
    if (browse) await add(browse);
    const item = { type: 'error', text: e.message };
    await add(item); emit(item);
  } finally {
    // Old page dumps only cost tokens on later turns; keep the gist.
    for (const m of thread.llm) if (m.role === 'tool' && m.content.length > 1500) m.content = m.content.slice(0, 1500) + '…';
    await save('threads', thread);
    await live?.close();
  }
}

// ---------- drafting a persona from creators you want to be like ----------
const oembed = (u) => fetch(u).then((r) => (r.ok ? r.json() : null)).catch(() => null);
async function draftPersona(input, emit) {
  const found = [], notes = [];
  const session = 'p' + newId();
  let live = null;
  try {
    for (const raw of input.links.slice(0, 8)) {
      let u; try { u = new URL(raw); } catch { continue; }
      const h = u.hostname.replace(/^(www|m)\./, '');
      if (h === 'youtube.com' && /^\/(@|channel\/|c\/)/.test(u.pathname)) {
        // A channel: open its Shorts tab in the live browser and read the titles.
        if (!live) live = await liveBrowser(session, emit);
        const page = `https://www.youtube.com${u.pathname.split('/').slice(0, u.pathname.startsWith('/@') ? 2 : 3).join('/')}/shorts`;
        emit({ type: 'step', note: `Reading ${u.pathname.split('/')[1]}'s Shorts`, args: ['open', page] });
        await ab(session, ['open', page]);
        await ab(session, ['wait', '1500']);
        const out = await links(session);
        for (const line of String(out).split('\n').slice(0, 15)) {
          const [id, title] = line.split(' | ');
          if (title) found.push({ platform: 'youtube', id, title: title.replace(/ - play Short$/, '') });
        }
      } else if (h === 'youtube.com' || h === 'youtu.be') {
        emit({ type: 'step', note: 'Reading a YouTube video' });
        const o = await oembed(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(u.href)}`);
        if (o) found.push({ platform: 'youtube', id: (u.href.match(/(?:shorts\/|v=|youtu\.be\/)([\w-]{11})/) || [])[1], title: o.title, author: o.author_name });
      } else if (h === 'tiktok.com' && u.pathname.includes('/video/')) {
        emit({ type: 'step', note: 'Reading a TikTok video' });
        const o = await oembed(`https://www.tiktok.com/oembed?url=${encodeURIComponent(u.href)}`);
        if (o?.title) found.push({ platform: 'tiktok', title: o.title, author: o.author_name, thumb: o.thumbnail_url });
        else notes.push('One TikTok link had no public caption. Paste its caption instead.');
      } else notes.push(`Can't read ${h} pages${h.includes('tiktok') || h.includes('instagram') ? ' (they block automated browsers). Paste video links or captions instead' : ''}.`);
    }
  } finally { await live?.close(); }

  const captions = String(input.captions || '').split('\n').map((s) => s.trim()).filter(Boolean);
  const examples = [...captions, ...found.map((f) => f.title)].slice(0, 8);
  const draft = { examples, refs: found.filter((f) => f.id).slice(0, 4).map((f) => f.id) };
  if (!examples.length && !input.idea) return emit({ type: 'draft', draft, notes: [...notes, 'Found nothing to read. Fill the fields in yourself.'] });

  emit({ type: 'step', note: 'Writing the persona' });
  try {
    const msg = await openai([
      { role: 'system', content: 'A creator wants to become a certain kind of content creator. From the videos and captions of creators they look up to, write the persona they want to be: what makes those creators work (formats, hooks, voice), as a direction of their own. Take the formula, never the identity or the content. Be specific and plain.' },
      { role: 'user', content: JSON.stringify({ videos: found, captions, idea: input.idea || '' }) },
    ], [fn('persona', 'The persona.', {
      name: str('A short persona name, e.g. "Budget fashion big sister". Not a real person\'s name.'),
      tagline: str('Who the creator wants to be, in one line, e.g. "the friend who makes 200-peso outfits look expensive".'),
      niche: str('e.g. "budget home cooking"'), audience: str('Who would watch, e.g. "Gen Z students in Metro Manila"'),
      voice: str('How this persona writes: language mix, tone, emoji habits, recurring phrases.'),
      avoid: strs('Content this persona never does.'),
    })], { type: 'function', function: { name: 'persona' } });
    Object.assign(draft, JSON.parse(msg.tool_calls[0].function.arguments));
  } catch (e) { notes.push(e.message.includes('OPENAI_API_KEY') ? 'Captions were read, but writing the persona needs an OpenAI key. Fill the rest in yourself.' : e.message); }
  emit({ type: 'draft', draft, notes });
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
    if (p === '/api/personas/draft' && req.method === 'POST') {
      const b = await body(req);
      const emit = sse(res);
      await draftPersona({ links: clips(b.links, 8), captions: clip(b.captions, 4000), idea: clip(b.idea, 400) }, emit);
      return res.end();
    }
    if (api === 'api' && kind === 'threads') {
      if (!id && req.method === 'POST') {
        const b = await body(req);
        await load('accounts', b.accountId); // must exist
        const thread = { id: newId(), accountId: b.accountId, title: clip(b.title, 80) || 'New thread', created: Date.now(), updated: Date.now(), items: [], llm: [] };
        await save('threads', thread);
        return json(res, thread);
      }
      if (!id) return json(res, (await list('threads')).map(({ llm, items, ...t }) => t).sort((a, b) => b.updated - a.updated));
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

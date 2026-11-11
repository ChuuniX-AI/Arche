// Ad Guy: an agent browses public trend sources with agent-browser, OpenAI decides what to do,
// and the result is a set of viral video templates. One file, no framework.
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

const run = promisify(execFile);
const ROOT = import.meta.dirname;
const RUNS = path.join(ROOT, 'runs');
const AB = path.join(ROOT, 'node_modules/agent-browser/bin/agent-browser.js');
const MODEL = process.env.OPENAI_MODEL || 'gpt-5-mini';
const MAX_STEPS = Number(process.env.MAX_STEPS || 18);
const PORT = Number(process.env.PORT || 5173);

// Only page-reading and navigation commands. No eval, cookies, storage or downloads.
const ALLOWED = new Set(['links', 'open', 'snapshot', 'click', 'fill', 'press', 'scroll', 'get', 'back', 'wait', 'find']);

// The fixed page script behind the "links" command: lists the YouTube videos on the current page.
const LINKS_JS = `JSON.stringify([...new Map([...document.querySelectorAll('a[href*="/shorts/"],a[href*="watch?v="]')]
  .map(a => [(a.href.match(/(?:shorts\\/|v=)([\\w-]{11})/) || [])[1], (a.getAttribute('aria-label') || a.title || a.textContent || '').trim().replace(/\\s+/g, ' ')])
  .filter(([id, t]) => id && t.length > 12)).entries()].slice(0, 25).map(([id, t]) => id + ' | ' + t.slice(0, 160)).join('\\n'))`;

function system(region, regionName) {
  const geo = region === 'WW' ? 'US' : region;
  const where = region === 'WW' ? 'worldwide (use US data as the biggest market, and global YouTube)' : regionName;
  return `You are Ad Guy, a trend scout for a content team that runs many creator accounts.
Goal: find what is going viral RIGHT NOW in ${where} for the user's niche, then turn it into ready-to-shoot short-video templates.

You control a real browser with the "browser" tool (agent-browser CLI). Good public sources:
- Google Trends, trending now: https://trends.google.com/trending?geo=${geo}&hours=48  (read with: get text main)
- YouTube search: https://www.youtube.com/results?search_query=<topic>+shorts${region === 'WW' ? '' : `+${regionName.replace(/\s+/g, '+')}`}
  add &sp=CAM%253D to sort by views, or &sp=CAISAhgB for newest uploads. If a page says "No results", drop the filter.
- YouTube hashtag Shorts: https://www.youtube.com/hashtag/<tag>/shorts
TikTok, Instagram and Reddit block this browser: do not visit them. Never try to get past a CAPTCHA or login wall; move on.

Work fast: about 6-12 browser calls. Use "get text main" or "snapshot -i -c" to read pages; prefer text over clicking around.
On YouTube result pages run ["links"] to get video ids with titles and view counts.
Look for repeated formats, hooks, sounds and topics with high views and recent upload dates. Note view counts and dates as evidence.

Finish by calling submit_templates with 3 to 4 templates. Each template is a format a creator can reshoot with their own face and voice,
not a copy of someone's video. For each, list the YouTube video ids it is based on in "references" (from the links output; 1-3 ids).
Write on-screen text and captions in the language and slang people in ${where} actually post in (e.g. Taglish for the Philippines).`;
}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'browser',
      description: 'Run one agent-browser command. Examples: ["open","https://..."], ["get","text","main"], ["snapshot","-i","-c"], ["click","@e12"], ["scroll","down","1500"], ["back"], ["links"] (YouTube video ids, titles and views on this page).',
      parameters: {
        type: 'object',
        properties: {
          note: { type: 'string', description: 'One short sentence shown to the user, e.g. "Checking what Filipinos searched in the last 48 hours".' },
          args: { type: 'array', items: { type: 'string' } },
        },
        required: ['note', 'args'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'submit_templates',
      description: 'Finish the run with the viral video templates.',
      parameters: {
        type: 'object',
        properties: {
          templates: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', description: 'Short punchy template name, e.g. "POV: tita sees your outfit"' },
                trend: { type: 'string', description: 'What is going viral and the evidence (views, dates, search growth).' },
                momentum: { type: 'string', enum: ['rising', 'peaking', 'saturated'] },
                days_left: { type: 'number', description: 'Rough days before the trend feels overdone.' },
                format: { type: 'string', description: 'e.g. POV skit, reaction, list, before/after, storytime' },
                duration_s: { type: 'number' },
                hook: { type: 'string', description: 'The on-screen line for the first 2 seconds.' },
                beats: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      t: { type: 'string', description: 'e.g. "0-2s"' },
                      shot: { type: 'string', description: 'What the camera sees / what the creator does.' },
                      text: { type: 'string', description: 'On-screen text, empty if none.' },
                    },
                    required: ['t', 'shot', 'text'],
                  },
                },
                caption: { type: 'string' },
                hashtags: { type: 'array', items: { type: 'string' } },
                audio: { type: 'string', description: 'Sound suggestion (trending audio name or style).' },
                sources: { type: 'array', items: { type: 'string' }, description: 'URLs you saw as evidence.' },
                references: { type: 'array', items: { type: 'string' }, description: '1-3 YouTube video ids (11 characters) this template is based on.' },
              },
              required: ['title', 'trend', 'momentum', 'days_left', 'format', 'duration_s', 'hook', 'beats', 'caption', 'hashtags', 'audio', 'sources', 'references'],
            },
          },
        },
        required: ['templates'],
      },
    },
  },
];

// What the model may run.
function browser(session, args) {
  if (!Array.isArray(args) || !ALLOWED.has(args[0])) return `Command not allowed. Use one of: ${[...ALLOWED].join(', ')}`;
  if (args[0] === 'open' && !/^https?:\/\//.test(args[1] || '')) return 'open needs an http(s) URL';
  if (args[0] === 'links') return ab(session, ['eval', LINKS_JS]).then((o) => { try { return JSON.parse(JSON.parse(o)); } catch { return o; } });
  return ab(session, args);
}

// Unrestricted, for the server's own screenshot/url/close calls.
async function ab(session, args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [AB, '--session', session, ...args.map(String)], { timeout: 45000, maxBuffer: 8e6 });
    return (stdout + stderr).slice(0, 7000) || 'ok';
  } catch (e) {
    return `Error: ${(e.stdout || '') + (e.stderr || e.message)}`.slice(0, 2000);
  }
}

async function openai(messages) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model: MODEL, messages, tools: TOOLS, tool_choice: 'required' }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()).choices[0].message;
}

// Runs the agent and calls emit(event) for each step. Every event is also saved, so the run can be replayed.
async function scout({ niche, region, regionName }, emit) {
  const id = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(RUNS, id);
  await fs.mkdir(dir, { recursive: true });
  const session = `scout-${id.slice(-10).replace(/\W/g, '')}`;
  const log = [];
  const send = async (ev) => { log.push(ev); emit(ev); await fs.writeFile(path.join(dir, 'events.json'), JSON.stringify({ niche, region, regionName, events: log })); };

  await send({ type: 'start', id, niche, region, regionName, max: MAX_STEPS });
  const messages = [
    { role: 'system', content: system(region, regionName) },
    { role: 'user', content: `Niche: ${niche}. Region: ${regionName}. Find what's viral now and make templates.` },
  ];
  try {
    if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set. Add it to .env and restart.');
    for (let step = 1; step <= MAX_STEPS; step++) {
      const last = step === MAX_STEPS;
      if (last) messages.push({ role: 'user', content: 'Out of browsing time. Call submit_templates now with what you have.' });
      const msg = await openai(messages);
      messages.push(msg);
      for (const call of msg.tool_calls || []) {
        const input = JSON.parse(call.function.arguments || '{}');
        if (call.function.name === 'submit_templates') {
          await send({ type: 'templates', templates: input.templates || [] });
          return;
        }
        await send({ type: 'step', step, note: input.note, args: input.args });
        const out = await browser(session, input.args);
        const shot = `shot-${step}.png`;
        await ab(session, ['screenshot', path.join(dir, shot)]);
        const exists = await fs.stat(path.join(dir, shot)).then(() => true, () => false);
        await send({ type: 'shot', step, src: exists ? `/runs/${id}/${shot}` : null, url: (await ab(session, ['get', 'url'])).trim() });
        messages.push({ role: 'tool', tool_call_id: call.id, content: out });
      }
    }
    throw new Error('The agent ran out of steps without templates.');
  } catch (e) {
    await send({ type: 'error', message: e.message });
  } finally {
    await ab(session, ['close']);
  }
}

const thumbs = new Map(); // shortcut: unbounded in-memory cache, fine for a demo; add eviction if it runs for days
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml' };

function sse(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  return (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/api/scout') {
      const emit = sse(res);
      const region = /^[A-Z]{2}$/.test(url.searchParams.get('region')) ? url.searchParams.get('region') : 'WW';
      const regionName = (url.searchParams.get('regionName') || 'Worldwide').slice(0, 60);
      await scout({ niche: (url.searchParams.get('niche') || 'anything').slice(0, 120), region, regionName }, emit);
      return res.end();
    }
    if (url.pathname === '/api/runs') {
      const ids = (await fs.readdir(RUNS).catch(() => [])).sort().reverse();
      const runs = [];
      for (const id of ids) {
        const data = JSON.parse(await fs.readFile(path.join(RUNS, id, 'events.json'), 'utf8').catch(() => 'null'));
        if (data?.events.some((e) => e.type === 'templates')) runs.push({ id, niche: data.niche, regionName: data.regionName });
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(runs));
    }
    if (url.pathname === '/api/thumb') {
      // Same-origin YouTube thumbnails, so the reel canvas can be exported as video. Vertical Shorts frame first.
      const id = url.searchParams.get('id') || '';
      if (!/^[\w-]{11}$/.test(id)) throw Object.assign(new Error('bad id'), { code: 'ENOENT' });
      if (!thumbs.has(id)) thumbs.set(id, (async () => {
        for (const f of ['oar2', 'hq720', 'hqdefault']) {
          const r = await fetch(`https://i.ytimg.com/vi/${id}/${f}.jpg`);
          if (r.ok) return Buffer.from(await r.arrayBuffer());
        }
        return null;
      })().catch(() => null));
      const img = await thumbs.get(id);
      if (!img) { thumbs.delete(id); throw Object.assign(new Error('no thumb'), { code: 'ENOENT' }); }
      res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'max-age=86400' });
      return res.end(img);
    }
    if (url.pathname === '/api/replay') {
      // Plays a saved run back at demo speed, so a flaky site can't break the stage demo.
      const id = path.basename(url.searchParams.get('id') || '');
      const { events } = JSON.parse(await fs.readFile(path.join(RUNS, id, 'events.json'), 'utf8'));
      const emit = sse(res);
      for (const ev of events) {
        emit(ev);
        await new Promise((r) => setTimeout(r, ev.type === 'shot' ? 1600 : ev.type === 'step' ? 700 : 300));
      }
      return res.end();
    }
    // Static files from public/ and runs/, with no path escapes.
    const base = url.pathname.startsWith('/runs/') ? ROOT : path.join(ROOT, 'public');
    const file = path.join(base, path.normalize(decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)));
    if (!file.startsWith(base)) throw Object.assign(new Error('bad path'), { code: 'ENOENT' });
    const body = await fs.readFile(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch (e) {
    if (!res.headersSent) res.writeHead(e.code === 'ENOENT' ? 404 : 500);
    res.end(e.code === 'ENOENT' ? 'Not found' : String(e.message));
  }
}).listen(PORT, () => console.log(`Ad Guy on http://localhost:${PORT}`));

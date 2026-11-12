// Deep search helpers: read YouTube result cards, apply the date rule, and find patterns that many creators share.
// Pure functions, so they can be tested without a browser.

// The page script behind collecting videos: each result card's id, raw text, channel and on-screen box.
// Parsing happens in Node (parseCard), so this script stays free of regexes.
export const CARDS_JS = `(() => {
  const out = [], seen = new Set();
  for (const a of document.querySelectorAll('a[href*="/shorts/"],a[href*="watch?v="]')) {
    const id = (a.href.split('/shorts/')[1] || a.href.split('v=')[1] || '').slice(0, 11);
    if (id.length !== 11 || seen.has(id)) continue;
    const card = a.closest('ytm-shorts-lockup-view-model, ytm-shorts-lockup-view-model-v2, ytd-video-renderer, ytd-rich-item-renderer, ytd-reel-item-renderer, ytd-grid-video-renderer, ytd-compact-video-renderer');
    if (!card) continue;
    seen.add(id);
    const ch = card.querySelector('ytd-channel-name a, #channel-name a, a[href^="/@"]');
    const r = card.getBoundingClientRect();
    const box = r.width > 20 && r.bottom > 0 && r.top < innerHeight ? [r.x, r.y, r.width, r.height].map(Math.round) : null;
    out.push({ id, text: (card.innerText || '').slice(0, 600), channel: ch ? ch.textContent.trim() : '', box });
    if (out.length >= 30) break;
  }
  return JSON.stringify(out);
})()`;

// A hashtag page's reach line, e.g. "5.3M videos • 862K channels".
export const REACH_JS = `JSON.stringify(((document.querySelector('yt-page-header-renderer, ytd-hashtag-header-renderer, #page-header') || {}).innerText || '').slice(0, 200))`;

// A video page: title, channel, date line, description and the first comments.
export const VIDEO_JS = `JSON.stringify({
  title: (document.querySelector('h1') || {}).innerText || document.title,
  channel: ((document.querySelector('#owner ytd-channel-name a, ytd-channel-name a') || {}).textContent || '').trim(),
  info: ((document.querySelector('#info-container, #info') || {}).innerText || '').slice(0, 200),
  description: ((document.querySelector('#description-inline-expander, ytd-text-inline-expander, #description') || {}).innerText || '').slice(0, 700),
  comments: [...document.querySelectorAll('ytd-comment-thread-renderer #content-text')].slice(0, 8).map((c) => c.innerText.slice(0, 200)),
})`;

const UNITS = { k: 1e3, m: 1e6, b: 1e9 };
export const num = (s) => { const m = String(s).replace(/,/g, '').match(/([\d.]+)\s*([kmb])?/i); return m ? Math.round(parseFloat(m[1]) * (UNITS[m[2]?.toLowerCase()] || 1)) : null; };
const HOURS = { s: 1 / 3600, sec: 1 / 3600, second: 1 / 3600, m: 1 / 60, min: 1 / 60, minute: 1 / 60, h: 1, hr: 1, hour: 1, d: 24, day: 24, w: 168, wk: 168, week: 168, mo: 720, month: 720, y: 8760, yr: 8760, year: 8760 };
// "4d ago", "4 days ago", "1y ago", "12 hours ago" -> hours
export const ageHours = (s) => { const m = String(s).match(/(\d+)\s*(seconds?|sec|minutes?|min|hours?|hr|days?|weeks?|wk|months?|mo|years?|yr|[smhdwy])\s+ago/i); return m ? +m[1] * HOURS[m[2].toLowerCase().replace(/s$/, '')] : null; };
export const fmt = (n) => (n == null ? '?' : n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'K' : String(Math.round(n)));
export const FRESH_HOURS = 24 * 14; // the date rule: only videos from the last two weeks count toward a trend

// One result card -> { id, title, views, ageH, vph, channel, stats }
export function parseCard({ id, text = '', channel = '' }) {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l && !/^(new|shorts|now playing|live|4k|cc|hd)$/i.test(l) && !/^\d+:\d+(:\d+)?$/.test(l));
  let views = null, ageH = null, viewsText = '', ageText = '';
  for (const l of lines) {
    if (views == null) { const v = l.match(/([\d.,]+\s*[KMB]?)\s*views?\b/i) || l.match(/^([\d.,]+\s*[KMB]?)(?:\s*[·•/]|$)/i); if (v) { views = num(v[1]); viewsText = v[1].replace(/\s+/g, ''); } }
    if (ageH == null) { const a = l.match(/\d+\s*\w+\s+ago/i); if (a) { ageH = ageHours(a[0]); ageText = a[0]; } }
  }
  const isMeta = (l) => /\bviews?\b/i.test(l) || /\bago\b/i.test(l) || /^[\d.,]+\s*[KMB]?$/i.test(l) || l === channel;
  const title = lines.filter((l) => !isMeta(l)).sort((a, b) => b.length - a.length)[0] || '';
  const vph = views != null && ageH != null ? Math.round(views / Math.max(ageH, 1)) : null;
  const stats = [viewsText && `${viewsText} views`, ageText].filter(Boolean).join(' · ');
  return { id, title: title.slice(0, 160), views, ageH, vph, channel: channel.slice(0, 60), stats };
}

// A video page's own data (the same public page a browser shows): exact publish time, views, channel, the creator's tags.
export function videoFromHtml(html) {
  const pick = (re) => (html.match(re) || [])[1];
  const str = (s) => { try { return JSON.parse(`"${s}"`); } catch { return s || ''; } };
  const published = Date.parse(pick(/"publishDate":"([^"]+)"/) || pick(/"uploadDate":"([^"]+)"/) || '');
  const views = pick(/"viewCount":"(\d+)"/);
  if (Number.isNaN(published) && views == null) return null;
  const description = str(pick(/"shortDescription":"((?:[^"\\]|\\.)*)"/));
  const keywords = (pick(/"keywords":\[((?:"(?:[^"\\]|\\.)*",?)*)\]/) || '').match(/"(?:[^"\\]|\\.)*"/g)?.map((k) => str(k.slice(1, -1)).toLowerCase()) || [];
  return {
    published: Number.isNaN(published) ? null : published, views: views == null ? null : +views,
    channel: str(pick(/"ownerChannelName":"((?:[^"\\]|\\.)*)"/)), seconds: +(pick(/"lengthSeconds":"(\d+)"/) || 0),
    description: description.slice(0, 600), tags: [...new Set([...keywords, ...(description.match(/#[\p{L}\p{N}_]+/gu) || []).map((t) => t.toLowerCase())])].slice(0, 25),
  };
}
// Merges a video page's data into a harvested card: exact age and views per hour.
export function withPageData(v, page, now = Date.now()) {
  if (!page) return v;
  const views = page.views ?? v.views, ageH = page.published ? Math.max((now - page.published) / 36e5, 0.1) : v.ageH;
  const stats = [views != null && `${fmt(views)} views`, ageH != null && (ageH < 48 ? `${Math.round(ageH)}h ago` : `${Math.round(ageH / 24)}d ago`)].filter(Boolean).join(' · ');
  return { ...v, views, ageH, vph: views != null && ageH != null ? Math.round(views / Math.max(ageH, 1)) : v.vph, channel: page.channel || v.channel,
    tags: page.tags, seconds: page.seconds, description: page.description, stats, exact: !!page.published };
}

// The line the agent reads for one video.
export const videoLine = (v) => `${v.id} | ${v.title} | ${v.views != null ? fmt(v.views) + ' views' : '? views'} | ${v.ageH != null ? Math.round(v.ageH / 24 * 10) / 10 + 'd old' : 'age unknown'}`
  + `${v.vph != null ? ` | ${fmt(v.vph)}/hr` : ''}${v.channel ? ` | ${v.channel}` : ''}${v.ageH != null && v.ageH > FRESH_HOURS ? ' | OLD, not evidence of a trend' : ''}`;

// Tags that say nothing about a specific trend: platform tags, and broad categories (a category is not a trend).
const GENERIC_TAGS = new Set(('shorts short fyp foryou foryoupage viral trending trend trends trendingshorts trendingnow youtubeshorts ytshorts explore explorepage reels '
  + 'tiktok viralvideo viralshorts viralreels shortsviral shortsfeed shortvideo shortsvideo subscribe youtube video videos fypシ new 2025 2026 '
  + 'funny comedy fashion style ootd outfit outfits outfitideas outfitinspo food foodie cooking recipe fitness gym workout beauty makeup skincare '
  + 'music dance vlog lifestyle travel motivation love life philippines pinoy filipino').split(' '));
// A search can't be evidence for its own words: videos found by searching "outfit check" don't count toward "outfit check".
const squash = (s) => String(s).toLowerCase().replace(/[#\s]/g, '');
export const independent = (v, key) => !v.via?.length || v.via.some((src) => !squash(src).includes(squash(key)));
const STOP = new Set(("the a an and or of to in on for with my your our is are was were be been this that these those it its i you me we he she they them his her at by from so but not no yes do does did just how what when why who whos which there here as if than then too very can will would should could all any some more most new best top vs "
  + "ang ng sa na mga si ni ko mo ka ako ikaw siya kami tayo sila po yung lang din rin pa ba naman ito iyan dito kung pag para may wala").split(' '));
const words = (t) => t.toLowerCase().replace(/#[\p{L}\p{N}_]+/gu, ' ').replace(/[^\p{L}\p{N}' ]+/gu, ' ').split(/\s+/).filter((w) => w.length > 1);

// Patterns shared by several fresh videos: hashtags and repeated 2-3 word phrases in titles.
// A pattern needs at least `min` fresh videos. Score favours many videos, fast views and recency.
export function patternsOf(videos, { min = 3, limit = 8 } = {}) {
  const fresh = videos.filter((v) => v.ageH != null && v.ageH <= FRESH_HOURS && !(v.seconds > 180)); // Shorts only
  const groups = new Map();
  for (const v of fresh) {
    const keys = new Set();
    for (const t of v.title.match(/#[\p{L}\p{N}_]+/gu) || []) { const k = t.toLowerCase(); if (!GENERIC_TAGS.has(k.slice(1))) keys.add(k); }
    // The creator's own tags: hashtags stay hashtags, multi-word tags count as phrases.
    for (const t of v.tags || []) {
      const k = t.trim();
      if (k.startsWith('#') ? GENERIC_TAGS.has(k.slice(1)) : (GENERIC_TAGS.has(k) || !k.includes(' ') || /^[\d\s]+$/.test(k))) continue;
      keys.add(k.length > 40 ? k.slice(0, 40) : k);
    }
    const w = words(v.title);
    for (let n = 2; n <= 3; n++) for (let i = 0; i + n <= w.length; i++) {
      const g = w.slice(i, i + n);
      if (STOP.has(g[0]) || STOP.has(g[n - 1]) || g.every((x) => /^\d+$/.test(x))) continue;
      keys.add(g.join(' '));
    }
    for (const k of keys) {
      if (!independent(v, k)) continue;
      if (!groups.has(k)) groups.set(k, new Set());
      groups.get(k).add(v.id);
    }
  }
  const byId = new Map(videos.map((v) => [v.id, v]));
  const found = [...groups].filter(([, ids]) => ids.size >= min).map(([key, ids]) => {
    const vs = [...ids].map((id) => byId.get(id)).sort((a, b) => (b.vph || 0) - (a.vph || 0));
    const rates = vs.map((v) => v.vph || 0).sort((a, b) => a - b), median = rates[rates.length >> 1];
    const week = vs.filter((v) => v.ageH <= 168).length, channels = new Set(vs.map((v) => v.channel).filter(Boolean)).size;
    return { key, videos: vs.length, week, channels, medianVph: median, ids: vs.map((v) => v.id), score: vs.length * Math.log10(median + 10) * (0.5 + week / vs.length) };
  }).sort((a, b) => b.score - a.score);
  // A phrase that only repeats part of a bigger pattern with the same videos adds nothing.
  const kept = [];
  for (const p of found) {
    const dup = kept.some((k) => p.ids.every((id) => k.ids.includes(id)) && (k.key.includes(p.key) || p.key.includes(k.key) || p.ids.length === k.ids.length));
    if (!dup) kept.push(p);
    if (kept.length >= limit) break;
  }
  return kept;
}

export const patternLine = (p, entry) => `- [${p.key}] ${p.videos} fresh videos (${p.week} this week)${p.channels ? `, ${p.channels} known creators` : ''}, median ${fmt(p.medianVph)} views/hr`
  + `${entry?.reach ? `, hashtag reach: ${entry.reach}` : ''}${entry?.status && entry.status !== 'checking' ? `, you marked it ${entry.status}` : ''}`;

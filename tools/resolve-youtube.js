#!/usr/bin/env node
/* Resolve YouTube video IDs for every track by scraping search results.
   Usage:
     node tools/resolve-youtube.js              # resolve all missing
     node tools/resolve-youtube.js --force      # re-resolve everything
     node tools/resolve-youtube.js --only cat   # only ids containing "cat"
   Writes data/yt-ids.json  (trackId -> {videoId, title, channel, duration, query, embeddable}) */
'use strict';
const fs = require('fs');
const path = require('path');
const { loadTracks } = require('./load-tracks');

const ROOT = path.resolve(__dirname, '..');
const P = (...s) => path.join(ROOT, ...s);
const OUT = P('data', 'yt-ids.json');

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const ONLY = (() => { const i = args.indexOf('--only'); return i >= 0 ? args[i + 1] : null; })();
const LIMIT = (() => { const i = args.indexOf('--limit'); return i >= 0 ? parseInt(args[i + 1], 10) : Infinity; })();
const CONCURRENCY = 3;
const DELAY_MS = 700;      // pace requests; YouTube throttles bursts
const ARTIST = 'ANRI';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

const store = (() => {
  try { return JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) { return {}; }
})();

/* ---------- collect the work list ---------- */
const { tracks: allTracks } = loadTracks();
const tasks = [];
for (const t of allTracks) {
  if (ONLY && !t.id.includes(ONLY) && !t.title.toLowerCase().includes(ONLY.toLowerCase())) continue;
  if (!FORCE && store[t.id]) continue;
  tasks.push(t);
}

if (!tasks.length) {
  console.log(`  Nothing to do — ${Object.keys(store).length} entries already resolved.`);
  console.log('  Use --force to re-resolve, or --only <filter> to target specific tracks.\n');
  process.exit(0);
}

const limited = tasks.slice(0, LIMIT);
console.log(`\n  Resolving ${limited.length} track(s) via YouTube search  (${FORCE ? 'forced' : 'only missing'}, concurrency ${CONCURRENCY})\n`);

/* ---------- helpers ---------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* Extract the ordered list of video renderers from the search page. */
function parseSearch(html) {
  const m = html.match(/var ytInitialData\s*=\s*(\{.+?\});<\/script>/s);
  if (!m) return null;
  let data;
  try { data = JSON.parse(m[1]); } catch (e) { return null; }

  const out = [];
  const seen = new Set();
  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    const vr = node.videoRenderer;
    if (vr && vr.videoId && !seen.has(vr.videoId)) {
      seen.add(vr.videoId);
      out.push({
        videoId: vr.videoId,
        title: (vr.title && (vr.title.runs || []).map(r => r.text).join('')) || vr.title?.simpleText || '',
        channel: (vr.ownerText && (vr.ownerText.runs || []).map(r => r.text).join('')) || vr.longBylineText?.runs?.map(r => r.text).join('') || '',
        length: parseLength(vr.lengthText?.simpleText || ''),
        isLive: !!vr.badges?.some?.(b => (b.metadataBadgeRenderer?.style || '') === 'BADGE_STYLE_TYPE_LIVE_NOW')
      });
    }
    if (node.compactVideoRenderer?.videoId && !seen.has(node.compactVideoRenderer.videoId)) {
      seen.add(node.compactVideoRenderer.videoId);
      out.push({ videoId: node.compactVideoRenderer.videoId, title: '', channel: '', length: 0, isLive: false });
    }
    for (const k of Object.keys(node)) walk(node[k]);
  })(data);
  return out;
}

function parseLength(s) {
  if (!s) return 0;
  const m = s.match(/(\d+):(\d+)/);
  if (!m) return 0;
  return (+m[1]) * 60 + (+m[2]);
}

async function searchYouTube(query) {
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&hl=en&gl=US`;
  let lastErr = 'unreachable';
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9'
        },
        signal: AbortSignal.timeout(25000)
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const html = await res.text();
      const vids = parseSearch(html);
      if (vids && vids.length) return vids;
      lastErr = 'no results parsed';
      await sleep(2000 * (attempt + 1));
    } catch (err) {
      lastErr = err.message;
      // back off harder for network-level failures (connection throttling)
      await sleep(1500 * (attempt + 1) + Math.floor(1500 * (attempt + 1) * Math.random()));
    }
  }
  return { error: lastErr };
}

/* Note on embeddability:
   Scraping youtube.com/embed/<id> is NOT a reliable signal. Its
   `previewPlayabilityStatus` reports ERROR for essentially every request from a
   plain server-side fetch (bot detection), even for videos that play perfectly
   in a real browser — verified directly with the YT.Player API.

   So we do NOT pre-filter on embeddability. A track is marked embeddable unless
   the app's own onError handler proves otherwise at runtime, which is the only
   trustworthy check available outside a browser. */
async function checkEmbeddable() {
  return { embeddable: true };
}

/* Rank candidates. Strongly prefers the artist's own channels — a compilation
   channel or a random cover can rank first in YouTube's results and is often
   not even embeddable, while the official upload is both correct and playable. */
const OFFICIAL = /(anri|杏里)/i;
const OFFICIAL_CHANNELS = /(anri\s*杏里\s*official|anri\s*-\s*topic|杏里\s*公式|anri\s*official|universal\s*music\s*japan|for\s*life|avex|ivy\s*records)/i;
const DISTRACT = /(cover|tribute|remix\s*by|dj|mix\s*20|medley|reaction|cover\s*by|inst\.|instrumental|remix)/i;
/* The discography entries describe the studio release, so a live/cover/tribute
   take is the wrong answer even when it comes from the official channel. */
const NOT_STUDIO = /(\blive\b|ライブ|acoustic|unplugged|orchestra|symphon|tribute|cover|remaster|\d{4}\s*live|concert|hall|pacifico|nhk|ymphony)/i;

function scoreCandidate(v, task) {
  if (v.isLive) return -1;
  if (v.length && v.length < 90) return -1;          // < 1.5 min is a clip, not a track

  const title = v.title || '';
  const chan = v.channel || '';
  const hay = (title + ' ' + chan).toLowerCase();
  const want = task.title.toLowerCase();

  // how much of the track title appears in the video title / channel
  const tokens = want.split(/[^a-z0-9]+/).filter(t => t.length > 2);
  let hit = 0;
  for (const t of tokens) if (hay.includes(t)) hit++;
  const ratio = tokens.length ? hit / tokens.length : 0;
  if (ratio < 0.5) return -1;

  let score = ratio;

  // the artist's own channel is the strongest positive signal
  if (OFFICIAL_CHANNELS.test(chan)) score += 1.5;
  if (/\banri\b/i.test(chan) || chan.includes('杏里')) score += 1.0;
  if (/\- Topic$/i.test(chan)) score += 0.8;          // official auto-generated uploads

  // penalise non-studio takes
  if (NOT_STUDIO.test(title)) score -= 1.5;
  if (DISTRACT.test(title)) score -= 1.2;
  if (/^(\[?lyrics?\]?|.*full\s*album\s*video)/i.test(title.trim())) score -= 0.8;
  if (v.length && v.length < 150 && !/\btopics?\b/i.test(chan)) score -= 0.4;

  // the artist name should be in the video title too
  if (OFFICIAL.test(title)) score += 0.2;

  return score;
}

/* Fetch the real title/channel. Best-effort: never fails the resolution. */
async function fetchMeta(videoId) {
  try {
    const res = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent('https://www.youtube.com/watch?v=' + videoId)}&format=json`, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(12000)
    });
    if (!res.ok) return {};
    const j = await res.json();
    return { title: j.title, channel: j.author_name };
  } catch (e) { return {}; }
}

async function resolveOne(task) {
  const query = `${task.title} ${ARTIST}`;
  const r = await searchYouTube(query);
  if (r.error) return { id: task.id, error: r.error };
  if (!r.length) return { id: task.id, error: 'no results' };

  // Rank candidates by title/channel match, dropping live streams and clips.
  const ranked = r
    .map(v => ({ v, s: scoreCandidate(v, task) }))
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map(x => x.v);
  const best = ranked[0] || r[0];
  const meta = await fetchMeta(best.videoId);

  return {
    id: task.id,
    videoId: best.videoId,
    title: meta.title || best.title,
    channel: meta.channel || best.channel,
    duration: best.length,
    query,
    embeddable: true
  };
}

/* ---------- run the pool ---------- */
(async () => {
  let done = 0, ok = 0, failed = 0, notEmbeddable = 0;
  let lastLog = 0;

  async function worker() {
    while (limited.length) {
      const task = limited.shift();
      let res;
      try { res = await resolveOne(task); }
      catch (e) { res = { id: task.id, error: e.message }; }

      done++;
      if (res.error) { failed++; console.log(`  ✗ ${res.id}  ${task.title}  (${res.error})`); }
      else {
        store[res.id] = res;
        ok++;
        if (res.embeddable === false) { notEmbeddable++; console.log(`  ⊘ ${res.id}  ${task.title}  → ${res.videoId}  [not embeddable]`); }
        else if (done % 10 === 0 || done - lastLog < 3) {
          console.log(`  ✓ ${res.id}  ${task.title}  → ${res.videoId}  (${res.duration ? Math.floor(res.duration / 60) + 'm' : '?'})`);
        }
        lastLog = done;
      }

      // checkpoint after every result so a crash never loses work
      if (done % 5 === 0 || !limited.length) fs.writeFileSync(OUT, JSON.stringify(store, null, 1));
      await sleep(DELAY_MS);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  fs.writeFileSync(OUT, JSON.stringify(store, null, 1));

  const total = Object.keys(store).length;
  console.log(`\n  Resolved ${ok}/${done}  ·  ${failed} failed  ·  ${notEmbeddable} not embeddable`);
  console.log(`  data/yt-ids.json now holds ${total} entries\n`);
})();

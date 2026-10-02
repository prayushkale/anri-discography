#!/usr/bin/env node
/* Fetch album/single cover art for every release in the discography.
   Writes data/covers.json  (releaseId -> { url, source, title })

   Source: the iTunes Search API. It is the only art source tested that returns
   real, correct Japanese-catalog artwork for Anri (Cover Art Archive has nothing
   filed for her releases, and Wikipedia only has artist photos).

   Correctness matters more than coverage: a wrong cover on a discography slide
   is worse than no cover. So a candidate is accepted only when the artist name
   matches AND the title matches on a normalised form AND the release year is
   within one year. Anything else is rejected and left artless.

   Usage:
     node tools/fetch-covers.js            # only releases still missing art
     node tools/fetch-covers.js --force    # re-fetch everything
     node tools/fetch-covers.js --only cat # only ids/titles matching "cat"   */
'use strict';
const fs = require('fs');
const path = require('path');
const { loadTracks } = require('./load-tracks');

const ROOT = path.resolve(__dirname, '..');
const P = (...s) => path.join(ROOT, ...s);
const OUT = P('data', 'covers.json');

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const ONLY = (() => { const i = args.indexOf('--only'); return i >= 0 ? args[i + 1] : null; })();

const store = (() => {
  try { return JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) { return {}; }
})();

/* ---------- normalisation, so "Feelin'" == "Feelin’" == "feelin" ---------- */
const WA = 'ʻ'; // okina
function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[’'`´‘]/g, "'")
    .replace(/[・･]/g, ' ')
    .replace(/[‐-―−-]/g, '-')   // dashes -> hyphen
    .replace(/[ー～〜]/g, '')         // kana prolong marks
    .replace(/[\s　]+/g, '')
    .replace(/[()（）「」『』,.!?:;'"~・]/g, '');
}
function jaNorm(s) { return String(s || '').replace(/[\s　ー～〜!-/:-@[-`{-~]/g, ''); }

/* ---------- title similarity ---------- */
function tokens(s) {
  return String(s || '').toLowerCase()
    .split(/[^a-z0-9]+/).filter(t => t.length > 1 && !/^(the|a|an|of|and|to|in|no|ni|wo|wa)$/.test(t));
}

/* Does the candidate collection name plausibly correspond to our release?
   Returns 0..1, or -1 to reject outright. */
function titleScore(ours, theirs) {
  const a = norm(ours), b = norm(theirs);
  if (!a || !b) return -1;
  if (a === b) return 1;
  if (b.includes(a) || a.includes(b)) return 0.9;

  const ta = tokens(ours), tb = tokens(theirs);
  if (ta.length && tb.length) {
    const setB = new Set(tb);
    const hit = ta.filter(t => setB.has(t)).length;
    const r = hit / ta.length;
    if (r >= 0.99) return 1;
    if (r >= 0.7) return 0.8;
    // single distinctive word match (e.g. "Timely" vs "Timely!!")
    if (ta.length === 1 && setB.has(ta[0])) return 0.85;
    if (r > 0) return 0.5;
  }
  return -1;
}

const isAnri = c => /anri|杏里/i.test(c || '');

/* ---------- iTunes search ---------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* The iTunes endpoint rate-limits aggressively by IP and answers with a plain
   text "Rate limit has been exceeded" body. Back off and retry rather than
   silently recording the miss, which would look identical to "no such album". */
let throttleUntil = 0;
async function itunes(term, kind, country) {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}` +
    `&entity=${kind}&limit=25&country=${country}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const wait = throttleUntil - Date.now();
    if (wait > 0) await sleep(Math.min(wait, 30000));
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      const body = await res.text();
      if (body.startsWith('Rate limit') || res.status === 403 || res.status === 429) {
        throttleUntil = Date.now() + (attempt === 0 ? 12000 : 45000);
        continue;
      }
      if (!res.ok) return [];
      return (JSON.parse(body).results) || [];
    } catch (e) {
      await sleep(2000 * (attempt + 1));
    }
  }
  return [];
}

const yearOf = r => r.releaseDate ? parseInt(String(r.releaseDate).slice(0, 4), 10) : 0;

/* Prefer the highest-resolution artwork iTunes will serve. */
function bestArt(res) {
  const u = res.artworkUrl100;
  if (!u) return null;
  const m = u.match(/\/100x100bb\.(jpg|png)$/);
  return m ? u.replace(/\/100x100bb\./, '/600x600bb.') : u;
}

/* Cache per release id so --force doesn't re-hit the API for identical work. */
async function searchFor(rel) {
  const queries = [];
  const ja = rel.titleJa && rel.titleJa.replace(/^杏里\s*/, '').trim();
  if (ja) queries.push(ja);
  if (rel.title) queries.push(rel.title);
  queries.push((rel.title || '') + ' anri');

  // Every query is searched and the results pooled: a single query often
  // returns a page of the artist's catalogue without the release we want, so
  // stopping at the first non-empty result would lose good matches.
  const kinds = ['album', 'song'];
  const seen = new Set();
  const out = [];
  for (const q of queries) {
    for (const kind of kinds) {
      for (const r of await itunes(q, kind, 'JP')) {
        const key = r.collectionId || (r.trackId || '') + (r.trackName || '');
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(r);
      }
    }
  }
  return out;
}

const isAlbumType = t => /Studio album|Compilation|Live album|Cover album|Self-cover album/.test(t);

function pickBest(cands, rel) {
  const ourYear = rel.year;
  const ja = rel.titleJa && rel.titleJa.replace(/^杏里\s*/, '').trim();
  let best = null, bestScore = 0;

  for (const c of cands) {
    if (!isAnri(c.artistName)) continue;
    const coll = c.collectionName || '';
    const track = c.trackName || '';
    if (!coll && !track) continue;

    const collScore = coll ? titleScore(rel.title, coll) : -1;
    const trackScore = track ? titleScore(rel.title, track) : -1;
    let score;

    if (isAlbumType(rel.type)) {
      // an album must be identified by its own collection, never by a track on it
      if (collScore < 0) continue;
      score = collScore;
    } else {
      // A single's artwork lives on its own single release, so the track name is
      // the real identity. Falling back to the parent album's art is allowed —
      // that album really did contain this single — but it scores far lower, so
      // any genuine single release wins. Without this split, a title like
      // "Eternity" happily matched an unrelated compilation because the album
      // happened to share a track name.
      if (trackScore >= 0) {
        score = trackScore + 0.2;
      } else if (collScore >= 0) {
        score = collScore - 0.4;
      } else continue;
    }

    // the Japanese title is a strong independent confirmation
    if (ja) {
      const na = jaNorm(ja);
      const hit = [coll, track].some(n => {
        if (!n) return false;
        const nb = jaNorm(n);
        return nb && (nb === na || nb.includes(na) || na.includes(nb));
      });
      if (hit) score += 0.15;
    }

    if (score > bestScore) { bestScore = score; best = c; }
  }
  if (!best) return null;

  const by = yearOf(best);
  if (by && Math.abs(by - ourYear) > 1) return null;
  return best;
}

/* ---------- run ---------- */
(async () => {
  const { discog } = loadTracks();
  const jobs = [];
  for (const y of discog.years) {
    for (const rel of y.releases) {
      rel.year = y.year;
      if (ONLY && !rel.id.includes(ONLY) && !(rel.title || '').toLowerCase().includes(ONLY.toLowerCase())) continue;
      if (!FORCE && store[rel.id]) continue;
      jobs.push(rel);
    }
  }
  if (!jobs.length) {
    console.log(`  Nothing to do — ${Object.keys(store).length} release(s) already have art.`);
    console.log('  Use --force to re-fetch, or --only <filter> to target specific releases.\n');
    process.exit(0);
  }

  console.log(`\n  Fetching cover art for ${jobs.length} release(s)  (${FORCE ? 'forced' : 'only missing'})\n`);
  let found = 0, missed = 0;
  const misses = [];

  for (const rel of jobs) {
    const cands = await searchFor(rel);
    const best = pickBest(cands, rel);
    if (best) {
      store[rel.id] = {
        url: bestArt(best),
        title: best.collectionName || best.trackName || '',
        year: yearOf(best) || null,
        source: 'itunes'
      };
      found++;
      console.log(`  ✓ ${rel.id.padEnd(36)} → ${(best.collectionName || best.trackName || '').slice(0, 34)}  (${store[rel.id].year})`);
    } else {
      store[rel.id] = { url: null, urlReason: 'no confident match', title: null };
      missed++;
      misses.push(rel);
      console.log(`  ✗ ${rel.id.padEnd(36)}   ${rel.title}`);
    }
    if (found % 5 === 0) fs.writeFileSync(OUT, JSON.stringify(store, null, 1));
    await new Promise(r => setTimeout(r, 350));   // be polite to the API
  }

  fs.writeFileSync(OUT, JSON.stringify(store, null, 1));
  const total = Object.keys(store).length;
  const withArt = Object.values(store).filter(v => v.url).length;
  console.log(`\n  Art found ${found}, no match ${missed}`);
  console.log(`  data/covers.json now holds ${withArt}/${total} releases with art\n`);
  if (misses.length) console.log(`  no-match: ${misses.map(m => m.id).join(', ')}\n`);
})();
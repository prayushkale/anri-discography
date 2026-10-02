#!/usr/bin/env node
/* Fetch a release date for every release in the discography.
   Writes data/dates.json  (releaseId -> { released, source, precision })

   Source: the MusicBrainz web service. It is a community-maintained catalogue but
   it is the only tested source that files precise (often day-level) release dates
   for Anri's Japanese-catalog singles, which the English Wikipedia singles table
   does not carry and the app never had at all.

   Correctness matters more than coverage, exactly as in fetch-covers.js: a wrong
   date on a discography slide is worse than no date. A MusicBrainz release is
   accepted only when the title matches on a normalised form AND its year is within
   one of ours. MusicBrainz also holds later reissues of the same album under the
   same title, so candidates are ranked to prefer the original-era edition, and an
   accepted match must land in the release's own year or the year before it.

   Usage:
     node tools/fetch-dates.js            # only releases still missing a date
     node tools/fetch-dates.js --force    # re-fetch everything
     node tools/fetch-dates.js --only cat # only ids/titles matching "cat"   */
'use strict';
const fs = require('fs');
const path = require('path');
const { loadTracks } = require('./load-tracks');

const ROOT = path.resolve(__dirname, '..');
const P = (...s) => path.join(ROOT, ...s);
const OUT = P('data', 'dates.json');

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const ONLY = (() => { const i = args.indexOf('--only'); return i >= 0 ? args[i + 1] : null; })();

const store = (() => {
  try { return JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) { return {}; }
})();

/* MusicBrainz asks for a descriptive User-Agent and rate limits to ~1 req/sec. */
const UA = 'anri-discography/1.0 (local static-site build script)';
const RATE_MS = 1100;

/* ---------- normalisation, kept identical to fetch-covers.js ---------- */
function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[’'`´‘]/g, "'")
    .replace(/[・･]/g, ' ')
    .replace(/[‐-―−-]/g, '-')          // dashes -> hyphen
    .replace(/[ー～〜]/g, '')           // kana prolong marks
    .replace(/[\s　]+/g, '')
    .replace(/[()（）「」『』,.!?:;'"~・]/g, '');
}
function tokens(s) {
  return String(s || '').toLowerCase()
    .split(/[^a-z0-9]+/).filter(t => t.length > 1 && !/^(the|a|an|of|and|to|in|no|ni|wo|wa)$/.test(t));
}

/* Returns 0..1, or -1 to reject. Same shape as fetch-covers.js titleScore so the
   two matchers cannot drift apart. */
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
    // single distinctive word match (e.g. "Timely" vs "TIMELY!!")
    if (ta.length === 1 && setB.has(ta[0])) return 0.85;
    if (r > 0) return 0.5;
  }
  return -1;
}

/* MusicBrainz files singles under their Japanese title (風のジェラシー), never the
   romanised one, so a latin-only comparison rejects every single in the catalogue.
   Matching on the Japanese title is therefore a first-class identity check, not
   just a bonus. */
function jaNorm(s) {
  return String(s || '').replace(/^杏里\s*/, '').replace(/[\s　ー～〜!-/:-@[-`{-~]/g, '');
}
function jaScore(ours, theirs) {
  const a = jaNorm(ours), b = jaNorm(theirs);
  if (!a || !b) return -1;
  if (a === b) return 1;
  if (b.includes(a) || a.includes(b)) return 0.9;
  return -1;
}

/* ---------- MusicBrainz ---------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));
let lastCall = 0;

async function mb(query) {
  // pace to one request per RATE_MS so we stay under the published limit
  const wait = RATE_MS - (Date.now() - lastCall);
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();

  const url = 'https://musicbrainz.org/ws/2/release/?query=' + encodeURIComponent(query) +
    '&fmt=json&limit=25';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept': 'application/json' },
        signal: AbortSignal.timeout(25000)
      });
      if (res.status === 503) { await sleep(4000 * (attempt + 1)); continue; }   // overloaded
      if (!res.ok) return [];
      return (JSON.parse(await res.text()).releases) || [];
    } catch (e) {
      await sleep(1500 * (attempt + 1));
    }
  }
  return [];
}

/* MusicBrainz stores partial dates (1983, 1983-08, 1983-08-05) exactly as the
   contributor recorded them, so precision is preserved rather than invented. */
function precisionOf(date) {
  if (!date) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return 'day';
  if (/^\d{4}-\d{2}$/.test(date)) return 'month';
  if (/^\d{4}$/.test(date)) return 'year';
  return null;
}

/* Rank MusicBrainz candidates. The catalogue files every reissue of an album under
   the same title (TIMELY!! exists for 1983, 2011 and 2016), so a title match alone
   is not enough — the original-era edition has to win. */
function pickBest(cands, rel) {
  const ourYear = rel.year;
  const ja = rel.titleJa && rel.titleJa.replace(/^杏里\s*/, '').trim();
  let best = null, bestScore = 0;

  for (const c of cands) {
    // either script can carry the identity: albums are filed in latin, singles in kanji
    const latin = titleScore(rel.title, c.title);
    const jap = ja ? Math.max(jaScore(ja, c.title), jaScore(rel.titleJa || '', c.title)) : -1;
    const s = Math.max(latin, jap);
    if (s < 0) continue;

    let score = s;

    const y = c.date ? parseInt(String(c.date).slice(0, 4), 10) : 0;

    // A dated entry in our own year is the original release; this is the signal
    // that separates 1983's TIMELY!! from its 2011 and 2016 reissues.
    if (y === ourYear) score += 0.5;
    // A single can be dated to the calendar year before our year group when the
    // release straddles the New Year, so the adjacent year stays acceptable.
    else if (y === ourYear - 1) score += 0.2;
    // undated entries can never win against a dated one
    else if (!y) score -= 0.3;
    else score -= 1;

    if (score > bestScore) { bestScore = score; best = c; }
  }

  // Strict gate, mirroring fetch-covers.js: accept only within one year of ours.
  if (!best) return null;
  const by = best.date ? parseInt(String(best.date).slice(0, 4), 10) : 0;
  if (by && Math.abs(by - ourYear) > 1) return null;
  return best;
}

async function searchFor(rel) {
  const queries = [];
  const ja = rel.titleJa && rel.titleJa.replace(/^杏里\s*/, '').trim();
  if (ja) queries.push('release:' + ja + ' AND artist:杏里');
  if (rel.title) queries.push('release:' + rel.title + ' AND artist:杏里');

  const seen = new Set();
  const out = [];
  for (const q of queries) {
    for (const r of await mb(q)) {
      const key = r.id || (r.title + r.date);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
    }
  }
  return out;
}

/* ---------- run ---------- */
(async () => {
  const { discog } = loadTracks();
  const jobs = [];
  for (const y of discog.years) {
    for (const rel of y.releases) {
      rel.year = y.year;
      if (ONLY && !rel.id.includes(ONLY) && !(rel.title || '').toLowerCase().includes(ONLY.toLowerCase())) continue;
      if (!FORCE && store[rel.id] && store[rel.id].released) continue;
      jobs.push(rel);
    }
  }
  if (!jobs.length) {
    console.log(`  Nothing to do — ${Object.values(store).filter(v => v.released).length} release(s) already dated.`);
    console.log('  Use --force to re-fetch, or --only <filter> to target specific releases.\n');
    process.exit(0);
  }

  console.log(`\n  Fetching release dates for ${jobs.length} release(s) from MusicBrainz  (${FORCE ? 'forced' : 'only missing'})\n`);
  let found = 0, missed = 0;
  const misses = [];

  for (const rel of jobs) {
    const cands = await searchFor(rel);
    const best = pickBest(cands, rel);
    const prec = best && precisionOf(best.date);
    if (best && prec) {
      store[rel.id] = {
        released: best.date,
        precision: prec,
        source: 'musicbrainz',
        matched: best.title,
        year: parseInt(String(best.date).slice(0, 4), 10)
      };
      found++;
      console.log(`  ✓ ${rel.id.padEnd(36)} → ${best.date}  (${prec})  ${best.title.slice(0, 30)}`);
    } else {
      const why = !cands.length ? 'no results' : 'no confident match';
      store[rel.id] = { released: null, dateReason: why };
      missed++;
      misses.push(rel);
      console.log(`  ✗ ${rel.id.padEnd(36)}   ${rel.title}   [${why}]`);
    }
    if (found % 5 === 0) fs.writeFileSync(OUT, JSON.stringify(store, null, 1));
  }

  fs.writeFileSync(OUT, JSON.stringify(store, null, 1));
  const total = Object.keys(store).length;
  const dated = Object.values(store).filter(v => v.released).length;
  const byPrecision = { day: 0, month: 0, year: 0 };
  for (const v of Object.values(store)) if (v.released) byPrecision[v.precision]++;

  console.log(`\n  Dated ${found}, no match ${missed}`);
  console.log(`  precision:  ${byPrecision.day} day · ${byPrecision.month} month · ${byPrecision.year} year`);
  console.log(`  data/dates.json now holds ${dated}/${total} releases with a date\n`);
  if (misses.length) console.log(`  no-match: ${misses.map(m => m.id).join(', ')}\n`);
})();
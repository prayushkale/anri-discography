#!/usr/bin/env node
/* Build anri.html — inline discography + YouTube IDs + choruses into src/template.html */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const P = (...s) => path.join(ROOT, ...s);
const readJSON = (p, dflt) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) {
    if (fs.existsSync(p)) { console.error(`  ! ${path.relative(ROOT, p)} is invalid JSON: ${e.message}`); process.exit(1); }
    return dflt;
  }
};

const discog = readJSON(P('data', 'discography.json'));
if (!discog) { console.error('  ! data/discography.json is required'); process.exit(1); }
const ytIds   = readJSON(P('data', 'yt-ids.json'), {});
const choruses = readJSON(P('data', 'choruses.json'), {});
const covers   = readJSON(P('data', 'covers.json'), {});
const dates    = readJSON(P('data', 'dates.json'), {});
const tracklists = fs.existsSync(P('data', 'tracklists'))
  ? fs.readdirSync(P('data', 'tracklists')).filter(f => f.endsWith('.json'))
  : [];

/* ---- attach release dates ----
   A `released` field written straight into discography.json always wins, so a
   hand-corrected date survives re-running tools/fetch-dates.js. Otherwise fall
   back to the fetched date, and finally to the year alone — the app knows the
   year from the nesting, but it is better to ship it as a real field. */
let datedReleases = 0, dayPrecision = 0;
for (const y of discog.years) {
  for (const rel of y.releases) {
    rel.year = y.year;
    const d = dates[rel.id];
    if (rel.released) {
      rel.dateSource = rel.dateSource || 'manual';
    } else if (d && d.released) {
      rel.released = d.released;
      rel.dateSource = 'musicbrainz';
      rel.datePrecision = d.precision || null;
    } else {
      rel.released = String(y.year);
      rel.dateSource = 'year';
    }
    if (rel.dateSource !== 'year') datedReleases++;
    if (rel.datePrecision === 'day') dayPrecision++;
  }
}

/* ---- attach tracklists to releases ---- */
let tracksAttached = 0;
for (const tl of tracklists) {
  const list = readJSON(P('data', 'tracklists', tl), null);
  if (!list || !list.tracks) continue;
  for (const y of discog.years) {
    for (const rel of y.releases) {
      if (rel.tracklist !== list.slug) continue;
      rel.tracks = list.tracks.map((t, i) => {
        const id = `${rel.id}-t${String(t.n != null ? t.n : i + 1).padStart(2, '0')}`;
        const merged = { id, n: t.n != null ? t.n : i + 1, title: t.title, titleJa: t.titleJa || null };
        if (t.note) merged.note = t.note;
        if (t.verified === false || list.verified === false) merged.unverified = true;
        // join YouTube resolution
        if (ytIds[id]) {
          merged.videoId = ytIds[id].videoId;
          merged.query   = ytIds[id].query   || (merged.title + ' ANRI');
          merged.embeddable = ytIds[id].embeddable !== false;
          // shown per-track on the release slide, so keep what the resolver found
          if (ytIds[id].channel) merged.channel = ytIds[id].channel;
          if (ytIds[id].duration) merged.duration = ytIds[id].duration;
        }
        // join chorus analysis
        if (choruses[id] && choruses[id].start != null) {
          merged.chorus = { start: choruses[id].start, end: choruses[id].end, confidence: choruses[id].confidence };
          // a hand-set span is not an analysis result, and the app shows it differently
          if (choruses[id].manual) merged.chorus.manual = true;
        }
        return merged;
      });
      tracksAttached += rel.tracks.length;
    }
  }
}

/* ---- synthesize a one-track list for trackless singles ----
   A single IS its one track, so give it a tracklist rather than leaving the app
   with nothing to play (which made it open YouTube in a new tab instead).
   Anthologies are excluded: a box set, video or compilation is many tracks, so a
   one-item list would let the resolver match a promo teaser or a documentary and
   present it as the release. They keep their search link instead.
   Mirrors tools/load-tracks.js — both must agree on the track id. */
const isAnthology = rel => rel.type === 'Box set' || rel.type === 'Video' ||
                           rel.type === 'Compilation';
let synthAttached = 0;
for (const y of discog.years) {
  for (const rel of y.releases) {
    if (rel.tracks) continue;
    if (isAnthology(rel)) continue;
    const id = `${rel.id}-t01`;
    const merged = { id, n: 1, title: rel.title, titleJa: rel.titleJa || null };
    if (ytIds[id]) {
      merged.videoId = ytIds[id].videoId;
      merged.query   = ytIds[id].query   || (rel.title + ' ANRI');
      merged.embeddable = ytIds[id].embeddable !== false;
      if (ytIds[id].channel) merged.channel = ytIds[id].channel;
      if (ytIds[id].duration) merged.duration = ytIds[id].duration;
    }
    if (choruses[id] && choruses[id].start != null) {
      merged.chorus = { start: choruses[id].start, end: choruses[id].end, confidence: choruses[id].confidence };
      if (choruses[id].manual) merged.chorus.manual = true;
    }
    rel.tracks = [merged];
    synthAttached++;
  }
}

/* ---- give every release-less track entity a query ---- */
for (const y of discog.years) {
  for (const rel of y.releases) {
    if (!rel.tracks) continue;
    for (const t of rel.tracks) if (!t.query) t.query = `${t.title} ANRI`;
  }
}

/* ---- report ---- */
let totalTracks = 0, resolved = 0, embeddable = 0, withChorus = 0, lowConf = 0, unverified = 0, manualChorus = 0;
const orphans = [];
for (const y of discog.years) {
  for (const rel of y.releases) {
    for (const t of rel.tracks || []) {
      totalTracks++;
      if (t.videoId) { resolved++; if (t.embeddable !== false) embeddable++; }
      else if (t.id) orphans.push(t.id);
      if (t.chorus) { withChorus++; if (t.chorus.manual) manualChorus++; if ((t.chorus.confidence || 0) < 0.45) lowConf++; }
      if (t.unverified) unverified++;
    }
  }
}

// Only ship artwork that actually resolved — the app draws a coloured tile for
// anything missing, so empty entries would just bloat the single file.
const shippedCovers = {};
let coverHits = 0;
for (const [id, c] of Object.entries(covers)) {
  if (c && c.url) { shippedCovers[id] = { url: c.url, title: c.title || null }; coverHits++; }
}

const payload = { artist: discog.artist, years: discog.years, portrait: discog.artist.portrait || null, covers: shippedCovers };
const releaseCount = discog.years.reduce((n, y) => n + y.releases.length, 0);

const template = fs.readFileSync(P('src', 'template.html'), 'utf8');
const PLACEHOLDER = '/*__ANRI_DATA__*/null';
if (!template.includes(PLACEHOLDER)) {
  console.error(`  ! src/template.html does not contain the placeholder ${PLACEHOLDER}`);
  process.exit(1);
}

// guard: the payload must not contain a literal </script>
const json = JSON.stringify(payload).replace(/<\/script/gi, '<\\/script');

const out = template.replace(PLACEHOLDER, json);
if (out === template) {
  console.error('  ! substitution produced no change — refusing to write an empty anri.html');
  process.exit(1);
}
if (!out.includes('"years"') || !out.includes('"artist"')) {
  console.error('  ! output is missing the data payload — refusing to write');
  process.exit(1);
}

const outPath = P('anri.html');
fs.writeFileSync(outPath, out, 'utf8');

const kb = (fs.statSync(outPath).size / 1024).toFixed(0);
const slides = discog.years.length + releaseCount + 1;
const pct = (a, b) => (b ? ((a / b) * 100).toFixed(0) + '%' : 'n/a');

console.log('\n  ANRI Discography — build complete\n');
console.log(`  output        anri.html  (${kb} KB, self-contained)`);
console.log(`  slides        ${slides}  (1 intro + ${discog.years.length} year + ${releaseCount} release)`);
console.log(`  releases      ${releaseCount}`);
console.log(`  tracks        ${totalTracks}  (${tracksAttached} from ${tracklists.length} tracklist file(s), ${synthAttached} synthesized singles)`);
console.log(`  videoId       ${resolved}/${totalTracks} resolved  (${pct(resolved, totalTracks)}), ${embeddable} embeddable`);
console.log(`  chorus        ${withChorus}/${totalTracks} analysed  (${pct(withChorus, totalTracks)}), ${lowConf} low confidence`);
if (manualChorus) console.log(`  hand-set      ${manualChorus} in the app, ${totalTracks - withChorus} track(s) still without a chorus`);
console.log(`  covers        ${coverHits}/${releaseCount} releases have artwork`);
console.log(`  dates         ${datedReleases}/${releaseCount} releases dated  (${dayPrecision} to the day, rest year-only)`);
if (unverified) console.log(`  unverified    ${unverified} track(s) flagged from source research`);
if (orphans.length && process.argv.includes('--verbose')) {
  console.log(`\n  unresolved (${orphans.length}):`);
  orphans.slice(0, 40).forEach(o => console.log('    ' + o));
  if (orphans.length > 40) console.log(`    … and ${orphans.length - 40} more`);
}
if (!resolved) console.log('  hint: run `node tools/resolve-youtube.js` to resolve YouTube video IDs');
if (!withChorus) console.log('  hint: run `node tools/analyze-choruses.js` to detect choruses (needs yt-dlp + ffmpeg)');
if (!coverHits) console.log('  hint: run `node tools/fetch-covers.js` to fetch release artwork');
if (!datedReleases) console.log('  hint: run `node tools/fetch-dates.js` to fetch release dates');
console.log(`\n  run it with:  node tools/serve.js   (a file:// page cannot play YouTube video)\n`);

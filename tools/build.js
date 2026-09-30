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
const tracklists = fs.existsSync(P('data', 'tracklists'))
  ? fs.readdirSync(P('data', 'tracklists')).filter(f => f.endsWith('.json'))
  : [];

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
        }
        // join chorus analysis
        if (choruses[id] && choruses[id].start != null) {
          merged.chorus = { start: choruses[id].start, end: choruses[id].end, confidence: choruses[id].confidence };
        }
        return merged;
      });
      tracksAttached += rel.tracks.length;
    }
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
let totalTracks = 0, resolved = 0, embeddable = 0, withChorus = 0, lowConf = 0, unverified = 0;
const orphans = [];
for (const y of discog.years) {
  for (const rel of y.releases) {
    for (const t of rel.tracks || []) {
      totalTracks++;
      if (t.videoId) { resolved++; if (t.embeddable !== false) embeddable++; }
      else if (t.id) orphans.push(t.id);
      if (t.chorus) { withChorus++; if ((t.chorus.confidence || 0) < 0.45) lowConf++; }
      if (t.unverified) unverified++;
    }
  }
}

const payload = { artist: discog.artist, years: discog.years, portrait: discog.artist.portrait || null };

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
const slides = discog.years.length + 1;
const pct = (a, b) => (b ? ((a / b) * 100).toFixed(0) + '%' : 'n/a');

console.log('\n  ANRI Discography — build complete\n');
console.log(`  output        anri.html  (${kb} KB, self-contained)`);
console.log(`  slides        ${slides}  (1 intro + ${discog.years.length} year slides)`);
console.log(`  releases      ${discog.years.reduce((n, y) => n + y.releases.length, 0)}`);
console.log(`  tracks        ${totalTracks}  from ${tracklists.length} tracklist file(s)`);
console.log(`  videoId       ${resolved}/${totalTracks} resolved  (${pct(resolved, totalTracks)}), ${embeddable} embeddable`);
console.log(`  chorus        ${withChorus}/${totalTracks} analysed  (${pct(withChorus, totalTracks)}), ${lowConf} low confidence`);
if (unverified) console.log(`  unverified    ${unverified} track(s) flagged from source research`);
if (orphans.length && process.argv.includes('--verbose')) {
  console.log(`\n  unresolved (${orphans.length}):`);
  orphans.slice(0, 40).forEach(o => console.log('    ' + o));
  if (orphans.length > 40) console.log(`    … and ${orphans.length - 40} more`);
}
if (!resolved) console.log('  hint: run `node tools/resolve-youtube.js` to resolve YouTube video IDs');
if (!withChorus) console.log('  hint: run `node tools/analyze-choruses.js` to detect choruses (needs yt-dlp + ffmpeg)');
console.log('');

/* Shared loader: merge discography.json + data/tracklists/*.json into a flat,
   fully-identified track list. Used by resolve-youtube.js, analyze-choruses.js and build.js
   so every tool agrees on track ids. */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const P = (...s) => path.join(ROOT, ...s);

function readJSON(p, dflt) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) {
    if (fs.existsSync(p)) { console.error(`  ! ${path.relative(ROOT, p)} is invalid JSON: ${e.message}`); process.exit(1); }
    return dflt;
  }
}

/** Returns { discog, tracks: [{id, n, title, titleJa, note, unverified, year, releaseId, releaseTitle, releaseType, label}], tracklists: {slug: list} } */
function loadTracks() {
  const discog = readJSON(P('data', 'discography.json'));
  if (!discog) { console.error('  ! data/discography.json is required'); process.exit(1); }

  const dir = P('data', 'tracklists');
  const tracklists = {};
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.json'))) {
      const list = readJSON(P('data', 'tracklists', f), null);
      if (list && list.slug) tracklists[list.slug] = list;
    }
  }

  /* A Box set or Video has no canonical audio track, and a compilation is an
     anthology — treating either as "one track named after the release" would let
     the YouTube resolver match a 21-minute documentary or a promo teaser and
     present it as the release. Those keep a search link instead. */
  const isAnthology = rel => rel.type === 'Box set' || rel.type === 'Video' ||
                             rel.type === 'Compilation';

  const tracks = [];
  for (const y of discog.years) {
    for (const rel of y.releases) {
      /* A single IS its one track, so give it a tracklist rather than leaving the
         app with nothing to play — without this, singles had no track entity and
         the app opened YouTube in a new tab instead of playing them in-frame. */
      if (!rel.tracklist) {
        if (isAnthology(rel)) continue;
        rel.tracks = [{
          id: `${rel.id}-t01`,
          n: 1,
          title: rel.title,
          titleJa: rel.titleJa || null,
          note: null,
          unverified: false,
          year: y.year,
          releaseId: rel.id,
          releaseTitle: rel.title,
          releaseType: rel.type,
          label: rel.label || null,
          query: `${rel.title} ANRI`
        }];
        rel.tracks.forEach(t => tracks.push(t));
        continue;
      }
      const list = tracklists[rel.tracklist];
      if (!list) continue;
      const rows = list.tracks || [];
      const rows2 = rows.map((t, i) => {
        const n = t.n != null ? t.n : i + 1;
        return {
          id: `${rel.id}-t${String(n).padStart(2, '0')}`,
          n,
          title: t.title,
          titleJa: t.titleJa || null,
          note: t.note || null,
          unverified: (t.verified === false || list.verified === false) || false,
          year: y.year,
          releaseId: rel.id,
          releaseTitle: rel.title,
          releaseType: rel.type,
          label: rel.label || null,
          query: `${t.title} ANRI`
        };
      });
      rel.tracks = rows2;
      rows2.forEach(t => tracks.push(t));
    }
  }
  return { discog, tracks, tracklists };
}

module.exports = { loadTracks, readJSON, ROOT, P };

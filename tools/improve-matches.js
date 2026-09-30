#!/usr/bin/env node
/* One-off maintenance: re-resolve only the tracks whose current match did NOT
   come from an Anri-owned channel. Run after improving the scorer. */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'data', 'yt-ids.json');
const store = JSON.parse(fs.readFileSync(OUT, 'utf8'));

const before = new Map(Object.entries(store).map(([k, v]) => [k, v.videoId]));
const bad = Object.keys(store).filter(k => !/(anri|杏里)/i.test(store[k].channel || ''));
console.log(`\n  Re-resolving ${bad.length} track(s) that did not match an Anri channel\n`);

let i = 0;
for (const id of bad) {
  i++;
  process.stdout.write(`\r  [${i}/${bad.length}] ${id}${' '.repeat(10)}`);
  try {
    execFileSync('node', [path.join(__dirname, 'resolve-youtube.js'), '--only', id, '--force'], {
      cwd: ROOT, stdio: 'ignore'
    });
  } catch (e) {
    console.log(`\n  ! ${id} failed: ${e.message}`);
  }
}

const after = JSON.parse(fs.readFileSync(OUT, 'utf8'));
let changed = 0, improved = 0, regressed = 0;
for (const [k, v] of Object.entries(after)) {
  if (before.get(k) && before.get(k) !== v.videoId) {
    changed++;
    const wasOff = !/(anri|杏里)/i.test(Object.entries(store).find(([kk]) => kk === k)[1].channel || '');
    const nowOff = !/(anri|杏里)/i.test(v.channel || '');
    if (wasOff && !nowOff) improved++;
    if (!wasOff && nowOff) regressed++;
  }
}
console.log(`\n\n  Changed: ${changed}  ·  moved onto an official channel: ${improved}  ·  moved off: ${regressed}`);
const final = Object.values(after);
const off = final.filter(x => /(anri|杏里)/i.test(x.channel || '')).length;
console.log(`  Official-channel coverage: ${off}/${final.length} (${(off / final.length * 100).toFixed(0)}%)\n`);

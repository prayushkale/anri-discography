#!/usr/bin/env node
/* Serve the discography app on a real http origin.

   YouTube refuses to play embeds on pages opened over file:// — every track
   fails with "Error 153 / Video player configuration error". The same video
   plays fine over http. This prints the one command to fix that, and (unless
   --no-open) opens the app for you.

   It also accepts POST /api/chorus so a chorus you set by hand in the app can be
   written back to data/choruses.json. That is the only endpoint here that writes,
   and the server binds 127.0.0.1 only — nothing on your network can reach it.

   Usage:  node tools/serve.js [--port 8000] [--no-open]  */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { loadTracks } = require('./load-tracks.js');

const ROOT = path.resolve(__dirname, '..');
const CHORUS_FILE = path.join(ROOT, 'data', 'choruses.json');
const args = process.argv.slice(2);
const portIdx = args.indexOf('--port');
const PORT = portIdx >= 0 ? parseInt(args[portIdx + 1], 10) : 8000;
const NO_OPEN = args.includes('--no-open');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8'
};

const entry = path.join(ROOT, 'anri.html');
if (!fs.existsSync(entry)) {
  console.error('\n  anri.html not found. Run `node tools/build.js` first.\n');
  process.exit(1);
}

/* ---------- POST /api/chorus ----------
   The app lets you mark a chorus by hand for a track the analyser could not find
   one in, and this persists that choice. The payload comes from the page, so treat
   it as untrusted: only ids that really exist in the discography are accepted,
   the numbers must be finite and in range, and the file is never written from a
   value that failed those checks. */
const MAX_BODY = 4096;
const ID_RE = /^[a-z0-9-]+-t\d{2}$/;

// Built once at startup: the set of ids loadTracks() agrees with, which is the
// same source analyze-choruses.js and build.js use, so all three always match.
const knownTrackIds = new Set(loadTracks().tracks.map(t => t.id));

function readChorusStore() {
  try { return JSON.parse(fs.readFileSync(CHORUS_FILE, 'utf8')); } catch (e) { return {}; }
}

function bad(res, why) {
  res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: false, error: why }));
}

function handleChorusPost(req, res) {
  let size = 0;
  const chunks = [];
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BODY) { req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => {
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch (e) { return bad(res, 'body is not valid JSON'); }
    if (!body || typeof body !== 'object') return bad(res, 'body must be an object');

    const id = body.id;
    if (typeof id !== 'string' || !ID_RE.test(id)) return bad(res, 'malformed track id');
    // Without this, any well-formed-looking id could be written into the data file.
    if (!knownTrackIds.has(id)) return bad(res, 'unknown track id');

    const store = readChorusStore();

    // A null span means "clear": only a hand-set entry is removed, so this can
    // never delete an analysis result.
    if (body.start === null || body.end === null) {
      if (!store[id] || !store[id].manual) {
        return json(res, { ok: true, cleared: false });
      }
      delete store[id];
      writeChorusStore(store);
      return json(res, { ok: true, cleared: true });
    }

    const start = body.start, end = body.end;
    if (typeof start !== 'number' || typeof end !== 'number' ||
        !Number.isFinite(start) || !Number.isFinite(end)) {
      return bad(res, 'start and end must be finite numbers');
    }
    if (start < 0 || end <= start || end > 21600) {
      return bad(res, 'start must be >= 0 and end must be greater than start');
    }

    // keep whatever the analyser already knew about the track length
    const prev = store[id] || {};
    store[id] = {
      start: +start.toFixed(2),
      end: +end.toFixed(2),
      confidence: 1,
      manual: true,
      duration: prev.duration != null ? prev.duration : (typeof body.duration === 'number' ? body.duration : null)
    };
    if (store[id].duration == null) delete store[id].duration;
    writeChorusStore(store);
    json(res, { ok: true, id, start: store[id].start, end: store[id].end });
  });
  req.on('error', () => {});
}

// Written the way tools/analyze-choruses.js writes it (indent 1, no trailing
// newline) so a hand-set entry does not show up as a whole-file reformat in git.
function writeChorusStore(store) {
  fs.writeFileSync(CHORUS_FILE, JSON.stringify(store, null, 1));
}

function json(res, obj) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);

  if (req.method === 'POST' && url === '/api/chorus') return handleChorusPost(req, res);

  // Browsers request this unprompted on every load; answering keeps a guaranteed
  // 404 out of the console.
  if (url === '/favicon.ico') { res.writeHead(204).end(); return; }
  const rel = url === '/' ? 'anri.html' : url.replace(/^\/+/, '');
  const file = path.join(ROOT, rel);
  // never serve anything outside the project
  if (!file.startsWith(ROOT)) { res.writeHead(403).end('Forbidden'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); return; }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(buf);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  const addr = `http://localhost:${PORT}/`;
  console.log('\n  ANRI discography is being served.\n');
  console.log(`  ${addr}\n`);
  console.log('  Playback needs this http origin — opening anri.html directly from');
  console.log('  disk (file://) makes every track fail with "Error 153".\n');
  if (!NO_OPEN) {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    try { spawn(cmd, [addr], { stdio: 'ignore', detached: true }).unref(); } catch (e) {}
  }
  console.log('  Ctrl+C to stop.\n');
});
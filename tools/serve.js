#!/usr/bin/env node
/* Serve the discography app on a real http origin.

   YouTube refuses to play embeds on pages opened over file:// — every track
   fails with "Error 153 / Video player configuration error". The same video
   plays fine over http. This prints the one command to fix that, and (unless
   --no-open) opens the app for you.

   Usage:  node tools/serve.js [--port 8000] [--no-open]  */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
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

const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
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
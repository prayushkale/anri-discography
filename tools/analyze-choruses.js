#!/usr/bin/env node
/* Detect chorus regions with Foote-style spectral-flux novelty detection.
   For each track: yt-dlp the audio -> ffmpeg to mono PCM -> STFT -> spectral flux
   novelty curve -> self-similarity -> repetition diagonals -> strongest repeated
   section = the chorus.

   Usage:
     node tools/analyze-choruses.js                # analyse all missing
     node tools/analyze-choruses.js --only cat     # filter
     node tools/analyze-choruses.js --force        # redo everything
     node tools/analyze-choruses.js --dry-run      # only fetch+decode, no detection

   Writes data/choruses.json. Requires yt-dlp and ffmpeg on PATH. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { loadTracks } = require('./load-tracks');

const pexec = promisify(execFile);
const ROOT = path.resolve(__dirname, '..');
const P = (...s) => path.join(ROOT, ...s);
const OUT = P('data', 'choruses.json');

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const DRY = args.includes('--dry-run');
const ONLY = (() => { const i = args.indexOf('--only'); return i >= 0 ? args[i + 1] : null; })();
const LIMIT = (() => { const i = args.indexOf('--limit'); return i >= 0 ? parseInt(args[i + 1], 10) : Infinity; })();
const PAUSE_MS = (() => { const i = args.indexOf('--pause'); return i >= 0 ? parseInt(args[i + 1], 10) : 2500; })();
/* Optional browser cookies, e.g. --cookies ../cookies.txt
   Only useful if you later hit the bot check again and the cookie jar is fresh.
   A stale or SABR-only account cookie jar makes downloads FAIL where they would
   otherwise succeed, so this is opt-in and never the default. */
const COOKIES = (() => {
  const i = args.indexOf('--cookies');
  if (i < 0) return null;
  const p = path.resolve(process.cwd(), args[i + 1] || 'cookies.txt');
  if (!fs.existsSync(p)) { console.error(`  ! cookie file not found: ${p}`); process.exit(1); }
  return p;
})();
const SR = 22050;        // analysis sample rate
const HOP = 512;         // STFT hop -> 43.07 frames/sec at 22.05kHz
const FFT = 1024;

const store = (() => {
  try { return JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) { return {}; }
})();
const yts = (() => {
  try { return JSON.parse(fs.readFileSync(P('data', 'yt-ids.json'), 'utf8')); } catch (e) { return {}; }
})();

/* ---------- work list ---------- */
const { tracks } = loadTracks();
const tasks = [];
for (const t of tracks) {
  const v = yts[t.id];
  if (!v || !v.videoId) continue;                       // needs a resolved video
  if (!FORCE && store[t.id]) continue;
  if (ONLY && !t.id.includes(ONLY) && !t.title.toLowerCase().includes(ONLY.toLowerCase())) continue;
  tasks.push({ ...t, videoId: v.videoId });
}

if (!tasks.length) {
  console.log(`\n  Nothing to analyse — ${Object.keys(store).length} choruses already recorded.`);
  console.log('  (Tracks without a resolved videoId are skipped; run tools/resolve-youtube.js first.)\n');
  process.exit(0);
}
const queue = tasks.slice(0, LIMIT);
console.log(`\n  Chorus detection — ${queue.length} track(s) of ${tasks.length} queued`);
console.log(`  method: spectral-flux novelty + self-similarity repetition diagonals\n`);

/* ---------- shell helpers ---------- */
function run(cmd, argv, opts = {}) {
  return pexec(cmd, argv, { maxBuffer: 1024 * 1024 * 64, ...opts });
}
async function have(bin) {
  try { await run('which', [bin]); return true; }
  catch (e) { return false; }
}

/* ---------- audio fetch + decode ---------- */

/* YouTube rate-limits sustained downloads and starts answering
   "Sign in to confirm you're not a bot" / HTTP 403. When that happens we back
   off for a long, escalating interval rather than hammering it. */
let throttleStrikes = 0;
const THROTTLE_BACKOFF = [60, 180, 420, 900];
function looksThrottled(msg) {
  return /sign in to confirm|not a bot|403|429|too many requests/i.test(msg || '');
}
async function throttleWait(trackId) {
  const waitSec = THROTTLE_BACKOFF[Math.min(throttleStrikes, THROTTLE_BACKOFF.length - 1)];
  throttleStrikes++;
  console.log(`\n  ⏳ YouTube is rate-limiting downloads — pausing ${waitSec}s before continuing`);
  await new Promise(r => setTimeout(r, waitSec * 1000));
}
function noteSuccess() { if (throttleStrikes > 0) throttleStrikes = 0; }

let COOKIES_OFF = false;
async function fetchPcm(videoId, tmpDir) {
  const out = path.join(tmpDir, videoId);
  const cookieArgs = (COOKIES && !COOKIES_OFF) ? ['--cookies', COOKIES] : [];
  let lastMsg = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await run('yt-dlp', [
        ...cookieArgs,
        '-f', 'bestaudio/best',
        '-x', '--audio-format', 'wav',
        '-o', out + '.%(ext)s',
        '--no-playlist', '--no-warnings', '--quiet',
        '--sleep-requests', '1',
        'https://www.youtube.com/watch?v=' + videoId
      ], { timeout: 180000 });
      lastMsg = '';
      break;
    } catch (e) {
      lastMsg = (e.stderr || e.message || '').slice(0, 200);
      // A cookie jar that cannot serve the stream is worse than no cookies.
      if ((COOKIES && !COOKIES_OFF) && /requested format is not available|sabr|needs to be reloaded/i.test(lastMsg)) {
        console.log('\n  ! cookies cannot serve this stream — falling back to no cookies for the rest of the run');
        COOKIES_OFF = true;
        continue;                       // retry this same track without cookies
      }
      if (looksThrottled(lastMsg)) {
        await throttleWait(videoId);
        continue;                      // retry this same track after the pause
      }
      if (attempt < 2) await new Promise(r => setTimeout(r, 3000 * (attempt + 1)));
    }
  }
  if (lastMsg && looksThrottled(lastMsg)) throw new Error('rate-limited by YouTube');

  let wav = null;
  for (const ext of ['wav', 'm4a', 'mp3', 'opus', 'webm']) {
    const p = out + '.' + ext;
    if (fs.existsSync(p) && fs.statSync(p).size > 1024) { wav = p; break; }
  }
  if (!wav) throw new Error('no audio file produced' + (lastMsg ? ' — ' + lastMsg.slice(0, 80) : ''));
  return wav;
}

/* decode to Float32 via ffmpeg raw pipe */
async function decodePcm(wavFile) {
  const { stdout } = await run('ffmpeg', [
    '-v', 'quiet', '-i', wavFile,
    '-f', 'f32le', '-acodec', 'pcm_f32le',
    '-ac', '1', '-ar', String(SR), '-'
  ], { encoding: 'buffer', maxBuffer: 1024 * 1024 * 1024 });
  const buf = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  const f = new Float32Array(buf.length / 4);
  for (let i = 0; i < f.length; i++) f[i] = buf.readFloatLE(i * 4);
  return f;
}

/* ---------- FFT (iterative radix-2, in-place) ---------- */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}
function hann(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
  return w;
}

/* ---------- novelty curve ---------- */
function noveltyCurve(pcm) {
  const win = hann(FFT);
  const bins = FFT / 2 + 1;
  let prev = new Float32Array(bins);
  let cur = new Float32Array(bins);
  const nov = [];
  const re = new Float64Array(FFT);
  const im = new Float64Array(FFT);
  for (let pos = 0; pos + FFT <= pcm.length; pos += HOP) {
    for (let i = 0; i < FFT; i++) { re[i] = pcm[pos + i] * win[i]; im[i] = 0; }
    fft(re, im);
    // log magnitude, then positive half-wave rectified flux
    let flux = 0;
    for (let b = 0; b < bins; b++) {
      const m = Math.log10(1 + 100 * Math.hypot(re[b], im[b]));
      cur[b] = m;
      const d = m - prev[b];
      if (d > 0) flux += d;
    }
    nov.push(flux);
    prev = Float32Array.from(cur);
  }
  return Float32Array.from(nov);
}
const frameSec = () => HOP / SR;

/* ---------- Foote self-similarity chorus scoring ---------- */
function detectChorus(nov) {
  const N = nov.length;
  if (N < 40) return null;
  const fps = 1 / frameSec();
  const dur = N / fps;

  // normalise + smooth the novelty curve
  const sm = new Float32Array(N);
  const W = 3;
  for (let i = 0; i < N; i++) {
    let s = 0, c = 0;
    for (let k = -W; k <= W; k++) { const j = i + k; if (j >= 0 && j < N) { s += nov[j]; c++; } }
    sm[i] = s / c;
  }
  let max = 0;
  for (let i = 0; i < N; i++) if (sm[i] > max) max = sm[i];
  if (max <= 0) return null;
  for (let i = 0; i < N; i++) sm[i] /= max;

  // lag range: a chorus repeats every ~8-30s
  const minLag = Math.max(8, Math.floor(8 * fps));
  const maxLag = Math.min(Math.floor(30 * fps), N - 1);
  if (maxLag <= minLag) return null;

  // autocorrelation of the novelty curve -> best repetition period
  let bestLag = 0, bestAc = -1;
  const ac = new Float32Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0, n = 0;
    for (let i = 0; i + lag < N; i++) { s += sm[i] * sm[i + lag]; n++; }
    ac[lag] = n ? s / n : 0;
  }
  // prefer larger lags slightly so a twice-repeated section wins over a single
  for (let lag = minLag; lag <= maxLag; lag++) {
    const v = ac[lag] * (1 + (lag / maxLag) * 0.12);
    if (v > bestAc) { bestAc = v; bestLag = lag; }
  }
  if (!bestLag || bestAc <= 0) return null;

  // Foote checkerboard kernel centred on each candidate diagonal
  // alpha spans +-chorusLen, beta = the repetition lag
  const chorusLen = bestLag;
  const alpha = Math.min(chorusLen, Math.floor(16 * fps));

  // A chorus is not in the intro vamp or the outro. Restrict the search to
  // the body of the track, then bias mildly toward the middle.
  const firstCand = Math.max(alpha + 1, Math.floor(dur * 0.10 * fps));
  const lastCand  = Math.min(N - alpha - 1, Math.floor(dur * 0.90 * fps));
  if (lastCand <= firstCand) return null;

  let bestScore = -1, bestIdx = -1;
  const mid = N / 2;
  for (let center = firstCand; center < lastCand; center += 2) {
    let score = 0;
    for (let dy = -alpha; dy <= alpha; dy += 1) {
      const row = center + dy;
      if (row < 0 || row >= N) continue;
      for (let dx = -alpha; dx <= alpha; dx += 1) {
        const c = row + dx;
        if (c < 0 || c >= N) continue;
        score += sm[row] * sm[c];
      }
    }
    // prefer regions nearer the middle of the track (chorus rarely sits at the edge)
    const centrality = 1 - Math.min(1, Math.abs(center - mid) / mid) * 0.22;
    score *= centrality;
    if (score > bestScore) { bestScore = score; bestIdx = center; }
  }
  if (bestIdx < 0) return null;

  const start = Math.max(0, (bestIdx - chorusLen) / fps);
  const end = Math.min(dur, (bestIdx + chorusLen) / fps);

  // confidence: normalised similarity of the winning diagonal vs. the mean
  let mean = 0;
  for (let lag = minLag; lag <= maxLag; lag++) mean += ac[lag];
  mean /= (maxLag - minLag + 1) || 1;
  const confidence = Math.max(0, Math.min(1, (bestAc / (mean || 1) - 1) / 2 + 0.5));

  return { start: +start.toFixed(2), end: +end.toFixed(2), confidence: +confidence.toFixed(3), lag: +bestLag.toFixed(2), duration: +dur.toFixed(1) };
}

/* ---------- run ---------- */
(async () => {
  for (const b of ['yt-dlp', 'ffmpeg']) {
    if (!(await have(b))) { console.error(`  ! "${b}" not found on PATH — install it first (brew install ${b}).`); process.exit(1); }
  }

  let done = 0, ok = 0, failed = 0, low = 0;
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'anri-chorus-'));

  const throttled = [];   // tracks skipped because YouTube throttled us

  for (const task of queue) {
    const dir = path.join(tmpRoot, task.id);
    fs.mkdirSync(dir, { recursive: true });
    try {
      const wav = await fetchPcm(task.videoId, dir);
      noteSuccess();
      const pcm = await decodePcm(wav);
      if (DRY) {
        console.log(`  ~ ${task.id}  ${task.title}  ${(pcm.length / SR).toFixed(1)}s decoded`);
      } else {
        const nov = noveltyCurve(pcm);
        const res = detectChorus(nov);
        if (res) {
          store[task.id] = { start: res.start, end: res.end, confidence: res.confidence, duration: res.duration };
          ok++;
          if (res.confidence < 0.45) low++;
          console.log(`  ✓ ${task.id}  ${task.title}  ${fmt(res.start)}–${fmt(res.end)}  conf ${res.confidence.toFixed(2)}  (${res.duration.toFixed(0)}s track)`);
        } else {
          failed++;
          console.log(`  ✗ ${task.id}  ${task.title}  (structure not detected)`);
        }
      }
    } catch (e) {
      const msg = String(e.message);
      if (/rate-limited/i.test(msg)) {
        throttled.push(task);
        console.log(`  ⏭  ${task.id}  ${task.title}  (deferred — YouTube throttled)`);
      } else {
        failed++;
        console.log(`  ✗ ${task.id}  ${task.title}  ${msg.slice(0, 90)}`);
      }
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}   // never keep the audio
      if (done % 5 === 0 || !queue.length) fs.writeFileSync(OUT, JSON.stringify(store, null, 1));
    }
    done++;
    // steady pace: sustained downloading is what triggers the bot check
    if (!DRY) await new Promise(r => setTimeout(r, PAUSE_MS));
  }

  // Second pass over anything deferred by throttling, now that we have paused.
  if (throttled.length) {
    console.log(`\n  Retrying ${throttled.length} throttled track(s) after a cool-down…\n`);
    await new Promise(r => setTimeout(r, 120000));
    for (const task of throttled) {
      const dir = path.join(tmpRoot, task.id);
      fs.mkdirSync(dir, { recursive: true });
      try {
        const wav = await fetchPcm(task.videoId, dir);
        const pcm = await decodePcm(wav);
        const res = detectChorus(noveltyCurve(pcm));
        if (res) {
          store[task.id] = { start: res.start, end: res.end, confidence: res.confidence, duration: res.duration };
          ok++;
          console.log(`  ✓ ${task.id}  ${task.title}  ${fmt(res.start)}–${fmt(res.end)}  (retry)`);
        }
      } catch (e) {
        console.log(`  ✗ ${task.id}  ${task.title}  still unavailable`);
      } finally {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
        await new Promise(r => setTimeout(r, PAUSE_MS * 2));
      }
    }
  }

  fs.writeFileSync(OUT, JSON.stringify(store, null, 1));
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) {}

  console.log(`\n  Analysed ${ok}/${done}  ·  ${failed} failed  ·  ${low} low confidence`);
  console.log(`  data/choruses.json now holds ${Object.keys(store).length} entries\n`);
})();

function fmt(s) { const m = Math.floor(s / 60); return m + ':' + String(Math.floor(s % 60)).padStart(2, '0'); }

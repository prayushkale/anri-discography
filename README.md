# ANRI — Complete Discography

A slide-by-slide presentation app of the Japanese singer **Anri** (杏里, b. Eiko Kawashima, 1961).
44 year-slides from 1978 to 2025, every release playable on YouTube, with a **chorus toggle**
that jumps straight to the hook — so you can build a whole chorus reel by pressing one key.

## Open it

Double-click **`anri.html`**. That's it.

No install, no server, no build step needed to *use* the app. It works from `file://`,
and you can copy the single file to a USB stick or email it.

## Using it

| Key | Action |
|---|---|
| `→` `Space` `PgDn` | Next slide |
| `←` `PgUp` | Previous slide |
| `Space` | Play / pause the current track |
| `C` | **Chorus mode** — jumps to the chorus |
| `L` | **Loop chorus** — repeats the chorus |
| `F` | Fullscreen |
| `O` | Jump-to-year overview |
| `P` | Blackout (pause the presentation) |
| `Home` / `End` | First / last slide |

Click any **release card** to expand its tracklist, then click a track to play it.
Releases without a tracklist (compilations, box sets, videos) open their YouTube search instead.

### The chorus feature

Each track has a detected chorus region, shown as a cyan band on the progress bar.

- **Chorus toggle (`C`)** — playback starts at the chorus rather than the intro.
- **Loop chorus** — repeats that region endlessly, which is how you sample it.
- **Set chorus here** — while the track plays, capture the current position as the chorus
  start. This overrides the detected value.
- **Reset** — revert back to the detected chorus.

Manual overrides are saved in your browser's `localStorage`, so they survive reloads.
They are per-browser: the shipped `anri.html` always starts from the detected values.

## Layout

```
anri.html              ← the deliverable. Generated, self-contained, double-clickable.
src/template.html      ← app source (markup + CSS + JS), with a __ANRI__ placeholder
data/
  discography.json     ← source of truth: artist info, all releases, per-year grouping
  tracklists/*.json    ← one file per album, 33 albums
  yt-ids.json          ← generated: track id -> YouTube video id
  choruses.json        ← generated: track id -> chorus start/end/confidence
tools/
  load-tracks.js       ← shared: merges discography + tracklists into a flat track list
  resolve-youtube.js   ← YouTube search -> video id
  analyze-choruses.js  ← yt-dlp + ffmpeg -> chorus detection
  build.js             ← inlines all data into anri.html
```

`anri.html` is generated. To change anything, edit the JSON or the template and re-run the build.

## Rebuilding

```bash
node tools/build.js            # regenerate anri.html from current data
node tools/build.js --verbose  # also list tracks with no YouTube video
```

The build prints a coverage report:

```
slides        45  (1 intro + 44 year slides)
releases      107
tracks        404  from 33 tracklist file(s)
videoId       398/404 resolved  (98%), 391 embeddable
chorus        372/404 analysed  (92%), 24 low confidence
```

## Regenerating the YouTube ids

```bash
node tools/resolve-youtube.js              # only tracks that are still missing
node tools/resolve-youtube.js --force      # re-resolve everything
node tools/resolve-youtube.js --only cat   # only tracks matching a filter
```

Searches `"<track title> ANRI"` and takes the best result. If the romanized title
matches nothing plausible, it retries with the original Japanese title — many
1980s–90s tracks have no Latin-script name on YouTube at all.

Ranking strongly prefers the artist's own channels (`Anri - Topic`,
`ANRI 杏里 Official`, the label channels) and penalises live, tribute and cover
takes, since a discography entry refers to the studio recording. Results that
belong to a different artist also called Anri are rejected outright. 84% of the
404 tracks resolved to an Anri-owned channel; the rest are fan uploads of the
correct recording. Four tracks with obscure titles matched nothing and fall back
to a YouTube search link in the app.

Results are checkpointed after every track, so an interrupted run loses nothing.
`tools/improve-matches.js` re-resolves only the tracks that did *not* land on an
Anri channel — useful after changing the ranking rules.

**On embeddability:** the resolver does *not* pre-check it, because there is no
reliable way to check it outside a browser. Both the oEmbed endpoint and
scraping `youtube.com/embed/<id>` return false results — one reports success for
videos whose embed is blocked, the other reports a generic `ERROR` for videos
that play perfectly (verified directly against the YT.Player API). So a track is
assumed playable, and if the embed genuinely fails the app shows a clear fallback
panel with an "Open on YouTube" link instead of a broken player.

## Regenerating the choruses

Requires `yt-dlp` and `ffmpeg` (`brew install yt-dlp ffmpeg`).

```bash
node tools/analyze-choruses.js              # only tracks not yet analysed
node tools/analyze-choruses.js --force      # redo everything
node tools/analyze-choruses.js --only cat   # filter
```

For each track it downloads the audio, decodes it to mono PCM, and runs
spectral-flux novelty detection: STFT → log-magnitude → positive spectral flux →
autocorrelation of the novelty curve to find the repetition period → a Foote
checkerboard kernel over the self-similarity matrix to find the strongest
repeated section. The search is restricted to the middle 80% of the track so
intro vamps and outros don't win.

Audio is deleted immediately after analysis. Only timestamps are kept.

**Rate limiting.** YouTube throttles sustained downloading and starts answering
`Sign in to confirm you're not a bot` or HTTP 403. The tool detects that, pauses
with an escalating back-off (60s → 180s → 420s → 900s), and retries the track
once things cool down. Anything still unavailable after that is simply left
without a chorus — the app falls back to "Set chorus here". If you need to fill
gaps later, just run the command again; it only processes what's missing.

```bash
node tools/analyze-choruses.js --pause 4000   # slower, if you keep hitting 403s
```

**Browser cookies.** If you do get blocked and have a fresh cookie export:

```bash
node tools/analyze-choruses.js --cookies cookies.txt
```

Cookies are opt-in, and the tool will fall back to no cookies automatically if
the jar can't serve the stream. This matters: a stale export, or an account with
YouTube's SABR-only streaming experiment enabled, makes downloads **fail** where
they would otherwise succeed — in testing, 0/3 videos downloaded with cookies
where all 3 succeeded without them. The default (no cookies) is the more reliable
path; reach for `--cookies` only as a second opinion when you're actually blocked.

`cookies.txt` is gitignored. Don't commit it — it holds live session credentials.

**Accuracy.** This finds *the most-repeated section*, which is usually the chorus
but is not guaranteed to be. A track whose intro riffs harder than its chorus, or
whose bridge repeats more than its hook, will get the wrong answer. That's what
the `confidence` score flags, and what "Set chorus here" is for. If a track
resolves to a low-confidence marker, listen to it and correct it by hand.

## Notes on the data

- The discography comes from the English Wikipedia article on Anri, with
  tracklists cross-checked against Japanese Wikipedia, MusicBrainz and Discogs.
- Where sources disagreed, the Japanese sources won. Notably **Circuit of Rainbow
  is 1989, not 1990** as the English article states.
- Tracks marked `unverified: true` in a tracklist file are rendered as a research
  flag rather than silently presented as fact. There are currently none.
- Oricon peak positions are included where Wikipedia lists them. A ★ marks a
  top-3 album.

## Requirements

| | |
|---|---|
| To use the app | Any modern browser. Internet required (YouTube embeds). |
| To rebuild | Node 18+ |
| To re-analyse choruses | Node 18+, `yt-dlp`, `ffmpeg` |

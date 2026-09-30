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

Searches `"<track title> ANRI"` and takes the best result — preferring official
`Anri - Topic` uploads, skipping live streams and anything under 90 seconds.
Results are checkpointed after every track, so an interrupted run loses nothing.

**On embeddability:** the resolver does *not* pre-check it, because there is no
reliable way to check it outside a browser. Both the oEmbed endpoint and
scraping `youtube.com/embed/<id>` return false negatives — they report success
(or a generic `ERROR`) for videos that play perfectly in a real player, and vice
versa. So a track is assumed playable, and if the embed genuinely fails the app
shows a clear fallback panel with an "Open on YouTube" link instead of a broken
player.

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

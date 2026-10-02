# ANRI — Complete Discography

A slide-by-slide presentation app of the Japanese singer **Anri** (杏里, b. Eiko Kawashima, 1961).
**152 slides** from 1978 to 2025: an intro, a year index for each of 44 years, and one slide per
release. Every release has its **cover art**, a large embedded **YouTube player**, full release
detail, and a **chorus toggle** that jumps straight to the hook.

## Open it

```bash
node tools/serve.js
```

That's it — no install, no dependencies, no build step needed to *use* the app.

`serve.js` prints a local `http://localhost:8000` URL and opens your browser.

### Deep links

Append a hash to jump straight to a year or a release:

```
anri.html#1986          the 1986 index
anri.html#al-timely     the Timely!! release slide
anri.html#42            slide 42
```

### Why not just double-click `anri.html`?

**YouTube will not play video embedded from a `file://` page.** Opened from disk,
every track fails with *"Video player configuration error"* (YouTube's internal
Error 153), because `file://` has no real origin for the embed to be authorised
against. It is not the videos and not the browser — the same tracks play fine the
moment the page is served over `http://`.

The app is still one self-contained file you can copy to a USB stick or email —
it just needs a local web server (any will do; `npx serve` works) rather than a
double-click.

## Using it

| Key | Action |
|---|---|
| `→` `Space` `PgDn` | Next slide |
| `←` `PgUp` | Previous slide |
| `Space` | Play / pause the current track |
| `C` | **Chorus mode** — playback jumps to the chorus |
| `F` | Fullscreen |
| `O` | Jump-to overview (grouped by year) |
| `P` | Blackout (pause the presentation) |
| `Home` / `End` | First / last slide |

**Navigate in two levels.** A year slide is a cover index — pick a release to open it.
Each release slide has a full-size player, the artwork, the release facts and the
complete tracklist, with a `← year` chip to go back.

Click any **track** in a release's tracklist to play it in place. Singles included:
a single *is* its one track, so it plays in the frame like any album track.

Only **box sets, videos and compilations** have no playable tracklist — those offer
a YouTube search link instead.

### The chorus feature

Each track has a detected chorus region, shown as a cyan band on the progress bar.

- **Chorus toggle (`C`)** — a small icon at the right of the transport strip. Switch it on and
  playback jumps to the chorus; switch it on before playing and a track starts there instead.
  It is deliberately tiny, so it stays out of the way until you want it.
- The **cyan band** on the scrub bar shows where the chorus is, and costs no UI space.
- A track with no detected chorus shows the toggle disabled.

Cyan is the only colour the *interface* reserves for itself; everything else is
chrome. The rest of the colour on screen is album art, which is the point — the
artwork is never competing with a coloured button.

Chorus markers you set by hand in an earlier version of the app are still honoured
from `localStorage`. There is no UI to set new ones.

## Design

The app is a **neon catalogue**: a deep indigo/violet ground lit by four accents.
Surfaces are the ground, a lifted glass panel, or a hairline border — never a
shadow doing structural work. Colour arrives through the album art, not the chrome.

| Token | Value | |
|---|---|---|
| Ground | `#0b0a1f` | page |
| Sun | `#ff8a3d` | the primary accent — years, headings, play |
| Pink | `#ff4d8d` | paired with sun in every gradient |
| Cyan | `#39d0d8` | chorus, dates, links — the one functional signal |
| Gold | `#ffd166` | Oricon positions, secondary data |
| Violet | `#3d2a8a` | scrollbars, grid glow |
| Glass | `rgba(255,255,255,.05)` | every raised panel |
| Radius | `10–16px` | cards, rails, the player frame |

Rules that keep it coherent:

- **Type is the hierarchy.** Big gradients carry the artist name, the year, and the
  release title; everything else is weight and size.
- **The year is the subject** of a year slide: a 96px gradient numeral above a rule.
- **Releases with no artwork get a coloured tile** carrying the title's first
  character, hue-cycling by position, so a year index stays a wall of colour rather
  than a field of empty grey boxes.
- **The playing track fills with a sun-to-pink gradient**, so the current track is
  findable instantly in a 16-row tracklist.
- Grids and rails are separated by 1px borders and glass fills, never by shadow.

## Layout

```
anri.html              ← the deliverable. Generated, self-contained.
src/template.html      ← app source (markup + CSS + JS), with a __ANRI__ placeholder
data/
  discography.json     ← source of truth: artist info, all releases, per-year grouping
  tracklists/*.json    ← one file per album, 33 albums
  yt-ids.json          ← generated: track id -> YouTube video id
  choruses.json        ← generated: track id -> chorus start/end/confidence
  covers.json          ← generated: release id -> album artwork URL
  dates.json           ← generated: release id -> release date + precision
tools/
  load-tracks.js       ← shared: merges discography + tracklists into a flat track list
  resolve-youtube.js   ← YouTube search -> video id
  analyze-choruses.js  ← yt-dlp + ffmpeg -> chorus detection
  fetch-covers.js      ← iTunes search -> release artwork
  fetch-dates.js       ← MusicBrainz -> release dates
  serve.js             ← serves the app on localhost (needed for playback)
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
output        anri.html  (221 KB, self-contained)
slides        152  (1 intro + 44 year + 107 release)
releases      107
tracks        460  (404 from 33 tracklist file(s), 56 synthesized singles)
videoId       455/460 resolved  (99%), 455 embeddable
chorus        400/460 analysed  (87%), 0 low confidence
covers        61/107 releases have artwork
dates         79/107 releases dated  (76 to the day, rest year-only)
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
without a chorus — the app shows the chorus toggle disabled on that track. If you need
to fill gaps later, just run the command again; it only processes what's missing.

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
the `confidence` score flags. A low-confidence marker means the band on the scrub bar
may not be the real hook.

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

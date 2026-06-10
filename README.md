# Clipframe

A fast, **private** video → GIF maker (+ trim + caption) that runs **100% in your browser** — nothing is uploaded, no account, no watermark, no ads. The clean, instant alternative to ezgif.

> Designed & built by Claude (Head of Design & Build). Human = Admin.

## Status
Phase **M1** — core flow **implemented and hardened**: drop a video → trim → export GIF, fully client-side.

For MP4/MOV the **worker does everything off the main thread**: it streams the file in slices
(never buffers the whole thing in RAM), demuxes with `mp4box.js`, **seeks to the keyframe before the
trim start** (so clipping 2s out of a 9-minute video doesn't decode 9 minutes), decodes with WebCodecs
`VideoDecoder` under **dequeue-event backpressure**, applies **rotation** from the track display matrix
(phone videos), resizes on an `OffscreenCanvas`, and encodes with `gifenc` (ordered Bayer dithering).
GIF frame delays come from **real frame timestamps** with drift correction, so variable / low-fps
sources play at the right speed. A seek-based `<video>` fallback (main thread) handles WebM, rotated
edge cases, and browsers without WebCodecs. Trimming is a dual-handle scrubber over a thumbnail
filmstrip with a loop-preview of the selected range. See `CLAUDE.md` and `docs/`.

### Files
- `index.html` — UI, trim scrubber, orchestration, main-thread seek fallback, CSP, accessibility.
- `worker.js` — streaming demux + decode + rotate + resize + `gifenc` encode (MP4 path) / encode-only
  (seek path). Loaded as `worker.js?<WORKER_V>` — **bump `WORKER_V` in `index.html` when you edit
  `worker.js`** (the query also versions its vendored `importScripts`, busting their caches too).
- `vendor/gifenc.js` (MIT) · `vendor/mp4box.all.min.js` (BSD-3) — vendored, **no CDN at runtime**.
  License texts: `vendor/gifenc.LICENSE.md`, `vendor/mp4box.LICENSE.txt`.

## Run (no build step in M1)
```bash
python3 -m http.server 8000   # → http://localhost:8000
```
Best in a **Chromium** browser (Chrome/Edge/Arc) for the fast WebCodecs path; **Safari/Firefox work too**
via the built-in `<video>`-seek fallback. Must be served over `http(s)` (the worker won't run from `file://`).

## Hosting & deploy
Clipframe is a fully static, no-backend site, so any static host works. Recommended:

**Repo on GitHub + hosting on Vercel** (or Cloudflare Pages). Why not GitHub Pages directly: it
can't set custom HTTP response headers, and we need one for clickjacking (`frame-ancestors` /
`X-Frame-Options`, which a `<meta>` CSP cannot express). Vercel/Cloudflare can, and auto-deploy from
the GitHub repo on push.

- **Vercel:** `vercel.json` (committed) already sets `X-Frame-Options: DENY`,
  `Content-Security-Policy: frame-ancestors 'none'`, `X-Content-Type-Options`, `Referrer-Policy`, and a
  locked-down `Permissions-Policy`, plus sane caching (HTML revalidates; `worker.js`/`vendor/*` cached).
  Point a custom domain (e.g. `clipframe.app`) at it. HTTPS is automatic (WebCodecs needs a secure context).
- **Cloudflare Pages / Netlify:** same headers via a `_headers` file:
  ```
  /*
    X-Frame-Options: DENY
    Content-Security-Policy: frame-ancestors 'none'
    X-Content-Type-Options: nosniff
    Referrer-Policy: no-referrer
    Permissions-Policy: camera=(), microphone=(), geolocation=(), browsing-topics=()
  ```

The in-page `<meta>` CSP (`default-src 'none'; connect-src 'none'`) is what makes the
*nothing-is-uploaded* promise verifiable; the deploy header only adds `frame-ancestors`, which `<meta>`
can't carry. The **Impressum** (§5 DDG) is filled in the *Privacy & legal* dialog. Don't commit test
media or `*.test.html` (already git-ignored).

## Docs
- `docs/DESIGN.md` — implementation spec + M1 scope + WebCodecs/gifenc tech notes.

## Hard rules
Privacy-by-design (nothing uploads, no accounts, no tracking/network) · no watermark/ads · original / MIT / OFL assets, vendored · stays "open index.html → runs" (Chromium) through M1 · speed is a feature.

## License
TBD (proprietary for now). Bundled libs keep their own licenses (e.g. gifenc — MIT).

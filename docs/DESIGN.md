# Clipframe — Design & Implementierungs-Spec

Implementierungs-orientiert. Voller Kontext: `MASTERPLAN.md`.

## Kern-Flow (User-Sicht)
1. Video **reinziehen** (Drag-Drop) oder auswählen → sofortige Vorschau (`<video>`).
2. **Trimmen**: Start/Ende per Slider/Scrubber (Live-Preview der Grenzen).
3. **Optionen**: FPS (z.B. 10/15/20/24), Breite/Skalierung (z.B. 320/480/original), Qualität/Dithering, optional Loop.
4. (M2) **Caption**: Meme-Text oben/unten oder frei platziert.
5. **Export GIF** → sofortiger Download (Blob). (M2: auch WebP/MP4.)
Alles **lokal**, sichtbar „nichts wird hochgeladen".

## M1 — Scope (genau das, nicht mehr)
- Video-Input (Drag-Drop + Picker), Vorschau.
- Trim (Start/Ende).
- Controls: FPS, Breite, Qualität.
- **Encode-Pipeline WebCodecs → gifenc → Download.**
- Privacy-Notiz sichtbar. Prefs in `localStorage`.
- Chromium-first; bei fehlendem WebCodecs klarer Hinweis (Fallback = M2).
- Saubere, schnelle, monochrom-moderne UI. **Speed-Gefühl ist Pflicht.**

## Encode-Pipeline (technisch)
```
File → <video>/Blob → WebCodecs VideoDecoder (decode frames in [trimStart, trimEnd] at target FPS)
     → for each frame: draw to OffscreenCanvas (resize to target width, optional caption)
     → getImageData → gifenc: quantize() palette + applyPalette() + GIFEncoder.writeFrame(delay=1000/fps)
     → encoder.finish() → Uint8Array → Blob('image/gif') → download (a[download])
```
- **Lib:** `gifenc` (MIT, schnell; `quantize`, `applyPalette`, `GIFEncoder`). **Vendored** (nicht per CDN, wegen Offline/Hard-Rule). 
- **Frame-Sampling:** Ziel-FPS bestimmt Frame-Abstand; bei langen Clips Frames begrenzen (z.B. Warnung > ~300 Frames) für Speicher/Tempo.
- **Performance:** Encoding im **Web Worker** halten (UI bleibt flüssig); Fortschrittsbalken. OffscreenCanvas wo möglich.
- **Speicher:** Frames streamen/sofort encoden, nicht alle im RAM sammeln (lange/HD-Clips).

## Browser-Support / Fallback
- WebCodecs: **Chrome/Edge/Arc** ✓. Safari 17+ teilweise, Firefox eingeschränkt.
- M1: Feature-Detect `window.VideoDecoder`; wenn fehlt → freundlicher „beste Erfahrung in Chrome"-Hinweis.
- M2-Fallback: `ffmpeg.wasm` (größer, langsamer, aber universell) für Nicht-WebCodecs-Browser.

## Stil
Monochrom-modern, ruhig, schnell. Großer Drop-Bereich, sofortige Vorschau, sichtbarer Fortschritt, ein klarer Export-Button. Kein Clutter, keine Ads, kein Wasserzeichen. Speed/Responsiveness ist Teil des Designs (vs. ezgifs Roundtrip).

## Später (M2+)
- Caption/Meme-Text (Top/Bottom/frei), Schriftauswahl (OFL).
- WebP/MP4-Export (`VideoEncoder`), Crop, Speed/Boomerang, Frame-Entfernen.
- Browser-Fallback (ffmpeg.wasm).
- SEO-Landingpages pro Format/Use-Case (programmatisch).
- PWA (installierbar, offline).
- Optional: On-Device-Auto-Captions (Whisper via transformers.js).

/* Clipframe — decode + GIF encode worker (v4).
   Everything heavy runs here, off the main thread.

   Mode A — WebCodecs fast path (MP4/MOV). Main posts the File handle; the worker
   streams it in slices (never the whole file in RAM), demuxes with mp4box.js
   (nextParsePosition jumps straight over mdat to find moov), seeks to the keyframe
   before trim start (seek(useRap) — validated: extraction starts at the RAP, and
   mp4box adjusts the offset past data already buffered), decodes with VideoDecoder
   under dequeue-event backpressure, applies tkhd-matrix rotation (phone videos),
   resizes on an OffscreenCanvas, and encodes with gifenc.
     main -> { type:'job', file, opts:{start,end,fps,width,maxColors,dither} }
     worker -> 'start'{target} -> 'progress'{encoded}... -> 'done'{buffer} | 'fallback'{message}

   Mode B — encode-only (seek fallback decodes via <video> on main, workers can't):
     main -> { type:'init', target, fps, maxColors, dither }
          -> { type:'frame', buffer, t } ...        // t = frame time in seconds
          -> { type:'finish', endT }
     worker -> 'progress'... -> 'done' | 'error'

   GIF timing: frames carry real timestamps; each frame's delay is the gap to the
   next one (correct for VFR/low-fps sources), quantized to GIF centiseconds with a
   running drift accumulator (a plain 1000/15→70ms rounding plays ~5% slow), and
   clamped to >=20ms (browsers snap tiny delays to 100ms).

   Vendor scripts inherit this worker's ?v= query so cache busting versions them too. */
"use strict";

const VQS = self.location.search || "";
importScripts("vendor/gifenc.js" + VQS);
const { GIFEncoder, quantize, applyPalette } = self.gifenc;

const MAX_FRAMES = 600;
const CHUNK = 2 * 1024 * 1024;
const DECODE_QUEUE_MAX = 24;

let mp4boxLoaded = false;
function ensureMp4box() {
  if (!mp4boxLoaded) { importScripts("vendor/mp4box.all.min.js" + VQS); mp4boxLoaded = true; }
}

// ========================= gifenc sink (shared) =========================
// Holds one pending frame; its delay is written when the NEXT frame arrives,
// so the delay equals the real gap between frames (VFR-correct).
let gif = null, GW = 0, GH = 0, GCOLORS = 256, GDITHER = true, GIDEAL = 100;
let pending = null;          // { index, t }
let writtenMs = 0, idealMs = 0, encoded = 0;

function beginGif(target, fps, maxColors, dither) {
  GW = target.w; GH = target.h;
  GIDEAL = 1000 / (fps || 10);
  GCOLORS = Math.max(2, Math.min(256, maxColors || 256));
  GDITHER = dither !== false;
  pending = null; writtenMs = 0; idealMs = 0; encoded = 0;
  gif = GIFEncoder();
}

// Ordered (Bayer 8x8) dithering — per-pixel deterministic, so video doesn't
// flicker frame-to-frame the way error-diffusion does.
const BAYER8 = [
   0,32, 8,40, 2,34,10,42,  48,16,56,24,50,18,58,26,
  12,44, 4,36,14,46, 6,38,  60,28,52,20,62,30,54,22,
   3,35,11,43, 1,33, 9,41,  51,19,59,27,49,17,57,25,
  15,47, 7,39,13,45, 5,37,  63,31,55,23,61,29,53,21
];
function clamp255(v){ return v < 0 ? 0 : (v > 255 ? 255 : v); }
function orderedDither(rgba, w, h, colors){
  const amp = (255 / Math.cbrt(colors)) * 0.55;
  for (let y = 0; y < h; y++){
    const row = (y & 7) * 8;
    let i = y * w * 4;
    for (let x = 0; x < w; x++, i += 4){
      const t = (BAYER8[row + (x & 7)] / 64 - 0.5) * amp;
      rgba[i]   = clamp255(rgba[i]   + t);
      rgba[i+1] = clamp255(rgba[i+1] + t);
      rgba[i+2] = clamp255(rgba[i+2] + t);
    }
  }
}

// Quantize a real-time gap to GIF centiseconds, absorbing rounding drift.
function quantizeDelay(gapMs) {
  idealMs += gapMs;
  let d = Math.round((idealMs - writtenMs) / 10) * 10;
  if (d < 20) d = 20;                      // browsers snap <20ms to 100ms
  writtenMs += d;
  return d;
}

function flushPending(gapMs) {
  if (!pending) return;
  gif.writeFrame(pending.index, GW, GH, {
    palette: pending.palette, delay: quantizeDelay(gapMs), repeat: 0
  });
  pending = null;
}

function encodeRGBA(buffer, tSec) {
  const rgba = new Uint8Array(buffer);
  const palette = quantize(rgba, GCOLORS, { format: "rgb565" });
  if (GDITHER) orderedDither(rgba, GW, GH, GCOLORS);
  const index = applyPalette(rgba, palette, "rgb565");
  if (pending) flushPending(Math.max(1, (tSec - pending.t) * 1000));
  pending = { index, palette, t: tSec };
  encoded++;
  self.postMessage({ type: "progress", encoded });
}

function finishGif(endT) {
  if (!gif) throw new Error("finish before init");
  if (pending) {
    const gap = (typeof endT === "number" && endT > pending.t) ? (endT - pending.t) * 1000 : GIDEAL;
    flushPending(gap);
  }
  gif.finish();
  const view = gif.bytesView();
  const out = new Uint8Array(view.length);
  out.set(view);
  gif = null;
  self.postMessage({ type: "done", buffer: out.buffer }, [out.buffer]);
}

function computeTarget(sw, sh, wantW) {
  if (!sw || !sh) { sw = sw || 320; sh = sh || 240; }
  let w = wantW > 0 ? wantW : sw;
  if (wantW === 0 && w > 640) w = 640;
  w = Math.max(2, Math.round(w));
  const h = Math.max(2, Math.round(w * sh / sw));
  return { w, h };
}

// ========================= message dispatch =========================
self.onmessage = (e) => {
  const m = e.data;
  try {
    if (m.type === "job") {
      job(m.file, m.opts);
    } else if (m.type === "init") {
      beginGif(m.target, m.fps, m.maxColors, m.dither);
    } else if (m.type === "frame") {
      encodeRGBA(m.buffer, m.t);
    } else if (m.type === "finish") {
      finishGif(m.endT);
    }
  } catch (err) {
    self.postMessage({ type: "error", message: String((err && err.message) || err) });
  }
};

// ========================= Mode A: streaming WebCodecs job =========================
async function job(file, opts) {
  let decoder = null, decodeErr = null;
  try {
    ensureMp4box();
    const mp4 = MP4Box.createFile();
    let readyInfo = null;
    mp4.onError = (err) => { decodeErr = decodeErr || new Error("mp4box: " + err); };
    mp4.onReady = (info) => { readyInfo = info; };

    const append = async (pos) => {
      const buf = await file.slice(pos, Math.min(pos + CHUNK, file.size)).arrayBuffer();
      buf.fileStart = pos;
      return mp4.appendBuffer(buf);
    };

    // --- phase 1: find moov. nextParsePosition jumps over mdat (validated). ---
    let pos = 0, guard = 0;
    while (!readyInfo && !decodeErr && pos < file.size && guard++ < 4096) {
      const next = await append(pos);
      pos = (typeof next === "number" && next > pos) ? next : pos + CHUNK;
    }
    if (decodeErr) throw decodeErr;
    if (!readyInfo) throw new Error("No MP4 structure found");

    // --- pick the real video track (largest area beats thumbnail/preview tracks) ---
    const tracks = (readyInfo.videoTracks || []).slice()
      .sort((a, b) => (b.video.width * b.video.height) - (a.video.width * a.video.height));
    const track = tracks[0];
    if (!track) throw new Error("No video track in this file.");

    // --- rotation from the tkhd display matrix (phone videos) ---
    const rot = matrixRotation(track.matrix);
    const srcW = track.video.width, srcH = track.video.height;
    const dispW = (rot % 180 === 90) ? srcH : srcW;
    const dispH = (rot % 180 === 90) ? srcW : srcH;
    const target = computeTarget(dispW, dispH, opts.width);

    // --- decoder config; description only for avcC/hvcC (AV1/VP9 in MP4 need none,
    //     and feeding them a vpcC/av1C box breaks otherwise-decodable files) ---
    const config = { codec: track.codec, codedWidth: srcW, codedHeight: srcH };
    const desc = avcHevcDescription(mp4, track);
    if (desc) config.description = desc;
    try {
      const support = await VideoDecoder.isConfigSupported(config);
      if (!support || !support.supported) throw new Error("unsupported");
    } catch (e) {
      throw new Error("Codec not supported here: " + (track.codec || "unknown"));
    }

    const canvas = new OffscreenCanvas(target.w, target.h);
    const ctx = canvas.getContext("2d", { willReadFrequently: true, alpha: false });
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
    // bake the rotation into the canvas transform once; getImageData reads raw pixels
    let drawW = target.w, drawH = target.h;
    if (rot === 90)      { ctx.translate(target.w, 0); ctx.rotate(Math.PI / 2);  drawW = target.h; drawH = target.w; }
    else if (rot === 180){ ctx.translate(target.w, target.h); ctx.rotate(Math.PI); }
    else if (rot === 270){ ctx.translate(0, target.h); ctx.rotate(-Math.PI / 2); drawW = target.h; drawH = target.w; }

    beginGif(target, opts.fps, opts.maxColors, opts.dither);
    self.postMessage({ type: "start", target });

    let accepted = 0, nextWanted = opts.start;
    const step = 1 / opts.fps;
    decoder = new VideoDecoder({
      output: (frame) => {
        try {
          const tSec = frame.timestamp / 1e6;
          if (tSec + 1e-4 >= nextWanted && tSec <= opts.end + 1e-4 && accepted < MAX_FRAMES) {
            const slotT = nextWanted;                  // grid slot this frame fills
            ctx.drawImage(frame, 0, 0, drawW, drawH);
            const img = ctx.getImageData(0, 0, target.w, target.h);
            encodeRGBA(img.data.buffer, slotT);
            accepted++;
            do { nextWanted += step; } while (nextWanted <= tSec);
          }
        } catch (err) { decodeErr = decodeErr || err; }
        finally { frame.close(); }
      },
      error: (err) => { decodeErr = decodeErr || err; }
    });
    decoder.configure(config);

    // --- demux -> bounded chunk queue (EncodedVideoChunk copies sample bytes,
    //     so demuxed sample storage can be released immediately) ---
    const chunkQ = [];
    let doneNeeded = false;
    mp4.onSamples = (id, user, samples) => {
      let lastNum = -1;
      for (const s of samples) {
        const cts = s.cts / s.timescale;
        lastNum = s.number;
        if (cts > opts.end + 0.8) { doneNeeded = true; continue; }  // +0.8s covers B-frame reorder
        chunkQ.push(new EncodedVideoChunk({
          type: s.is_sync ? "key" : "delta",
          timestamp: Math.round((s.cts / s.timescale) * 1e6),
          duration: Math.round((s.duration / s.timescale) * 1e6),
          data: s.data
        }));
      }
      if (lastNum >= 0) { try { mp4.releaseUsedSamples(track.id, lastNum); } catch (e) {} }
    };

    const supportsDequeue = "ondequeue" in VideoDecoder.prototype || "ondequeue" in decoder;
    const waitDequeue = () => new Promise(res => {
      if (supportsDequeue) {
        const h = () => { decoder.removeEventListener("dequeue", h); res(); };
        decoder.addEventListener("dequeue", h);
        setTimeout(() => { decoder.removeEventListener("dequeue", h); res(); }, 100);
      } else setTimeout(res, 16);
    });
    const pump = async () => {
      while (chunkQ.length && !decodeErr) {
        if (decoder.decodeQueueSize > DECODE_QUEUE_MAX) { await waitDequeue(); continue; }
        decoder.decode(chunkQ.shift());
      }
    };

    // --- phase 2: seek to the RAP before trim start, then read sequentially.
    //     (The appendBuffer return value is only meaningful for moov DISCOVERY —
    //      after moov it points at EOF, so we must NOT follow it here. Validated.) ---
    mp4.setExtractionOptions(track.id, null, { nbSamples: 60 });
    let feedPos = 0;
    try {
      const sk = mp4.seek(Math.max(0, opts.start), true);   // also adjusts past buffered data
      if (sk && typeof sk.offset === "number" && isFinite(sk.offset)) feedPos = sk.offset;
    } catch (e) { /* fall back to sequential from 0 */ }
    mp4.start();

    while (!doneNeeded && !decodeErr && feedPos < file.size && accepted < MAX_FRAMES) {
      await append(feedPos);
      feedPos += CHUNK;
      await pump();
    }
    mp4.stop();
    await pump();

    if (!decodeErr) { try { await decoder.flush(); } catch (e) { if (!doneNeeded && !accepted) decodeErr = decodeErr || e; } }
    try { decoder.close(); } catch (e) {}
    decoder = null;

    if (decodeErr) throw (decodeErr instanceof Error ? decodeErr : new Error(String(decodeErr)));
    if (accepted === 0) throw new Error("No frames decoded in the selected range");

    finishGif(opts.end);
  } catch (err) {
    if (decoder) { try { decoder.close(); } catch (e) {} }
    gif = null; pending = null;
    // anything wrong with the fast path -> main thread retries via <video> seek
    self.postMessage({ type: "fallback", message: String((err && err.message) || err) });
  }
}

// tkhd matrix (16.16 fixed point) -> nearest of 0/90/180/270 degrees
function matrixRotation(m) {
  if (!m || m.length < 5) return 0;
  const a = m[0] / 65536, b = m[1] / 65536;
  if (!a && !b) return 0;
  let deg = Math.round(Math.atan2(b, a) * 180 / Math.PI);
  deg = ((deg % 360) + 360) % 360;
  const snapped = [0, 90, 180, 270].reduce((best, x) =>
    Math.min(Math.abs(deg - x), 360 - Math.abs(deg - x)) <
    Math.min(Math.abs(deg - best), 360 - Math.abs(deg - best)) ? x : best, 0);
  return snapped;
}

// codec description for H.264/H.265 only (box payload minus the 8-byte header)
function avcHevcDescription(mp4, track) {
  const trak = mp4.getTrackById(track.id);
  const entries = trak && trak.mdia && trak.mdia.minf && trak.mdia.minf.stbl &&
                  trak.mdia.minf.stbl.stsd && trak.mdia.minf.stbl.stsd.entries;
  if (!entries) return null;
  for (const entry of entries) {
    const box = entry.avcC || entry.hvcC;
    if (box) {
      const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
      box.write(stream);
      return new Uint8Array(stream.buffer, 8);
    }
  }
  return null;
}

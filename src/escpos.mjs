// ESC/POS job builder for a single full-width picture.

import { BAND_ROWS } from "./config.mjs";

const ESC = 0x1b;
const GS = 0x1d;

const INIT = [ESC, 0x40]; // ESC @  — reset printer
const CENTER = [ESC, 0x61, 0x01]; // ESC a 1 — center alignment
const FEED = (n) => [ESC, 0x64, n]; // ESC d n — feed n lines
const FULL_CUT = [GS, 0x56, 0x00]; // GS V 0 — full cut

const DOTS_PER_MM = 203 / 25.4; // 203 dpi printer

// One GS v 0 raster band. `bits` holds `rows` rows of `bytesPerRow` bytes.
function rasterBand(bits, bytesPerRow, rows) {
  return Buffer.concat([
    Buffer.from([
      GS, 0x76, 0x30, 0x00, // GS v 0, mode 0 (normal)
      bytesPerRow & 0xff, (bytesPerRow >> 8) & 0xff, // xL, xH (bytes per row)
      rows & 0xff, (rows >> 8) & 0xff, // yL, yH (rows in this band)
    ]),
    bits,
  ]);
}

// Split the full packed bitmap into bands of BAND_ROWS and emit one command each.
function rasterCommand(bits, widthPx, heightPx) {
  const bytesPerRow = Math.ceil(widthPx / 8);
  const out = [];
  for (let y = 0; y < heightPx; y += BAND_ROWS) {
    const rows = Math.min(BAND_ROWS, heightPx - y);
    const slice = bits.subarray(y * bytesPerRow, (y + rows) * bytesPerRow);
    out.push(rasterBand(slice, bytesPerRow, rows));
  }
  return Buffer.concat(out);
}

// A blank (all-white) raster `heightDots` tall. We feed write-space by *printing*
// empty rows rather than ESC J / ESC d feed commands, because this printer
// honors raster height exactly (it's the same path as the photo) whereas it
// under-delivers dot/line feeds.
function blankRaster(widthPx, heightDots) {
  if (heightDots <= 0) return Buffer.alloc(0);
  const bytesPerRow = Math.ceil(widthPx / 8);
  return rasterCommand(Buffer.alloc(bytesPerRow * heightDots), widthPx, heightDots);
}

/**
 * Build the full ESC/POS job: reset, center, the banded raster, an optional
 * blank "write space" strip (polaroid-style, for handwriting), feed and cut.
 * @param {{ widthPx:number, heightPx:number, bits:Buffer }} processed
 * @param {{ captionMm?: number }} [opts]
 * @returns {Buffer}
 */
export function buildJob({ widthPx, heightPx, bits }, { captionMm = 0 } = {}) {
  return Buffer.concat([
    Buffer.from(INIT),
    Buffer.from(CENTER),
    rasterCommand(bits, widthPx, heightPx),
    blankRaster(widthPx, Math.round(captionMm * DOTS_PER_MM)), // handwriting strip
    Buffer.from(FEED(4)), // margin so the cut clears the head-to-cutter gap
    Buffer.from(FULL_CUT),
  ]);
}

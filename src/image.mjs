// Image -> 1-bit thermal raster.
//
// Pipeline (adapted from amigo-la-douve's buildLogoRaster): sharp loads the
// image, honors EXIF orientation, optionally center-crops to a square, resizes
// to the printable dot-width, flattens transparency onto white, and converts to
// grayscale. We then turn the grayscale buffer into 1 bit per dot (1 = black =
// print), either by Floyd–Steinberg dithering or a hard threshold.

import sharp from "sharp";

export const clamp01 = (n) => Math.min(1, Math.max(0, n));

// Build the grayscale raw buffer for a given orientation/crop, at PRINT_WIDTH.
//
// `offset` (0..1) slides the square crop window along the image's long axis when
// the source isn't already square: 0 = top/left, 0.5 = centered, 1 = bottom/right.
// Returns `panAxis` ("x" | "y" | null) so the caller knows which arrows reframe.
async function rasterizeGray(path, { width, square, rotate, offset }) {
  // Stage 1: bake EXIF orientation + any manual rotation into a raw buffer so we
  // know the true post-orientation pixel dimensions before cropping.
  let pipe = sharp(path).rotate(); // EXIF auto-orient
  if (rotate) pipe = pipe.rotate(rotate); // manual 90° steps
  const baked = await pipe
    .flatten({ background: { r: 255, g: 255, b: 255 } }) // drop alpha onto white
    .raw()
    .toBuffer({ resolveWithObject: true });

  const W0 = baked.info.width;
  const H0 = baked.info.height;
  const src = sharp(baked.data, {
    raw: { width: W0, height: H0, channels: baked.info.channels },
  });

  let region = src;
  let panAxis = null;

  if (square && W0 !== H0) {
    // Extract a square window we can slide along the long axis.
    const side = Math.min(W0, H0);
    const maxOff = Math.max(W0, H0) - side;
    panAxis = W0 > H0 ? "x" : "y";
    const off = Math.round(clamp01(offset) * maxOff);
    region = src.extract({
      left: panAxis === "x" ? off : 0,
      top: panAxis === "y" ? off : 0,
      width: side,
      height: side,
    });
  }

  const resized = square
    ? region.resize({ width })
    : region.resize({ width, fit: "inside" });

  const { data, info } = await resized
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return { data, width: info.width, height: info.height, channels: info.channels, panAxis };
}

// Floyd–Steinberg error diffusion over a single-channel grayscale buffer.
// Returns a Uint8Array of 0/1 (1 = black). Operates on a Float copy so error
// can push values outside 0..255 before being clamped at output time.
function ditherFloydSteinberg(gray, width, height) {
  const buf = Float32Array.from(gray); // working copy, one value per pixel
  const out = new Uint8Array(width * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const old = buf[i];
      const newVal = old < 128 ? 0 : 255;
      out[i] = newVal === 0 ? 1 : 0; // 1 = black/print
      const err = old - newVal;

      // Distribute the quantization error to neighbours (7/16, 3/16, 5/16, 1/16).
      if (x + 1 < width) buf[i + 1] += (err * 7) / 16;
      if (y + 1 < height) {
        if (x > 0) buf[i + width - 1] += (err * 3) / 16;
        buf[i + width] += (err * 5) / 16;
        if (x + 1 < width) buf[i + width + 1] += (err * 1) / 16;
      }
    }
  }
  return out;
}

// Hard threshold: dark pixels print.
function thresholdMono(gray, width, height) {
  const out = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) out[i] = gray[i] < 128 ? 1 : 0;
  return out;
}

// Pack a 0/1 mono buffer into MSB-first bytes, bytesPerRow per row.
function packBits(mono, width, height) {
  const bytesPerRow = Math.ceil(width / 8);
  const bits = Buffer.alloc(bytesPerRow * height);
  for (let y = 0; y < height; y++) {
    for (let bx = 0; bx < bytesPerRow; bx++) {
      let byte = 0;
      for (let bit = 0; bit < 8; bit++) {
        const x = bx * 8 + bit;
        if (x < width && mono[y * width + x]) byte |= 0x80 >> bit;
      }
      bits[y * bytesPerRow + bx] = byte;
    }
  }
  return bits;
}

// Render a 0/1 mono buffer to a PNG (black on white) for the terminal preview.
async function monoToPng(mono, width, height) {
  const rgb = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    const v = mono[i] ? 0 : 255;
    rgb[i * 3] = rgb[i * 3 + 1] = rgb[i * 3 + 2] = v;
  }
  return sharp(rgb, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

/**
 * Process an image file into a printable thermal raster.
 *
 * @param {string} path
 * @param {{ width:number, square:boolean, mode:"dither"|"threshold", rotate?:number, offset?:number }} opts
 * @returns {Promise<{ widthPx:number, heightPx:number, bits:Buffer, previewPng:Buffer, panAxis:("x"|"y"|null) }>}
 */
export async function processImage(path, { width, square, mode, rotate = 0, offset = 0.5 }) {
  const { data, width: w, height: h, panAxis } = await rasterizeGray(path, { width, square, rotate, offset });

  // Sharp grayscale raw is single-channel, so stride is 1; guard anyway.
  const gray = data.length === w * h ? data : sampleChannel(data, w, h, data.length / (w * h));

  const mono =
    mode === "threshold"
      ? thresholdMono(gray, w, h)
      : ditherFloydSteinberg(gray, w, h);

  const bits = packBits(mono, w, h);
  const previewPng = await monoToPng(mono, w, h);

  return { widthPx: w, heightPx: h, bits, previewPng, panAxis };
}

// Fallback: pull the first channel if the buffer isn't single-channel.
function sampleChannel(data, width, height, channels) {
  const c = Math.round(channels);
  const out = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) out[i] = data[i * c];
  return out;
}

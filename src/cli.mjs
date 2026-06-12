#!/usr/bin/env node
// funprint — drag-drop a picture into your terminal and print it on an 80mm (or
// 58mm) ESC/POS thermal receipt printer. Cross-platform: macOS, Linux, Windows.

import "./force-color.mjs"; // must precede the terminal-image import below
import readline from "node:readline";
import { stdin, stdout, platform } from "node:process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import terminalImage from "terminal-image";

import { PRINT_WIDTH } from "./config.mjs";
import { processImage, clamp01 } from "./image.mjs";
import { buildJob } from "./escpos.mjs";
import { printBytes, dryRun, waitForJob, isPrinterConnected, resolvePrinter } from "./print.mjs";
import { printSplash, wordmark } from "./splash.mjs";

const DRY_RUN = process.argv.includes("--dry-run");
let jobCounter = 0;
const PAN_STEP = 0.12; // how far each arrow press slides the crop window
const CAPTION_PRESETS = [0, 40, 80]; // blank write-space strip options, in mm

// Selectable paper formats (printable dot-width). 58mm→384, 80mm→576 cover
// virtually all thermal receipt printers. FUNPRINT_WIDTH adds/selects a custom one.
const PAPER_PRESETS = [
  { label: "58mm", dots: 384 },
  { label: "80mm", dots: 576 },
];
if (!PAPER_PRESETS.some((p) => p.dots === PRINT_WIDTH)) {
  PAPER_PRESETS.push({ label: `${PRINT_WIDTH}px`, dots: PRINT_WIDTH });
  PAPER_PRESETS.sort((a, b) => a.dots - b.dots);
}
let paperIdx = Math.max(0, PAPER_PRESETS.findIndex((p) => p.dots === PRINT_WIDTH));

// ── tiny ANSI helpers ───────────────────────────────────────
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
};
const paint = (color, s) => `${color}${s}${c.reset}`;

// Cache the connection check briefly so rapid re-renders don't shell out on
// every keypress. `connected` is true / false / null (unknown).
let connCache = { t: -Infinity, connected: null };
async function connectionDot() {
  const now = Date.now();
  if (now - connCache.t > 2000) {
    connCache = { t: now, connected: await isPrinterConnected().catch(() => null) };
  }
  const v = connCache.connected;
  if (v === true) return paint(c.green, "●") + paint(c.dim, " connected");
  if (v === false) return paint(c.red, "●") + paint(c.dim, " not connected");
  return paint(c.dim, "● status unknown");
}

async function banner() {
  // Compact FUN/PRINT wordmark (a short version of the startup splash) plus the
  // live printer + connection status line.
  const dot = await connectionDot();
  const printer = (await resolvePrinter().catch(() => null)) || "(no printer found)";

  stdout.write(
    "\n" +
      wordmark() +
      "\n" +
      paint(c.dim, `  printer: ${printer} `) + dot +
      paint(c.dim, DRY_RUN ? "   [DRY RUN]" : "") + "\n\n",
  );
}

// ── input helpers ───────────────────────────────────────────

// Prompt for a line of text (cooked mode).
function promptLine(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: stdin, output: stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

// Wait for a single keypress (raw mode). Returns a lowercase name.
function readKey() {
  return new Promise((resolve) => {
    readline.emitKeypressEvents(stdin);
    const wasRaw = stdin.isRaw;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    const onKey = (str, key) => {
      stdin.removeListener("keypress", onKey);
      if (stdin.isTTY) stdin.setRawMode(wasRaw || false);
      stdin.pause();
      if (key && key.ctrl && key.name === "c") resolve("q");
      else resolve((key && key.name) || (str || "").toLowerCase());
    };
    stdin.on("keypress", onKey);
  });
}

// Turn a dragged/pasted path into a real filesystem path.
function cleanPath(raw) {
  let p = raw.trim();
  if (!p) return p;
  // Strip one layer of surrounding matching quotes.
  if ((p.startsWith("'") && p.endsWith("'")) || (p.startsWith('"') && p.endsWith('"'))) {
    p = p.slice(1, -1);
  }
  // file:// URL (with percent-encoding) — e.g. dragged from some apps.
  if (p.startsWith("file://")) {
    try {
      p = decodeURIComponent(new URL(p).pathname);
      if (platform === "win32" && /^\/[A-Za-z]:/.test(p)) p = p.slice(1); // "/C:/…" → "C:/…"
    } catch {
      /* fall through */
    }
  }
  // On POSIX, terminals escape spaces etc. as "\ "; unescape them. NOT on Windows,
  // where backslashes are path separators (C:\Users\… must stay intact).
  if (platform !== "win32") p = p.replace(/\\(.)/g, "$1");
  return p.trim();
}

// ── preview ─────────────────────────────────────────────────

async function showPreview(processed, state) {
  stdout.write("\x1b[2J\x1b[H"); // clear screen, home
  await banner();
  const PREVIEW_COLS = 44; // requested render width for the photo
  const art = await terminalImage.buffer(processed.previewPng, { width: PREVIEW_COLS });
  stdout.write(art.endsWith("\n") ? art : art + "\n");

  // Show the write-space as a proportionally-sized empty frame under the photo.
  if (state.caption > 0) {
    const cols = Math.min(PREVIEW_COLS, stdout.columns || PREVIEW_COLS);
    const w = Math.max(2, cols - 2); // inner width so the frame matches the photo
    const DOTS_PER_MM = 203 / 25.4;
    let rows = Math.round((state.caption * DOTS_PER_MM * cols) / (2 * processed.widthPx));
    rows = Math.max(1, Math.min(rows, 18));
    const label = " ✎ write here";
    const firstMid = "│" + label + " ".repeat(Math.max(0, w - [...label].length)) + "│";
    const mid = "│" + " ".repeat(w) + "│";
    const box = [
      "╭" + "─".repeat(w) + "╮",
      firstMid,
      ...Array(Math.max(0, rows - 1)).fill(mid),
      "╰" + "─".repeat(w) + "╯",
    ].join("\n");
    stdout.write(paint(c.dim, box) + "\n");
  }

  // Reframe hint only when the source isn't square (there's something to slide).
  const arrows = processed.panAxis === "x" ? "←/→" : processed.panAxis === "y" ? "↑/↓" : null;
  const reframe = arrows
    ? paint(c.bold, `  [${arrows}]`) + " reframe    "
    : "  ";

  stdout.write(
    "\n" +
      paint(c.yellow, `  ${PAPER_PRESETS[paperIdx].label}`) +
      paint(c.dim, ` ${processed.widthPx}×${processed.heightPx}px  ·  `) +
      paint(c.yellow, state.square ? "square crop" : "full image") +
      paint(c.dim, "  ·  ") +
      paint(c.yellow, state.mode === "dither" ? "Floyd–Steinberg dither" : "hard threshold") +
      paint(c.dim, state.rotate ? `  ·  rotated ${state.rotate}°` : "") +
      paint(c.dim, arrows ? `  ·  reframe ${Math.round(state.offset * 100)}%` : "") +
      paint(c.dim, state.caption ? `  ·  ✎ ${state.caption}mm write space` : "") +
      "\n\n" +
      reframe +
      paint(c.bold, "[P]") + " print    " +
      paint(c.bold, "[S]") + " paper    " +
      paint(c.bold, "[F]") + " " + (state.square ? "→ full width" : "→ square") + "    " +
      paint(c.bold, "[W]") + " write space    " +
      paint(c.bold, "[D]") + " " + (state.mode === "dither" ? "→ threshold" : "→ dither") + "    " +
      paint(c.bold, "[R]") + " rotate    " +
      paint(c.bold, "[N]") + " new    " +
      paint(c.bold, "[Q]") + " quit\n\n",
  );
}

// ── main loop ───────────────────────────────────────────────

async function loadAndShow(path, state) {
  stdout.write(paint(c.dim, "  processing…\n"));
  state.processed = await processImage(path, {
    width: PAPER_PRESETS[paperIdx].dots,
    square: state.square,
    mode: state.mode,
    rotate: state.rotate,
    offset: state.offset,
  });
  await showPreview(state.processed, state);
}

async function doPrint(state) {
  const job = buildJob(state.processed, { captionMm: state.caption });
  if (DRY_RUN) {
    const file = join(tmpdir(), `funprint-${++jobCounter}.escpos`);
    await dryRun(job, file);
    stdout.write(paint(c.green, `\n  ✓ dry run — ${job.length} bytes written to ${file}\n\n`));
    return;
  }

  stdout.write(paint(c.dim, "\n  queued…"));
  const jobId = await printBytes(job);
  const result = await waitForJob(jobId);
  connCache = { t: -Infinity, connected: null }; // force a fresh dot next render

  if (result === "printed") {
    stdout.write(paint(c.green, "  ✓ printed! 🎉\n\n"));
  } else if (result === "offline") {
    stdout.write(
      paint(c.red, `\n  ⚠ printer offline — job ${jobId} is queued.\n`) +
        paint(c.dim, `    Plug in / power on the printer and it will print automatically.\n\n`),
    );
  } else if (result === "timeout") {
    stdout.write(paint(c.yellow, `\n  … still printing — job ${jobId} is in the queue; check the printer.\n\n`));
  } else {
    stdout.write(paint(c.green, "  ✓ sent.\n\n"));
  }
}

async function main() {
  // Fancy receipt-art splash once on load, with the real printer + status baked in.
  const [printerName, connected] = await Promise.all([
    resolvePrinter().catch(() => null),
    isPrinterConnected().catch(() => null),
  ]);
  printSplash({ printerName, connected, dots: PAPER_PRESETS[paperIdx].dots });

  while (true) {
    const raw = await promptLine(
      paint(c.cyan, "  Drag an image here and press Enter") + paint(c.dim, " (q to quit): "),
    );
    const answer = raw.trim();
    if (answer === "" ) continue;
    if (answer.toLowerCase() === "q") break;

    const path = cleanPath(raw);
    if (!existsSync(path)) {
      stdout.write(paint(c.red, `  ✗ not found: ${path}\n\n`));
      continue;
    }
    try {
      await sharp(path).metadata(); // validates it's a readable image
    } catch {
      stdout.write(paint(c.red, `  ✗ not a supported image: ${path}\n\n`));
      continue;
    }

    // Per-image interaction state.
    const state = { square: true, mode: "dither", rotate: 0, offset: 0.5, caption: 0, processed: null };
    try {
      await loadAndShow(path, state);
    } catch (err) {
      stdout.write(paint(c.red, `  ✗ failed to process: ${err.message}\n\n`));
      continue;
    }

    let nextImage = false;
    while (!nextImage) {
      const key = await readKey();
      switch (key) {
        case "p":
        case "return":
        case "enter":
          try {
            await doPrint(state);
          } catch (err) {
            stdout.write(paint(c.red, `  ✗ print failed: ${err.message}\n\n`));
          }
          nextImage = true;
          break;
        case "s":
          paperIdx = (paperIdx + 1) % PAPER_PRESETS.length;
          await loadAndShow(path, state);
          break;
        case "f":
          state.square = !state.square;
          await loadAndShow(path, state);
          break;
        case "w": {
          // Caption space doesn't change the image — just re-render the menu.
          const i = CAPTION_PRESETS.indexOf(state.caption);
          state.caption = CAPTION_PRESETS[(i + 1) % CAPTION_PRESETS.length];
          await showPreview(state.processed, state);
          break;
        }
        case "d":
          state.mode = state.mode === "dither" ? "threshold" : "dither";
          await loadAndShow(path, state);
          break;
        case "r":
          state.rotate = (state.rotate + 90) % 360;
          state.offset = 0.5; // crop axis flips on rotation — recenter
          await loadAndShow(path, state);
          break;
        case "left":
        case "up": {
          const axis = key === "left" ? "x" : "y";
          if (state.processed.panAxis === axis) {
            state.offset = clamp01(state.offset - PAN_STEP);
            await loadAndShow(path, state);
          }
          break;
        }
        case "right":
        case "down": {
          const axis = key === "right" ? "x" : "y";
          if (state.processed.panAxis === axis) {
            state.offset = clamp01(state.offset + PAN_STEP);
            await loadAndShow(path, state);
          }
          break;
        }
        case "n":
          nextImage = true;
          break;
        case "q":
          stdout.write("\n  bye 👋\n\n");
          process.exit(0);
          break;
        default:
          break;
      }
    }
  }

  stdout.write("\n  bye 👋\n\n");
  process.exit(0);
}

main().catch((err) => {
  stdout.write(paint(c.red, `\nfatal: ${err.stack || err.message}\n`));
  process.exit(1);
});

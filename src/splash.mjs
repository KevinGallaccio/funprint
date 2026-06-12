// funprint startup splash — truecolor ANSI receipt art.
// Original art by Fable; adapted to take the live printer name + connection state.
// Shown once when the app loads; the interactive header lives in cli.mjs.

const PAPER = [247, 243, 232];
const INK = [38, 34, 30];
const FAINT = [150, 144, 132];
const SHELL = [56, 54, 62];
const SHELL_TXT = [186, 182, 192];
const SLOT = [18, 17, 20];
const GREEN = [86, 222, 128];
const PINK = [255, 64, 129];
const AMBER = [255, 176, 46];

const W = 34; // receipt width in chars
const MARGIN = 3; // printer overhangs the paper by this much per side

// ---------- tiny segment renderer ----------------------------------------
// a line is an array of segments: [text, fg|null, bg|null]
const lines = [];
const seg = (t, f = null, b = null) => [t, f, b];

function toAnsi(line) {
  let out = "";
  for (const [t, f, b] of line) {
    let pre = "";
    if (f) pre += `\x1b[38;2;${f[0]};${f[1]};${f[2]}m`;
    if (b) pre += `\x1b[48;2;${b[0]};${b[1]};${b[2]}m`;
    out += pre + t + (pre ? "\x1b[0m" : "");
  }
  return out;
}

// ---------- helpers --------------------------------------------------------
const lerp = (a, b, t) => Math.round(a + (b - a) * t);
const grad = (c1, c2, t) => [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];

// paper row: content segments padded to W, with optional decor at the sides
function paperRow(content, decorL = null, decorR = null) {
  const len = content.reduce((n, s) => n + s[0].length, 0);
  const padL = Math.floor((W - len) / 2);
  const padR = W - len - padL;
  const row = [];
  row.push(decorL ?? seg(" ".repeat(MARGIN)));
  row.push(seg(" ".repeat(padL), null, PAPER));
  row.push(...content.map(([t, f, b]) => seg(t, f ?? INK, b ?? PAPER)));
  row.push(seg(" ".repeat(padR), null, PAPER));
  row.push(decorR ?? seg(" ".repeat(MARGIN)));
  lines.push(row);
}

// ---------- 4x5 block font -------------------------------------------------
const FONT = {
  F: ["████", "█   ", "███ ", "█   ", "█   "],
  U: ["█  █", "█  █", "█  █", "█  █", " ██ "],
  N: ["█  █", "██ █", "█ ██", "█  █", "█  █"],
  P: ["███ ", "█  █", "███ ", "█   ", "█   "],
  R: ["███ ", "█  █", "███ ", "█ █ ", "█  █"],
  I: ["████", " ██ ", " ██ ", " ██ ", "████"],
  T: ["████", " ██ ", " ██ ", " ██ ", " ██ "],
};

function wordRows(word) {
  const totalW = word.length * 5 - 1;
  for (let r = 0; r < 5; r++) {
    const content = [];
    let x = 0;
    for (let li = 0; li < word.length; li++) {
      const glyphRow = FONT[word[li]][r] + (li < word.length - 1 ? " " : "");
      for (const ch of glyphRow) {
        if (ch === "█") content.push(seg("█", grad(PINK, AMBER, x / (totalW - 1)), PAPER));
        else content.push(seg(" ", null, PAPER));
        x++;
      }
    }
    paperRow(content);
  }
}

// ---------- the dithered "photo" (sun over the sea, Bayer-ordered) ---------
const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

function photoRows() {
  const PW = 30, PH = 14; // pixels (half-blocks -> PH/2 text rows)
  const horizon = 8;
  const px = [];
  for (let y = 0; y < PH; y++) {
    px.push([]);
    for (let x = 0; x < PW; x++) {
      let v; // 0 = white paper, 1 = black ink
      if (y < horizon) {
        v = 0.12 + 0.02 * y; // light sky, sparse dots
        const dx = x - 22, dy = (y - 3) * 1.6;
        if (dx * dx + dy * dy < 9) v = 1; // setting sun, solid ink
      } else if (y === horizon) {
        v = 0.95; // horizon line
      } else {
        v = 0.34 + 0.03 * (y - horizon); // sea
        if ((Math.floor(x * 1.3) + y * 5) % 7 < 2) v += 0.4; // waves
        if (Math.abs(x - 22) < 2.2 - (y - horizon) * 0.22) v = y % 2 ? 0.95 : 0.1; // sun reflection
      }
      const t = (BAYER[y % 4][x % 4] + 0.5) / 16;
      px[y][x] = v > t ? INK : PAPER;
    }
  }
  for (let y = 0; y < PH; y += 2) {
    const content = [];
    for (let x = 0; x < PW; x++) content.push(seg("▀", px[y][x], px[y + 1][x]));
    paperRow(content);
  }
}

// ---------- build the banner ------------------------------------------------
function build({ printerName, connected, dots }) {
  lines.length = 0;
  const FACE = W + MARGIN * 2;

  // printer body
  lines.push([seg(" " + "▄".repeat(FACE - 2), SHELL)]);

  // label (real printer name) + live status, padded to the printer face width
  const label = " " + (printerName || "thermal printer").slice(0, 16).toUpperCase();
  const statusText =
    connected === true ? " connected " : connected === false ? " offline " : " ready ";
  const dotColor = connected === true ? GREEN : connected === false ? PINK : FAINT;
  const gap = Math.max(1, FACE - label.length - 1 - statusText.length);
  lines.push([
    seg(label, SHELL_TXT, SHELL),
    seg(" ".repeat(gap), null, SHELL),
    seg("●", dotColor, SHELL),
    seg(statusText, SHELL_TXT, SHELL),
  ]);

  // the slot, paper peeking out
  lines.push([
    seg(" ".repeat(MARGIN), null, SHELL),
    seg("▄".repeat(W), PAPER, SLOT),
    seg(" ".repeat(MARGIN), null, SHELL),
  ]);

  // receipt — first row flanked by the printer's lower lip
  paperRow([seg("· · INSTANT PHOTO · ·", FAINT)], seg("▀".repeat(MARGIN), SHELL), seg("▀".repeat(MARGIN), SHELL));
  paperRow([]);
  wordRows("FUN");
  paperRow([]);
  wordRows("PRINT");
  paperRow([]);
  paperRow([seg("—".repeat(W - 6), FAINT)]);
  paperRow([]);
  photoRows();
  paperRow([]);
  paperRow([seg("—".repeat(W - 6), FAINT)]);
  paperRow([seg(` 1× PHOTO  ${dots} dots ······· OK`, INK)]);
  paperRow([seg(" DITHER    floyd–steinberg  ", INK), seg("ON", [20, 140, 70])]);
  paperRow([]);
  paperRow([seg("█▐ ██▌▐ █ ▐██▌ █▌▐█ ██ ▌█▐ █", INK)]);
  paperRow([seg("· merci ·", FAINT)]);
  // torn edge
  const tear = [seg(" ".repeat(MARGIN))];
  for (let i = 0; i < W; i++) tear.push(seg(i % 2 ? "▄" : "▀", PAPER));
  lines.push(tear);
}

/**
 * Print the startup splash.
 * @param {{ printerName?: string, connected?: boolean|null, dots?: number }} [opts]
 */
export function printSplash({ printerName, connected = null, dots = 576 } = {}) {
  build({ printerName, connected, dots });
  process.stdout.write("\n" + lines.map(toAnsi).join("\n") + "\n\n");
}

/**
 * Just the FUN/PRINT wordmark on paper, as an ANSI string — a compact header
 * for the interactive screens (stacked gradient block caps, like the splash).
 */
export function wordmark() {
  lines.length = 0;
  paperRow([]); // a little cream breathing room
  wordRows("FUN");
  paperRow([]);
  wordRows("PRINT");
  paperRow([]);
  return lines.map(toAnsi).join("\n");
}

// Standalone preview: `node src/splash.mjs`
if (import.meta.url === `file://${process.argv[1]}`) {
  printSplash({ printerName: "Printer_POS_80", connected: true, dots: 576 });
}

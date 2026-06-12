// funprint configuration.
//
// The MUNBYN P047 is registered with CUPS as the queue below (system default,
// connected over usb://Printer/POS-80). We send raw ESC/POS through `lp` — no
// QZ Tray needed.

// Printer queue name. If unset, funprint resolves the OS default printer at
// runtime (see resolvePrinter in print.mjs), so it works on any machine.
export const PRINTER = process.env.FUNPRINT_PRINTER || null;

// Printable dot-width. 80mm paper prints ~72mm = 576 dots at 203 dpi.
// Must be a multiple of 8 (one bit per dot, packed into bytes). If 576 clips
// the paper edge on your unit, drop to 512 or 384 via FUNPRINT_WIDTH.
export const PRINT_WIDTH = (() => {
  const w = Number.parseInt(process.env.FUNPRINT_WIDTH || "576", 10);
  if (!Number.isFinite(w) || w <= 0) return 576;
  return w - (w % 8); // round down to a multiple of 8
})();

// Rows per GS v 0 band. Tall images are split into bands so we never overrun
// the printer's image buffer in a single command.
export const BAND_ROWS = 128;

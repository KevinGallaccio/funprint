// Printer transport — dispatches to the OS-specific implementation and exposes
// a small platform-agnostic API to the CLI. Reports real status (queued →
// printed / offline) by watching the queued job and the device.

import { platform } from "node:process";
import { writeFile } from "node:fs/promises";
import { PRINTER } from "./config.mjs";
import * as darwin from "./platform/darwin.mjs";
import * as linux from "./platform/linux.mjs";
import * as win32 from "./platform/win32.mjs";

const impl = platform === "win32" ? win32 : platform === "linux" ? linux : darwin;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let resolved; // cached resolved printer name (or null)

/** The printer queue to use: FUNPRINT_PRINTER if set, else the OS default. */
export async function resolvePrinter() {
  if (PRINTER) return PRINTER;
  if (resolved === undefined) resolved = await impl.resolveDefaultPrinter();
  return resolved;
}

/**
 * Submit a raw ESC/POS job. Resolves with a job id (or null). Note: this only
 * means the job was *accepted* — use waitForJob to learn whether it printed.
 * @param {Buffer} buf
 */
export async function printBytes(buf) {
  const name = await resolvePrinter();
  if (!name) {
    throw new Error("No printer found. Set FUNPRINT_PRINTER to your queue name.");
  }
  return impl.sendRaw(name, buf);
}

/**
 * Wait for a queued job to actually print.
 *   "printed" | "offline" | "timeout" | "unknown"
 * @param {string|null} jobId
 */
export async function waitForJob(jobId, { timeoutMs = 25000, intervalMs = 400 } = {}) {
  if (!jobId) return "unknown";
  const name = await resolvePrinter();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!(await impl.isJobPending(name, jobId).catch(() => false))) return "printed";
    if ((await impl.isConnected(name).catch(() => null)) === false) return "offline";
    await sleep(intervalMs);
  }
  return "timeout";
}

/** true (connected) / false (offline) / null (unknown — platform can't tell). */
export async function isPrinterConnected() {
  const name = await resolvePrinter();
  if (!name) return null;
  return impl.isConnected(name).catch(() => null);
}

/** Write the raw job to disk instead of printing (for --dry-run). */
export async function dryRun(buf, file) {
  await writeFile(file, buf);
}

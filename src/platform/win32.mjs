// Windows printer transport. Raw bytes go through winspool via a bundled
// PowerShell helper (scripts/raw-print.ps1); status/connection use the Print
// Management + WMI cmdlets.

import { execFile } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const PS1 = join(here, "..", "..", "scripts", "raw-print.ps1");
let counter = 0;

// Run a PowerShell command/script with a non-interactive, unrestricted profile.
const ps = (args) =>
  run("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", ...args], {
    maxBuffer: 8 << 20,
    windowsHide: true,
  });

// Escape a value for embedding inside a single-quoted PowerShell string.
const q = (s) => String(s).replace(/'/g, "''");

export async function resolveDefaultPrinter() {
  try {
    const { stdout } = await ps([
      "-Command",
      "(Get-CimInstance Win32_Printer -Filter 'Default = true').Name",
    ]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function sendRaw(printer, buf) {
  const tmp = join(tmpdir(), `funprint-${process.pid}-${counter++}.bin`);
  await writeFile(tmp, buf);
  try {
    const { stdout } = await ps(["-File", PS1, "-PrinterName", printer, "-Path", tmp]);
    const m = stdout.match(/JOBID:(\d+)/);
    return m ? m[1] : null;
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

export async function isJobPending(printer, jobId) {
  try {
    const { stdout } = await ps([
      "-Command",
      `@(Get-PrintJob -PrinterName '${q(printer)}' -ErrorAction SilentlyContinue | ` +
        `Where-Object { $_.Id -eq ${Number(jobId)} }).Count`,
    ]);
    return Number.parseInt(stdout.trim() || "0", 10) > 0;
  } catch {
    return false;
  }
}

export async function isConnected(printer) {
  try {
    const { stdout } = await ps([
      "-Command",
      `(Get-CimInstance Win32_Printer -Filter "Name='${q(printer)}'").WorkOffline`,
    ]);
    const v = stdout.trim().toLowerCase();
    if (v === "true") return false; // WorkOffline = true → not reachable
    if (v === "false") return true;
    return null;
  } catch {
    return null;
  }
}

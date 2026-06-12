// Linux printer transport (CUPS). Same lp/lpstat path as macOS; the only
// difference is the connection check, since there's no ioreg.

import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export async function resolveDefaultPrinter() {
  try {
    const { stdout } = await run("lpstat", ["-d"]);
    const m = stdout.match(/:\s*(\S+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export function sendRaw(printer, buf) {
  return new Promise((resolve, reject) => {
    const lp = spawn("lp", ["-d", printer, "-o", "raw"], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    lp.stdout.on("data", (d) => (out += d.toString()));
    lp.stderr.on("data", (d) => (err += d.toString()));
    lp.on("error", reject);
    lp.on("close", (code) => {
      if (code !== 0) return reject(new Error(`lp exited ${code}: ${err.trim()}`));
      const m = out.match(/request id is (\S+)/i);
      resolve(m ? m[1] : null);
    });
    lp.stdin.end(buf);
  });
}

export async function isJobPending(printer, jobId) {
  try {
    const { stdout } = await run("lpstat", ["-W", "not-completed", "-o", printer]);
    return stdout.includes(jobId);
  } catch {
    return false;
  }
}

// Best effort: CUPS can positively tell us when it's *offline* (false). We can't
// cheaply confirm a USB device is present without root (lsusb -v), so when the
// queue looks fine we return null ("unknown") rather than a possibly-false green.
export async function isConnected(printer) {
  try {
    const { stdout } = await run("lpstat", ["-p", printer, "-l"]);
    if (/disabled|offline|not connected|waiting for printer|powered off/i.test(stdout)) {
      return false;
    }
  } catch {
    return null;
  }
  return null;
}

// macOS printer transport (CUPS + ioreg).

import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export async function resolveDefaultPrinter() {
  try {
    const { stdout } = await run("lpstat", ["-d"]);
    const m = stdout.match(/:\s*(\S+)/); // "system default destination: NAME"
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

// USB serial CUPS associates with this queue (from its device URI).
async function deviceSerial(printer) {
  try {
    const { stdout } = await run("lpstat", ["-v", printer]);
    const m = stdout.match(/serial=([^&\s]+)/i);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// CUPS only reports "offline" after a job fails, so we look for the device in
// ioreg, matched by the serial from its device URI. Returns true/false, or null
// when we can't determine it.
export async function isConnected(printer) {
  let ioreg;
  try {
    ({ stdout: ioreg } = await run("ioreg", ["-rc", "IOUSBHostDevice"], { maxBuffer: 8 << 20 }));
  } catch {
    return null;
  }
  const serial = await deviceSerial(printer);
  if (serial) return ioreg.includes(serial);
  return /printer-80|POS-?80/i.test(ioreg) ? true : null;
}

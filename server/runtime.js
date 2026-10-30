import { readFileSync, writeFileSync, mkdirSync, unlinkSync, chmodSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const file = resolve("data/runtime.json");
function read() {
  try {
    const r = JSON.parse(readFileSync(file, "utf8"));
    if (r.version !== 1 || !/^[a-f0-9-]{36}$/.test(r.instance) || !/^[a-f0-9]{64}$/.test(r.token) ||
        !/^http:\/\/127\.0\.0\.1:\d+$/.test(r.controlOrigin)) return null;
    return r;
  } catch { return null; }
}
export async function runningService() {
  const r = read();
  if (!r) return null;
  try {
    const res = await fetch(r.controlOrigin + "/__kit/status", {
      headers: { Authorization: `Bearer ${r.token}` },
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return null;
    const status = await res.json();
    return status.instance === r.instance ? { ...r, ...status } : null;
  } catch { return null; }
}
export async function registerRuntime(port, publicOrigin, stop) {
  const r = { version: 1, instance: randomUUID(), token: randomBytes(32).toString("hex"),
    pid: process.pid,
    localUrl: `http://localhost:${port}`, publicUrl: publicOrigin || null };
  const authorized = req => {
    const expected = Buffer.from(`Bearer ${r.token}`), received = Buffer.from(req.headers.authorization || "");
    return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress) &&
      received.length === expected.length && timingSafeEqual(received, expected);
  };
  // Separate loopback listener: tunnel traffic and workspace cookies cannot reach controls.
  const control = createServer((req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (!authorized(req)) { res.writeHead(404); return res.end(); }
    res.setHeader("Content-Type", "application/json");
    if (req.method === "GET" && req.url === "/__kit/status")
      return res.end(JSON.stringify({ instance: r.instance, pid: r.pid, localUrl: r.localUrl, publicUrl: r.publicUrl }));
    if (req.method === "POST" && req.url === "/__kit/stop") {
      res.once("finish", () => void stop());
      return res.end(JSON.stringify({ stopping: true }));
    }
    res.writeHead(404); res.end();
  });
  await new Promise((done, fail) => { control.once("error", fail); control.listen(0, "127.0.0.1", done); });
  r.controlOrigin = `http://127.0.0.1:${control.address().port}`;
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify(r), { mode: 0o600 });
    chmodSync(file, 0o600);
  } catch (e) { control.close(); throw e; }
  return () => {
    control.close();
    if (read()?.instance === r.instance) unlinkSync(file);
  };
}
export async function stopService() {
  const r = await runningService();
  if (!r) return false;
  const res = await fetch(r.controlOrigin + "/__kit/stop", {
    method: "POST", headers: { Authorization: `Bearer ${r.token}` },
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) throw new Error("The kit rejected the stop request.");
  // Wait for the runtime file to be removed after HTTP, worker and tunnel cleanup.
  for (let i = 0; i < 220; i++) {
    if (read()?.instance !== r.instance) return true;
    await new Promise(done => setTimeout(done, 100));
  }
  throw new Error("Shutdown is taking longer than expected. Check the running terminal.");
}

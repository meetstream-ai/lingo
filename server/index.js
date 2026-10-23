import { createApp } from "./app.js";
import { registerRuntime } from "./runtime.js";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export async function startServer({ managed = false, beforeClose = async () => {} } = {}) {
  const env = process.env;
  if (env.NODE_ENV === "production") {
    if (!env.APP_PASSWORD || env.APP_PASSWORD.length < 12 ||
        !env.SESSION_SECRET || env.SESSION_SECRET.length < 32)
      throw new Error("Production requires APP_PASSWORD (12+ characters) and SESSION_SECRET (32+ characters).");
    if (!env.PUBLIC_ORIGIN?.startsWith("https://"))
      throw new Error("Production requires an HTTPS PUBLIC_ORIGIN.");
  }
  const kit = createApp(), port = Number(env.PORT || 3000),
    host = env.HOST || (env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
  let server, removeRuntime = () => {}, shuttingDown = false;
  async function stop() {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("Stopping meeting kit…");
    const timeout = setTimeout(() => { removeRuntime(); process.exit(1); }, 20000);
    timeout.unref();
    try {
      const stopped = new Promise(done => server.close(done));
      // close() ends caption streams and waits for jobs before closing SQLite.
      await kit.close();
      // A paused download or incomplete request must not hold npm stop open.
      server.closeAllConnections();
      await stopped;
      await beforeClose();
      removeRuntime();
      clearTimeout(timeout);
      console.log("Meeting kit stopped.");
      process.exit(0);
    } catch {
      removeRuntime();
      console.error("Shutdown failed. Restart the kit to recover queued work.");
      process.exit(1);
    }
  }
  try {
    await new Promise((done, fail) => {
      server = kit.app.listen(port, host, done);
      server.once("error", fail);
    });
    if (managed) removeRuntime = await registerRuntime(port, env.PUBLIC_ORIGIN, stop);
  } catch (e) {
    server?.close();
    await kit.close();
    throw e;
  }
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, stop);
  console.log(`Lingo: http://localhost:${port}\nStop: Ctrl+C in this terminal, or npm stop from another terminal.`);
  return { stop };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await startServer();

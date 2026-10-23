import {
  existsSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  chmodSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

process.chdir(fileURLToPath(new URL("../", import.meta.url)));
let listener;
let tunnelMonitor, reconnecting, closing = false;
const { runningService } = await import("../server/runtime.js");
function saveSetting(key, value) {
  let content = readFileSync(".env", "utf8");
  const line = `${key}=${value}`;
  const match = new RegExp(`^${key}=.*$`, "m");
  content = match.test(content)
    ? content.replace(match, () => line)
    : `${content}\n${line}\n`;
  writeFileSync(".env", content, { mode: 0o600 });
  chmodSync(".env", 0o600);
  process.env[key] = value;
}
try {
  if (Number(process.versions.node.split(".")[0]) < 24)
    throw new Error("Use Node.js 24 or newer.");
  if (!existsSync(".env")) {
    copyFileSync(".env.example", ".env");
    chmodSync(".env", 0o600);
    console.log(
      "Created .env. Add provider credentials there when you want a real meeting.",
    );
  }
  process.loadEnvFile(".env");
  const existing = await runningService();
  if (existing) {
    console.log(`Meeting kit is already running: ${existing.localUrl}\n${existing.publicUrl ? `Public workspace: ${existing.publicUrl}\n` : ""}Use npm stop before restarting. Ctrl+C stops the terminal that launched it.`);
    process.exit(0);
  }
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("PORT must be an integer from 1 to 65535.");
  const host =
    process.env.HOST ||
    (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
  await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", (err) =>
      reject(
        new Error(
          err.code === "EADDRINUSE"
            ? `Port ${port} is already in use by an unmanaged process. Stop that process or change PORT in .env. npm stop only stops this project's managed kit.`
            : `Cannot listen on ${host}:${port}.`,
        ),
      ),
    );
    probe.listen(port, host, () => probe.close(resolve));
  });
  const require = createRequire(import.meta.url);
  const dependencies = Object.keys(
    JSON.parse(readFileSync("package.json", "utf8")).dependencies,
  );
  if (
    dependencies.some((name) => {
      try {
        require.resolve(name);
        return false;
      } catch {
        return true;
      }
    })
  ) {
    console.log("Installing dependencies from package-lock.json…");
    await new Promise((resolve, reject) => {
      const installEnv = { ...process.env };
      // npm can re-export a persistent user policy as an invalid CLI policy to nested installs.
      // Let the child read the user's .npmrc and the project's policy directly.
      delete installEnv.npm_config_allow_scripts;
      delete installEnv.NPM_CONFIG_ALLOW_SCRIPTS;
      const child = spawn(
        process.platform === "win32" ? "npm.cmd" : "npm",
        ["ci"],
        {
          env: installEnv,
          stdio: "inherit",
          shell: process.platform === "win32",
        },
      );
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0
          ? resolve()
          : reject(
              new Error(
                "Dependency installation failed. Check your network and retry npm start.",
              ),
            ),
      );
    });
  }
  const enabled = process.env.NGROK_ENABLED || "auto";
  if (!["auto", "true", "false"].includes(enabled))
    throw new Error("NGROK_ENABLED must be auto, true, or false.");
  const token = process.env.NGROK_AUTHTOKEN?.trim();
  if (enabled === "true" && !token)
    throw new Error(
      "Add NGROK_AUTHTOKEN to .env, or set NGROK_ENABLED=false for local use.",
    );
  if (enabled !== "false" && token) {
    for (const [key, bytes, minimum] of [
      ["APP_PASSWORD", 18, process.env.NODE_ENV === "production" ? 12 : 4],
      ["SESSION_SECRET", 32, 32],
    ]) {
      if (!process.env[key]) {
        saveSetting(key, randomBytes(bytes).toString("hex"));
        console.log(`Created ${key} in your local .env.`);
      }
      if (process.env[key].length < minimum)
        throw new Error(
          `${key} needs at least ${minimum} characters before starting a public tunnel.`,
        );
    }
    const ngrok = await import("@ngrok/ngrok");
    const tunnelOptions = {
      addr: `http://${host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host}:${port}`,
      authtoken: token,
      onStatusChange: status => {
        if (closing || reconnecting) return;
        console.log(status === "connected"
          ? "ngrok connected."
          : "ngrok disconnected; its SDK is reconnecting. Local workspace remains available. If the public URL stays offline, run npm stop and npm start.");
      },
      ...(process.env.NGROK_DOMAIN ? { domain: process.env.NGROK_DOMAIN } : {}),
    };
    // The SDK mutates callback options. Keep the original function for reconnects.
    // A just-closed ngrok agent can briefly remain counted during a rapid restart.
    for(let attempt=0;attempt<3;attempt++) {
      try {listener=await ngrok.forward({...tunnelOptions});break;}
      catch(e){if(attempt===2 || !String(e.message).includes('ERR_NGROK_108'))throw e;
        console.log('ngrok is still releasing an agent session. Retrying shortly…');
        await new Promise(resolve=>setTimeout(resolve,1000));}
    }
    const origin = listener.url();
    if (!origin?.startsWith("https://"))
      throw new Error("ngrok did not return an HTTPS URL.");
    saveSetting("PUBLIC_ORIGIN", origin);
    console.log(
      `Public workspace: ${origin}\nMeetStream webhook endpoint: ${origin}/webhooks/meetstream`,
    );
    let failedChecks = 0;
    tunnelMonitor = setInterval(async () => {
      if (closing || reconnecting) return;
      try {
        const response = await fetch(origin + "/healthz", {
          headers: { "ngrok-skip-browser-warning": "1" }, signal: AbortSignal.timeout(5000),
        });
        if (response.ok && (await response.json()).ok === true) { failedChecks = 0; return; }
      } catch {}
      if (++failedChecks < 2 || closing) return;
      console.log("Public tunnel is offline. Reconnecting the same URL; local workspace remains available.");
      reconnecting = (async () => {
        await listener.close().catch(() => {});
        const next = await ngrok.forward({ ...tunnelOptions, domain: new URL(origin).hostname, force_new_session: true });
        if (closing || next.url() !== origin) {
          await next.close();
          if (!closing) throw new Error("ngrok returned a different URL; restart the kit to refresh callback configuration.");
          return;
        }
        listener = next;
        failedChecks = 0;
        console.log(`Public tunnel restored: ${origin}`);
      })().catch(() => console.error("Tunnel recovery failed. Check your network/ngrok account, or run npm stop and npm start."))
        .finally(() => { reconnecting = null; });
    }, 30000);
    tunnelMonitor.unref();
  }
  const { packageExtension } = await import("./package-extension.js");
  packageExtension();
  const { startServer } = await import("../server/index.js");
  await startServer({ managed: true, beforeClose: async () => {
    closing = true;
    clearInterval(tunnelMonitor);
    await reconnecting;
    await listener?.close();
  } });
} catch (error) {
  closing = true;
  clearInterval(tunnelMonitor);
  await listener?.close().catch(() => {});
  let message = error.message || "Startup failed.";
  for (const [key, value] of Object.entries(process.env))
    if (/KEY|TOKEN|SECRET|PASSWORD/.test(key) && value)
      message = message.replaceAll(value, "[redacted]");
  console.error(message);
  process.exit(1);
}

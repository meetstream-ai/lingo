import { spawn } from "node:child_process";

const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("PORT must be an integer from 1 to 65535.");
const passwordMinimum=process.env.NODE_ENV === "production" ? 12 : 4;
if (
  !process.env.APP_PASSWORD ||
  process.env.APP_PASSWORD.length < passwordMinimum ||
  !process.env.SESSION_SECRET ||
  process.env.SESSION_SECRET.length < 32
)
  throw new Error(
    `Set APP_PASSWORD (${passwordMinimum}+ characters) and SESSION_SECRET (32+ characters) in .env before exposing the workspace.`,
  );
const env = { ...process.env };
// An empty template value should not override ngrok's saved agent credential.
if (!env.NGROK_AUTHTOKEN?.trim()) delete env.NGROK_AUTHTOKEN;
const child = spawn(
  "ngrok",
  ["http", `http://127.0.0.1:${port}`, "--log", "stdout"],
  {
    env,
    stdio: "inherit",
  },
);
child.on("error", (error) => {
  console.error(
    error.code === "ENOENT"
      ? "Install the ngrok agent, then run npm run tunnel again."
      : "The ngrok agent could not start.",
  );
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));

import { execFileSync } from "node:child_process";
import { randomUUID, randomBytes } from "node:crypto";
import assert from "node:assert/strict";
const name = `meetstream-smoke-${randomUUID().slice(0, 8)}`,
  volume = `${name}-data`,
  image = process.argv[2] || "meetstream-accessibility-kit:local";
const env = {
  ...process.env,
  APP_PASSWORD: randomBytes(18).toString("hex"),
  SESSION_SECRET: randomBytes(32).toString("hex"),
  PUBLIC_ORIGIN: "https://smoke.example",
};
const docker = (...args) =>
  execFileSync("docker", args, {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
let base, cookie, id, extensionToken;
async function ready() {
  for (let n = 0; n < 100; n++) {
    try {
      if ((await fetch(base + "/healthz")).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Docker service did not become ready.");
}
async function request(path, body) {
  return fetch(base + path, {
    method: body ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
try {
  docker(
    "run",
    "--detach",
    "--name",
    name,
    "--publish",
    "127.0.0.1::3000",
    "--env",
    "APP_PASSWORD",
    "--env",
    "SESSION_SECRET",
    "--env",
    "PUBLIC_ORIGIN",
    "--volume",
    `${volume}:/app/data`,
    image,
  );
  const mapping = docker("port", name, "3000/tcp");
  base = `http://${mapping.split("\n")[0]}`;
  await ready();
  const home = await request("/");
  assert.equal(home.status, 200);
  assert.match(await home.text(), /The meeting stays/);
  const zip = await request("/extension.zip");
  assert.equal(zip.status, 200);
  assert.equal(Buffer.from(await zip.arrayBuffer()).readUInt32LE(0), 0x04034b50);
  assert.equal((await request("/api/meetings")).status, 401);
  const login = await request("/api/login", { password: env.APP_PASSWORD });
  assert.equal(login.status, 200);
  cookie = login.headers.get("Set-Cookie").split(";")[0];
  assert.match(login.headers.get("Set-Cookie"), /Secure/);
  const result = await request("/api/meetings", {
    title: "Docker persistence smoke",
    mode: "demo",
  });
  assert.equal(result.status, 201);
  id = (await result.json()).id;
  const pairing = await request("/api/extension/pairing", { meetingId: id });
  assert.equal(pairing.status, 200);
  const { code } = await pairing.json();
  const paired = await request("/extension-api/pair", { code });
  assert.equal(paired.status, 200);
  extensionToken = (await paired.json()).token;
  assert.equal((await request("/extension-api/pair", { code })).status, 401);
  await new Promise((r) => setTimeout(r, 500));
  let snapshot = await (await request(`/api/meetings/${id}`)).json();
  assert.ok(snapshot.cues.length >= 1);
  assert.equal(
    (
      await request("/api/connections/google", {
        values: { GOOGLE_TRANSLATE_API_KEY: "docker-smoke-placeholder" },
      })
    ).status,
    200,
  );
  assert.equal(
    docker("exec", name, "stat", "-c", "%a", "/app/data/connections.json"),
    "600",
  );
  const details = await fetch(`${base}/api/meetings/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({
      title: "Docker persistence smoke",
      notes: "Notes survive container restart.",
      actions: [
        {
          id: "task-1",
          text: "Review transcript",
          owner: "Test owner",
          done: false,
        },
      ],
      version: 0,
    }),
  });
  assert.equal(details.status, 200);
  docker("restart", name);
  base = `http://${docker("port", name, "3000/tcp").split("\n")[0]}`;
  await ready();
  snapshot = await (await request(`/api/meetings/${id}`)).json();
  assert.equal(snapshot.meeting.title, "Docker persistence smoke");
  assert.ok(snapshot.cues.length >= 1);
  assert.equal(snapshot.meeting.notes, "Notes survive container restart.");
  assert.equal(snapshot.meeting.actions[0].owner, "Test owner");
  const config = await (await request("/api/config")).json();
  assert.equal(config.providers.google, true);
  assert.ok(!JSON.stringify(config).includes("docker-smoke-placeholder"));
  const extension = await fetch(`${base}/extension-api/captions?target=en`, {
    headers: { Authorization: `Bearer ${extensionToken}` },
  });
  assert.equal(extension.status, 200);
  const captions = await extension.json();
  assert.equal(captions.meeting.id, id);
  assert.ok(captions.cues.length >= 1);
  assert.ok(!JSON.stringify(captions).includes("docker-smoke-placeholder"));
  assert.equal((await request("/api/extension/revoke", {})).status, 200);
  assert.equal((await fetch(`${base}/extension-api/captions`, {
    headers: { Authorization: `Bearer ${extensionToken}` },
  })).status, 401);
  console.log(
    "Docker smoke passed: public homepage/extension ZIP, non-root service, production authentication, secure cookie, private credentials, captions/settings/notebook/extension pairing persistence, and token revocation across restart.",
  );
} catch (error) {
  try {
    console.error(docker("logs", name));
  } catch {}
  throw error;
} finally {
  try {
    docker("rm", "--force", name);
  } catch {}
  try {
    docker("volume", "rm", volume);
  } catch {}
}

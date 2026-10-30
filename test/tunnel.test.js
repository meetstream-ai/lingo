import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("tunnel reads manually saved .env credentials, keeps tokens out of arguments and supports saved-config fallback", () => {
  const dir = mkdtempSync(join(tmpdir(), "meetstream-tunnel-"));
  const script = fileURLToPath(
    new URL("../scripts/tunnel.js", import.meta.url),
  );
  try {
    writeFileSync(
      join(dir, "ngrok"),
      "#!/usr/bin/env node\nconsole.log(JSON.stringify({args:process.argv.slice(2),token:process.env.NGROK_AUTHTOKEN ?? null}));\n",
      { mode: 0o755 },
    );
    const run = (token, extra = "") => {
      writeFileSync(
        join(dir, ".env"),
        `APP_PASSWORD=test-workspace-password\nSESSION_SECRET=test-session-secret-with-32-characters\nPORT=3456\nNGROK_AUTHTOKEN=${token}\n${extra}`,
      );
      return spawnSync(process.execPath, ["--env-file=.env", script], {
        cwd: dir,
        env: { PATH: dir + delimiter + process.env.PATH },
        encoding: "utf8",
      });
    };
    const configured = run("fake-manually-saved-token");
    assert.equal(configured.status, 0, configured.stderr);
    const result = JSON.parse(configured.stdout);
    assert.equal(result.token, "fake-manually-saved-token");
    assert.deepEqual(result.args, [
      "http",
      "http://127.0.0.1:3456",
      "--log",
      "stdout",
    ]);
    assert.equal(
      result.args.some((arg) => arg.includes("token")),
      false,
    );
    const fallback = run("");
    assert.equal(fallback.status, 0, fallback.stderr);
    assert.equal(JSON.parse(fallback.stdout).token, null);
    assert.equal(run("fake-token", "APP_PASSWORD=2468\nNODE_ENV=development\n").status,0);
    const productionShort=run("fake-token", "APP_PASSWORD=2468\nNODE_ENV=production\n");
    assert.equal(productionShort.status,1);assert.match(productionShort.stderr,/12\+ characters/);
    const invalid = run("fake-token", "PORT=not-a-port\n");
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /PORT must be an integer/);
    const unprotected = run("fake-token", "APP_PASSWORD=\n");
    assert.equal(unprotected.status, 1);
    assert.match(unprotected.stderr, /before exposing the workspace/);
    assert.equal(unprotected.stdout, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

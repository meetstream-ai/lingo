import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  cpSync,
  symlinkSync,
  writeFileSync,
  existsSync,
  readFileSync,
  statSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { spawn } from "node:child_process";
import { createServer, createConnection } from "node:net";
import { fileURLToPath } from "node:url";

test("one-command launcher creates environment, starts local demo, shuts down, and explains occupied ports", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "meetstream-start-"));
  const reservation = createServer();
  await new Promise((done) => reservation.listen(0, "127.0.0.1", done));
  const port = reservation.address().port;
  const env = {
    PATH: process.env.PATH,
    PORT: String(port),
    HOST: "127.0.0.1",
    DATABASE_PATH: ":memory:",
    NGROK_ENABLED: "false",
    NODE_ENV: "development",
  };
  let child, heldClient;
  const run = () => {
    const process = spawn(globalThis.process.execPath, ["scripts/start.js"], {
      cwd: dir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    process.stdout.on("data", (d) => (output += d));
    process.stderr.on("data", (d) => (output += d));
    const exited = new Promise((done) =>
      process.once("exit", (code) => done({ code, output })),
    );
    return { process, exited, getOutput: () => output };
  };
  try {
    for (const name of ["server", "public", "scripts", "extension", "test", "deploy", "docs", ".github"])
      cpSync(join(root, name), join(dir, name), { recursive: true });
    for (const name of ["package.json", "package-lock.json", ".env.example", ".gitignore", ".dockerignore", "Dockerfile", "compose.yaml", "README.md", "QUICKSTART.md", "DESIGN.md", "LICENSE", "playwright.config.js"])
      cpSync(join(root, name), join(dir, name));
    symlinkSync(join(root, "node_modules"), join(dir, "node_modules"), "dir");
    let blocked = run();
    assert.equal((await blocked.exited).code, 1);
    assert.match(blocked.getOutput(), /already in use/);
    assert.equal(existsSync(join(dir, ".env")), true);
    assert.match(readFileSync(join(dir, ".env"), "utf8"), /NGROK_AUTHTOKEN=/);
    await new Promise((done) => reservation.close(done));
    child = run();
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try {
        ready = (await fetch(`http://127.0.0.1:${port}/healthz`)).ok;
      } catch {}
      if (ready) break;
      await new Promise((done) => setTimeout(done, 50));
    }
    assert.equal(ready, true, child.getOutput());
    const result = await fetch(`http://127.0.0.1:${port}/api/meetings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "demo",
        title: "Launcher test",
        targets: ["en", "hi"],
      }),
    });
    assert.equal(result.status, 201);
    const runtimeFile = join(dir, "data/runtime.json");
    assert.equal(statSync(runtimeFile).mode & 0o777, 0o600);
    const runtime = JSON.parse(readFileSync(runtimeFile, "utf8"));
    assert.notEqual(runtime.controlOrigin, `http://127.0.0.1:${port}`);
    assert.equal((await fetch(runtime.controlOrigin + "/__kit/stop", { method: "POST" })).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${port}/__kit/stop`, { method: "POST" })).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${port}/__kit/status`, { headers: { Authorization: "Bearer wrong" } })).status, 404);
    const duplicate = run();
    assert.equal((await duplicate.exited).code, 0);
    assert.match(duplicate.getOutput(), /already running/);
    // Leave a request body unfinished, as a stalled client can during shutdown.
    await new Promise(done => {
      heldClient = createConnection({ port, host: '127.0.0.1' }, () => {
        heldClient.write('POST /api/meetings HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{');
        done();
      });
    });
    const stop = spawn(globalThis.process.execPath, ["scripts/stop.js"], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
    let stopOutput = "";
    stop.stdout.on("data", d => stopOutput += d);
    stop.stderr.on("data", d => stopOutput += d);
    assert.equal(await new Promise(done => stop.once("exit", done)), 0, stopOutput);
    assert.match(stopOutput, /Port released/);
    assert.equal((await child.exited).code, 0);
    assert.equal(existsSync(runtimeFile), false);
    const unrelated = createServer(socket => socket.destroy());
    await new Promise(done => unrelated.listen(port, "127.0.0.1", done));
    writeFileSync(runtimeFile, JSON.stringify({ ...runtime, controlOrigin: `http://127.0.0.1:${port}` }), { mode: 0o600 });
    const staleStop = spawn(globalThis.process.execPath, ["scripts/stop.js"], { cwd: dir, env, stdio: "ignore" });
    assert.equal(await new Promise(done => staleStop.once("exit", done)), 0);
    assert.equal(unrelated.listening, true, "stale state must never stop an unrelated listener");
    await new Promise(done => unrelated.close(done));
    child = run();
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) break; } catch {}
      await new Promise(done => setTimeout(done, 50));
    }
    child.process.kill("SIGINT");
    assert.equal((await child.exited).code, 0, child.getOutput());
    assert.equal(existsSync(runtimeFile), false);
    const manifest = JSON.parse(
      readFileSync(join(dir, "package.json"), "utf8"),
    );
    manifest.dependencies["bootstrap-test-missing-package"] = "1.0.0";
    writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
    writeFileSync(
      join(dir, "npm"),
      "#!/usr/bin/env node\nimport {writeFileSync} from 'node:fs'; writeFileSync('installer-check.json',JSON.stringify({args:process.argv.slice(2),inherited:process.env.npm_config_allow_scripts??null}));\n",
      { mode: 0o755 },
    );
    env.PATH = dir + delimiter + process.env.PATH;
    env.npm_config_allow_scripts = "esbuild";
    child = run();
    for (
      let i = 0;
      i < 100 && !existsSync(join(dir, "installer-check.json"));
      i++
    )
      await new Promise((done) => setTimeout(done, 20));
    assert.equal(
      existsSync(join(dir, "installer-check.json")),
      true,
      child.getOutput(),
    );
    assert.deepEqual(
      JSON.parse(readFileSync(join(dir, "installer-check.json"), "utf8")),
      { args: ["ci"], inherited: null },
    );
    child.process.kill("SIGTERM");
    await child.exited;
  } finally {
    heldClient?.destroy();
    child?.process.kill("SIGTERM");
    reservation.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("launcher restores an offline tunnel at the same URL and closes it on npm stop", { timeout: 15000 }, async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'meetstream-reconnect-'));
  const reservation = createServer();
  await new Promise(done => reservation.listen(0, '127.0.0.1', done));
  const port = reservation.address().port;
  await new Promise(done => reservation.close(done));
  let child;
  try {
    for (const name of ['server', 'public', 'scripts', 'extension', 'test', 'deploy', 'docs', '.github']) cpSync(join(root,name),join(dir,name),{recursive:true});
    for (const name of ['package.json','package-lock.json','.env.example','.gitignore','.dockerignore','Dockerfile','compose.yaml','README.md','QUICKSTART.md','DESIGN.md','LICENSE','playwright.config.js']) cpSync(join(root,name),join(dir,name));
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(dir,'node_modules/@ngrok/ngrok'),{recursive:true});
    for (const name of ['express','@meetstream/sdk']) {
      mkdirSync(join(dir,'node_modules',name,'..'),{recursive:true});
      symlinkSync(join(root,'node_modules',name),join(dir,'node_modules',name),'dir');
    }
    writeFileSync(join(dir,'node_modules/@ngrok/ngrok/package.json'),JSON.stringify({type:'module',main:'index.js'}));
    writeFileSync(join(dir,'node_modules/@ngrok/ngrok/index.js'),`import{readFileSync,writeFileSync,existsSync,renameSync}from'node:fs';
// Publish fixture state atomically for the polling parent and preload reader.
const save=r=>{writeFileSync('tunnel-check.pending.json',JSON.stringify(r));renameSync('tunnel-check.pending.json','tunnel-check.json');};
const log=()=>existsSync('tunnel-check.json')?JSON.parse(readFileSync('tunnel-check.json','utf8')):{opens:0,closes:0};
export async function forward(options){if(!existsSync('initial-restart-retry.json')){writeFileSync('initial-restart-retry.json','{}');throw Error('ERR_NGROK_108 transient session release');}if(typeof options.onStatusChange !== 'function')throw Error('Status callback was mutated');const callback=options.onStatusChange;options.onStatusChange=true;callback('connected');const r=log();r.opens++;r.domain=options.domain||null;r.force=options.force_new_session||false;save(r);return{url:()=>'https://tunnel.invalid',close:async()=>{const r=log();r.closes++;save(r);}};}`);
    writeFileSync(join(dir,'preload.js'),`import{readFileSync,existsSync}from'node:fs';
const nativeInterval=setInterval;globalThis.setInterval=(fn,ms,...args)=>nativeInterval(fn,ms===30000?60:ms,...args);
const nativeFetch=fetch;globalThis.fetch=(url,...args)=>{if(String(url).startsWith('https://tunnel.invalid/')){const r=existsSync('tunnel-check.json')?JSON.parse(readFileSync('tunnel-check.json','utf8')):{};return Promise.resolve(new Response(r.opens>=2?'{"ok":true}':'offline',{status:r.opens>=2?200:404}));}return nativeFetch(url,...args);};`);
    writeFileSync(join(dir,'.env'),`NGROK_AUTHTOKEN=isolated-test-placeholder\nNGROK_ENABLED=true\nAPP_PASSWORD=isolated-test-password\nSESSION_SECRET=isolated-test-session-secret-at-least-32-characters\n`);
    const env={PATH:process.env.PATH,PORT:String(port),HOST:'127.0.0.1',DATABASE_PATH:':memory:',NODE_ENV:'development'};
    child=spawn(process.execPath,['--import',join(dir,'preload.js'),'scripts/start.js'],{cwd:dir,env,stdio:['ignore','pipe','pipe']});
    let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
    const exited=new Promise(done=>child.once('exit',done));
    const logFile=join(dir,'tunnel-check.json');
    for(let i=0;i<100;i++){
      if(existsSync(logFile)&&JSON.parse(readFileSync(logFile,'utf8')).opens>=2 && /Public tunnel restored/.test(output))break;
      await new Promise(done=>setTimeout(done,30));
    }
    assert.deepEqual(JSON.parse(readFileSync(logFile,'utf8')),{opens:2,closes:1,domain:'tunnel.invalid',force:true});
    assert.match(output,/Public tunnel restored/);
    assert.doesNotMatch(output,/isolated-test-placeholder/);
    const stop=spawn(process.execPath,['scripts/stop.js'],{cwd:dir,env,stdio:'ignore'});
    assert.equal(await new Promise(done=>stop.once('exit',done)),0);
    assert.equal(await exited,0,output);
    assert.equal(JSON.parse(readFileSync(logFile,'utf8')).closes,2);
    assert.equal(existsSync(join(dir,'data/runtime.json')),false);
  } finally {
    child?.kill('SIGTERM');
    rmSync(dir,{recursive:true,force:true});
  }
});

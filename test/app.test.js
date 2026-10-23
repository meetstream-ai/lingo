import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.js";
import { NotReadyError } from "@meetstream/sdk";
import { openStore } from "../server/store.js";
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(check, limit = 4000) {
  const began = Date.now();
  while (Date.now() - began < limit) {
    if (check()) return;
    await pause(25);
  }
  assert.fail("Timed out waiting for application state.");
}
async function launch(options = {}) {
  const originalFetch=options.fetchImpl;
  const kit = createApp({ env: {}, database: ":memory:", ...options, fetchImpl: async(url,opts)=>{
    const body=opts?.body && typeof opts.body==='string' ? JSON.parse(opts.body) : null;
    if(body?.q === 'Hello') return Response.json({data:{translations:[{translatedText:'नमस्ते'}]}});
    return originalFetch ? originalFetch(url,opts) : fetch(url,opts);
  }});
  const server = kit.app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    ...kit,
    base,
    async close() {
      await kit.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
    async request(path, body, headers = {}) {
      return fetch(base + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json", ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    },
  };
}
test("complete live pipeline: bot creation, durable webhook, translations, dedupe, post-call and exports", async () => {
  const sdk = {
    bots: {
      create: async (payload) => {
        assert.equal(
          payload.recording_config.transcript.provider.meetstream.translate,
          false,
        );
        return { bot_id: "bot-1", transcript_id: "transcript-1" };
      },
      remove: async () => ({ ok: true }),
      status: async () => ({ status: "InMeeting" }),
    },
    transcripts: {
      get: async (id) => {
        assert.equal(id, "transcript-1");
        return [
          {
            speaker: "Karthik",
            transcript: "வணக்கம்",
            start_time: 1,
            end_time: 2,
          },
        ];
      },
    },
  };
  const kit = await launch({
    env: {
      MEETSTREAM_API_KEY: "key",
      PUBLIC_ORIGIN: "https://kit.example",
      MEETSTREAM_WEBHOOK_SECRET: "webhook-secret",
      GOOGLE_TRANSLATE_API_KEY: "google-key",
    },
    meetstream: sdk,
    fetchImpl: async (_url, opts) => {
      const q = JSON.parse(opts.body);
      return new Response(
        JSON.stringify({
          data: {
            translations: [
              {
                translatedText: q.target === "hi" ? "नमस्ते" : "Hello",
                detectedSourceLanguage: "ta",
              },
            ],
          },
        }),
      );
    },
  });
  try {
    let res = await kit.request("/api/meetings", {
      title: "Real acceptance",
      mode: "live",
      meetingLink: "https://meet.google.com/abc-defg-hij",
      targets: ["en", "hi"],
    });
    assert.equal(res.status, 201);
    const m = await res.json();
    assert.equal(m.liveToken, undefined);
    await waitFor(() => kit.store.meeting(m.id).botId);
    const token = kit.store.meeting(m.id).liveToken;
    const body = {
        bot_id: "bot-1",
        speakerName: "Karthik",
        speakerId: "speaker-7",
        timestamp: new Date().toISOString(),
        utterance: "வணக்கம்",
        transcription_mode: "sentence",
        words: [{ start: 1, end: 2 }],
      },
      path = `/webhooks/live/${m.id}/${token}`;
    res = await kit.request(path, body);
    assert.equal(res.status, 202);
    await kit.request(path, body);
    await waitFor(
      () =>
        kit.store.cues(m.id)[0]?.translations.hi?.status === "ready" &&
        kit.store.cues(m.id)[0]?.translations.en?.status === "ready",
    );
    assert.equal(kit.store.cues(m.id).length, 1);
    assert.equal(kit.store.cues(m.id)[0].speakerId, "speaker-7");
    assert.equal(
      (await kit.request(`/webhooks/live/${m.id}/wrong`, body)).status,
      403,
    );
    assert.equal(
      (await kit.request(path, { ...body, bot_id: "imposter" })).status,
      403,
    );
    const sse = await fetch(kit.base + `/api/meetings/${m.id}/events`);
    assert.match(sse.headers.get("Content-Type"), /event-stream/);
    const reader = sse.body.getReader();
    const first = await reader.read();
    assert.match(new TextDecoder().decode(first.value), /Karthik/);
    res = await kit.request(`/api/meetings/${m.id}/receipts`, {
      cueId: kit.store.cues(m.id)[0].id,
      target: "hi",
      clientId: "receipt-regression",
      delayMs: 42,
    });
    assert.equal(res.status, 200);
    const receiptUpdate = new TextDecoder().decode((await reader.read()).value);
    assert.match(receiptUpdate, /"displayP50":42/);
    assert.match(receiptUpdate, /"displaySamples":1/);
    await reader.cancel();
    const at = new Date().toISOString(),
      event = {
        bot_id: "bot-1",
        event: "bot.stopped",
        bot_event: "bot.stopped",
        timestamp: at,
      };
    const signature =
      "sha256=" +
      createHmac("sha256", "webhook-secret")
        .update(JSON.stringify(event))
        .digest("hex");
    res = await kit.request("/webhooks/meetstream", event, {
      "X-Meetstream-Signature": signature,
      "X-Meetstream-Timestamp": at,
    });
    assert.equal(res.status, 202);
    await waitFor(() => kit.store.meeting(m.id).postCallStatus === "ready");
    await waitFor(
      () =>
        kit.store.cues(m.id).find((c) => c.kind === "final")?.translations.hi
          ?.status === "ready",
    );
    res = await kit.request(
      `/api/meetings/${m.id}/export?format=html&target=hi&kind=final`,
    );
    assert.equal(res.status, 200);
    assert.match(await res.text(), /lang="ta"/);
    const snapshot = await (await kit.request(`/api/meetings/${m.id}`)).json();
    assert.equal(snapshot.cues.length, 2);
    assert.equal(snapshot.metrics[0].simulated, false);
    assert.equal(snapshot.metrics[0].speechToCaptionMs, null);
    const c = snapshot.cues[0];
    assert.equal(
      (
        await kit.request(`/api/meetings/${m.id}/reviews`, {
          cueId: c.id,
          target: "hi",
          score: 4,
          notes: "Meaning preserved.",
        })
      ).status,
      200,
    );
    assert.equal(kit.store.reviews(m.id)[0].score, 4);
  } finally {
    await kit.close();
  }
});
test("authentication, session cookies, origin validation and login rate limit", async () => {
  const kit = await launch({
    env: {
      APP_PASSWORD: "workspace-password",
      SESSION_SECRET: "long-session-secret",
      PUBLIC_ORIGIN: "https://kit.example",
    },
  });
  try {
    assert.equal((await kit.request("/api/meetings")).status, 401);
    let r = await kit.request("/api/login", { password: "workspace-password" });
    assert.equal(r.status, 200);
    const cookie = r.headers.get("Set-Cookie").split(";")[0];
    assert.match(r.headers.get("Set-Cookie"), /HttpOnly/);
    assert.match(r.headers.get("Set-Cookie"), /SameSite=Strict/);
    assert.equal(
      (await kit.request("/api/meetings", undefined, { Cookie: cookie }))
        .status,
      200,
    );
    assert.equal(
      (
        await kit.request(
          "/api/meetings",
          { title: "x" },
          { Cookie: cookie, Origin: "https://evil.example" },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await kit.request("/api/meetings", undefined, {
          Cookie: "access_session=1.fake",
        })
      ).status,
      401,
    );
    for (let i = 0; i < 5; i++)
      assert.equal(
        (await kit.request("/api/login", { password: "wrong" })).status,
        401,
      );
    assert.equal(
      (await kit.request("/api/login", { password: "wrong" })).status,
      429,
    );
  } finally {
    await kit.close();
  }
});
test("retryable translation failure retains originals and records failure instead of hiding it", async () => {
  let providerReady = false;
  const sdk = {
      bots: { create: async () => ({ bot_id: "b", transcript_id: "t" }) },
    },
    kit = await launch({
      env: {
        PUBLIC_ORIGIN: "https://kit.example",
        MEETSTREAM_WEBHOOK_SECRET: "s",
        GOOGLE_TRANSLATE_API_KEY: "k",
      },
      meetstream: sdk,
      fetchImpl: async () =>
        providerReady
          ? new Response(
              JSON.stringify({
                data: {
                  translations: [
                    { translatedText: "Hello", detectedSourceLanguage: "hi" },
                  ],
                },
              }),
            )
          : new Response("{}", { status: 401 }),
    });
  try {
    const m = await (
      await kit.request("/api/meetings", {
        title: "Failure case",
        mode: "live",
        meetingLink: "https://meet.google.com/abc-defg-hij",
        targets: ["en"],
      })
    ).json();
    await waitFor(() => kit.store.meeting(m.id).botId);
    const token = kit.store.meeting(m.id).liveToken;
    await kit.request(`/webhooks/live/${m.id}/${token}`, {
      bot_id: "b",
      speakerName: "Ananya",
      transcript: "नमस्ते",
      timestamp: new Date().toISOString(),
    });
    await waitFor(
      () => kit.store.cues(m.id)[0]?.translations.en?.status === "failed",
    );
    assert.equal(kit.store.cues(m.id)[0].text, "नमस्ते");
    assert.equal(
      (await kit.request(`/api/meetings/${m.id}/export?format=vtt&target=en`))
        .status,
      409,
    );
    assert.equal(kit.store.failed(m.id).length, 1);
    providerReady = true;
    assert.equal(
      (await kit.request(`/api/meetings/${m.id}/retry`, {})).status,
      200,
    );
    await waitFor(
      () => kit.store.cues(m.id)[0]?.translations.en?.status === "ready",
    );
    assert.equal(kit.store.failed(m.id).length, 0);
  } finally {
    await kit.close();
  }
});
test("durable inbox and unfinished work survive restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "access-kit-")),
    path = join(dir, "kit.sqlite");
  let store = openStore(path);
  try {
    store.saveMeeting({ id: "m", title: "Persisted" });
    store.enqueue("job", "live", {
      meetingId: "m",
      body: { transcript: "नमस्ते" },
    });
    assert.equal(store.claim().attempts, 1);
    store.close();
    store = openStore(path);
    assert.equal(store.meeting("m").title, "Persisted");
    const job = store.claim();
    assert.equal(job.payload.body.transcript, "नमस्ते");
    assert.equal(job.attempts, 2);
    assert.equal(store.enqueue("job", "live", {}), false);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("live creation is blocked without credentials and invalid review/receipt payloads fail cleanly", async () => {
  const kit = await launch();
  try {
    assert.equal(
      (
        await kit.request("/api/meetings", {
          title: "Live",
          mode: "live",
          meetingLink: "https://meet.google.com/abc-defg-hij",
        })
      ).status,
      409,
    );
    assert.equal(
      (await kit.request("/api/meetings", { title: "Demo" })).status,
      201,
    );
    const m = kit.store.meetings()[0];
    assert.equal(
      (await kit.request(`/api/meetings/${m.id}/reviews`, {})).status,
      400,
    );
    assert.equal(
      (await kit.request(`/api/meetings/${m.id}/receipts`, {})).status,
      400,
    );
    assert.equal((await kit.request("/webhooks/meetstream", {})).status, 401);
  } finally {
    await kit.close();
  }
});

const liveEnv = {
  PUBLIC_ORIGIN: "https://kit.example",
  MEETSTREAM_WEBHOOK_SECRET: "test-secret",
  GOOGLE_TRANSLATE_API_KEY: "test-key",
};
const liveInput = {
  title: "Lifecycle regression",
  mode: "live",
  meetingLink: "https://meet.google.com/abc-defg-hij",
  source: "hi",
  targets: ["hi"],
};
function makeDue(kit, id) {
  kit.store.db.prepare("UPDATE jobs SET run_at=0 WHERE id=?").run(id);
}
function jobDone(kit, id) {
  return (
    kit.store.db.prepare("SELECT status FROM jobs WHERE id=?").get(id)
      ?.status === "done"
  );
}
function lifecycle(kit, id, event) {
  const jobId = `regression:${event}:${Date.now()}`;
  kit.store.enqueue(jobId, "lifecycle", {
    meetingId: id,
    body: { bot_id: "regression-bot", event },
  });
  return jobId;
}

test("stopping during bot creation retains the stop request and never removes an unknown bot", async () => {
  let finishCreate;
  const removed = [];
  const kit = await launch({
    startWorker: false,
    env: liveEnv,
    meetstream: {
      bots: {
        create: () =>
          new Promise((resolve) => {
            finishCreate = resolve;
          }),
        remove: async (id) => {
          assert.equal(id, "regression-bot");
          removed.push(id);
        },
      },
      transcripts: {
        get: async () => [
          {
            speaker: "Ananya",
            transcript: "नमस्ते",
            start_time: 1,
            end_time: 2,
          },
        ],
      },
    },
  });
  try {
    const m = await (await kit.request("/api/meetings", liveInput)).json();
    await kit.tick();
    assert.ok(finishCreate);
    assert.equal(
      (await kit.request(`/api/meetings/${m.id}/stop`, {})).status,
      202,
    );
    await kit.tick();
    await waitFor(
      () =>
        kit.store.db
          .prepare("SELECT status FROM jobs WHERE id=?")
          .get(`stop:${m.id}`).status === "queued",
    );
    assert.deepEqual(removed, []);
    finishCreate({
      bot_id: "regression-bot",
      transcript_id: "regression-transcript",
    });
    await waitFor(() => kit.store.meeting(m.id).botId);
    assert.equal(kit.store.meeting(m.id).status, "stopping");
    makeDue(kit, `stop:${m.id}`);
    await kit.tick();
    await waitFor(() => kit.store.meeting(m.id).endedAt);
    assert.equal(kit.store.meeting(m.id).status, "stopped");
    assert.deepEqual(removed, ["regression-bot"]);
  } finally {
    finishCreate?.({ bot_id: "regression-bot" });
    await kit.close();
  }
});

test("late lifecycle events and a stale in-flight status response cannot reopen a completed meeting", async () => {
  let finishPoll;
  const kit = await launch({
    startWorker: false,
    env: liveEnv,
    meetstream: {
      bots: {
        create: async () => ({
          bot_id: "regression-bot",
          transcript_id: "regression-transcript",
        }),
        status: () =>
          new Promise((resolve) => {
            finishPoll = resolve;
          }),
      },
      transcripts: {
        get: async () => [
          {
            speaker: "Ananya",
            transcript: "नमस्ते",
            start_time: 1,
            end_time: 2,
          },
        ],
      },
    },
  });
  try {
    const m = await (await kit.request("/api/meetings", liveInput)).json();
    await kit.tick();
    await waitFor(() => kit.store.meeting(m.id).botId);
    makeDue(kit, `status:${m.id}`);
    await kit.tick();
    assert.ok(finishPoll);
    const ready = lifecycle(kit, m.id, "transcription.processed");
    await kit.tick();
    await waitFor(() => jobDone(kit, ready));
    makeDue(kit, `final:${m.id}`);
    await kit.tick();
    await waitFor(() => kit.store.meeting(m.id).postCallStatus === "ready");
    finishPoll({ status: "InMeeting" });
    await waitFor(() => jobDone(kit, `status:${m.id}`));
    for (const event of [
      "bot.stopped",
      "bot.inmeeting",
      "transcription.failed",
    ]) {
      const id = lifecycle(kit, m.id, event);
      await kit.tick();
      await waitFor(() => jobDone(kit, id));
    }
    assert.equal(kit.store.meeting(m.id).status, "completed");
    assert.equal(kit.store.meeting(m.id).postCallStatus, "ready");
    assert.equal(kit.store.meeting(m.id).lastError, null);
  } finally {
    finishPoll?.({ status: "Stopped" });
    await kit.close();
  }
});

for (const trigger of ["readiness webhook", "manual retry"])
  test(`a failed post-call job recovers after ${trigger}`, async () => {
    let available = false;
    const kit = await launch({
      startWorker: false,
      env: liveEnv,
      meetstream: {
        bots: {
          create: async () => ({
            bot_id: "regression-bot",
            transcript_id: "regression-transcript",
          }),
        },
        transcripts: {
          get: async () => {
            if (!available)
              throw Object.assign(new Error("Transcript unavailable"), {
                status: 401,
              });
            return [
              {
                speaker: "Ananya",
                transcript: "नमस्ते",
                start_time: 1,
                end_time: 2,
              },
            ];
          },
        },
      },
    });
    try {
      const m = await (await kit.request("/api/meetings", liveInput)).json();
      await kit.tick();
      await waitFor(() => kit.store.meeting(m.id).botId);
      const stopped = lifecycle(kit, m.id, "bot.stopped");
      await kit.tick();
      await waitFor(() => jobDone(kit, stopped));
      makeDue(kit, `final:${m.id}`);
      await kit.tick();
      await waitFor(() => kit.store.meeting(m.id).postCallStatus === "failed");
      available = true;
      if (trigger === "manual retry") {
        assert.equal(
          (await kit.request(`/api/meetings/${m.id}/retry`, {})).status,
          200,
        );
      } else {
        const ready = lifecycle(kit, m.id, "transcription.processed");
        await kit.tick();
        await waitFor(() => jobDone(kit, ready));
      }
      await kit.tick();
      await waitFor(() => kit.store.meeting(m.id).postCallStatus === "ready");
      assert.equal(kit.store.meeting(m.id).status, "completed");
      assert.equal(kit.store.failed(m.id).length, 0);
      assert.equal(
        kit.store.cues(m.id).filter((c) => c.kind === "final").length,
        1,
      );
    } finally {
      await kit.close();
    }
  });

for (const status of ["Processing", "Skipped", "Failed"])
  test(`HTTP 202 transcript ${status} is ${status === "Processing" ? "retried" : "terminal"}`, async () => {
    const kit = await launch({
      startWorker: false,
      env: liveEnv,
      meetstream: {
        bots: {
          create: async () => ({
            bot_id: "regression-bot",
            transcript_id: "regression-transcript",
          }),
        },
        transcripts: {
          get: async () => {
            const message = `Transcript is still being processed. Current status: ${status}`;
            throw new NotReadyError(message, {
              status: 202,
              body: { message },
            });
          },
        },
      },
    });
    try {
      const m = await (await kit.request("/api/meetings", liveInput)).json();
      await kit.tick();
      await waitFor(() => kit.store.meeting(m.id).botId);
      const stopped = lifecycle(kit, m.id, "bot.stopped");
      await kit.tick();
      await waitFor(() => jobDone(kit, stopped));
      const id = `final:${m.id}`;
      makeDue(kit, id);
      await kit.tick();
      await waitFor(
        () =>
          kit.store.db.prepare("SELECT status FROM jobs WHERE id=?").get(id)
            .status !== "running",
      );
      const job = kit.store.db
        .prepare("SELECT status,attempts FROM jobs WHERE id=?")
        .get(id);
      assert.equal(job.status, status === "Processing" ? "queued" : "failed");
      assert.equal(job.attempts, 1);
      if (status !== "Processing") {
        assert.equal(kit.store.meeting(m.id).postCallStatus, "failed");
        assert.match(
          kit.store.meeting(m.id).lastError,
          /No post-call transcript was produced/,
        );
      }
    } finally {
      await kit.close();
    }
  });

test("paged library treats search literally, clamps pages and archives complete originals without webhook tokens", async () => {
  const kit = await launch({ startWorker: false });
  try {
    for (let i = 0; i < 23; i++)
      kit.store.saveMeeting({
        id: `page-${i}`,
        title: i === 22 ? "100% progress" : "Meeting " + i,
        mode: "demo",
        targets: ["en"],
        liveToken: "private-webhook-token",
      });
    const page = await (await kit.request("/api/meetings?page=2")).json();
    assert.equal(page.items.length, 10);
    assert.equal(page.total, 23);
    assert.equal(page.pages, 3);
    assert.equal(
      (await (await kit.request("/api/meetings?page=99")).json()).page,
      3,
    );
    const search = await (
      await kit.request("/api/meetings?page=1&q=%25")
    ).json();
    assert.equal(search.total, 1);
    assert.equal((await kit.request("/api/meetings?page=-1")).status, 400);
    const archived = await (
      await kit.request("/api/meetings/page-22/archive")
    ).json();
    assert.equal(archived.schemaVersion, 1);
    assert.equal(archived.meeting.liveToken, undefined);
  } finally {
    await kit.close();
  }
});

test("recording playback uses fresh provider URLs, supports range requests, guards storage hosts and identifies absent audio", async () => {
  let urlCalls = 0;
  const kit = await launch({
    meetstream: {
      bots: {
        audio: async () => {
          urlCalls++;
          return { audio_url: "https://media.s3.amazonaws.com/audio.wav" };
        },
      },
    },
    fetchImpl: async (url, opts) => {
      assert.equal(url, "https://media.s3.amazonaws.com/audio.wav");
      assert.equal(opts.headers.Range, "bytes=0-3");
      return new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 206,
        headers: {
          "content-range": "bytes 0-3/8",
          "content-length": "4",
          "accept-ranges": "bytes",
        },
      });
    },
    startWorker: false,
  });
  try {
    const m = {
      id: "recorded",
      mode: "live",
      botId: "bot",
      endedAt: Date.now(),
      targets: ["en"],
    };
    kit.store.saveMeeting(m);
    const metadata = await (
      await kit.request("/api/meetings/recorded/recording")
    ).json();
    assert.equal(metadata.audio.status, "ready");
    assert.equal(metadata.audio.url, undefined);
    const response = await kit.request(
      "/api/meetings/recorded/recording/audio",
      undefined,
      { Range: "bytes=0-3" },
    );
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("content-range"), "bytes 0-3/8");
    assert.equal((await response.arrayBuffer()).byteLength, 4);
    assert.equal(urlCalls, 2);
    assert.equal(
      (
        await kit.request("/api/meetings/recorded/recording/audio", undefined, {
          Range: "nonsense",
        })
      ).status,
      416,
    );
  } finally {
    await kit.close();
  }
  for (const [data, status] of [
    [{ audio_status: "no_audio" }, "unavailable"],
    [{ audio_status: "processing" }, "processing"],
    [{ audio_url: "https://127.0.0.1/audio.wav" }, null],
  ]) {
    const k = await launch({
      meetstream: { bots: { audio: async () => data } },
      startWorker: false,
    });
    try {
      k.store.saveMeeting({ id: "x", mode: "live", botId: "bot", endedAt: 1 });
      const r = await k.request("/api/meetings/x/recording");
      if (status) assert.equal((await r.json()).audio.status, status);
      else assert.equal(r.status, 502);
    } finally {
      await k.close();
    }
  }
});

test("nested bot details resolve the post-call transcript; token-protected callbacks reject wrong bots", async () => {
  const kit = await launch({
    env: { PUBLIC_ORIGIN: "https://kit.example" },
    meetstream: {
      bots: {
        detail: async () => ({
          bot_details: { transcript_id: "nested-transcript" },
        }),
      },
      transcripts: {
        get: async (id) => {
          assert.equal(id, "nested-transcript");
          return [
            {
              speaker: "Test speaker",
              transcript: "नमस्ते",
              start_time: 0,
              end_time: 1,
            },
          ];
        },
      },
    },
    startWorker: false,
  });
  try {
    const m = {
      id: "nested",
      mode: "live",
      source: "hi",
      targets: ["hi"],
      botId: "bot-nested",
      liveToken: "callback-test-secret",
      status: "stopped",
      endedAt: 1,
      postCallStatus: "pending",
    };
    kit.store.saveMeeting(m);
    assert.equal(
      (
        await kit.request("/webhooks/callback/nested/wrong", {
          bot_id: "bot-nested",
          event: "bot.done",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await kit.request("/webhooks/callback/nested/callback-test-secret", {
          bot_id: "wrong",
          event: "bot.done",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await kit.request("/webhooks/callback/nested/callback-test-secret", {
          bot_id: "bot-nested",
          event: "bot.done",
        })
      ).status,
      202,
    );
    kit.store.enqueue("nested-final", "final", { meetingId: m.id });
    await kit.tick();
    await waitFor(() => kit.store.meeting(m.id).postCallStatus === "ready");
    assert.equal(kit.store.cues(m.id)[0].speaker, "Test speaker");
  } finally {
    await kit.close();
  }
});

test("re-transcription uses the selected provider, stays idempotent and recovers a failed final job", async () => {
  let calls = 0;
  const kit = await launch({
    env: { PUBLIC_ORIGIN: "https://kit.example" },
    meetstream: {
      bots: {
        audio: async () => ({
          audio_url: "https://media.s3.amazonaws.com/audio.wav",
        }),
      },
      transcripts: {
        transcribeBotAudio: async (bot, body) => {
          calls++;
          assert.equal(bot, "retry-bot");
          assert.equal(body.provider.deepgram.language, "ta");
          assert.equal(body.provider.deepgram.model, "nova-3");
          return { transcript_id: "recovered-id" };
        },
        get: async () => [
          {
            speaker: "Tamil test speaker",
            transcript: "வணக்கம்",
            start_time: 1,
            end_time: 2,
          },
        ],
      },
    },
    startWorker: false,
  });
  try {
    const m = {
      id: "recover-recording",
      mode: "live",
      source: "ta",
      targets: [],
      postCallProvider: "deepgram",
      botId: "retry-bot",
      liveToken: "secret-path-token",
      status: "stopped",
      endedAt: 1,
      postCallStatus: "failed",
    };
    kit.store.saveMeeting(m);
    kit.store.enqueue("final:" + m.id, "final", { meetingId: m.id });
    kit.store.fail("final:" + m.id, "previous provider error");
    for (let i = 0; i < 2; i++)
      assert.equal(
        (await kit.request(`/api/meetings/${m.id}/retranscribe`, {})).status,
        202,
      );
    await kit.tick();
    await waitFor(
      () => kit.store.meeting(m.id).transcriptId === "recovered-id",
    );
    await kit.tick();
    await waitFor(() => kit.store.meeting(m.id).postCallStatus === "ready");
    assert.equal(calls, 1);
    assert.equal(kit.store.cues(m.id)[0].speaker, "Tamil test speaker");
    assert.equal(
      (await kit.request(`/api/meetings/${m.id}/retranscribe`, {})).status,
      409,
    );
  } finally {
    await kit.close();
  }
});

test("audio remains available while opted-in video has not been produced", async () => {
  const kit = await launch({
    meetstream: {
      bots: {
        audio: async () => ({
          audio_url: "https://media.s3.amazonaws.com/audio.wav",
        }),
        video: async () => {
          throw Object.assign(
            new Error("No video processing has been initiated"),
            { status: 404 },
          );
        },
      },
    },
    startWorker: false,
  });
  try {
    kit.store.saveMeeting({
      id: "audio-only-ready",
      mode: "live",
      endedAt: 1,
      botId: "bot",
      recordVideo: true,
    });
    const r = await kit.request("/api/meetings/audio-only-ready/recording");
    assert.equal(r.status, 200);
    const data = await r.json();
    assert.equal(data.audio.status, "ready");
    assert.equal(data.video.status, "unavailable");
  } finally {
    await kit.close();
  }
});

test("browser connection settings require authentication, hide secrets, activate immediately and persist privately across restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kit-connections-"));
  const path = join(dir, "connections.json");
  const invalidPath = join(dir, "invalid.json");
  writeFileSync(invalidPath, "not-json private-value");
  assert.throws(
    () =>
      createApp({
        env: {},
        database: ":memory:",
        connectionsPath: invalidPath,
      }),
    /Saved connection settings are invalid/,
  );
  writeFileSync(invalidPath, JSON.stringify({ values: null, checks: {} }));
  assert.throws(
    () =>
      createApp({
        env: {},
        database: ":memory:",
        connectionsPath: invalidPath,
      }),
    /Saved connection settings are invalid/,
  );
  let usedKey;
  const opts = {
    connectionsPath: path,
    startWorker: false,
    env: {
      APP_PASSWORD: "settings-password",
      GOOGLE_TRANSLATE_API_KEY: "old-google-secret",
    },
    fetchImpl: async (_url, options) => {
      usedKey = options.headers["X-Goog-Api-Key"];
      return Response.json({
        data: { translations: [{ translatedText: "Hello" }] },
      });
    },
  };
  let kit = await launch(opts);
  try {
    assert.equal(
      (
        await kit.request("/api/connections/google", {
          values: { GOOGLE_TRANSLATE_API_KEY: "new-google-secret" },
        })
      ).status,
      401,
    );
    async function headers() {
      const login = await kit.request("/api/login", {
        password: "settings-password",
      });
      return { Cookie: login.headers.get("set-cookie").split(";")[0] };
    }
    let h = await headers();
    assert.equal(
      (await kit.request("/api/connections/google", { values: null }, h))
        .status,
      400,
    );
    assert.equal(
      (
        await kit.request(
          "/api/connections/google",
          { values: { GOOGLE_TRANSLATE_API_KEY: "bad\nkey" } },
          h,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await kit.request(
          "/api/connections/google",
          { values: { APP_PASSWORD: "hijack" } },
          h,
        )
      ).status,
      400,
    );
    assert.equal(
      (await kit.request("/api/connections/__proto__", { values: {} }, h))
        .status,
      400,
    );
    assert.equal(
      (
        await kit.request(
          "/api/connections/google",
          { values: { GOOGLE_TRANSLATE_API_KEY: "new-google-secret" } },
          { ...h, Origin: "https://foreign.example" },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await kit.request(
          "/api/connections/google",
          { values: { GOOGLE_TRANSLATE_API_KEY: "new-google-secret" } },
          h,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await kit.request(
          "/api/connections/google",
          { values: { GOOGLE_TRANSLATE_API_KEY: "" } },
          h,
        )
      ).status,
      200,
    );
    assert.equal(
      (await kit.request("/api/connections/google/test", {}, h)).status,
      200,
    );
    assert.equal(usedKey, "new-google-secret");
    const config = await (
      await kit.request("/api/config", undefined, h)
    ).json();
    assert.equal(
      config.connections.find((c) => c.id === "google").check.status,
      "passed",
    );
    assert.ok(!JSON.stringify(config).includes("new-google-secret"));
    await kit.request(
      "/api/connections/google",
      { values: { GOOGLE_TRANSLATE_API_KEY: "" } },
      h,
    );
    const unchanged = await (
      await kit.request("/api/config", undefined, h)
    ).json();
    assert.deepEqual(
      unchanged.connections.find((c) => c.id === "google").check,
      config.connections.find((c) => c.id === "google").check,
    );
    const { statSync, readFileSync } = await import("node:fs");
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.match(readFileSync(path, "utf8"), /new-google-secret/);
    await kit.close();
    kit = await launch(opts);
    h = await headers();
    await kit.request("/api/connections/google/test", {}, h);
    assert.equal(usedKey, "new-google-secret");
    assert.equal(
      (await kit.request("/api/connections/google", { disconnect: true }, h))
        .status,
      200,
    );
    await kit.close();
    kit = await launch(opts);
    h = await headers();
    assert.equal(
      (await (await kit.request("/api/config", undefined, h)).json()).providers
        .google,
      false,
    );
  } finally {
    await kit.close();
    rmSync(dir, { recursive: true, force: true });
  }
  const demo = await launch();
  try {
    assert.equal(
      (await demo.request("/api/connections/google", { values: {} })).status,
      409,
    );
  } finally {
    await demo.close();
  }
});

test("meeting notebook preserves transcripts, validates action items, detects conflicting edits and includes notes in archives", async () => {
  const kit = await launch({ startWorker: false });
  try {
    const m = await (
      await kit.request("/api/meetings", {
        mode: "demo",
        title: "Original",
        targets: ["en"],
      })
    ).json();
    const patch = (body) =>
      fetch(`${kit.base}/api/meetings/${m.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const details = {
      title: "Renamed हिन्दी",
      notes: "Decisions\n<script>alert(1)</script>",
      actions: [
        {
          id: "action-1",
          text: "Send translated notes",
          owner: "Arjun",
          done: false,
        },
      ],
      version: 0,
    };
    assert.equal(
      (await patch({ ...details, title: "a".repeat(101) })).status,
      400,
    );
    assert.equal((await patch({ ...details, botId: "tampered" })).status, 400);
    assert.equal(
      (
        await patch({
          ...details,
          actions: [...details.actions, ...details.actions],
        })
      ).status,
      400,
    );
    const saved = await (await patch(details)).json();
    assert.equal(saved.meeting.title, details.title);
    assert.equal(saved.meeting.metadataVersion, 1);
    assert.equal((await patch(details)).status, 409);
    assert.equal(
      (
        await patch({
          ...details,
          version: 1,
          actions: [{ ...details.actions[0], done: true }],
        })
      ).status,
      200,
    );
    const archive = await (
      await kit.request(`/api/meetings/${m.id}/archive`)
    ).json();
    assert.equal(archive.meeting.notes, details.notes);
    assert.equal(archive.meeting.actions[0].done, true);
    assert.deepEqual(archive.cues, []);
    const notes = await kit.request(`/api/meetings/${m.id}/notes`);
    assert.match(notes.headers.get("content-type"), /text\/plain/);
    assert.match(await notes.text(), /\[x\] Send translated notes — Arjun/);
    assert.equal(
      (await (await kit.request("/api/meetings?page=1&q=Renamed")).json())
        .total,
      1,
    );
  } finally {
    await kit.close();
  }
});

test("Deepgram saved-audio diagnostic checks the existing MeetStream integration without replacing meeting transcripts", async () => {
  let calls = 0,
    ready = false;
  const kit = await launch({
    startWorker: false,
    env: { APP_PASSWORD: "private-workspace" },
    meetstream: {
      bots: {
        audio: async () => ({
          audio_mp3_url: "https://media.s3.amazonaws.com/test.mp3",
        }),
      },
      transcripts: {
        transcribeBotAudio: async (bot, body) => {
          calls++;
          assert.equal(bot, "existing-bot");
          assert.equal(body.provider.deepgram.language, "ta");
          return { transcript_id: "dg-test" };
        },
        get: async () => {
          if (!ready) throw new NotReadyError("Processing", { status: 202 });
          return [
            {
              transcript: "வணக்கம்",
              start_time: 0,
              end_time: 1,
              speaker: "Tamil speaker",
            },
          ];
        },
      },
    },
  });
  try {
    kit.store.saveMeeting({
      id: "saved-meeting",
      title: "Saved audio",
      mode: "live",
      botId: "existing-bot",
      endedAt: Date.now(),
      createdAt: Date.now(),
      status: "completed",
      postCallStatus: "ready",
      transcriptId: "original-transcript",
      source: "auto",
      targets: ["en"],
      liveToken: "private-token",
    });
    const login = await kit.request("/api/login", {
        password: "private-workspace",
      }),
      h = { Cookie: login.headers.get("set-cookie").split(";")[0] };
    assert.equal(
      (
        await kit.request(
          "/api/connections/deepgram/test",
          { meetingId: "saved-meeting", source: "auto" },
          h,
        )
      ).status,
      400,
    );
    const result = await kit.request(
      "/api/connections/deepgram/test",
      { meetingId: "saved-meeting", source: "ta" },
      h,
    );
    assert.equal(result.status, 200);
    await kit.request(
      "/api/connections/meetstream",
      { values: { MEETSTREAM_API_KEY: "" } },
      h,
    );
    assert.equal(
      (await (await kit.request("/api/config", undefined, h)).json()).deepgram
        .status,
      "processing",
    );
    assert.equal(
      (
        await kit.request(
          "/api/connections/deepgram/test",
          { meetingId: "saved-meeting", source: "ta" },
          h,
        )
      ).status,
      409,
    );
    assert.equal(calls, 1);
    assert.equal(
      (
        await (
          await kit.request("/api/connections/deepgram/refresh", {}, h)
        ).json()
      ).status,
      "processing",
    );
    ready = true;
    assert.equal(
      (
        await (
          await kit.request("/api/connections/deepgram/refresh", {}, h)
        ).json()
      ).status,
      "passed",
    );
    assert.equal(
      kit.store.meeting("saved-meeting").transcriptId,
      "original-transcript",
    );
    assert.equal(kit.store.meeting("saved-meeting").postCallStatus, "ready");
  } finally {
    await kit.close();
  }
});

test("meeting status filters combine with literal search and pagination without mixing finished or failed calls", async () => {
  const kit = await launch({ startWorker: false });
  try {
    for (let i = 0; i < 12; i++)
      kit.store.saveMeeting({
        id: `active-${i}`,
        title: `Navigation ${i}`,
        status: "live",
        mode: "demo",
        targets: ["en"],
      });
    kit.store.saveMeeting({
      id: "finished-call",
      title: "Navigation finished",
      status: "completed",
      endedAt: Date.now(),
      targets: ["en"],
    });
    kit.store.saveMeeting({
      id: "failed-call",
      title: "Navigation failed",
      status: "failed",
      lastError: "Provider key missing",
      targets: ["en"],
    });
    for (const [status, total] of [
      ["all", 14],
      ["active", 12],
      ["finished", 1],
      ["attention", 1],
    ]) {
      const response = await kit.request(
        `/api/meetings?page=1&q=Navigation&status=${status}`,
      );
      assert.equal(response.status, 200);
      const data = await response.json();
      assert.equal(data.total, total);
      assert.equal(data.status, status);
    }
    const second = await (
      await kit.request("/api/meetings?page=2&q=Navigation&status=active")
    ).json();
    assert.equal(second.items.length, 2);
    assert.equal(second.page, 2);
    assert.equal(
      (await kit.request("/api/meetings?page=1&status=constructor")).status,
      400,
    );
  } finally {
    await kit.close();
  }
});

test("Deepgram incremental live payloads and empty partials are accepted without inventing final captions", async () => {
  const kit = await launch({ startWorker: false });
  try {
    kit.store.saveMeeting({
      id: "deepgram-live",
      title: "DG payload",
      botId: "dg-bot",
      mode: "live",
      source: "ta",
      targets: [],
      createdAt: 1000,
      liveToken: "private-live-token",
      status: "live",
    });
    const path = "/webhooks/live/deepgram-live/private-live-token";
    assert.equal(
      (
        await kit.request(path, {
          bot_id: "dg-bot",
          end_of_turn: false,
          new_text: "",
        })
      ).status,
      202,
    );
    assert.equal(kit.store.cues("deepgram-live").length, 0);
    assert.equal(
      (
        await kit.request(path, {
          bot_id: "dg-bot",
          speakerName: "Tamil speaker",
          end_of_turn: true,
          new_text: "வணக்கம்",
          words: [{ start: 1, end: 2 }],
        })
      ).status,
      202,
    );
    await kit.tick();
    await waitFor(() => kit.store.cues("deepgram-live").length === 1);
    const cue = kit.store.cues("deepgram-live")[0];
    assert.equal(cue.text, "வணக்கம்");
    assert.equal(cue.speaker, "Tamil speaker");
    assert.equal(cue.start, 1);
    assert.equal(cue.source, "ta");
  } finally {
    await kit.close();
  }
});

test("provider diagnostics expose HTTP status and redact credentials from untrusted request IDs", async () => {
  const kit = await launch({
    startWorker: false,
    env: {
      APP_PASSWORD: "diagnostic-password",
      MEETSTREAM_API_KEY: "provider-test-key",
    },
    meetstream: {
      bots: {
        audio: async () => ({
          audio_mp3_url: "https://media.s3.amazonaws.com/test.mp3",
        }),
      },
      transcripts: {
        transcribeBotAudio: async () => {
          throw Object.assign(new Error("Provider key missing"), {
            status: 400,
            requestId: "trace-provider-test-key",
          });
        },
      },
    },
  });
  try {
    kit.store.saveMeeting({
      id: "diagnostic-meeting",
      mode: "live",
      botId: "diagnostic-bot",
      endedAt: Date.now(),
      status: "completed",
      title: "Diagnostic",
    });
    const login = await kit.request("/api/login", {
        password: "diagnostic-password",
      }),
      h = { Cookie: login.headers.get("set-cookie").split(";")[0] };
    assert.equal(
      (
        await kit.request(
          "/api/connections/deepgram/test",
          { meetingId: "diagnostic-meeting", source: "hi" },
          h,
        )
      ).status,
      502,
    );
    const config = await (
      await kit.request("/api/config", undefined, h)
    ).json();
    assert.equal(config.deepgram.upstreamStatus, 400);
    assert.equal(config.deepgram.requestId, "trace-redacted");
    assert.ok(!JSON.stringify(config).includes("provider-test-key"));
  } finally {
    await kit.close();
  }
});

test('extension pairing is single-use, meeting-scoped, secret-free, revocable and queues added languages', async () => {
  const kit = await launch({ env: { APP_PASSWORD:'extension-password' } });
  try {
    const login = await kit.request('/api/login',{password:'extension-password'});
    const h = { Cookie: login.headers.get('set-cookie').split(';')[0] };
    const m = await (await kit.request('/api/meetings',{title:'Caption sample'},h)).json();
    assert.equal((await kit.request('/api/extension/pairing',{meetingId:m.id})).status,401);
    assert.equal((await kit.request('/api/extension/pairing',{meetingId:m.id},{...h,Origin:'https://evil.example'})).status,403);
    const grant = await (await kit.request('/api/extension/pairing',{meetingId:m.id},h)).json();
    const auth = await (await kit.request('/extension-api/pair',{code:grant.code})).json();
    const eh = { Authorization:`Bearer ${auth.token}` };
    assert.equal((await kit.request('/extension-api/pair',{code:grant.code})).status,401);
    assert.equal((await kit.request('/api/config',undefined,eh)).status,401);
    assert.equal((await kit.request('/extension-api/captions',undefined,{...eh,Origin:'https://evil.example'})).status,403);
    await waitFor(()=>kit.store.cues(m.id).length>0);
    const data = await (await kit.request('/extension-api/captions?target=en',undefined,eh)).json();
    assert.equal(data.meeting.id,m.id);
    assert.equal(data.meeting.liveToken,undefined);
    assert.equal(data.meeting.botId,undefined);
    assert.equal(data.cues[0].speaker,'Ananya Rao');
    assert.equal((await kit.request('/extension-api/language',{target:'ta'},eh)).status,200);
    await waitFor(()=>kit.store.cues(m.id)[0].translations.ta?.status==='ready');
    assert.equal((await kit.request('/extension-api/language',{target:'fr'},eh)).status,409);
    await kit.request('/api/extension/revoke',{},h);
    assert.equal((await kit.request('/extension-api/captions',undefined,eh)).status,401);
    const second = await (await kit.request('/api/extension/pairing',{meetingId:m.id},h)).json();
    kit.store.db.prepare("UPDATE extension_tokens SET expires=0 WHERE kind='pair'").run();
    assert.equal((await kit.request('/extension-api/pair',{code:second.code})).status,401);
  } finally { await kit.close(); }
});

test('AssemblyAI and JigsawStack saved-audio checks use managed keys without replacing meeting transcripts', async () => {
  const seen=[];
  const kit = await launch({ env:{ APP_PASSWORD:'provider-test-password' }, meetstream: { bots: { audio:async()=>({audio_mp3_url:'https://storage.amazonaws.com/test.mp3'}) }, transcripts: { transcribeBotAudio:async(_id,config)=>{seen.push(config);return {transcript_id:'test-transcript'}},get:async()=>[{speaker:'Test',transcript:'வணக்கம்',start_time:0,end_time:1}] } } });
  try {
    const login=await kit.request('/api/login',{password:'provider-test-password'});
    const h={Cookie:login.headers.get('set-cookie').split(';')[0]};
    kit.store.saveMeeting({id:'recorded',botId:'bot',mode:'live',source:'ta',endedAt:Date.now(),postCallStatus:'ready',targets:['hi'],translationProvider:'google'});
    for(const id of ['assemblyai','jigsawstack_asr']) {
      assert.equal((await kit.request(`/api/connections/${id}/test`,{meetingId:'recorded',source:'ta'},h)).status,200);
      const result=await(await kit.request(`/api/connections/${id}/refresh`,{},h)).json();
      assert.equal(result.status,'passed');
    }
    assert.equal(seen[0].provider.assemblyai.language_code,'ta');
    assert.equal(seen[1].provider.jigsawstack.by_speaker,true);
    assert.equal(kit.store.meeting('recorded').transcriptId,undefined);
    assert.equal(kit.store.cues('recorded').length,0);
  } finally { await kit.close(); }
});

test('automatic text detection does not trust an incorrect ASR language hint', async () => {
  let body;
  const kit=await launch({env:{PUBLIC_ORIGIN:'https://kit.example',MEETSTREAM_API_KEY:'key',GOOGLE_TRANSLATE_API_KEY:'key'},meetstream:{bots:{create:async()=>({bot_id:'auto-bot'})}},fetchImpl:async(_url,options)=>{body=JSON.parse(options.body);return Response.json({data:{translations:[{translatedText:'Hello',detectedSourceLanguage:'hi'}]}})}});
  try {
    const m=await(await kit.request('/api/meetings',{title:'Auto source',mode:'live',meetingLink:'https://meet.google.com/abc-defg-hij',targets:['en'],source:'auto'})).json();
    await waitFor(()=>kit.store.meeting(m.id).botId);
    const saved=kit.store.meeting(m.id);
    await kit.request(`/webhooks/live/${m.id}/${saved.liveToken}`,{bot_id:saved.botId,transcript:'नमस्ते',language_code:'en',speakerName:'Test',start_time:0,end_time:1});
    await waitFor(()=>kit.store.cues(m.id)[0]?.translations.en?.status==='ready');
    assert.equal(body.source,undefined);
    assert.equal(kit.store.cues(m.id)[0].translations.en.detectedSource,'hi');
    assert.equal(kit.store.cues(m.id)[0].source,'hi');
    assert.equal(kit.store.cues(m.id)[0].asrSource,'en'); // Raw provider language hint is retained honestly.
  } finally { await kit.close(); }
});

test('missing speech keys during bot creation update managed connection diagnostics', async () => {
  const kit = await launch({env:{PUBLIC_ORIGIN:'https://kit.example',GOOGLE_TRANSLATE_API_KEY:'mock',MEETSTREAM_API_KEY:'private-meetstream-credential'},meetstream:{bots:{create:async payload=>{
    const provider = Object.keys(payload.recording_config.transcript.provider)[0].replace('_streaming','');
    const name = {deepgram:'Deepgram',assemblyai:'AssemblyAI',jigsawstack:'JigsawStack'}[provider];
    throw Object.assign(new Error(`${name}APIKey is not configured in user profile.`),{status:400});
  }}}});
  try {
    for (const provider of ['deepgram','assemblyai','jigsawstack']) {
      const response = await kit.request('/api/meetings',{title:`Missing ${provider}`,mode:'live',meetingLink:'https://meet.google.com/abc-defg-hij',source:provider==='assemblyai'?'en':'hi',liveProvider:provider+'_streaming',postCallProvider:provider});
      assert.equal(response.status,201);
      const m = await response.json();
      await waitFor(()=>kit.store.meeting(m.id)?.status==='failed');
      const config = await(await kit.request('/api/config')).json();
      assert.equal(config.meetstreamCredential.source,'.env');
      assert.match(config.meetstreamCredential.fingerprint,/^[a-f0-9]{12}$/);
      assert.ok(!JSON.stringify(config).includes('private-meetstream-credential'));
      const check = provider==='deepgram'?config.deepgram:config.managedChecks[provider==='jigsawstack'?'jigsawstack_asr':provider];
      assert.equal(check.status,'failed');
      assert.equal(check.kind,'bot_creation');
      assert.equal(check.meetingId,m.id);
      assert.equal(check.upstreamStatus,400);
      assert.match(check.message,/current API workspace/);
    }
  } finally { await kit.close(); }
});

test('live provider errors retain the actionable message, redact credentials, and update the connection check', async()=>{
  const kit=await launch({env:{MEETSTREAM_API_KEY:'private-test-key',GOOGLE_TRANSLATE_API_KEY:'mock'},startWorker:false,fetchImpl:async()=>Response.json({data:{translations:[{translatedText:'Hello'}]}})});
  try {
    kit.store.saveMeeting({id:'error-meeting',botId:'error-bot',mode:'live',status:'live',postCallStatus:'pending',liveProvider:'jigsawstack_streaming',targets:['en'],source:'hi',translationProvider:'google',createdAt:Date.now()});
    kit.store.enqueue('provider-error','lifecycle',{meetingId:'error-meeting',body:{bot_id:'error-bot',event:'bot.error',message:'JigsawStack authentication failed (HTTP 401). private-test-key Token unknown-secret'}});
    await kit.tick();
    await waitFor(()=>kit.store.meeting('error-meeting').liveError);
    const message=kit.store.meeting('error-meeting').liveError;
    assert.match(message,/authentication failed \(HTTP 401\)/);
    assert.ok(!message.includes('private-test-key')&&!message.includes('unknown-secret'));
    const config=await(await kit.request('/api/config')).json();
    assert.equal(config.managedChecks.jigsawstack_asr.kind,'live_transcription');
    assert.equal(config.managedChecks.jigsawstack_asr.upstreamStatus,401);
    assert.equal(config.managedChecks.jigsawstack_asr.message,message);
    kit.store.enqueue('recovered-caption','live',{meetingId:'error-meeting',receivedAt:Date.now(),body:{bot_id:'error-bot',speakerName:'Test',transcript:'नमस्ते',end_of_turn:true,start_time:0,end_time:1}});
    await kit.tick();
    await waitFor(()=>kit.store.meeting('error-meeting').liveError===null);
    assert.equal(kit.store.meeting('error-meeting').lastError,null);
    assert.equal((await(await kit.request('/api/config')).json()).managedChecks.jigsawstack_asr.status,'passed');
  } finally {await kit.close();}
});

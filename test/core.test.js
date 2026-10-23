import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  validateMeeting,
  validatePublicOrigin,
  botPayload,
  normalizeLive,
  normalizeTranscript,
  verifyWebhook,
  percentile,
  summarize,
  chrf,
} from "../server/core.js";
import { exportArtifact, timestamp } from "../server/exports.js";
const m = {
  ...validateMeeting({ title: "Accessible meeting", mode: "demo" }),
  id: "meeting-1",
  createdAt: 1000,
  botId: "bot-1",
  liveToken: "secret",
};
const caption = () => ({
  ...normalizeLive(
    {
      bot_id: "bot-1",
      speakerName: "Ananya",
      speakerId: "a",
      transcript: "नमस्ते",
      timestamp: "2026-10-12T00:00:00Z",
      words: [{ start: 1, end: 2 }],
    },
    m,
    2000,
  ),
  source: "hi",
  translations: {
    en: {
      status: "ready",
      text: "Hello",
      durationMs: 120,
      readyAt: 2160,
      detectedSource: "hi",
    },
  },
});
test("validation rejects unsupported providers, target lists and unsafe meeting links", () => {
  for (const input of [
    { targets: ["xx"] },
    { targets: ["constructor"] },
    { source: "toString" },
    { targets: [] },
    { targets: ["en", "en"] },
    { source: "xx" },
    { liveProvider: "unknown" },
    { translationProvider: "unknown" },
    { mode: "oops" },
    { mode: "live", meetingLink: "https://evil.example/meeting" },
    { mode: "live", meetingLink: "http://meet.google.com/a" },
    { mode: "live", meetingLink: "https://meet.google.com@evil.example/" },
    { liveProvider: "deepgram_streaming", source: "auto" },
  ])
    assert.throws(() => validateMeeting({ title: "Meeting", ...input }));
  assert.equal(
    validateMeeting({
      title: "Meeting",
      mode: "live",
      meetingLink: "https://us02web.zoom.us/j/123456789",
    }).mode,
    "live",
  );
});
test("public webhook origin is normalized and rejects invalid deployment configuration", () => {
  assert.equal(
    validatePublicOrigin("https://kit.example/"),
    "https://kit.example",
  );
  assert.equal(validatePublicOrigin(undefined), "");
  for (const origin of [
    "https://",
    "http://kit.example",
    "https://kit.example/path",
    "https://user:password@kit.example",
    "https://kit.example?x=1",
    "https://kit.example/#fragment",
  ])
    assert.throws(() => validatePublicOrigin(origin), /PUBLIC_ORIGIN/);
});
test("bot payload enables exactly one live and one post-call provider, keeps originals and audio", () => {
  const p = botPayload(m, "https://example.com");
  assert.notEqual(p.bot_name, botPayload({ ...m, id: "another-meeting" }, "https://example.com").bot_name);
  assert.equal(p.video_required, false);
  assert.equal(p.audio_required, true);
  assert.deepEqual(Object.keys(p.recording_config.transcript.provider), [
    "meetstream_streaming",
    "meetstream",
  ]);
  assert.equal(
    p.recording_config.transcript.provider.meetstream.translate,
    false,
  );
  assert.match(p.live_transcription_required.webhook_url, /meeting-1\/secret$/);
  assert.equal(p.recording_config.retention.hours, 48);
});
test("sentence normalization keeps speaker and actual provider timing; ignores partials", () => {
  const c = caption();
  assert.equal(c.speaker, "Ananya");
  assert.equal(c.speakerId, "a");
  assert.equal(c.start, 1);
  assert.equal(c.end, 2);
  assert.equal(c.timing, "provider-relative");
  assert.equal(normalizeLive({ bot_id: "bot-1", is_final: false }, m), null);
  assert.throws(() => normalizeLive({ bot_id: "other" }, m));
  const estimate = normalizeLive({ bot_id: "bot-1", transcript: "x" }, m, 7000);
  assert.equal(estimate.timing, "receipt-estimate");
  assert.equal(estimate.start, 6);
});
test("post-call normalization supports segment lists, wrapped arrays, participant maps and numeric speakers", () => {
  const s = {
    speaker: "Ananya",
    transcript: "Hello",
    start_time: 1,
    end_time: 2,
  };
  for (const payload of [
    [s],
    { transcript: [s] },
    { segments: [s] },
    { Ananya: [{ ...s, speaker: undefined }] },
  ]) {
    const cs = normalizeTranscript(payload, m);
    assert.equal(cs[0].text, "Hello");
    assert.equal(cs[0].speaker, "Ananya");
  }
  assert.equal(
    normalizeTranscript([{ ...s, speaker: 0 }], m)[0].speaker,
    "Speaker 0",
  );
  assert.throws(() =>
    normalizeTranscript([{ ...s, start_time: undefined }], m),
  );
  assert.throws(() =>
    normalizeTranscript(
      [{ ...s, transcript: undefined, text: "Wrong field" }],
      m,
    ),
  );
  assert.throws(() => normalizeTranscript([], m));
});
test("HMAC validation requires exact body, valid signed timestamp and replay window", () => {
  const now = Date.now(),
    at = new Date(now).toISOString(),
    raw = Buffer.from(JSON.stringify({ bot_id: "bot-1", timestamp: at }));
  const signature =
    "sha256=" + createHmac("sha256", "secret").update(raw).digest("hex");
  const headers = {
    "x-meetstream-signature": signature,
    "x-meetstream-timestamp": at,
  };
  assert.equal(verifyWebhook("secret", raw, headers, now), true);
  assert.equal(verifyWebhook("bad", raw, headers, now), false);
  assert.equal(verifyWebhook("secret", Buffer.from("{}"), headers, now), false);
  assert.equal(verifyWebhook("secret", raw, headers, now + 300001), false);
  assert.equal(
    verifyWebhook(
      "secret",
      raw,
      { ...headers, "x-meetstream-timestamp": "bad" },
      now,
    ),
    false,
  );
  assert.equal(
    verifyWebhook(
      "secret",
      raw,
      { ...headers, "x-meetstream-signature": "sha256=zz" },
      now,
    ),
    false,
  );
});
test("UTF-8 subtitle exports preserve speakers, timing, bilingual text and escape injection", () => {
  const c = caption(),
    vtt = exportArtifact(m, [c], {
      format: "vtt",
      target: "en",
      bilingual: true,
    });
  assert.match(vtt.content, /WEBVTT/);
  assert.match(vtt.content, /00:00:01.000 --> 00:00:02.000/);
  assert.match(vtt.content, /<v Ananya>नमस्ते\nHello<\/v>/);
  assert.match(vtt.content, /Simulated/);
  const srt = exportArtifact(m, [c], { format: "srt", target: "en" });
  assert.match(srt.content, /00:00:01,000 --> 00:00:02,000/);
  assert.match(srt.content, /Ananya: Hello/);
  assert.equal(timestamp(3661.234), "01:01:01.234");
  c.text = "<script>alert(1)</script>";
  c.speaker = "<img onerror=x>";
  const html = exportArtifact(m, [c], { format: "html", target: "en" });
  assert.match(html.content, /lang="hi"/);
  assert.match(html.content, /lang="en"/);
  assert.match(html.content, /&lt;script&gt;/);
  assert.doesNotMatch(html.content, /<script>/);
  assert.match(html.content, /&lt;img/);
  assert.throws(() => exportArtifact(m, [c], { target: "ta" }), /incomplete/);
  assert.throws(
    () => exportArtifact(m, [c], { kind: "final" }),
    /No post-call/,
  );
  assert.throws(() => exportArtifact(m, [c], { format: "exe" }));
});
test("metrics separate latency stages, exclude passthroughs and do not invent speech latency", () => {
  const c = caption();
  c.translations.hi = {
    status: "ready",
    text: c.text,
    passthrough: true,
    durationMs: 0,
    readyAt: 2000,
  };
  const metrics = summarize(
    [c],
    [{ cueId: c.id, target: "en", delayMs: 40 }],
    [{ cueId: c.id, target: "en", score: 4 }],
  );
  const g = metrics.find((g) => g.pair === "hi → en");
  assert.equal(g.translationP50, 120);
  assert.equal(g.pipelineP50, 160);
  assert.equal(g.displayP50, 40);
  assert.equal(g.quality, 4);
  assert.equal(g.speechToCaptionMs, null);
  const final = { ...c, id: "final-review", kind: "final" };
  assert.equal(
    summarize(
      [c, final],
      [],
      [{ cueId: final.id, target: "en", score: 3 }],
    ).find((g) => g.pair === "hi → en").quality,
    3,
  );
  assert.equal(percentile([], 0.95), null);
  assert.equal(chrf("hello", "hello"), 100);
  assert.equal(chrf("xyz", "abc"), 0);
  assert.ok(chrf("Hello world", "Hello there") < 100);
});

test("original-only exports remain available when translations fail and plain text keeps attributed turns", () => {
  const meeting = {
    id: "save-original",
    title: "Meeting",
    mode: "live",
    createdAt: 1,
  };
  const cues = [
    {
      id: "cue",
      kind: "live",
      start: 0,
      end: 1,
      text: "வணக்கம்",
      source: "ta",
      speaker: "Tamil speaker",
      timing: "provider-relative",
      translations: { hi: { status: "failed" } },
    },
  ];
  for (const format of ["txt", "vtt", "srt", "html", "md", "json"]) {
    const artifact = exportArtifact(meeting, cues, {
      format,
      target: "original",
    });
    assert.match(artifact.content, /வணக்கம்/);
    assert.match(artifact.content, /Tamil speaker/);
  }
  assert.throws(
    () => exportArtifact(meeting, cues, { format: "txt", target: "hi" }),
    /incomplete/,
  );
});

test("hosted post-call participant word records preserve names, IDs and relative timestamps", () => {
  const m = { id: "participant-shape", source: "auto", mode: "live" };
  const cues = normalizeTranscript(
    [
      {
        participant: { id: 100, name: "Hindi test speaker" },
        language_code: "hi",
        words: [
          {
            text: "नमस्ते",
            start_timestamp: { relative: 96.34, absolute: 96.34 },
            end_timestamp: { relative: 101.06, absolute: 101.06 },
          },
        ],
      },
    ],
    m,
  );
  assert.equal(cues[0].speaker, "Hindi test speaker");
  assert.equal(cues[0].speakerId, "100");
  assert.equal(cues[0].source, "hi");
  assert.equal(cues[0].start, 96.34);
  assert.equal(cues[0].end, 101.06);
  assert.throws(
    () =>
      normalizeTranscript(
        [{ participant: { id: 100 }, words: [{ text: "No timing" }] }],
        m,
      ),
    /timestamps/,
  );
});

test("current Nova-3 supports Hindi and Tamil with matching live and post-call providers", () => {
  for (const source of ["hi", "ta"]) {
    const m = {
      ...validateMeeting({
        title: "Indic acceptance",
        source,
        liveProvider: "deepgram_streaming",
      }),
      id: "indic",
      liveToken: "secret",
    };
    const body = botPayload(m, "https://kit.example");
    assert.equal(
      body.recording_config.transcript.provider.deepgram_streaming.language,
      source,
    );
    assert.equal(
      body.recording_config.transcript.provider.deepgram.language,
      source,
    );
    assert.equal(
      body.recording_config.transcript.provider.deepgram.model,
      "nova-3",
    );
    assert.equal(
      body.recording_config.transcript.provider.meetstream,
      undefined,
    );
  }
});

test('expanded providers enforce platform/model/source compatibility and preserve originals', () => {
  const base = { title: 'Meeting', mode: 'live', meetingLink: 'https://meet.google.com/abc-defg-hij', targets: ['en','hi','ta','es','fr','de','ja','ar'] };
  const jig = validateMeeting({ ...base, source: 'auto', liveProvider: 'jigsawstack_streaming', postCallProvider: 'jigsawstack', translationProvider: 'jigsawstack' });
  const payload = botPayload({ ...jig, id:'m',liveToken:'token'}, 'https://kit.example');
  assert.deepEqual(Object.keys(payload.recording_config.transcript.provider), ['jigsawstack_streaming','jigsawstack']);
  assert.equal(payload.recording_config.transcript.provider.jigsawstack.by_speaker,true);
  assert.equal(payload.recording_config.transcript.provider.jigsawstack.translate,false);
  const asr = validateMeeting({ ...base, source: 'en', liveProvider:'assemblyai_streaming',postCallProvider:'assemblyai' });
  const p = botPayload({ ...asr,id:'m',liveToken:'token'}, 'https://kit.example');
  assert.equal(p.recording_config.transcript.provider.assemblyai.language_code,'en');
  assert.equal(p.recording_config.transcript.provider.assemblyai_streaming.speech_model,'universal-streaming-english');
  for (const input of [ { ...jig, meetingLink:'https://zoom.us/j/123' }, { ...asr, source:'ta' }, { ...asr, source:'auto' }, { ...jig, postCallProvider:'meetstream' }, { ...base, targets:['na'],translationProvider:'google' } ]) assert.throws(()=>validateMeeting(input));
  const c = normalizeLive({ bot_id:'bot-1',new_text:'New turn',transcript:'Prior turn. New turn',speakerName:'Ananya' },m);
  assert.equal(c.text,'New turn');
});

import {meetingInvitation} from '../extension/meeting-links.js';
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { LANGUAGE_CATALOG, TRANSLATION_LANGUAGES, ASSEMBLY_LANGUAGES, DEEPGRAM_LANGUAGES, canonicalLanguage } from "./languages.js";

export const LANGUAGES = {
  ...LANGUAGE_CATALOG,
  en: "English",
  hi: "हिन्दी · Hindi",
  ta: "தமிழ் · Tamil",
  es: "Español · Spanish",
  fr: "Français · French",
  de: "Deutsch · German",
  pt: "Português · Portuguese",
  ja: "日本語 · Japanese",
  ar: "العربية · Arabic",
};
export const hash = (value) => createHash("sha256").update(value).digest("hex");
export const escapeHtml = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export function equal(a, b) {
  const x = Buffer.from(a || ""),
    y = Buffer.from(b || "");
  return x.length === y.length && timingSafeEqual(x, y);
}
export function verifyWebhook(secret, raw, headers, now = Date.now()) {
  const signature = headers["x-meetstream-signature"];
  if (!secret || !/^sha256=[a-f\d]{64}$/i.test(signature || "")) return false;
  if (
    !equal(
      signature.slice(7).toLowerCase(),
      createHmac("sha256", secret).update(raw).digest("hex"),
    )
  )
    return false;
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return false;
  }
  // The header is not signed. Anchor replay protection to the signed body's timestamp too.
  const sent = parseTimestamp(body.timestamp),
    header = parseTimestamp(headers["x-meetstream-timestamp"]);
  return (
    sent !== null &&
    header !== null &&
    Math.abs(sent - header) < 1000 &&
    Math.abs(now - sent) <= 300_000
  );
}
export function parseTimestamp(value) {
  if (typeof value !== "string" || !value) return null;
  const time = Date.parse(
    /(?:Z|[+-]\d\d:\d\d)$/i.test(value) ? value : `${value}Z`,
  );
  return Number.isFinite(time) ? time : null;
}
export function validatePublicOrigin(value) {
  if (!value) return "";
  try {
    const url = new URL(value);
    if (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash
    )
      return url.origin;
  } catch {}
  throw new Error(
    "PUBLIC_ORIGIN must be an HTTPS origin without credentials, a path, query or fragment.",
  );
}
export function validateMeeting(input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid meeting configuration.");
  const mode = input.mode || "demo",
    source = input.source || "auto",
    targets = input.targets || ["en", "hi"];
  if (!["demo", "live"].includes(mode))
    throw new Error("Choose demo or live mode.");
  if (source !== "auto" && !Object.hasOwn(LANGUAGES, source))
    throw new Error("Unsupported source language.");
  if (
    !Array.isArray(targets) ||
    !targets.length ||
    targets.length > 8 ||
    targets.some((x) => !Object.hasOwn(LANGUAGES, x)) ||
    new Set(targets).size !== targets.length
  )
    throw new Error("Select one to eight distinct target languages.");
  const liveProvider = input.liveProvider || "meetstream_streaming",
    translationProvider = input.translationProvider ?? "google";
  if (!["meetstream_streaming", "deepgram_streaming", "assemblyai_streaming", "jigsawstack_streaming"].includes(liveProvider))
    throw new Error("Unsupported transcription provider.");
  if (!Object.hasOwn(TRANSLATION_LANGUAGES, translationProvider))
    throw new Error("Unsupported translation provider.");
  if (
    liveProvider === "deepgram_streaming" &&
    !Object.hasOwn(DEEPGRAM_LANGUAGES, source)
  )
    throw new Error(
      "Choose a fixed source language for Deepgram. Use MeetStream for automatic detection.",
    );
  const postCallProvider =
    input.postCallProvider ||
    (liveProvider === "deepgram_streaming" ? "deepgram" : "meetstream");
  if (!["meetstream", "deepgram", "assemblyai", "jigsawstack"].includes(postCallProvider))
    throw new Error("Unsupported post-call transcription provider.");
  if (postCallProvider === "deepgram" && !Object.hasOwn(DEEPGRAM_LANGUAGES, source))
    throw new Error(
      "Choose a fixed source for Deepgram post-call transcription.",
    );
  if (translationProvider==='deepl' && source!=='auto' && !Object.hasOwn(TRANSLATION_LANGUAGES.deepl,source))
    throw Error('This source is outside the DeepL adapter’s verified catalog. Choose automatic detection or another text translator.');
  if (targets.some(t => !Object.hasOwn(TRANSLATION_LANGUAGES[translationProvider], t)))
    throw new Error("A target language is unsupported by the selected translation provider.");
  if (liveProvider === "assemblyai_streaming" && source !== "en")
    throw new Error("MeetStream currently supports AssemblyAI live transcription for English. Choose English or another live provider.");
  if (postCallProvider === "assemblyai" && !Object.hasOwn(ASSEMBLY_LANGUAGES, source))
    throw new Error("Choose a supported fixed source language for AssemblyAI Universal-2 post-call transcription.");
  if ((liveProvider === "jigsawstack_streaming" || postCallProvider === "jigsawstack") && source !== "auto" && !Object.hasOwn(TRANSLATION_LANGUAGES.jigsawstack, source))
    throw new Error("Choose a supported JigsawStack source language.");
  if ((liveProvider === "jigsawstack_streaming" && postCallProvider === "meetstream") || (liveProvider === "meetstream_streaming" && postCallProvider === "jigsawstack"))
    throw new Error("MeetStream and JigsawStack transcription cannot be combined. Choose matching live and post-call providers, or AssemblyAI/Deepgram.");
  if (
    typeof input.title !== "string" ||
    !input.title.trim() ||
    input.title.length > 100
  )
    throw new Error("Meeting title must contain 1–100 characters.");
  let meetingLink = "";
  if (mode === "live") {
    meetingLink=meetingInvitation(input.meetingLink);
    if (liveProvider === "jigsawstack_streaming" && new URL(meetingLink).hostname !== "meet.google.com")
      throw new Error("JigsawStack live transcription is supported only on Google Meet.");
  }
  return {
    title: input.title.trim(),
    mode,
    source,
    targets,
    liveProvider,
    translationProvider,
    postCallProvider,
    meetingLink,
    recordVideo: input.recordVideo === true || input.recordVideo === "true",
  };
}
export function postCallConfig(m) {
  return m.postCallProvider === "deepgram"
    ? {
        model: "nova-3",
        language: m.source,
        punctuate: true,
        smart_format: true,
        diarize: true,
      }
    : m.postCallProvider === "assemblyai"
      ? { speech_models: ["universal-2"], language_code: m.source === "jv" ? "jw" : m.source, speaker_labels: true, punctuate: true, format_text: true }
      : { language: m.source, translate: false, ...(m.postCallProvider === "jigsawstack" ? { by_speaker: true } : {}) };
}
export function botPayload(m, origin) {
  const live =
    m.liveProvider === "deepgram_streaming"
      ? {
          transcription_mode: "sentence",
          model: "nova-3",
          language: m.source,
          punctuate: true,
          smart_format: true,
        }
      : m.liveProvider === "assemblyai_streaming"
        ? { transcription_mode: "sentence", speech_model: "universal-streaming-english", sample_rate: 48000, encoding: "pcm_s16le", format_turns: true }
        : m.liveProvider === "jigsawstack_streaming"
          ? { language: m.source, translate: false, by_speaker: true }
          : { transcription_mode: "sentence" };
  return {
    meeting_link: m.meetingLink,
    bot_name: `MeetStream Captions · ${m.id.slice(0, 12)}`,
    video_required: !!m.recordVideo,
    audio_mixed_mp3: true,
    callback_url: `${origin}/webhooks/callback/${m.id}/${m.liveToken}`,
    audio_required: true,
    live_transcription_required: {
      webhook_url: `${origin}/webhooks/live/${m.id}/${m.liveToken}`,
    },
    custom_attributes: { accessibility_session: m.id },
    recording_config: {
      ...(m.recordVideo ? { video_layout: "speaker_view" } : {}),
      retention: { type: "timed", hours: 48 },
      transcript: {
        provider: {
          [m.liveProvider]: live,
          [m.postCallProvider || "meetstream"]: postCallConfig(m),
        },
      },
    },
    automatic_leave: {
      waiting_room_timeout: 300,
      everyone_left_timeout: 60,
      in_call_recording_timeout: 14400,
    },
  };
}
const languageCode = canonicalLanguage;
export function normalizeLive(body, meeting, receivedAt = Date.now()) {
  if (!body || typeof body !== "object" || body.bot_id !== meeting.botId)
    throw new Error("Unknown bot.");
  if (body.is_final === false || body.end_of_turn === false) return null;
  const text = body.utterance || body.new_text || body.transcript;
  if (typeof text !== "string" || !text.trim() || text.length > 10000)
    throw new Error("Caption text is empty or too long.");
  const words = Array.isArray(body.words) ? body.words : [];
  const start = finite(body.start_time) ?? finite(words[0]?.start);
  const end = finite(body.end_time) ?? finite(words.at(-1)?.end);
  const timed = start !== null && end !== null && start >= 0 && end > start;
  return {
    id: hash(
      JSON.stringify([
        meeting.id,
        body.timestamp,
        body.speakerId,
        body.speakerName,
        text,
        body.turn_order,
      ]),
    ),
    meetingId: meeting.id,
    kind: "live",
    text: text.trim(),
    speaker: String(
      body.speakerName ||
        (body.speakerId != null
          ? `Speaker ${body.speakerId}`
          : "Unknown speaker"),
    ).slice(0, 100),
    speakerId: String(body.speakerId ?? body.speakerName ?? "unknown").slice(
      0,
      100,
    ),
    asrSource: languageCode(body.language_code),
    source: meeting.source === "auto" ? languageCode(body.language_code) : meeting.source,
    start: timed ? start : Math.max(0, (receivedAt - meeting.createdAt) / 1000),
    end: timed ? end : Math.max(0, (receivedAt - meeting.createdAt) / 1000) + 3,
    timing: timed ? "provider-relative" : "receipt-estimate",
    receivedAt,
    providerProducedAt: parseTimestamp(body.timestamp),
    simulated: meeting.mode === "demo",
    translations: {},
  };
}
const finite = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);
export function normalizeTranscript(payload, meeting) {
  let list = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.transcript)
      ? payload.transcript
      : payload?.segments;
  if (!Array.isArray(list) && payload && typeof payload === "object") {
    // Participant-keyed processed transcripts use one array per participant.
    list = Object.entries(payload).flatMap(([speaker, xs]) =>
      Array.isArray(xs)
        ? xs.map((x) => ({ ...x, speaker: x.speaker ?? speaker }))
        : [],
    );
  }
  if (!Array.isArray(list) || !list.length)
    throw new Error(
      "Post-call transcript has no supported segments. Live captions are preserved.",
    );
  // The hosted engine also returns participant records with timestamped word chunks.
  list = list.flatMap((s) =>
    s.participant && Array.isArray(s.words) && !s.transcript
      ? s.words.map((w) => ({
          transcript: w.text,
          start_time: w.start_timestamp?.relative,
          end_time: w.end_timestamp?.relative,
          speaker:
            s.participant.name || `Speaker ${s.participant.id ?? "unknown"}`,
          speakerId: s.participant.id,
          language_code: s.language_code,
        }))
      : [s],
  );
  if (!list.length)
    throw new Error(
      "Post-call transcript has no words. Live captions are preserved.",
    );
  return list
    .map((s, i) => {
      if (
        typeof s?.transcript !== "string" ||
        !s.transcript.trim() ||
        s.transcript.length > 10000
      )
        throw new Error(`Invalid post-call segment ${i + 1}.`);
      const start = finite(s.start_time),
        end = finite(s.end_time);
      if (start === null || end === null || start < 0 || end <= start)
        throw new Error(
          `Missing or invalid timestamps in post-call segment ${i + 1}; refusing to invent subtitle timing.`,
        );
      return {
        id: hash(`${meeting.id}:final:${i}:${s.transcript}`),
        meetingId: meeting.id,
        kind: "final",
        text: s.transcript.trim(),
        speaker:
          typeof s.speaker === "number"
            ? `Speaker ${s.speaker}`
            : String(s.speaker || "Unknown speaker").slice(0, 100),
        speakerId: String(s.speakerId ?? s.speaker ?? "unknown"),
        asrSource: languageCode(s.language_code),
        source: meeting.source === "auto" ? languageCode(s.language_code) : meeting.source,
        start,
        end,
        timing: "provider-relative",
        receivedAt: Date.now(),
        simulated: false,
        translations: {},
      };
    })
    .sort((a, b) => a.start - b.start);
}
export function percentile(xs, p) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.max(0, Math.ceil(p * s.length) - 1)]);
}
export function summarize(cues, receipts = [], reviews = []) {
  const groups = new Map();
  for (const c of cues)
    for (const [target, t] of Object.entries(c.translations)) {
      const source = t.detectedSource || c.source || "unknown",
        key = `${source} → ${target}`;
      if (!groups.has(key))
        groups.set(key, {
          pair: key,
          simulated: c.simulated,
          samples: 0,
          failures: 0,
          translation: [],
          pipeline: [],
          display: [],
          scores: [],
        });
      const g = groups.get(key);
      if (c.kind === "final") {
        if (t.status === "ready" && !t.passthrough)
          g.scores.push(
            ...reviews
              .filter((r) => r.cueId === c.id && r.target === target)
              .map((r) => r.score),
          );
        continue;
      }
      if (t.status === "failed") g.failures++;
      if (t.status !== "ready" || t.passthrough) continue;
      g.samples++;
      g.translation.push(t.durationMs);
      g.pipeline.push(t.readyAt - c.receivedAt);
      g.display.push(
        ...receipts
          .filter((r) => r.cueId === c.id && r.target === target)
          .map((r) => r.delayMs),
      );
      g.scores.push(
        ...reviews
          .filter((r) => r.cueId === c.id && r.target === target)
          .map((r) => r.score),
      );
    }
  return [...groups.values()].map((g) => ({
    pair: g.pair,
    simulated: g.simulated,
    samples: g.samples,
    failures: g.failures,
    translationP50: percentile(g.translation, 0.5),
    translationP95: percentile(g.translation, 0.95),
    pipelineP50: percentile(g.pipeline, 0.5),
    pipelineP95: percentile(g.pipeline, 0.95),
    displayP50: percentile(g.display, 0.5),
    displaySamples: g.display.length,
    reviewCount: g.scores.length,
    quality: g.scores.length
      ? +(g.scores.reduce((a, b) => a + b, 0) / g.scores.length).toFixed(2)
      : null,
    speechToCaptionMs: null,
  }));
}
// chrF2: character 1–6 grams, whitespace removed, beta=2. This is reference overlap, not semantic accuracy.
export function chrf(hypothesis, reference) {
  const clean = (s) => [...s.normalize("NFC").toLowerCase().replace(/\s/g, "")];
  const h = clean(hypothesis),
    r = clean(reference);
  let p = 0,
    recall = 0,
    count = 0;
  for (let n = 1; n <= 6; n++) {
    if (h.length < n || r.length < n) continue;
    const grams = (a) => {
      const m = new Map();
      for (let i = 0; i <= a.length - n; i++) {
        const g = a.slice(i, i + n).join("");
        m.set(g, (m.get(g) || 0) + 1);
      }
      return m;
    };
    const hg = grams(h),
      rg = grams(r);
    let overlap = 0;
    for (const [g, v] of hg) overlap += Math.min(v, rg.get(g) || 0);
    p += overlap / (h.length - n + 1);
    recall += overlap / (r.length - n + 1);
    count++;
  }
  if (!count) return h.join("") === r.join("") ? 100 : 0;
  p /= count;
  recall /= count;
  return p + recall === 0
    ? 0
    : +((100 * 5 * p * recall) / (4 * p + recall)).toFixed(2);
}

export function meetingServices(m) {
  const speech={meetstream:'MeetStream',deepgram:'Deepgram',assemblyai:'AssemblyAI',jigsawstack:'JigsawStack'};
  return {speech:m.mode==='demo'?'Sample dialogue':speech[m.liveProvider?.replace('_streaming','')] || 'Unknown',
    translation:m.mode==='demo'?'Handwritten sample':({google:'Google Translate',azure:'Microsoft Translator',jigsawstack:'JigsawStack',deepl:'DeepL'})[m.translationProvider] || 'Unknown',
    postCall:m.mode==='demo'?'Handwritten sample':speech[m.postCallProvider] || 'Unknown',source:m.source==='auto'?'Detect automatically':LANGUAGES[m.source] || m.source,
    canChangeSource:false,canRestartSource:['deepgram_streaming','jigsawstack_streaming'].includes(m.liveProvider) && m.mode==='live' && !m.endedAt && ['live','joining','waiting'].includes(m.status),sourceHelp:m.liveProvider==='meetstream_streaming'?'MeetStream live speech detects language automatically. A fixed source is a text translation and post-call hint. To choose a fixed live recognizer language, start another recording with Deepgram or JigsawStack.':m.liveProvider==='assemblyai_streaming'?'AssemblyAI live through MeetStream supports English only. Start another recording with a different speech provider to recognize another language.':m.source==='auto'?'Your speech provider detects the spoken language automatically. Choose a fixed language by restarting captions.':'To recognize a different spoken language, restart captions in this call. The earlier recording stays saved.'};
}

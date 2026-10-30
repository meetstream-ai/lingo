import {meetingServices} from './core.js';
import {calendarConfigured,calendarMeetingName} from './calendar.js';
import express from "express";
import { ASSEMBLY_LANGUAGES, DEEPGRAM_LANGUAGES, TRANSLATION_LANGUAGES } from "./languages.js";
import { extensionRoutes } from "./extension.js";
import { randomUUID, randomBytes, createHmac } from "node:crypto";
import { resolve, dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { MeetStream } from "@meetstream/sdk";
import { openStore } from "./store.js";
import {
  LANGUAGES,
  hash,
  equal,
  verifyWebhook,
  validateMeeting,
  validatePublicOrigin,
  botPayload,
  postCallConfig,
  normalizeLive,
  normalizeTranscript,
  summarize,
} from "./core.js";
import {
  translate,
  translationConfigured,
  shareArtifact,
  translatedAudio,
} from "./providers.js";
import { meetingSummary, summaryFingerprint, excerptSummary } from "./summaries.js";
import { exportArtifact, exportFilename } from "./exports.js";
import { DEMO } from "./demo.js";
import { openConnections, CONNECTIONS, testConnection } from "./connections.js";

export function createApp({
  env = process.env,
  database = env.DATABASE_PATH || "data/meetings.sqlite",
  meetstream,
  fetchImpl = fetch,
  startWorker = true,
  connectionsPath = database === ":memory:"
    ? null
    : resolve(dirname(database), "connections.json"),
} = {}) {
  env = { ...env, PUBLIC_ORIGIN: validatePublicOrigin(env.PUBLIC_ORIGIN) };
  const connections = openConnections(connectionsPath, env);
  const store = openStore(database),
    app = express(),
    clients = new Map(),
    inflight = new Set(),
    loginAttempts = new Map();
  let sdk =
    meetstream ||
    (env.MEETSTREAM_API_KEY
      ? new MeetStream({
          apiKey: env.MEETSTREAM_API_KEY,
          timeout: 15000,
          maxRetries: 1,
        })
      : null);
  const sessionSecret = env.SESSION_SECRET || randomBytes(32).toString("hex");
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; media-src 'self' blob:",
    });
    next();
  });
  app.use(
    express.json({
      limit: "256kb",
      verify: (req, _res, buf) => {
        req.rawBody = buf;
      },
    }),
  );
  function signed(expiry) {
    return createHmac("sha256", sessionSecret)
      .update(`${expiry}:${hash(env.APP_PASSWORD || "")}`)
      .digest("hex");
  }
  function authorized(req) {
    if (!env.APP_PASSWORD) return true;
    const value = /(?:^|; )access_session=([^;]+)/.exec(
      req.headers.cookie || "",
    )?.[1];
    if (!value) return false;
    const [expires, signature] = value.split(".");
    return (
      /^\d+$/.test(expires) &&
      Number(expires) > Date.now() &&
      Number(expires) < Date.now() + 43_201_000 &&
      equal(signature, signed(expires))
    );
  }
  app.get("/healthz", (_req, res) => res.json({ ok: true }));
  app.get("/api/auth", (req, res) =>
    res.set("Cache-Control", "no-store").json({
      authenticated: authorized(req),
      passwordRequired: !!env.APP_PASSWORD,
    }),
  );
  app.post("/api/login", (req, res) => {
    const ip = req.socket.remoteAddress,
      now = Date.now();
    let attempt = loginAttempts.get(ip);
    if (!attempt || now - attempt.at > 60000) {
      attempt = { at: now, count: 0 };
      loginAttempts.set(ip, attempt);
    }
    if (loginAttempts.size > 10000)
      for (const [key, value] of loginAttempts)
        if (now - value.at > 60000) loginAttempts.delete(key);
    if (attempt.count >= 5)
      return res
        .status(429)
        .json({ error: "Too many attempts. Try again in a minute." });
    if (
      typeof req.body?.password !== "string" ||
      !equal(hash(req.body.password), hash(env.APP_PASSWORD || ""))
    ) {
      attempt.count++;
      return res.status(401).json({ error: "Incorrect workspace password." });
    }
    const expires = String(now + 43_200_000);
    res.setHeader(
      "Set-Cookie",
      `access_session=${expires}.${signed(expires)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${env.NODE_ENV === "production" ? "; Secure" : ""}`,
    );
    res.json({ ok: true });
  });
  app.post("/api/logout", (_req, res) => {
    res.setHeader(
      "Set-Cookie",
      "access_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
    );
    res.json({ ok: true });
  });
  function addLanguage(m, target) {
    if (typeof target !== "string" || !Object.hasOwn(TRANSLATION_LANGUAGES[m.translationProvider], target)) throw new Error("Choose a language supported by this meeting's translation provider.");
    if (m.targets.includes(target)) return;
    if (m.targets.length >= 8) throw new Error("This meeting already has eight translation languages.");
    if (m.mode === "demo" && !["en", "hi", "ta"].includes(target)) throw new Error("Sample translations are available only in English, Hindi and Tamil.");
    if (m.mode === "live" && !translationConfigured(m.translationProvider, env)) throw new Error("Configure this meeting's translation provider in Connections.");
    store.transaction(() => {
      m.targets.push(target);
      store.saveMeeting(m);
      for (const cue of store.cues(m.id)) queueTranslations(cue, m);
    });
    publish(m.id);
  }
  extensionRoutes(app, { store, authorize: authorized, env, addLanguage, fetchImpl, createMeeting, stopMeeting, switchSource, config: extensionConfig });
  app.use("/api", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!authorized(req))
      return res.status(401).json({ error: "Sign in to the workspace." });
    if (req.method !== "GET" && req.headers.origin) {
      const allowed = env.PUBLIC_ORIGIN || `http://${req.headers.host}`;
      if (
        req.headers.origin !== allowed &&
        !(
          env.NODE_ENV !== "production" &&
          req.headers.origin === `http://${req.headers.host}`
        )
      )
        return res
          .status(403)
          .json({ error: "Request origin is not allowed." });
    }
    next();
  });
  function requireMeeting(req, res, next) {
    const m = store.meeting(req.params.id);
    if (!m) return res.status(404).json({ error: "Meeting not found." });
    req.meeting = m;
    next();
  }
  function publicMeeting(m) {
    const { liveToken, ...rest } = m;
    return {...rest,services:meetingServices(m)};
  }
  function ensurePostCallSummaries(m) {
    if (!m?.endedAt || m.postCallStatus !== 'ready') return m;
    const cues=store.cues(m.id), final=cues.filter(c=>c.kind==='final');
    if (!final.length) return m;
    let changed=false;
    for (const target of m.targets) {
      const previous=m.summaries?.[target];
      if (previous?.sourceKind==='final' && previous.fingerprint===summaryFingerprint(cues,target,previous.kind)) continue;
      if (final.some(c=>c.source!==target && c.translations[target]?.status!=='ready')) continue;
      const result=excerptSummary(cues,target);
      m.summaries={...m.summaries,[target]:{...result,automatic:true}};changed=true;
    }
    if(changed)store.saveMeeting(m);
    return m;
  }
  function snapshot(id) {
    const m = ensurePostCallSummaries(store.meeting(id));
    return {
      meeting: publicMeeting(m),
      cues: store.cues(id),
      failures: store.failed(id),
      reviews: store.reviews(id),
      metrics: summarize(store.cues(id), store.receipts(id), store.reviews(id)),
    };
  }
  function publish(id) {
    if (!clients.get(id)?.size) return;
    const data = `data: ${JSON.stringify(snapshot(id))}\n\n`;
    for (const res of clients.get(id)) res.write(data);
  }
  function saveMeeting(m) {
    store.saveMeeting(m);
    publish(m.id);
  }
  function queueTranslations(c, m) {
    for (const target of m.targets)
      if (c.translations[target]?.status !== "ready") {
        c.translations[target] = { status: "pending" };
        store.enqueue(`translate:${c.id}:${target}`, "translate", {
          meetingId: m.id,
          cueId: c.id,
          target,
        });
      }
    store.saveCue(c);
  }
  function addCue(c, m) {
    store.transaction(() => {
      if (store.insertCue(c)) queueTranslations(c, m);
    });
    publish(m.id);
  }
  function extensionConfig() {
    return {languages:LANGUAGES,speechLanguages:{deepgram:DEEPGRAM_LANGUAGES,assemblyai:{en:"English"},jigsawstack:TRANSLATION_LANGUAGES.jigsawstack},translationLanguages:TRANSLATION_LANGUAGES,liveReady:!!(sdk && env.PUBLIC_ORIGIN?.startsWith("https://")),
      providers:Object.fromEntries(Object.keys(TRANSLATION_LANGUAGES).map(p=>[p,translationConfigured(p,env)])),
      translationChecks:Object.fromEntries(Object.keys(TRANSLATION_LANGUAGES).map(p=>[p,connections.check(p)])),
      checks:{deepgram:speechCheck("deepgram"),assemblyai:speechCheck("assemblyai"),jigsawstack:speechCheck("jigsawstack")}};
  }
  app.get("/api/config", (_req, res) =>
    res.json({
      languages: LANGUAGES,
      translationLanguages: TRANSLATION_LANGUAGES,
      speechLanguages: { deepgram: DEEPGRAM_LANGUAGES, assemblyai: ASSEMBLY_LANGUAGES, jigsawstack_asr: TRANSLATION_LANGUAGES.jigsawstack },
      serverTime: Date.now(),
      liveReady: !!(sdk && env.PUBLIC_ORIGIN),
      providers: {
        deepl:translationConfigured("deepl",env),
        google: translationConfigured("google", env),
        azure: translationConfigured("azure", env),
        jigsawstack: translationConfigured("jigsawstack", env),
      },
      integrations: {
        calendar:calendarConfigured(env),discord:!!env.DISCORD_WEBHOOK_URL,
        slack: !!(env.SLACK_BOT_TOKEN && env.SLACK_CHANNEL_ID),
        gmail: !!(env.GMAIL_CLIENT_ID && env.GMAIL_CLIENT_SECRET && env.GMAIL_REFRESH_TOKEN),
        drive: !!(
          env.GOOGLE_DRIVE_REFRESH_TOKEN &&
          env.GOOGLE_CLIENT_ID &&
          env.GOOGLE_CLIENT_SECRET &&
          env.GOOGLE_DRIVE_FOLDER_ID
        ),
      },
      lifecycleUrl: env.PUBLIC_ORIGIN
        ? `${env.PUBLIC_ORIGIN}/webhooks/meetstream`
        : null,
      connections: connections.list(),
      meetstreamCredential: { source: connections.source("MEETSTREAM_API_KEY"),
        fingerprint: env.MEETSTREAM_API_KEY ? hash(env.MEETSTREAM_API_KEY).slice(0, 12) : null },
      connectionsEditable: !!env.APP_PASSWORD,
      deepgram: connections.check("deepgram"),
      managedChecks: { assemblyai: connections.check("assemblyai"), jigsawstack_asr: connections.check("jigsawstack_asr") },
    }),
  );
  const testingConnections = new Set();
  function connectionOwner(req, res, next) {
    if (!env.APP_PASSWORD)
      return res.status(409).json({
        error:
          "Set a workspace password in .env and restart before managing credentials.",
      });
    next();
  }
  app.post("/api/connections/:connection", connectionOwner, (req, res) => {
    const id = req.params.connection;
    if (
      testingConnections.has(id) ||
      (id === "meetstream" && ["deepgram", "assemblyai", "jigsawstack_asr"].some(p => testingConnections.has(p)))
    )
      return res
        .status(409)
        .json({ error: "Wait for the current connection test to finish." });
    try {
      const changed = connections.save(id, req.body);
      if (id === "meetstream" && !meetstream && changed)
        sdk = env.MEETSTREAM_API_KEY
          ? new MeetStream({
              apiKey: env.MEETSTREAM_API_KEY,
              timeout: 15000,
              maxRetries: 1,
            })
          : null;
      res.json({ saved: true });
    } catch (e) {
      res.status(400).json({ error: safeError(e) });
    }
  });
  app.post(
    "/api/connections/:connection/test",
    connectionOwner,
    async (req, res) => {
      const id = req.params.connection;
      if (!Object.hasOwn(CONNECTIONS, id) && !["deepgram", "assemblyai", "jigsawstack_asr"].includes(id))
        return res.status(400).json({ error: "Unsupported connection." });
      if (testingConnections.has(id))
        return res
          .status(409)
          .json({ error: "A connection test is already running." });
      testingConnections.add(id);
      try {
        let check;
        if (["deepgram", "assemblyai", "jigsawstack_asr"].includes(id)) {
          const provider = id === "jigsawstack_asr" ? "jigsawstack" : id;
          const m = store.meeting(req.body?.meetingId),
            source = req.body?.source;
          if (typeof source !== "string" || (id === "assemblyai" ? !Object.hasOwn(ASSEMBLY_LANGUAGES, source) : id === "jigsawstack_asr" ? !Object.hasOwn(TRANSLATION_LANGUAGES.jigsawstack, source) : !Object.hasOwn(DEEPGRAM_LANGUAGES, source)))
            return res.status(400).json({
              error: "Select a supported spoken language for the saved-audio test.",
            });
          if (!sdk || !m?.botId || !m.endedAt)
            return res.status(409).json({
              error: "Choose a completed real meeting with saved audio.",
            });
          const previous = connections.check(id);
          if (previous?.status === "processing")
            return res.status(409).json({
              error:
                "A provider transcript is already processing. Refresh its status.",
            });
          const media = await recording(m, "audio");
          if (media.status !== "ready")
            return res.status(409).json({ error: media.message });
          const data = await sdk.transcripts.transcribeBotAudio(m.botId, {
            provider: {
              [provider]: postCallConfig({
                ...m,
                source,
                postCallProvider: provider,
              }),
            },
          });
          if (!data.transcript_id)
            throw new Error("MeetStream did not return a test transcript ID.");
          check = {
            status: "processing",
            message:
              `MeetStream accepted the ${provider} request. Processing saved audio; this does not verify live caption quality.`,
            at: Date.now(),
            transcriptId: data.transcript_id,
            meetingId: m.id,
            source,
          };
        } else {
          check = {
            status: "passed",
            message: await testConnection(id, { ...env }, sdk, fetchImpl),
            at: Date.now(),
          };
        }
        connections.setCheck(id, check);
        res.json(check);
      } catch (e) {
        const check = {
          status: "failed",
          message: safeError(e),
          at: Date.now(),
          upstreamStatus: Number.isInteger(e.status) ? e.status : null,
          requestId:
            typeof e.requestId === "string"
              ? safeError({ message: e.requestId })
                  .replace(/[^a-zA-Z0-9_-]/g, "")
                  .slice(0, 120)
              : null,
        };
        connections.setCheck(id, check);
        res.status(502).json({ error: check.message });
      } finally {
        testingConnections.delete(id);
      }
    },
  );
  app.post(
    "/api/connections/:managed/refresh",
    connectionOwner,
    async (req, res) => {
      const id = req.params.managed;
      if (!["deepgram", "assemblyai", "jigsawstack_asr"].includes(id)) return res.status(400).json({ error: "Unsupported provider test." });
      if (testingConnections.has(id))
        return res
          .status(409)
          .json({ error: "A provider test request is already running." });
      const check = connections.check(id);
      if (!check || check.status !== "processing")
        return res.json(
          check || {
            status: "unverified",
            message: "No saved-audio test has run.",
          },
        );
      testingConnections.add(id);
      try {
        const data = await sdk.transcripts.get(check.transcriptId);
        const cues = normalizeTranscript(data, {
          id: check.meetingId,
          source: check.source,
        });
        const result = {
          ...check,
          status: "passed",
          at: Date.now(),
          message: `${id} produced ${cues.length} saved-audio transcript segments. Review language and speakers; live caption quality is unverified.`,
        };
        connections.setCheck(id, result);
        res.json(result);
      } catch (e) {
        if (e.status === 202 && !/Skipped|Failed/i.test(e.message || ""))
          return res.json(check);
        const result = {
          ...check,
          status: "failed",
          at: Date.now(),
          message: safeError(e),
        };
        connections.setCheck(id, result);
        res.status(502).json({ error: result.message });
      } finally {
        testingConnections.delete(id);
      }
    },
  );
  app.get("/api/meetings", (req, res) => {
    if (req.query.page === undefined)
      return res.json(store.meetings().map(publicMeeting));
    const page = Number(req.query.page),
      query = req.query.q || "",
      status = req.query.status || "all";
    if (
      !Number.isSafeInteger(page) ||
      page < 1 ||
      typeof query !== "string" ||
      query.length > 100 ||
      !["all", "active", "finished", "attention"].includes(status)
    )
      return res.status(400).json({
        error:
          "Use a positive page, a search of up to 100 characters and a supported status filter.",
      });
    const result = store.meetingPage(page, query, 10, status);
    res.json({ ...result, items: result.items.map(publicMeeting) });
  });
  function speechCheck(provider) {
    return connections.check(provider === "jigsawstack" ? "jigsawstack_asr" : provider);
  }
  function assertSpeechAvailable(input) {
    for (const provider of new Set([input.liveProvider.replace("_streaming", ""), input.postCallProvider])) {
      const check = speechCheck(provider);
      if (check?.status === "failed") throw Error(`${provider === "jigsawstack" ? "JigsawStack" : provider} speech failed its last check: ${check.message} Open Connections, repair the key in MeetStream, and pass a saved-audio test before joining another call.`);
    }
  }
  async function preflight(input) {
    if (input.mode !== "live") return;
    if (!sdk || !env.PUBLIC_ORIGIN?.startsWith("https://")) throw Error("Configure MeetStream and an HTTPS callback URL in Connections before joining a meeting.");
    assertSpeechAvailable(input);
    if (!translationConfigured(input.translationProvider, env)) throw Error("Choose a configured translation provider in Connections before joining a meeting.");
    try {
      const target = input.translationProvider==='deepl'?input.targets[0]:input.targets.find(t=>t!=='en') || 'hi', source=input.translationProvider==='deepl' && target==='en'?'fr':'en';
      await translate(source==='fr'?"Bonjour":"Hello", source, target, input.translationProvider, env, fetchImpl);
      connections.setCheck(input.translationProvider,{status:"passed",at:Date.now(),message:"Text translation preflight succeeded."});
    } catch (e) {
      connections.setCheck(input.translationProvider,{status:"failed",at:Date.now(),upstreamStatus:e.status || null,message:safeError(e)});
      throw Error(`${input.translationProvider} text translation check failed: ${safeError(e)} Fix and test this connection before joining. No bot was created.`);
    }
  }
  app.post("/api/meetings/preflight", async (req,res) => {
    try { const input=validateMeeting(req.body); await preflight(input); res.json({ready:true,message:"Text translation checked. Speech access uses the last provider check; live recognition is confirmed only when captions arrive."}); }
    catch(e){res.status(409).json({error:safeError(e)});}
  });
  async function createMeeting(body, continuation = null) {
    if (continuation && store.meeting(continuation.id)) return publicMeeting(store.meeting(continuation.id));
    let input;
    try {
      input = validateMeeting(body);
    } catch (e) {
      throw Object.assign(e, { status: 400 });
    }
    try { await preflight(input); }
    catch(e) { throw Object.assign(Error(safeError(e)), { status: 409 }); }
    if (
      input.mode === "demo" &&
      input.targets.some((x) => !["en", "hi", "ta"].includes(x))
    )
      throw Object.assign(Error("The sample supports English, Hindi and Tamil. Live meetings support all listed targets."), {status:400});
    if (continuation && store.meeting(continuation.previousMeetingId)?.languageSwitch?.cancelled) return null;
    const id = continuation?.id || randomUUID(),
      m = {
        ...(continuation ? {previousMeetingId:continuation.previousMeetingId} : {}),
        ...input,
        title:input.mode==='live' && body.autoTitle===true && input.title==='Meeting'?`${new URL(input.meetingLink).hostname==='meet.google.com'?'Google Meet':new URL(input.meetingLink).hostname.includes('zoom.us')?'Zoom':'Teams'} · ${new URL(input.meetingLink).pathname.split('/').filter(Boolean).at(-1).slice(0,50)}`:input.title,
        autoTitle:body.autoTitle===true || ["Meeting captions","Multilingual team sync","Meeting"].includes(input.title),
        titleSource:body.titleSource==='browser'?'browser':'manual',
        id,
        createdAt: Date.now(),
        liveToken: randomBytes(24).toString("hex"),
        botId: null,
        transcriptId: null,
        status: input.mode === "demo" ? "live" : "connecting",
        postCallStatus: "pending",
        lastError: null,
      };
    store.transaction(() => {
      store.saveMeeting(m);
      if (continuation) {
        const previous=store.meeting(continuation.previousMeetingId);
        previous.nextMeetingId=id;
        previous.languageSwitch.status='ready';
        store.saveMeeting(previous);
      }
      if(m.mode==='live' && m.autoTitle && calendarConfigured(env))store.enqueue(`name:${id}`,'name',{meetingId:id});
      store.enqueue(`start:${id}`, input.mode === "demo" ? "demo" : "create", {
        meetingId: id,
        index: 0,
      });
    });
    if (continuation) publish(continuation.previousMeetingId);
    return publicMeeting(m);
  }
  app.post("/api/meetings", async (req,res) => {
    try {res.status(201).json(await createMeeting(req.body));}
    catch(e){res.status(e.status || 409).json({error:safeError(e)});}
  });
  app.post('/api/meetings/:id/name/refresh',requireMeeting,async(req,res)=>{
    try {const match=await syncName(req.meeting);res.json({matched:!!match,meeting:publicMeeting(store.meeting(req.meeting.id))});}
    catch(e){res.status(409).json({error:safeError(e)});}
  });
  async function switchSource(m, source, confirmed) {
    if (source === m.source) return publicMeeting(m);
    if (confirmed !== true) throw Object.assign(Error('Confirm the recording restart to change spoken language. Earlier captions and recordings stay saved; the bot must rejoin.'),{status:409});
    if (m.languageSwitch && m.languageSwitch.source === source && !m.languageSwitch.cancelled) return publicMeeting(m);
    if (m.mode !== 'live' || m.endedAt || !['live','joining','waiting'].includes(m.status)) throw Error('Spoken language can change only during an active live recording.');
    if (m.languageSwitch) throw Error('A spoken-language switch is already in progress.');
    if (!['deepgram_streaming','jigsawstack_streaming'].includes(m.liveProvider)) throw Error('This live provider does not support another fixed recognizer language. MeetStream detects automatically; AssemblyAI live supports English only. Start another recording with Deepgram or JigsawStack.');
    const input=validateMeeting({...m,source});
    await preflight(input); // No stop is sent until the new configuration passes.
    m=store.meeting(m.id);
    if (m.languageSwitch) {
      if (m.languageSwitch.source === source) return publicMeeting(m);
      throw Error('A spoken-language switch is already in progress.');
    }
    if (m.endedAt || !['live','joining','waiting'].includes(m.status)) throw Error('This recording has ended or is stopping.');
    m.languageSwitch={source,childId:randomUUID(),status:'stopping',requestedAt:Date.now()};
    m.status='stopping';
    store.transaction(()=>{store.saveMeeting(m);store.enqueue(`switch:${m.id}`,'switch-source',{meetingId:m.id});});
    publish(m.id);
    return publicMeeting(m);
  }
  app.post('/api/meetings/:id/source',requireMeeting,async(req,res)=>{
    try { res.status(202).json(await switchSource(req.meeting,req.body?.source,req.body?.confirmed)); }
    catch(e){res.status(e.status || 409).json({error:safeError(e)});}
  });
  async function syncName(m) {
    if(m.mode!=='live')throw Error('Samples do not have calendar meeting names.');
    if(m.autoTitle===false || (!m.autoTitle && !['Meeting captions','Multilingual team sync','Meeting'].includes(m.title)))throw Error('This meeting has a custom name. Edit details to change it.');
    const match=await calendarMeetingName(m,env,fetchImpl),current=store.meeting(m.id);
    if(match && current.autoTitle!==false){current.title=match.title;current.nameError=null;current.titleSource='calendar';current.calendarEventId=match.eventId;current.autoTitle=true;current.metadataVersion=(current.metadataVersion || 0)+1;saveMeeting(current);}
    return match;
  }
  app.post("/api/meetings/:id/language", requireMeeting, (req, res) => {
    try { addLanguage(req.meeting, req.body?.target); res.json(snapshot(req.meeting.id)); }
    catch (e) { res.status(409).json({ error: e.message }); }
  });
  app.get("/api/meetings/:id", requireMeeting, (req, res) =>
    res.json(snapshot(req.meeting.id)),
  );
  app.patch("/api/meetings/:id", requireMeeting, (req, res) => {
    const m = req.meeting,
      b = req.body;
    if (
      !b ||
      typeof b !== "object" ||
      Array.isArray(b) ||
      Object.keys(b).some(
        (k) => !["title", "notes", "actions", "version"].includes(k),
      )
    )
      return res.status(400).json({ error: "Invalid meeting details." });
    if (b.version !== (m.metadataVersion || 0))
      return res.status(409).json({
        error:
          "Meeting details changed in another tab. Reopen the editor before saving.",
      });
    if (
      typeof b.title !== "string" ||
      !b.title.trim() ||
      b.title.length > 100 ||
      typeof b.notes !== "string" ||
      b.notes.length > 20000 ||
      !Array.isArray(b.actions) ||
      b.actions.length > 50
    )
      return res.status(400).json({
        error:
          "Use a title up to 100 characters, notes up to 20,000 characters and at most 50 action items.",
      });
    if (
      b.actions.some(
        (a) =>
          !a ||
          typeof a !== "object" ||
          Object.keys(a).some(
            (k) => !["id", "text", "owner", "done"].includes(k),
          ) ||
          typeof a.id !== "string" ||
          !/^[a-zA-Z0-9-]{1,60}$/.test(a.id) ||
          typeof a.text !== "string" ||
          !a.text.trim() ||
          a.text.length > 500 ||
          typeof a.owner !== "string" ||
          a.owner.length > 100 ||
          typeof a.done !== "boolean",
      ) ||
      new Set(b.actions.map((a) => a.id)).size !== b.actions.length
    )
      return res.status(400).json({
        error:
          "Each action needs a unique ID, description up to 500 characters and owner up to 100 characters.",
      });
    saveMeeting({
      ...m,
      title: b.title.trim(),autoTitle:false,titleSource:"manual",
      notes: b.notes,
      actions: b.actions,
      metadataVersion: (m.metadataVersion || 0) + 1,
    });
    res.json(snapshot(m.id));
  });
  app.get("/api/meetings/:id/notes", requireMeeting, (req, res) => {
    const m = req.meeting;
    res
      .type("text/plain; charset=utf-8")
      .attachment(exportFilename(m,"notes","txt"))
      .send(
        `${m.title}\n\nMeeting notes\n${m.notes || "No notes yet."}\n\nAction items\n${(m.actions || []).map((a) => `${a.done ? "[x]" : "[ ]"} ${a.text}${a.owner ? " — " + a.owner : ""}`).join("\n") || "No action items yet."}\n`,
      );
  });
  app.get("/api/meetings/:id/archive", requireMeeting, (req, res) => {
    res
      .type("json")
      .attachment(exportFilename(req.meeting,"archive","json"))
      .send(
        JSON.stringify(
          {
            schemaVersion: 1,
            exportedAt: new Date().toISOString(),
            ...snapshot(req.meeting.id),
            receipts: store.receipts(req.meeting.id),
          },
          null,
          2,
        ),
      );
  });
  async function recording(m, kind) {
    if (m.mode !== "live")
      return {
        status: "unavailable",
        message: "Samples contain no recording.",
      };
    if (!m.botId && m.status === "failed")
      return {
        status: "unavailable",
        message:
          "The bot was not created, so this meeting has no recording. Fix the provider configuration and retry failed work.",
      };
    if (!m.endedAt)
      return {
        status: "recording",
        message:
          "Audio is captured while the bot is in the call. Playback is available after processing.",
      };
    if (!sdk || !m.botId)
      return {
        status: "unavailable",
        message: "No recording bot is available.",
      };
    if (kind === "video" && !m.recordVideo)
      return {
        status: "unavailable",
        message: "Video was not enabled for this meeting.",
      };
    try {
      const data = await sdk.bots[kind](m.botId);
      const url =
        kind === "audio"
          ? data.audio_mp3_url || data.audio_url
          : data.video_url;
      if (!url) {
        const status = String(data[`${kind}_status`] || "").toLowerCase();
        if (/no_audio|failed|skipped|expired|deleted/.test(status))
          return {
            status: "unavailable",
            message:
              kind === "audio"
                ? "MeetStream has no usable audio for this call. Live captions can still be saved."
                : "MeetStream has no video for this call.",
          };
        return {
          status: "processing",
          message: "MeetStream is still processing the recording.",
        };
      }
      const u = new URL(url);
      // Only provider storage links can be fetched; the client never supplies an upstream URL.
      if (
        u.protocol !== "https:" ||
        u.username ||
        u.password ||
        (u.port && u.port !== "443") ||
        !["amazonaws.com", "cloudfront.net", "meetstream.ai"].some((host) =>
          u.hostname.endsWith(`.${host}`),
        )
      )
        throw new Error("The recording storage host is unsupported.");
      return {
        status: "ready",
        url: u.href,
        type:
          kind === "video"
            ? "video/mp4"
            : data.audio_mp3_url
              ? "audio/mpeg"
              : "audio/wav",
      };
    } catch (e) {
      if (e.name === "NotReadyError")
        return {
          status: "processing",
          message: "MeetStream is still processing the recording.",
        };
      if ([404, 410].includes(e.status))
        return {
          status: "unavailable",
          message: `MeetStream has no ${kind} available for this call. It may not have been captured or its retention has expired.`,
        };
      throw e;
    }
  }
  app.get("/api/meetings/:id/recording", requireMeeting, async (req, res) => {
    try {
      const audio = await recording(req.meeting, "audio"),
        video = req.meeting.recordVideo
          ? await recording(req.meeting, "video")
          : { status: "unavailable", message: "Video was not enabled." };
      const { url: audioUrl, ...a } = audio,
        { url: videoUrl, ...v } = video;
      res.json({ audio: a, video: v });
    } catch (e) {
      res.status(502).json({ error: safeError(e) });
    }
  });
  app.get(
    "/api/meetings/:id/recording/:kind",
    requireMeeting,
    async (req, res) => {
      if (!["audio", "video"].includes(req.params.kind))
        return res.status(400).json({ error: "Choose audio or video." });
      const controller = new AbortController();
      res.on("close", () => controller.abort());
      try {
        const media = await recording(req.meeting, req.params.kind);
        if (media.status !== "ready")
          return res
            .status(media.status === "unavailable" ? 404 : 409)
            .json({ error: media.message });
        if (req.headers.range && !/^bytes=\d*-\d*$/.test(req.headers.range))
          return res.status(416).end();
        const upstream = await fetchImpl(media.url, {
          redirect: "error",
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(120000),
          ]),
          headers: req.headers.range ? { Range: req.headers.range } : {},
        });
        if (![200, 206, 416].includes(upstream.status))
          throw new Error(
            "The recording download failed. Refresh and try again.",
          );
        res.status(upstream.status).type(media.type);
        for (const name of ["content-length", "content-range", "accept-ranges"])
          if (upstream.headers.has(name))
            res.set(name, upstream.headers.get(name));
        if (req.query.download === "true")
          res.attachment(
            exportFilename(req.meeting,kind,media.type === "video/mp4" ? "mp4" : media.type === "audio/mpeg" ? "mp3" : "wav"),
          );
        if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), res);
        else res.end();
      } catch (e) {
        if (controller.signal.aborted) return;
        if (res.headersSent) res.destroy();
        else res.status(502).json({ error: safeError(e) });
      }
    },
  );
  app.post(
    "/api/meetings/:id/retranscribe",
    requireMeeting,
    async (req, res) => {
      const m = req.meeting;
      if (
        m.mode !== "live" ||
        !m.endedAt ||
        !m.botId ||
        m.postCallStatus === "ready"
      )
        return res.status(409).json({
          error:
            "Re-transcription is available for an ended call without a completed transcript.",
        });
      try {
        const provider=req.body?.provider || m.postCallProvider, source=req.body?.source || m.source;
        if (!["meetstream","deepgram","assemblyai","jigsawstack"].includes(provider) || (source !== "auto" && !Object.hasOwn(LANGUAGES,source))) throw Error("Choose a valid recovery provider and source language.");
        if (provider === "deepgram" && !Object.hasOwn(DEEPGRAM_LANGUAGES,source)) throw Error("Choose the spoken language for Deepgram recovery.");
        if (provider === "assemblyai" && !Object.hasOwn(ASSEMBLY_LANGUAGES,source)) throw Error("Choose a supported fixed source for AssemblyAI recovery.");
        const check=speechCheck(provider); if(check?.status === "failed") throw Error(`This speech provider failed its last check: ${check.message} Choose another provider or repair and test it in Connections.`);
        const queued=store.db.prepare("SELECT id FROM jobs WHERE kind='retranscribe' AND status IN ('queued','running') AND json_extract(payload,'$.meetingId')=?").get(m.id);
        if(queued)return res.status(202).json({queued:true});
        if(m.recoveryStartedAt && m.postCallStatus === "pending") return res.status(409).json({error:"Transcript recovery is still processing. Wait for its result before changing providers."});
        const media = await recording(m, "audio");
        if (media.status !== "ready") return res.status(409).json({ error: media.message });
        if(store.db.prepare("SELECT id FROM jobs WHERE kind='retranscribe' AND status IN ('queued','running') AND json_extract(payload,'$.meetingId')=?").get(m.id))return res.status(202).json({queued:true});
        Object.assign(m,store.meeting(m.id));
        if(m.postCallStatus === "ready")return res.status(409).json({error:"This meeting already has a completed transcript."});
        m.transcriptHistory=[...(m.transcriptHistory || []),{transcriptId:m.transcriptId,provider:m.postCallProvider,error:m.lastError,at:Date.now()}];
        m.postCallProvider=provider; m.source=source; store.saveMeeting(m);
        const id = `retranscribe:${m.id}:${randomUUID()}`;
        store.enqueue(id, "retranscribe", { meetingId: m.id });
        store.requeueFailed(id);
        res.status(202).json({ queued: true });
      } catch (e) {
        res.status(502).json({ error: safeError(e) });
      }
    },
  );
  app.post("/api/meetings/:id/speech", requireMeeting, async(req,res)=>{
    const m=req.meeting,target=req.body?.target;
    if(!m.targets.includes(target)) return res.status(400).json({error:"Choose a translation language from this meeting."});
    let text;
    if(req.body?.summary === true) text=m.summaries?.[target]?.points.map(p=>p.text).join(". ");
    else { const cue=store.cue(req.body?.cueId);if(cue?.meetingId===m.id && cue.translations[target]?.status==='ready')text=cue.translations[target].text; }
    if(!text)return res.status(409).json({error:"This translation is not ready to listen to."});
    try {res.json(await translatedAudio(text,target,env,fetchImpl));}
    catch(e){res.status(502).json({error:[401,403].includes(e.status) ? "Google Cloud speech rejected this key. Allow Text-to-Speech in this key’s API restrictions, enable that API and billing, or configure a speech key in Connections. Device voices may still be available." : safeError(e)});}
  });
  const summarizing = new Set();
  app.post("/api/meetings/:id/summary", requireMeeting, async (req,res) => {
    const m=req.meeting, target=req.body?.target, kind=req.body?.kind || "excerpts";
    if (!m.targets.includes(target) || !["ai","excerpts"].includes(kind)) return res.status(400).json({error:"Choose a meeting language and a supported summary type."});
    if (summarizing.has(m.id)) return res.status(409).json({error:"A summary is already being generated for this meeting."});
    summarizing.add(m.id);
    try {
      const cues=store.cues(m.id), previous=m.summaries?.[target];
      if (previous?.fingerprint === summaryFingerprint(cues,target,kind)) return res.json(previous);
      const result=await meetingSummary(cues,target,kind,m,env,fetchImpl);
      if (result.fingerprint !== summaryFingerprint(store.cues(m.id),target,kind)) return res.status(409).json({error:"The transcript changed while summarizing. Generate again to include the newest turns."});
      const current=store.meeting(m.id); current.summaries={...current.summaries,[target]:result}; saveMeeting(current); res.json(result);
    } catch(e){res.status(502).json({error:safeError(e)});} finally {summarizing.delete(m.id);}
  });
  app.get("/api/meetings/:id/summary.txt",requireMeeting,(req,res)=>{
    const m=req.meeting,s=m.summaries?.[req.query.target];
    if(!s)return res.status(404).json({error:"Generate a summary in this language first."});
    res.type("text/plain").attachment(exportFilename(m,`summary-${s.target}`,"txt")).send(`${m.title}\n${s.kind === "ai" ? "AI summary — review against the transcript" : "Summary — selected transcript excerpts"}\n\n${s.points.map(p=>`• ${p.text}${p.speaker ? ` (${p.speaker})` : ""}`).join("\n")}`);
  });
  app.get("/api/meetings/:id/measurements", requireMeeting, (req, res) => {
    const id = req.meeting.id;
    res.json({
      filename:exportFilename(req.meeting,"measurements","json"),
      recordedAt: new Date().toISOString(),
      meeting: publicMeeting(req.meeting),
      speechToCaptionMs: null,
      methodology: {
        translation:
          "Server provider request duration, including network time.",
        processing:
          "Webhook receipt to translation ready; excludes speech recognition.",
        browser:
          "Client-reported approximately clock-adjusted receipt; excludes speech recognition.",
        quality:
          "Human 1–5 reviews; text-provider chrF2 benchmark is separate.",
      },
      pairs: summarize(store.cues(id), store.receipts(id), store.reviews(id)),
      reviews: store.reviews(id),
    });
  });
  app.get("/api/meetings/:id/events", requireMeeting, (req, res) => {
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    const id = req.meeting.id;
    if (!clients.has(id)) clients.set(id, new Set());
    clients.get(id).add(res);
    res.write(`data: ${JSON.stringify(snapshot(id))}\n\n`);
    const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 20000);
    const expiry = setTimeout(() => res.end(), 3600000);
    req.on("close", () => {
      clearInterval(heartbeat);
      clearTimeout(expiry);
      clients.get(id)?.delete(res);
      if (!clients.get(id)?.size) clients.delete(id);
    });
  });
  function stopMeeting(m) {
    if (m.languageSwitch && !m.nextMeetingId) {
      m.languageSwitch.cancelled=true;
      store.saveMeeting(m);
      if (!m.endedAt) store.enqueue(`stop:${m.id}`,"stop",{meetingId:m.id});
    }
    if (!["completed", "failed", "stopped", "stopping"].includes(m.status)) {
      m.status="stopping";
      store.transaction(()=>{store.saveMeeting(m);store.enqueue(`stop:${m.id}`,"stop",{meetingId:m.id});});
      publish(m.id);
    }
    return publicMeeting(m);
  }
  app.post("/api/meetings/:id/stop",requireMeeting,(req,res)=>res.status(["completed","failed","stopped"].includes(req.meeting.status)?200:202).json(stopMeeting(req.meeting)));
  app.post("/api/meetings/:id/retry", requireMeeting, (req, res) => {
    const m = req.meeting;
    store.retryFailed(m.id);
    m.lastError = null;
    if (m.status === "failed" && !m.botId) {
      m.status = "connecting";
      m.postCallStatus = "pending";
    }
    if (m.postCallStatus === "failed") {
      if (m.endedAt) {
        m.postCallStatus = "pending";
        queueFinal(m, true);
      }
    }
    saveMeeting(m);
    res.json({ ok: true });
  });
  app.post("/api/meetings/:id/receipts", requireMeeting, (req, res) => {
    const r = req.body,
      c = typeof r?.cueId === "string" ? store.cue(r.cueId) : null;
    if (
      !c ||
      c.meetingId !== req.meeting.id ||
      c.kind !== "live" ||
      c.translations[r.target]?.status !== "ready" ||
      typeof r.clientId !== "string" ||
      !/^[\w-]{1,64}$/.test(r.clientId) ||
      !Number.isFinite(r.delayMs) ||
      r.delayMs < 0 ||
      r.delayMs > 60000
    )
      return res
        .status(400)
        .json({ error: "Invalid caption receipt measurement." });
    store.receipt({
      cueId: c.id,
      target: r.target,
      clientId: r.clientId,
      delayMs: Math.round(r.delayMs),
    });
    publish(req.meeting.id);
    res.json({ ok: true });
  });
  app.post("/api/meetings/:id/reviews", requireMeeting, (req, res) => {
    const r = req.body,
      c = typeof r?.cueId === "string" ? store.cue(r.cueId) : null;
    if (
      !c ||
      c.meetingId !== req.meeting.id ||
      c.translations[r.target]?.status !== "ready" ||
      !Number.isInteger(r.score) ||
      r.score < 1 ||
      r.score > 5 ||
      typeof r.notes !== "string" ||
      r.notes.length > 1000
    )
      return res.status(400).json({
        error:
          "Select a ready caption and rate it from 1 to 5 with a note under 1000 characters.",
      });
    store.review({
      cueId: c.id,
      target: r.target,
      score: r.score,
      notes: r.notes,
      reviewedAt: Date.now(),
    });
    publish(req.meeting.id);
    res.json({ ok: true });
  });
  app.get("/api/meetings/:id/export", requireMeeting, (req, res) => {
    try {
      const artifact = exportArtifact(req.meeting, store.cues(req.meeting.id), {
        format: req.query.format,
        target: req.query.target,
        kind: req.query.kind,
        bilingual: req.query.bilingual === "true",
      });
      res
        .type(artifact.type)
        .attachment(artifact.filename)
        .set('X-Export-Filename',encodeURIComponent(artifact.filename))
        .set(
          "Content-Security-Policy",
          "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
        )
        .set('Content-Disposition',req.query.inline==='true' && req.query.format==='html' ? res.get('Content-Disposition').replace(/^attachment/,'inline') : res.get('Content-Disposition'))
        .send(artifact.content);
    } catch (e) {
      res.status(409).json({ error: e.message });
    }
  });
  app.post("/api/meetings/:id/share", requireMeeting, async (req, res) => {
    const m = req.meeting,
      b = req.body;
    if (
      !["slack", "drive", "gmail", "discord"].includes(b?.destination) ||
      !["html", "md", "vtt", "srt", "json", "txt"].includes(b?.format)
    )
      return res
        .status(400)
        .json({ error: "Choose a supported destination and format." });
    // Keep outbound sharing explicit. A click shares exactly one fully translated artifact.
    try {
      const artifact = exportArtifact(m, store.cues(m.id), b);
      const result = await shareArtifact(
        b.destination,
        artifact,
        env,
        fetchImpl,
      );
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(409).json({ error: safeError(e) });
    }
  });
  app.post("/webhooks/live/:id/:token", requireMeeting, (req, res) => {
    const m = req.meeting,
      b = req.body;
    if (m.mode !== "live" || !equal(req.params.token, m.liveToken))
      return res.status(403).json({ error: "Invalid live webhook token." });
    if (!b || typeof b.bot_id !== "string" || (m.botId && b.bot_id !== m.botId))
      return res.status(403).json({ error: "Unknown bot." });
    if (b.is_final === false || b.end_of_turn === false)
      return res.status(202).json({ accepted: true });
    if (
      typeof (b.utterance || b.transcript || b.new_text) !== "string" ||
      (b.utterance || b.transcript || b.new_text).length > 10000
    )
      return res.status(400).json({ error: "Invalid caption payload." });
    const receivedAt = Date.now(),
      id = `inbox:${m.id}:${hash(req.rawBody)}`;
    store.enqueue(id, "live", { meetingId: m.id, body: b, receivedAt });
    res.status(202).json({ accepted: true });
  });
  app.post("/webhooks/meetstream", (req, res) => {
    if (!verifyWebhook(env.MEETSTREAM_WEBHOOK_SECRET, req.rawBody, req.headers))
      return res
        .status(401)
        .json({ error: "Invalid webhook signature or timestamp." });
    const b = req.body,
      m = store
        .meetings()
        .find(
          (m) =>
            m.mode === "live" &&
            (m.botId === b.bot_id ||
              (!m.botId &&
                m.id === b.custom_attributes?.accessibility_session)),
        );
    if (!m) return res.status(404).json({ error: "Unknown bot." });
    store.enqueue(`lifecycle:${hash(req.rawBody)}`, "lifecycle", {
      meetingId: m.id,
      body: b,
    });
    res.status(202).json({ accepted: true });
  });
  app.post("/webhooks/callback/:id/:token", requireMeeting, (req, res) => {
    const m = req.meeting,
      b = req.body;
    if (
      m.mode !== "live" ||
      !equal(req.params.token, m.liveToken) ||
      typeof b?.bot_id !== "string" ||
      (m.botId && b.bot_id !== m.botId)
    )
      return res.status(403).json({ error: "Invalid callback token or bot." });
    store.enqueue(`callback:${m.id}:${hash(req.rawBody)}`, "lifecycle", {
      meetingId: m.id,
      body: b,
    });
    res.status(202).json({ accepted: true });
  });
  const routeViews={sessions:'meetings',settings:'connections',measurements:'health',captions:'captions'};
  function legacyWorkspace(req,res) {
    const params=new URLSearchParams(req.url.split('?')[1] || ''),view=params.get('view') || 'captions',id=params.get('meeting'),panel=params.get('panel');
    let path='/workspace/'+(routeViews[view] || 'captions');
    if(view==='captions' && id){path=`/workspace/meetings/${encodeURIComponent(id)}`;if(['captions','transcript','recording','notes','summary'].includes(panel))path+='/'+panel;params.delete('meeting');params.delete('panel');}
    params.delete('view');res.redirect(302,path+(params.size?'?'+params:''));
  }
  app.get('/',(req,res)=>{
    if(['view','meeting'].some(key=>Object.hasOwn(req.query,key)))return legacyWorkspace(req,res);
    res.sendFile(resolve('public/home.html'));
  });
  app.get(['/workspace','/index.html'],legacyWorkspace);
  app.get('/home.html',(_req,res)=>res.redirect(302,'/'));
  app.get(['/workspace/captions','/workspace/connections','/workspace/health','/workspace/meetings','/workspace/meetings/:meetingId','/workspace/meetings/:meetingId/:panel'],(req,res,next)=>{
    if(req.params.panel && !['captions','transcript','recording','notes','summary'].includes(req.params.panel))return next();
    res.sendFile(resolve('public/index.html'));
  });
  app.use(express.static(resolve('public'), {etag:true,maxAge:0}));
  app.use((req,res)=>res.status(404).type('html').sendFile(resolve('public/404.html')));
  app.use((err, _req, res, _next) =>
    res.status(err.status === 413 ? 413 : 400).json({
      error: err.status === 413 ? "Request is too large." : "Invalid request.",
    }),
  );
  function safeError(e) {
    let message = String(e.message || "Operation failed.");
    for (const [key, value] of Object.entries(env))
      if (/KEY|TOKEN|SECRET|PASSWORD/.test(key) && value && (value.length > 5 || (key === "APP_PASSWORD" && value.length > 0)))
        message = message.split(value).join("[redacted]");
    message = message.replace(/\b(Bearer|Token)\s+[A-Za-z0-9._-]+/gi, "$1 [redacted]");
    return message.slice(0, 400);
  }
  async function handle(job) {
    let m = store.meeting(job.payload.meetingId);
    if (!m) return;
    const p = job.payload;
    if (job.kind === 'switch-source') {
      const change=m.languageSwitch;
      if (!change || change.cancelled || m.nextMeetingId) return;
      if (!m.botId) throw Error('No active bot to restart. Start a new recording instead.');
      // remove is idempotent; a restart may repeat it. Its acknowledgement alone
      // does not prove the bot stopped. Poll the actual lifecycle before rejoining.
      await sdk.bots.remove(m.botId);
      const result=await sdk.bots.status(m.botId);
      if (!['Stopped','Done','Completed'].includes(result.status || result.bot_status))
        throw Object.assign(Error('Waiting for the previous bot to leave before changing spoken language.'),{pending:true});
      m=store.meeting(m.id);
      if (m.languageSwitch.cancelled) return;
      m.endedAt ||= Date.now();m.status='stopped';
      m.languageSwitch.status='starting';saveMeeting(m);queueFinal(m);
      await createMeeting({...m,source:change.source},{id:change.childId,previousMeetingId:m.id});
    } else if(job.kind==='name'){try{await syncName(m);}catch(e){const current=store.meeting(m.id);current.nameError=safeError(e);saveMeeting(current);}
    } else if (job.kind === "create") {
      const b = await sdk.bots.create(
        botPayload(m, env.PUBLIC_ORIGIN.replace(/\/$/, "")),
        { idempotencyKey: m.id },
      );
      if (!b.bot_id) throw new Error("MeetStream did not return a bot_id.");
      m = store.meeting(m.id);
      m.botId = b.bot_id;
      m.transcriptId ||= b.transcript_id || null;
      if (m.status === "connecting") m.status = "joining";
      saveMeeting(m);
      store.enqueue(
        `status:${m.id}`,
        "status",
        { meetingId: m.id },
        Date.now() + 5000,
      );
    } else if (job.kind === "live") {
      if (!m.botId)
        throw Object.assign(new Error("Waiting for bot creation."), {
          pending: true,
        });
      const c = normalizeLive(p.body, m, p.receivedAt);
      if (!c) return;
      addCue(c, m);
      m = store.meeting(m.id);
      if (m.liveError) {
        if (m.lastError === m.liveError) m.lastError = null;
        m.liveError = null;
        const provider = m.liveProvider?.replace("_streaming", ""), id = provider === "jigsawstack" ? "jigsawstack_asr" : provider;
        const check = connections.check(id);
        if (check?.kind === "live_transcription" && check.meetingId === m.id)
          connections.setCheck(id, { status: "passed", kind: "live_transcription", at: Date.now(), meetingId: m.id,
            message: "Live captions resumed. This verifies live access, not post-call quality." });
        saveMeeting(m);
      }
      if (["joining", "connecting", "waiting"].includes(m.status)) {
        m.status = "live";
        saveMeeting(m);
      }
    } else if (job.kind === "translate") {
      const c = store.cue(p.cueId);
      if (!c) return;
      let result;
      if (m.mode === "demo") {
        const sample = DEMO[c.demoIndex];
        result = {
          text: sample[p.target],
          detectedSource: sample.source,
          durationMs: 0,
          passthrough: sample.source === p.target,
        };
      } else
        result = await translate(
          c.text,
          m.source === "auto" ? null : m.source,
          p.target,
          m.translationProvider,
          env,
          fetchImpl,
        );
      // Reload after await so parallel language jobs do not overwrite one another.
      const current = store.cue(c.id);
      current.translations[p.target] = {
        ...result,
        status: "ready",
        readyAt: Date.now(),
      };
      if (m.source === "auto" && result.detectedSource)
        current.source = result.detectedSource;
      store.saveCue(current);
      ensurePostCallSummaries(store.meeting(m.id));
      publish(m.id);
    } else if (job.kind === "demo") {
      if (m.status !== "live") return;
      const i = p.index,
        s = DEMO[i],
        c = {
          id: hash(`${m.id}:demo:${i}`),
          meetingId: m.id,
          kind: "live",
          demoIndex: i,
          text: s[s.source],
          source: s.source,
          speaker: s.speaker,
          speakerId: s.speaker,
          start: i * 6,
          end: i * 6 + 5,
          timing: "sample-script",
          receivedAt: Date.now(),
          simulated: true,
          translations: {},
        };
      addCue(c, m);
      if (i + 1 < DEMO.length)
        store.enqueue(
          `demo:${m.id}:${i + 1}`,
          "demo",
          { meetingId: m.id, index: i + 1 },
          Date.now() + 1800,
        );
      else
        store.enqueue(
          `stop:${m.id}`,
          "stop",
          { meetingId: m.id },
          Date.now() + 2000,
        );
    } else if (job.kind === "stop") {
      if (m.mode === "live") {
        if (m.endedAt) return;
        if (!m.botId) {
          if (m.status === "failed") return;
          throw Object.assign(
            new Error("Waiting for bot creation before stopping."),
            { pending: true },
          );
        }
        await sdk.bots.remove(m.botId);
        m = store.meeting(m.id);
        if (m.endedAt) return;
        m.status = "stopped";
        m.endedAt = Date.now();
        saveMeeting(m);
        queueFinal(m);
      } else {
        store.transaction(() => {
          for (const c of store.cues(m.id).filter((c) => c.kind === "live")) {
            const final = { ...c, id: hash(`${c.id}:final`), kind: "final" };
            if (store.insertCue(final)) queueTranslations(final, m);
          }
          m.status = "completed";
          m.endedAt = Date.now();
          m.postCallStatus = "ready";
          store.saveMeeting(m);
        });
        publish(m.id);
      }
    } else if (job.kind === "lifecycle") {
      const b = p.body,
        event = b.bot_event || b.event;
      if (m.botId && m.botId !== b.bot_id)
        throw new Error("Lifecycle bot_id mismatch.");
      if (b.transcript_id) m.transcriptId = b.transcript_id;
      if (
        ["bot.inmeeting", "bot.recording"].includes(event) &&
        !m.endedAt &&
        m.status !== "stopping"
      )
        m.status = "live";
      if (
        event === "bot.in_waiting_room" &&
        !m.endedAt &&
        m.status !== "stopping"
      )
        m.status = "waiting";
      if (
        !m.endedAt &&
        (b.event === "bot.stopped" ||
          [
            "bot.stopped",
            "bot.kicked",
            "bot.denied",
            "bot.notallowed",
            "bot.failed",
          ].includes(event))
      ) {
        m.status = ["bot.denied", "bot.notallowed", "bot.failed"].includes(
          event,
        )
          ? "failed"
          : "stopped";
        m.endedAt = Date.now();
        m.lastError =
          m.status === "failed"
            ? "Bot could not join. Check admission and platform settings."
            : null;
        queueFinal(m);
      }
      if (["transcription.processed", "bot.done"].includes(event)) {
        m.endedAt ||= Date.now();
        queueFinal(m, true);
      }
      if (
        ["transcription.failed", "transcription.skipped", "bot.error"].includes(
          event,
        ) &&
        m.postCallStatus !== "ready"
      ) {
        m.lastError =
          event === "bot.error"
            ? safeError({ message: b.message || "MeetStream reported a live transcription error. Check the provider key and dashboard." })
            : (m.liveError || "MeetStream could not produce a post-call transcript. Live captions are preserved.");
        if (event === "bot.error") {
          m.liveError = m.lastError;
          const provider = m.liveProvider?.replace("_streaming", "");
          if (["deepgram", "assemblyai", "jigsawstack"].includes(provider))
            connections.setCheck(provider === "jigsawstack" ? "jigsawstack_asr" : provider, {
              status: "failed", kind: "live_transcription", at: Date.now(), message: m.liveError,
              meetingId: m.id, upstreamStatus: Number(/HTTP\s+(\d{3})/i.exec(m.liveError)?.[1]) || null,
            });
        }
        if (event !== "bot.error") m.postCallStatus = "failed";
      }
      saveMeeting(m);
    } else if (job.kind === "final") {
      if (!m.transcriptId) {
        const d = await sdk.bots.detail(m.botId);
        m = store.meeting(m.id);
        m.transcriptId =
          d.transcript_id ||
          d.bot_details?.transcript_id ||
          d.bot_details?.TranscriptId;
        if (!m.transcriptId && sdk.transcripts.listForBot) {
          const list = await sdk.transcripts.listForBot(m.botId);
          const candidate = list.transcriptions
            ?.filter(
              (t) =>
                t.transcript_id &&
                !/_streaming$/.test(t.provider) &&
                !["Skipped", "Failed"].includes(t.status),
            )
            .at(-1);
          m = store.meeting(m.id);
          m.transcriptId = candidate?.transcript_id;
        }
        if (!m.transcriptId)
          throw Object.assign(
            new Error("Post-call transcript ID is not available yet."),
            { pending: true },
          );
        store.saveMeeting(m);
      }
      let data;
      try {
        data = await sdk.transcripts.get(m.transcriptId);
      } catch (e) {
        if (
          e.name !== "NotReadyError" ||
          !/Current status:\s*(Skipped|Failed)\b/i.test(
            e.body?.message || e.message,
          ) ||
          !sdk.transcripts.listForBot
        )
          throw e;
        const list = await sdk.transcripts.listForBot(m.botId);
        const candidate = list.transcriptions
          ?.filter(
            (t) =>
              t.transcript_id &&
              t.transcript_id !== m.transcriptId &&
              !/_streaming$/.test(t.provider) &&
              !["Skipped", "Failed"].includes(t.status),
          )
          .at(-1);
        if (!candidate) throw e;
        m = store.meeting(m.id);
        m.transcriptId = candidate.transcript_id;
        store.saveMeeting(m);
        data = await sdk.transcripts.get(m.transcriptId);
      }
      let cues;
      try {
        cues = normalizeTranscript(data, m);
      } catch (e) {
        e.status = 422;
        throw e;
      }
      store.transaction(() => {
        for (const c of cues) {
          if (store.insertCue(c)) queueTranslations(c, m);
        }
        m = store.meeting(m.id);
        m.status = "completed";
        m.postCallStatus = "ready";
        m.lastError = null;
        store.saveMeeting(m);
      });
      ensurePostCallSummaries(store.meeting(m.id));
      publish(m.id);
    } else if (job.kind === "retranscribe") {
      const data = await sdk.transcripts.transcribeBotAudio(m.botId, {
        provider: { [m.postCallProvider || "meetstream"]: postCallConfig(m) },
        callback_url: `${env.PUBLIC_ORIGIN}/webhooks/callback/${m.id}/${m.liveToken}`,
      });
      if (!data.transcript_id)
        throw new Error("MeetStream did not return a post-call transcript ID.");
      m = store.meeting(m.id);
      m.transcriptId = data.transcript_id;
      m.postCallStatus = "pending";
      m.recoveryStartedAt = Date.now();
      m.lastError = null;
      saveMeeting(m);
      queueFinal(m, true);
    } else if (job.kind === "status") {
      if (m.endedAt || m.mode === "demo") return;
      const data = await sdk.bots.status(m.botId),
        status = data.status || data.bot_status;
      m = store.meeting(m.id);
      if (m.endedAt) return;
      if (
        ["InMeeting", "Recording"].includes(status) &&
        m.status !== "stopping"
      )
        m.status = "live";
      if (status === "InWaitingRoom" && m.status !== "stopping")
        m.status = "waiting";
      if (
        [
          "Stopped",
          "Done",
          "Completed",
          "Failed",
          "NotAllowed",
          "Denied",
        ].includes(status)
      ) {
        m.endedAt = Date.now();
        m.status = ["Failed", "NotAllowed", "Denied"].includes(status)
          ? "failed"
          : "stopped";
        queueFinal(m);
      }
      saveMeeting(m);
      if (!m.endedAt)
        store.enqueue(
          `status:${m.id}:${Date.now()}`,
          "status",
          { meetingId: m.id },
          Date.now() + 10000,
        );
    }
  }
  function queueFinal(m, reviveFailed = false) {
    if (m.postCallStatus !== "ready") {
      store.enqueue(
        `final:${m.id}`,
        "final",
        { meetingId: m.id },
        Date.now() + 1000,
      );
      if (reviveFailed) store.requeueFailed(`final:${m.id}`);
    }
  }
  async function run(job) {
    try {
      await handle(job);
      store.done(job.id);
    } catch (e) {
      // MeetStream also returns HTTP 202 for terminal transcript states.
      // Its SDK exposes these as NotReadyError with the status in the message.
      const terminal =
        job.kind === "final" && e.name === "NotReadyError"
          ? /Current status:\s*(Skipped|Failed)\b/i.exec(
              e.body?.message || e.message,
            )
          : null;
      const pending = !terminal && (e.pending || e.name === "NotReadyError"),
        max = ["final", "switch-source"].includes(job.kind) ? 120 : job.kind === "status" ? 12 : 4,
        error = terminal
          ? `MeetStream reported the post-call transcript as ${terminal[1].toLowerCase()}. No post-call transcript was produced; live captions are preserved.`
          : safeError(e);
      if (
        job.attempts < max &&
        (!e.status || e.status === 429 || e.status >= 500 || pending)
      )
        store.retry(
          job.id,
          pending ? 5000 : Math.min(30000, 1000 * 2 ** job.attempts),
          error,
        );
      else {
        store.fail(job.id, error);
        const m = store.meeting(job.payload.meetingId);
        if (m) {
          m.lastError = error;
          if (job.kind === 'switch-source' && m.languageSwitch) m.languageSwitch.status='failed';
          if (job.kind === "create") {
            m.status = "failed";
            m.postCallStatus = "unavailable";
            const missing = /(Deepgram|AssemblyAI|JigsawStack)APIKey.{0,40}not configured|No API key configured for provider '(deepgram|assemblyai|jigsawstack)'/i.exec(error);
            if (missing) {
              const provider = (missing[1] || missing[2]).toLowerCase();
              const id = provider === "jigsawstack" ? "jigsawstack_asr" : provider;
              if (connections.check(id)?.status !== "processing")
                connections.setCheck(id, {
                  status: "failed", at: Date.now(), kind: "bot_creation",
                  message: `Live bot creation was rejected by the current API workspace: ${error}`,
                  upstreamStatus: Number.isInteger(e.status) ? e.status : null,
                  meetingId: m.id,
                });
            }
          }
          if (job.kind === "final") m.postCallStatus = "failed";
          store.saveMeeting(m);
        }
        if (job.kind === "translate") {
          if (m && [401,403].includes(e.status)) connections.setCheck(m.translationProvider,{status:"failed",at:Date.now(),message:error,upstreamStatus:e.status});
          const c = store.cue(job.payload.cueId);
          if (c) {
            c.translations[job.payload.target] = { status: "failed", error };
            store.saveCue(c);
          }
        }
        publish(job.payload.meetingId);
      }
    }
  }
  async function tick() {
    while (inflight.size < 4) {
      const job = store.claim();
      if (!job) break;
      const task = run(job);
      inflight.add(task);
      task.finally(() => inflight.delete(task));
    }
  }
  const interval = startWorker ? setInterval(() => void tick(), 150) : null;
  interval?.unref();
  return {
    app,
    store,
    tick,
    async close() {
      if (interval) clearInterval(interval);
      for (const set of clients.values()) for (const res of set) res.end();
      clients.clear();
      await Promise.allSettled([...inflight]);
      store.close();
    },
  };
}

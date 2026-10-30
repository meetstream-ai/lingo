import { createHash } from "node:crypto";
const hashKey = key => createHash("sha256").update(key).digest("hex");
import {TRANSLATION_LANGUAGES} from "./languages.js";
import { performance } from "node:perf_hooks";
import { LANGUAGES } from "./core.js";

export function decodeEntities(text) {
  return text.replace(
    /&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|#39);/gi,
    (all, c) => {
      if (c[0] === "#") {
        const n =
          c[1].toLowerCase() === "x"
            ? parseInt(c.slice(2), 16)
            : Number(c.slice(1));
        return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all;
      }
      return (
        { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[c.toLowerCase()] ||
        all
      );
    },
  );
}
export async function jsonRequest(url, options = {}, fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl(url, {
      ...options,
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    });
  } catch {
    throw new Error(
      "Provider connection failed or timed out. Check network and provider availability.",
    );
  }
  if (!response.ok) {
    const e = new Error(
      response.status === 456 ? "Translation quota is exhausted (HTTP 456). Increase the provider’s usage limit or choose another configured translator." : response.status === 401 ? "Provider authentication failed (HTTP 401). Check the key, account access and available credits in the provider dashboard."
        : response.status === 403 ? "Provider access denied (HTTP 403). Check this key’s API permissions, restrictions and billing."
        : `Provider returned HTTP ${response.status}. Check quota and provider status.`,
    );
    e.status = response.status;
    throw e;
  }
  try {
    return await response.json();
  } catch {
    throw new Error("Provider returned invalid JSON.");
  }
}
export function translationConfigured(provider, env) {
  return provider === "google" ? !!env.GOOGLE_TRANSLATE_API_KEY
    : provider === "azure" ? !!(env.AZURE_TRANSLATOR_KEY && env.AZURE_TRANSLATOR_REGION)
    : provider === "jigsawstack" ? !!env.JIGSAWSTACK_API_KEY
    : provider === "deepl" ? !!env.DEEPL_API_KEY : false;
}
export async function translate(
  text,
  source,
  target,
  provider,
  env = process.env,
  fetchImpl = fetch,
) {
  if (!Object.hasOwn(TRANSLATION_LANGUAGES,provider)) throw new Error("Unsupported translation provider.");
  if (!Object.hasOwn(TRANSLATION_LANGUAGES[provider],target)) throw Error('Choose a target supported by this translation adapter.');
  if (provider==='deepl' && source && source!=='auto' && !Object.hasOwn(TRANSLATION_LANGUAGES.deepl,source)) throw Error('This source is outside the DeepL adapter’s verified catalog. Use automatic detection or another translator.');
  const began = performance.now();
  if (source === target)
    return { text, detectedSource: source, durationMs: 0, passthrough: true };
  if (!translationConfigured(provider, env))
    throw new Error(
      `Configure ${provider === "deepl" ? "DEEPL_API_KEY" : provider === "google" ? "GOOGLE_TRANSLATE_API_KEY" : provider === "jigsawstack" ? "JIGSAWSTACK_API_KEY" : "AZURE_TRANSLATOR_KEY and AZURE_TRANSLATOR_REGION"} on the server.`,
    );
  let translated, detected;
  if (provider === 'deepl') {
    const body=JSON.stringify({text:[text],target_lang:({en:'EN-US',pt:'PT-BR',zh:'ZH-HANS'})[target] || target.toUpperCase(),...(source && source!=='auto'?{source_lang:source.toUpperCase()}:{})});
    if(Buffer.byteLength(body)>128*1024)throw Error('DeepL text requests must fit its 128 KiB request limit.');
    const host=env.DEEPL_API_KEY.endsWith(':fx')?'api-free.deepl.com':'api.deepl.com';
    const data=await jsonRequest(`https://${host}/v2/translate`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`DeepL-Auth-Key ${env.DEEPL_API_KEY}`},body},fetchImpl);
    translated=data.translations?.[0]?.text;
    detected=data.translations?.[0]?.detected_source_language?.toLowerCase() || source;
  } else if (provider === "google") {
    const data = await jsonRequest(
      "https://translation.googleapis.com/language/translate/v2",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": env.GOOGLE_TRANSLATE_API_KEY,
        },
        body: JSON.stringify({
          q: text,
          target,
          format: "text",
          ...(source && source !== "auto" ? { source } : {}),
        }),
      },
      fetchImpl,
    );
    const t = data.data?.translations?.[0];
    translated = t?.translatedText;
    detected = t?.detectedSourceLanguage || source;
    if (typeof translated === "string") translated = decodeEntities(translated);
  } else if (provider === "jigsawstack") {
    if (text.length > 5000) throw new Error("JigsawStack translation accepts at most 5000 characters per turn.");
    const data = await jsonRequest("https://api.jigsawstack.com/v1/ai/translate", {
      method: "POST", headers: { "Content-Type": "application/json", "x-api-key": env.JIGSAWSTACK_API_KEY },
      body: JSON.stringify({ text, target_language: target, ...(source && source !== "auto" ? { current_language: source } : {}) })
    }, fetchImpl);
    if (data.success !== true) throw new Error("JigsawStack rejected the translation.");
    translated = data.translated_text;
    detected = data.detected_language || source;
  } else {
    const query = new URLSearchParams({
      "api-version": "3.0",
      to: target,
      ...(source && source !== "auto" ? { from: source } : {}),
    });
    const data = await jsonRequest(
      `https://api.cognitive.microsofttranslator.com/translate?${query}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Ocp-Apim-Subscription-Key": env.AZURE_TRANSLATOR_KEY,
          "Ocp-Apim-Subscription-Region": env.AZURE_TRANSLATOR_REGION,
        },
        body: JSON.stringify([{ Text: text }]),
      },
      fetchImpl,
    );
    translated = data[0]?.translations?.[0]?.text;
    detected = data[0]?.detectedLanguage?.language || source;
  }
  if (typeof translated !== "string" || !translated.trim())
    throw new Error("Translation provider returned no text.");
  return {
    text: translated,
    detectedSource: Object.hasOwn(LANGUAGES, detected) ? detected : source || null,
    durationMs: Math.round(performance.now() - began),
    passthrough: false,
  };
}
export async function shareArtifact(
  destination,
  artifact,
  env = process.env,
  fetchImpl = fetch,
) {
  if(destination==='discord') {
    const url=new URL(discordWebhook(env.DISCORD_WEBHOOK_URL));url.searchParams.set('wait','true');
    if(Buffer.byteLength(artifact.content)>8*1024*1024)throw Error('This transcript exceeds the adapter’s 8 MB attachment limit. Download it instead.');
    const form=new FormData();form.append('payload_json',JSON.stringify({content:'Meeting transcript from Lingo',allowed_mentions:{parse:[]},attachments:[{id:0,filename:artifact.filename}]}));form.append('files[0]',new Blob([artifact.content],{type:artifact.type}),artifact.filename);
    const data=await jsonRequest(url,{method:'POST',body:form},fetchImpl);
    if(!data.id || !data.channel_id)throw Error('Discord did not confirm the message. Check the channel before retrying.');
    return {id:data.id,url:`https://discord.com/channels/${data.guild_id || '@me'}/${data.channel_id}/${data.id}`};
  }
  if (destination === "gmail") {
    if (!env.GMAIL_CLIENT_ID || !env.GMAIL_CLIENT_SECRET || !env.GMAIL_REFRESH_TOKEN)
      throw new Error("Configure Gmail OAuth credentials with gmail.compose access.");
    const auth = await jsonRequest("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: env.GMAIL_CLIENT_ID, client_secret: env.GMAIL_CLIENT_SECRET, refresh_token: env.GMAIL_REFRESH_TOKEN }).toString()
    }, fetchImpl);
    if (!auth.access_token) throw new Error("Google did not return an access token.");
    const boundary = "lingua_" + crypto.randomUUID();
    const name = artifact.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    const encoded = Buffer.from(artifact.content).toString("base64").match(/.{1,76}/g)?.join("\r\n") || "";
    const mime = [`Subject: =?UTF-8?B?${Buffer.from("Meeting transcript: " + artifact.filename).toString("base64")}?=`, "MIME-Version: 1.0", `Content-Type: multipart/mixed; boundary="${boundary}"`, "", `--${boundary}`, "Content-Type: text/plain; charset=UTF-8", "", "Review the attached meeting transcript and choose recipients before sending.", `--${boundary}`, `Content-Type: ${artifact.type}`, "Content-Transfer-Encoding: base64", `Content-Disposition: attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(artifact.filename)}`, "", encoded, `--${boundary}--`, ""].join("\r\n");
    const data = await jsonRequest("https://gmail.googleapis.com/gmail/v1/users/me/drafts", {
      method: "POST", headers: { Authorization: `Bearer ${auth.access_token}`, "Content-Type": "application/json" }, body: JSON.stringify({ message: { raw: Buffer.from(mime).toString("base64url") } })
    }, fetchImpl);
    if (!data.id) throw new Error("Gmail did not confirm the draft.");
    return { id: data.id, url: "https://mail.google.com/mail/u/0/#drafts", draft: true };
  }
  if (destination === "drive") {
    if (
      !env.GOOGLE_DRIVE_REFRESH_TOKEN ||
      !env.GOOGLE_CLIENT_ID ||
      !env.GOOGLE_CLIENT_SECRET ||
      !env.GOOGLE_DRIVE_FOLDER_ID
    )
      throw new Error(
        "Configure Google OAuth credentials, refresh token and Drive folder ID.",
      );
    const auth = await jsonRequest(
      "https://oauth2.googleapis.com/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: env.GOOGLE_CLIENT_ID,
          client_secret: env.GOOGLE_CLIENT_SECRET,
          refresh_token: env.GOOGLE_DRIVE_REFRESH_TOKEN,
        }).toString(),
      },
      fetchImpl,
    );
    if (!auth.access_token)
      throw new Error("Google did not return an access token.");
    const boundary = "meetstream_artifact_boundary";
    const metadata = {
      name: artifact.filename,
      mimeType: artifact.type.split(";")[0],
      parents: [env.GOOGLE_DRIVE_FOLDER_ID],
    };
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${artifact.type}\r\n\r\n${artifact.content}\r\n--${boundary}--\r\n`;
    const data = await jsonRequest(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink&supportsAllDrives=true",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${auth.access_token}`,
          "Content-Type": `multipart/related; boundary=${boundary}`,
        },
        body,
      },
      fetchImpl,
    );
    if (!data.id) throw new Error("Drive did not confirm the file upload.");
    return {
      id: data.id,
      url:
        data.webViewLink ||
        `https://drive.google.com/file/d/${encodeURIComponent(data.id)}/view`,
    };
  }
  if (destination !== "slack") throw new Error("Choose Slack or Google Drive.");
  if (!env.SLACK_BOT_TOKEN || !env.SLACK_CHANNEL_ID)
    throw new Error("Configure SLACK_BOT_TOKEN and SLACK_CHANNEL_ID.");
  async function slack(method, body) {
    const data = await jsonRequest(
      `https://slack.com/api/${method}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(body).toString(),
      },
      fetchImpl,
    );
    if (!data.ok)
      throw new Error(
        `Slack rejected the request (${String(data.error || "unknown_error")
          .replace(/[^\w]/g, "")
          .slice(0, 60)}). Check token scopes and channel membership.`,
      );
    return data;
  }
  const upload = await slack("files.getUploadURLExternal", {
    filename: artifact.filename,
    length: String(Buffer.byteLength(artifact.content)),
  });
  const u = new URL(upload.upload_url);
  if (
    u.protocol !== "https:" ||
    !(u.hostname === "slack.com" || u.hostname.endsWith(".slack.com"))
  )
    throw new Error("Slack returned an unexpected upload host.");
  const res = await fetchImpl(u, {
    method: "POST",
    body: artifact.content,
    headers: { "Content-Type": artifact.type },
    signal: AbortSignal.timeout(15000),
    redirect: "error",
  });
  if (!res.ok)
    throw new Error(`Slack file upload failed (HTTP ${res.status}).`);
  const completed = await slack("files.completeUploadExternal", {
    files: JSON.stringify([{ id: upload.file_id, title: artifact.filename }]),
    channel_id: env.SLACK_CHANNEL_ID,
  });
  const file = completed.files?.[0];
  return { id: upload.file_id, url: file?.permalink || null };
}

const speechVoices = new Map();
export async function translatedAudio(text, target, env, fetchImpl=fetch) {
  const key=env.GOOGLE_TTS_API_KEY || (!env.GOOGLE_TTS_FALLBACK_DISABLED && env.GOOGLE_TRANSLATE_API_KEY);
  if(!key) throw Error('Configure a Google Cloud Text-to-Speech API key in Connections.');
  if(!text?.trim() || Buffer.byteLength(text,'utf8')>5000) throw Error('Cloud audio supports up to 5,000 UTF-8 bytes. Listen to an individual transcript turn instead.');
  const fingerprint=hashKey(key);
  let cached=speechVoices.get(fingerprint);
  if(!cached || Date.now()-cached.at>3600000) {
    const data=await jsonRequest('https://texttospeech.googleapis.com/v1/voices',{headers:{'X-Goog-Api-Key':key}},fetchImpl);
    if(!Array.isArray(data.voices))throw Error('Cloud speech returned no voice catalog.');
    cached={voices:data.voices,at:Date.now()};speechVoices.clear();speechVoices.set(fingerprint,cached);
  }
  const base=target.toLowerCase().split('-')[0], code=base==='zh'?'cmn':base;
  const candidates=cached.voices.filter(v=>v.languageCodes?.some(c=>c.toLowerCase().split('-')[0]===code));
  const exact=candidates.filter(v=>v.languageCodes.some(c=>c.toLowerCase()===target.toLowerCase()));
  const choices=exact.length?exact:candidates;
  const voice=choices.find(v=>v.name.includes('Standard')) || choices[0];
  if(!voice)throw Error(`Google Cloud speech has no voice for ${target}. Use an installed device voice if available.`);
  const data=await jsonRequest('https://texttospeech.googleapis.com/v1/text:synthesize',{method:'POST',headers:{'Content-Type':'application/json','X-Goog-Api-Key':key},body:JSON.stringify({input:{text},voice:{languageCode:voice.languageCodes[0],name:voice.name},audioConfig:{audioEncoding:'MP3'}})},fetchImpl);
  if(typeof data.audioContent!=='string' || !/^[A-Za-z0-9+/]+=*$/.test(data.audioContent) || data.audioContent.length>2000000)throw Error('Cloud speech returned invalid audio.');
  return {audioContent:data.audioContent,type:'audio/mpeg',language:voice.languageCodes[0],voice:voice.name};
}

export function discordWebhook(value) {
 let u;try{u=new URL(value);}catch{throw Error('Configure a Discord channel webhook URL.');}
 if(u.protocol!=='https:' || u.hostname!=='discord.com' || u.port || u.username || u.password || !/^\/api(?:\/v10)?\/webhooks\/\d{15,22}\/[A-Za-z0-9_-]{20,200}$/.test(u.pathname) || u.search || u.hash)throw Error('Use a discord.com channel webhook URL without query parameters.');
 return u.href;
}

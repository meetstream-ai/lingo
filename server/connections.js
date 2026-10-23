import {calendarEvents} from './calendar.js';
import {discordWebhook} from './providers.js';
import {
  existsSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { translate, jsonRequest, translationConfigured, translatedAudio } from "./providers.js";

// Credentials stay on the server. Blank form fields preserve existing values.
export const CONNECTIONS = {
  calendar:{name:"Google Calendar",fields:[["CALENDAR_CLIENT_ID","OAuth client ID",false],["CALENDAR_CLIENT_SECRET","OAuth client secret",true],["CALENDAR_REFRESH_TOKEN","Read-only OAuth refresh token",true],["CALENDAR_ID","Calendar ID · primary or email",false]]},
  discord:{name:"Discord",fields:[["DISCORD_WEBHOOK_URL","Channel webhook URL",true]]},
  meetstream: {
    name: "MeetStream",
    fields: [["MEETSTREAM_API_KEY", "API key", true]],
  },
  google_tts: {name:"Google Cloud speech",fields:[["GOOGLE_TTS_API_KEY","API key · optional if the Translation key also has speech access",true]]},
  deepl:{name:"DeepL",fields:[["DEEPL_API_KEY","API key · Free or Pro",true]]},
  google: {
    name: "Google Cloud Translation",
    fields: [["GOOGLE_TRANSLATE_API_KEY", "API key", true]],
  },
  jigsawstack: { name: "JigsawStack translation", fields: [["JIGSAWSTACK_API_KEY", "API key", true]] },
  gmail: { name: "Gmail drafts", fields: [["GMAIL_CLIENT_ID", "OAuth client ID", false], ["GMAIL_CLIENT_SECRET", "OAuth client secret", true], ["GMAIL_REFRESH_TOKEN", "OAuth refresh token", true]] },
  azure: {
    name: "Azure Translator",
    fields: [
      ["AZURE_TRANSLATOR_KEY", "Subscription key", true],
      ["AZURE_TRANSLATOR_REGION", "Region", false],
    ],
  },
  slack: {
    name: "Slack",
    fields: [
      ["SLACK_BOT_TOKEN", "Bot token", true],
      ["SLACK_CHANNEL_ID", "Channel ID", false],
    ],
  },
  drive: {
    name: "Google Drive",
    fields: [
      ["GOOGLE_CLIENT_ID", "OAuth client ID", false],
      ["GOOGLE_CLIENT_SECRET", "OAuth client secret", true],
      ["GOOGLE_DRIVE_REFRESH_TOKEN", "OAuth refresh token", true],
      ["GOOGLE_DRIVE_FOLDER_ID", "Folder ID", false],
    ],
  },
};

export function openConnections(path, env) {
  let saved = { values: {}, checks: {} };
  if (path && existsSync(path)) {
    try {
      saved = JSON.parse(readFileSync(path, "utf8"));
      if (
        !saved?.values ||
        !saved?.checks ||
        typeof saved.values !== "object" ||
        Array.isArray(saved.values) ||
        typeof saved.checks !== "object" ||
        Array.isArray(saved.checks) ||
        Object.values(saved.values).some((v) => typeof v !== "string")
      )
        throw new Error();
    } catch {
      throw new Error(
        "Saved connection settings are invalid. Repair the private connections.json file before starting.",
      );
    }
  }
  const keys = Object.values(CONNECTIONS).flatMap((c) =>
    c.fields.map(([key]) => key),
  );
  for (const key of keys)
    if (Object.hasOwn(saved.values, key)) env[key] = saved.values[key];
  env.GOOGLE_TTS_FALLBACK_DISABLED = Object.hasOwn(saved.values,"GOOGLE_TTS_API_KEY") && !saved.values.GOOGLE_TTS_API_KEY;
  function credentialFingerprint(id) {
    const fields = ["deepgram", "assemblyai", "jigsawstack_asr"].includes(id)
      ? ["MEETSTREAM_API_KEY"]
      : id === "google_tts" ? ["GOOGLE_TTS_API_KEY","GOOGLE_TRANSLATE_API_KEY","GOOGLE_TTS_FALLBACK_DISABLED"] : CONNECTIONS[id]?.fields.map(([key]) => key) || [];
    return createHash("sha256").update(JSON.stringify(fields.map(key => env[key] || ""))).digest("hex");
  }
  function check(id) {
    const result = saved.checks[id];
    // A result from another key (including an unbound legacy result) proves nothing about this one.
    return result?.credentialFingerprint === credentialFingerprint(id) ? result : null;
  }
  function persist(next) {
    if (path) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const tmp = `${path}.${randomUUID()}.tmp`;
      try {
        writeFileSync(tmp, JSON.stringify(next), { mode: 0o600, flag: "wx" });
        renameSync(tmp, path);
      } finally {
        if (existsSync(tmp)) unlinkSync(tmp);
      }
    }
    saved = next;
  }
  return {
    list() {
      return Object.entries(CONNECTIONS).map(([id, c]) => ({
        id,
        name: c.name,
        configured: c.fields.every(([key]) => !!env[key]) || (id === "google_tts" && !env.GOOGLE_TTS_FALLBACK_DISABLED && !!env.GOOGLE_TRANSLATE_API_KEY),
        check: check(id),
        fields: c.fields.map(([key, label, secret]) => ({
          key,
          label,
          secret,
          configured: !!env[key],
          ...(!secret ? { value: env[key] || "" } : {}),
        })),
      }));
    },
    save(id, body) {
      const c = CONNECTIONS[id];
      if (
        !Object.hasOwn(CONNECTIONS, id) ||
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).some((k) => !["values", "disconnect"].includes(k))
      )
        throw new Error("Invalid connection settings.");
      if (body.disconnect !== undefined && typeof body.disconnect !== "boolean")
        throw new Error("Invalid disconnect option.");
      const values = body.values === undefined ? {} : body.values;
      if (
        values === null ||
        typeof values !== "object" ||
        Array.isArray(values) ||
        Object.keys(values).some((key) => !c.fields.some(([k]) => k === key))
      )
        throw new Error("Unsupported credential field.");
      const next = { values: { ...saved.values }, checks: { ...saved.checks } };
      for (const [key] of c.fields) {
        if (body.disconnect) next.values[key] = "";
        else if (Object.hasOwn(values, key)) {
          if (
            typeof values[key] !== "string" ||
            values[key].length > 8192 ||
            /[\r\n\0]/.test(values[key])
          )
            throw new Error(
              "Credentials must be single-line text of up to 8192 characters.",
            );
          if (values[key].trim()) next.values[key] = values[key].trim();
        }
      }
      const changed = c.fields.some(
        ([key]) =>
          (Object.hasOwn(next.values, key) ? next.values[key] : env[key]) !==
          env[key],
      );
      if (changed || body.disconnect) delete next.checks[id];
      if (id === "meetstream" && changed) for (const p of ["deepgram", "assemblyai", "jigsawstack_asr"]) delete next.checks[p];
      persist(next);
      for (const [key] of c.fields)
        if (Object.hasOwn(next.values, key)) env[key] = next.values[key];
      if(id === "google_tts") env.GOOGLE_TTS_FALLBACK_DISABLED = Object.hasOwn(next.values,"GOOGLE_TTS_API_KEY") && !next.values.GOOGLE_TTS_API_KEY;
      return changed;
    },
    check,
    source: (key) => Object.hasOwn(saved.values, key) ? "browser settings" : ".env",
    setCheck(id, check) {
      persist({
        values: { ...saved.values },
        checks: { ...saved.checks, [id]: { ...check, credentialFingerprint: credentialFingerprint(id) } },
      });
    },
  };
}

export async function testConnection(id, env, sdk, fetchImpl) {
  if (id === "google_tts") { await translatedAudio("Hello", "en", env, fetchImpl); return "Google Cloud speech generated test audio. Enable the Text-to-Speech API for this key’s project."; }
  if (id === "meetstream") {
    if (!sdk) throw new Error("Configure the MeetStream API key first.");
    await sdk.bots.list({ query: { limit: 1 } });
    return "MeetStream accepted this workspace API key.";
  }
  if (["google", "azure", "jigsawstack", "deepl"].includes(id)) {
    if (!translationConfigured(id, env))
      throw new Error("Save the translation credentials first.");
    await translate(id==='deepl'?"Bonjour":"नमस्ते", id==='deepl'?"fr":"hi", "en", id, env, fetchImpl);
    return `${id==='deepl'?"French":"Hindi"} → English test translation succeeded.`;
  }
  if(id==='calendar'){await calendarEvents(env,fetchImpl,Date.now(),true);return "Google Calendar read access confirmed. Meeting names match conference links near the call time.";}
  if(id==='discord'){const data=await jsonRequest(discordWebhook(env.DISCORD_WEBHOOK_URL),{},fetchImpl);if(!data.id || !data.channel_id)throw Error("Discord did not return a channel webhook.");return "Discord channel webhook verified. No message was sent.";}
  if (id === "slack") {
    if (!env.SLACK_BOT_TOKEN || !env.SLACK_CHANNEL_ID)
      throw new Error("Save the bot token and channel ID first.");
    const headers = { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` };
    const auth = await jsonRequest(
      "https://slack.com/api/auth.test",
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: "{}",
      },
      fetchImpl,
    );
    if (!auth.ok)
      throw new Error(
        "Slack rejected the bot token. Check its validity and scopes.",
      );
    const channel = await jsonRequest(
      `https://slack.com/api/conversations.info?channel=${encodeURIComponent(env.SLACK_CHANNEL_ID)}`,
      { headers },
      fetchImpl,
    );
    if (
      !channel.ok ||
      !channel.channel?.is_member ||
      channel.channel?.is_archived
    )
      throw new Error(
        "The bot must belong to an active channel. Check channel scopes and membership.",
      );
    return "Slack authenticated the bot and confirmed channel membership. File-upload permission is checked when you share.";
  }
  if (id === "gmail") {
    if (!["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN"].every(k => env[k])) throw new Error("Save Gmail OAuth credentials first.");
    const auth = await jsonRequest("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", client_id: env.GMAIL_CLIENT_ID, client_secret: env.GMAIL_CLIENT_SECRET, refresh_token: env.GMAIL_REFRESH_TOKEN }).toString() }, fetchImpl);
    if (!auth.access_token) throw new Error("Google did not return an access token.");
    const info = await jsonRequest("https://oauth2.googleapis.com/tokeninfo?access_token=" + encodeURIComponent(auth.access_token), {}, fetchImpl);
    if (!String(info.scope || "").split(" ").some(x => ["https://www.googleapis.com/auth/gmail.compose", "https://www.googleapis.com/auth/gmail.modify", "https://mail.google.com/"].includes(x))) throw new Error("Authorize this Gmail refresh token with gmail.compose access.");
    return "Google refreshed the token and confirmed draft permissions. No draft was created or email sent.";
  }
  if (id === "drive") {
    if (
      ![
        "GOOGLE_CLIENT_ID",
        "GOOGLE_CLIENT_SECRET",
        "GOOGLE_DRIVE_REFRESH_TOKEN",
        "GOOGLE_DRIVE_FOLDER_ID",
      ].every((k) => env[k])
    )
      throw new Error("Save all Google Drive credentials first.");
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
    const folder = await jsonRequest(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(env.GOOGLE_DRIVE_FOLDER_ID)}?fields=mimeType,capabilities(canAddChildren)&supportsAllDrives=true`,
      { headers: { Authorization: `Bearer ${auth.access_token}` } },
      fetchImpl,
    );
    if (
      folder.mimeType !== "application/vnd.google-apps.folder" ||
      !folder.capabilities?.canAddChildren
    )
      throw new Error("Choose a Drive folder this OAuth account can write to.");
    return "Google refreshed the token and confirmed access to a writable folder. No file was uploaded.";
  }
  throw new Error("Unsupported connection.");
}

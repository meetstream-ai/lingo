import test from "node:test";
import assert from "node:assert/strict";
import { MeetStream, NotReadyError } from "@meetstream/sdk";
import {
  translate,
  shareArtifact,
  decodeEntities,
} from "../server/providers.js";
const json = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
test("Google translation uses automatic detection, plain text, key header and decodes escaped response", async () => {
  const result = await translate(
    "नमस्ते",
    null,
    "en",
    "google",
    { GOOGLE_TRANSLATE_API_KEY: "test-key" },
    async (url, opts) => {
      assert.equal(
        url,
        "https://translation.googleapis.com/language/translate/v2",
      );
      assert.equal(opts.headers["X-Goog-Api-Key"], "test-key");
      assert.deepEqual(JSON.parse(opts.body), {
        q: "नमस्ते",
        target: "en",
        format: "text",
      });
      return json({
        data: {
          translations: [
            {
              translatedText: "Hello &amp; welcome &#39;all&#39;",
              detectedSourceLanguage: "hi",
            },
          ],
        },
      });
    },
  );
  assert.equal(result.text, "Hello & welcome 'all'");
  assert.equal(result.detectedSource, "hi");
  assert.ok(result.durationMs >= 0);
  assert.equal(decodeEntities("&#x0BB5;"), "வ");
});
test("Azure translates Tamil to Hindi with automatic detection and correct headers", async () => {
  const r = await translate(
    "வணக்கம்",
    null,
    "hi",
    "azure",
    { AZURE_TRANSLATOR_KEY: "key", AZURE_TRANSLATOR_REGION: "centralindia" },
    async (url, opts) => {
      assert.match(url, /to=hi/);
      assert.doesNotMatch(url, /from=/);
      assert.equal(
        opts.headers["Ocp-Apim-Subscription-Region"],
        "centralindia",
      );
      assert.deepEqual(JSON.parse(opts.body), [{ Text: "வணக்கம்" }]);
      return json([
        {
          detectedLanguage: { language: "ta", score: 1 },
          translations: [{ text: "नमस्ते", to: "hi" }],
        },
      ]);
    },
  );
  assert.equal(r.text, "नमस्ते");
  assert.equal(r.detectedSource, "ta");
});
test("provider failures, missing configuration, empty responses and passthroughs are explicit", async () => {
  await assert.rejects(
    () => translate("x", null, "en", "google", {}),
    /Configure/,
  );
  await assert.rejects(
    () =>
      translate(
        "x",
        null,
        "en",
        "google",
        { GOOGLE_TRANSLATE_API_KEY: "x" },
        async () => json({}, 429),
      ),
    /429/,
  );
  await assert.rejects(
    () =>
      translate(
        "x",
        null,
        "en",
        "google",
        { GOOGLE_TRANSLATE_API_KEY: "x" },
        async () => json({}),
      ),
    /no text/,
  );
  assert.equal(
    (await translate("Hello", "en", "en", "google", {})).passthrough,
    true,
  );
});
test("Slack uses current external upload flow with UTF-8 byte length", async () => {
  const calls = [],
    artifact = {
      filename: "meeting.html",
      type: "text/html; charset=utf-8",
      content: "नमस्ते",
    },
    env = { SLACK_BOT_TOKEN: "token", SLACK_CHANNEL_ID: "C123" };
  const result = await shareArtifact(
    "slack",
    artifact,
    env,
    async (url, options) => {
      url = String(url);
      calls.push(url);
      if (url.endsWith("files.getUploadURLExternal")) {
        assert.equal(
          new URLSearchParams(options.body).get("length"),
          String(Buffer.byteLength(artifact.content)),
        );
        return json({
          ok: true,
          upload_url: "https://files.slack.com/upload",
          file_id: "F1",
        });
      }
      if (url.includes("/upload")) return new Response("OK");
      const p = new URLSearchParams(options.body);
      assert.equal(p.get("channel_id"), "C123");
      assert.equal(JSON.parse(p.get("files"))[0].id, "F1");
      return json({
        ok: true,
        files: [{ permalink: "https://slack.com/file/F1" }],
      });
    },
  );
  assert.equal(calls.length, 3);
  assert.equal(result.id, "F1");
  await assert.rejects(
    () =>
      shareArtifact("slack", artifact, env, async () =>
        json({ ok: false, error: "missing_scope" }),
      ),
    /missing_scope/,
  );
});
test("Drive refreshes OAuth token and uploads bilingual artifact to configured folder", async () => {
  const env = {
      GOOGLE_CLIENT_ID: "client",
      GOOGLE_CLIENT_SECRET: "secret",
      GOOGLE_DRIVE_REFRESH_TOKEN: "refresh",
      GOOGLE_DRIVE_FOLDER_ID: "folder",
    },
    artifact = {
      filename: "meeting.html",
      type: "text/html; charset=utf-8",
      content: '<p lang="hi">नमस्ते</p>',
    };
  const result = await shareArtifact(
    "drive",
    artifact,
    env,
    async (url, opts) => {
      if (url.includes("oauth2")) {
        assert.equal(
          new URLSearchParams(opts.body).get("grant_type"),
          "refresh_token",
        );
        return json({ access_token: "access" });
      }
      assert.equal(opts.headers.Authorization, "Bearer access");
      assert.match(opts.body, /"parents":\["folder"\]/);
      assert.match(opts.body, /नमस्ते/);
      assert.match(url, /uploadType=multipart/);
      return json({
        id: "drive-id",
        webViewLink: "https://drive.google.com/file/d/drive-id/view",
      });
    },
  );
  assert.equal(result.id, "drive-id");
});
test("official SDK sends Token auth and persistent idempotency, treats 507 replay as success and 202 as pending", async () => {
  const requests = [],
    sdk = new MeetStream({
      apiKey: "test-key",
      maxRetries: 0,
      fetch: async (url, opts) => {
        requests.push({ url, opts });
        if (String(url).includes("/get_transcript"))
          return json({ message: "pending" }, 202);
        return json({ bot_id: "bot-1", transcript_id: "transcript-1" }, 507);
      },
    });
  const bot = await sdk.bots.create(
    { meeting_link: "https://meet.google.com/abc-defg-hij", bot_name: "Kit" },
    { idempotencyKey: "stable-uuid" },
  );
  assert.equal(bot.bot_id, "bot-1");
  assert.equal(requests[0].opts.headers.Authorization, "Token test-key");
  assert.equal(requests[0].opts.headers["Idempotency-Key"], "stable-uuid");
  await assert.rejects(
    () => sdk.transcripts.get("transcript-1"),
    NotReadyError,
  );
  assert.match(
    String(requests[1].url),
    /\/transcript\/transcript-1\/get_transcript/,
  );
});

test("connection checks validate Slack membership and Drive folder access without publishing files", async () => {
  const { testConnection } = await import("../server/connections.js");
  const requests = [];
  const env = {
    SLACK_BOT_TOKEN: "token",
    SLACK_CHANNEL_ID: "C1",
    GOOGLE_CLIENT_ID: "client",
    GOOGLE_CLIENT_SECRET: "secret",
    GOOGLE_DRIVE_REFRESH_TOKEN: "refresh",
    GOOGLE_DRIVE_FOLDER_ID: "folder",
  };
  const mock = async (url, options) => {
    requests.push([String(url), options.method || "GET"]);
    if (String(url).includes("auth.test")) return Response.json({ ok: true });
    if (String(url).includes("conversations.info"))
      return Response.json({
        ok: true,
        channel: { is_member: true, is_archived: false },
      });
    if (String(url).includes("oauth2"))
      return Response.json({ access_token: "access" });
    return Response.json({
      mimeType: "application/vnd.google-apps.folder",
      capabilities: { canAddChildren: true },
    });
  };
  await testConnection("slack", env, null, mock);
  await testConnection("drive", env, null, mock);
  assert.equal(requests.length, 4);
  assert.ok(
    requests.every(
      ([url]) => !url.includes("/upload") && !url.includes("files.complete"),
    ),
  );
  await assert.rejects(
    testConnection("slack", env, null, async () =>
      Response.json({ ok: false }),
    ),
    /rejected/,
  );
  await assert.rejects(
    testConnection("drive", env, null, async (url) =>
      Response.json(
        String(url).includes("oauth2")
          ? { access_token: "access" }
          : { mimeType: "text/plain" },
      ),
    ),
    /folder/,
  );
});

test('JigsawStack uses documented text API, automatic detection, and rejects failed/oversize output', async () => {
  const env = { JIGSAWSTACK_API_KEY: 'private-key' };
  const result = await translate('வணக்கம்', null, 'hi', 'jigsawstack', env, async (url, opts) => {
    assert.equal(url, 'https://api.jigsawstack.com/v1/ai/translate');
    assert.equal(opts.headers['x-api-key'], 'private-key');
    assert.deepEqual(JSON.parse(opts.body), { text: 'வணக்கம்', target_language: 'hi' });
    return json({ success: true, translated_text: 'नमस्ते' });
  });
  assert.equal(result.text, 'नमस्ते'); assert.equal(result.detectedSource, null);
  await assert.rejects(translate('x', 'hi', 'en', 'jigsawstack', env, async () => json({ success: false, translated_text: 'wrong' })), /rejected/);
  await assert.rejects(translate('x'.repeat(5001), 'hi', 'en', 'jigsawstack', env), /5000/);
  await assert.rejects(translate('x', 'hi', 'en', 'unknown', {}), /Unsupported/);
});
test('Gmail creates a reviewable UTF-8 attachment draft and never calls send', async () => {
  const urls = [];
  const result = await shareArtifact('gmail', { filename: 'meeting.txt', content: 'தமிழ் → हिन्दी', type: 'text/plain; charset=utf-8' }, { GMAIL_CLIENT_ID: 'client', GMAIL_CLIENT_SECRET: 'secret', GMAIL_REFRESH_TOKEN: 'refresh' }, async (url, opts) => {
    urls.push(url);
    if (url.includes('oauth2')) return json({ access_token: 'access' });
    assert.equal(url, 'https://gmail.googleapis.com/gmail/v1/users/me/drafts');
    const mime = Buffer.from(JSON.parse(opts.body).message.raw, 'base64url').toString();
    assert.match(mime, /Content-Disposition: attachment; filename="meeting.txt"/);
    assert.ok(mime.includes(Buffer.from('தமிழ் → हिन्दी').toString('base64')));
    assert.doesNotMatch(mime, /\r\nTo:/);
    return json({ id: 'draft-1' });
  });
  assert.equal(result.draft,true); assert.equal(urls.length,2);
  assert.ok(urls.every(url => !url.includes('/send')));
});

test('DeepL uses header auth, the correct Free/Pro host and its verified language catalog',async()=>{
 const seen=[];const fake=async(url,opts)=>{seen.push({url,opts});return json({translations:[{text:'Hello',detected_source_language:'FR'}]});};
 const result=await translate('Bonjour',null,'en','deepl',{DEEPL_API_KEY:'fixture:fx'},fake);
 assert.equal(result.text,'Hello');assert.equal(result.detectedSource,'fr');assert.equal(seen[0].url,'https://api-free.deepl.com/v2/translate');assert.equal(seen[0].opts.headers.Authorization,'DeepL-Auth-Key fixture:fx');assert.deepEqual(JSON.parse(seen[0].opts.body),{text:['Bonjour'],target_lang:'EN-US'});assert.ok(!seen[0].opts.body.includes('fixture'));
 await translate('Hallo','de','fr','deepl',{DEEPL_API_KEY:'fixture-pro'},fake);assert.equal(seen[1].url,'https://api.deepl.com/v2/translate');assert.equal(JSON.parse(seen[1].opts.body).source_lang,'DE');
 await assert.rejects(()=>translate('x','hi','en','deepl',{DEEPL_API_KEY:'fixture'},fake),/verified catalog/);
 await assert.rejects(()=>translate('x','en','ta','deepl',{DEEPL_API_KEY:'fixture'},fake),/target supported/);
 await assert.rejects(()=>translate('x','en','fr','deepl',{DEEPL_API_KEY:'fixture'},async()=>json({},456)),/quota is exhausted/);
 await assert.rejects(()=>translate('x','en','fr','deepl',{},fake),/DEEPL_API_KEY/);
 await assert.rejects(()=>translate('x'.repeat(128*1024),'en','fr','deepl',{DEEPL_API_KEY:'fixture'},fake),/128 KiB/);
});

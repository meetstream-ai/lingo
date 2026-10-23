# Lingo quickstart

This guide starts a sample first, then connects a real meeting. You need **Node.js 24+**, npm and Git. A live meeting also needs a MeetStream account, a speech provider configured there, a text translation account, and a public HTTPS URL for callbacks.

## 1. Start the app

```sh
git clone https://github.com/meetstream-ai/lingo.git
cd lingo
npm start
```

For an existing checkout or extracted starter kit, open that directory and run only `npm start`. It creates `.env` if missing, installs missing dependencies and starts the app. Open **http://localhost:3000**, enter the workspace, then try **Start sample**. The sample uses prerecorded text fixtures, not a real meeting or speech API.

Keep this terminal running. To stop, press **Ctrl+C** in it, or use `npm stop` in another terminal in the project directory. On macOS, Command+C copies text; **Control+C** stops the process. Restart after changing `.env`:

```sh
npm stop
npm start
```

## 2. Configure a live workspace

Stop the app. Open the generated `.env` in your editor and fill these values with **your own** credentials:

```dotenv
APP_PASSWORD=replace-with-your-private-workspace-password
SESSION_SECRET=replace-with-a-random-secret-at-least-32-characters
MEETSTREAM_API_KEY=replace-with-your-meetstream-api-key
GOOGLE_TRANSLATE_API_KEY=replace-with-your-google-translation-api-key
NGROK_AUTHTOKEN=replace-with-your-ngrok-auth-token
NGROK_ENABLED=auto
```

Do not paste these placeholders unchanged. Generate a session secret using your password manager or `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`. Use a strong private password; hosted production requires at least 12 characters. Never commit `.env`.

Google is one translator option. Instead, configure Azure Translator, JigsawStack text translation or DeepL using `.env.example`. Google Translation needs the Cloud Translation API enabled, suitable key restrictions, billing and quota. DeepL's adapter does not expose Hindi or Tamil targets.

Run `npm start` again. With an ngrok token, the launcher starts both the tunnel and app, saves its HTTPS URL as `PUBLIC_ORIGIN`, and prints the public workspace and webhook URL. No separate ngrok terminal or CLI command is needed. The computer and app must stay running.

Sign in using your **`APP_PASSWORD` from `.env`**, not a MeetStream account password. Open **Connections** to save or test credentials in the browser. Browser-saved settings take precedence over `.env` for the same fields; update the value in Connections when changing an already saved credential. An empty password permits a local sample but disables editing connections in the browser.

### Configure speech in MeetStream

In [app.meetstream.ai](https://app.meetstream.ai), configure Deepgram, AssemblyAI or JigsawStack under the workspace associated with your `MEETSTREAM_API_KEY`. You do **not** need a separate local Deepgram key. A JigsawStack text key saved in Lingo is separate from the JigsawStack speech connection managed by MeetStream.

For Hindi → English or Tamil → Hindi, a practical starting combination is Deepgram speech with a fixed spoken language and Google text translation, provided your accounts support those languages. AssemblyAI live here is English-only. JigsawStack live here supports Google Meet only. A saved key does not prove permission or remaining quota; test the connections and inspect meeting errors.

### Callback URLs and the optional webhook secret

Per-bot callbacks are configured automatically from `PUBLIC_ORIGIN` and use a generated path token. You do not need to invent a signing secret for them.

The separate workspace lifecycle webhook is optional. If you configure it in MeetStream, enter:

```text
https://YOUR-PUBLIC-HOST/webhooks/meetstream
```

Use the actual public host printed at startup, not localhost. Save the signing secret associated with that endpoint as `MEETSTREAM_WEBHOOK_SECRET` and restart. Do not substitute an API key for the signing secret. If your public host changes, update the registered endpoint. Provider webhook setup is documented at [docs.meetstream.ai](https://docs.meetstream.ai).

## 3. Install the Chrome extension

1. Open **http://localhost:3000/extension-guide.html** for the full guide. Load the checkout's `extension/` folder, or download `/extension.zip` from the running app and extract it.
2. In Chrome open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the `extension` directory containing `manifest.json`. Pin **Lingo** to the toolbar.
3. Open your Lingo workspace and sign in. In the popup, enter that same workspace URL and choose **Connect open workspace**. Grant Chrome access to that host when prompted. Authorization lasts 24 hours.
4. Join a Google Meet, Zoom web or Teams web call. Open Lingo **on the meeting tab**, select the spoken language, speech provider, text translator and caption languages, then choose **Start captions**. If needed, paste the original invitation URL, not a homepage or generic Teams app URL.
5. Admit the visible bot. Show/move the overlay and check the provider labels. Caption language can change during the call. Spoken-language changes use **Restart captions in new language** with supported providers; expect a gap and possible re-admission.
6. Choose **End recording and open summary**. Wait for final processing, then inspect Transcript, Recordings and Summary. The automatic summary is an excerpt overview; optional AI summarization is explicitly requested. Export or share only the artifacts you intend to disclose.

After an update, reload the unpacked extension in Chrome and refresh your meeting tab. The popup header shows its version. The extension needs this backend running; it does not independently transcribe browser audio.

## 4. Optional translated audio and sharing

**Audio:** Enable Google Cloud Text-to-Speech API and billing. Allow that API on your key, save `GOOGLE_TTS_API_KEY` (or allow it on your existing translation key), then test **Google speech** in Connections. Press **Listen** on translated captions or summaries. A matching installed device voice is the fallback; install Hindi/Tamil voices in your operating system if needed.

**Sharing:** Connections supports Google Drive, Slack, Discord and Gmail drafts. Configure only what you need; OAuth scopes and required values appear on each card. Save/export locally without those accounts. Gmail creates a draft and does not send email. Google Calendar naming uses a separate read-only connection.

## Troubleshooting

| Problem | What to check |
| --- | --- |
| Node/SQLite/CRC32 startup error | `node --version` must be 24 or newer; restart your terminal after installing Node. |
| Port 3000 already in use | Run `npm stop` in this checkout. If another app owns it, stop that app or change `PORT` in `.env`. |
| Workspace password unknown | Read your private `.env` value `APP_PASSWORD`. The tunnel launcher generates one when missing. |
| Browser rejects connection editing | Configure `APP_PASSWORD`, restart and sign in. |
| MeetStream speech 401/403 | Verify the API key and speech integration belong to the same workspace, with valid provider credentials and quota. |
| Translator fails or is unavailable | Test its card, check API/billing/quota, and choose languages in that adapter's catalog. |
| Invitation rejected | Use a real invitation. Zoom `/my/` needs the numeric room invitation; Teams home/app/chat URLs need the original meeting link. |
| Bot joins but no captions | Check its admission, microphone audio, meeting status, fixed source language, provider access and public callback reachability. |
| Overlay absent/stale | Reload the updated extension and meeting tab, reconnect the same workspace, then select/start that room. |
| Summary/transcript pending | End recording and allow final transcript and translation jobs to finish. Inspect failed jobs and provider errors; no speech means no text to summarize. |
| Settings appear to ignore `.env` | A browser-saved connection value overrides the same environment field. Update it in Connections. Leaving a secret field blank keeps the saved value; Disconnect disables the connection. |

## Host it instead

See [HOSTING.md](docs/HOSTING.md). Deploy the Node service with HTTPS and a persistent data volume, one replica, strong credentials and ngrok disabled. Hosting keeps it available without your laptop; API usage still has its own costs. Test a real call and restart persistence before relying on the deployment.

Return to the [README](README.md) for architecture, tests, limits and contribution guidance.

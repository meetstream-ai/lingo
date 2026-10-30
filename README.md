# Lingo

Live translated captions and a searchable meeting workspace, powered by [MeetStream](https://meetstream.ai). Follow Google Meet, Zoom web and Microsoft Teams web in another language, then keep the speaker-attributed transcript, recording and post-call overview.

**[Quickstart](QUICKSTART.md)** · **[Hosting](docs/HOSTING.md)** · **[Project repository](https://github.com/meetstream-ai/lingo)** · **[Report an issue](https://github.com/meetstream-ai/lingo/issues)**

## Run locally

Install **Node.js 24 or newer** (including npm) and Git, then:

```sh
git clone https://github.com/meetstream-ai/lingo.git
cd lingo
npm start
```

Open **http://localhost:3000**. The launcher creates `.env` from `.env.example`, installs missing dependencies from the lockfile, packages the extension and starts the server. Try the built-in Hindi/Tamil sample without provider accounts. The terminal and computer must stay running for local use; VS Code is optional.

Stop with **Ctrl+C** in the launching terminal, or run `npm stop` from another terminal in the same checkout. Starting twice reports the existing instance. If another application owns the port, stop that application or change `PORT` in `.env`.

For live meetings, configure your credentials and a public HTTPS callback URL first. See [the full quickstart](QUICKSTART.md), including extension installation and troubleshooting. No API keys, meeting data or shared default password are included.

## What you get

- A meeting library with titles, search, pagination, browser Back/Forward navigation and links to individual meeting sections.
- Live captions in the web app and a movable Chrome overlay, with speaker names and separate speech/translation provider labels.
- Original and translated transcripts, up to eight output languages per recording, and caption-language changes during a call.
- Spoken-language changes through a linked recording restart for supported providers. There is a caption gap and the host may need to admit the replacement bot.
- Recordings, notes, action items and an automatic excerpt overview after the final transcript and translations are ready. Optional JigsawStack AI summaries are a separate, explicit action.
- Optional translated audio through Google Cloud Text-to-Speech, with matching installed device voices as a fallback.
- VTT, SRT, HTML, Markdown, text and JSON exports; print-to-PDF, recording downloads and portable meeting archives. Filenames include the meeting name and timestamp.
- Optional Google Drive uploads, Slack and Discord sharing, Gmail drafts, and read-only Google Calendar naming. Sharing is user initiated; Gmail drafts are not sent automatically.

## Providers and credentials

Speech recognition and text translation are different services. A configured speech key does not automatically configure the translator.

| Role | Supported choices | Where to configure |
| --- | --- | --- |
| Meeting bot | MeetStream | `MEETSTREAM_API_KEY` in `.env` or Connections |
| Live/post-call speech | MeetStream, Deepgram, AssemblyAI, JigsawStack | The **same MeetStream workspace** as your API key; choose providers in Lingo |
| Text translation | Google Cloud Translation, Azure Translator, JigsawStack, DeepL | Lingo Connections or the corresponding variable in `.env.example` |
| Translated audio | Google Cloud Text-to-Speech, matching device voices | Optional `GOOGLE_TTS_API_KEY`; otherwise the Google translation key is tried |
| AI summary | JigsawStack | Optional `JIGSAWSTACK_API_KEY` in Lingo |

The UI limits choices to each adapter's language catalog. DeepL currently exposes a conservative 32-code subset; use Google, Azure or JigsawStack for Hindi/Tamil targets. AssemblyAI live through this integration is English-only; JigsawStack live is Google Meet-only. Deepgram live needs a fixed spoken language. Native MeetStream live uses automatic recognition. See the [provider/link audit](docs/AUDIT-2026-10-23.md) for details.

Provider accounts, billing, quota and meeting admission are your responsibility. Self-hosting this open-source app does not make speech or translation APIs free.

## How it works

1. A visible MeetStream bot joins the invitation and receives meeting audio after admission.
2. The selected speech provider sends speaker-attributed turns to the Node backend through per-bot callbacks.
3. The backend stores originals and translation jobs in SQLite, translates each turn and serves captions.
4. The web app receives updates; the extension polls for captions every 1.5 seconds. This interval adds delay beyond recognition, translation and network time.
5. After recording ends, the worker retrieves final transcripts and recordings, completes translations and saves excerpt overviews.

The extension does not record your microphone or scrape meeting captions. It needs a running Lingo backend; installing the extension alone is insufficient. Credentials stay on the server. Workspace extension grants expire after 24 hours and can be revoked in Connections.

## Supported invitations

Google Meet invitation and `/meet/` call URLs, numeric Zoom invitations and web join/start URLs, and Teams numeric or encoded `meetup-join` invitations are supported. Teams business cloud redirects are recognized. Generic homepages and Teams app/chat URLs cannot identify a room. For Zoom personal `/my/` rooms, use the numeric invitation from meeting details. Desktop Zoom/Teams apps cannot host the Chrome overlay; use the web app captions separately.

## Configuration and data

`.env.example` lists supported environment variables without secrets. Set `APP_PASSWORD` to protect the workspace and enable browser connection editing. Public tunneling requires a password and session secret; the launcher generates missing values in your private `.env`. Read your password there when signing in. Environment changes require a restart.

SQLite defaults to `data/meetings.sqlite`; browser-saved credentials live in `data/connections.json` with restricted file permissions. These files contain sensitive data and must not be committed. Protect the data directory and backups. Use a SQLite online backup or stop the app before copying database files; copying the main file alone during writes can lose WAL data.

## Hosting

Deploy the **Node backend**, not just `public/`. Use Node 24+, one process/replica, persistent writable storage, HTTPS, and `NODE_ENV=production`. Set a strong workspace password (12+ characters), session secret (32+), `HOST=0.0.0.0`, `PUBLIC_ORIGIN`, and `DATABASE_PATH` on the persistent volume. Disable ngrok on hosted deployments.

The [hosting guide](docs/HOSTING.md), [environment template](deploy/railway.env.example), Dockerfile and Compose example explain deployment. Free services that sleep or discard local storage cannot reliably retain this SQLite workspace. Run `npm run check:hosting` in the deployed environment and test a real call before relying on it. `/healthz` is the health endpoint.

## Development and verification

```sh
npm ci
npm test
npx playwright install --with-deps chromium firefox webkit
npm run test:e2e
npm run build
```

`npm run dev` watches the backend without managing ngrok. `npm run benchmark -- --demo` exercises sample translation measurements. `npm run build` checks JavaScript syntax, creates extension/source ZIPs, and produces a runnable `dist/` source distribution. Generated downloads are available at `/extension.zip` and `/starter-kit.zip` while the server runs. Do not edit generated files.

Automated tests use controlled fixtures. They do not prove real speech quality, external account permissions or vendor bot admission. The latest audit recorded 82 backend and 75 browser passes, with 12 intentional non-Chromium extension skips; see [verification limits](docs/AUDIT-2026-10-23.md). Live language-pair quality and end-to-end latency need real-call acceptance. Production readiness is not claimed merely because tests pass.

## Repository layout

| Path | Purpose |
| --- | --- |
| `server/` | API, authentication, callbacks, SQLite jobs and provider adapters |
| `public/` | Homepage, workspace and setup guides |
| `extension/` | Chrome Manifest V3 popup, room matching and caption overlay |
| `scripts/` | Startup/stop, packaging, build, hosting checks and diagnostics |
| `test/` | Backend and isolated browser/extension tests |
| `docs/` | Hosting, acceptance evidence, reference material and roadmap |
| `deploy/` | Hosting environment examples |

Existing EveryVoice/Lingua browser storage identifiers remain internally compatible after the Lingo rename. Historical reports retain the names and versions used when their observations were recorded.

## Contributing

Use [meetstream-ai/lingo](https://github.com/meetstream-ai/lingo) for issues and pull requests. Include reproduction steps, expected/actual behavior and sanitized errors. Never include API keys, passwords, signed recording URLs or private meeting transcripts. Keep provider limitations explicit and add focused regression coverage for behavior changes.

## License

[MIT](LICENSE). Lingo's artwork is original to this project; MeetStream and other provider names identify integrations, not a corporate logo endorsement.

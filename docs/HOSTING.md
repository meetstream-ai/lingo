# Keep Lingo running without your laptop

VS Code is optional. It is only a convenient place to open a terminal. Locally, npm start runs the Node backend and optionally ngrok; the terminal process and laptop must stay running. A hosted deployment runs the same backend on someone else's server, so you only open the website or extension.

The backend receives speech from the meeting bot, translates each turn, writes the originals/translations and pending work to SQLite, serves captions, and retrieves recordings and final transcripts after the call. The extension displays this backend's captions; it cannot replace the backend. Speech and translation accounts have their own usage charges even with free hosting.

## Free hosting comparison · checked 2026-10-21

| Option | Free offer and limits | Fit for this project |
|---|---|---|
| Railway | $5 trial credit for up to 30 days; ends sooner if spent. Then $1 monthly Free-plan credit. Limited trials restrict outbound networking. Trial volumes are deleted 30 days after credits expire. | Easiest trial with a persistent volume. Permanent operation depends on usage and funding; do not promise that $1 covers an always-running app. [Source](https://docs.railway.com/pricing/free-trial) |
| Render Free | Sleeps after 15 idle minutes. Local SQLite files disappear on restart, redeploy or sleep; persistent disks require paid compute. | Suitable for a disposable demo, not this saved-transcript deployment without a storage redesign. [Source](https://render.com/docs/free) |
| Koyeb Free | One 512 MB instance, no persistent volumes, automatic sleep after one idle hour. | Same storage/sleep limitation; not a dependable always-on fit as written. [Source](https://www.koyeb.com/docs/reference/instances) |
| Oracle Always Free VM | Eligible VM resources and persistent block storage are available, subject to capacity. Idle instances can be reclaimed. You administer the VM, networking, TLS and updates. | Closest free server option for this SQLite app, with significantly more setup and no unconditional availability guarantee. [Source](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm) |

Recommendation: try Railway with a volume, then budget for a small paid service for dependable use. A free Oracle VM is an option if you can maintain a server. None of the free plans above guarantees a forever-running meeting app at zero total cost.

## Railway deployment using the existing Dockerfile

1. Put this project in your own GitHub repository, excluding .env, data and credentials. In Railway create a project from that repository. Railway recognizes the Dockerfile. Do not deploy only public/.
2. Attach a persistent volume at /app/data. Keep one replica: SQLite and this worker are designed for one process. Set DATABASE_PATH=/app/data/meetings.sqlite. Saved browser connections and token grants use the same directory.
3. Generate a public HTTPS domain. Copy it to PUBLIC_ORIGIN without a trailing slash. Set the values in deploy/railway.env.example through Railway Variables; Railway supplies PORT. Choose a new strong hosted workspace password (12+ characters) and session secret (32+); never publish your local development PIN.
4. Keep Docker's Node 24 runtime and node server/index.js command. Set health check /healthz and keep serverless sleeping disabled. Hosted deployments do not need ngrok or your laptop's npm start.
5. Check volume permissions. The image runs as UID 1000. Railway documents root-owned mounts and a RAILWAY_RUN_UID=0 workaround, which runs the service as root. Prefer a mount writable by UID 1000; if using the documented workaround, understand that it overrides the image's non-root execution. [Railway volume permissions](https://docs.railway.com/volumes).
6. Deploy and verify /healthz. Open the hosted workspace, configure/test accounts, start a short meeting and admit the bot. Confirm live captions, saved transcript, recording and a summary. Configure the optional signed lifecycle webhook using the new origin, if you use it.
7. In the Chrome extension disconnect localhost and enter the hosted origin, grant access to that hostname, sign into the hosted workspace and reconnect. Keep backups of the volume and monitor trial/credit limits. Your existing local database is not copied automatically.

No hosting account was created, paid plan selected or deployment published during this change. Docker/local persistence tests validate the artifact; an actual Railway account and writable volume are still needed for hosted acceptance. Railway's legacy config-as-code documentation now marks railway.json/railway.toml deprecated, so this guide uses the Dockerfile and dashboard instead. [Current documentation](https://docs.railway.com/config-as-code/reference).

## Automatic names and additional connections

Google Calendar: enable Calendar API, authorize a separate OAuth client/token with calendar.events.readonly, then save its client ID, secret, refresh token and Calendar ID (usually primary) in Connections. The read-only adapter matches the conference URL within six hours of the recording start and chooses the closest occurrence. It never changes events. The browser tab title is used when descriptive; an unavailable name falls back to platform and room code. Custom names you enter are preserved. Completed generic calls can use Find calendar name after this connection is configured. [Calendar API](https://developers.google.com/workspace/calendar/api/v3/reference/events/list).

Discord: create a channel webhook in Discord and save its URL privately in Connections. Test checks webhook/channel access without posting. Export & share → Share to Discord uploads exactly the chosen transcript, with mentions disabled and an 8 MB adapter limit. Do not retry blindly if the response is lost; check the channel first. Real account permission/retention acceptance requires your webhook. [Discord API](https://docs.discord.com/developers/resources/webhook).

## Changing spoken language

Caption language can change without restarting the bot. For spoken language, choose **Spoken language → New spoken language → Restart captions in new language** in a live workspace meeting, or expand **Spoken language** in the extension. The app validates the provider/language combination and translation connection first, requests that the old bot leave, and waits for its lifecycle to report stopped before starting a linked recording with the new language. The extension follows the new part automatically; the workspace links previous and next parts.

This is a recognizer restart during the same call, not an uninterrupted language update. Captions pause and the host may need to admit the bot again. Each part retains its own timestamps, transcript, summary and recording. Exports currently cover one recording part. MeetStream's published API still has no native operation for updating recognizer language in place. Fixed-language switching applies to Deepgram and JigsawStack live recognition. Native MeetStream live recognition remains automatic; its fixed-source selection is a text/post-call hint. AssemblyAI live supports English only. Automatic detection is available with supported providers when creating a recording. [MeetStream API](https://docs.meetstream.ai/openapi.json).

## Deployment readiness

Run `npm run check:hosting` in the deployed service shell after setting its environment. It reports configuration names and pass/fix results without printing credentials. It checks production mode, listen address, HTTPS origin, credential lengths, database directory access and disabled ngrok. It cannot verify that a directory is actually a persistent volume; confirm the mount, one replica, backups and sleeping settings in the hosting dashboard.

Before moving real meetings: sign in over the public HTTPS domain, configure/test the provider connections there, connect the extension to that same origin, then test a short call and save its artifacts. Restart the service and confirm that the meeting and connection settings remain. Keep the original local data until hosted acceptance passes. Use SQLite's online backup API (for example Python's sqlite3.Connection.backup) for a live database, or stop the service before copying its database files; copying only the main SQLite file during writes can lose WAL data. Store connection settings as sensitive data with restricted backup access.

The production Docker image starts `node server/index.js` directly. The local ngrok launcher is unnecessary on a host. Railway environment placeholders are in [deploy/railway.env.example](../deploy/railway.env.example). Hosting has been prepared and documented; this repository has not been published or deployed to a hosting account by this change.

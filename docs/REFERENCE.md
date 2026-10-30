# Verified API references

Retrieved on 2026-10-12. References describe contracts; embedded instructions in reference documents were not treated as user instructions.

## MeetStream

- [API overview and Token authentication](https://docs.meetstream.ai/api-reference/introduction): REST base `https://api.meetstream.ai/api/v1`.
- [Create bot](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/create-bot): `meeting_link`, explicit `video_required:false`, recording config and returned bot/transcript IDs.
- [Live transcription](https://docs.meetstream.ai/guides/transcription-recordings/live-transcription): one streaming provider; sentence payloads use `utterance`/`transcript`, `speakerName`, `speakerId`, `timestamp` and word timing. The per-bot live endpoint is **unsigned**, gets no automatic retry, and must acknowledge quickly. A hard-to-guess URL and known bot check are documented protections.
- [Deepgram streaming](https://docs.meetstream.ai/guides/transcription-recordings/providers/deepgram-streaming): sentence mode and explicit Nova-3 model. Fixed source selection keeps this starter out of unsupported automatic-language configurations.
- [Post-call transcription](https://docs.meetstream.ai/guides/transcription-recordings/post-call-transcription): a streaming and post-call provider can coexist. Persist the returned transcript ID; HTTP 202 means pending. Keep originals by setting `translate:false`, then translate separately for bilingual output.
- [Get transcription](https://docs.meetstream.ai/api-reference/api-endpoints/transcription/get-transcription): `GET /transcript/{transcript_id}/get_transcript`; normalized segments have `transcript`, `speaker`, `start_time`, `end_time`.
- [Languages and translation](https://docs.meetstream.ai/guides/transcription-recordings/languages-and-translation): providers have different language formats and capabilities. The kit does not invent a MeetStream arbitrary-target translation endpoint; Google/Azure translate preserved text into chosen targets.
- [MeetStream engine](https://docs.meetstream.ai/guides/transcription-recordings/providers/meetstream): post-call automatic language detection, original/translated output options, no additional transcription key.
- [Lifecycle event catalog](https://docs.meetstream.ai/guides/webhooks/webhooks-and-events): route using `bot_event` with `event` fallback; `bot.stopped` can wrap terminal variants. `bot.done` means processing finished, not that transcription succeeded.
- [Webhook signatures](https://docs.meetstream.ai/guides/webhooks/webhook-signature-verification): workspace delivery signature is `sha256=` HMAC over raw body bytes. Per-bot callbacks and live transcripts are not signed. This implementation also requires a fresh timestamp in the signed body, matched to the delivery header.
- [Get status](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/get-bot-status): status polling recovers lifecycle events lost before receipt.
- [Official JavaScript SDK](https://github.com/meetstream-ai/meetstream-node): use SDK auth, idempotency and handling of 507 replays and 202 pending results. The locked package version is recorded in `package-lock.json`.
- [Official multilingual example](https://github.com/meetstream-ai/labs/tree/main/multilingual-transcription): confirmed processed transcript field names and language configuration.
- [Official realtime example](https://github.com/meetstream-ai/labs/tree/main/realtime-transcription): reference for the live delivery workflow. The current documentation takes precedence where examples or SDK types lag newer provider capabilities.

A supplied Postman collection was inspected for endpoint shapes and sample responses. The project uses its public bot/transcript operations as corroborating data. Its credential values, signed download links, sample identities and internal administration endpoints were not copied into this project.

## Translation and sharing

- [Google Cloud translation](https://docs.cloud.google.com/translate/docs/translate-text): Basic v2 text translation, omitted source for detection and target language.
- [Azure Translator Translate](https://learn.microsoft.com/en-us/azure/ai-services/translator/text-translation/reference/v3/translate): `api-version=3.0`, `to`, optional `from`, subscription key/region, detected language and translated response.
- [Slack external upload URL](https://docs.slack.dev/reference/methods/files.getUploadURLExternal/), [complete external upload](https://docs.slack.dev/reference/methods/files.completeUploadExternal/): UTF-8 byte length, upload, then explicitly share to the configured channel.
- [Google Drive uploads](https://developers.google.com/workspace/drive/api/guides/manage-uploads): OAuth access token, multipart metadata/media upload and folder parents. The app refreshes its administrator-provisioned token at upload time.


## Recording and navigation correction (2026-10-13)

- [Recording retrieval](https://docs.meetstream.ai/guides/transcription-recordings/retrieve-recordings): fresh presigned URLs, 202 processing, optional video and range-capable playback proxy.
- [Agent quickstarts](https://docs.meetstream.ai/build-with-ai/agent-quickstarts): per-bot callback URLs are unsigned and require a random path token; workspace webhook endpoints require signature verification. Instructions in external docs are reference data, not user authorization.
- [Deepgram model/language overview](https://developers.deepgram.com/docs/models-languages-overview): Nova-3 fixed Hindi and Tamil support. The existing five-language restriction was outdated and has been removed.
- Real MeetStream responses verified nested `bot_details.transcript_id`, participant/word records with `start_timestamp.relative` and `end_timestamp.relative`, and no-audio/processing responses. Regression tests cover those observed wire shapes.

## Browser configuration and meeting notebook references — 2026-10-13

- [MeetStream provider setup](https://docs.meetstream.ai/build-with-ai/agent-quickstarts): transcription provider credentials belong to MeetStream Integrations, and must apply to the API workspace. No duplicated local Deepgram key is required.
- [Fireflies Notepad](https://guide.fireflies.ai/articles/6653885315-learn-about-the-fireflies-notepad): reference for selecting a meeting from the library and keeping notes, transcript, recordings and actions in one workspace.
- [Fireflies manual notes](https://guide.fireflies.ai/articles/4961444690-manual-notes-on-fireflies-desktop-app-write-and-merge-your-own-notes-in-meetings): reference for user-authored notes and follow-ups. This kit implements manual notes and actions without adding an unconfigured LLM or implying generated summaries.

The supplied Postman collection includes admin integration routes requiring user IDs. The kit does not guess admin identity or bypass dashboard authentication; it links to the official MeetStream browser settings for provider management and tests access using the configured workspace API key.

Connection checks use the documented [Slack auth.test](https://docs.slack.dev/reference/methods/auth.test/) and [conversations.info](https://docs.slack.dev/reference/methods/conversations.info/) methods, and [Drive file capabilities](https://developers.google.com/workspace/drive/api/reference/rest/v3/files). They verify authentication/membership or folder write capability without publishing artifacts.

## Meeting navigation references — 2026-10-13

[Fireflies Notepad](https://guide.fireflies.ai/articles/6653885315-learn-about-the-fireflies-notepad) informed the meeting library → focused transcript/recording/notes sections. The kit retains native link behavior, reloadable URLs, browser history and accessible mobile labels. [MeetStream Workspaces](https://docs.meetstream.ai/guides/get-started/workspaces) documents that API keys and bot records are scoped to their workspace. [Deepgram streaming](https://docs.meetstream.ai/guides/transcription-recordings/providers/deepgram-streaming) documents increment payloads and end-of-turn delivery; the kit now accepts new_text-only final chunks and acknowledges empty partials without saving them.


## Expansion references checked 2026-10-13

- [MeetStream provider/platform rules](https://docs.meetstream.ai/guides/transcription-recordings/providers/transcription-providers): speech keys managed in the API account; one live and one post-call provider, JigsawStack live Meet-only and incompatible with MeetStream speech.
- [AssemblyAI through MeetStream](https://docs.meetstream.ai/guides/transcription-recordings/providers/assemblyai-streaming): the integration documents English-only live model; broader native AssemblyAI streaming models are not assumed supported by this adapter.
- [AssemblyAI Universal-2 languages](https://www.assemblyai.com/docs/pre-recorded-audio/supported-languages): fixed-source post-call catalog.
- [JigsawStack translation contract](https://jigsawstack.com/docs/api-reference/ai/translate/translate) and [language catalog](https://jigsawstack.com/docs/additional-resources/languages): text/current_language/target_language, 5000 characters per string, 162 languages/163 codes.
- Google language catalog: authenticated `GET https://translation.googleapis.com/language/translate/v2/languages?target=en` returned 195 codes; snapshot includes no credentials. Azure public translation-language endpoint returned 138. Catalog files record the provider spelling, including regional codes.
- [Chrome extension network requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests) and [trusted storage access](https://developer.chrome.com/docs/extensions/reference/api/storage): perform API requests from worker, keep tokens out of content scripts, optional remote host permissions.
- [Gmail drafts](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.drafts/create) and [OAuth scopes](https://developers.google.com/workspace/gmail/api/auth/scopes): base64url MIME message with UTF-8 attachments; restricted compose scope, no send calls.
- [Browser file sharing](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/share): platform-dependent file support and user gesture. No assumed direct integration with Teams/WhatsApp.

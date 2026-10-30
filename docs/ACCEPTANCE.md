# Real-call acceptance checklist

Automated fixtures verify application behavior, not real account permissions, speech quality, vendor bot admission or speech-to-visible latency. Run this checklist privately on your deployment. Do not commit meeting invitations, names, transcripts, recordings, screenshots or raw results.

## Prepare

1. Follow [QUICKSTART.md](../QUICKSTART.md). Test the MeetStream and text translation connections; configure speech credentials in the same MeetStream workspace as the API key.
2. Use a dedicated test call with participants who consent to recording and translation. Confirm the provider supports the spoken languages. For Deepgram, choose a fixed source language; test Hindi → English and Tamil → Hindi in separate recordings or through the supported recognizer restart.
3. Keep the public callback URL and server running. Admit the visible bot and verify the actual speech and translation provider labels in Lingo.

## Check live behavior

- Read the synthetic examples in `test/fixtures/language-pairs.json`, then try natural conversation, speaker changes and overlapping speech. Verify originals, translations and speaker labels; document omissions and mistakes honestly.
- Use the website and extension on the matching meeting tab. Change caption language, move the overlay, test keyboard access and check readable text on a narrow screen.
- Test a supported spoken-language restart. Confirm the old recording stops, the replacement is admitted, the extension follows it and earlier artifacts remain. Measure the interruption; this is not seamless switching.
- Briefly disconnect the viewer and reconnect. Stored turns should return. Loss of server callback connectivity has different recovery limits and must be recorded separately.
- Have a fluent reviewer score translation meaning and terminology for both required pairs. Measure speech-to-visible delay with synchronized observations; API request duration alone is not that measurement.

## Check post-call behavior

- End recording and wait for final transcription and translations. Review Transcript, Recordings and Summary. Excerpt overviews should be identified as such; optional AI summaries require their own configured service.
- Compare live and final text. Check speaker names, Unicode and subtitle timing against the recording, including transcript-relative timestamp offsets.
- Export VTT, SRT, HTML, Markdown, text and JSON. Check filenames, original-only export when translation fails, notebook/actions and portable archives. Inspect print output.
- Test optional sharing only to a private destination with explicit participant consent. Verify Gmail creates a draft without sending it.
- Restart the service and verify persistence. On hosted services, confirm an actual persistent volume, one replica, backups and HTTPS, then reconnect the extension to that origin.

## Record the outcome privately

Record provider/model, language pair, permissions, sample size, reviewer results, observed latency, errors and unresolved limits. Keep raw evidence in ignored local storage or an access-controlled location. A passing synthetic suite is not a production certification.

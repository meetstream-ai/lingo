# Lingua 1.6 verification

2026-10-21

The product is renamed to Lingua throughout the current website, workspace, extension, package metadata and user-facing guides. Historical reports retain their original names. Persistent database locations, browser preference keys, runtime ownership markers and existing extension authorization storage remain compatible.

UI refinement preserves the incumbent design: compact homepage spacing, larger small text, consistent provider context, shared dialog spacing, explicit recording-part navigation and a mobile notification offset above bottom navigation. Impeccable's detector was run once; actionable small-text and spacing findings were fixed and the affected paths were rendered and tested again. The detector's translated-column padding warning is a false positive at the responsive divider: desktop has 36px left padding and narrow layouts use 17px top padding. SVG branding's secondary lettering remains part of the graphic with a textual accessible name.

Validation:

- `npm test`: 77 passing backend tests, including source-switch preflight, stop confirmation, duplicate prevention, cancellation and native-provider limits.
- Full browser run: 81 cases, 10 intentional Chrome-extension skips outside Chromium. All affected failures were fixed and rerun: cross-browser recording/layout, provider clarity and spoken-language tests pass. Across the full run plus the targeted recheck, 71 applicable cases pass.
- Actual unpacked MV3 extension loaded in an isolated Chromium profile: recognizer restart follows its server-issued continuation, next-part captions appear, and another room remains unchanged. Meet URLs in these tests serve controlled HTML fixtures; no real participants or paid meeting bots are involved.
- Automated accessibility checks cover homepage, workspace/provider views, language-switch dialog and extension. Desktop/mobile renders were inspected.
- `npm run build`: JavaScript syntax checks and portable source/extension ZIP creation pass. Private .env, databases, recordings and connection settings are excluded from distribution.
- Docker daemon was unavailable on this machine. This release has not had a fresh container smoke test or a real hosted deployment.

The language workflow is an interrupted recognizer restart, not an in-place API update. Fixed live-language switching is available for Deepgram and JigsawStack. MeetStream native live speech detects automatically; AssemblyAI live is English-only. Earlier recording parts preserve separate timestamps and artifacts. Real Hindi-to-Tamil switching, bot re-admission, gap measurement and provider output quality still need a real-call acceptance test.

Hosting options and their current limits were checked against primary vendor documentation. The Railway guide and environment template use an HTTPS origin, a persistent volume, one replica, sleeping disabled and strong hosted credentials. `npm run check:hosting` checks configuration and writable database-directory access without printing secrets. It does not prove persistence, live provider access or hosted meeting behavior. A hosting account, repository/source upload and service provisioning remain necessary.

Post-call summary follow-up: completed final transcripts now save excerpt overviews automatically, including without an open browser. Ready target languages are saved independently; pending translations do not block other languages. Opening an older completed meeting fills missing overviews without provider calls. Current AI summaries are retained. Summary UI checks pass in Chromium, Firefox and WebKit; the extension connection check passes in Chromium (two platform skips).

## 1.6.1 invitation compatibility · 2026-10-22

Diagnosed against the actual Chrome call URL: Google Meet uses `/meet/<code>` in the active call, with `/<code>` as its shareable invitation. The shared server/extension room parser accepts both and core meeting validation normalizes the bot invitation. Popup controls distinguish a supported call tab from a homepage, and malformed legacy records are skipped during room reuse. A loaded MV3 fixture exercises the active-call URL, canonical navigation, overlay binding, room reuse and homepage guidance. Reload the installed extension to activate this change. No real paid bot was started for this regression test.

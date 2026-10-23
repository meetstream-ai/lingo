# Lingo improvement scope

Updated 2026-10-21. This describes implementation and acceptance separately; it is not a production certification.

## Included in 1.7

- Optional DeepL text adapter with a conservative verified catalog; shared Google Meet/Zoom/Teams URL validation, cloud/legacy Teams matching and clearer provider/extension state. See [the audit report](AUDIT-2026-10-23.md).

## Included in 1.6

- Automatic post-call excerpt overviews in each ready target language. They are saved from the final transcript, appear in Summary without a Generate click, and preserve current manually generated AI summaries. Older completed meetings receive missing overviews when opened.

- Lingo product name in website, workspace, extension, guides and package metadata. Existing data and browser settings remain compatible.
- Compact homepage, consistent provider context, aligned labeled controls, keyboard focus and clearer recording-part navigation.
- Spoken-language switching during a call through a confirmed, durable bot restart. Validate before stopping, wait for the old bot to stop, prevent duplicate continuations and preserve earlier artifacts. The workspace links parts and the extension follows them automatically.
- Hosted deployment instructions, Docker image, Railway environment template and a configuration readiness command. SQLite requires persistent storage and a single service replica.

## Acceptance still needed in a real environment

| Priority | Scope | Acceptance |
|---|---|---|
| P1 | Hosted deployment | Public HTTPS, writable persistent volume, successful restart preserving meetings/connections, extension connected to hosted origin. |
| P1 | Spoken-language restart | Host admits bot after Hindi → Tamil switch in a real call; new captions reflect Tamil, old Hindi transcript/media remain, measured gap recorded. Automated fixtures exercise orchestration; they cannot prove provider behavior or host permissions. |
| P1 | Current provider accounts | Run configured account checks and short speech tests on the deployment; quotas, expired keys and workspace integration permissions are external dependencies. |
| P1 | Hindi → English and Tamil → Hindi quality | Record observed end-to-end latency and human-reviewed translation quality on real audio. Synthetic tests are not a quality measurement. |

## Next improvements

| Priority | Scope | Expected result |
|---|---|---|
| P1 | Access control for public use | Individual accounts, workspace roles, per-user OAuth connections and transcript visibility rules instead of one shared administrator password. |
| P1 | Retention and backup operations | Scheduled encrypted backups, restore drills, deletion controls and clear recording-expiry notices. |
| P2 | Combined multi-part artifacts | A meeting-level view and export with explicit part boundaries, correct timestamps and provenance across recognizer restarts. Current exports and summaries cover one part. |
| P2 | Onboarding | Hosted-workspace setup checks, provider capability explanations and recovery hints in one guided flow. |
| P2 | Provider resilience | Opt-in failover with visible provider changes, quota alerts and reviewable cost limits; never silently switch to a billable provider. |
| P2 | Extension distribution | Chrome Web Store package, review, versioned releases and permission review; the downloadable unpacked ZIP is available now. |
| P2 | Operational visibility | Structured redacted diagnostics, uptime alerts and per-provider caption-gap tracking. |
| P3 | Horizontal scaling | Leased shared queue, shared database/object storage and multi-instance caption delivery before enabling replicas. |

## Upstream limitation

MeetStream's published API does not expose an in-place recognizer language update. Lingo's restart workflow intentionally has a gap and may require re-admission. Seamless switching depends on provider/API support and needs a separate implementation when that support exists.

import {randomUUID} from "node:crypto";
import { escapeHtml, LANGUAGES } from "./core.js";

// Meeting-local date, not export time. UUID keeps repeated downloads distinct.
export function exportFilename(meeting, suffix, format) {
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Kolkata',day:'2-digit',month:'2-digit',year:'numeric',weekday:'long',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(meeting.createdAt ?? Date.now())).map(p=>[p.type,p.value]));
  let title=String(meeting.title || 'Meeting').normalize('NFC').replace(/[^\p{L}\p{M}\p{N}_-]+/gu,'-').replace(/^-+|-+$/g,'') || 'Meeting';
  const letters=[...new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(title)].map(p=>p.segment).slice(0,60);
  title=letters.join('');
  while(Buffer.byteLength(title,'utf8')>80){letters.pop();title=letters.join('');}
  return `${title}_${parts.day}-${parts.month}-${parts.year}_${parts.weekday}_${parts.hour}-${parts.minute}-${parts.second}_IST_${randomUUID()}-${suffix}.${format}`;
}

export function timestamp(seconds, separator = ".") {
  const ms = Math.max(0, Math.round(seconds * 1000));
  return `${String(Math.floor(ms / 3600000)).padStart(2, "0")}:${String(Math.floor(ms / 60000) % 60).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}${separator}${String(ms % 1000).padStart(3, "0")}`;
}
const safeText = (s) =>
  String(s)
    .replace(/[\r\n]+/g, " ")
    .replace(/-->/g, "→");
const markdown = (s) => safeText(s).replace(/[\\`*_{}\[\]<>#|]/g, "\\$&");
export function exportArtifact(
  meeting,
  allCues,
  { format = "vtt", target = "en", kind = "live", bilingual = false } = {},
) {
  const cues = allCues
    .filter((c) => c.kind === kind)
    .sort((a, b) => a.start - b.start);
  if (!cues.length)
    throw new Error(
      `No ${kind === "final" ? "post-call" : "live"} captions available.`,
    );
  const originalOnly = target === "original";
  if (!["live", "final"].includes(kind))
    throw new Error("Unsupported transcript version.");
  if (!originalOnly && !Object.hasOwn(LANGUAGES, target))
    throw new Error("Unsupported export language.");
  if (
    !originalOnly &&
    cues.some((c) => c.translations[target]?.status !== "ready")
  )
    throw new Error(
      "Translations are incomplete. Retry failed work or wait before exporting.",
    );
  const filename=exportFilename(meeting,`${kind}-${target}`,format);
  const provenance =
    meeting.mode === "demo"
      ? "Simulated sample; not a real meeting."
      : `${kind === "final" ? "Post-call transcript" : "Live transcript"}; ${originalOnly ? "machine transcription" : "machine transcription and translation"}, review before relying on it.`;
  const timing = cues.some((c) => c.timing === "receipt-estimate")
    ? "Some subtitle timings are estimated from webhook receipt; not aligned to the recording."
    : "Subtitle timing is relative to the provider audio stream. Confirm alignment against the recording.";
  const translated = (c) =>
    originalOnly ? c.text : c.translations[target].text;
  const lines = (c) =>
    `${safeText(c.speaker)}: ${bilingual && !originalOnly ? safeText(c.text) + "\n" : ""}${safeText(translated(c))}`;
  let content, type;
  if (format === "vtt") {
    content =
      `WEBVTT\n\nNOTE ${safeText(provenance)} ${safeText(timing)}\n\n` +
      cues
        .map(
          (c, i) =>
            `${i + 1}\n${timestamp(c.start)} --> ${timestamp(c.end)}\n<v ${escapeHtml(safeText(c.speaker))}>${bilingual && !originalOnly ? escapeHtml(safeText(c.text)) + "\n" : ""}${escapeHtml(safeText(translated(c)))}</v>\n`,
        )
        .join("\n");
    type = "text/vtt";
  } else if (format === "srt") {
    content = cues
      .map(
        (c, i) =>
          `${i + 1}\n${timestamp(c.start, ",")} --> ${timestamp(c.end, ",")}\n${lines(c).replace(/[<>]/g, "")}\n`,
      )
      .join("\n");
    type = "application/x-subrip";
  } else if (format === "html") {
    content =
      `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(filename.replace(/\.html$/, ""))}</title><style>body{font:18px/1.7 system-ui;max-width:72rem;margin:auto;padding:2rem;color:#15243d}article{border-top:1px solid #ccd5e2;padding:1rem 0;break-inside:avoid}.columns{display:grid;grid-template-columns:1fr 1fr;gap:2rem}p{white-space:pre-wrap}time{color:#526179}@media(max-width:600px){.columns{display:block}}@media print{body{padding:0;font-size:12pt}}</style><body><main><h1>${escapeHtml(meeting.title)}</h1><p>${escapeHtml(provenance)}</p><p>${escapeHtml(timing)}</p><p>Created ${escapeHtml(new Date(meeting.createdAt).toISOString())}. Target: ${escapeHtml(originalOnly ? "Original languages" : LANGUAGES[target])}.</p>` +
      cues
        .map(
          (c) =>
            `<article aria-label="${escapeHtml(c.speaker)} at ${timestamp(c.start)}"><h2>${escapeHtml(c.speaker)}</h2><time>${timestamp(c.start)} – ${timestamp(c.end)}</time><div class="${originalOnly ? "original" : "columns"}"><section><h3>Original${c.source ? " · " + escapeHtml(LANGUAGES[c.source] || c.source) : ""}</h3><p lang="${escapeHtml(c.source || c.translations[target]?.detectedSource || "und")}" dir="auto">${escapeHtml(c.text)}</p></section>${originalOnly ? "" : `<section><h3>${escapeHtml(LANGUAGES[target])}</h3><p lang="${target}" dir="auto">${escapeHtml(translated(c))}</p></section>`}</div></article>`,
        )
        .join("") +
      "</main></body></html>";
    type = "text/html";
  } else if (format === "md") {
    content =
      `# ${markdown(meeting.title)}\n\n${provenance}\n\n${timing}\n\n` +
      cues
        .map(
          (c) =>
            `## ${markdown(c.speaker)} · ${timestamp(c.start)}\n\nOriginal: ${markdown(c.text)}${originalOnly ? "" : `\n\n${LANGUAGES[target]}: ${markdown(translated(c))}`}\n`,
        )
        .join("\n");
    type = "text/markdown";
  } else if (format === "txt") {
    content =
      `${meeting.title}\n${provenance}\n${timing}\n\n` +
      cues
        .map((c) => `[${timestamp(c.start)} – ${timestamp(c.end)}] ${lines(c)}`)
        .join("\n\n") +
      "\n";
    type = "text/plain";
  } else if (format === "json") {
    content = JSON.stringify(
      {
        meeting: {
          id: meeting.id,
          title: meeting.title,
          createdAt: meeting.createdAt,
          mode: meeting.mode,
        },
        target,
        kind,
        provenance,
        timing,
        cues,
      },
      null,
      2,
    );
    type = "application/json";
  } else throw new Error("Choose VTT, SRT, HTML, Markdown, text or JSON.");
  return {
    content,
    type: `${type}; charset=utf-8`,
    filename,
  };
}

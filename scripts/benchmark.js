import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { translate, translationConfigured } from "../server/providers.js";
import { chrf, percentile } from "../server/core.js";
import { DEMO } from "../server/demo.js";
import { openConnections } from "../server/connections.js";
const args = process.argv.slice(2),
  demo = args.includes("--demo"),
  provider = args.includes("--provider")
    ? args[args.indexOf("--provider") + 1]
    : "google";
if (!["google", "azure", "jigsawstack"].includes(provider))
  throw new Error("Use --provider google, azure or jigsawstack.");
if (!demo)
  openConnections(
    resolve(
      dirname(process.env.DATABASE_PATH || "data/meetings.sqlite"),
      "connections.json",
    ),
    process.env,
  );
const output = args.includes("--output")
  ? args[args.indexOf("--output") + 1]
  : `docs/measurements-${demo ? "simulated" : provider}.json`;
if (!demo && !translationConfigured(provider, process.env)) {
  console.error(
    `No ${provider} credentials configured. No real benchmark was run. Save them in Connections or .env and retry, or use --demo to check the harness.`,
  );
  process.exit(1);
}
const fixtures = JSON.parse(
    readFileSync(
      new URL("../test/fixtures/language-pairs.json", import.meta.url),
    ),
  ),
  samples = [];
for (const f of fixtures) {
  if (demo && !DEMO.some((s) => s[s.source] === f.text)) continue;
  try {
    const result = demo
      ? {
          text: DEMO.find((s) => s[s.source] === f.text)[f.target],
          detectedSource: f.source,
          durationMs: 0,
        }
      : await translate(f.text, null, f.target, provider);
    samples.push({
      ...f,
      status: "success",
      hypothesis: result.text,
      detectedSource: result.detectedSource,
      translationMs: result.durationMs,
      chrF2: chrf(result.text, f.reference),
    });
  } catch (e) {
    samples.push({ ...f, status: "failed", error: e.message });
  }
}
const pairs = [...new Set(fixtures.map((f) => f.pair))].map((pair) => {
  const xs = samples.filter((s) => s.pair === pair),
    ok = xs.filter((s) => s.status === "success");
  return {
    pair,
    samples: ok.length,
    failures: xs.length - ok.length,
    translationP50Ms: demo
      ? null
      : percentile(
          ok.map((s) => s.translationMs),
          0.5,
        ),
    translationP95Ms: demo
      ? null
      : percentile(
          ok.map((s) => s.translationMs),
          0.95,
        ),
    meanChrF2: ok.length
      ? +(ok.reduce((s, x) => s + x.chrF2, 0) / ok.length).toFixed(2)
      : null,
    speechToCaptionMs: null,
    humanQuality: null,
  };
});
const report = {
  recordedAt: new Date().toISOString(),
  mode: demo ? "simulated-handwritten" : "text-provider-benchmark",
  provider: demo ? "handwritten sample" : provider,
  notes: demo
    ? "Harness verification only. Outputs are handwritten sample references; perfect overlap is expected. No real provider or meeting latency measured."
    : "Serial text requests with automatic detection, no audio. Translation duration includes network time. References are starter examples, not certified evaluator judgments. Human semantic review and a real meeting are still required.",
  pairs,
  samples,
};
mkdirSync(resolve(output, ".."), { recursive: true });
writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ output, pairs, mode: report.mode }, null, 2));
if (samples.some((s) => s.status === "failed")) process.exitCode = 1;

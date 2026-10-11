// Sends the synthetic activity probe set (test/fixtures/activity-probe.json) to one classifier as the router would ask
// it, and writes accuracy, the expected × answered confusion matrix and p50/p95 latency to
// experiments/mod-router/results/activity-probe-<classifier>.json, then regenerates lib/probe-results.mjs, which the
// Classifier tab reads. Ollama's latency covers both of its requests.
// Reads keys and endpoint settings as probe-classifier.mjs does. Never prints a key or the full URL. Billed; run by
// hand, not in CI.
// Usage: node scripts/probe-activity.mjs [classifier-id]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildActivityRequest, buildRequest, parseActivityAnswer, parseAnswers } from '../lib/classifier-apis.mjs';
import { resolveCredentials } from '../lib/classifier-contract.mjs';
import { ACTIVITY_VALUES, loadConfig } from '../lib/config.mjs';
import { isUsableProbe, writeProbeModule } from './probe-results.mjs';

if (existsSync('.env')) process.loadEnvFile('.env');
const profile = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'router.json');
const userFile = existsSync(profile) ? JSON.parse(readFileSync(profile, 'utf8')) : null;
const loaded = loadConfig({ userFile });
const id = process.argv[2] ?? loaded.classifier;
if (!Object.hasOwn(loaded.classifiers, id)) {
  console.error(`unknown classifier ${id}; configured: ${Object.keys(loaded.classifiers).join(', ')}`);
  process.exit(2);
}
// A profile with activity routing off would not ask the question at all.
const config = { ...loaded, classifier: id, activityRouting: 'on' };
const entry = config.classifiers[id];
const credentials = await resolveCredentials(entry, (name) => process.env[name.toUpperCase()]?.trim());
if (credentials.missing) {
  console.error(`${id}: ${credentials.missing}`);
  process.exit(2);
}

async function post(body) {
  const response = await fetch(credentials.endpoint, {
    method: 'POST',
    headers: {
      ...(credentials.apiKey ? { authorization: `Bearer ${credentials.apiKey}` } : {}),
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(entry.timeoutMs * 4),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return JSON.parse(await response.text());
}

// The activity the router would read for one prompt: from the route answer, or from Ollama's second request.
async function ask(text, turns) {
  const advice = parseAnswers(config, await post(buildRequest(config, text, turns)));
  const step = buildActivityRequest(config, text, turns);
  return step ? parseActivityAnswer(config, await post(step)) : advice.activity;
}

const percentile = (sorted, p) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? null;
const { probes } = JSON.parse(readFileSync(new URL('../test/fixtures/activity-probe.json', import.meta.url), 'utf8'));
const confusion = {};
const latencies = [];
const errors = {};
let correct = 0;
for (const [index, { text, dialogue = [], expected }] of probes.entries()) {
  const started = Date.now();
  let answered = 'none';
  try {
    answered = (await ask(text, dialogue))?.choice ?? 'none';
    latencies.push(Date.now() - started);
  } catch (error) {
    errors[error.message] = (errors[error.message] ?? 0) + 1;
  }
  confusion[expected] ??= {};
  confusion[expected][answered] = (confusion[expected][answered] ?? 0) + 1;
  if (answered === expected) correct += 1;
  process.stdout.write(`\r${index + 1}/${probes.length}`);
}
latencies.sort((a, b) => a - b);
const result = {
  classifier: id,
  model: entry.model,
  api: entry.api,
  date: new Date().toISOString(),
  probes: probes.length,
  answered: probes.length - Object.values(errors).reduce((sum, n) => sum + n, 0),
  accuracy: correct / probes.length,
  // Rows are the expected activity, columns the answer: an activity, 'uncertain', or 'none' (no usable answer).
  labels: [...ACTIVITY_VALUES, 'none'],
  confusion,
  latencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), deadline: entry.timeoutMs },
  errors,
};
if (!isUsableProbe(result)) {
  console.error(`\n${id}: no activity answer, nothing written. Errors: ${JSON.stringify(errors)}`);
  process.exit(1);
}
const dir = fileURLToPath(new URL('../experiments/mod-router/results/', import.meta.url));
mkdirSync(dir, { recursive: true });
const out = join(dir, `activity-probe-${id}.json`);
writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
const host = new URL(credentials.endpoint).host;
console.log(
  `\n${id} (${entry.model}) at ${host}: ${correct}/${probes.length} correct (${(result.accuracy * 100).toFixed(1)}%), ` +
    `p50 ${result.latencyMs.p50} ms, p95 ${result.latencyMs.p95} ms, deadline ${entry.timeoutMs} ms`,
);
console.log(`wrote ${out}`);
console.log(`wrote ${writeProbeModule()}`);

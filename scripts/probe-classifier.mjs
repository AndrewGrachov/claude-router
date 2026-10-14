// Sends the router's real request to one classifier and prints what came back: status, latency, answer shape.
// Reads the profile router.json and the key and endpoint settings from the environment or ./.env, as upper-case
// option names (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, TYPESAFE_API_KEY, OPENAI_API_KEY, LITELLM_API_KEY, LITELLM_API_BASE, GATEWAY_MODEL). Never prints a key or the
// full URL.
// Usage: node scripts/probe-classifier.mjs [classifier-id]
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildRequest, parseAnswers } from '../lib/classifier-apis.mjs';
import { resolveCredentials } from '../lib/classifier-contract.mjs';
import { loadConfig } from '../lib/config.mjs';

if (existsSync('.env')) process.loadEnvFile('.env');
// An option's upper-case name; the gateway key and URL are read as LITELLM_API_KEY and LITELLM_API_BASE, as the hook
// reads them.
const ENV_NAMES = { gateway_api_key: 'LITELLM_API_KEY', gateway_url: 'LITELLM_API_BASE' };
const envSetting = (name) => process.env[ENV_NAMES[name] ?? name.toUpperCase()]?.trim();
const profile = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'router.json');
const userFile = existsSync(profile) ? JSON.parse(readFileSync(profile, 'utf8')) : null;
const loaded = loadConfig({ userFile });
const id = process.argv[2] ?? loaded.classifier;
if (!Object.hasOwn(loaded.classifiers, id)) {
  console.error(`unknown classifier ${id}; configured: ${Object.keys(loaded.classifiers).join(', ')}`);
  process.exit(2);
}
const entry = loaded.classifiers[id];
const credentials = await resolveCredentials(entry, (name) => envSetting(name));
if (credentials.missing) {
  console.error(`${id}: ${credentials.missing}`);
  process.exit(2);
}
// The entry asks for its model with settings filled in, such as the Gateway classifier's {gateway_model}.
const config = {
  ...loaded,
  classifier: id,
  classifiers: { ...loaded.classifiers, [id]: { ...entry, model: credentials.model } },
};

const prompt = 'Design a cache invalidation scheme across three services with strict consistency requirements.';
const turns = [{ role: 'user', text: 'We are refactoring the billing service.' }];
const started = Date.now();
const response = await fetch(credentials.endpoint, {
  method: 'POST',
  headers: {
    ...(credentials.apiKey ? { authorization: `Bearer ${credentials.apiKey}` } : {}),
    'content-type': 'application/json',
  },
  body: JSON.stringify(buildRequest(config, prompt, turns)),
  signal: AbortSignal.timeout(entry.timeoutMs * 4),
});
const ms = Date.now() - started;
const text = await response.text();
const host = new URL(credentials.endpoint).host;
console.log(`${id} (${credentials.model}) at ${host}: HTTP ${response.status} in ${ms} ms, deadline ${entry.timeoutMs} ms`);
try {
  console.log(JSON.stringify(parseAnswers(config, JSON.parse(text)), null, 2));
} catch (error) {
  console.log(`not a classifier answer: ${error.message}`);
  console.log(text.slice(0, 600));
  process.exitCode = 1;
}

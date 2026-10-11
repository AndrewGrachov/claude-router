// Subagent routing: one model per subagent, chosen at agent.spawn before its cache exists, and the counts that show
// what that choice saves. Pure: the hook passes the spawn input, the classifier's advice and each reply's usage, and
// keeps the totals in the view and, per session, in $.store under SUBAGENT_PREFIX.

import { CLASSIFY } from './config.mjs';
import { clip } from './facts.mjs';
import { modelSpec, requestUsd } from './savings.mjs';

export const SUBAGENT_PREFIX = 'subagents:v1:';
// The longest a spawn waits for the classifier. The wait delays the subagent's start, and the client's deadline race
// sleeps on $.clock, which counts against the hook's 10 s budget (HookBudget in the build types).
export const SPAWN_DEADLINE_MS = 3000;
// A spawn of a type its parent loop finished one of this recently counts as a respawn: a proxy for a retry.
export const RESPAWN_WINDOW_MS = 600_000;
// Why a spawn passes through unchanged, in the order they are checked.
// `unlisted`: a built-in router.json does not list, or a type it lists as null. `pinned`: the agent's definition names a
// model and does not set `modelRouting: auto`. `unknown`: its definition could not be found or read.
export const PASS_REASONS = ['fork', 'workflow', 'explicit', 'teammate', 'unlisted', 'pinned', 'unknown'];
// Built-ins that ignore CLAUDE_CODE_SUBAGENT_MODEL unless CLAUDE_CODE_SUBAGENT_MODEL_FORCE is set.
const OWN_MODEL_BUILTINS = ['Explore', 'Plan'];

// The agent definition frontmatter the router reads: `name`, `model` and `modelRouting`, from a YAML block or the
// one-line JSON object some plugin builds write. Null when the text has no frontmatter. Only top-level scalars are read.
export function agentFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(typeof text === 'string' ? text : '');
  if (!match) return null;
  const block = match[1].trim();
  const fields = {};
  if (block.startsWith('{')) {
    try {
      Object.assign(fields, JSON.parse(block));
    } catch {
      return null;
    }
  } else
    for (const line of block.split(/\r?\n/)) {
      const pair = /^([A-Za-z][\w-]*):\s*(.*?)\s*$/.exec(line);
      if (pair) fields[pair[1]] = pair[2].replace(/\s+#.*$/, '').replace(/^(['"])(.*)\1$/, '$2');
    }
  const text_ = (value) => (typeof value === 'string' && value ? value : null);
  return { name: text_(fields.name), model: text_(fields.model), modelRouting: text_(fields.modelRouting) };
}

// Whether a definition lets the router choose its model: no model, `inherit` (the main conversation's model, which
// the router routes too), or `modelRouting: auto`, where `model` is only what runs without the router.
export const routableDefinition = (definition) =>
  !definition.model || definition.model === 'inherit' || definition.modelRouting === 'auto';

const pluginOf = (spawn) => {
  const provider = spawn.provider?.plugin;
  return typeof provider === 'string' ? provider.split('@')[0] : null;
};

// What router.json lists for this spawn's type: a models key, CLASSIFY or null, or undefined when it does not list
// it. A key without a colon names a built-in, so it matches only the engine's own agent; a `plugin:name` key matches
// only that plugin's agent (provider `plugin@marketplace`).
function listedRoute(config, spawn) {
  const { types } = config.subagents;
  const type = spawn.subagentType;
  if (typeof type !== 'string' || !Object.hasOwn(types, type)) return undefined;
  const owner = type.includes(':') ? type.slice(0, type.indexOf(':')) : 'engine';
  return pluginOf(spawn) === owner ? types[type] : undefined;
}

// How the router may route this spawn's type: `{ route }`, a models key or CLASSIFY, or `{ pass }`, a PASS_REASONS
// entry. router.json's `types` decide first, a null there excluding the type. An unlisted built-in passes, since its
// definition is not readable. Any other agent is classified when its `definition` (agentFrontmatter of its file) is
// routable, and passes when it pins a model or could not be read.
export function typeRoute(config, spawn, definition = null) {
  const listed = listedRoute(config, spawn);
  if (listed !== undefined) return listed === null ? { pass: 'unlisted' } : { route: listed };
  if (pluginOf(spawn) === 'engine') return { pass: 'unlisted' };
  if (!definition) return { pass: 'unknown' };
  return routableDefinition(definition) ? { route: CLASSIFY } : { pass: 'pinned' };
}

// The reason a spawn keeps the model core gives it, or null when the router may choose one. A fork reads the parent's
// cache on the parent's model; `model` is the Agent call's own choice; a teammate and a workflow agent are not
// rewritable (a workflow agent's model rewrite is ignored, experiments/mod-router/results/agent-spawn-probe.json).
export function passReason(config, spawn, definition = null) {
  if (spawn.fork) return 'fork';
  // Before `explicit`: a workflow agent({ model }) arrives with `model` set, and counts as a workflow agent.
  if (spawn.workflow) return 'workflow';
  if (spawn.model) return 'explicit';
  if (spawn.isTeammate) return 'teammate';
  return typeRoute(config, spawn, definition).pass ?? null;
}

// The task text the classifier sees: the description and the prompt the parent wrote, clipped like a main turn's
// prompt. Never tool results or history.
export const spawnPrompt = (config, spawn) =>
  clip(`${spawn.description ?? ''}\n${spawn.prompt ?? ''}`.trim(), config.context.maxTextChars);

// The models key a `classify` type runs on from the classifier's advice, or null (no advice: core's model). `heavy`
// only for a clearly hard task, `light` for exploration or the smallest tier, `standard` for the rest.
export function classifiedAlias(config, advice) {
  if (!advice) return null;
  const { light, standard, heavy, heavyMass } = config.subagents;
  if ((advice.probabilities?.high ?? 0) >= heavyMass) return heavy;
  const activity = advice.activity;
  const explores =
    activity?.choice === 'explore' && (activity.probabilities?.explore ?? 0) >= config.policy.activityMass;
  return explores || advice.choice === 'micro' ? light : standard;
}

// The model core runs an agent on when the router sets none: its definition's model unless that is `inherit`, else
// CLAUDE_CODE_SUBAGENT_MODEL, except for the
// built-ins that ignore it without CLAUDE_CODE_SUBAGENT_MODEL_FORCE, else the parent's model. An estimate: it does not
// apply the family-alias rule or the availableModels substitution.
export function coreModelOf(config, spawn, { envModel = null, force = false, definition = null } = {}) {
  const idOf = (model) => (Object.hasOwn(config.models, model) ? config.models[model].id : model);
  const pinned = definition?.model && definition.model !== 'inherit' ? definition.model : null;
  if (pinned && !(force && envModel)) return idOf(pinned);
  const usesEnv = envModel && envModel !== 'inherit' && (force || !OWN_MODEL_BUILTINS.includes(spawn.subagentType));
  return usesEnv ? idOf(envModel) : spawn.parentModel;
}

// One spawn's record while its agent runs: what was decided and the priced replies since the last flush. `pass` is a
// PASS_REASONS entry or null. `choice` is the models key decided, or 'core' when the decision kept core's model.
// `actualUsd` prices each reply on the model it ran on; `otherUsd` the same tokens on core's estimated model. Null for
// a pass-through.
export function spawnRecord({ sessionId, spawn, pass, choice, routedModel, coreModel, failed, respawn }) {
  return {
    sessionId,
    type: spawn.subagentType,
    pass,
    choice,
    routedModel,
    coreModel,
    failed: Boolean(failed),
    respawn: Boolean(respawn),
    counted: false,
    requests: 0,
    pricedRequests: 0,
    actualUsd: 0,
    otherUsd: 0,
  };
}

const isCount = (n) => Number.isFinite(n) && n >= 0;

// The record with one reply added. A reply is priced only when both its model and the comparison's have a price.
export function addAgentReply(config, agent, usage, ttl) {
  const counts = {
    input: usage?.input_tokens,
    cacheRead: usage?.cache_read_input_tokens,
    cacheWrite: usage?.cache_creation_input_tokens,
    output: usage?.output_tokens,
  };
  const next = { ...agent, requests: agent.requests + 1 };
  const write = config.cache.writeMultiplier[ttl];
  const actual = modelSpec(config, usage?.model);
  const other = agent.pass ? null : modelSpec(config, agent.coreModel);
  const priced = (spec) => spec && Number.isFinite(spec.output);
  if (!Object.values(counts).every(isCount) || !Number.isFinite(write) || !priced(actual)) return next;
  if (!agent.pass && !priced(other)) return next;
  next.pricedRequests += 1;
  next.actualUsd += requestUsd(actual, counts, write);
  if (other) next.otherUsd += requestUsd(other, counts, write);
  return next;
}

// A record kept across sessions, one session's or their sum, since `since` (ms), the first agent after a reset.
// `routed.on[type]` counts the routed types; `passed[reason]` the pass-throughs, priced on the model they ran on. Records
// saved before 1.10.1 may also hold `routed.shadow`, which reads as dropped.
export function emptySubagentStore() {
  return { version: 1, since: null, routed: { on: {} }, passed: {} };
}

const ROUTED_SUMS = ['agents', 'differs', 'requests', 'pricedRequests', 'coreUsd', 'routedUsd', 'respawns', 'failures'];
const PASSED_SUMS = ['agents', 'requests', 'pricedRequests', 'usd'];
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const emptyRouted = () => ({ ...Object.fromEntries(ROUTED_SUMS.map((sum) => [sum, 0])), choices: {} });
const emptyPassed = () => Object.fromEntries(PASSED_SUMS.map((sum) => [sum, 0]));

// The finished turn's counts of one agent added to a store at `now`: the agent once, on its first flush, then its
// requests and prices since the last flush.
export function recordAgent(store, agent, now) {
  if (!agent.requests && agent.counted) return store;
  const first = agent.counted ? 0 : 1;
  const next = { ...store, since: store.since ?? now, routed: { ...store.routed }, passed: { ...store.passed } };
  if (agent.pass) {
    const counts = { ...(next.passed[agent.pass] ?? emptyPassed()) };
    counts.agents += first;
    counts.requests += agent.requests;
    counts.pricedRequests += agent.pricedRequests;
    counts.usd += agent.actualUsd;
    next.passed[agent.pass] = counts;
    return next;
  }
  const byType = { ...next.routed.on };
  const counts = { ...(byType[agent.type] ?? emptyRouted()), choices: { ...byType[agent.type]?.choices } };
  counts.agents += first;
  counts.differs += first && agent.routedModel !== agent.coreModel ? 1 : 0;
  counts.respawns += first && agent.respawn ? 1 : 0;
  counts.failures += first && agent.failed ? 1 : 0;
  if (first) counts.choices[agent.choice] = (counts.choices[agent.choice] ?? 0) + 1;
  counts.requests += agent.requests;
  counts.pricedRequests += agent.pricedRequests;
  counts.coreUsd += agent.otherUsd;
  counts.routedUsd += agent.actualUsd;
  byType[agent.type] = counts;
  next.routed = { on: byType };
  return next;
}

// The record after a flush: counted once, nothing pending.
export const flushedAgent = (agent) => ({
  ...agent,
  counted: true,
  requests: 0,
  pricedRequests: 0,
  actualUsd: 0,
  otherUsd: 0,
});

function readCounts(value, sums, withChoices) {
  if (!isRecord(value) || !sums.every((sum) => isCount(value[sum]))) return null;
  const out = Object.fromEntries(sums.map((sum) => [sum, value[sum]]));
  if (!withChoices) return out;
  const choices = isRecord(value.choices) ? value.choices : {};
  out.choices = Object.fromEntries(Object.entries(choices).filter(([, n]) => Number.isSafeInteger(n) && n >= 0));
  return out;
}

function readMap(value, sums, withChoices) {
  const out = {};
  if (!isRecord(value)) return out;
  for (const [key, counts] of Object.entries(value)) {
    const read = readCounts(counts, sums, withChoices);
    if (read) out[key] = read;
  }
  return out;
}

// The stored value with its well-formed entries, else an empty store: a missing, hand-edited or unknown value must not
// break a turn or the pane.
export function readSubagentStore(value) {
  if (!isRecord(value) || value.version !== 1 || !(value.since === null || Number.isFinite(value.since)))
    return emptySubagentStore();
  return {
    version: 1,
    since: value.since,
    routed: { on: readMap(value.routed?.on, ROUTED_SUMS, true) },
    passed: readMap(value.passed, PASSED_SUMS, false),
  };
}

// A record whose first agent came before the last reset at `resetAt` (ms) reads as empty.
export function subagentsAfterReset(record, resetAt) {
  return Number.isFinite(resetAt) && record.since !== null && record.since < resetAt ? emptySubagentStore() : record;
}

function addInto(target, source, sums, withChoices) {
  for (const [key, counts] of Object.entries(source)) {
    const into = target[key] ?? (withChoices ? emptyRouted() : emptyPassed());
    for (const sum of sums) into[sum] += counts[sum];
    if (withChoices)
      for (const [choice, n] of Object.entries(counts.choices)) into.choices[choice] = (into.choices[choice] ?? 0) + n;
    target[key] = into;
  }
}

// Every session's record since the last reset added up, since the earliest.
export function mergeSubagentStores(values, resetAt = null) {
  const merged = emptySubagentStore();
  for (const one of values.map((value) => subagentsAfterReset(readSubagentStore(value), resetAt))) {
    const since = [merged.since, one.since].filter(Number.isFinite);
    merged.since = since.length ? Math.min(...since) : null;
    addInto(merged.routed.on, one.routed.on, ROUTED_SUMS, true);
    addInto(merged.passed, one.passed, PASSED_SUMS, false);
  }
  return merged;
}

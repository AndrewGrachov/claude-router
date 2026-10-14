// Subagent routing: one model per subagent, chosen at agent.spawn before its cache exists, and the counts that show
// what that choice saves. Pure: the hook passes the spawn input, the classifier's advice and each reply's usage, and
// keeps the totals in the view and, per session, in $.store under SUBAGENT_PREFIX.

import { CLASSIFY } from './config.mjs';
import { clip } from './facts.mjs';
import { afterResetOf, earlierSince, isRecord } from './records.mjs';
import { modelSpec, requestUsd } from './savings.mjs';
import { DAY, dayKey, daysBefore, RETAIN_DAYS } from './usage.mjs';

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
// Each reason as the pane and the band show it.
export const PASS_LABEL = {
  fork: 'fork',
  workflow: 'workflow agent',
  explicit: 'explicit model',
  teammate: 'teammate',
  unlisted: 'type not routed',
  pinned: 'pinned model',
  unknown: 'no definition',
};
// Why Claude Code picked the model for each reason.
export const PASS_WHY = {
  fork: 'your model',
  workflow: 'the workflow sets it',
  explicit: 'the Agent call sets it',
  teammate: 'teammates keep theirs',
  unlisted: 'not in subagents.types',
  pinned: 'its agent file sets it',
  unknown: 'agent file not found',
};
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

// How the router's model compares with core's: null when they are the same, `up` or `down` by output price, `moved`
// when either has no price.
export function moveOf(config, routedModel, coreModel) {
  if (!routedModel || !coreModel || routedModel === coreModel) return null;
  const [routed, core] = [routedModel, coreModel].map((id) => modelSpec(config, id)?.output);
  if (!Number.isFinite(routed) || !Number.isFinite(core) || routed === core) return 'moved';
  return routed > core ? 'up' : 'down';
}

// One spawn's record while its agent runs: what was decided and the priced replies since the last flush. `pass` is a
// PASS_REASONS entry or null. `choice` is the models key decided, or 'core' when the decision kept core's model.
// `move` is moveOf the routed model against core's. `actualUsd` prices each reply on the model it ran on; `otherUsd`
// the same tokens on core's estimated model, none for a pass-through.
export function spawnRecord({ sessionId, spawn, pass, choice, routedModel, coreModel, move = null, failed, respawn }) {
  return {
    sessionId,
    type: spawn.subagentType,
    pass,
    choice,
    routedModel,
    coreModel,
    move,
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

// A record kept across sessions, one session's or their sum, since `since` (ms), the first agent after a reset, by
// local calendar day like the usage records, so the Usage tab's period applies. A day holds `routed[type]` and
// `passed[reason]`: agents, requests and the retry proxies of the type, and per model id the agents ran on, its agents
// and their cost (`models`); a routed model also counts the agents the router moved onto it, `up` or `down` from
// core's, and core's estimated cost of the same tokens. A version 1 record, from before 1.14.0, has neither days nor
// models: it reads as `undated` totals, which only the periods without a range (session and all) count.
export function emptySubagentStore() {
  return { version: 2, since: null, days: {} };
}

const ROUTED_SUMS = ['agents', 'requests', 'pricedRequests', 'respawns', 'failures'];
const PASSED_SUMS = ['agents', 'requests', 'pricedRequests'];
const ROUTED_MODEL_SUMS = ['agents', 'moved', 'up', 'down', 'usd', 'coreUsd'];
const PASSED_MODEL_SUMS = ['agents', 'usd'];
const UNDATED_SUMS = ['agents', 'usd'];
const SUMS = {
  routed: [ROUTED_SUMS, ROUTED_MODEL_SUMS],
  passed: [PASSED_SUMS, PASSED_MODEL_SUMS],
};
// A model id the record never got.
const UNKNOWN_MODEL = 'unknown';

const zeros = (sums) => Object.fromEntries(sums.map((sum) => [sum, 0]));
const emptyCounts = (sums) => ({ ...zeros(sums), models: {} });
const emptySubagentDay = () => ({ routed: {}, passed: {} });

// A key read from the store, such as a model id `__proto__`, must neither answer from the prototype nor set it.
const own = (object, key) => (Object.hasOwn(object, key) ? object[key] : undefined);
const put = (object, key, value) =>
  Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true });

// The finished turn's counts of one agent added to a store at `now`, on that day: the agent once, on its first flush,
// with the model it ran on and the router's move, then its requests and prices since the last flush. Days past
// RETAIN_DAYS leave the record.
export function recordAgent(store, agent, now) {
  if (!agent.requests && agent.counted) return store;
  const first = agent.counted ? 0 : 1;
  const days = structuredClone(store.days);
  const day = days[dayKey(now)] ?? emptySubagentDay();
  const kind = agent.pass ? 'passed' : 'routed';
  const key = agent.pass ?? agent.type;
  const [sums, modelSums] = SUMS[kind];
  const counts = own(day[kind], key) ?? emptyCounts(sums);
  counts.agents += first;
  counts.requests += agent.requests;
  counts.pricedRequests += agent.pricedRequests;
  const modelId = agent.routedModel || UNKNOWN_MODEL;
  const model = own(counts.models, modelId) ?? zeros(modelSums);
  model.agents += first;
  model.usd += agent.actualUsd;
  if (!agent.pass) {
    counts.respawns += first && agent.respawn ? 1 : 0;
    counts.failures += first && agent.failed ? 1 : 0;
    model.moved += first && agent.move ? 1 : 0;
    model.up += first && agent.move === 'up' ? 1 : 0;
    model.down += first && agent.move === 'down' ? 1 : 0;
    model.coreUsd += agent.otherUsd;
  }
  put(counts.models, modelId, model);
  put(day[kind], key, counts);
  days[dayKey(now)] = day;
  const cutoff = daysBefore(now, RETAIN_DAYS);
  for (const old of Object.keys(days)) if (old < cutoff) delete days[old];
  return { version: 2, since: store.since ?? now, days, ...(store.undated ? { undated: store.undated } : {}) };
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

const readSums = (value, sums) =>
  isRecord(value) && sums.every((sum) => isCount(value[sum]))
    ? Object.fromEntries(sums.map((sum) => [sum, value[sum]]))
    : null;

function readCounts(value, [sums, modelSums]) {
  const counts = readSums(value, sums);
  if (!counts || !isRecord(value.models)) return null;
  counts.models = {};
  for (const [id, model] of Object.entries(value.models)) {
    const read = readSums(model, modelSums);
    if (!read) return null;
    put(counts.models, id, read);
  }
  return counts;
}

function readKind(value, kind) {
  const out = {};
  if (!isRecord(value)) return out;
  for (const [key, counts] of Object.entries(value)) {
    const read = readCounts(counts, SUMS[kind]);
    if (read) put(out, key, read);
  }
  return out;
}

const readDay = (day) => ({ routed: readKind(day.routed, 'routed'), passed: readKind(day.passed, 'passed') });

// A version 1 record's agents and their cost on the models they ran on: what is left of it without days or models.
function undatedOf(value) {
  const out = zeros(UNDATED_SUMS);
  const add = (counts, usd) => {
    if (!isRecord(counts) || !isCount(counts.agents) || !isCount(counts[usd])) return;
    out.agents += counts.agents;
    out.usd += counts[usd];
  };
  for (const counts of Object.values(isRecord(value.routed?.on) ? value.routed.on : {})) add(counts, 'routedUsd');
  for (const counts of Object.values(isRecord(value.passed) ? value.passed : {})) add(counts, 'usd');
  return out;
}

// The stored value with its well-formed days and entries, else an empty store: a missing, hand-edited or unknown value
// must not break a turn or the pane.
export function readSubagentStore(value) {
  if (!isRecord(value) || !(value.since === null || Number.isFinite(value.since))) return emptySubagentStore();
  if (value.version === 1) {
    const undated = undatedOf(value);
    return { version: 2, since: value.since, days: {}, ...(undated.agents ? { undated } : {}) };
  }
  if (value.version !== 2 || !isRecord(value.days)) return emptySubagentStore();
  const days = {};
  for (const [key, day] of Object.entries(value.days)) if (DAY.test(key) && isRecord(day)) days[key] = readDay(day);
  const undated = readSums(value.undated, UNDATED_SUMS);
  return { version: 2, since: value.since, days, ...(undated ? { undated } : {}) };
}

// A record whose first agent came before the last reset at `resetAt` (ms) reads as empty.
export const subagentsAfterReset = (record, resetAt) => afterResetOf(record, resetAt, emptySubagentStore);

const addSums = (into, from, sums) => {
  for (const sum of sums) into[sum] += from[sum];
};

function addDay(into, day) {
  for (const kind of ['routed', 'passed']) {
    const [sums, modelSums] = SUMS[kind];
    for (const [key, counts] of Object.entries(day[kind])) {
      const total = own(into[kind], key) ?? emptyCounts(sums);
      addSums(total, counts, sums);
      for (const [id, model] of Object.entries(counts.models)) {
        const sum = own(total.models, id) ?? zeros(modelSums);
        addSums(sum, model, modelSums);
        put(total.models, id, sum);
      }
      put(into[kind], key, total);
    }
  }
}

// Every session's record since the last reset added up day by day, since the earliest.
export function mergeSubagentStores(values, resetAt = null) {
  const merged = emptySubagentStore();
  for (const one of values.map((value) => subagentsAfterReset(readSubagentStore(value), resetAt))) {
    merged.since = earlierSince(merged.since, one.since);
    for (const [key, day] of Object.entries(one.days)) {
      merged.days[key] ??= emptySubagentDay();
      addDay(merged.days[key], day);
    }
    if (one.undated) {
      merged.undated ??= zeros(UNDATED_SUMS);
      addSums(merged.undated, one.undated, UNDATED_SUMS);
    }
  }
  return merged;
}

// A record's days inside `range` (periodRange in lib/usage.mjs) added up, with the agents per day, oldest first; null
// ends take the whole record and its undated totals.
export function summarizeSubagents(record, { from, to }) {
  const total = emptySubagentDay();
  const perDay = [];
  for (const key of Object.keys(record.days).sort()) {
    if ((from !== null && key < from) || (to !== null && key > to)) continue;
    const day = record.days[key];
    addDay(total, day);
    const agents = [...Object.values(day.routed), ...Object.values(day.passed)].reduce((n, c) => n + c.agents, 0);
    perDay.push([key, agents]);
  }
  const whole = from === null && to === null;
  return { ...total, perDay, undated: whole && record.undated ? record.undated : null };
}

// A routed type's or a pass-through's totals over its models: agents moved and their direction, routed cost and
// core's estimate (zero for a pass-through).
export function modelTotals(counts) {
  const out = zeros(ROUTED_MODEL_SUMS);
  for (const model of Object.values(counts.models)) for (const sum of ROUTED_MODEL_SUMS) out[sum] += model[sum] ?? 0;
  return out;
}

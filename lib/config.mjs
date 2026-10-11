// Defaults, user overrides and validation. Pure: callers pass env and the parsed user file.

export const TIERS = ['micro', 'low', 'medium', 'high'];
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
// What kind of work a turn does, named by what it produces. Closed: the classifier question is built for this set.
export const ACTIVITIES = ['code', 'debug', 'explore', 'plan', 'review', 'ops', 'docs'];
export const ACTIVITY_VALUES = [...ACTIVITIES, 'uncertain'];
// `off` asks nothing new and routes as 1.5; `on`, the default since 1.7, applies overrides.
export const ACTIVITY_MODES = ['off', 'on'];
// `subagentRouting` takes the same modes: `off` asks and records nothing, `on` applies the decision at agent.spawn.
export const SUBAGENT_MODES = ACTIVITY_MODES;
// Both modes took `shadow` until 1.10.1. A file that still sets it is read as not setting the key, and a write from the
// pane drops it.
const MODE_KEYS = ['activityRouting', 'subagentRouting'];
const withoutShadow = (file) =>
  Object.fromEntries(Object.entries(file).filter(([key, value]) => !(value === 'shadow' && MODE_KEYS.includes(key))));
// A `subagents.types` value that asks the classifier instead of naming a model.
export const CLASSIFY = 'classify';
const SONNET_HIGH = { model: 'sonnet', effort: 'high' };
export const DEFAULTS = {
  baselineTier: 'low',
  // Haiku 5.5 is the worker at `low` and `micro`: at high effort it scored above Sonnet 5.5 at low, and at xhigh near
  // Sonnet at medium, for a fraction of the cost per attempt (Anthropic's OSWorld 2.1 effort chart: computer use, not
  // coding). Opus 5.5 at medium matched or beat Sonnet 5.5 at xhigh at 25-50% lower cost per task on Terminal-Bench
  // 4.0, FrontierCode v1.1 and CursorBench 4.0 (anthropic.com/claude-sonnet-5-5). `high` is Opus 5.5 at xhigh, the
  // strongest setting this router asks for. These are routing defaults, not a claim of equal model quality.
  routes: {
    high: { model: 'opus', effort: 'xhigh' },
    medium: { model: 'opus', effort: 'medium' },
    low: { model: 'haiku', effort: 'high' },
    micro: { model: 'haiku', effort: 'medium' },
  },
  // Sparse per-field overrides of `routes` by activity; a missing activity, tier or field inherits the tier's route.
  // Coding is where Haiku is weakest (Terminal-Bench 4.0: Haiku 5.5 39.2%, Sonnet 5.5 70.6%), so `low` work that
  // edits, debugs, plans or reviews runs on Sonnet. At `high`, not `medium`: on FrontierCode Main Sonnet scored ~49%
  // at high and ~37% at medium, below Haiku at high (~42%). Command runs at `medium` lasted 6-11 requests at the
  // median in one developer's replay, long enough for Haiku to repay its cache write (~4 requests from Opus at ~350K
  // context). Haiku trails on multi-step tool work (OSWorld 2.1: ~61% at high, Opus ~79% at medium), so `high` ops
  // stays on Opus, and repeated tool errors still escalate. Moving explore and docs saved nothing in the replay, and
  // Haiku trails on research (HLE with tools 50.1% vs Opus 63.0%), so they keep the base routes. Two cells, one more cache (Sonnet at high) than the base routes.
  activityRouting: 'on',
  activities: {
    code: { low: SONNET_HIGH },
    debug: { low: SONNET_HIGH },
    plan: { low: SONNET_HIGH },
    review: { low: SONNET_HIGH },
    ops: { medium: { model: 'haiku', effort: 'high' } },
  },
  // Subagents get one model at agent.spawn, never between their steps. An agent whose definition names no model, says
  // `inherit`, or sets `modelRouting: auto` gets `light`, `standard` or `heavy` from the classifier; a pinned one keeps
  // its model. `types` overrides by agent type: a models key, `classify`, or null to never route it. A key without a
  // colon matches only the built-in of that name, whose definition is not readable, so only the listed built-ins route.
  // A listed type is routed even if it pins a model. docs/plans/2026-10-10-subagent-routing-plan.md.
  subagentRouting: 'on',
  subagents: {
    types: { Explore: 'haiku', Plan: CLASSIFY, 'general-purpose': CLASSIFY },
    light: 'haiku',
    standard: 'sonnet',
    heavy: 'opus',
    // The classifier's probability of `high` a task needs to run on `heavy`.
    heavyMass: 0.8,
  },
  // `id` selects the native model. List prices in USD per million tokens; `cacheRead` is absolute,
  // not a multiplier (Opus 5.5 reads at 0.05x input, the rest at the standard 0.1x). `longContext` multiplies every
  // rate of a request whose prompt (input, cache read and cache write) is over `above` tokens: Haiku 5.5 lists its
  // rates for prompts up to 100,000 tokens and 5x above. A price change must also change
  // test/fixtures/list-prices.json, with its source and date. `output` feeds the downgrade tax.
  // `efforts` lists what the model accepts; an empty list means no effort field and no adaptive thinking. A change
  // must also change test/fixtures/effort-support.json, from a new probe against the real API.
  models: {
    opus: {
      id: 'claude-opus-5-5',
      input: 4,
      output: 20,
      cacheRead: 0.2,
      contextWindow: 1_000_000,
      billing: 'plan',
      efforts: EFFORTS,
    },
    sonnet: {
      id: 'claude-sonnet-5-5',
      input: 2,
      output: 10,
      cacheRead: 0.2,
      contextWindow: 1_000_000,
      billing: 'plan',
      efforts: EFFORTS,
    },
    haiku: {
      id: 'claude-haiku-5-5',
      input: 0.1,
      output: 0.5,
      cacheRead: 0.01,
      longContext: { above: 100_000, multiplier: 5 },
      contextWindow: 1_000_000,
      billing: 'plan',
      efforts: EFFORTS,
    },
  },
  cache: {
    writeMultiplier: { '5m': 1.25, '1h': 2 },
    ttlMs: { '5m': 300_000, '1h': 3_600_000 },
    warmMarginMs: 30_000,
  },
  policy: {
    upgradeVotes: 2,
    upgradeBase: 0.75,
    upgradeSlope: 0.15,
    upgradePivotUsd: 0.5, // tax at which half the slope applies: $0.20 of tax raises the bar to ~0.79, $4 to ~0.88
    jumpConfidence: 0.95,
    downgradeVotes: 2,
    downgradeMass: 0.9,
    downgradeSlope: 0.08, // a cold candidate raises the bar toward ~0.98, same shape as the upgrade bar
    downgradePivotUsd: 0.5,
    downgradeHorizonTurns: 5, // turns whose output and read savings offset a downgrade's cache write
    continuationMass: 0.7,
    escalationHoldTurns: 2,
    // Inside a turn the classifier is asked again every this many requests, in the background; 0 turns it off. The
    // answer applies at a later step, so a step never waits for it. Not tuned yet.
    reviewEveryRequests: 4,
    // A move to a cheaper route on the same task waits this many requests after the last model change, and for a
    // verification command (tests, build, lint) that passed since then. Not tuned yet.
    minDwellRequests: 8,
    // Ceiling on a cold cache write to a `credits` model. No default model bills credits, so this is
    // inert until a user adds one in router.json; a Claude Code turn starts near 100k tokens.
    cashCapUsd: 2,
    // An activity applies only above this probability; below it a new task goes back to the base route. Not tuned on any
    // classifier yet: the probe results record whether the label was right, not its probability.
    activityMass: 0.6,
  },
  // The active entry of `classifiers`. `api` names the wire protocol (CLASSIFIER_APIS); a user entry without one speaks
  // `system-one`. `keyOption` names the plugin option that holds the bearer key, or null for no key (a local server);
  // a `{name}` in `endpoint` is filled from the plugin option of that name. Both must be in CLASSIFIER_OPTIONS.
  // Cloudflare wraps the System One answer in `result`; the parser reads both shapes.
  classifier: 'jev',
  classifiers: {
    jev: {
      label: 'Jev',
      api: 'system-one',
      endpoint: 'https://api.typesafe.ai/v1/systemone',
      model: 'jev-1.13.0',
      keyOption: 'typesafe_api_key',
      timeoutMs: 1500,
    },
    clef: {
      label: 'Clef',
      api: 'system-one',
      endpoint: 'https://api.cloudflare.com/client/v4/accounts/{cloudflare_account_id}/ai/run/@cf/cloudflare/clef',
      model: 'clef',
      keyOption: 'cloudflare_api_token',
      timeoutMs: 3000,
    },
    'clef-flash': {
      label: 'Clef Flash',
      api: 'system-one',
      endpoint:
        'https://api.cloudflare.com/client/v4/accounts/{cloudflare_account_id}/ai/run/@cf/cloudflare/clef-flash',
      model: 'clef-flash',
      keyOption: 'cloudflare_api_token',
      timeoutMs: 3000,
    },
    openai: {
      label: 'OpenAI',
      api: 'openai-decisions',
      endpoint: 'https://api.openai.com/v1/decisions',
      model: 'gpt-6-luna',
      keyOption: 'openai_api_key',
      timeoutMs: 3000,
    },
    // Ollama runs on this machine: no key, and the prompt text stays local. `model` is any tag you have pulled.
    // Its first token is read with `think: false`; thinking models otherwise spend it on reasoning text.
    ollama: {
      label: 'Ollama',
      api: 'ollama',
      endpoint: 'http://127.0.0.1:11434/api/chat',
      model: 'qwen3.5:9b',
      keyOption: null,
      timeoutMs: 5000,
    },
  },
  context: { recentTurns: 6, maxTextChars: 1200 },
};

// Keys a route, a model or a classifier entry may carry. The other closed sections take their key sets from DEFAULTS.
const ROUTE_KEYS = ['model', 'effort'];
const MODEL_KEYS = ['id', 'input', 'output', 'cacheRead', 'longContext', 'contextWindow', 'billing', 'efforts'];
const CLASSIFIER_KEYS = ['label', 'api', 'endpoint', 'model', 'keyOption', 'timeoutMs'];
// The wire protocols a classifier can speak. Each has an adapter in classifier-apis.mjs; a test keeps the two in step.
export const CLASSIFIER_APIS = ['system-one', 'openai-decisions', 'ollama'];
// The plugin options a classifier can read, the userConfig fields of plugin.json, with what each holds as the pane
// names it. The engine lets a Mod read only declared options and literally named environment variables, so a
// classifier cannot name a setting of its own.
export const CLASSIFIER_OPTIONS = {
  typesafe_api_key: 'API key',
  cloudflare_api_token: 'API token',
  cloudflare_account_id: 'account ID',
  openai_api_key: 'API key',
};
const OPTION_NAMES = Object.keys(CLASSIFIER_OPTIONS);
// A JSON file can hold these as own keys; merged into a plain object they reach the prototype chain.
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
export const MIGRATION_HINT =
  'run node scripts/migrate-config.mjs /path/to/router.json from the router plugin directory';

export function loadConfig({ userFile = null } = {}) {
  if (userFile !== null) checkShape(userFile);
  const merged = merge(DEFAULTS, withoutShadow(userFile ?? {}));
  // A user entry without `api` speaks the System One protocol that every entry spoke before 1.5.
  const config = {
    ...merged,
    classifiers: Object.fromEntries(
      Object.entries(merged.classifiers).map(([id, entry]) => [id, { api: 'system-one', ...entry }]),
    ),
  };
  validate(config);
  return config;
}

export function activeClassifier(config) {
  return config.classifiers[config.classifier];
}

// The `{name}` placeholders of an endpoint, in order.
export function endpointSettings(endpoint) {
  return [...endpoint.matchAll(/\{([a-z][a-z0-9_]*)\}/g)].map((match) => match[1]);
}

// The router.json `file` with `id` as the active classifier; the default is written as no key at all.
export function withClassifier(file, id) {
  const { classifier: _, ...rest } = file;
  return id === DEFAULTS.classifier ? rest : { ...rest, classifier: id };
}

export const sameRoute = (a, b) => a.model === b.model && (a.effort ?? null) === (b.effort ?? null);

// A route draft carries `base`, the routes and baseline it was made from. A tier counts as edited when it differs
// from its base; everything else follows `current`, so a change saved elsewhere meanwhile is neither shown stale
// nor written back.
export function effectiveRoutes(draft, current) {
  const { base } = draft;
  return {
    routes: Object.fromEntries(
      TIERS.map((tier) => [
        tier,
        sameRoute(draft.routes[tier], base.routes[tier]) ? current.routes[tier] : draft.routes[tier],
      ]),
    ),
    baselineTier: draft.baselineTier === base.baselineTier ? current.baselineTier : draft.baselineTier,
  };
}

// The router.json `file` with the tiers and baseline the person edited in `draft`; everything else stays as the
// file has it now, so an edit made on disk meanwhile survives. Only differences from DEFAULTS are written, so a later
// change of a default still reaches tiers the user never edited; a route equal to the default is removed.
export function withRoutes(file, draft) {
  const { base } = draft;
  const { routes: kept = {}, baselineTier: keptBaseline, ...rest } = file;
  const routes = {};
  for (const tier of TIERS) {
    if (sameRoute(draft.routes[tier], base.routes[tier])) {
      // Untouched here: keep the file's own entry verbatim, so an inherited effort stays inherited.
      if (kept[tier]) routes[tier] = kept[tier];
      continue;
    }
    const { model, effort = null } = draft.routes[tier];
    const preset = DEFAULTS.routes[tier];
    if (model === preset.model && effort === (preset.effort ?? null)) continue;
    routes[tier] = { model, effort };
  }
  const baseline =
    draft.baselineTier === base.baselineTier
      ? keptBaseline
      : draft.baselineTier === DEFAULTS.baselineTier
        ? undefined
        : draft.baselineTier;
  return {
    ...rest,
    ...(Object.keys(routes).length ? { routes } : {}),
    ...(baseline === undefined ? {} : { baselineTier: baseline }),
  };
}

// Activity cells are sparse: a missing field inherits the tier's route, so `effort: undefined` and `effort: null`
// differ. A null or missing cell is no override.
export const sameCell = (a, b) => (a && b ? a.model === b.model && a.effort === b.effort : !a === !b);
const cellOf = (activities, activity, tier) => activities?.[activity]?.[tier];

// The activity side of a route draft, with the effectiveRoutes rule: a cell or the mode counts as edited when it
// differs from the draft's `base`; everything else follows `current`. A draft built without `activities` or
// `activityRouting` edits none. A null cell is a removed override.
export function effectiveActivities(draft, current) {
  const { base } = draft;
  const activityRouting =
    draft.activityRouting === undefined || draft.activityRouting === base.activityRouting
      ? current.activityRouting
      : draft.activityRouting;
  if (!draft.activities) return { activities: current.activities, activityRouting };
  const activities = {};
  for (const activity of ACTIVITIES) {
    for (const tier of TIERS) {
      const edited = cellOf(draft.activities, activity, tier);
      const cell = sameCell(edited, cellOf(base.activities, activity, tier))
        ? cellOf(current.activities, activity, tier)
        : edited;
      if (cell) activities[activity] = { ...activities[activity], [tier]: cell };
    }
  }
  return { activities, activityRouting };
}

// The route draft after a pane edit of cell (activity, tier): `kind` is 'model' (value: alias), 'effort' (value:
// effort or null), 'add' or 'remove'. A model change keeps the effort when the new model accepts it, as for routes.
// An added cell starts from the built-in override, so re-adding a removed default restores it, else from the base
// route, which the pane flags as having no effect until edited. An edit that lands on the route the saved cell
// already resolves to is the saved cell, so a partial cell is not rewritten with the fields it inherits.
export function editActivity(draft, current, activity, tier, kind, value = null) {
  const config = { ...current, ...effectiveRoutes(draft, current), ...effectiveActivities(draft, current) };
  const route = resolveRoute(config, tier, activity);
  let cell = {
    model: () => ({ model: value, effort: config.models[value]?.efforts.includes(route.effort) ? route.effort : null }),
    effort: () => ({ model: route.model, effort: value }),
    add: () => ({ ...(cellOf(DEFAULTS.activities, activity, tier) ?? resolveRoute(config, tier)) }),
    remove: () => null,
  }[kind]();
  const saved = cellOf(draft.base.activities, activity, tier);
  const at = (c) => resolveRoute({ ...config, activities: { [activity]: { [tier]: c } } }, tier, activity);
  if (cell && saved && sameRoute(at(cell), at(saved))) cell = { ...saved };
  const activities = draft.activities ?? draft.base.activities;
  return { ...draft, activities: { ...activities, [activity]: { ...activities[activity], [tier]: cell } } };
}

// The router.json `file` with the activity cells and mode the person edited in `draft`; untouched cells stay as the
// file has them. Only differences from DEFAULTS are written. A removed built-in override is written as the tier's
// route in `file` (the merge would bring the built-in back otherwise), so call this after withRoutes.
export function withActivities(file, draft) {
  const { base } = draft;
  const { activities: kept = {}, activityRouting: keptMode, ...rest } = withoutShadow(file);
  const activities = {};
  for (const activity of ACTIVITIES) {
    for (const tier of TIERS) {
      const cell = cellOf(draft.activities, activity, tier);
      const preset = cellOf(DEFAULTS.activities, activity, tier);
      let written;
      if (!draft.activities || sameCell(cell, cellOf(base.activities, activity, tier)))
        written = cellOf(kept, activity, tier);
      else if (cell) written = sameCell(cell, preset) ? undefined : cell;
      else if (preset) {
        const route = { ...DEFAULTS.routes[tier], ...file.routes?.[tier] };
        written = { model: route.model, effort: route.effort ?? null };
      }
      if (written) activities[activity] = { ...activities[activity], [tier]: written };
    }
  }
  const mode =
    draft.activityRouting === undefined || draft.activityRouting === base.activityRouting
      ? keptMode
      : draft.activityRouting === DEFAULTS.activityRouting
        ? undefined
        : draft.activityRouting;
  return {
    ...rest,
    ...(Object.keys(activities).length ? { activities } : {}),
    ...(mode === undefined ? {} : { activityRouting: mode }),
  };
}

// The pane's policy controls and the router.json fields they stand for. The classifier deadline saves on its own.
const TUNING_FIELDS = {
  downgradeVotes: ['policy', 'downgradeVotes'],
  horizon: ['policy', 'downgradeHorizonTurns'],
  cashCapUsd: ['policy', 'cashCapUsd'],
  activityMass: ['policy', 'activityMass'],
};

export function tuningOf(config) {
  return Object.fromEntries(
    Object.entries(TUNING_FIELDS).map(([key, [section, field]]) => [key, config[section][field]]),
  );
}

// The router.json `file` with only the tuning values the person changed in `draft` against `saved`. A value equal to
// the default is written as no key, and a section left empty is dropped, as for routes and deadlines.
export function withTuning(file, draft, saved) {
  let next = file;
  for (const [key, [section, field]] of Object.entries(TUNING_FIELDS)) {
    if (draft[key] === saved[key]) continue;
    const { [field]: _, ...kept } = next[section] ?? {};
    const entry = draft[key] === DEFAULTS[section][field] ? kept : { ...kept, [field]: draft[key] };
    const { [section]: __, ...rest } = next;
    next = Object.keys(entry).length ? { ...rest, [section]: entry } : rest;
  }
  return next;
}

// The router.json `file` with classifier `id` given `timeoutMs`. A built-in classifier's default deadline is written
// as no override, and an entry or section left empty is dropped, so a later change of the default still reaches it.
export function withClassifierTimeout(file, id, timeoutMs) {
  const { classifiers = {}, ...rest } = file;
  const { [id]: current = {}, ...others } = classifiers;
  const { timeoutMs: _, ...entry } = current;
  const isDefault = Object.hasOwn(DEFAULTS.classifiers, id) && DEFAULTS.classifiers[id].timeoutMs === timeoutMs;
  const kept = isDefault ? entry : { ...entry, timeoutMs };
  const next = Object.keys(kept).length ? { ...others, [id]: kept } : others;
  return Object.keys(next).length ? { ...rest, classifiers: next } : rest;
}

export function rank(tier) {
  return TIERS.indexOf(tier);
}

// The (model, effort) a tier runs on for an activity: the tier's route with that activity's sparse override on top.
// A null activity (off, uncertain, failed) resolves to the tier's route.
export function resolveRoute(config, tier, activity = null) {
  const route = { ...config.routes[tier], ...config.activities?.[activity]?.[tier] };
  return { model: route.model, effort: route.effort ?? null };
}

// The model entry a route runs on.
export const routeSpec = (config, route) => config.models[route.model];

// Whether a Claude Code version, such as 2.1.289 or a 2.1.290-beta build, runs the router: 2.1.289 or newer.
export function supportedVersion(version) {
  const parts = /^(\d+)\.(\d+)\.(\d+)(?:$|-)/.exec(version ?? '');
  if (!parts) return false;
  const [major, minor, patch] = parts.slice(1).map(Number);
  return major > 2 || (major === 2 && (minor > 1 || (minor === 1 && patch >= 289)));
}

function merge(base, override) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return override;
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] =
      Object.hasOwn(base, key) && typeof value === 'object' && value !== null && !Array.isArray(value)
        ? merge(base[key], value)
        : value;
  }
  return out;
}

// The 0.8 gateway layout: these keys only existed there.
export const isGatewayLayout = (file) =>
  Object.hasOwn(file, 'gateway') ||
  Object.hasOwn(file, 'log') ||
  Object.values(file.models ?? {}).some(
    (model) => model && (Object.hasOwn(model, 'features') || Object.hasOwn(model, 'maxOutput')),
  );

// The raw file, before the merge: only known keys, and every section an object. Messages name the path, never the
// value. An open map (model aliases, cache TTL labels) takes any key but the forbidden ones.
function checkShape(file) {
  if (file && typeof file === 'object' && isGatewayLayout(file))
    throw new Error(`router.json uses gateway settings; ${MIGRATION_HINT}`);
  if (file && typeof file === 'object' && Object.hasOwn(file, 'jev'))
    throw new Error(`router.json uses the 1.1 jev section; ${MIGRATION_HINT}`);
  checkObject(file, 'router.json', Object.keys(DEFAULTS));
  const { routes, activities, models, cache, policy, classifiers, context, subagents } = file;
  if (routes !== undefined) {
    checkObject(routes, 'routes', TIERS);
    for (const [tier, route] of Object.entries(routes)) checkObject(route, `routes.${tier}`, ROUTE_KEYS);
  }
  if (activities !== undefined) {
    checkObject(activities, 'activities', ACTIVITIES);
    for (const [activity, tiers] of Object.entries(activities)) {
      checkObject(tiers, `activities.${activity}`, TIERS);
      for (const [tier, route] of Object.entries(tiers))
        checkObject(route, `activities.${activity}.${tier}`, ROUTE_KEYS);
    }
  }
  if (models !== undefined) {
    checkObject(models, 'models');
    for (const [alias, model] of Object.entries(models)) {
      checkObject(model, `models.${alias}`, MODEL_KEYS);
      // null removes a built-in surcharge.
      if (model.longContext != null)
        checkObject(model.longContext, `models.${alias}.longContext`, ['above', 'multiplier']);
    }
  }
  if (cache !== undefined) {
    checkObject(cache, 'cache', Object.keys(DEFAULTS.cache));
    for (const map of ['writeMultiplier', 'ttlMs'])
      if (cache[map] !== undefined) checkObject(cache[map], `cache.${map}`);
  }
  if (policy !== undefined) checkObject(policy, 'policy', Object.keys(DEFAULTS.policy));
  if (classifiers !== undefined) {
    checkObject(classifiers, 'classifiers');
    for (const [id, entry] of Object.entries(classifiers)) checkObject(entry, `classifiers.${id}`, CLASSIFIER_KEYS);
  }
  if (context !== undefined) checkObject(context, 'context', Object.keys(DEFAULTS.context));
  if (subagents !== undefined) {
    checkObject(subagents, 'subagents', Object.keys(DEFAULTS.subagents));
    if (subagents.types !== undefined) checkObject(subagents.types, 'subagents.types');
  }
}

// `allowed` null: an open map.
function checkObject(value, path, allowed = null) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${path} must be an object`);
  for (const key of Object.keys(value)) {
    const at = path === 'router.json' ? key : `${path}.${key}`;
    if (FORBIDDEN_KEYS.has(key)) throw new Error(`${at} is not allowed`);
    if (allowed && !allowed.includes(key)) throw new Error(`${at} is not a known key`);
  }
}

const isNumber = (value, min, { above = false, integer = false } = {}) =>
  Number.isFinite(value) && (above ? value > min : value >= min) && (!integer || Number.isInteger(value));

function validate(config) {
  for (const tier of TIERS) {
    const route = config.routes[tier];
    if (!route || typeof route.model !== 'string') throw new Error(`routes.${tier}.model is required`);
    if (!Object.hasOwn(config.models, route.model)) throw new Error(`routes.${tier}.model is not in models`);
    // null keeps the session effort; it is how a file overrides a default route that names one.
    if (route.effort != null && !EFFORTS.includes(route.effort))
      throw new Error(`routes.${tier}.effort must be one of ${EFFORTS.join(', ')} or null`);
  }
  if (!ACTIVITY_MODES.includes(config.activityRouting))
    throw new Error(`activityRouting must be one of ${ACTIVITY_MODES.join(', ')}`);
  for (const [activity, tiers] of Object.entries(config.activities)) {
    for (const [tier, { model, effort }] of Object.entries(tiers)) {
      const at = `activities.${activity}.${tier}`;
      if (model !== undefined && !(typeof model === 'string' && Object.hasOwn(config.models, model)))
        throw new Error(`${at}.model is not in models`);
      if (effort != null && !EFFORTS.includes(effort))
        throw new Error(`${at}.effort must be one of ${EFFORTS.join(', ')} or null`);
    }
  }
  for (const [alias, model] of Object.entries(config.models)) validateModel(`models.${alias}`, model);
  if (!TIERS.includes(config.baselineTier)) throw new Error(`baselineTier must be one of ${TIERS.join(', ')}`);
  const p = config.policy;
  for (const field of ['upgradeBase', 'jumpConfidence', 'downgradeMass', 'continuationMass', 'activityMass']) {
    if (!(isNumber(p[field], 0) && p[field] <= 1)) throw new Error(`policy.${field} must be between 0 and 1`);
  }
  for (const field of ['upgradeVotes', 'downgradeVotes', 'downgradeHorizonTurns', 'escalationHoldTurns']) {
    if (!isNumber(p[field], 1, { integer: true })) throw new Error(`policy.${field} must be a positive integer`);
  }
  for (const field of ['reviewEveryRequests', 'minDwellRequests']) {
    if (!isNumber(p[field], 0, { integer: true })) throw new Error(`policy.${field} must be a non-negative integer`);
  }
  // The pivot divides: tax / (tax + pivot). Zero makes a free switch NaN and silently stops that switch.
  for (const side of ['upgrade', 'downgrade']) {
    if (!isNumber(p[`${side}Slope`], 0)) throw new Error(`policy.${side}Slope must be a non-negative number`);
    if (!isNumber(p[`${side}PivotUsd`], 0, { above: true })) throw new Error(`policy.${side}PivotUsd must be positive`);
  }
  if (!isNumber(p.cashCapUsd, 0)) throw new Error('policy.cashCapUsd must be a non-negative number');
  const { cache, context } = config;
  for (const map of ['writeMultiplier', 'ttlMs']) {
    for (const [ttl, value] of Object.entries(cache[map]))
      if (!isNumber(value, 0, { above: true })) throw new Error(`cache.${map}.${ttl} must be positive`);
  }
  if (!isNumber(cache.warmMarginMs, 0)) throw new Error('cache.warmMarginMs must be a non-negative number');
  for (const [id, entry] of Object.entries(config.classifiers)) validateClassifier(`classifiers.${id}`, entry);
  if (typeof config.classifier !== 'string' || !Object.hasOwn(config.classifiers, config.classifier))
    throw new Error('classifier is not in classifiers');
  if (!SUBAGENT_MODES.includes(config.subagentRouting))
    throw new Error(`subagentRouting must be one of ${SUBAGENT_MODES.join(', ')}`);
  const { subagents } = config;
  for (const [type, route] of Object.entries(subagents.types)) {
    if (route !== null && route !== CLASSIFY && !(typeof route === 'string' && Object.hasOwn(config.models, route)))
      throw new Error(`subagents.types.${type} must be a models key, ${CLASSIFY} or null`);
  }
  for (const field of ['light', 'standard', 'heavy']) {
    if (!(typeof subagents[field] === 'string' && Object.hasOwn(config.models, subagents[field])))
      throw new Error(`subagents.${field} is not in models`);
  }
  if (!(isNumber(subagents.heavyMass, 0) && subagents.heavyMass <= 1))
    throw new Error('subagents.heavyMass must be between 0 and 1');
  for (const field of ['recentTurns', 'maxTextChars']) {
    if (!isNumber(context[field], 1, { integer: true })) throw new Error(`context.${field} must be a positive integer`);
  }
}

function validateModel(at, model) {
  for (const field of ['input', 'cacheRead', 'contextWindow']) {
    if (!Number.isFinite(model[field]) || model[field] < 0)
      throw new Error(`${at}.${field} must be a non-negative number`);
  }
  if (model.output !== undefined && !(Number.isFinite(model.output) && model.output >= 0))
    throw new Error(`${at}.output must be a non-negative number`);
  if (model.longContext != null) {
    const { above, multiplier } = model.longContext;
    if (!isNumber(above, 0, { above: true, integer: true }))
      throw new Error(`${at}.longContext.above must be a positive integer`);
    if (!isNumber(multiplier, 0, { above: true })) throw new Error(`${at}.longContext.multiplier must be positive`);
  }
  if (typeof model.id !== 'string' || !model.id) throw new Error(`${at}.id is required`);
  if (!['plan', 'credits'].includes(model.billing)) throw new Error(`${at}.billing must be plan or credits`);
  if (!Array.isArray(model.efforts) || model.efforts.some((e) => !EFFORTS.includes(e)))
    throw new Error(`${at}.efforts must list valid effort levels`);
}

function validateClassifier(at, entry) {
  for (const field of ['label', 'endpoint', 'model']) {
    if (typeof entry[field] !== 'string' || !entry[field]) throw new Error(`${at}.${field} is required`);
  }
  if (!CLASSIFIER_APIS.includes(entry.api)) throw new Error(`${at}.api must be one of ${CLASSIFIER_APIS.join(', ')}`);
  // The bearer key travels with the request: plain http only to this machine, as the test stubs use.
  if (!/^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\/)/.test(entry.endpoint))
    throw new Error(`${at}.endpoint must be an https URL, or http on localhost`);
  // Only `{name}` placeholders: a stray brace would reach the network as part of the URL.
  if (/[{}]/.test(entry.endpoint.replace(/\{[a-z][a-z0-9_]*\}/g, '')))
    throw new Error(`${at}.endpoint placeholders must look like {lower_snake_case}`);
  if (endpointSettings(entry.endpoint).some((name) => !OPTION_NAMES.includes(name)))
    throw new Error(`${at}.endpoint placeholders must be one of ${OPTION_NAMES.join(', ')}`);
  if (entry.keyOption !== null && !OPTION_NAMES.includes(entry.keyOption))
    throw new Error(`${at}.keyOption must be null or one of ${OPTION_NAMES.join(', ')}`);
  if (!isNumber(entry.timeoutMs, 0, { above: true })) throw new Error(`${at}.timeoutMs must be positive`);
}

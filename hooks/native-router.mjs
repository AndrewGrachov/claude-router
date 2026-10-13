import {
  advanceDown,
  advanceRun,
  emptyMetrics,
  emptySession,
  emptyStore,
  METRICS_PREFIX,
  mergeMetrics,
  mergeStores,
  metricsAfterReset,
  readMetrics,
  readStore,
  recordMetrics,
  recordStore,
  recordTurn,
  STORE_KEY,
  STORE_PREFIX,
  storeAfterReset,
  turnActivity,
} from '../lib/activity-stats.mjs';
import { renderBand, switchToast } from '../lib/band.mjs';
import { ClassifierClient } from '../lib/classifier-client.mjs';
import { resolveCredentials } from '../lib/classifier-contract.mjs';
import {
  ACTIVITY_MODES,
  activeClassifier,
  CLASSIFY,
  DEFAULTS,
  editActivity,
  effectiveActivities,
  effectiveRoutes,
  loadConfig,
  MIGRATION_HINT,
  supportedVersion,
  TIERS,
  tuningOf,
  withActivities,
  withClassifier,
  withClassifierTimeout,
  withRoutes,
  withTuning,
} from '../lib/config.mjs';
import { changedLeaves, notSaved, restored, rewrittenConfig } from '../lib/config-file.mjs';
import {
  activityDetailLines,
  classifierStatus,
  classifierTimed,
  GATEWAY_CLEANUP,
  GATEWAY_SETTINGS,
  missingCredentials,
  NOT_A_TIER_REASON,
  savingsLine,
  storeAgreementLine,
  unavailableReason,
} from '../lib/display.mjs';
import { clip, observedActivity, promptIndex } from '../lib/facts.mjs';
import { renderPanel, routeDraftOf, routingChanges } from '../lib/panel.mjs';
import {
  canMoveUp,
  cellForModel,
  chooseRoute,
  continueRoute,
  emptyLoop,
  isModelAllowed,
  isNativeFallback,
  isSameModel,
  nativeFacts,
  observedMove,
  observeResponse,
  prepareLoop,
  resetHistory,
} from '../lib/route.mjs';
import {
  addReplies,
  afterReset,
  compareModels,
  emptySavingsStore,
  mergeSavingsStores,
  modelAlias,
  modelEntry,
  modelSpec,
  readSavingsStore,
  SAVINGS_PREFIX,
  SAVINGS_RESET_KEY,
  sessionCacheTtl,
  subagentCacheTtl,
} from '../lib/savings.mjs';
import {
  addAgentReply,
  agentFrontmatter,
  classifiedAlias,
  coreModelOf,
  emptySubagentStore,
  flushedAgent,
  mergeSubagentStores,
  passReason,
  RESPAWN_WINDOW_MS,
  readSubagentStore,
  recordAgent,
  SPAWN_DEADLINE_MS,
  SUBAGENT_PREFIX,
  spawnPrompt,
  spawnRecord,
  subagentsAfterReset,
  typeRoute,
} from '../lib/subagents.mjs';
import {
  emptyUsage,
  mergeUsage,
  PERIOD_KEY,
  PERIODS,
  prunedUsage,
  readUsage,
  recordUsage,
  replyEntry,
  USAGE_PREFIX,
  usageAfterReset,
} from '../lib/usage.mjs';
import {
  CLEARED_READINGS,
  continuationView,
  healthOf,
  initialView,
  responseMetrics,
  switchView,
} from '../lib/view.mjs';

// The engine follows $ only into functions declared in this file, never across an import: every helper that takes $
// lives here, and the pure parts live in lib/.

const VIEW = { plugin: 'router', key: 'view' };
const LOOP = { plugin: 'router', key: 'loops' };
const PANE = 'jev-router';
const PANE_TITLE = 'Router';
const BAND_DETAIL = 'band:detail';
const MODE_PREFIX = 'mode:';
const isSet = (value) => /^(1|true|yes|on)$/i.test(String(value ?? '').trim());

// The counts kept across sessions: each session writes only its own record of a kind, `prefix` and its session id,
// because $.store has no atomic update; the view's `field` shows every session's record since the last reset added
// up, and `ownField`, where a kind has one, this session's alone. One marker, SAVINGS_RESET_KEY, resets them all.
// `legacy` is the key all sessions shared before 1.10.3: it counts as another session's record until a reset deletes
// it. Another session's records that `prune` names are deleted when read. `savings` is no longer written: its records
// are the undated totals from before `usage`, which the All period adds.
const LEDGERS = {
  usage: {
    prefix: USAGE_PREFIX,
    field: 'usageStore',
    ownField: 'usageSession',
    read: readUsage,
    afterReset: usageAfterReset,
    merge: mergeUsage,
    empty: emptyUsage,
    prune: prunedUsage,
  },
  savings: {
    prefix: SAVINGS_PREFIX,
    field: 'savingsStore',
    read: readSavingsStore,
    afterReset,
    merge: mergeSavingsStores,
    empty: emptySavingsStore,
  },
  metrics: {
    prefix: METRICS_PREFIX,
    field: 'activityMetrics',
    read: readMetrics,
    afterReset: metricsAfterReset,
    merge: mergeMetrics,
    empty: emptyMetrics,
  },
  subagents: {
    prefix: SUBAGENT_PREFIX,
    field: 'subagentStore',
    read: readSubagentStore,
    afterReset: subagentsAfterReset,
    merge: mergeSubagentStores,
    empty: emptySubagentStore,
  },
  activity: {
    prefix: STORE_PREFIX,
    legacy: STORE_KEY,
    field: 'activityStore',
    read: readStore,
    afterReset: storeAfterReset,
    merge: mergeStores,
    empty: emptyStore,
  },
};
const LEDGER_KINDS = Object.keys(LEDGERS);

// Everything the hooks change between events, in one object `register()` creates and passes to its helpers. Module
// variables, not $.state: a reload starts them over, and the view is written through to $.state as it changes.
function createRouter(options) {
  return {
    options,
    config: loadConfig(),
    // Each turn's config, fixed at turn.start, so a pane save mid-turn does not change the turn.
    turnConfigs: new Map(),
    // One client per classifier, each with its own breaker and in-flight slot: a turn that started under one
    // classifier finishes with it, and its answer, failures or pause never land on another.
    clients: new Map(),
    prompts: new Map(),
    decisions: new Map(),
    controllers: new Set(),
    turnControllers: new Map(),
    view: null,
    modes: new Map(),
    // Each routed turn's activity record until turn.complete adds it to the stats, and the session's open run of
    // one activity, flushed to the store when it ends.
    turnActivities: new Map(),
    // Each turn's classifier review in flight or answered (reviewMidTurn): `{ controller, generation, observedUpTo, answer }`.
    reviews: new Map(),
    run: null,
    // The route a cheaper activity move went to, while the turns stay on it (advanceDown); else null.
    afterDown: null,
    // Counts every switch to routing off; a turn compares it with its own start to see routing went off meanwhile.
    offSwitches: 0,
    // Each turn's routed replies (replyEntry) until turn.complete adds them to the session's usage record.
    turnUsage: new Map(),
    // The counts kept across sessions, by LEDGERS kind: this session's record (`own`, `{ sessionId, record }`), held
    // here so a refresh never reads it back from the store while a write of it is pending, and the sum of every other
    // session's (`others`), read on refresh. The view shows their sum.
    // `othersResetAt` is the reset marker the others were read under: a newer one means they are read again.
    ledgers: Object.fromEntries(
      Object.keys(LEDGERS).map((kind) => [kind, { own: null, others: null, othersResetAt: null }]),
    ),
    // Bumped by Reset activity stats, so a store write that read the counts before the reset skips.
    statsResets: 0,
    // Bumped by each pin press, and each pinned turn's count when its route was written: the pin is used up when the
    // first request goes out on that route, unless it was pressed again meanwhile.
    pinPresses: 0,
    turnPins: new Map(),
    // Each spawned agent's record by agentId (spawnRecord), and when each parent loop last finished an agent of a type,
    // for respawns.
    agents: new Map(),
    finished: new Map(),
    // Each agent type's definition frontmatter by provider and type, read once per session (agentDefinition).
    definitions: new Map(),
  };
}

function clientOf(router, id) {
  if (!router.clients.has(id)) router.clients.set(id, new ClassifierClient());
  return router.clients.get(id);
}

// `router.view` is a write-through cache of $.state, because state reads are frozen within one dispatch.
async function readView($, router) {
  return (await $.state.get(VIEW)).value ?? router.view ?? initialView(await $.session.model());
}

// Only a saved mode is cached: the engine can draw the band before session.start, and a cached fallback from that
// render would override the start rule.
async function modeOf($, router, fallback = 'auto') {
  const sessionId = await $.session.id();
  if (router.modes.has(sessionId)) return router.modes.get(sessionId);
  try {
    const saved = await $.store.get(`${MODE_PREFIX}${sessionId}`);
    if (saved !== 'manual' && saved !== 'auto') return fallback;
    router.modes.set(sessionId, saved);
    return saved;
  } catch {
    return 'manual';
  }
}

// A saved preference wins; a fresh session starts with routing on for a model some route runs (a tier's, or in `on` an
// activity override's), and off for any other.
async function startMode($, router, model) {
  const mode = await modeOf($, router, cellForModel(router.config, model) === null ? 'manual' : 'auto');
  router.modes.set(await $.session.id(), mode);
  return mode;
}

// A fresh Manual start on a non-tier model gets a reason the band can show; a saved mode carries none.
async function startView($, router, model) {
  const fresh = (await modeOf($, router, null)) === null;
  const mode = await startMode($, router, model);
  return fresh && mode === 'manual' ? { mode, reason: NOT_A_TIER_REASON } : { mode };
}

// The Usage tab's period as last chosen in any session; Session when none was or the store cannot be read.
async function periodOf($) {
  const saved = await $.store.get(PERIOD_KEY).catch(() => null);
  return PERIODS.includes(saved) ? saved : 'session';
}

async function rememberMode($, mode) {
  try {
    await $.store.set(`${MODE_PREFIX}${await $.session.id()}`, mode);
    return true;
  } catch {
    return false;
  }
}

async function updateView($, router, patch) {
  const value = router.view ?? (await readView($, router));
  router.view = { ...value, ...patch };
  // The session readout is against the model /model selects now, so a /model change shows the whole session against
  // the new one.
  if ('nativeModel' in patch || 'savingsBy' in patch)
    router.view.savings = modelEntry(router.view.savingsBy, modelAlias(router.config, router.view.nativeModel)) ?? null;
  await $.state.set(VIEW, router.view);
}

// This session's record of `kind`, read from the store once per session, and the last reset (ms) from any session,
// read each time: a Reset in another session empties a record held from before it.
async function ownRecord($, router, kind) {
  const { prefix, read, afterReset } = LEDGERS[kind];
  const held = router.ledgers[kind];
  const sessionId = await $.session.id();
  const resetAt = await $.store.get(SAVINGS_RESET_KEY);
  if (held.own?.sessionId !== sessionId) {
    const record = read(await $.store.get(`${prefix}${sessionId}`));
    // Another call may have read it meanwhile and a turn added to it: that one stands.
    if (held.own?.sessionId !== sessionId) held.own = { sessionId, record };
  }
  held.own.record = afterReset(held.own.record, resetAt);
  return { own: held.own, resetAt };
}

// Every other session's record of `kind` since the last reset, added up and held. `keys` is one $.store.keys() listing.
async function readOthers($, router, kind, { sessionId, resetAt, keys }) {
  const { prefix, legacy, merge, prune } = LEDGERS[kind];
  const own = `${prefix}${sessionId}`;
  const names = keys.filter((key) => (key.startsWith(prefix) && key !== own) || key === legacy);
  let values = await Promise.all(names.map((key) => $.store.get(key)));
  if (prune) {
    // An expired record holds nothing a period shows, a capped one only the oldest days; a session still running
    // writes its own again at its next turn.
    const gone = prune(
      names.map((key, i) => [key, values[i]]),
      Date.now(),
    );
    // Read again just before deleting: a session that wrote its record since keeps it, and it counts as written. The
    // window between the read and the delete stays, as $.store has no conditional delete; it needs that session's write
    // inside it. A record whose delete failed still counts.
    const deleted = new Set();
    // Every check settles before the merge, a failed read or delete included.
    await Promise.allSettled(
      [...gone].map(async (key) => {
        const i = names.indexOf(key);
        const current = await $.store.get(key);
        if (JSON.stringify(current) !== JSON.stringify(values[i])) values[i] = current;
        else {
          await $.store.delete(key);
          deleted.add(key);
        }
      }),
    );
    values = values.filter((_, i) => !deleted.has(names[i]));
  }
  const others = merge(values, resetAt);
  router.ledgers[kind] = { ...router.ledgers[kind], others, othersResetAt: resetAt ?? null };
}

// The view's sums of `kinds`, this session's record and the others', from what the router holds; a kind whose others
// were never read gives nothing.
function ledgerView(router, kinds = LEDGER_KINDS) {
  const patch = {};
  for (const kind of kinds) {
    const { others, own } = router.ledgers[kind];
    const { field, ownField, merge, empty } = LEDGERS[kind];
    if (!others) continue;
    patch[field] = merge([others, own?.record]);
    if (ownField) patch[ownField] = own?.record ?? empty();
  }
  return patch;
}

// Adds to this session's record of `kind` (`add(record, now)` returns the record itself when it adds nothing) and
// writes it. A record read before a Reset is never written back: the reset counter is compared after the reads. The
// record is added to in memory before the write, so a refresh during the write counts it once. True when the view
// may show the new sums: no reset ran meanwhile.
async function addToLedger($, router, kind, add) {
  const resets = router.statsResets;
  const { own, resetAt } = await ownRecord($, router, kind);
  const held = router.ledgers[kind];
  // The others held from before a reset in another session are read again: a record from before 1.10.3 has no
  // `since` to tell.
  if (!held.others || held.othersResetAt !== (resetAt ?? null))
    await readOthers($, router, kind, { sessionId: own.sessionId, resetAt, keys: await $.store.keys() });
  if (router.statsResets !== resets) return false;
  const record = add(own.record, Date.now());
  if (record !== own.record) {
    own.record = record;
    await $.store.set(`${LEDGERS[kind].prefix}${own.sessionId}`, record);
  }
  return router.statsResets === resets;
}

// The counts kept across sessions for the view, read when the session starts and the pane opens: another session
// may have added to them. A failed read keeps what the view has; it never breaks a turn or a render. The sums are
// taken from the router after the reads, so a turn that finished meanwhile counts once; a Reset meanwhile gives
// nothing, as the reset view stands.
async function storeView($, router) {
  const resets = router.statsResets;
  try {
    const keys = await $.store.keys();
    for (const kind of LEDGER_KINDS) {
      try {
        const { own, resetAt } = await ownRecord($, router, kind);
        await readOthers($, router, kind, { sessionId: own.sessionId, resetAt, keys });
      } catch {}
    }
  } catch {}
  return router.statsResets === resets ? ledgerView(router) : {};
}

// A notice answers the last press in the pane, so the pane opens without one; the last write keeps its Undo in the
// status bar.
async function openPane($, router) {
  await updateView($, router, { notice: null, confirmDelete: false, ...(await storeView($, router)) });
  await $.ui.open({ id: PANE, title: PANE_TITLE, focus: true, closeOnEscape: true });
}

async function changeMode($, router, mode) {
  const view = router.view ?? (await readView($, router));
  for (const controller of router.controllers) controller.abort();
  // Turns with routing off run on Claude's model, off the cheaper move's route: the escalation watch ends.
  if (mode === 'manual') {
    router.afterDown = null;
    router.offSwitches += 1;
  }
  router.modes.set(await $.session.id(), mode);
  const saved = await rememberMode($, mode);
  await updateView($, router, {
    mode,
    pendingPin: null,
    phase: view.phase === 'unavailable' ? 'unavailable' : mode === 'manual' ? 'manual' : 'ready',
    reason: mode === 'manual' ? 'routing off' : 'ready',
    ...(!saved ? { notice: 'Mode changed for this session. Resume preference could not be saved.' } : {}),
  });
}

async function setPin($, router, tier) {
  const view = router.view ?? (await readView($, router));
  if (view.phase === 'unavailable') return unavailableText(view);
  const mode = await modeOf($, router, view.mode);
  if (mode === 'manual') return 'Routing is off. Turn routing on before pinning a turn.';
  router.pinPresses += 1;
  await updateView($, router, { pendingPin: tier });
  return `${tier} pinned for the next turn and its tool continuations.`;
}

// `/router [auto|off|pin <tier>|activities <mode>]`; with no action, the pane, or the status text without a surface.
async function routerCommand($, router, args) {
  const [action, value] = args.trim().split(/\s+/);
  if (action === 'auto' || action === 'off') {
    const view = router.view ?? (await readView($, router));
    if (view.phase === 'unavailable') return { text: unavailableText(view) };
    await changeMode($, router, action === 'auto' ? 'auto' : 'manual');
    return { text: action === 'auto' ? 'Routing on.' : 'Routing off: Claude’s model is kept.' };
  }
  if (action === 'pin')
    return { text: TIERS.includes(value) ? await setPin($, router, value) : `Choose ${TIERS.join(', ')}.` };
  if (action === 'activities')
    return {
      text: ACTIVITY_MODES.includes(value)
        ? await setActivityRouting($, router, value)
        : `Choose activities ${ACTIVITY_MODES.join(', ')}.`,
    };
  const storedView = await readView($, router);
  const view = { ...storedView, mode: await modeOf($, router, storedView.mode) };
  if (!(await $.session.surfaces()).length) return { text: detailText(router.config, view) };
  await openPane($, router);
  return {};
}

// `/router activities <mode>`: the pane's write, so the file keeps the rest and Undo in the pane restores it.
async function setActivityRouting($, router, mode) {
  const view = router.view ?? (await readView($, router));
  if (view.phase === 'unavailable') return unavailableText(view);
  if (mode === router.config.activityRouting) return `Activity routing is already ${mode}.`;
  await paneActions($, router, view).activityRouting(mode);
  return router.view.notice;
}

// The environment variables that stand in for a classifier option: its upper-case name, then the one Claude Code
// exports for a plugin option. Spelled out because $.env.get takes literal names only. Cases: CLASSIFIER_OPTIONS.
async function envSettingOf($, name) {
  switch (name) {
    case 'typesafe_api_key':
      return (await $.env.get('TYPESAFE_API_KEY')) || (await $.env.get('CLAUDE_PLUGIN_OPTION_TYPESAFE_API_KEY'));
    case 'cloudflare_api_token':
      return (
        (await $.env.get('CLOUDFLARE_API_TOKEN')) || (await $.env.get('CLAUDE_PLUGIN_OPTION_CLOUDFLARE_API_TOKEN'))
      );
    case 'cloudflare_account_id':
      return (
        (await $.env.get('CLOUDFLARE_ACCOUNT_ID')) || (await $.env.get('CLAUDE_PLUGIN_OPTION_CLOUDFLARE_ACCOUNT_ID'))
      );
    case 'openai_api_key':
      return (await $.env.get('OPENAI_API_KEY')) || (await $.env.get('CLAUDE_PLUGIN_OPTION_OPENAI_API_KEY'));
    default:
      return null;
  }
}

// A plugin option, else its environment variables.
async function settingOf($, options, name) {
  const value = options[name];
  if (typeof value === 'string' && value.trim()) return value.trim();
  return ((await envSettingOf($, name)) ?? '').trim() || null;
}

// The credentials error, or null, of every configured classifier: the pane lists them all.
async function credentialsOf($, options, config) {
  const lookup = (name) => settingOf($, options, name);
  return Object.fromEntries(
    await Promise.all(
      Object.entries(config.classifiers).map(async ([id, entry]) => [
        id,
        (await resolveCredentials(entry, lookup)).missing,
      ]),
    ),
  );
}

// The host refuses $.command.run from a hook the turn is holding, so the secure key dialog opens from a timer.
function openKeySettings($) {
  $.clock.after(0, () => $.command.run({ command: 'plugin', args: `configure ${$.plugin.name}` }).catch(() => {}));
}

// Whether this session's provider gives each effort its own prompt cache (effortSharesCache in lib/cost.mjs): Amazon
// Bedrock, Google Cloud, Microsoft Foundry, a custom ANTHROPIC_BASE_URL (it may be a Claude apps gateway) or
// CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS. A HIPAA configuration is not visible to a Mod. $.env.get takes literal names.
async function effortSplitsCacheOf($) {
  const flags = [
    await $.env.get('CLAUDE_CODE_USE_BEDROCK'),
    await $.env.get('CLAUDE_CODE_USE_VERTEX'),
    await $.env.get('CLAUDE_CODE_USE_FOUNDRY'),
    await $.env.get('CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS'),
  ];
  return flags.some(isSet) || Boolean(await $.env.get('ANTHROPIC_BASE_URL'));
}

async function loadNativeConfig($) {
  for (const source of ['project', 'local']) {
    const settings = await $.settings.read({ source });
    if (settings.env && ['HOME', 'CLAUDE_CONFIG_DIR'].some((key) => Object.hasOwn(settings.env, key)))
      throw new Error('project settings cannot redirect the router profile');
  }
  const home = await $.env.get('HOME');
  const profile = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${home}/.claude`;
  const path = `${profile}/router.json`;
  const userFile = (await $.fs.exists(path)) ? JSON.parse(await $.fs.read(path)) : null;
  return { ...loadConfig({ userFile }), nativePath: path, effortSplitsCache: await effortSplitsCacheOf($) };
}

// Writes router.json through `change(previousFile)` once the result validates. Returns the new config or an error
// line for the pane; a failure leaves the file untouched.
async function saveConfig($, path, change) {
  try {
    if ((await $.fs.exists(path)) && (await $.fs.stat(path)).isLink)
      return { error: 'Not saved: router.json is a symlink. Edit its maintained source instead.' };
    const { config, text } = rewrittenConfig((await $.fs.exists(path)) ? await $.fs.read(path) : null, change);
    await $.fs.write(path, text);
    return { config: { ...config, nativePath: path, effortSplitsCache: await effortSplitsCacheOf($) } };
  } catch (error) {
    return { error: notSaved(error) };
  }
}

const unavailableText = (view) => `Routing unavailable: ${unavailableReason(view)}. Claude’s model is kept.`;

function detailText(config, view) {
  if (view.phase === 'unavailable')
    return [
      unavailableText(view),
      `Model: ${view.nativeModel}`,
      ...(view.error === GATEWAY_SETTINGS ? GATEWAY_CLEANUP : []),
    ].join('\n');
  const missing = missingCredentials(config, view, config.classifier);
  return [
    `Router — routing ${view.mode === 'auto' ? 'on' : 'off'}`,
    `Native model: ${view.nativeModel}`,
    `Selected: ${view.selectedModel ?? 'not selected'}`,
    `Observed: ${view.actualModel ?? 'no response yet'}`,
    `Reason: ${view.reason}`,
    ...activityDetailLines(config, view),
    storeAgreementLine(view),
    savingsLine(view),
    view.error || missing ? classifierStatus(config, view.error ?? missing) : `${activeClassifier(config).label} ready`,
    `Context: ${view.contextKnown ? `${view.contextTokens} tokens (estimate)` : 'unknown'}`,
    `Observed cache: ${view.cacheRead ?? 'unknown'} read, ${view.cacheWrite ?? 'unknown'} written tokens`,
    view.pendingPin ? `Next turn pin: ${view.pendingPin}` : 'No next-turn pin.',
    'Routing on picks a model for each turn. Routing off keeps Claude’s model. Pins serve one turn only.',
    'Cache lifetime is an estimate. Claude’s cost ledger owns session totals.',
  ].join('\n');
}

async function contextOf($, loop) {
  const previous = loop.lastRequest ? loop.lastRequest.tokens + loop.lastRequest.outputTokens : null;
  try {
    const usage = await $.session.usage({ breakdown: 'summary' });
    const estimate = usage.context.breakdown?.totalTokens;
    const observed = usage.context.tokens;
    const values = [previous, estimate, observed].filter((n) => Number.isFinite(n) && n >= 0);
    return { tokens: values.length ? Math.max(...values) : null, known: Number.isFinite(estimate) };
  } catch {
    return { tokens: previous, known: false };
  }
}

async function* passMain($, e, next, loop, version, nativeModel, reason, router) {
  // A turn routing did not choose is a turn on another route: it ends the watch for escalations after a cheaper
  // activity move, including one a turn started before routing was turned off mid-turn.
  if (reason === 'manual') router.afterDown = null;
  const ref = { ...LOOP, id: 'main' };
  const context = await contextOf($, loop);
  await updateView($, router, {
    nativeModel,
    selectedModel: e.model,
    effort: e.effort ?? null,
    reason,
    contextTokens: context.tokens,
    contextKnown: context.known,
  });
  const sessionId = await $.session.id();
  const response = yield* next(e);
  if (!next.signal.aborted && (await $.session.id()) === sessionId) {
    const observed = observeResponse(router.config, loop, {
      usage: response.usage,
      requestedModel: e.model,
      effort: e.effort ?? null,
      stopReason: response.stopReason,
      now: Date.now(),
    });
    // Routing chose nothing here, so the reply is not counted; your model's cache still follows it.
    const compared = await compareYours($, router, loop, response, e.effort ?? null, nativeModel);
    if (compared) observed.yoursBy = compared.states;
    const written = await $.state.set(ref, observed, { ifVersion: version });
    if (written.isSet) await updateView($, router, responseMetrics(router.view, response, null, Date.now()));
  }
  return response;
}

// One turn's classification and route, written to the loop at `loopVersion`: the loop and its new version, or null
// when the turn was aborted, left the session or Auto, or lost the write. `signal` is the step's: its abort cancels
// the classifier call. The pin is the one in `view`, the view as the step read it; it is used up only once the route
// is written, so a turn interrupted before then leaves it for the next.
async function decideTurn($, router, e, signal, step) {
  const { sessionId, view, cfg, loop, loopVersion, context, nativeModel, availableModels } = step;
  const ref = { ...LOOP, id: 'main' };
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal.addEventListener('abort', cancel, { once: true });
  router.controllers.add(controller);
  router.turnControllers.set(e.turnId, controller);
  const live = async () => !controller.signal.aborted && (await $.session.id()) === sessionId;
  try {
    const pin = view.pendingPin;
    const pinPresses = router.pinPresses;
    const [credentials, messages] = await Promise.all([
      resolveCredentials(activeClassifier(cfg), (name) => settingOf($, router.options, name)),
      $.session.messages({ as: 'api' }),
    ]);
    if (!(await live())) return null;
    const facts = nativeFacts(cfg, loop, {
      messages,
      prompt: router.prompts.get(e.turnId),
      effort: e.effort,
      turnId: e.turnId,
      contextTokens: context.tokens,
    });
    await updateView($, router, {
      phase: 'choosing',
      activeTurnId: e.turnId,
      nativeModel,
      credentials: { ...router.view?.credentials, [cfg.classifier]: credentials.missing },
    });
    const adviceStarted = Date.now();
    const result = pin
      ? { advice: null, error: null }
      : await clientOf(router, cfg.classifier).ask({
          request: (url, init) => $.http.fetch(url, init),
          sleep: (ms, args) => $.clock.sleep(ms, args),
          config: cfg,
          apiKey: credentials.apiKey,
          endpoint: credentials.endpoint,
          prompt: facts.prompt,
          turns: facts.turns,
          signal: controller.signal,
        });
    // The wait for advice alone, comparable with the activity probe's p95; the routing after it is not the classifier's.
    const adviceMs = pin || !classifierTimed(result.error) ? null : Date.now() - adviceStarted;
    if (controller.signal.aborted || (await $.session.id()) !== sessionId || (await modeOf($, router)) !== 'auto')
      return null;
    const previous = loop.decision;
    const selected = chooseRoute(cfg, loop, {
      facts,
      advice: result.advice,
      pin,
      nativeModel,
      contextKnown: context.known,
      availableModels,
      now: Date.now(),
    });
    selected.engineModel = e.model;
    const written = await $.state.set(ref, selected, { ifVersion: loopVersion });
    // The written route serves the turn's next steps, even if an abort lands now.
    if (written.isSet && pin) router.turnPins.set(e.turnId, pinPresses);
    // Manual, /clear and turn completion abort the controller; one may land during the write.
    if (!written.isSet || controller.signal.aborted) return null;
    if (previous?.model && previous.model !== selected.decision.model && !selected.decision.pinned)
      $.ui.toast(switchToast(cfg, previous, selected.decision, selected.decision.estimate));
    const activity = turnActivity(cfg, result.advice, previous, selected.decision);
    router.turnActivities.set(e.turnId, {
      ...activity,
      reason: selected.decision.reason,
      escalated: Boolean(selected.decision.escalated),
      pinned: selected.decision.pinned,
      route: `${selected.decision.model}@${selected.decision.effort ?? 'session'}`,
      classifier: cfg.classifier,
      offSwitches: router.offSwitches,
      adviceMs,
      sessionId,
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      routedUsd: null,
      pricedRequests: 0,
      routes: {},
    });
    await updateView($, router, {
      ...(activity.switched ? switchView(previous, selected.decision, activity.label, Date.now()) : {}),
      phase: 'routed',
      selectedModel: selected.decision.model,
      actualModel: null,
      tier: selected.decision.tier,
      effort: selected.decision.effort,
      reason: selected.decision.reason,
      activity: activity.label,
      contextTokens: context.tokens,
      contextKnown: context.known,
      comparison: selected.decision.comparison,
      // A turn that started before a classifier switch routes on its own classifier's answer, but the
      // pane now labels the new one: its readings stay off the view.
      ...(cfg.classifier === router.config.classifier
        ? {
            error: result.error,
            health: healthOf(clientOf(router, cfg.classifier), cfg.classifier),
            adviceMs,
            adviceChoice: result.advice?.choice ?? null,
            probabilities: result.advice?.probabilities ?? null,
            estimate: selected.decision.estimate ?? null,
            activityChoice: activity.predicted,
            activityProbabilities: result.advice?.activity?.probabilities ?? null,
          }
        : {}),
    });
    return { loop: selected, version: written.version };
  } finally {
    signal.removeEventListener('abort', cancel);
    router.controllers.delete(controller);
    if (router.turnControllers.get(e.turnId) === controller) router.turnControllers.delete(e.turnId);
  }
}

// Facts for a step of the running turn, read from the transcript as it is now.
function stepFacts(cfg, router, loop, e, messages, context) {
  return nativeFacts(cfg, loop, {
    messages,
    prompt: router.prompts.get(e.turnId),
    effort: e.effort,
    turnId: e.turnId,
    contextTokens: context.tokens,
  });
}

// The transcript, or null when it cannot be read: a continuation then keeps its route.
async function transcript($) {
  try {
    return await $.session.messages({ as: 'api' });
  } catch {
    return null;
  }
}

// The activity a route runs for, as the view labels it: only activity routing `on` applies one.
const activityLabel = (cfg, decision) => (cfg.activityRouting === 'on' ? (decision.activity ?? null) : null);

// A tool continuation whose turn shows stronger work than its route was chosen for moves up once (observedMove). Only
// tool calls after the last applied review count (`loop.observedFrom`): the review judged the ones before. The
// transcript is read only when some activity's route at this tier is stronger than the running one.
async function moveOnObserved($, router, cfg, loop, e, context) {
  if (!canMoveUp(cfg, loop.decision, e.effort)) return loop;
  const messages = await transcript($);
  if (!messages) return loop;
  const facts = stepFacts(cfg, router, loop, e, messages, context);
  const observed = observedActivity(messages, Math.max(promptIndex(messages), (loop.observedFrom ?? 0) - 1));
  const moved = observedMove(cfg, loop, { observed, facts, contextKnown: context.known, now: Date.now() });
  if (moved === loop) return loop;
  $.ui.toast(switchToast(cfg, loop.decision, moved.decision, moved.decision.estimate));
  // Replies from here on are labelled with the moved activity; the classifier's answer stays as recorded.
  const turn = router.turnActivities.get(e.turnId);
  if (turn) router.turnActivities.set(e.turnId, { ...turn, label: moved.decision.activity });
  await updateView($, router, {
    estimate: moved.decision.estimate ?? null,
    comparison: null,
    ...switchView(loop.decision, moved.decision, activityLabel(cfg, moved.decision), Date.now()),
  });
  return moved;
}

// Inside a turn the classifier is asked again every `policy.reviewEveryRequests` requests, in the background: a step
// never waits for it. The answer applies at the first step after it arrives, as a decision on the same task
// (sameTaskOf), so the tier and the activity can move either way: up on the usual votes, down only past the dwell and a
// passed verification. Pinned turns and a native fallback are left alone; a failed read or ask changes nothing.
async function reviewMidTurn($, router, cfg, loop, e, { context, nativeModel, availableModels }) {
  const review = router.reviews.get(e.turnId);
  if (review?.answer) {
    router.reviews.delete(e.turnId);
    // An answer about a history that compaction or a rewind replaced is dropped.
    if (!review.answer.advice || loop.decision?.pinned || review.generation !== loop.generation) return loop;
    // Only the advice is from the review; the checkpoint, context and cache facts are read now.
    const messages = await transcript($);
    if (!messages) return loop;
    const advice = review.answer.advice;
    const facts = { ...stepFacts(cfg, router, loop, e, messages, context), midTurn: true };
    const selected = chooseRoute(cfg, loop, {
      facts,
      advice,
      pin: null,
      nativeModel,
      contextKnown: context.known,
      availableModels,
      now: Date.now(),
    });
    const previous = loop.decision;
    if (previous && (previous.model !== selected.decision.model || previous.effort !== selected.decision.effort)) {
      $.ui.toast(switchToast(cfg, previous, selected.decision, selected.decision.estimate));
      const turn = router.turnActivities.get(e.turnId);
      if (turn) router.turnActivities.set(e.turnId, { ...turn, label: selected.decision.activity ?? null });
      await updateView(
        $,
        router,
        switchView(previous, selected.decision, activityLabel(cfg, selected.decision), Date.now()),
      );
    }
    // The pane shows the readings behind the route; a review by a classifier the pane no longer labels keeps them off.
    if (cfg.classifier === router.config.classifier)
      await updateView($, router, {
        comparison: selected.decision.comparison,
        adviceChoice: advice.choice ?? null,
        probabilities: advice.probabilities ?? null,
        estimate: selected.decision.estimate ?? null,
        activityChoice: advice.activity?.choice ?? null,
        activityProbabilities: advice.activity?.probabilities ?? null,
      });
    // Tool calls up to the review's snapshot were judged by it; later ones can still move the route up.
    return { ...selected, observedFrom: review.observedUpTo };
  }
  const every = cfg.policy.reviewEveryRequests;
  if (review || every === 0 || !loop.decision?.tier || loop.decision.pinned) return loop;
  if ((loop.requests ?? 0) - (loop.reviewedAt ?? 0) < every) return loop;
  const job = { controller: new AbortController(), generation: loop.generation, observedUpTo: 0, answer: null };
  router.reviews.set(e.turnId, job);
  try {
    const [credentials, messages] = await Promise.all([
      resolveCredentials(activeClassifier(cfg), (name) => settingOf($, router.options, name)),
      $.session.messages({ as: 'api' }),
    ]);
    job.observedUpTo = messages.length;
    const facts = stepFacts(cfg, router, loop, e, messages, context);
    clientOf(router, cfg.classifier)
      .ask({
        request: (url, init) => $.http.fetch(url, init),
        sleep: (ms, args) => $.clock.sleep(ms, args),
        config: cfg,
        apiKey: credentials.apiKey,
        endpoint: credentials.endpoint,
        prompt: facts.prompt,
        turns: facts.turns,
        signal: job.controller.signal,
      })
      .then((answer) => {
        if (router.reviews.get(e.turnId) === job) job.answer = answer;
      })
      .catch(() => {
        if (router.reviews.get(e.turnId) === job) router.reviews.delete(e.turnId);
      });
  } catch {
    router.reviews.delete(e.turnId);
    return loop;
  }
  return { ...loop, reviewedAt: loop.requests ?? 0 };
}

// A routed reply's metrics in the view, with the tier that served it, and added to the turn's activity record with its list price (`routedUsd`, null when unpriced) and, when its tier served it, its route.
async function publishReply($, router, turnId, response, tier, route, routedUsd) {
  const turn = router.turnActivities.get(turnId);
  const metrics = responseMetrics(router.view, response, tier, Date.now());
  await updateView($, router, metrics);
  if (turn)
    router.turnActivities.set(turnId, {
      ...turn,
      requests: turn.requests + 1,
      inputTokens: turn.inputTokens + (metrics.inputTokens ?? 0),
      outputTokens: turn.outputTokens + (metrics.outputTokens ?? 0),
      routedUsd: Number.isFinite(routedUsd) ? (turn.routedUsd ?? 0) + routedUsd : turn.routedUsd,
      pricedRequests: turn.pricedRequests + (Number.isFinite(routedUsd) ? 1 : 0),
      routes: tier ? { ...turn.routes, [route]: (turn.routes[route] ?? 0) + 1 } : turn.routes,
    });
}

// A routed reply written to the loop at `loopVersion`, then published: the view's metrics and the routing-vs-your-model
// totals. A lost write publishes nothing.
async function observeRouted($, router, { turnId, cfg, loop, loopVersion, request, response, nativeModel }) {
  // When the reply arrived: the awaits below can cross midnight or the hour it is kept under.
  const at = Date.now();
  const observed = observeResponse(cfg, loop, {
    usage: response.usage,
    requestedModel: request.model,
    effort: request.effort ?? null,
    stopReason: response.stopReason,
    now: at,
  });
  if (response.stopReason === null) observed.suspended = true;
  const compared = await compareYours($, router, loop, response, request.effort ?? null, nativeModel, cfg);
  if (compared) observed.yoursBy = compared.states;
  const written = await $.state.set({ ...LOOP, id: 'main' }, observed, { ifVersion: loopVersion });
  if (!written.isSet) return;
  // A substituted reply is not the tier's: the strip and trend must not count it as one.
  const tier = isSameModel(request.model, response.usage?.model) ? loop.decision.tier : null;
  const route = `${request.model}@${request.effort ?? 'session'}`;
  await publishReply($, router, turnId, response, tier, route, compared?.reply?.routedUsd ?? null);
  // Kept by model id, under the model that served it: a substitute's cost is not the requested model's, and a models
  // key can name another model later.
  const idOf = (model) => modelSpec(cfg, model)?.id ?? model;
  if (compared)
    await addSavings($, router, {
      turnId,
      compared,
      tier,
      route: `${idOf(response.usage?.model ?? request.model)}@${request.effort ?? 'session'}`,
      yours: idOf(nativeModel),
      byId: Object.fromEntries(Object.entries(compared.replies).map(([alias, r]) => [cfg.models[alias].id, r])),
      usage: response.usage,
      at,
    });
}

// The main conversation's prompt-cache lifetime by Claude Code's rule (sessionCacheTtl), or null when a reading
// fails. $.env.get takes literal names only. A plan subscriber is one whose replies report plan rate limits; a usage
// without them is not one.
async function cacheTtlOf($) {
  try {
    const settings = await $.settings.read();
    const usage = await $.session.usage();
    return sessionCacheTtl({
      force5m: await $.env.get('FORCE_PROMPT_CACHING_5M'),
      envTtl: await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL'),
      settingTtl: settings.promptCacheTtl,
      enable1h: await $.env.get('ENABLE_PROMPT_CACHING_1H'),
      subscriber: (usage?.rateLimits ?? []).some((limit) => limit.kind === 'five_hour' || limit.kind === 'seven_day'),
    });
  } catch {
    return null;
  }
}

// A main reply against every configured model (compareModels): the loop's next states, the reply's prices by models
// key, and `reply`, its prices against your model now, or null. The readout never breaks a turn. A reply whose cache
// lifetime cannot be read still moves the models' caches and is not counted; any other failure leaves the loop's
// states and the totals as they were.
async function compareYours($, router, loop, response, servedEffort, nativeModel, cfg = router.config) {
  try {
    if (!response.usage?.model) return null;
    const view = router.view ?? (await readView($, router));
    return compareModels(cfg, loop.yoursBy ?? {}, {
      usage: response.usage,
      served: { model: response.usage.model, effort: servedEffort },
      effort: view.nativeEffort ?? null,
      ttl: await cacheTtlOf($),
      now: Date.now(),
      yours: nativeModel,
    });
  } catch {
    return null;
  }
}

// A routed reply's prices added to each model's session totals in the view, and the reply, priced against your model
// now, to the turn's replies for the usage record. `route` is the served model's `id@effort`, `yours` your model's id,
// `byId` the reply priced against each model as yours, keyed by model id; `at` when the reply arrived (ms).
async function addSavings($, router, { turnId, compared, tier, route, yours, byId, usage, at }) {
  try {
    const view = router.view ?? (await readView($, router));
    if (compared.reply) {
      const turn = router.turnActivities.get(turnId);
      const entry = replyEntry({
        at,
        activity: tier ? (turn?.label ?? null) : null,
        tier,
        route,
        yours,
        reply: compared.reply,
        replies: byId,
        usage,
      });
      router.turnUsage.set(turnId, [...(router.turnUsage.get(turnId) ?? []), entry]);
    }
    await updateView($, router, { savingsBy: addReplies(view.savingsBy ?? {}, compared.replies) });
  } catch {}
}

// A finished turn's replies, and the switch that started it, added to this session's usage record.
async function flushUsage($, router, entries, switched) {
  try {
    if (await addToLedger($, router, 'usage', (record, now) => recordUsage(record, entries, { switched, now })))
      await updateView($, router, ledgerView(router, ['usage']));
  } catch {}
}

// A finished turn's activity stats: the session counts in the view and the counts kept across sessions. Stats never
// break a turn: a failed read or write loses this turn's counts. Readings already in the session's metrics record stay
// in memory after a failed write and go out with the next turn that adds a reading.
async function recordActivity($, router, turn) {
  try {
    if ((await $.session.id()) !== turn.sessionId) return;
    const messages = await $.session.messages({ as: 'api' });
    const start = promptIndex(messages);
    if (start < 0) return;
    const observed = observedActivity(messages, start);
    const view = router.view ?? (await readView($, router));
    const manual = (await modeOf($, router)) === 'manual';
    // The session may have changed during the reads; this turn is not the new session's.
    if ((await $.session.id()) !== turn.sessionId) return;
    // Advanced before any further await, so a session change meanwhile cannot carry this run into the new session.
    const { run, ended } = advanceRun(router.run, turn.answer);
    router.run = run;
    // Routing turned off while this turn ran ends the watch here, even when it is back on by now, so the move is not
    // inherited. The counter is read after the last await: a switch during any of them counts.
    const off = manual || turn.offSwitches !== router.offSwitches;
    const down = advanceDown(router.afterDown, turn);
    router.afterDown = off ? null : down.after;
    await updateView($, router, {
      activityStats: recordTurn(view.activityStats ?? emptySession(), {
        activity: turn.label,
        answer: turn.answer,
        observed,
        requests: turn.requests,
        inputTokens: turn.inputTokens,
        outputTokens: turn.outputTokens,
        routedUsd: turn.routedUsd,
        pricedRequests: turn.pricedRequests,
        routes: turn.routes,
        tierSwitches: turn.switched === 'tier' ? 1 : 0,
        activitySwitches: turn.switched === 'activity' ? 1 : 0,
        lateral: turn.lateral,
      }),
    });
    // Writing counts read before a reset would bring them back; this turn's are lost instead. A reset during a write
    // empties the view; these counts are older than it. Each record is written on its own: a failed write of one
    // keeps the other.
    const stats = { predicted: turn.predicted, observed, runEnded: ended, lateral: turn.lateral };
    const metrics = { classifier: turn.classifier, adviceMs: turn.adviceMs, downMove: down.event };
    const shown = await Promise.all([
      addToLedger($, router, 'activity', (record, now) => recordStore(record, stats, now)).catch(() => false),
      addToLedger($, router, 'metrics', (record, now) => recordMetrics(record, { ...metrics, now })).catch(() => false),
    ]);
    const kinds = ['activity', 'metrics'].filter((_, i) => shown[i]);
    if (kinds.length) await updateView($, router, ledgerView(router, kinds));
  } catch {}
}

// The session's open run ends with it; without this flush it is never counted.
async function flushRun($, router, run) {
  try {
    const ended = { predicted: null, observed: null, runEnded: run, lateral: null };
    await addToLedger($, router, 'activity', (record, now) => recordStore(record, ended, now));
  } catch {}
}

// The frontmatter of the agent file a spawn starts (agentFrontmatter), or null when it cannot be found or read. Read
// once per provider and type in a session, and never for a built-in, whose definition is not on disk. A read that
// failed is not kept: the next spawn of the type reads again.
async function agentDefinition($, router, e) {
  const plugin = e.provider?.plugin;
  if (typeof plugin !== 'string' || plugin === 'engine' || typeof e.subagentType !== 'string') return null;
  const key = `${plugin} ${e.subagentType}`;
  if (!router.definitions.has(key)) {
    try {
      router.definitions.set(key, await findDefinition($, plugin, e.subagentType));
    } catch {
      return null;
    }
  }
  return router.definitions.get(key);
}

// A plugin agent (provider `plugin@marketplace`) is looked up under each install path installed_plugins.json gives
// that plugin, the files Claude Code itself loads; any other agent under the session's .claude/agents, then the
// profile's agents. Every match must agree on the model, or the definition is unknown. Limit: a plugin that keeps its
// agents outside `agents/` reads as unknown, so its agents pass through. Throws when a file cannot be read.
async function findDefinition($, plugin, type) {
  const home = await $.env.get('HOME');
  const profile = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${home}/.claude`;
  const name = type.slice(type.indexOf(':') + 1);
  const fromPlugin = plugin.includes('@');
  const dirs = fromPlugin
    ? (JSON.parse(await $.fs.read(`${profile}/plugins/installed_plugins.json`)).plugins?.[plugin] ?? []).map(
        (entry) => `${entry.installPath}/agents`,
      )
    : [`${await $.session.cwd()}/.claude/agents`, `${profile}/agents`];
  const found = [];
  for (const dir of dirs) {
    if (!(await $.fs.exists(dir))) continue;
    for (const entry of await $.fs.list(dir)) {
      if (entry.kind === 'dir' || !entry.name.endsWith('.md')) continue;
      const definition = agentFrontmatter(await $.fs.read(`${dir}/${entry.name}`));
      if (definition && (definition.name ?? entry.name.slice(0, -3)) === name) found.push(definition);
    }
    // A project agent replaces a user agent of the same name.
    if (found.length && !fromPlugin) break;
  }
  const agree = found.every((d) => d.model === found[0].model && d.modelRouting === found[0].modelRouting);
  return found.length && agree ? found[0] : null;
}

// The spawn path's classifier client: a breaker of its own, so spawn failures never pause main-turn routing, and no
// in-flight slot, so a parent that spawns several agents at once gets an answer for each.
function spawnClientOf(router, id) {
  const key = `spawn:${id}`;
  if (!router.clients.has(key)) router.clients.set(key, new ClassifierClient({ exclusive: false }));
  return router.clients.get(key);
}

// A listed spawn's model: the models key its type names, or the classifier's pick for a `classify` type from the task
// text alone. `choice: 'core'` keeps core's model: no advice (`failed`), or a model availableModels blocks.
async function decideSpawn($, router, cfg, e, definition, signal) {
  let alias = typeRoute(cfg, e, definition).route;
  let failed = false;
  if (alias === CLASSIFY) {
    const entry = activeClassifier(cfg);
    const credentials = await resolveCredentials(entry, (name) => settingOf($, router.options, name));
    // The wait delays the subagent's start, so it is the classifier's deadline capped at SPAWN_DEADLINE_MS.
    const timeoutMs = Math.min(entry.timeoutMs, SPAWN_DEADLINE_MS);
    const result = await spawnClientOf(router, cfg.classifier).ask({
      request: (url, init) => $.http.fetch(url, init),
      sleep: (ms, args) => $.clock.sleep(ms, args),
      config: { ...cfg, classifiers: { ...cfg.classifiers, [cfg.classifier]: { ...entry, timeoutMs } } },
      apiKey: credentials.apiKey,
      endpoint: credentials.endpoint,
      prompt: spawnPrompt(cfg, e),
      turns: [],
      signal,
    });
    alias = classifiedAlias(cfg, result.advice);
    failed = !result.advice;
  }
  // The full id, not an alias: a family alias would resolve to the parent's exact model when the families match.
  const model = alias ? cfg.models[alias].id : null;
  // Settings that cannot be read may hold an availableModels list, so the model is not sent.
  const settings = await $.settings.read().catch(() => null);
  if (!model || !settings || !isModelAllowed(model, settings.availableModels, e.parentModel))
    return { choice: 'core', model: null, failed };
  return { choice: alias, model, failed };
}

// One model per subagent, chosen before its cache exists. `on` waits for the decision and sends its model, which
// Claude Code uses in place of the Agent call's `model` and the agent's frontmatter. Routing off or unavailable keeps
// every model Claude Code chooses, and records nothing.
async function spawnAgent($, router, e, next) {
  const cfg = router.config;
  if (cfg.subagentRouting === 'off') return next(e);
  const view = router.view ?? (await readView($, router));
  if (view.phase === 'unavailable' || (await modeOf($, router, view.mode)) === 'manual') return next(e);
  const definition = await agentDefinition($, router, e);
  const pass = passReason(cfg, e, definition);
  const decision = pass ? null : await decideSpawn($, router, cfg, e, definition, next.signal).catch(() => null);
  const routed = Boolean(decision?.model);
  const result = await next(routed ? { ...e, model: decision.model } : e);
  if (result.agentId && (pass || decision))
    await noteSpawn($, router, { cfg, e, pass, decision, routed, result, definition }).catch(() => {});
  return result;
}

// The spawn's record, kept until the session ends. When routed, core's model is an estimate (coreModelOf); otherwise it
// is the model the agent started on.
async function noteSpawn($, router, { cfg, e, pass, decision, routed, result, definition }) {
  const parentKey = `${e.parentAgentId ?? 'main'} ${e.subagentType}`;
  const finishedAt = router.finished.get(parentKey);
  const coreModel = routed
    ? coreModelOf(cfg, e, {
        envModel: await $.env.get('CLAUDE_CODE_SUBAGENT_MODEL'),
        force: isSet(await $.env.get('CLAUDE_CODE_SUBAGENT_MODEL_FORCE')),
        definition,
      })
    : result.model;
  const record = spawnRecord({
    sessionId: await $.session.id(),
    spawn: e,
    pass,
    choice: decision?.choice ?? null,
    routedModel: decision?.model ?? result.model,
    coreModel,
    failed: decision?.failed,
    respawn: Number.isFinite(finishedAt) && Date.now() - finishedAt < RESPAWN_WINDOW_MS,
  });
  router.agents.set(result.agentId, { ...record, parentKey });
}

// A subagent's prompt-cache lifetime, by Claude Code's rule for requests outside the main conversation.
async function subagentTtlOf($) {
  const settings = await $.settings.read();
  return subagentCacheTtl({
    force5m: await $.env.get('FORCE_PROMPT_CACHING_5M'),
    envTtl: await $.env.get('CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL'),
    settingTtl: settings.subagentPromptCacheTtl,
    enable1h: await $.env.get('ENABLE_PROMPT_CACHING_1H'),
  });
}

// A subagent's step runs exactly as Claude Code sent it: a model switch between its steps would rewrite its context
// cold. Its reply is added to its spawn record; the record never breaks the step.
async function* stepAgent($, router, e, next) {
  const response = yield* next(e);
  if (router.agents.has(e.agentId) && response?.usage) {
    try {
      const ttl = await subagentTtlOf($);
      const agent = router.agents.get(e.agentId);
      if (agent) router.agents.set(e.agentId, addAgentReply(router.config, agent, response.usage, ttl));
    } catch {}
  }
  return response;
}

// A subagent's turn ended: its counts since the last flush go to this session's record kept across sessions.
async function finishAgent($, router, agentId) {
  const agent = router.agents.get(agentId);
  if (!agent) return;
  router.finished.set(agent.parentKey, Date.now());
  router.agents.set(agentId, flushedAgent(agent));
  await flushSubagents($, router, [agent]);
}

// This session's agents' counts added to its record kept across sessions. Stats never break a turn: a failed read or
// write loses these counts.
async function flushSubagents($, router, agents) {
  try {
    const sessionId = await $.session.id();
    const mine = agents.filter((agent) => agent.sessionId === sessionId);
    if (!mine.length) return;
    const add = (record, now) => mine.reduce((sum, agent) => recordAgent(sum, agent, now), record);
    if (await addToLedger($, router, 'subagents', add)) await updateView($, router, ledgerView(router, ['subagents']));
  } catch {}
}

// The pane's handlers. `view` is the view the pane was drawn from; a handler reads `router.view` first, which holds
// any press since.
function paneActions($, router, view) {
  const editRoute = (tier, change) => {
    const draft = routeDraftOf(router.config, router.view ?? view);
    const current = effectiveRoutes(draft, router.config).routes[tier];
    return updateView($, router, {
      routeDraft: { ...draft, routes: { ...draft.routes, [tier]: change(current) } },
      notice: null,
    });
  };
  const editCell = (activity, tier, kind, value) =>
    updateView($, router, {
      routeDraft: editActivity(
        routeDraftOf(router.config, router.view ?? view),
        router.config,
        activity,
        tier,
        kind,
        value,
      ),
      notice: null,
    });
  // Every pane save adopts the file as written, which may name another classifier than before: a hand edit
  // meanwhile, or a row press. Then the new classifier starts clean and the old one's readings leave the view;
  // an unavailable reason stays.
  const adopt = async (loaded) => {
    const switched = loaded.classifier !== router.config.classifier;
    router.config = loaded;
    if (!switched) return {};
    clientOf(router, router.config.classifier).restore(null);
    const current = router.view ?? view;
    return {
      ...CLEARED_READINGS,
      error: current.phase === 'unavailable' ? current.error : null,
      credentials: await credentialsOf($, router.options, router.config),
      health: healthOf(clientOf(router, router.config.classifier), router.config.classifier),
    };
  };
  // Pending drafts re-pointed at the config a write just adopted. An edit that still differs stays; everything else
  // follows the file, and the file becomes what the draft compares against, so picking a value the write replaced
  // counts as a change again.
  const rebased = ({ routeDraft, tuning, tuningBase }) => {
    const routes = routeDraft && {
      ...effectiveRoutes(routeDraft, router.config),
      ...effectiveActivities(routeDraft, router.config),
    };
    const edited = Object.entries(tuning ?? {}).filter(([key, value]) => value !== tuningBase?.[key]);
    return {
      routeDraft: routes ? { ...routes, base: routeDraftOf(router.config, {}).base } : null,
      tuning: edited.length ? Object.fromEntries(edited) : null,
      tuningBase: edited.length ? tuningOf(router.config) : null,
    };
  };
  const save = async (change, saved) => {
    const result = await saveConfig($, router.config.nativePath, change);
    if (result.error) return updateView($, router, { notice: result.error });
    const drafts = router.view ?? view;
    const reset = await adopt(result.config);
    return updateView($, router, { ...reset, ...rebased(drafts), ...saved(router.config) });
  };
  // Defaults go into the routing draft like any edit; the notice says whether Save has anything of that section left
  // to write.
  const loadDefaults = (patch, what) => {
    const changes = routingChanges(router.config, { ...(router.view ?? view), ...patch });
    const pending = what === 'route' ? changes.tiers.length + Number(changes.baseline) : changes.policy.length;
    return updateView($, router, {
      ...patch,
      notice: pending
        ? `${what === 'route' ? 'Route' : 'Policy'} defaults loaded. Save removes your ${what} overrides from router.json.`
        : `${what === 'route' ? 'Routes' : 'Policy'} already at defaults.`,
    });
  };
  // A pane write keeps the leaves it changed as router.json had them, read from the file it rewrites rather than from
  // the loaded config, so Undo restores them verbatim. A later write replaces them, and Undo clears them.
  const write = (label, change, patch = {}) => {
    let leaves = [];
    return save(
      (file) => {
        const written = change(file);
        leaves = changedLeaves(file, written);
        return written;
      },
      () => ({ ...patch, lastWrite: { label, leaves }, notice: `Saved: ${label}. Applies from the next turn.` }),
    );
  };
  // The Usage tab's period, kept across sessions; a failed save keeps it for this session.
  const showPeriod = async (period, patch = {}) => {
    if (!PERIODS.includes(period)) return;
    await $.store.set(PERIOD_KEY, period).catch(() => {});
    await updateView($, router, { usagePeriod: period, usageOpen: null, ...patch });
  };
  return {
    mode: (mode) => changeMode($, router, mode),
    tab: (tab) => updateView($, router, { tab, notice: null, confirmDelete: false }),
    help: () => updateView($, router, { help: !(router.view ?? view).help }),
    pin: async (tier) => {
      await updateView($, router, { notice: await setPin($, router, tier) });
    },
    unpin: () => updateView($, router, { pendingPin: null, notice: null }),
    key: async () => {
      openKeySettings($);
      await $.ui.close({ id: PANE });
    },
    copyPath: async (press) => {
      await $.ui.copy({ text: router.config.nativePath, surface: press?.surface });
      await updateView($, router, { notice: 'Path copied.' });
    },
    close: () => $.ui.close({ id: PANE }),
    routeModel: (tier, alias) =>
      editRoute(tier, (route) => ({
        model: alias,
        effort: router.config.models[alias]?.efforts.includes(route.effort) ? route.effort : null,
      })),
    routeEffort: (tier, effort) => editRoute(tier, (route) => ({ model: route.model, effort })),
    baseline: async (tier) => {
      const draft = routeDraftOf(router.config, router.view ?? view);
      await updateView($, router, { routeDraft: { ...draft, baselineTier: tier }, notice: null });
    },
    saveRouting: async () => {
      const current = router.view ?? view;
      const routeDraft = current.routeDraft;
      const saved = tuningOf(router.config);
      const base = current.tuningBase ?? saved;
      const edited = Object.keys(current.tuning ?? {}).filter((key) => current.tuning[key] !== base[key]);
      const changes = routingChanges(router.config, current).count;
      if (!changes) return updateView($, router, { notice: 'No routing changes to save.' });
      const after = Object.fromEntries(edited.map((key) => [key, current.tuning[key]]));
      return write(
        `${changes} routing change${changes === 1 ? '' : 's'}`,
        (file) => {
          // withActivities reads the routes withRoutes wrote: a removed built-in override is saved as its tier's route.
          const routed = routeDraft ? withActivities(withRoutes(file, routeDraft), routeDraft) : file;
          return edited.length ? withTuning(routed, { ...base, ...after }, base) : routed;
        },
        { routeDraft: null, tuning: null, tuningBase: null },
      );
    },
    activityMode: (mode) =>
      updateView($, router, {
        routeDraft: { ...routeDraftOf(router.config, router.view ?? view), activityRouting: mode },
        notice: null,
      }),
    activityModel: (activity, tier, alias) => editCell(activity, tier, 'model', alias),
    activityEffort: (activity, tier, effort) => editCell(activity, tier, 'effort', effort),
    // Restore puts the built-in default back; Use tier model drops the cell, a built-in one saved as the tier's route.
    restoreActivity: (activity, tier) => editCell(activity, tier, 'add'),
    removeActivity: (activity, tier) => editCell(activity, tier, 'remove'),
    selectCell: (cell) => updateView($, router, { routeCell: cell, notice: null }),
    usageDetail: () => updateView($, router, { usageDetail: !(router.view ?? view).usageDetail }),
    period: (period) => showPeriod(period),
    // The Now tab's Usage links: the Usage tab on the period the line sums.
    usageFor: (period) => showPeriod(period, { tab: 'usage', notice: null, confirmDelete: false }),
    usageGroup: (group) => updateView($, router, { usageGroup: group, usageOpen: null }),
    usageCompare: () => updateView($, router, { usageCompare: !(router.view ?? view).usageCompare }),
    usageOpen: (row) => updateView($, router, { usageOpen: row }),
    // An insight's link: the Routes tab with the grid cell it names open.
    openRoute: (cell) => updateView($, router, { tab: 'routes', routeCell: cell, notice: null }),
    confirmDelete: (asked) => updateView($, router, { confirmDelete: asked }),
    // `/router activities <mode>`: the mode alone, saved at once like a classifier press, with Undo.
    activityRouting: (mode) => {
      const from = router.config.activityRouting;
      if (mode === from) return undefined;
      return write(`activity routing ${from} → ${mode}`, (file) =>
        withActivities(file, { base: { activityRouting: from }, activityRouting: mode }),
      );
    },
    // Delete history: every record kept across sessions (usage, the undated savings, activity stats and metrics,
    // subagents) and this session's counts.
    resetStats: async () => {
      router.statsResets += 1;
      router.run = null;
      router.afterDown = null;
      router.turnUsage.clear();
      for (const [id, agent] of router.agents) router.agents.set(id, flushedAgent(agent));
      // Every session's records. The marker is written first, so a session still holding its record from before the
      // reset drops it, unless that record's first count has the reset's millisecond or the clock moved back across
      // the reset.
      const clearRecords = async () => {
        const resetAt = Date.now();
        await $.store.set(SAVINGS_RESET_KEY, resetAt);
        const keys = (await $.store.keys()).filter((key) =>
          Object.values(LEDGERS).some(({ prefix, legacy }) => key.startsWith(prefix) || key === legacy),
        );
        await Promise.all(keys.map((key) => $.store.delete(key)));
        for (const kind of LEDGER_KINDS)
          router.ledgers[kind] = { own: null, others: LEDGERS[kind].empty(), othersResetAt: resetAt };
        return true;
      };
      const cleared = await clearRecords().catch(() => false);
      // The store kept the history: this session's records start over, and its next write replaces the stored one.
      if (!cleared)
        for (const kind of LEDGER_KINDS) {
          const held = router.ledgers[kind];
          if (held.own) held.own = { ...held.own, record: LEDGERS[kind].empty() };
        }
      await updateView($, router, {
        activityStats: null,
        savingsBy: {},
        confirmDelete: false,
        usageOpen: null,
        ...ledgerView(router),
        notice: cleared
          ? 'History deleted: usage, activity and subagent records of every session.'
          : 'This session’s counts cleared. The saved history could not be deleted.',
      });
    },
    discardRouting: () => updateView($, router, { routeDraft: null, tuning: null, tuningBase: null, notice: null }),
    // Routes only: pending activity edits and the mode stay in the draft.
    resetRoutes: () =>
      loadDefaults(
        {
          routeDraft: {
            ...routeDraftOf(router.config, router.view ?? view),
            ...structuredClone({ routes: DEFAULTS.routes, baselineTier: DEFAULTS.baselineTier }),
            base: routeDraftOf(router.config, {}).base,
          },
        },
        'route',
      ),
    tune: (key, value) =>
      updateView($, router, {
        tuning: { ...(router.view ?? view).tuning, [key]: value },
        tuningBase: (router.view ?? view).tuningBase ?? tuningOf(router.config),
        notice: null,
      }),
    resetPolicy: () =>
      loadDefaults(
        // The draft is replaced whole, so it starts from the saved values, not from an older draft's base.
        { tuning: tuningOf(DEFAULTS), tuningBase: tuningOf(router.config) },
        'policy',
      ),
    classifier: (id) => {
      const { config } = router;
      if (!id || id === config.classifier || !Object.hasOwn(config.classifiers, id)) return undefined;
      const from = config.classifier;
      return write(`classifier ${config.classifiers[from].label} → ${config.classifiers[id].label}`, (file) =>
        withClassifier(file, id),
      );
    },
    classifierTimeout: (timeoutMs) => {
      const active = activeClassifier(router.config);
      if (timeoutMs === active.timeoutMs) return undefined;
      return write(`${active.label} deadline ${active.timeoutMs} → ${timeoutMs} ms`, (file) =>
        withClassifierTimeout(file, router.config.classifier, timeoutMs),
      );
    },
    undo: async () => {
      const last = (router.view ?? view).lastWrite;
      if (!last) return undefined;
      return save(
        (file) => restored(file, last.leaves),
        () => ({ lastWrite: null, notice: `Undid: ${last.label}.` }),
      );
    },
  };
}

// The session's turns, open run and running agents end with it; the view starts the next session from the counts kept
// across sessions.
async function endSession($, router) {
  for (const controller of router.controllers) controller.abort();
  router.decisions.clear();
  router.prompts.clear();
  router.turnConfigs.clear();
  router.turnPins.clear();
  router.turnActivities.clear();
  for (const review of router.reviews.values()) review.controller.abort();
  router.reviews.clear();
  router.turnUsage.clear();
  const run = router.run;
  router.run = null;
  router.afterDown = null;
  if (run) await flushRun($, router, run);
  // Agents still running when the session ends: what they did so far is counted.
  const agents = [...router.agents.values()];
  router.agents.clear();
  router.finished.clear();
  await flushSubagents($, router, agents);
  router.view = {
    ...initialView(router.view?.nativeModel ?? ''),
    // The effort carries over /clear until the next turn reads it again, so "your model" keeps its effort.
    nativeEffort: router.view?.nativeEffort ?? null,
    mode: 'auto',
    credentials: router.view?.credentials ?? null,
    // Counts kept across sessions: the next session starts from them.
    activityStore: router.view?.activityStore ?? null,
    activityMetrics: router.view?.activityMetrics ?? null,
    savingsStore: router.view?.savingsStore ?? null,
    subagentStore: router.view?.subagentStore ?? null,
    usageStore: router.view?.usageStore ?? null,
    usagePeriod: router.view?.usagePeriod ?? 'session',
    health: healthOf(clientOf(router, router.config.classifier), router.config.classifier),
    configPath: router.config.nativePath,
    phase: router.view?.phase === 'unavailable' ? 'unavailable' : 'ready',
    error: router.view?.phase === 'unavailable' ? router.view.error : null,
  };
}

export function register(on, options) {
  const router = createRouter(options);

  on('session.start', async ($, e, next) => {
    router.definitions.clear();
    await $.command.register({
      name: 'router',
      description: 'Open the Router pane, or switch routing: auto, off, pin <tier>, activities <mode>.',
      argumentHint: '[auto|off|pin <tier>|activities off|on]',
      immediate: true,
    });
    const model = await $.session.model();
    try {
      router.config = await loadNativeConfig($);
      const existing = await readView($, router);
      router.view = existing;
      const sameClassifier = existing.health?.classifier === router.config.classifier;
      clientOf(router, router.config.classifier).restore(sameClassifier ? existing.health : null);
      const base = await $.env.get('ANTHROPIC_BASE_URL');
      const version = await $.session.version().catch(() => null);
      const supported = supportedVersion(version?.version);
      const gateway =
        ['jev-router', 'jev-router[1m]'].includes(model) ||
        model === 'router' ||
        Boolean(base?.includes('127.0.0.1:43170') || base?.includes('localhost:43170'));
      await updateView($, router, {
        nativeModel: model,
        ...(await startView($, router, model)),
        phase: gateway || !supported ? 'unavailable' : 'ready',
        error: !supported ? 'requires Claude Code 2.1.289 or newer' : gateway ? GATEWAY_SETTINGS : null,
        ...(sameClassifier ? {} : CLEARED_READINGS),
        credentials: await credentialsOf($, options, router.config),
        health: healthOf(clientOf(router, router.config.classifier), router.config.classifier),
        configPath: router.config.nativePath,
        tuning: null,
        tuningBase: null,
        routeDraft: null,
        lastWrite: null,
        bandDetail: (await $.store.get(BAND_DETAIL).catch(() => false)) === true,
        usagePeriod: await periodOf($),
        ...(await storeView($, router)),
      });
    } catch (error) {
      await updateView($, router, {
        phase: 'unavailable',
        error: error.message?.endsWith(MIGRATION_HINT)
          ? 'router.json needs migration; run the plugin scripts/migrate-config.mjs with your router.json path'
          : 'invalid router configuration',
      });
    }
    return next(e);
  });

  on('command.run', { command: 'model' }, async ($, e, next) => {
    const result = await next(e);
    if (e.origin.kind !== 'plugin') {
      await changeMode($, router, 'manual');
      await updateView($, router, { nativeModel: await $.session.model(), reason: 'model selected manually' });
    }
    return result;
  });

  on('config.set', { key: 'model' }, async ($, e, next) => {
    const result = await next(e);
    if (!result.deny && e.origin.kind !== 'plugin') {
      await changeMode($, router, 'manual');
      await updateView($, router, { nativeModel: await $.session.model() });
    }
    return result;
  });

  on('command.run', { command: 'router' }, ($, e) => routerCommand($, router, e.args));

  on('turn.start', (_$, e, next) => {
    router.turnConfigs.set(e.turnId, router.config);
    router.prompts.set(e.turnId, clip(e.text, router.config.context.maxTextChars));
    return next(e);
  });

  // A hook failure spawns the agent as Claude Code would; next(e) replays a spawn already made. agent.spawn and a
  // catchable on() are in the 2.1.293 build types, not checked on 2.1.289: an engine without them still loads routing.
  try {
    on('agent.spawn', ($, e, next) => spawnAgent($, router, e, next)).catch((_$, e, next) => next(e));
  } catch {}

  on('turn.step', async function* ($, e, next) {
    if (e.agentId) return yield* stepAgent($, router, e, next);
    const cfg = router.turnConfigs.get(e.turnId) ?? router.config;
    const [sessionId, nativeModel, view] = await Promise.all([$.session.id(), $.session.model(), readView($, router)]);
    const mode = await modeOf($, router, view.mode);
    if (e.index === 0) {
      const saved = await rememberMode($, mode);
      await updateView($, router, {
        mode,
        nativeEffort: e.effort ?? null,
        ...(!saved ? { notice: 'Resume preference could not be saved. Current mode remains active.' } : {}),
      });
    }
    const ref = { ...LOOP, id: 'main' };
    const loaded = await $.state.get(ref);
    let loopVersion = loaded.version;
    let loop = prepareLoop(loaded.value ?? emptyLoop(cfg, e.model), e.messageCount);
    if (view.phase === 'unavailable' || mode === 'manual') {
      return yield* passMain($, e, next, loop, loopVersion, nativeModel, 'manual', router);
    }
    if (loop.turnId === e.turnId && isNativeFallback(loop, e.model)) {
      return yield* passMain($, e, next, loop, loopVersion, nativeModel, 'native-fallback', router);
    }
    const [context, settings] = await Promise.all([contextOf($, loop), $.settings.read()]);
    const availableModels = settings.availableModels;
    const key = `${sessionId}:${e.turnId}:${loop.generation}`;
    if (loop.turnId !== e.turnId) {
      let job = router.decisions.get(key);
      if (!job) {
        job = decideTurn($, router, e, next.signal, {
          sessionId,
          view,
          cfg,
          loop,
          loopVersion,
          context,
          nativeModel,
          availableModels,
        });
        router.decisions.set(key, job);
      }
      const selected = await job;
      if (!selected) {
        if (!next.signal.aborted && (await $.session.id()) === sessionId && router.view?.activeTurnId === e.turnId) {
          const reserved = await $.state.set(ref, loop, { ifVersion: loopVersion });
          if (reserved.isSet) return yield* passMain($, e, next, loop, reserved.version, nativeModel, 'manual', router);
        }
        return yield* next(e);
      }
      loop = selected.loop;
      loopVersion = selected.version;
    } else {
      // A review answer applies first, so tool calls made after its snapshot can still move the route up.
      loop = await reviewMidTurn($, router, cfg, loop, e, { context, nativeModel, availableModels });
      loop = await moveOnObserved($, router, cfg, loop, e, context);
      loop = continueRoute(cfg, loop, {
        nativeModel,
        contextTokens: context.tokens,
        contextKnown: context.known,
        availableModels,
        effort: e.effort,
      });
      await updateView($, router, continuationView(cfg, loop.decision, context));
    }
    const pinPresses = router.turnPins.get(e.turnId);
    if (pinPresses !== undefined) {
      router.turnPins.delete(e.turnId);
      if (pinPresses === router.pinPresses) await updateView($, router, { pendingPin: null });
    }
    const request = { ...e, model: loop.decision.model };
    if (loop.decision.effort === null) delete request.effort;
    else request.effort = loop.decision.effort;
    const response = yield* next(request);
    if (!next.signal.aborted && (await $.session.id()) === sessionId)
      await observeRouted($, router, { turnId: e.turnId, cfg, loop, loopVersion, request, response, nativeModel });
    return response;
  });

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) {
      await finishAgent($, router, e.agentId);
      return next(e);
    }
    router.turnConfigs.delete(e.turnId);
    router.turnPins.delete(e.turnId);
    router.reviews.get(e.turnId)?.controller.abort();
    router.reviews.delete(e.turnId);
    router.turnControllers.get(e.turnId)?.abort();
    if (router.view?.activeTurnId === e.turnId && router.view.phase === 'choosing') {
      router.view = { ...router.view, activeTurnId: null };
      const mode = await modeOf($, router);
      if (router.view.activeTurnId === null)
        await updateView($, router, { phase: mode === 'manual' ? 'manual' : 'ready', reason: 'interrupted' });
    }
    router.prompts.delete(e.turnId);
    for (const key of router.decisions.keys()) if (key.includes(`:${e.turnId}:`)) router.decisions.delete(key);
    // `off` asks nothing, so it records nothing; it only ends the watch after a cheaper activity move.
    const turn = router.turnActivities.get(e.turnId);
    router.turnActivities.delete(e.turnId);
    if (turn?.mode === 'off') {
      if ((await $.session.id()) === turn.sessionId) router.afterDown = advanceDown(router.afterDown, turn).after;
    } else if (turn) await recordActivity($, router, turn);
    const entries = router.turnUsage.get(e.turnId);
    router.turnUsage.delete(e.turnId);
    if (entries) await flushUsage($, router, entries, turn?.switched ?? null);
    return next(e);
  });

  on('session.compact', async ($, e, next) => {
    const result = await next(e);
    // Only the main conversation is routed, so an agent compaction changes nothing here.
    if (!result.skip && e.trigger !== 'precompute' && !e.agentId) {
      const ref = { ...LOOP, id: 'main' };
      const loop = (await $.state.get(ref)).value;
      if (loop) await $.state.set(ref, resetHistory(loop));
      for (const controller of router.controllers) controller.abort();
    }
    return result;
  });

  on('session.end', async ($, e, next) => {
    await endSession($, router);
    return next(e);
  });

  // While the classifier runs, the turn's spinner says so; the engine's own word returns once the route is set.
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    if (e.props.message !== null) return next(e);
    const view = await readView($, router);
    return view.phase === 'choosing' ? next({ ...e, props: { ...e.props, message: 'Choosing model' } }) : next(e);
  });

  // Paused or broken routing stays visible in the prompt footer even when the band is collapsed.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const view = await readView($, router);
    const label =
      view.phase === 'unavailable'
        ? 'routing unavailable'
        : (await modeOf($, router, view.mode)) === 'manual'
          ? 'routing off'
          : null;
    return label ? next({ ...e, props: { ...e.props, modes: [...e.props.modes, label] } }) : next(e);
  });

  on('ui.render', { component: ['AbovePrompt', 'Pane'] }, async ($, e, next) => {
    if (e.component === 'Pane' && e.requestId !== PANE) return next(e);
    const storedView = await readView($, router);
    const view = { ...storedView, mode: await modeOf($, router, storedView.mode) };
    const elements = $.ui.resolve(e);
    const { Box } = elements;
    const usage = await $.session.usage().catch(() => null);
    if (e.component === 'AbovePrompt') {
      if (e.props.hasSurvey) return next(e);
      return Box({
        flexDirection: 'column',
        children: [
          await next(e),
          renderBand(
            elements,
            router.config,
            view,
            usage,
            { columns: e.props.bodyColumns, agentId: e.props.view?.agentId },
            {
              open: () => openPane($, router),
              mode: (mode) => changeMode($, router, mode),
              pin: async (tier) => $.ui.toast(await setPin($, router, tier)),
              unpin: () => updateView($, router, { pendingPin: null }),
              key: () => openKeySettings($),
              toggleDetail: async () => {
                const bandDetail = !(router.view ?? view).bandDetail;
                await $.store.set(BAND_DETAIL, bandDetail).catch(() => {});
                await updateView($, router, { bandDetail });
              },
            },
          ),
        ],
      });
    }
    const settings = await $.settings.read().catch(() => ({}));
    const modelOptions = Object.keys(router.config.models).filter((alias) =>
      isModelAllowed(router.config.models[alias].id, settings.availableModels, view.nativeModel),
    );
    return renderPanel(elements, router.config, view, usage, paneActions($, router, view), {
      modelOptions,
      columns: e.props.bodyColumns,
    });
  });
}

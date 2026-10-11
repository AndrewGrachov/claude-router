import {
  advanceDown,
  advanceRun,
  emptyMetrics,
  emptySession,
  emptyStore,
  METRICS_PREFIX,
  mergeMetrics,
  metricsAfterReset,
  readMetrics,
  readStore,
  recordMetrics,
  recordStore,
  recordTurn,
  STORE_KEY,
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
  cellForModel,
  chooseRoute,
  continueRoute,
  emptyLoop,
  isModelAllowed,
  isNativeFallback,
  isSameModel,
  nativeFacts,
  observeResponse,
  prepareLoop,
  resetHistory,
} from '../lib/route.mjs';
import {
  addReplies,
  addReply,
  afterReset,
  compareModels,
  emptySavingsStore,
  emptyTotals,
  mergeSavingsStores,
  modelAlias,
  modelEntry,
  readSavingsStore,
  recordSavingsStore,
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
import { CLEARED_READINGS, continuationView, healthOf, initialView, responseMetrics } from '../lib/view.mjs';

// The engine follows $ only into functions declared in this file, never across an import: every helper that takes $
// lives here, and the pure parts live in lib/.

const VIEW = { plugin: 'router', key: 'view' };
const LOOP = { plugin: 'router', key: 'loops' };
const PANE = 'jev-router';
const PANE_TITLE = 'Router';
const BAND_DETAIL = 'band:detail';
const MODE_PREFIX = 'mode:';
const isSet = (value) => /^(1|true|yes|on)$/i.test(String(value ?? '').trim());

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
    run: null,
    // The route a cheaper activity move went to, while the turns stay on it (advanceDown); else null.
    afterDown: null,
    // Counts every switch to routing off; a turn compares it with its own start to see routing went off meanwhile.
    offSwitches: 0,
    // Each turn's routing-vs-your-model totals until turn.complete adds them to the store.
    turnSavings: new Map(),
    // The totals kept across sessions: this session's record (`{ sessionId, record }`), held here so a refresh never
    // reads it back from the store while a write of it is pending, and the sum of every other session's, read on
    // refresh. The view shows their sum.
    savingsOwn: null,
    savingsOthers: null,
    // The activity metrics kept across sessions, held the same way: this session's record and the others' sum.
    metricsOwn: null,
    metricsOthers: null,
    // Bumped by Reset activity stats, so a store write that read the counts before the reset skips.
    statsResets: 0,
    // Each spawned agent's record by agentId (spawnRecord), and when each parent loop last finished an agent of a type,
    // for respawns. The subagent totals kept across sessions, held as the savings records are.
    agents: new Map(),
    finished: new Map(),
    // Each agent type's definition frontmatter by provider and type, read once per session (agentDefinition).
    definitions: new Map(),
    subagentsOwn: null,
    subagentsOthers: null,
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

// This session's record kept across sessions, read from the store once per session, and the last reset (ms) from
// any session, read each time: a Reset in another session empties a record held from before it.
async function ownSavings($, router) {
  const sessionId = await $.session.id();
  const resetAt = await $.store.get(SAVINGS_RESET_KEY);
  if (router.savingsOwn?.sessionId !== sessionId) {
    const record = readSavingsStore(await $.store.get(`${SAVINGS_PREFIX}${sessionId}`));
    // Another call may have read it meanwhile and a turn added to it: that one stands.
    if (router.savingsOwn?.sessionId !== sessionId) router.savingsOwn = { sessionId, record };
  }
  router.savingsOwn.record = afterReset(router.savingsOwn.record, resetAt);
  return { own: router.savingsOwn, resetAt };
}

// Every other session's record since the last reset, added up.
async function otherSavings($, sessionId, resetAt) {
  const own = `${SAVINGS_PREFIX}${sessionId}`;
  const keys = (await $.store.keys()).filter((key) => key.startsWith(SAVINGS_PREFIX) && key !== own);
  return mergeSavingsStores(await Promise.all(keys.map((key) => $.store.get(key))), resetAt);
}

// This session's metrics record and the last reset, as ownSavings: Reset stats clears both with one marker.
async function ownMetrics($, router) {
  const sessionId = await $.session.id();
  const resetAt = await $.store.get(SAVINGS_RESET_KEY);
  if (router.metricsOwn?.sessionId !== sessionId) {
    const record = readMetrics(await $.store.get(`${METRICS_PREFIX}${sessionId}`));
    if (router.metricsOwn?.sessionId !== sessionId) router.metricsOwn = { sessionId, record };
  }
  router.metricsOwn.record = metricsAfterReset(router.metricsOwn.record, resetAt);
  return { own: router.metricsOwn, resetAt };
}

// Every other session's metrics since the last reset, added up.
async function otherMetrics($, sessionId, resetAt) {
  const own = `${METRICS_PREFIX}${sessionId}`;
  const keys = (await $.store.keys()).filter((key) => key.startsWith(METRICS_PREFIX) && key !== own);
  return mergeMetrics(await Promise.all(keys.map((key) => $.store.get(key))), resetAt);
}

// This session's subagent record and the last reset, as ownSavings: Reset stats clears it with the same marker.
async function ownSubagents($, router) {
  const sessionId = await $.session.id();
  const resetAt = await $.store.get(SAVINGS_RESET_KEY);
  if (router.subagentsOwn?.sessionId !== sessionId) {
    const record = readSubagentStore(await $.store.get(`${SUBAGENT_PREFIX}${sessionId}`));
    if (router.subagentsOwn?.sessionId !== sessionId) router.subagentsOwn = { sessionId, record };
  }
  router.subagentsOwn.record = subagentsAfterReset(router.subagentsOwn.record, resetAt);
  return { own: router.subagentsOwn, resetAt };
}

// Every other session's subagent record since the last reset, added up.
async function otherSubagents($, sessionId, resetAt) {
  const own = `${SUBAGENT_PREFIX}${sessionId}`;
  const keys = (await $.store.keys()).filter((key) => key.startsWith(SUBAGENT_PREFIX) && key !== own);
  return mergeSubagentStores(await Promise.all(keys.map((key) => $.store.get(key))), resetAt);
}

// The view's subagent totals, this session's and the others', from what the router holds; nothing until a read
// succeeded.
const subagentView = (router) =>
  router.subagentsOthers
    ? { subagentStore: mergeSubagentStores([router.subagentsOthers, router.subagentsOwn?.record]) }
    : {};

const metricsView = (router) => mergeMetrics([router.metricsOthers, router.metricsOwn?.record]);

// The view's totals kept across sessions, from what the router holds; nothing until a read succeeded.
const savedView = (router) =>
  router.savingsOthers ? { savingsStore: mergeSavingsStores([router.savingsOthers, router.savingsOwn?.record]) } : {};

// The counts kept across sessions for the view, read when the session starts and the pane opens: another session
// may have added to them. A failed read keeps what the view has; it never breaks a turn or a render. The saved
// totals are taken from the router after the reads, so a turn that finished meanwhile counts once.
async function storeView($, router) {
  const out = {};
  try {
    out.activityStore = readStore(await $.store.get(STORE_KEY));
  } catch {}
  try {
    const { own, resetAt } = await ownMetrics($, router);
    router.metricsOthers = await otherMetrics($, own.sessionId, resetAt);
    out.activityMetrics = metricsView(router);
  } catch {}
  try {
    const { own, resetAt } = await ownSavings($, router);
    router.savingsOthers = await otherSavings($, own.sessionId, resetAt);
  } catch {}
  try {
    const { own, resetAt } = await ownSubagents($, router);
    router.subagentsOthers = await otherSubagents($, own.sessionId, resetAt);
    Object.assign(out, subagentView(router));
  } catch {}
  return out;
}

// A notice answers the last press in the pane, so the pane opens without one; the last write keeps its Undo in the
// status bar.
async function openPane($, router) {
  await updateView($, router, { notice: null, ...(await storeView($, router)), ...savedView(router) });
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
    if (written.isSet) await updateView($, router, responseMetrics(router.view, response, null));
  }
  return response;
}

// One turn's classification and route, written to the loop at `loopVersion`: the loop and its new version, or null
// when the turn was aborted, left the session or Auto, or lost the write. `signal` is the step's: its abort cancels
// the classifier call. The pin is the one in `view`, the view as the step read it.
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
    const credentials = await resolveCredentials(activeClassifier(cfg), (name) => settingOf($, router.options, name));
    const messages = await $.session.messages({ as: 'api' });
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
      pendingPin: null,
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

// A routed reply's metrics in the view, labelled with the turn's activity when its tier served it, and added to the
// turn's activity record with its list price (`routedUsd`, null when unpriced) and, when its tier served it, its route.
async function publishReply($, router, turnId, response, tier, route, routedUsd) {
  const turn = router.turnActivities.get(turnId);
  const metrics = responseMetrics(
    router.view,
    response,
    tier,
    tier ? (turn?.label ?? null) : null,
    tier ? route : null,
  );
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
  const observed = observeResponse(cfg, loop, {
    usage: response.usage,
    requestedModel: request.model,
    effort: request.effort ?? null,
    stopReason: response.stopReason,
    now: Date.now(),
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
  if (compared) await addSavings($, router, turnId, compared, tier);
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

// A routed reply's prices added to each model's session totals in the view, and its prices against your model now to
// the turn's totals for the store.
async function addSavings($, router, turnId, compared, tier) {
  try {
    const view = router.view ?? (await readView($, router));
    if (compared.reply)
      router.turnSavings.set(turnId, addReply(router.turnSavings.get(turnId) ?? emptyTotals(), compared.reply, tier));
    await updateView($, router, { savingsBy: addReplies(view.savingsBy ?? {}, compared.replies, tier) });
  } catch {}
}

// A finished turn's totals added to this session's record kept across sessions, with the guard recordActivity uses:
// totals read before a reset are not written back. The record is added to in memory before the write, so a refresh
// during the write counts the turn once.
async function flushSavings($, router, totals) {
  try {
    const resets = router.statsResets;
    const { own, resetAt } = await ownSavings($, router);
    // The others held from before a reset in another session are read again.
    if (!router.savingsOthers || afterReset(router.savingsOthers, resetAt) !== router.savingsOthers)
      router.savingsOthers = await otherSavings($, own.sessionId, resetAt);
    if (router.statsResets !== resets) return;
    own.record = recordSavingsStore(own.record, totals, Date.now());
    await $.store.set(`${SAVINGS_PREFIX}${own.sessionId}`, own.record);
    if (router.statsResets === resets) await updateView($, router, savedView(router));
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
    const resets = router.statsResets;
    const store = readStore(await $.store.get(STORE_KEY));
    const { own, resetAt } = await ownMetrics($, router);
    // The others held from before a reset in another session are read again.
    if (!router.metricsOthers || metricsAfterReset(router.metricsOthers, resetAt) !== router.metricsOthers)
      router.metricsOthers = await otherMetrics($, own.sessionId, resetAt);
    // Writing counts read before a reset would bring them back; this turn's are lost instead.
    if (router.statsResets !== resets) return;
    const written = recordStore(store, {
      predicted: turn.predicted,
      observed,
      runEnded: ended,
      lateral: turn.lateral,
    });
    const measured = recordMetrics(own.record, {
      classifier: turn.classifier,
      adviceMs: turn.adviceMs,
      downMove: down.event,
      now: Date.now(),
    });
    // Added to in memory before the write, so a refresh during the write counts the turn once.
    const changed = measured !== own.record;
    own.record = measured;
    // Both writes start before any reset can run between them.
    await Promise.all([
      $.store.set(STORE_KEY, written),
      changed ? $.store.set(`${METRICS_PREFIX}${own.sessionId}`, measured) : null,
    ]);
    // A reset during the write emptied the view; these counts are older than it.
    if (router.statsResets === resets)
      await updateView($, router, { activityStore: written, activityMetrics: metricsView(router) });
  } catch {}
}

// The session's open run ends with it; without this flush it is never counted.
async function flushRun($, run) {
  try {
    const store = readStore(await $.store.get(STORE_KEY));
    const ended = { predicted: null, observed: null, runEnded: run, lateral: null };
    await $.store.set(STORE_KEY, recordStore(store, ended));
  } catch {}
}

// The frontmatter of the agent file a spawn starts (agentFrontmatter), or null when it cannot be found or read. Read
// once per provider and type in a session, and never for a built-in, whose definition is not on disk.
async function agentDefinition($, router, e) {
  const plugin = e.provider?.plugin;
  if (typeof plugin !== 'string' || plugin === 'engine' || typeof e.subagentType !== 'string') return null;
  const key = `${plugin} ${e.subagentType}`;
  if (!router.definitions.has(key)) router.definitions.set(key, await findDefinition($, plugin, e.subagentType));
  return router.definitions.get(key);
}

// A plugin agent (provider `plugin@marketplace`) is looked up under each install path installed_plugins.json gives
// that plugin, the files Claude Code itself loads; any other agent under the session's .claude/agents, then the
// profile's agents. Every match must agree on the model, or the definition is unknown. Limit: a plugin that keeps its
// agents outside `agents/` reads as unknown, so its agents pass through.
async function findDefinition($, plugin, type) {
  try {
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
  } catch {
    return null;
  }
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
  const settings = await $.settings.read().catch(() => ({}));
  if (!model || !isModelAllowed(model, settings.availableModels, e.parentModel))
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

// Agents' counts added to this session's record, with the guard flushSavings uses: counts read before a reset are not
// written back. Stats never break a turn: a failed read or write loses these counts.
async function flushSubagents($, router, agents) {
  try {
    const resets = router.statsResets;
    const { own, resetAt } = await ownSubagents($, router);
    const mine = agents.filter((agent) => agent.sessionId === own.sessionId);
    if (!mine.length) return;
    if (!router.subagentsOthers || subagentsAfterReset(router.subagentsOthers, resetAt) !== router.subagentsOthers)
      router.subagentsOthers = await otherSubagents($, own.sessionId, resetAt);
    if (router.statsResets !== resets) return;
    const now = Date.now();
    own.record = mine.reduce((record, agent) => recordAgent(record, agent, now), own.record);
    await $.store.set(`${SUBAGENT_PREFIX}${own.sessionId}`, own.record);
    if (router.statsResets === resets) await updateView($, router, subagentView(router));
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
  return {
    mode: (mode) => changeMode($, router, mode),
    tab: (tab) => updateView($, router, { tab, notice: null }),
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
    // `/router activities <mode>`: the mode alone, saved at once like a classifier press, with Undo.
    activityRouting: (mode) => {
      const from = router.config.activityRouting;
      if (mode === from) return undefined;
      return write(`activity routing ${from} → ${mode}`, (file) =>
        withActivities(file, { base: { activityRouting: from }, activityRouting: mode }),
      );
    },
    // One reset for both readouts: activity stats and routing vs your model, this session's and the saved ones.
    resetStats: async () => {
      router.statsResets += 1;
      router.run = null;
      router.afterDown = null;
      router.turnSavings.clear();
      for (const [id, agent] of router.agents) router.agents.set(id, flushedAgent(agent));
      const clear = (key, value) =>
        $.store
          .set(key, value)
          .then(() => true)
          .catch(() => false);
      // The per-session records: savings and activity metrics.
      const clearRecords = async () => {
        // Written first, so a session still holding its record from before the reset drops it, unless that record's
        // first reading has the reset's millisecond or the clock moved back across the reset.
        await $.store.set(SAVINGS_RESET_KEY, Date.now());
        const keys = (await $.store.keys()).filter((key) =>
          [SAVINGS_PREFIX, METRICS_PREFIX, SUBAGENT_PREFIX].some((prefix) => key.startsWith(prefix)),
        );
        await Promise.all(keys.map((key) => $.store.delete(key)));
        router.savingsOwn = null;
        router.savingsOthers = emptySavingsStore();
        router.metricsOwn = null;
        router.metricsOthers = emptyMetrics();
        router.subagentsOwn = null;
        router.subagentsOthers = emptySubagentStore();
        return true;
      };
      const [stats, records] = await Promise.all([clear(STORE_KEY, emptyStore()), clearRecords().catch(() => false)]);
      await updateView($, router, {
        activityStats: null,
        savingsBy: {},
        ...(stats ? { activityStore: emptyStore() } : {}),
        ...(records
          ? { activityMetrics: emptyMetrics(), savingsStore: emptySavingsStore(), subagentStore: emptySubagentStore() }
          : {}),
        notice:
          stats && records
            ? 'Stats reset: activity and routing vs your model, this session and saved.'
            : 'This session’s stats reset. Saved stats could not be cleared.',
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
  router.turnActivities.clear();
  router.turnSavings.clear();
  const run = router.run;
  router.run = null;
  router.afterDown = null;
  if (run) await flushRun($, run);
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
        ...(await storeView($, router)),
        ...savedView(router),
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
    const sessionId = await $.session.id();
    const nativeModel = await $.session.model();
    const view = await readView($, router);
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
    const context = await contextOf($, loop);
    const settings = await $.settings.read();
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
      loop = continueRoute(cfg, loop, {
        nativeModel,
        contextTokens: context.tokens,
        contextKnown: context.known,
        availableModels,
        effort: e.effort,
      });
      await updateView($, router, continuationView(cfg, loop.decision, context));
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
    const savings = router.turnSavings.get(e.turnId);
    router.turnSavings.delete(e.turnId);
    if (savings) await flushSavings($, router, savings);
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

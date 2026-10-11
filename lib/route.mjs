import { chooseActivity, compareRoutes, lateralMove, sameRequest } from './activity.mjs';
import { ACTIVITIES, rank, resolveRoute, routeSpec, TIERS } from './config.mjs';
import * as costs from './cost.mjs';
import { clip, extractFacts, verifiedSince } from './facts.mjs';
import { CONTEXT_FILL, decide, fitTier, initialState } from './policy.mjs';

// Exact observed API snapshot, not a rule that merges different dated versions.
const SNAPSHOTS = { 'claude-haiku-4-5': 'claude-haiku-4-5-20251001' };

// A request this much smaller than the last means the history was compacted or rewound: the cached prefixes the
// observations describe are gone, so they are dropped rather than priced as warm.
export const HISTORY_SHRINK = 0.8;

// Whether the engine served the requested model, allowing for a dated snapshot of it.
export function isSameModel(requested, served) {
  return requested === served || SNAPSHOTS[requested] === served;
}

// The engine may echo our own routed model on a continuation; any third model is its fallback.
export function isNativeFallback(loop, model) {
  if (loop.suspended) return true;
  const known = [loop.engineModel, loop.decision?.model].filter(Boolean);
  return known.length > 0 && !known.some((id) => isSameModel(id, model));
}

// The tier and activity whose route runs model `id`, or null when no route names it. Base routes first, baseline
// first; activity overrides only when they apply, with `activityRouting: on`.
export function cellForModel(config, id) {
  const order = [config.baselineTier, ...TIERS.filter((tier) => tier !== config.baselineTier)];
  const runs = (tier, activity) => isSameModel(routeSpec(config, resolveRoute(config, tier, activity)).id, id);
  const tier = order.find((t) => runs(t, null));
  if (tier) return { tier, activity: null };
  if (config.activityRouting !== 'on') return null;
  for (const t of order)
    for (const activity of ACTIVITIES)
      if (config.activities[activity]?.[t] && runs(t, activity)) return { tier: t, activity };
  return null;
}

export function emptyLoop(config, model) {
  const cell = cellForModel(config, model);
  return {
    lastRoute: cell?.tier ?? config.baselineTier,
    lastActivity: cell?.activity ?? null,
    state: initialState(),
    models: {},
    resolutions: {},
    lastRequest: null,
    historyMeasured: false,
    lastMessageCount: null,
    generation: 0,
    turnId: null,
    decision: null,
    ineligible: [],
    // Routed main requests so far, the one that started on the running route (`switchedAt`: requests and message
    // count then), and the request count at the last classifier answer (`reviewedAt`). Dwell and reviews count these.
    requests: 0,
    servedRoute: null,
    switchedAt: null,
    reviewedAt: 0,
    // The message count at the last review applied inside a turn: tool calls before it were already judged, so only
    // later ones can move the route up again (observedMove).
    observedFrom: 0,
    // Each configured model's simulated cache, by models key, for the routing-vs-your-model readout (compareModels in
    // savings.mjs).
    yoursBy: {},
  };
}

const freshState = (state) => ({ ...state, votes: [], holdUntilTurn: 0, escalatedSignature: null });

export function resetHistory(loop) {
  return {
    ...loop,
    generation: loop.generation + 1,
    models: {},
    resolutions: {},
    historyMeasured: false,
    state: freshState(loop.state),
    // The active turn keeps its route, pin and fallback suspension; the next turn decides afresh.
    ineligible: [],
    yoursBy: {},
  };
}

export function prepareLoop(loop, messageCount) {
  if (loop.lastMessageCount === null || messageCount >= loop.lastMessageCount)
    return { ...loop, lastMessageCount: messageCount };
  // Compaction or a rewind shortened the history: message cursors past its end move to it, so checks and edits made
  // from here on count. The request-based dwell is kept.
  const cursor = (count) => Math.min(count ?? 0, messageCount);
  return {
    ...resetHistory(loop),
    lastMessageCount: messageCount,
    switchedAt: loop.switchedAt && { ...loop.switchedAt, messageCount: cursor(loop.switchedAt.messageCount) },
    observedFrom: cursor(loop.observedFrom),
  };
}

export function nativeFacts(config, loop, { messages, prompt, effort, turnId, contextTokens }) {
  const facts = extractFacts({ messages, output_config: { effort } }, loop, config.context);
  if (typeof prompt === 'string') facts.prompt = clip(prompt, config.context.maxTextChars);
  // A move down on the same task waits out the dwell and for a passed verification since the last model change.
  const since = loop.switchedAt ?? { requests: 0, messageCount: 0 };
  const downAllowed =
    (loop.requests ?? 0) - since.requests >= config.policy.minDwellRequests &&
    verifiedSince(messages, since.messageCount);
  // A loop saved without the field counts as measured, keeping the vote streak.
  return {
    ...facts,
    downAllowed,
    pin: null,
    contextTokens,
    turnKey: turnId,
    historyMeasured: loop.historyMeasured !== false,
  };
}

export function isModelAllowed(id, available, nativeModel) {
  if (available === undefined) return true;
  if (!Array.isArray(available) || !available.every((v) => typeof v === 'string')) return false;
  if (available.includes('default') && id === nativeModel) return true;
  const family = /^claude-(opus|sonnet|haiku)-/.exec(id)?.[1];
  const specific = available.filter((v) => family && v.startsWith(`claude-${family}-`));
  if (specific.length) return specific.some((v) => id === v || id.startsWith(`${v}-`));
  return available.some((v) => id === v || id.startsWith(`${v}-`) || (family && v === family));
}

function economicConfig(config, loop) {
  const models = Object.fromEntries(
    Object.entries(config.models).map(([alias, model]) => [
      alias,
      { ...model, id: Object.hasOwn(loop.resolutions, model.id) ? loop.resolutions[model.id] : model.id },
    ]),
  );
  return { ...config, models };
}

// `activityRouting` decides which activity the route may use: none in `off`, the chosen one in `on`.
export function chooseRoute(config, loop, input) {
  const { pin, facts } = input;
  const applied = routeTurn(config, loop, input);
  const kept = pin || !applied.tier;
  return {
    ...loop,
    state: applied.state,
    lastRoute: kept ? loop.lastRoute : applied.tier,
    lastActivity: kept ? activityOf(config, loop) : applied.activity,
    turnId: facts.turnKey,
    decision: applied,
    suspended: false,
    reviewedAt: loop.requests ?? 0,
  };
}

// The activity of the route running now. Outside `on` there is none, even one a turn in `on` left in the loop before
// the mode changed: `off` is the 1.5 decision.
const activityOf = (config, loop) => (config.activityRouting === 'on' ? (loop.lastActivity ?? null) : null);

// One decision (plan §5.2) for the cell `{ tier, activity }` it lands on. Outside `on` the activity is null throughout.
function routeTurn(config, loop, { facts, advice, pin, nativeModel, contextKnown, availableModels, now }) {
  const projected = economicConfig(config, loop);
  const routeOf = (cell) => resolveRoute(config, cell.tier, cell.activity);
  const specOf = (cell) => routeSpec(config, routeOf(cell));
  const last = { tier: loop.lastRoute, activity: activityOf(config, loop) };
  const tier0 = TIERS.includes(facts.lastRoute) ? facts.lastRoute : config.baselineTier;
  const incumbent = { tier: tier0, activity: last.activity, route: resolveRoute(config, tier0, last.activity) };
  const activity =
    pin || config.activityRouting !== 'on' ? null : chooseActivity(config, advice, incumbent, facts.effort, facts);
  let result =
    pin && TIERS.includes(pin)
      ? {
          tier: pin,
          activity: null,
          reason: 'pinned',
          lateral: null,
          escalated: false,
          state: { ...loop.state, turn: loop.state.turn + 1 },
        }
      : decideCell({ config, projected, facts, advice, state: loop.state, now, incumbent, activity });
  // Without a reliable reading of the context, a route with a smaller window than the last one might overflow.
  const shrinksUnmeasured = (cell) =>
    (!contextKnown || !loop.historyMeasured) && specOf(cell).contextWindow < specOf(last).contextWindow;
  const fits = (cell) => {
    const model = specOf(cell);
    return (
      !shrinksUnmeasured(cell) &&
      isModelAllowed(model.id, availableModels, nativeModel) &&
      !loop.ineligible.includes(model.id) &&
      (!contextKnown || costs.nextContextTokens(facts) <= model.contextWindow * CONTEXT_FILL)
    );
  };
  if (contextKnown) {
    const routeFor = (tier) => resolveRoute(config, tier, result.activity);
    const fitted = fitTier(config, result.tier, costs.nextContextTokens(facts), routeFor);
    if (fitted !== result.tier) result = { ...result, tier: fitted, reason: 'context-fit', lateral: null };
  }
  // A lateral outcome describes the cell the lateral rule chose; a context or availability override replaces it.
  if (shrinksUnmeasured(result)) result = { ...result, ...last, reason: 'context-unknown', lateral: null };
  if (!fits(result)) {
    // A cell labelled with another activity would run, and stick, a route this turn did not choose.
    const native = cellForModel(config, nativeModel);
    const cells = [last, native, ...TIERS.map((tier) => ({ tier, activity }))];
    const fallback = cells.find(
      (cell) => cell && (cell.activity === null || cell.activity === activity) && fits(cell),
    ) ?? { tier: null, activity: null };
    result = { ...result, ...fallback, reason: 'model-unavailable', lateral: null };
  }
  const route = result.tier ? routeOf(result) : null;
  const model = route ? routeSpec(config, route).id : nativeModel;
  const effort = route ? costs.routeEffort(config, route, facts.effort) : facts.effort;
  let comparison = null;
  const candidate = pin ?? advice?.choice;
  if (contextKnown && loop.lastRequest && TIERS.includes(candidate) && candidate !== loop.lastRoute) {
    const [to, from] = [resolveRoute(config, candidate, activity), routeOf(last)];
    const forecast = costs.switchEconomics(projected, to, from, facts, now);
    comparison = {
      candidate,
      incumbent: loop.lastRoute,
      ...costs.nextTurnRange(projected, to, from, facts, now),
      paybackTurns: forecast?.paybackTurns ?? null,
      outputTokens: loop.lastRequest.outputTokens,
    };
  }
  return { ...result, model, effort, comparison, pinned: Boolean(pin), requestedPin: pin ?? null };
}

// Steps 3-6 of plan §5.2: the tier as `decide` picks it, every candidate priced at its route for `activity` and the
// incumbent at the route it runs; then, when the tier stays and the route would change, the lateral rule. Equal routes
// never switch: a label alone decides nothing.
function decideCell({ config, projected, facts, advice, state, now, incumbent, activity }) {
  const routeFor = (tier) => resolveRoute(config, tier, activity);
  // With an activity, failures move to the lowest tier whose route is stronger, or another request that does not
  // order against it; with none, one tier up as before.
  const escalates = (t) => {
    const order = compareRoutes(config, routeFor(t), incumbent.route, facts.effort);
    return order > 0 || (order === null && !sameRequest(config, routeFor(t), incumbent.route, facts.effort));
  };
  const escalateTo = activity === null ? undefined : (tier) => TIERS.slice(rank(tier) + 1).find(escalates) ?? null;
  const step = decide({
    config: projected,
    facts,
    advice,
    state,
    baseline: config.baselineTier,
    now,
    costs,
    routeFor,
    incumbentRoute: incumbent.route,
    escalateTo,
  });
  // `decide` takes the failure's signature whenever it escalates, before the cash gate can hold the move; a later
  // context or availability override keeps the flag.
  const escalated = step.state.escalatedSignature !== state.escalatedSignature;
  const route = routeFor(step.tier);
  if (step.tier !== incumbent.tier || sameRequest(config, route, incumbent.route, facts.effort))
    return { ...step, activity, lateral: null, escalated };
  const lateral = lateralMove({
    config: projected,
    from: incumbent.route,
    to: route,
    // Returning to the base route needs no evidence.
    mass: activity === null ? 1 : (advice?.activity?.probabilities?.[activity] ?? 0),
    hold: step.reason === 'hold',
    facts,
    now,
    costs,
  });
  const activityOf = lateral.move ? activity : incumbent.activity;
  return {
    ...step,
    activity: activityOf,
    reason: lateral.reason,
    estimate: lateral.estimate,
    lateral: lateral.move ? 'taken' : 'refused',
    escalated,
  };
}

// Whether some activity's route at the decision's tier is stronger than the one running: only then can the turn's own
// tool calls move it (observedMove), so a step on the strongest route skips reading the transcript.
export function canMoveUp(config, decision, effort) {
  if (config.activityRouting !== 'on' || !decision?.tier || decision.pinned) return false;
  const from = resolveRoute(config, decision.tier, decision.activity ?? null);
  return ACTIVITIES.some((a) => compareRoutes(config, resolveRoute(config, decision.tier, a), from, effort) > 0);
}

// A move up inside a turn: the classifier labels a turn from its prompt, and a prompt that reads as ops or explore can
// still end up editing code. Once the turn's tool calls show an activity (observedActivity in facts.mjs) whose route at the
// tier is stronger, the remaining steps take that route. The tools are the evidence, so the move needs no classifier
// probability. At probability 1 the switching tax never holds it back (the upgrade bar tops out near 0.9): only the
// cash gate, priced at the context-fitted route, can. Only up: a move down comes from a classifier review, past its
// checks. Returns the loop, unchanged when nothing moves.
export function observedMove(config, loop, { observed, facts, contextKnown, now }) {
  const decision = loop.decision;
  if (!canMoveUp(config, decision, facts.effort) || !ACTIVITIES.includes(observed)) return loop;
  const from = resolveRoute(config, decision.tier, decision.activity ?? null);
  // The gates price the route that will run: the one the context fits, not the tier's first choice.
  const routeFor = (tier) => resolveRoute(config, tier, observed);
  const tier = fitTier(config, decision.tier, costs.nextContextTokens(facts), routeFor);
  const to = routeFor(tier);
  if (!(compareRoutes(config, to, from, facts.effort) > 0)) return loop;
  // Without a reliable reading of the context, a smaller window might overflow, as in routeTurn.
  const window = (route) => routeSpec(config, route).contextWindow;
  if ((!contextKnown || !loop.historyMeasured) && window(to) < window(from)) return loop;
  const projected = economicConfig(config, loop);
  const lateral = lateralMove({ config: projected, from, to, mass: 1, hold: false, facts, now, costs });
  if (!lateral.move) return loop;
  return {
    ...loop,
    lastActivity: observed,
    decision: {
      ...decision,
      tier,
      activity: observed,
      model: routeSpec(config, to).id,
      effort: costs.routeEffort(config, to, facts.effort),
      reason: lateral.reason,
      estimate: lateral.estimate,
    },
  };
}

// A tool continuation keeps the turn's route and activity; only the context, the model list, or the turn's own tool
// calls (observedMove) can move it.
export function continueRoute(config, loop, { nativeModel, contextTokens, contextKnown, availableModels, effort }) {
  if (!loop.decision) return loop;
  let decision = loop.decision;
  if (contextKnown && decision.tier) {
    const routeOf = (tier) => resolveRoute(config, tier, decision.activity ?? null);
    const fitted = fitTier(config, decision.tier, contextTokens, routeOf);
    if (fitted !== decision.tier)
      decision = {
        ...decision,
        tier: fitted,
        model: routeSpec(config, routeOf(fitted)).id,
        effort: costs.routeEffort(config, routeOf(fitted), effort),
        reason: 'context-fit',
      };
  }
  if (!isModelAllowed(decision.model, availableModels, nativeModel) || loop.ineligible.includes(decision.model)) {
    decision = { ...decision, tier: null, activity: null, model: nativeModel, effort, reason: 'model-unavailable' };
  }
  return { ...loop, decision };
}

export function observeResponse(config, loop, { usage, requestedModel, effort, stopReason, now }) {
  // Every request counts toward dwell and reviews; a request on another (model, effort) than the last starts a dwell,
  // and so does the first one this loop serves: checks from before it ran on a route the router did not choose.
  const served = `${requestedModel}@${effort ?? 'session'}`;
  const requests = (loop.requests ?? 0) + 1;
  const switched = loop.servedRoute !== served;
  let next = {
    ...loop,
    requests,
    servedRoute: served,
    switchedAt: switched ? { requests, messageCount: loop.lastMessageCount ?? 0 } : (loop.switchedAt ?? null),
  };
  if (stopReason === 'model_context_window_exceeded') {
    next = { ...next, ineligible: [...new Set([...next.ineligible, requestedModel])] };
  }
  if (!usage?.model) return next;
  const sameModel = isSameModel(requestedModel, usage.model);
  if (!sameModel) next = { ...next, suspended: true };
  const counts = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'output_tokens'];
  if (!counts.every((key) => Number.isFinite(usage[key]) && usage[key] >= 0)) return next;
  const tokens = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens;
  if (tokens === 0) return next;
  const resolutions = sameModel ? { ...next.resolutions, [requestedModel]: usage.model } : { ...next.resolutions };
  if (!sameModel) delete resolutions[requestedModel];
  let models = next.models;
  if (next.lastRequest && tokens < next.lastRequest.tokens * HISTORY_SHRINK) models = {};
  // A substituted model's effort is not reported, so do not credit its estimated cache.
  if (sameModel)
    models = {
      ...models,
      [costs.cacheKey(config, usage.model, effort)]: {
        lastAt: now,
        prefixTokens: usage.cache_read_input_tokens + usage.cache_creation_input_tokens,
      },
    };
  return {
    ...next,
    historyMeasured: true,
    models,
    resolutions,
    lastRequest: {
      model: usage.model,
      tokens,
      outputTokens: usage.output_tokens,
      cacheReadTokens: usage.cache_read_input_tokens,
      cacheWriteTokens: usage.cache_creation_input_tokens,
      at: now,
    },
  };
}

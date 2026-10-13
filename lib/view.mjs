// The view the band and pane draw from: its initial shape and the patches built from pure inputs. Pure: the hook
// writes the view to $.state.

// Replies kept for the pane's trend and tier strip.
const HISTORY = 30;

export function initialView(model) {
  return {
    phase: 'ready',
    activeTurnId: null,
    mode: 'auto',
    nativeModel: model,
    // The effort Claude Code sent on the turn's first request, before routing: with nativeModel, "your model".
    nativeEffort: null,
    selectedModel: null,
    actualModel: null,
    tier: null,
    effort: null,
    reason: 'ready',
    error: null,
    pendingPin: null,
    credentials: null,
    contextTokens: null,
    contextKnown: false,
    cacheRead: null,
    cacheWrite: null,
    health: { failures: 0, pausedUntil: 0 },
    inputTokens: null,
    outputTokens: null,
    adviceMs: null,
    adviceChoice: null,
    estimate: null,
    comparison: null,
    probabilities: null,
    activity: null,
    activityChoice: null,
    activityProbabilities: null,
    history: [],
    tiers: [],
    activities: [],
    routes: [],
    activityStats: null,
    activityStore: null,
    activityMetrics: null,
    // Routing vs your model: this session's totals and the totals kept across sessions as last read or written.
    // Routing vs each configured model this session, by models key; `savings` is the one /model selects now.
    savingsBy: {},
    savings: null,
    // The undated savings totals from before the usage records, added to the All period.
    savingsStore: null,
    // Routed usage by day: every session's records as last read or written, and this session's own.
    usageStore: null,
    usageSession: null,
    // The Usage tab's controls: the period (kept across sessions), the breakdown, the what-if view, the open row
    // (`<group>:<name>`), and whether Delete history waits for its confirmation.
    usagePeriod: 'session',
    usageGroup: 'activity',
    usageCompare: false,
    usageOpen: null,
    confirmDelete: false,
    configPath: null,
    tuning: null,
    tuningBase: null,
    routeDraft: null,
    lastWrite: null,
    tab: 'now',
    routeCell: null,
    usageDetail: false,
    help: false,
    notice: null,
  };
}

// Failures and a pause belong to the classifier that earned them.
export const healthOf = (client, id) => ({ ...client.snapshot(), classifier: id });
// The last classification's readings, cleared when another classifier takes over so no label claims them.
export const CLEARED_READINGS = {
  adviceMs: null,
  adviceChoice: null,
  probabilities: null,
  estimate: null,
  activityChoice: null,
  activityProbabilities: null,
};

// The view patch for a tool continuation's route. In `on` the activity label is the route's, which a fallback to the
// native model drops.
export function continuationView(config, decision, context) {
  return {
    selectedModel: decision.model,
    effort: decision.effort,
    tier: decision.tier,
    reason: decision.reason,
    contextTokens: context.tokens,
    contextKnown: context.known,
    ...(config.activityRouting === 'on' ? { activity: decision.activity ?? null } : {}),
  };
}

// The view patch for a main reply's usage. `tier` is the routed tier that served it, else null; `activity` the
// turn's activity as the view labels it, else null.
// `route` is the (model, effort) the request went out with, so the switch count reads what served each reply.
export function responseMetrics(view, response, tier, activity = null, route = null) {
  const usage = response.usage;
  const counters = usage ? [usage.input_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens] : [];
  const inputTokens =
    counters.length && counters.every(Number.isFinite) ? counters.reduce((sum, n) => sum + n, 0) : null;
  return {
    actualModel: usage?.model ?? null,
    cacheRead: usage?.cache_read_input_tokens ?? null,
    cacheWrite: usage?.cache_creation_input_tokens ?? null,
    inputTokens,
    outputTokens: usage?.output_tokens ?? null,
    // Appended together so the Usage trend can color each reading by its tier, and REPLIES letter it by activity.
    ...(Number.isFinite(inputTokens)
      ? {
          history: [...(view?.history ?? []), inputTokens].slice(-HISTORY),
          tiers: [...(view?.tiers ?? []), tier ?? null].slice(-HISTORY),
          activities: [...(view?.activities ?? []), activity ?? null].slice(-HISTORY),
          routes: [...(view?.routes ?? []), route ?? null].slice(-HISTORY),
        }
      : {}),
  };
}

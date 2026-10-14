// The view the band and pane draw from: its initial shape and the patches built from pure inputs. Pure: the hook
// writes the view to $.state.

// Replies kept for the input trend behind the Now tab's details.
export const HISTORY = 30;
// The session strip's most cells. Once it is full, neighbouring cells merge, so each covers twice the replies and the
// strip always spans the whole session in a bounded view.
export const STRIP_CELLS = 48;

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
    // The session's replies by tier (addToStrip), and the last route switch: when, the tiers and routes it moved
    // between, and the turn's activity.
    strip: null,
    lastSwitch: null,
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
    // Subagents by day: every session's records as last read or written, and this session's own.
    subagentStore: null,
    subagentSession: null,
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

// The view patch for a route switch at `at`: the routes it moved between with their tiers, and the activity the new
// route runs for (null outside activity routing `on`).
export const switchView = (from, to, activity, at) => ({
  lastSwitch: { at, from: routeOf(from), to: routeOf(to), activity: activity ?? null },
});
const routeOf = (decision) => ({ tier: decision.tier ?? null, model: decision.model, effort: decision.effort ?? null });

// A reply that arrived `at` (ms) added to the session strip, `{ per, cells, from }`: each cell counts up to `per`
// replies by tier, `none` for one routing did not serve, and `from` is when the first reply arrived. A full strip
// merges each pair of cells first. The view lives as long as the Claude Code process, so after a restart the strip
// starts again while the session's usage record goes on: `from` tells the two apart.
export function addToStrip(strip, tier, at = null) {
  const key = tier ?? 'none';
  const from = strip?.from ?? at;
  let per = strip?.per ?? 1;
  let cells = strip?.cells ?? [];
  const last = cells.at(-1);
  if (last && Object.values(last).reduce((sum, n) => sum + n, 0) < per)
    return { per, cells: [...cells.slice(0, -1), { ...last, [key]: (last[key] ?? 0) + 1 }], from };
  if (cells.length >= STRIP_CELLS) {
    cells = mergePairs(cells);
    per *= 2;
  }
  return { per, cells: [...cells, { [key]: 1 }], from };
}

// Each pair of cells as one, its counts added; an odd last cell stays as it is.
export function mergePairs(cells) {
  const merged = [];
  for (let i = 0; i < cells.length; i += 2) {
    const cell = { ...cells[i] };
    for (const [key, n] of Object.entries(cells[i + 1] ?? {})) cell[key] = (cell[key] ?? 0) + n;
    merged.push(cell);
  }
  return merged;
}

// The view patch for a main reply's usage that arrived `at` (ms). `tier` is the routed tier that served it, else null.
export function responseMetrics(view, response, tier, at = null) {
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
    // Appended together so the input trend can color each reading by its tier.
    ...(Number.isFinite(inputTokens)
      ? {
          history: [...(view?.history ?? []), inputTokens].slice(-HISTORY),
          tiers: [...(view?.tiers ?? []), tier ?? null].slice(-HISTORY),
          strip: addToStrip(view?.strip, tier, at),
        }
      : {}),
  };
}

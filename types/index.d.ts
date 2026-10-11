declare module 'claude-code' {
  type RouterTier = 'micro' | 'low' | 'medium' | 'high';
  type RouterCacheState = 'fresh' | 'unknown';
  // What kind of work a turn does (ACTIVITIES in lib/config.mjs); 'uncertain' only as a classifier answer.
  type RouterActivity = 'code' | 'debug' | 'explore' | 'plan' | 'review' | 'ops' | 'docs';
  type RouterActivityAnswer = RouterActivity | 'uncertain';
  type RouterActivityMode = 'off' | 'on';
  // A finished turn's bucket, read from its tool calls.
  type RouterObserved = 'code' | 'docs' | 'ops' | 'read' | 'talk';
  // A route change inside the incumbent's tier: taken, refused (does not pay back, a hold, the cash gate), or none.
  type RouterLateral = 'taken' | 'refused' | null;
  // Classifier output. `activity` is null when not asked, or missing, malformed or failed.
  interface RouterAdvice {
    choice: RouterTier | 'uncertain';
    confidence: number;
    probabilities: Record<RouterTier | 'uncertain', number>;
    continuation: number | null;
    activity?: {
      choice: RouterActivityAnswer;
      probabilities: Record<RouterActivityAnswer, number>;
    } | null;
  }
  interface RouterActivityCounts {
    turns: number;
    requests: number;
    inputTokens: number;
    outputTokens: number;
    // The list price of the priced replies (null: none had one), how many replies had a price, and routed replies by
    // `model@effort`; absent in views saved by 1.7.0.
    routedUsd?: number | null;
    pricedRequests?: number;
    routes?: Record<string, number>;
  }
  // Per-session activity stats; 'none' counts turns without an applied or accepted activity.
  interface RouterActivitySession {
    byActivity: Partial<Record<RouterActivity | 'none', RouterActivityCounts>>;
    switches: { tier: number; activity: number };
    // Lateral moves taken and refused (by economics, a hold or the cash gate); absent in views saved by 1.7.0.
    lateral?: { taken: number; refused: number };
    agreement: { matched: number; total: number };
  }
  // Cross-session counts under store key 'activity:stats:v1'. `runs` buckets run lengths 1, 2, 3, 4, 5+.
  interface RouterActivityStore {
    version: 1;
    confusion: Partial<Record<RouterActivityAnswer | 'none', Partial<Record<RouterObserved, number>>>>;
    runs: Partial<Record<RouterActivity, [number, number, number, number, number]>>;
    lateral: { taken: number; refused: number };
  }
  // Cross-session readings under store key 'activity:metrics:v1'. Classifier wait per turn by classifier id, in
  // LATENCY_BOUNDS buckets plus one above; at most 8 ids. Cheaper activity moves taken in 'on' and the escalations that
  // followed one.
  interface RouterActivityMetrics {
    version: 1;
    latency: Record<string, number[]>;
    downMoves: { moves: number; escalations: number };
  }
  interface RouterComparison {
    candidate: RouterTier;
    incumbent: RouterTier;
    minUsd: number;
    maxUsd: number;
    paybackTurns: number | null;
    outputTokens: number;
  }
  interface RouterEstimate {
    taxUsd?: number;
    threshold?: number;
    upgradeMass?: number;
    downgradeMass?: number;
    streak?: number;
    coldUsd?: number;
    cap?: number;
    cache?: RouterCacheState | { candidate: RouterCacheState; incumbent: RouterCacheState };
  }
  interface RouterTuning {
    downgradeVotes: number;
    horizon: number;
    cashCapUsd: number;
  }
  // A model alias and the effort it runs at: what Claude Code receives and what owns a cache.
  interface RouterRoute {
    model: string;
    effort?: string | null;
  }
  interface RouterRoutes {
    routes: Record<RouterTier, RouterRoute>;
    baselineTier: RouterTier;
    // The Routing tab's activity edits; a draft without them edits none. A null cell is a removed override.
    activities?: Partial<
      Record<RouterActivity, Partial<Record<RouterTier, { model?: string; effort?: string | null } | null>>>
    >;
    activityRouting?: RouterActivityMode;
  }
  // Routing vs your model at configured list prices, in USD: routed replies, the same tokens on your model, and the
  // difference's parts (cheaper models, stronger than yours, cache writes from switches), which sum to it.
  interface RouterSavingsSums {
    replies: number;
    routedUsd: number;
    yoursUsd: number;
    cheaperUsd: number;
    strongerUsd: number;
    switchUsd: number;
  }
  // A session's totals; per tier ('none': not chosen by routing) its replies and their routed cost, and replies by the
  // stronger model they ran on.
  interface RouterSavingsSession extends RouterSavingsSums {
    tiers: Partial<Record<RouterTier | 'none', number>>;
    tierUsd: Partial<Record<RouterTier | 'none', number>>;
    stronger: Record<string, number>;
  }
  // Totals kept across sessions, one per session under store key 'savings:v1:<session id>' or their sum in the view,
  // since the first reply after the last reset (ms).
  interface RouterSavingsStore extends RouterSavingsSums {
    version: 1;
    since: number | null;
  }
  // Subagent routing counts for one agent type in one mode (lib/subagents.mjs). `differs`: agents the decision moved off
  // core's model; `choices`: agents by models key decided, or 'core'. USD over the priced requests.
  interface RouterSubagentCounts {
    agents: number;
    differs: number;
    requests: number;
    pricedRequests: number;
    coreUsd: number;
    routedUsd: number;
    respawns: number;
    failures: number;
    choices: Record<string, number>;
  }
  // Spawns that passed through for one reason, priced on the model they ran on.
  interface RouterSubagentPassed {
    agents: number;
    requests: number;
    pricedRequests: number;
    usd: number;
  }
  // Kept across sessions, one per session under store key 'subagents:v1:<session id>' or their sum in the view, since
  // the first agent after the last reset (ms).
  interface RouterSubagentStore {
    version: 1;
    since: number | null;
    routed: { on: Record<string, RouterSubagentCounts> };
    passed: Partial<Record<'fork' | 'explicit' | 'teammate' | 'workflow' | 'unlisted', RouterSubagentPassed>>;
  }
  interface RouterView {
    phase: 'ready' | 'choosing' | 'routed' | 'manual' | 'unavailable';
    mode: 'auto' | 'manual';
    nativeModel: string;
    // The effort Claude Code sent on the turn's first request, before routing.
    nativeEffort?: string | number | null;
    activeTurnId?: string | null;
    selectedModel?: string | null;
    actualModel?: string | null;
    tier?: RouterTier | null;
    effort?: string | number | null;
    reason?: string;
    error?: string | null;
    pendingPin?: RouterTier | null;
    // Per classifier id: what its credentials lack, or null when complete.
    credentials?: Record<string, 'missing-key' | 'missing-account' | null> | null;
    contextTokens?: number | null;
    contextKnown?: boolean;
    cacheRead?: number | null;
    cacheWrite?: number | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    health?: { failures: number; pausedUntil: number; classifier?: string };
    adviceMs?: number | null;
    adviceChoice?: RouterTier | 'uncertain' | null;
    estimate?: RouterEstimate | null;
    comparison?: RouterComparison | null;
    probabilities?: Partial<Record<RouterTier | 'uncertain', number>> | null;
    // The turn's activity, applied in 'on'.
    activity?: RouterActivity | null;
    activityChoice?: RouterActivityAnswer | null;
    activityProbabilities?: Partial<Record<RouterActivityAnswer, number>> | null;
    history?: number[];
    tiers?: (RouterTier | null)[];
    // Aligned with `history` and `tiers`.
    activities?: (RouterActivity | null)[];
    // The (model, effort) each reply's request went out with, aligned with tiers; null where routing did not choose.
    routes?: (string | null)[];
    activityStats?: RouterActivitySession | null;
    // The counts kept across sessions as last read or written.
    activityStore?: RouterActivityStore | null;
    activityMetrics?: RouterActivityMetrics | null;
    savings?: RouterSavingsSession | null;
    savingsStore?: RouterSavingsStore | null;
    subagentStore?: RouterSubagentStore | null;
    configPath?: string | null;
    tuning?: Partial<RouterTuning> | null;
    tuningBase?: RouterTuning | null;
    routeDraft?: (RouterRoutes & { base: RouterRoutes }) | null;
    // The last pane write to router.json: each leaf it changed with the value the file had before, none if absent.
    lastWrite?: { label: string; leaves: { path: string[]; value?: unknown }[] } | null;
    tab?: 'now' | 'routes' | 'policy' | 'classifier' | 'usage';
    // The Routes grid cell whose editor is open: '<activity>.<tier>', or 'tier.<tier>' for a tier's own route.
    routeCell?: string | null;
    // Whether the Usage tab shows Claude's readings in detail, with the estimates.
    usageDetail?: boolean;
    help?: boolean;
    bandDetail?: boolean;
    notice?: string | null;
  }
  interface RouterPolicyState {
    turn: number;
    votes: { tier: RouterTier; turn: number }[];
    holdUntilTurn: number;
    escalatedSignature: string | null;
  }
  interface RouterLoop {
    lastRoute: RouterTier;
    // The activity of the route running now; absent in loops saved before 1.6.
    lastActivity?: RouterActivity | null;
    state: RouterPolicyState;
    models: Record<string, { lastAt: number; prefixTokens: number }>;
    resolutions: Record<string, string>;
    lastRequest: {
      model: string;
      tokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      at: number;
    } | null;
    lastMessageCount: number | null;
    historyMeasured?: boolean;
    generation: number;
    turnId: string | null;
    decision: {
      tier: RouterTier | null;
      reason: string;
      state: RouterPolicyState;
      model: string;
      effort: string | number | null;
      estimate?: RouterEstimate | null;
      comparison?: RouterComparison | null;
      // The applied activity.
      activity?: RouterActivity | null;
      lateral?: RouterLateral;
      // A failure asked for an escalation this turn, also one the cash gate held or context-fit replaced.
      escalated?: boolean;
      pinned: boolean;
      requestedPin: RouterTier | null;
    } | null;
    ineligible: string[];
    // Your model's simulated cache for routing vs your model: the last prompt's tokens, when, whether that reply ran
    // on your route, and the model and effort it was kept for. Null at the start and after a compaction.
    yours?: { total: number; at: number; onYours: boolean; model: string; effort: string | null } | null;
    engineModel?: string;
    suspended?: boolean;
  }
  interface PluginState {
    router: {
      view: RouterView;
      loops: StateFamily<RouterLoop>;
    };
  }
}

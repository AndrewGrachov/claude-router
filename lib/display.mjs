import { acceptActivity } from './activity.mjs';
import { readStore, storeSummary } from './activity-stats.mjs';
import {
  activeClassifier,
  CLASSIFIER_OPTIONS,
  endpointSettings,
  resolveRoute,
  routeSpec,
  sameRoute,
} from './config.mjs';
import { ratesAt } from './cost.mjs';
import { PROBE_RESULTS } from './probe-results.mjs';
import { cellForModel } from './route.mjs';
import { emptyTotals, readout, readSavingsStore } from './savings.mjs';

// Cost order, cheapest first, so the colors read as a scale. Hex values: every surface draws them.
export const TIER_COLOR = { micro: '#5fd7af', low: '#5f9fe0', medium: '#d7af5f', high: '#e0708a' };

// Why routing starts off: the session's model is no tier's model. Set at session start, read by the band.
export const NOT_A_TIER_REASON = 'not a routing tier';

export function modelName(id) {
  if (!id) return 'no response yet';
  return id
    .replace(/^claude-/, '')
    .replace(/-([0-9])-([0-9])(-\d{8})?$/, ' $1.$2')
    .replace(/^./, (c) => c.toUpperCase());
}

// "Opus 5.5 · high"; a model with no effort reading shows its name alone.
export const routeLabel = (model, effort) =>
  `${modelName(model)}${effort === null || effort === undefined ? '' : ` · ${effort}`}`;

// A configured route by its model's name; a null effort is the session's, and a model without efforts shows none.
export function routeName(config, route) {
  const model = config.models[route.model];
  return `${modelName(model.id)}${model.efforts.length ? ` · ${route.effort ?? 'session'}` : ''}`;
}

// Changes of route between consecutive replies, from the (model, effort) each request went out with, so a move inside
// a tier counts and a later change of settings does not rewrite the count. A reply routing did not choose breaks no run.
export const switchCount = (routes) =>
  routes.slice(1).filter((route, i) => route && routes[i] && route !== routes[i]).length;

export const percent = (value) => `${Math.round(value * 100)}%`;

// Two shares that are compared, such as a classifier's support and the bar it must clear: whole percents, or as many
// decimals (up to two) as it takes for unequal values not to read as equal, "81.0%" against "81.4%".
export function percentPair(a, b) {
  const at = (digits) => [a, b].map((value) => `${(value * 100).toFixed(digits)}%`);
  for (const digits of [0, 1]) {
    const pair = at(digits);
    if (a === b || pair[0] !== pair[1]) return pair;
  }
  return at(2);
}

export const REASONS = {
  ready: 'ready for the next turn',
  'same-tier': 'the task fits the current tier',
  'no-advice': 'keeping the current model without classifier advice',
  continuation: 'continuing the previous task',
  uncertain: 'the classifier could not justify a change',
  upgrade: 'enough support for a stronger model',
  jump: 'clear need for a stronger model',
  downgrade: 'enough support for a cheaper model',
  'upgrade-pending': 'waiting before upgrading',
  'downgrade-pending': 'switching is not justified yet',
  hold: 'staying after an escalation',
  escalation: 'repeated tool failures need a stronger model',
  'cash-gate': 'estimated cold cache write exceeds the cap',
  'context-fit': 'a larger context window is needed',
  'context-unknown': 'context is not measured reliably',
  'model-unavailable': 'the requested model is not available',
  pinned: 'one-turn model pin',
  manual: 'routing did not choose this turn, so Claude’s model is kept',
  'routing off': 'routing is off, so Claude’s model is kept',
  'native-fallback': 'Claude Code switched to another model, so the router kept it',
  interrupted: 'the turn ended before a model was chosen',
  'activity-up': 'the activity needs a stronger route',
  'activity-down': 'a cheaper route fits the activity and is estimated to pay back its cache write',
  'activity-pending': 'a route for the activity does not pay back yet',
};

// The active decision model behind the router. Named in the UI only where it explains a reading or a failure.
export const classifierLabel = (config) => activeClassifier(config).label;
// The credentials error of classifier `id` from the view, or null when its key and endpoint settings are all there.
// Not yet read counts as a missing key, unless the classifier takes no key.
export const missingCredentials = (config, view, id) => {
  if (view.credentials && Object.hasOwn(view.credentials, id)) return view.credentials[id];
  return config.classifiers[id].keyOption === null ? null : 'missing-key';
};
// What classifier `id` lacks, named by the setting the person enters: "no API token", "no account ID".
export function missingText(config, id, missing) {
  const entry = config.classifiers[id];
  const option = missing === 'missing-key' ? entry.keyOption : endpointSettings(entry.endpoint)[0];
  return `no ${CLASSIFIER_OPTIONS[option] ?? 'setting'}`;
}

// The active classifier with what went wrong: "Jev: no API key", "Clef timed out". Short: the band keeps it whole.
export function classifierStatus(config, error) {
  const label = activeClassifier(config).label;
  return error === 'missing-key' || error === 'missing-account'
    ? `${label}: ${missingText(config, config.classifier, error)}`
    : `${label} ${CLASSIFIER_ERRORS[error]?.text ?? error}`;
}

// Every classifier error: its words after the label (missing credentials name the setting instead), whether the band
// warns (busy and cancelled are routine and pass silently), and whether the wait counts as a timed reading (a request
// that was never sent does not).
const CLASSIFIER_ERRORS = {
  'missing-key': { text: null, warn: true, timed: false },
  'missing-account': { text: null, warn: true, timed: false },
  paused: { text: 'paused after failures', warn: true, timed: false },
  busy: { text: 'busy', warn: false, timed: false },
  timeout: { text: 'timed out', warn: true, timed: true },
  auth: { text: 'rejected the key', warn: true, timed: true },
  http: { text: 'request failed', warn: true, timed: true },
  unreachable: { text: 'unreachable', warn: true, timed: true },
  policy: { text: 'blocked by network policy', warn: true, timed: true },
  malformed: { text: 'sent a bad answer', warn: true, timed: true },
  cancelled: { text: 'cancelled', warn: false, timed: true },
};
export const classifierWarns = (error) => CLASSIFIER_ERRORS[error]?.warn === true;
// No error, or one outside the table, times the wait.
export const classifierTimed = (error) => CLASSIFIER_ERRORS[error]?.timed !== false;
// One or two words for the band; REASONS holds the sentence the pane shows.
export const SHORT_REASONS = {
  ready: 'ready',
  'same-tier': '= fits',
  'no-advice': '= no advice',
  continuation: '→ continuing',
  uncertain: '= uncertain',
  upgrade: '↑ upgrade',
  jump: '↑ jump',
  downgrade: '↓ downgrade',
  'upgrade-pending': '… waiting to go up',
  'downgrade-pending': '… waiting to go down',
  hold: '= holding',
  escalation: '↑ tool errors',
  'cash-gate': '= cash cap',
  'context-fit': '↑ context',
  'context-unknown': '= context unknown',
  'model-unavailable': '! model unavailable',
  'native-fallback': '! fallback',
  pinned: '⏵ pinned',
  interrupted: 'interrupted',
  'activity-up': '↗ {activity}',
  'activity-down': '↘ {activity}',
  'activity-pending': '… {activity}: not worth a switch',
};

// What the band calls each activity: the verb for the work, as Claude Code names a turn's action.
const ACTIVITY_VERB = {
  code: 'coding',
  debug: 'debugging',
  explore: 'exploring',
  plan: 'planning',
  review: 'reviewing',
  ops: 'running',
  docs: 'documenting',
};
export const activityVerb = (activity) => ACTIVITY_VERB[activity] ?? activity;

// The band's words for `reason`; an activity move names the activity it is about, `base` for the tier's own route.
export const shortReason = (reason, activity) =>
  (SHORT_REASONS[reason] ?? reason ?? '').replace('{activity}', activity ? activityVerb(activity) : 'base');

// The activity a reason is about: the applied one for a move, and for a refused move the classifier's activity when
// it carries enough mass to apply, else null (the tier's base route).
export function reasonActivity(config, view) {
  if (view.reason !== 'activity-pending') return view.activity ?? null;
  return acceptActivity(config, {
    activity: { choice: view.activityChoice, probabilities: view.activityProbabilities },
  });
}

// The classifier's activity answer: its choice with the share it got and the two runners-up, or null when there is
// none.
export function activityReading(view) {
  const choice = view.activityChoice ?? view.activity ?? null;
  if (!choice) return null;
  const probabilities = Object.entries(view.activityProbabilities ?? {}).filter(([, p]) => Number.isFinite(p));
  const share = probabilities.find(([name]) => name === choice)?.[1];
  const others = probabilities
    .filter(([name, p]) => name !== choice && p > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([name, p]) => `${name} ${percent(p)}`);
  return { choice, share: Number.isFinite(share) ? percent(share) : null, others };
}

// The route the turn's cell resolves to, against the tier's base route. Null outside `on`, or before a turn has a tier.
function activityRouteText(config, view) {
  if (config.activityRouting !== 'on' || !view.tier) return null;
  const cell = `${view.tier}${view.activity ? ` + ${view.activity}` : ''}`;
  const route = resolveRoute(config, view.tier, view.activity ?? null);
  const base = resolveRoute(config, view.tier);
  return sameRoute(route, base)
    ? `${cell} → ${routeName(config, route)} (base)`
    : `${cell} → ${routeName(config, route)}   (override)   base: ${routeName(config, base)}`;
}

// Reasons that only say the route stayed: on an override cell they leave out why it is not the tier's base route.
const STAYED = ['ready', 'same-tier', 'no-advice', 'continuation', 'uncertain'];

// The Now tab's Why. In `on`, an activity move, or a stay on an override cell, says the cell plainly: "coding at low
// runs on Sonnet 5.5 · high", or for a move to no activity "low runs on its base route, Haiku 5.5 · high".
// Every other decision keeps its reason: a refusal, a hold or a tier move says more than the cell.
export function whyText(config, view) {
  const reason = REASONS[view.reason] ?? view.reason ?? 'ready';
  if (config.activityRouting !== 'on' || !view.tier) return reason;
  const activity = view.activity ?? null;
  const route = resolveRoute(config, view.tier, activity);
  const override = activity !== null && !sameRoute(route, resolveRoute(config, view.tier));
  const moved = view.reason === 'activity-up' || view.reason === 'activity-down';
  if (!moved && !(override && STAYED.includes(view.reason ?? 'ready'))) return reason;
  return activity
    ? `${activityVerb(activity)} at ${view.tier} runs on ${routeName(config, route)}`
    : `${view.tier} runs on its base route, ${routeName(config, route)}`;
}

// The activity lines of /router without a UI surface: "Activity: ops (81%)" and the resolved route. None in `off`.
export function activityDetailLines(config, view) {
  if (config.activityRouting === 'off') return [];
  const reading = activityReading(view);
  const route = activityRouteText(config, view);
  return [
    `Activity: ${reading ? `${reading.choice}${reading.share ? ` (${reading.share})` : ''}` : 'none yet'}`,
    ...(route ? [`Route: ${route}`] : []),
  ];
}

// The tool agreement kept across sessions, for `/router` without a surface. The view holds the store as last read.
export function storeAgreementLine(view) {
  const { agreement, focus } = storeSummary(readStore(view.activityStore));
  const share = ({ matched, total }) => `${matched} of ${total}`;
  if (!agreement.total) return 'Agreement across sessions: no labelled turns yet';
  const all = `${share(agreement)} turns (${percent(agreement.matched / agreement.total)})`;
  const code = focus.total ? ` · code/ops/explore ${share(focus)} (${percent(focus.matched / focus.total)})` : '';
  return `Agreement across sessions: ${all}${code}`;
}

// The classifier's last checked-in activity probe, or null when none was run on the model it is configured with.
export const probeOf = (config, id) => {
  const probe = PROBE_RESULTS[id];
  return probe && probe.model === config.classifiers[id]?.model ? probe : null;
};

// The classifier's last checked-in activity probe, "activity probe 70/70 · p95 299 ms · Oct 10", or null when none
// was run on the model it is configured with.
export function probeText(config, id) {
  const probe = probeOf(config, id);
  if (!probe) return null;
  const day = new Date(`${probe.date}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
  return `activity probe ${probe.correct}/${probe.probes} · p95 ${probe.p95Ms} ms · ${day}`;
}

// Routing vs your model: less is green, more is amber, not red: a stronger model is a purchase, not a fault.
export const SAVINGS_COLOR = { less: '#6fcf97', more: '#f0b429' };

// "$6.40"; signed for a difference or a part: "−$1.84", "+$0.47", "$0.00".
export const usd = (value) => `$${Math.abs(value).toFixed(2)}`;
export const signedUsd = (value) => (value === 0 ? '$0.00' : `${value < 0 ? '−' : '+'}${usd(value)}`);
export const savingsColor = (value) => (value < 0 ? SAVINGS_COLOR.less : value > 0 ? SAVINGS_COLOR.more : undefined);

// The difference against your model: "−22%", "+15%", or "×5.0" once routing cost twice your model or more. Null when
// it rounds to nothing or there is nothing to compare.
export function differenceShare(r) {
  if (r.differenceUsd === 0 || r.share === null) return null;
  if (r.ratio >= 2) return `×${r.ratio.toFixed(1)}`;
  const share = Math.round(r.share * 100);
  return share === 0 ? null : `${share < 0 ? '−' : '+'}${Math.abs(share)}%`;
}

// "−$1.84 (−22%)".
export const savingsAmount = (r) => {
  const share = differenceShare(r);
  return `${signedUsd(r.differenceUsd)}${share ? ` (${share})` : ''}`;
};

export const yourModel = (view) => routeLabel(view.nativeModel, view.nativeEffort);
export const sinceDate = (ms) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const replyCount = (n, what = 'replies') => `${n} ${n === 1 ? what.replace(/ies$/, 'y') : what}`;

// The model most stronger replies ran on, and how many ran on stronger models.
export function strongerReplies(totals) {
  const [model] = Object.entries(totals?.stronger ?? {}).sort((a, b) => b[1] - a[1])[0] ?? [];
  const count = Object.values(totals?.stronger ?? {}).reduce((sum, n) => sum + n, 0);
  return { model: model ?? null, count, several: Object.keys(totals?.stronger ?? {}).length > 1 };
}

// The `/router` line without a surface: this session's difference, or why there is none yet, with the saved totals
// when this session has no routed reply.
export function savingsLine(view) {
  const label = `vs your model (${yourModel(view)})`;
  const session = readout(view.savings ?? emptyTotals());
  const store = readSavingsStore(view.savingsStore);
  const across = readout(store);
  if (!session.replies) {
    const saved = across.early
      ? ''
      : `; ${savingsAmount(across)} since ${sinceDate(store.since)}, each session compared with its own model`;
    return `${label}: no routed replies this session${saved}`;
  }
  if (session.early) return `${label}: too early, ${replyCount(session.replies, 'routed replies')}`;
  const stronger = strongerReplies(view.savings);
  const replies =
    session.differenceUsd > 0 && stronger.count
      ? `${stronger.count} of ${replyCount(session.replies)} on ${stronger.several ? 'stronger models' : modelName(stronger.model)}`
      : replyCount(session.replies);
  return `${label}: ${savingsAmount(session)} this session, ${replies}, est. at list prices`;
}

export const GATEWAY_SETTINGS = 'v0.8 gateway settings remain · see /router';
// Why routing is unavailable, as the band and the pane say it: they show the gateway cleanup themselves.
export const unavailableReason = (view) =>
  view.error === GATEWAY_SETTINGS ? 'v0.8 gateway settings remain' : (view.error ?? 'unknown error');
export const GATEWAY_CLEANUP = [
  'Remove from settings.json, then restart: model jev-router[1m], its modelPicker row,',
  'env.ANTHROPIC_BASE_URL for 127.0.0.1:43170, env.CLAUDE_CODE_GATEWAY_HINT_HEADERS,',
  'and a statusLine that runs the router scripts/statusline.mjs.',
];

export function formatTokens(value) {
  if (!Number.isFinite(value)) return 'unknown';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}K`;
  return String(Math.round(value));
}

export function bar(value, maximum, width = 16) {
  if (!Number.isFinite(value) || !(maximum > 0)) return { text: 'unknown', percent: null, color: 'gray' };
  const fraction = Math.max(0, value / maximum);
  const filled = Math.min(width, Math.round(fraction * width));
  return {
    text: `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`,
    percent: Math.round(fraction * 100),
    color: fraction > 0.8 ? 'red' : fraction > 0.6 ? 'yellow' : 'green',
  };
}

export function usageMetrics(config, view, usage) {
  const model = view.actualModel ?? view.selectedModel ?? view.nativeModel;
  const cell = cellForModel(config, model);
  const spec = cell ? routeSpec(config, resolveRoute(config, cell.tier, cell.activity)) : null;
  const window = spec?.contextWindow ?? null;
  const observed = Number.isFinite(usage?.context?.tokens) ? usage.context.tokens : null;
  const candidates = [view.contextTokens, observed === null ? null : observed + (view.outputTokens ?? 0)].filter(
    (value) => Number.isFinite(value),
  );
  const nextContext = candidates.length ? Math.max(...candidates) : null;
  const reuse = view.inputTokens > 0 && Number.isFinite(view.cacheRead) ? view.cacheRead / view.inputTokens : null;
  const cost = Number.isFinite(usage?.cost?.usd) ? usage.cost.usd : null;
  const rates = spec && ratesAt(spec, view.inputTokens ?? 0);
  const cacheBenefit =
    rates && Number.isFinite(view.cacheRead) ? ((rates.input - rates.cacheRead) * view.cacheRead) / 1e6 : null;
  return {
    window,
    observed,
    nextContext,
    reuse,
    cost,
    cacheBenefit,
    contextBar: bar(nextContext, window),
    cacheBar: {
      ...bar(reuse, 1),
      color: reuse === null ? 'gray' : reuse >= 0.6 ? 'green' : reuse >= 0.2 ? 'yellow' : 'gray',
    },
  };
}

// Scaled from the lowest to the highest reading: a long session's inputs sit close together, and a scale from zero
// draws them all as full blocks. Equal readings draw a flat middle line.
export function sparkline(values) {
  if (!values.length || !values.every(Number.isFinite)) return 'no history yet';
  const symbols = '▁▂▃▄▅▆▇█';
  const minimum = Math.min(...values);
  const span = Math.max(...values) - minimum;
  return values.map((value) => symbols[span > 0 ? Math.round(((value - minimum) / span) * 7) : 3]).join('');
}

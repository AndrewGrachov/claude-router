import { compareRoutes } from './activity.mjs';
import { latencyP95, readMetrics, readStore, storeSummary } from './activity-stats.mjs';
import {
  ACTIVITIES,
  ACTIVITY_MODES,
  activeClassifier,
  DEFAULTS,
  effectiveActivities,
  effectiveRoutes,
  resolveRoute,
  sameCell,
  sameRoute,
  TIERS,
  tuningOf,
} from './config.mjs';
import { effortSharesCache, routeEffort } from './cost.mjs';
import {
  activityReading,
  activityVerb,
  classifierLabel,
  classifierStatus,
  differenceShare,
  formatTokens,
  GATEWAY_CLEANUP,
  GATEWAY_SETTINGS,
  missingCredentials,
  missingText,
  modelColor,
  modelName,
  percent,
  percentPair,
  probeOf,
  routeLabel,
  routeName,
  savingsColor,
  signedUsd,
  sparkline,
  TIER_COLOR,
  unavailableReason,
  usageMetrics,
  usd,
  whyText,
  yourModel,
} from './display.mjs';
import { cellForModel, isSameModel } from './route.mjs';
import { modelSpec, readout } from './savings.mjs';
import {
  modelTotals,
  PASS_LABEL,
  PASS_REASONS,
  PASS_WHY,
  readSubagentStore,
  summarizeSubagents,
} from './subagents.mjs';
import {
  allTime,
  breakdown,
  cellsWhere,
  dayKey,
  INSIGHT_REPLIES,
  insights,
  mostlyOn,
  PERIODS,
  periodRange,
  readUsage,
  summarize,
  trend,
} from './usage.mjs';
import { mergePairs, STRIP_CELLS } from './view.mjs';

// Routes and Policy edit one draft and save together; Classifier saves each pick at once.
const TABS = [
  ['now', '1', 'Now'],
  ['routes', '2', 'Routes'],
  ['policy', '3', 'Policy'],
  ['classifier', '4', 'Classifier'],
  ['usage', '5', 'Usage'],
];
const DRAFT_TABS = ['routes', 'policy'];
const TUNING_CHOICES = {
  timeoutMs: [500, 1000, 1500, 3000, 5000],
  downgradeVotes: [1, 2, 3],
  horizon: [1, 3, 5, 10],
  cashCapUsd: [0.5, 1, 2, 5],
  activityMass: [0.5, 0.6, 0.7, 0.8],
};
const LADDER = [...TIERS].reverse();
// The effort option that sends no effort of its own: the request keeps the one Claude Code sends.
const SESSION_EFFORT = 'session';
const INHERIT = 'inherit';
// The Routes grid's row of the tiers' own routes; every other row is an activity.
const TIER_ROW = 'tier';
// Activity verbs are orange italic, as on the band.
const ACTIVITY_STYLE = { color: '#d7875f', italic: true };

const ACTIVITY_MODE_HINT = {
  off: 'not asked; every turn runs its tier’s model',
  on: 'an activity can change its tier’s model',
};
// What `subagentRouting` does, under the router.json path: it is set in the file, not in the pane.
const SUBAGENT_LINE = {
  off: 'Subagents keep their own model (subagentRouting off).',
  on: 'Subagents: on. Agents that pin no model get one at spawn, kept for every step.',
};
const EFFORT_SHORT = { low: 'low', medium: 'med', high: 'high', xhigh: 'xh', max: 'max', [INHERIT]: 'inh' };

// The route draft the Routes and Policy tabs edit: the saved routes, activity overrides and mode until the person
// changes one.
export function routeDraftOf(config, view) {
  if (view.routeDraft) return view.routeDraft;
  const base = structuredClone({
    routes: config.routes,
    baselineTier: config.baselineTier,
    activities: config.activities,
    activityRouting: config.activityRouting,
  });
  return { ...structuredClone(base), base };
}

const dollars = (value) => (Number.isFinite(value) ? `$${value.toFixed(3)}` : 'not reported');
const difference = (value) => `${value < 0 ? '−' : '+'}$${Math.abs(value).toFixed(3)}`;
// The host and port as the request sees them: user info before an `@` is not the host. An endpoint that does not
// parse, such as one with a placeholder in its host, shows as written up to its path, and is not this machine.
function urlOf(endpoint) {
  try {
    return new URL(endpoint);
  } catch {
    return null;
  }
}
const hostOf = (endpoint) => urlOf(endpoint)?.host ?? endpoint.replace(/^https?:\/\//, '').split('/')[0];
const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '[::1]'];
const isLocal = (endpoint) => LOCAL_HOSTS.includes(urlOf(endpoint)?.hostname);
const windowSize = (tokens) => (tokens >= 1e6 ? `${tokens / 1e6}M` : `${Math.round(tokens / 1e3)}K`);
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const contextSuffix = (metrics) =>
  Number.isFinite(metrics.nextContext)
    ? `~${formatTokens(metrics.nextContext)} / ${formatTokens(metrics.window)}`
    : 'no reading yet';

function kit({ Box, Text, Button, Select }) {
  const text = (children, style = {}) => Text({ ...style, children });
  return {
    Box,
    Button,
    Select,
    text,
    dim: (children) => text(children, { dimColor: true }),
    head: (children) => text(children, { bold: true, color: 'cyan' }),
    tier: (tier, children = tier) => text(children, { bold: true, color: TIER_COLOR[tier] }),
    activity: (activity) => text(activityVerb(activity), ACTIVITY_STYLE),
    // One row of mixed parts; strings become plain Text, nulls are dropped.
    line: (...parts) =>
      Box({
        children: parts
          .filter((part) => part !== null && part !== '')
          .map((p) => (typeof p === 'string' ? text(p) : p)),
      }),
    // A fixed-width column, so controls of different widths still line up; it never shrinks in a narrow pane.
    cell: (width, part) => Box({ width, flexShrink: 0, children: [typeof part === 'string' ? text(part) : part] }),
    gauge: (name, value, suffix) =>
      text(`${name}${value.text}${value.percent === null ? '' : ` ${String(value.percent).padStart(3)}%`}  ${suffix}`, {
        color: value.color,
      }),
  };
}

export function renderPanel(
  elements,
  config,
  view,
  usage,
  actions,
  { modelOptions = Object.keys(config.models), columns = null, now = Date.now() } = {},
) {
  const ui = kit(elements);
  const tab = TABS.some(([id]) => id === view.tab) ? view.tab : 'now';
  const body = { now: nowTab, routes: routesTab, policy: policyTab, classifier: classifierTab, usage: usageTab }[tab];
  return ui.Box({
    flexDirection: 'column',
    children: [
      ...header(ui, config, view, tab, actions),
      ...body(ui, config, view, usage, actions, modelOptions, columns, now),
      ...(view.help ? helpLines(ui) : []),
      ...statusBar(ui, config, view, tab, actions),
      ui.Button({ key: 'close', label: 'Close', hotkey: 'q', role: 'dismiss', onPress: actions.close }),
    ],
  });
}

// Routing's state, its one mode control and the classifier's state on one line. While routing is unavailable, on and
// off would change nothing, so the line says why instead of offering them.
function routingState(ui, config, view, actions) {
  if (view.phase === 'unavailable')
    return [
      ui.line(
        ui.head('ROUTING'),
        '  ',
        ui.text('unavailable', { color: 'yellow' }),
        ui.dim('  Claude’s model is kept'),
      ),
      ui.text(unavailableReason(view), { color: 'yellow' }),
      ...(view.error === GATEWAY_SETTINGS ? GATEWAY_CLEANUP.map((line) => ui.text(line, { color: 'yellow' })) : []),
    ];
  const label = classifierLabel(config);
  const error = view.error ?? missingCredentials(config, view, config.classifier);
  // A radio pair, marked as the Classifier tab marks its active row.
  const option = (mode, label, hotkey) =>
    ui.Button({
      key: mode,
      label: `${view.mode === mode ? '◉' : '○'} ${label}`,
      hotkey,
      variant: view.mode === mode ? 'primary' : 'secondary',
      onPress: () => actions.mode(mode),
    });
  return [
    ui.line(
      ui.head('ROUTING'),
      '  ',
      option('auto', 'on', 'o'),
      ' ',
      option('manual', 'off', 'f'),
      '  ',
      error
        ? ui.text(classifierStatus(config, error), { color: 'yellow' })
        : ui.text(`${label} ready${Number.isFinite(view.adviceMs) ? ` · ${view.adviceMs} ms` : ''}`, {
            color: 'green',
          }),
    ),
  ];
}

function header(ui, config, view, tab, actions) {
  const changes = routingChanges(config, view);
  const unsaved = {
    routes: changes.tiers.length + changes.cells.length + Number(changes.mode) > 0,
    policy: changes.policy.length + Number(changes.baseline) > 0,
  };
  return [
    ...routingState(ui, config, view, actions),
    ui.line(
      ...TABS.flatMap(([id, hotkey, label]) => [
        ui.Button({
          key: `tab-${id}`,
          label: unsaved[id] ? `${label} ●` : label,
          hotkey,
          variant: tab === id ? 'primary' : 'secondary',
          onPress: () => actions.tab(id),
        }),
        ' ',
      ]),
      ui.Button({ key: 'help', label: '?', variant: view.help ? 'primary' : 'secondary', onPress: actions.help }),
    ),
    ui.text(' '),
  ];
}

// "Jev gave stronger tiers 88% (needs 82%) · switch ≈ $0.48": the support for the switch the policy weighed against
// the bar it set, and the switch cost. Null without a reading.
function supportText(label, estimate) {
  if (!Number.isFinite(estimate?.threshold)) return null;
  const [direction, mass] = Number.isFinite(estimate.upgradeMass)
    ? ['stronger', estimate.upgradeMass]
    : ['cheaper', estimate.downgradeMass];
  const [needs, gave] = percentPair(estimate.threshold, Number.isFinite(mass) ? mass : estimate.threshold);
  const cost = Number.isFinite(estimate.taxUsd) ? ` · switch ≈ ${usd(estimate.taxUsd)}` : '';
  return `${label} gave ${direction} tiers ${Number.isFinite(mass) ? gave : '—'} (needs ${needs})${cost}`;
}

// What runs next turn and why first, with the one-turn pins; then this session and today as headlines, the finding
// worth a look, and Claude's context and cost readings.
function nowTab(ui, config, view, usage, actions, _modelOptions, columns, now) {
  const metrics = usageMetrics(config, view, usage);
  const unavailable = view.phase === 'unavailable';
  const auto = view.mode === 'auto' && !unavailable;
  const current = view.selectedModel ?? view.nativeModel;
  const label = classifierLabel(config);
  const missing = unavailable ? null : missingCredentials(config, view, config.classifier);
  const served = view.actualModel && current && !isSameModel(current, view.actualModel);
  const mode = config.activityRouting;
  const reading = mode === 'off' ? null : activityReading(view);
  // In `on` an override names the tier's own model.
  const base = view.tier ? resolveRoute(config, view.tier) : null;
  const override =
    mode === 'on' && view.activity && base && !sameRoute(resolveRoute(config, view.tier, view.activity), base);
  const support = auto ? supportText(label, view.estimate) : null;
  const out = [
    ui.line(
      'Next turn  ',
      view.tier ? ui.tier(view.tier, `▌${view.tier}  `) : null,
      ui.text(routeLabel(current, view.effort), { bold: true }),
      auto ? null : ui.dim(unavailable ? '  Claude’s model' : '  your /model choice, routing off'),
      override ? ui.dim(`   override · ${view.tier} runs ${routeName(config, base)}`) : null,
    ),
    reading
      ? ui.line(
          'Activity   ',
          // `uncertain` is an answer, not an activity: it applies none.
          ACTIVITIES.includes(reading.choice) ? ui.activity(reading.choice) : ui.dim(reading.choice),
          reading.share ? ` ${reading.share}` : '',
          reading.others.length ? ui.dim(`   ${reading.others.map(verbShare).join(' · ')}`) : null,
          ui.dim(`   applies at ${percent(config.policy.activityMass)}+`),
        )
      : null,
    ui.line('Why        ', whyText(config, view)),
    support ? ui.dim(`           ${support}`) : null,
    served
      ? ui.line(ui.text('Served     ', { color: 'yellow' }), `${modelName(view.actualModel)} · native fallback`)
      : null,
    view.pendingPin
      ? ui.line(
          ui.text('Pinned     ', { color: 'yellow' }),
          'next turn → ',
          ui.tier(view.pendingPin),
          '  ',
          ui.Button({ key: 'unpin', label: 'unpin', onPress: actions.unpin }),
        )
      : null,
    missing
      ? ui.line(
          ui.text(`${classifierStatus(config, missing)}, keeping the model  `, { color: 'yellow' }),
          ui.Button({ key: 'key', label: 'Set up', hotkey: 'k', onPress: actions.key }),
        )
      : null,
    pinLine(ui, view, auto, unavailable, actions, columns),
  ];
  const session = summarize(readUsage(view.usageSession), periodRange('session', now));
  const today = summarize(readUsage(view.usageStore), periodRange('today', now));
  out.push(ui.text(' '), ...sessionLines(ui, view, session, actions, columns, now));
  // Today repeats this session's part of it until another session adds to it.
  const ownToday = summarize(readUsage(view.usageSession), periodRange('today', now));
  if (today.replies > ownToday.replies) out.push(ui.text(' '), ...todayLines(ui, today, actions, columns));
  out.push(
    ...sessionAgentLines(ui, view, actions, columns),
    ...worthLines(ui, today, actions, columns),
    ui.text(' '),
    ui.gauge('Context  ', metrics.contextBar, contextSuffix(metrics)),
    ui.line(
      ui.text('Cache    ', { color: metrics.cacheBar.color }),
      metrics.cacheBar.percent === null
        ? ui.dim('no reply yet')
        : ui.text(`${metrics.cacheBar.percent}% reused on the last reply`, { color: metrics.cacheBar.color }),
      ui.dim('  ·  '),
      `cost ${dollars(metrics.cost)} `,
      ui.dim('by Claude  '),
      detailButton(ui, view, actions),
    ),
    ...(view.usageDetail ? readingDetail(ui, view, metrics) : []),
  );
  return out;
}

const detailButton = (ui, view, actions) =>
  ui.Button({
    key: 'usage-detail',
    label: view.usageDetail ? 'less' : 'details',
    variant: view.usageDetail ? 'primary' : 'secondary',
    onPress: actions.usageDetail,
  });

// Behind `details` on the Now tab: Claude's readings of the last reply, the input per reply, and the estimates the
// last decision weighed.
function readingDetail(ui, view, metrics) {
  const history = view.history ?? [];
  const tiers = view.tiers ?? [];
  const glyphs = sparkline(history);
  const trend = history.length
    ? ui.line(
        '  ',
        ...[...glyphs].map((glyph, i) => {
          const tier = tiers[tiers.length - history.length + i];
          return tier ? ui.tier(tier, glyph) : ui.text(glyph);
        }),
        ui.dim(`  ${formatTokens(Math.min(...history))} … ${formatTokens(Math.max(...history))}`),
      )
    : ui.dim('  no replies yet');
  return [
    ui.dim(`  context observed ${formatTokens(metrics.observed)} · estimated ${formatTokens(view.contextTokens)}`),
    ui.dim(`  cache read ${formatTokens(view.cacheRead)} · written ${formatTokens(view.cacheWrite)} tokens`),
    ui.dim(`  output ${formatTokens(view.outputTokens)} tokens on the last reply`),
    ui.text(' '),
    ui.head(`INPUT PER REPLY · last ${plural(history.length, 'reply', 'replies')} · lowest to highest`),
    trend,
    ui.text(' '),
    ui.head('ESTIMATES · configured list prices'),
    ui.text(`Cache hits saved      ${dollars(metrics.cacheBenefit)}`),
    Number.isFinite(view.estimate?.taxUsd) ? ui.text(`Switch cost           ${dollars(view.estimate.taxUsd)}`) : null,
    ...(view.comparison
      ? [
          ui.text(`Compared tiers        ${view.comparison.incumbent} → ${view.comparison.candidate}`),
          ui.text(
            `Next-turn difference  ${difference(view.comparison.minUsd)} to ${difference(view.comparison.maxUsd)}`,
          ),
          ui.text(
            `Payback               ${view.comparison.paybackTurns === null ? 'none projected' : `${view.comparison.paybackTurns} later turns`}`,
          ),
        ]
      : []),
  ];
}

const verbShare = (text) => text.replace(/^(\S+)/, (name) => activityVerb(name));

// One button per tier with the classifier's support on the last turn, the current tier marked; a press pins the next
// turn only. Without routing there is nothing to pin.
function pinLine(ui, view, auto, unavailable, actions, columns) {
  if (!auto)
    return ui.line(
      'Pin next   ',
      ui.dim(unavailable ? 'needs routing, which is unavailable' : 'needs routing on (o above)'),
    );
  return ui.line(
    'Pin next   ',
    ...LADDER.flatMap((tier) => {
      const support = view.probabilities?.[tier];
      return [
        ui.Button({
          key: `pin-${tier}`,
          label: `${view.tier === tier ? '▶ ' : ''}${tier} ${Number.isFinite(support) ? percent(support) : '—'}`,
          variant: view.pendingPin === tier ? 'primary' : 'secondary',
          onPress: () => actions.pin(tier),
        }),
        ' ',
      ];
    }),
    !Number.isFinite(columns) || columns >= PIN_HINT_COLUMNS ? ui.dim(' next turn only') : null,
  );
}
const PIN_HINT_COLUMNS = 80;

// "13:41", or "Oct 12 13:41" for another day than `now`'s.
const clockText = (ms) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const sinceText = (ms, now) =>
  dayKey(ms) === dayKey(now) ? clockText(ms) : `${dayLabel(dayKey(ms))} ${clockText(ms)}`;

// The strip cell's tier: the one with most replies, the stronger on a tie; `none` where routing served none.
const STRIP_ORDER = [...LADDER, 'none'];
const cellTier = (cell) => STRIP_ORDER.reduce((top, key) => ((cell[key] ?? 0) > (cell[top] ?? 0) ? key : top));

// The session strip fitted to the pane beside its note: pairs of cells merge until both fit. The note says how many
// replies a cell holds, and since when the strip runs when Claude Code restarted after the session's first reply.
function fittedStrip(strip, columns, since, now) {
  let { per, cells } = strip;
  const restarted = Number.isFinite(strip.from) && Number.isFinite(since) && strip.from > since;
  const note = () =>
    [per > 1 ? `${per} replies per cell` : null, restarted ? `since ${sinceText(strip.from, now)}` : null]
      .filter(Boolean)
      .join(' · ');
  const room = () => (Number.isFinite(columns) ? Math.max(8, columns - 4 - note().length) : STRIP_CELLS);
  while (cells.length > room()) {
    cells = mergePairs(cells);
    per *= 2;
  }
  return { cells, note: note() };
}

// This session: since its first routed reply, its routed replies and route switches; its replies as a strip colored
// by tier, with the replies per tier, and the routed replies per activity; the last switch; and routing against your
// model, linked to Usage.
function sessionLines(ui, view, summary, actions, columns, now) {
  const since = readUsage(view.usageSession).since;
  const strip = view.strip?.cells?.length ? fittedStrip(view.strip, columns, since, now) : null;
  const counts = {};
  for (const cell of view.strip?.cells ?? [])
    for (const [key, n] of Object.entries(cell)) counts[key] = (counts[key] ?? 0) + n;
  const replies = Object.values(counts).reduce((sum, n) => sum + n, 0);
  const switches = summary.switches.tier + summary.switches.activity;
  const head = [
    Number.isFinite(since) ? `since ${sinceText(since, now)}` : null,
    summary.replies
      ? plural(summary.replies, 'routed reply', 'routed replies')
      : replies
        ? plural(replies, 'reply', 'replies')
        : null,
    summary.turns ? plural(switches, 'route switch', 'route switches') : null,
  ].filter(Boolean);
  if (!strip && !summary.replies) return [ui.line(ui.head('SESSION'), ui.dim(' · no replies yet'))];
  const out = [ui.line(ui.head('SESSION'), head.length ? ui.dim(` · ${head.join(' · ')}`) : null)];
  if (strip) {
    out.push(
      ui.line(
        '  ',
        ...strip.cells.map((cell) => {
          const tier = cellTier(cell);
          return tier === 'none' ? ui.dim('·') : ui.tier(tier, '█');
        }),
        strip.note ? ui.dim(`  ${strip.note}`) : null,
      ),
      ui.line(
        '  ',
        ...TIERS.filter((tier) => counts[tier]).flatMap((tier) => [ui.tier(tier, '■ '), `${tier} ${counts[tier]}  `]),
        counts.none ? ui.dim(`· not routed ${counts.none}`) : null,
      ),
    );
  }
  const used = breakdown(summary.cells, 'activity')
    .filter((group) => ACTIVITIES.includes(group.name))
    .sort((a, b) => b.sums[0] - a.sums[0])
    .map((group) => [group.name, `${activityVerb(group.name)} ${group.sums[0]}`]);
  // The most used first, as many as fit the pane; the rest as a count.
  const shown = [];
  for (const [i, entry] of used.entries()) {
    const rest = used.length - i - 1;
    const width =
      2 + [...shown, entry].map(([, text]) => text).join(' · ').length + (rest ? ` · +${rest} more`.length : 0);
    if (Number.isFinite(columns) && width > columns && shown.length) break;
    shown.push(entry);
  }
  if (shown.length)
    out.push(
      ui.line(
        '  ',
        ...shown.flatMap(([name, text], i) => [
          ui.activity(name),
          ui.dim(`${text.slice(activityVerb(name).length)}${i < shown.length - 1 ? ' · ' : ''}`),
        ]),
        shown.length < used.length ? ui.dim(` · +${used.length - shown.length} more`) : null,
      ),
    );
  const last = view.lastSwitch;
  if (Number.isFinite(last?.at) && last.from && last.to) out.push(lastSwitchLine(ui, last, now));
  if (summary.replies)
    out.push(verdictLine(ui, readout(summary), () => actions.usageFor('session'), 'session', columns));
  return out;
}

// "last switch 13:41  medium → high · debugging"; routes by name when the switch kept the tier.
function lastSwitchLine(ui, last, now) {
  const byTier = TIERS.includes(last.from.tier) && TIERS.includes(last.to.tier) && last.from.tier !== last.to.tier;
  return ui.line(
    '  ',
    ui.dim(`last switch ${sinceText(last.at, now)}  `),
    ...(byTier
      ? [ui.tier(last.from.tier), ui.dim(' → '), ui.tier(last.to.tier)]
      : [routeLabel(last.from.model, last.from.effort), ui.dim(' → '), routeLabel(last.to.model, last.to.effort)]),
    ...(ACTIVITIES.includes(last.activity) ? [ui.dim(' · '), ui.activity(last.activity)] : []),
  );
}

// Routing against your model, with the Usage tab on the same period one press away. The switch writes in it and an
// early sample follow where the pane has room, the early sample dropping first.
function verdictLine(ui, r, open, period, columns) {
  const notes = [
    r.switchUsd > 0 ? ` · switch writes ${usd(r.switchUsd)}` : null,
    r.early ? ' · early sample' : null,
  ].filter(Boolean);
  const width = () => 2 + verdictText(r).join('').length + notes.join('').length + USAGE_LINK;
  while (notes.length && Number.isFinite(columns) && width() > columns) notes.pop();
  return ui.line(
    '  ',
    ...verdictParts(ui, r),
    ...notes.map((note) => ui.dim(note)),
    '  ',
    ui.Button({ key: `usage-${period}`, label: 'Usage', onPress: open }),
  );
}
// "  [ Usage ]" after the verdict.
const USAGE_LINK = 11;

// Today across sessions, shown once another session added to it.
function todayLines(ui, summary, actions, columns) {
  const switches = summary.switches.tier + summary.switches.activity;
  return [
    ui.line(
      ui.head('TODAY'),
      ui.dim(
        ` · ${plural(summary.replies, 'routed reply', 'routed replies')} · ${plural(switches, 'route switch', 'route switches')}`,
      ),
    ),
    verdictLine(ui, readout(summary), () => actions.usageFor('today'), 'today', columns),
  ];
}

// Today's first finding from Usage's WORTH A LOOK, with the tab that changes it; nothing when there is none.
function worthLines(ui, summary, actions, columns) {
  const [first] = summary.replies >= INSIGHT_REPLIES ? insights(summary) : [];
  if (!first) return [];
  return [ui.text(' '), ui.line(ui.head('WORTH A LOOK'), ui.dim(' · today')), insightLine(ui, first, actions, columns)];
}

// Rows: [key, label, format, router.json field]. Typed as tuples so tsc keeps each position's type.
/** @type {[string, string, (value: number) => string, string][]} */
const POLICY_ROWS = [
  ['downgradeVotes', 'Votes to go down', String, 'policy.downgradeVotes'],
  ['horizon', 'Payback horizon', (v) => plural(v, 'turn'), 'policy.downgradeHorizonTurns'],
  ['cashCapUsd', 'Credits cap', (v) => `$${v.toFixed(2)}`, 'policy.cashCapUsd'],
  ['activityMass', 'Activity threshold', percent, 'policy.activityMass'],
];
const POLICY_FORMAT = Object.fromEntries(POLICY_ROWS.map(([key, , format]) => [key, format]));

// What Routes and Policy changed and have not saved: tiers, baseline, activity cells and mode against the saved config,
// policy values against the values the draft started from. `cells` lists [activity, tier] pairs.
export function routingChanges(config, view) {
  const raw = routeDraftOf(config, view);
  const draft = { ...effectiveRoutes(raw, config), ...effectiveActivities(raw, config) };
  const saved = tuningOf(config);
  const base = view.tuningBase ?? saved;
  const tuning = { ...saved, ...view.tuning };
  const tiers = TIERS.filter((tier) => !sameRoute(draft.routes[tier], config.routes[tier]));
  const baseline = draft.baselineTier !== config.baselineTier;
  const cells = ACTIVITIES.flatMap((activity) =>
    TIERS.filter((tier) => !sameCell(draft.activities[activity]?.[tier], config.activities[activity]?.[tier])).map(
      (tier) => [activity, tier],
    ),
  );
  const mode = draft.activityRouting !== config.activityRouting;
  const policy = POLICY_ROWS.map(([key]) => key).filter(
    (key) => Object.hasOwn(view.tuning ?? {}, key) && view.tuning[key] !== base[key],
  );
  const count = tiers.length + Number(baseline) + cells.length + Number(mode) + policy.length;
  return { draft, saved, tuning, tiers, baseline, cells, mode, policy, count };
}

const marker = (ui, changed) => ui.cell(2, changed ? ui.text('●', { color: 'yellow' }) : '');

// "sonnet·high": the route's models key and its effort, short enough for the grid; `inherit` for a route that leaves
// the effort to the session, and no effort for a model without efforts. The key, not the model name: two Haiku versions
// in router.json still read apart.
function shortRoute(config, route, narrow) {
  if (!config.models[route.model].efforts.length) return route.model;
  const effort = route.effort ?? INHERIT;
  return `${route.model}·${narrow ? (EFFORT_SHORT[effort] ?? effort) : effort}`;
}
const routeKey = (route) => `${route.model}@${route.effort ?? ''}`;
const builtIn = (activity, tier) => DEFAULTS.activities[activity]?.[tier] ?? null;
const sharesEffort = (config, route) => effortSharesCache(config, config.models[route.model]?.id);
// The cache a route runs on: one per model on a model that keeps one cache across efforts, else one per route.
const cacheOf = (config, route) => (sharesEffort(config, route) ? route.model : routeKey(route));

// Why an override may be a mistake: no effect, a route above the next tier's, or a cache no other cell runs on.
function overrideWarnings(config, uses, activity, tier) {
  const route = resolveRoute(config, tier, activity);
  if (sameRoute(route, config.routes[tier])) return [];
  const above = config.routes[TIERS[TIERS.indexOf(tier) + 1]];
  return [
    above && compareRoutes(config, route, above) > 0 ? 'stronger than the tier above' : null,
    uses.get(cacheOf(config, route)) === 1
      ? `${sharesEffort(config, route) ? 'a model' : 'a model + effort'} only this cell uses: one more cache`
      : null,
  ].filter(Boolean);
}

// A model Select and an effort Select for one route; `session` is offered as `inherit`.
function routeSelects(ui, config, key, route, modelOptions, onModel, onEffort) {
  const model = config.models[route.model];
  const aliases = modelOptions.includes(route.model) ? modelOptions : [route.model, ...modelOptions];
  return [
    ui.cell(
      14,
      ui.Select
        ? ui.Select({
            key: `${key}-model`,
            value: route.model,
            options: aliases.map((alias) => ({ value: alias, label: modelName(config.models[alias].id) })),
            onSelect: onModel,
          })
        : modelName(model.id),
    ),
    ui.cell(
      12,
      !model.efforts.length
        ? ui.dim('none')
        : ui.Select
          ? ui.Select({
              key: `${key}-effort`,
              value: route.effort ?? SESSION_EFFORT,
              options: [
                { value: SESSION_EFFORT, label: INHERIT },
                ...model.efforts.map((effort) => ({ value: effort, label: effort })),
              ],
              onSelect: (effort) => onEffort(effort === SESSION_EFFORT ? null : effort),
            })
          : (route.effort ?? INHERIT),
    ),
  ];
}

// Routes per cache: the tiers' routes, and the overrides when `overrides` is set. The count shows the overrides once
// activity routing is on; the one-more-cache warning always counts them, so it reads the same in every mode. `shared`
// says, per counted route, whether its model keeps one cache across efforts.
function cacheUses(draft, overrides) {
  const uses = new Map();
  const shared = [];
  const count = (route) => {
    shared.push(sharesEffort(draft, route));
    uses.set(cacheOf(draft, route), (uses.get(cacheOf(draft, route)) ?? 0) + 1);
  };
  for (const tier of TIERS) count(draft.routes[tier]);
  if (overrides)
    for (const activity of ACTIVITIES)
      for (const tier of TIERS) {
        const route = resolveRoute(draft, tier, activity);
        if (!sameRoute(route, draft.routes[tier])) count(route);
      }
  return { uses, shared };
}

// The Routes tab: one grid of tier (columns) by activity (rows), the tiers' own routes on top. A cell press opens its
// editor under the grid. Nothing is written until Save; the cache count reads the whole draft.
function routesTab(ui, config, view, _usage, actions, modelOptions, columns) {
  const changes = routingChanges(config, view);
  const draft = { ...config, ...changes.draft };
  const mode = draft.activityRouting;
  const narrow = Number.isFinite(columns) && columns < 80;
  const width = narrow ? 14 : 16;
  const { uses, shared } = cacheUses(draft, mode === 'on');
  const selected = view.routeCell ?? null;
  const cellButton = (row, tier, text, dim) =>
    ui.cell(
      width,
      ui.Button({
        key: `cell-${row}-${tier}`,
        label: `${selected === `${row}.${tier}` ? '▸' : ' '}${text}`,
        plain: true,
        ...(dim ? { dimColor: true } : {}),
        onPress: () => actions.selectCell(`${row}.${tier}`),
      }),
    );
  const gridRow = (name, cells) => ui.line(ui.cell(13, name), ...cells);
  const out = [
    ui.line(ui.head('ROUTES'), ui.dim(' · which model runs, by tier and activity · edit, then Save')),
    ui.line(
      ui.cell(
        26,
        ui.Select
          ? ui.Select({
              key: 'activity-mode',
              label: 'Activity routing',
              value: mode,
              options: ACTIVITY_MODES.map((m) => ({ value: m, label: m })),
              onSelect: (m) => actions.activityMode(m),
            })
          : `Activity routing: ${mode}`,
      ),
      marker(ui, changes.mode),
      ui.dim(ACTIVITY_MODE_HINT[mode]),
    ),
    ...overridesState(ui, view, config.activityRouting, mode),
    ui.text(' '),
    ui.line(ui.cell(13, ''), ...TIERS.map((tier) => ui.cell(width, ui.tier(tier, ` ${tier}`)))),
    gridRow(
      ui.text('every turn', { bold: true }),
      TIERS.map((tier) =>
        cellButton(
          TIER_ROW,
          tier,
          `${shortRoute(draft, draft.routes[tier], narrow)}${changes.tiers.includes(tier) ? '●' : ''}`,
          false,
        ),
      ),
    ),
  ];
  for (const activity of ACTIVITIES)
    out.push(
      gridRow(
        ui.activity(activity),
        TIERS.map((tier) => {
          const route = resolveRoute(draft, tier, activity);
          const edited = changes.cells.some(([a, t]) => a === activity && t === tier) ? '●' : '';
          if (sameRoute(route, draft.routes[tier])) return cellButton(activity, tier, `·${edited}`, true);
          const preset = builtIn(activity, tier);
          const mark = preset && sameRoute(route, { model: preset.model, effort: preset.effort ?? null }) ? '°' : '';
          return cellButton(activity, tier, `${shortRoute(draft, route, narrow)}${mark}${edited}`, mode !== 'on');
        }),
      ),
    );
  out.push(
    ui.dim('  · runs the tier’s model   ° built-in default   ● unsaved'),
    ui.text(' '),
    ...cellEditor(ui, draft, changes, selected, cacheUses(draft, true).uses, actions, modelOptions),
    ui.text(' '),
    ...cacheLines(ui, uses.size, shared, mode, columns),
    ...LADDER.slice(0, -1)
      .filter((upper, i) => sameRoute(draft.routes[upper], draft.routes[LADDER[i + 1]]))
      .map((upper) =>
        ui.text(
          `! ${LADDER[LADDER.indexOf(upper) + 1]} and ${upper} run the same model and effort: that step changes nothing`,
          { color: 'yellow' },
        ),
      ),
    ui.Button({ key: 'reset-routes', label: 'Reset routes to defaults', hotkey: 'r', onPress: actions.resetRoutes }),
    ui.dim('A new model ID needs router.json → models: price, window, efforts.'),
  );
  return out;
}

// Why the cache count matters, in one or two lines: a model keeps one cache across efforts (the 5.5 models on an API key
// or a subscription) or one per effort (other providers).
function cacheLines(ui, n, shared, mode, columns) {
  const scope = mode === 'on' ? '' : ' (tiers only: activity routing is not on)';
  const per = shared.every(Boolean)
    ? 'one per model; effort changes keep it'
    : shared.some(Boolean)
      ? 'one per model, or per model + effort where efforts cache apart'
      : 'one per model + effort';
  return dimLines(
    ui,
    `${plural(n, 'prompt cache')} in use${scope}: ${per}. A switch to a cold cache writes the whole context again, the switch cost on Now.`,
    Math.min(columns ?? 78, 78),
  );
}

// The editor of the selected grid cell: a tier's own route, or an activity's cell with what it runs, its built-in
// default, and the two ways back.
function cellEditor(ui, draft, changes, selected, uses, actions, modelOptions) {
  const [row, tier] = selected?.split('.') ?? [];
  if (!TIERS.includes(tier) || (row !== TIER_ROW && !ACTIVITIES.includes(row)))
    return [ui.dim('Select a cell to change its model and effort.')];
  if (row === TIER_ROW) {
    const route = draft.routes[tier];
    const model = draft.models[route.model];
    return [
      ui.line(
        ui.cell(22, ui.line(ui.tier(tier), ui.dim(' · every turn'))),
        ...routeSelects(
          ui,
          draft,
          `route-${tier}`,
          route,
          modelOptions,
          (alias) => actions.routeModel(tier, alias),
          (effort) => actions.routeEffort(tier, effort),
        ),
        marker(ui, changes.tiers.includes(tier)),
      ),
      ui.dim(
        `${''.padEnd(22)}$${model.input} in · $${model.output ?? '?'} out per M tokens · ${windowSize(model.contextWindow)} window`,
      ),
    ];
  }
  const activity = row;
  const route = resolveRoute(draft, tier, activity);
  const base = draft.routes[tier];
  const preset = builtIn(activity, tier);
  const presetRoute = preset ? { model: preset.model, effort: preset.effort ?? null } : null;
  const edited = changes.cells.some(([a, t]) => a === activity && t === tier);
  const own = !sameRoute(route, base);
  // A saved cell that resolves to the tier's route and is no built-in one changes nothing; 1.6 wrote such cells.
  const noEffect = !own && !presetRoute && Boolean(draft.activities[activity]?.[tier]);
  const drop = own || noEffect;
  const state = !own
    ? presetRoute && !sameRoute(route, presetRoute)
      ? 'runs the tier’s model; the built-in default is removed'
      : noEffect
        ? 'same as the tier’s model: no effect'
        : 'runs the tier’s model'
    : presetRoute && sameRoute(route, presetRoute)
      ? 'built-in default'
      : 'your override';
  const warnings = overrideWarnings(draft, uses, activity, tier);
  const back = Boolean(presetRoute) && !sameRoute(route, presetRoute);
  return [
    ui.line(
      ui.cell(22, ui.line(ui.activity(activity), ' at ', ui.tier(tier))),
      ...routeSelects(
        ui,
        draft,
        `activity-${activity}-${tier}`,
        route,
        modelOptions,
        (alias) => actions.activityModel(activity, tier, alias),
        (effort) => actions.activityEffort(activity, tier, effort),
      ),
      marker(ui, edited),
    ),
    ui.line(ui.cell(22, ''), ui.dim(state)),
    ...(drop || back
      ? [
          ui.line(
            ui.cell(22, ''),
            drop
              ? ui.Button({
                  key: `activity-tier-${activity}-${tier}`,
                  label: `Use tier model: ${routeName(draft, base)}`,
                  onPress: () => actions.removeActivity(activity, tier),
                })
              : null,
            drop && back ? ' ' : null,
            back
              ? ui.Button({
                  key: `activity-default-${activity}-${tier}`,
                  label: `Restore default: ${routeName(draft, presetRoute)}`,
                  onPress: () => actions.restoreActivity(activity, tier),
                })
              : null,
          ),
        ]
      : []),
    ...warnings.map((warning) => ui.text(`${''.padEnd(22)}! ${warning}`, { color: 'yellow' })),
  ];
}

// Whether the overrides run now: the saved mode decides, since a draft runs nothing until Save. A different draft mode
// says what Save will change. Nothing while they run.
function overridesState(ui, view, saved, drafted) {
  const why = (mode) =>
    view.phase === 'unavailable'
      ? 'routing is unavailable'
      : view.mode === 'manual'
        ? 'routing is off'
        : mode === 'on'
          ? null
          : `activity routing is ${mode}`;
  const now = why(saved);
  const after = drafted === saved || Boolean(why(drafted)) === Boolean(now) ? null : why(drafted) ? 'not' : 'in';
  if (!now && !after) return [];
  return [
    ui.line(
      now ? ui.text(`Activity overrides not in use: ${now}`, { color: 'yellow' }) : ui.dim('Activity overrides in use'),
      after ? ui.dim(` · ${after === 'not' ? 'not in use' : 'in use'} after Save`) : null,
    ),
  ];
}

// A Select over TUNING_CHOICES[key], with a saved value outside them kept as the first option.
function choice(ui, key, value, format, pick) {
  if (!ui.Select) return format(value);
  const values = TUNING_CHOICES[key].includes(value) ? TUNING_CHOICES[key] : [value, ...TUNING_CHOICES[key]];
  return ui.Select({
    key,
    value: String(value),
    options: values.map((v) => ({ value: String(v), label: format(v) })),
    onSelect: (picked) => (TUNING_CHOICES[key].includes(Number(picked)) ? pick(Number(picked)) : undefined),
  });
}

// The Policy tab: each control inside the sentence it completes, its default named when the value differs. One Save
// writes it with the Routes draft.
function policyTab(ui, config, view, _usage, actions) {
  const changes = routingChanges(config, view);
  const { draft, tuning, policy } = changes;
  const defaults = tuningOf(DEFAULTS);
  const label = classifierLabel(config);
  const pad = ''.padEnd(13);
  const tune = (key) => choice(ui, key, tuning[key], POLICY_FORMAT[key], (value) => actions.tune(key, value));
  const note = (key) => [
    marker(ui, policy.includes(key)),
    tuning[key] === defaults[key] ? null : ui.dim(`default ${POLICY_FORMAT[key](defaults[key])}`),
  ];
  const { upgradeBase, upgradeSlope } = config.policy;
  const credits = Object.values(config.models).some((model) => model.billing === 'credits');
  return [
    ui.line(ui.head('POLICY'), ui.dim(' · how readily the router changes models · edit, then Save')),
    ui.text(' '),
    ui.line(
      ui.cell(13, ui.text('Start', { bold: true })),
      'at ',
      ui.Select
        ? ui.Select({
            key: 'baseline',
            value: draft.baselineTier,
            options: TIERS.map((tier) => ({ value: tier, label: tier })),
            onSelect: (tier) => actions.baseline(tier),
          })
        : draft.baselineTier,
      ' ',
      marker(ui, changes.baseline),
      draft.baselineTier === DEFAULTS.baselineTier ? null : ui.dim(`default ${DEFAULTS.baselineTier}`),
    ),
    ui.dim(`${pad}when the session’s model is no tier’s model`),
    ui.line(
      ui.cell(13, ui.text('Going down', { bold: true })),
      'after ',
      tune('downgradeVotes'),
      ' agreeing turns ',
      ...note('downgradeVotes'),
    ),
    ui.line(pad, 'if a cache write pays back within ', tune('horizon'), ' ', ...note('horizon')),
    ui.line(
      ui.cell(13, ui.text('Going up', { bold: true })),
      ui.dim(
        `needs ${label} support of ${percent(upgradeBase)}, up to ${percent(upgradeBase + upgradeSlope)} as the switch costs more`,
      ),
    ),
    ui.line(
      ui.cell(13, ui.text('Activities', { bold: true })),
      'apply at ',
      tune('activityMass'),
      ' certainty or more ',
      ...note('activityMass'),
    ),
    ui.dim(`${pad}else a new task runs its tier’s model; a continuation keeps it`),
    ui.line(
      ui.cell(13, ui.text('Credits', { bold: true })),
      'cap one cold cache write at ',
      tune('cashCapUsd'),
      ' ',
      ...note('cashCapUsd'),
    ),
    ui.dim(
      credits
        ? `${pad}on a model that bills credits`
        : `${pad}no model in router.json bills credits, so this has no effect`,
    ),
    ui.text(' '),
    ui.Button({ key: 'reset-policy', label: 'Reset policy to defaults', onPress: actions.resetPolicy }),
    ui.text(' '),
    ui.line(
      ui.head('FILE'),
      `  ${view.configPath ?? 'profile router.json'}  `,
      view.configPath ? ui.Button({ key: 'copy-path', label: 'copy', onPress: actions.copyPath }) : null,
    ),
    ui.dim(SUBAGENT_LINE[config.subagentRouting]),
  ];
}

// One row per configured classifier, as columns to compare: where the prompt goes, its activity probe and p95 wait,
// and whether its credentials are complete. A row press and the deadline are single values with nothing to review as
// a set, so each writes router.json at once; Undo in the status bar puts it back. Under the rows, the active
// classifier's own settings and readings, and its accuracy across sessions.
function classifierTab(ui, config, view, _usage, actions, _modelOptions, columns) {
  const active = activeClassifier(config);
  const health = view.health ?? { failures: 0, pausedUntil: 0 };
  const where = (entry) => (isLocal(entry.endpoint) ? 'this machine' : hostOf(entry.endpoint));
  const rows = Object.entries(config.classifiers).map(([id, entry]) => {
    const isActive = id === config.classifier;
    const missing = missingCredentials(config, view, id);
    const probe = probeOf(config, id);
    return ui.line(
      ui.cell(
        17,
        ui.Button({
          key: `classifier-${id}`,
          label: `${isActive ? '◉' : '○'} ${entry.label.padEnd(10)}`,
          variant: isActive ? 'primary' : 'secondary',
          onPress: () => actions.classifier(id),
        }),
      ),
      ui.cell(21, isLocal(entry.endpoint) ? ui.text(where(entry), { color: 'green' }) : ui.dim(where(entry))),
      ui.cell(8, probe ? `${probe.correct}/${probe.probes}` : ui.dim('—')),
      ui.cell(10, probe ? `${probe.p95Ms} ms` : ui.dim('—')),
      missing
        ? ui.text(`○ ${missingText(config, id, missing)}  `, { color: 'yellow' })
        : ui.text('● ready', { color: 'green' }),
      missing ? ui.Button({ key: `key-${id}`, label: 'Set up', onPress: actions.key }) : null,
    );
  });
  const { latency } = readMetrics(view.activityMetrics);
  const live = latencyP95(Object.hasOwn(latency, config.classifier) ? latency[config.classifier] : null);
  const probe = probeOf(config, config.classifier);
  const p95 = live ? live.ms : probe?.p95Ms;
  const wait = live
    ? `p95 ${live.over ? '>' : '≤'} ${live.ms} ms over ${plural(live.turns, 'turn')}`
    : probe
      ? `p95 ${probe.p95Ms} ms in its probe`
      : 'no wait measured yet';
  const slow = Number.isFinite(p95) && (p95 > active.timeoutMs || live?.over);
  const paused = health.pausedUntil > Date.now();
  return [
    ui.line(ui.head('CLASSIFIER'), ui.dim(' · asked once per new turn · a pick saves at once')),
    ui.dim(`${''.padEnd(17)}${'prompt goes to'.padEnd(21)}${'probe'.padEnd(8)}${'p95'.padEnd(10)}status`),
    ...rows,
    ...dimLines(ui, '  probe: test prompts with a known activity it answered right, and its p95 wait', columns),
    ui.text(' '),
    ui.line(ui.head(active.label.toUpperCase()), ui.dim(' · active')),
    ui.line(
      ui.cell(12, 'Deadline'),
      ui.cell(
        12,
        choice(ui, 'timeoutMs', active.timeoutMs, (v) => `${v} ms`, actions.classifierTimeout),
      ),
      slow ? ui.text(`${wait}: slower than the deadline`, { color: 'yellow' }) : ui.dim(wait),
    ),
    ui.dim(`${''.padEnd(12)}past the deadline the turn keeps its model`),
    ui.line(ui.cell(12, 'Sends'), `prompt + ${config.context.recentTurns} recent turns → ${where(active)}`),
    ui.line(
      ui.cell(12, 'Health'),
      paused
        ? ui.text(`paused until ${new Date(health.pausedUntil).toLocaleTimeString()}`, { color: 'yellow' })
        : 'not paused',
      ` · ${plural(health.failures, 'recent failure')}`,
      Number.isFinite(view.adviceMs) ? ui.dim(` · last ${view.adviceMs} ms`) : null,
    ),
    ui.line(
      ui.cell(12, 'Credentials'),
      ui.Button({ key: 'key', label: 'Edit', hotkey: 'k', onPress: actions.key }),
      ui.dim('  opens /plugin configure'),
    ),
    ...sessionAgreement(ui, view),
    ...(storeSummary(readStore(view.activityStore)).labelled > 0
      ? [ui.text(' '), ...storeUsage(ui, view.activityStore, view.activityMetrics)]
      : []),
  ];
}

// How often this session's tools fit the classifier's accepted activity; none before a labelled turn.
function sessionAgreement(ui, view) {
  const { matched = 0, total = 0 } = view.activityStats?.agreement ?? {};
  if (!total) return [];
  return [
    ui.text(' '),
    ui.head('THIS SESSION'),
    ui.text(`Agreement  classifier vs tools: ${matched} of ${total} turns (${percent(matched / total)})`),
  ];
}

// Green for a write or its undo, red for a refused write, yellow for everything else that needs a look.
const noticeColor = (notice) =>
  /^Not saved/.test(notice) ? 'red' : /^(Saved|Undid|Path copied)/.test(notice) ? 'green' : 'yellow';

// The one place for commit state on every tab: the unsaved Routes and Policy draft with Save and Discard (the
// router.json lines it writes on those two tabs, a count elsewhere), the last notice, and Undo for the last write.
function statusBar(ui, config, view, tab, actions) {
  const changes = routingChanges(config, view);
  const out = [];
  if (changes.count) {
    out.push(ui.text(' '));
    if (DRAFT_TABS.includes(tab)) {
      const diff = (key, before, after) => [
        ui.text(`- ${key.padEnd(30)} ${before}`, { color: 'red' }),
        ui.text(`+ ${key.padEnd(30)} ${after}`, { color: 'green' }),
      ];
      out.push(ui.dim('router.json changes:'));
      for (const tier of changes.tiers)
        out.push(
          ...diff(
            `routes.${tier}`,
            routeName(config, config.routes[tier]),
            routeName(config, changes.draft.routes[tier]),
          ),
        );
      if (changes.baseline) out.push(...diff('baselineTier', config.baselineTier, changes.draft.baselineTier));
      const draft = { ...config, ...changes.draft };
      const cellName = (c, activity, tier) =>
        c.activities[activity]?.[tier] ? routeName(c, resolveRoute(c, tier, activity)) : 'no override';
      for (const [activity, tier] of changes.cells)
        out.push(
          ...diff(`activities.${activity}.${tier}`, cellName(config, activity, tier), cellName(draft, activity, tier)),
        );
      if (changes.mode) out.push(...diff('activityRouting', config.activityRouting, changes.draft.activityRouting));
      for (const [key, , format, field] of POLICY_ROWS.filter(([key]) => changes.policy.includes(key)))
        out.push(...diff(field, format(changes.saved[key]), format(changes.tuning[key])));
    }
    out.push(
      ui.line(
        ui.text(`● ${changes.count} unsaved routing change${changes.count === 1 ? '' : 's'}  `, { color: 'yellow' }),
        ui.Button({
          key: 'save-routing',
          label: 'Save',
          hotkey: 's',
          variant: 'primary',
          onPress: actions.saveRouting,
        }),
        ' ',
        ui.Button({ key: 'discard-routing', label: 'Discard', hotkey: 'd', onPress: actions.discardRouting }),
        DRAFT_TABS.includes(tab) ? null : ui.dim('  listed on Routes and Policy'),
      ),
    );
  }
  const undo = view.lastWrite ? ui.Button({ key: 'undo', label: 'Undo', hotkey: 'u', onPress: actions.undo }) : null;
  const confirmsWrite = Boolean(undo && view.notice?.startsWith('Saved'));
  if (view.notice || undo) out.push(ui.text(' '));
  if (view.notice)
    out.push(ui.line(ui.text(`${view.notice}  `, { color: noticeColor(view.notice) }), confirmsWrite ? undo : null));
  if (undo && !confirmsWrite) out.push(ui.line(ui.dim(`Last change: ${view.lastWrite.label}  `), undo));
  return out;
}

// The counts kept across sessions, read from the stores as last loaded: how often the tools a turn used fit the
// classifier's activity, and what the activity moves led to. Agreement uses the classifier's raw answer, so it can
// differ from the session's.
function storeUsage(ui, store, metrics) {
  const summary = storeSummary(readStore(store));
  const { downMoves } = readMetrics(metrics);
  const out = [ui.head('ACROSS SESSIONS · since the last reset')];
  out.push(ui.text(`Labelled   ${summary.labelled} turns`));
  const { matched, total } = summary.agreement;
  if (total > 0)
    out.push(ui.text(`Agreement  classifier vs tools: ${matched} of ${total} turns (${percent(matched / total)})`));
  const { focus } = summary;
  if (focus.total > 0)
    out.push(
      ui.text(
        `Code/ops/explore  classifier vs tools: ${focus.matched} of ${focus.total} turns (${percent(focus.matched / focus.total)})`,
      ),
    );
  if (summary.disagreements.length)
    out.push(
      ui.text(`Mismatch   ${summary.disagreements.map((d) => `${d.predicted} → ${d.observed} ${d.n}`).join(' · ')}`),
    );
  const { taken, refused } = summary.lateral;
  if (taken + refused > 0) out.push(ui.text(`Activity moves  ${taken} taken · ${refused} refused`));
  const { moves, escalations } = downMoves;
  if (moves > 0)
    out.push(
      ui.text(`Escalations  after a cheaper activity move: ${escalations} in ${moves} move${moves === 1 ? '' : 's'}`),
    );
  return out;
}

// The footer as [text, joiner] pieces, packed to the pane: two lines at full width, more in a narrow pane, never a
// line that ends in a joiner.
const SAVINGS_FOOTER = [
  ['API list prices', ' · '],
  ['same tokens and output length', ' · '],
  ['not a bill;', ' '],
  ['on a Claude plan it stands for quota', ' · '],
  ['answer quality not measured', ''],
];
const FULL_WIDTH = 68;

// `pieces` packed into lines of at most `width` cells after `indent`.
function pack(pieces, width, indent) {
  const lines = [];
  let line = '';
  let joiner = '';
  for (const [text, next] of pieces) {
    if (line && indent.length + line.length + joiner.length + text.length > width) {
      lines.push(indent + line);
      line = text;
    } else line += (line ? joiner : '') + text;
    joiner = next;
  }
  return line ? [...lines, indent + line] : lines;
}

// A dim sentence wrapped by words to a narrow pane, keeping its indent, which Ink's own wrap would drop.
const dimLines = (ui, text, columns) => {
  const indent = /^ */.exec(text)[0];
  const words = text
    .trim()
    .split(' ')
    .map((word) => [word, ' ']);
  return (Number.isFinite(columns) ? pack(words, columns, indent) : [text]).map((line) => ui.dim(line));
};
const footer = (ui, columns) =>
  pack(SAVINGS_FOOTER, Math.min(FULL_WIDTH, columns ?? FULL_WIDTH), '  ').map((line) => ui.dim(line));

// The tier whose route is your model at your effort, for its color; else any tier on your model.
function yourTier(config, view) {
  const runs = (tier) => {
    const route = resolveRoute(config, tier);
    return (
      isSameModel(config.models[route.model].id, view.nativeModel) &&
      routeEffort(config, route, view.nativeEffort) === (view.nativeEffort ?? null)
    );
  };
  return TIERS.find(runs) ?? cellForModel(config, view.nativeModel)?.tier ?? null;
}

// Prices summed over the priced requests, and how many were not priced (a model without a price in router.json).
const pricedText = (text, counts) =>
  counts.pricedRequests < counts.requests ? `${text} (${counts.requests - counts.pricedRequests} unpriced)` : text;

// "Oct 7 – Oct 13" for a period's span, or "since Oct 10", its `first` day, for one without a range; null without one.
function spanText(period, now, first) {
  const { from, to } = periodRange(period, now);
  if (period === 'today') return `today, ${dayLabel(to)}`;
  if (from) return `${dayLabel(from)} – ${dayLabel(to)}`;
  return first ? `since ${dayLabel(first)}` : null;
}

// The subagent rows: the open mark, the type, its squares, agents, cost, and against Claude Code's pick with its arrow.
const AGENT_TYPE = 19;
const AGENT_SQUARES = 12;
const AGENT_ROW = 4 + AGENT_TYPE + AGENT_SQUARES + 3 + 9 + 11;
// The summary strip's squares at most: past this each model gets its share of them, not one per agent.
const AGENT_STRIP = 25;
// The models in the order their squares go, by family; any other after them by name.
const FAMILIES = ['haiku', 'sonnet', 'opus', 'fable'];
const clipped = (text, width) => (text.length < width ? text : `${text.slice(0, width - 2)}…`);
const familyRank = (id) => {
  const rank = FAMILIES.findIndex((family) => id.includes(family));
  return rank < 0 ? FAMILIES.length : rank;
};
const byFamily = (a, b) => familyRank(a[0]) - familyRank(b[0]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
const colored = (ui, id, text) => {
  const color = modelColor(id);
  return ui.text(text, color ? { color } : {});
};

// Each model's agents in a period and how many the router moved, across the routed types and the pass-throughs.
function agentsByModel(s) {
  const models = new Map();
  for (const kind of ['routed', 'passed'])
    for (const counts of Object.values(s[kind]))
      for (const [id, m] of Object.entries(counts.models)) {
        const sum = models.get(id) ?? { agents: 0, moved: 0 };
        models.set(id, { agents: sum.agents + m.agents, moved: sum.moved + (m.moved ?? 0) });
      }
  return [...models].filter(([, m]) => m.agents > 0).sort(byFamily);
}

// Squares for `models` ([id, { agents, moved }]), colored by model, filled for the agents the router moved. `scale`:
// one per agent up to `max`, then each model's share of `max`, at least one. Else one per agent up to `max`, and
// `rest` counts the agents past them.
function squares(ui, models, max, scale) {
  const total = models.reduce((n, [, m]) => n + m.agents, 0);
  const shown = (n) => (!scale || total <= max || !n ? n : Math.max(1, Math.round((n / total) * max)));
  const parts = [];
  let left = max;
  for (const [id, m] of models) {
    const n = Math.min(shown(m.agents), left);
    const filled = Math.min(n, shown(m.moved));
    if (filled) parts.push(colored(ui, id, '■'.repeat(filled)));
    if (n > filled) parts.push(colored(ui, id, '□'.repeat(n - filled)));
    left -= n;
  }
  return { parts, width: max - left, rest: scale ? 0 : total - (max - left) };
}

// "Routing saved $0.21 (5%) on 7 routed agents": the routed agents' cost against Claude Code's picks.
function agentVerdict(ui, routed) {
  const agents = routed.reduce((n, [, c]) => n + c.agents, 0);
  const totals = routed.map(([, c]) => modelTotals(c));
  const cost = totals.reduce((n, t) => n + t.usd, 0);
  const core = totals.reduce((n, t) => n + t.coreUsd, 0);
  const counts = {
    requests: routed.reduce((n, [, c]) => n + c.requests, 0),
    pricedRequests: routed.reduce((n, [, c]) => n + c.pricedRequests, 0),
  };
  if (!counts.pricedRequests) return ui.dim(`  ${plural(agents, 'routed agent')}, not priced`);
  const difference = cents(cost - core);
  const on = pricedText(` on ${plural(agents, 'routed agent')}`, counts);
  if (!difference) return ui.line('  Routing cost the same as Claude Code’s picks', ui.dim(on));
  return ui.line(
    `  Routing ${difference < 0 ? 'saved' : 'cost'} `,
    ui.text(usd(difference), { color: savingsColor(difference) }),
    difference < 0 ? '' : ' more',
    core > 0 ? ` (${percent(Math.abs(difference) / core)})` : '',
    ui.dim(on),
  );
}

// The strip of every agent by model, what the router moved, and how routing paid off.
function agentSummary(ui, s, columns) {
  const models = agentsByModel(s);
  const total = models.reduce((n, [, m]) => n + m.agents, 0);
  const moved = models.reduce((n, [, m]) => n + m.moved, 0);
  const strip = squares(ui, models, AGENT_STRIP, true);
  const labels = models.map(([id, m]) => [id, `${modelName(id)} ${m.agents}`]);
  const names = labels.flatMap(([id, text], i) => [i ? ui.dim(' · ') : null, colored(ui, id, text)]);
  const namesWidth = labels.reduce((n, [, text], i) => n + (i ? 3 : 0) + text.length, 0);
  const out =
    Number.isFinite(columns) && 2 + strip.width + 2 + namesWidth > columns
      ? [ui.line('  ', ...strip.parts), ui.line('  ', ...names)]
      : [ui.line('  ', ...strip.parts, '  ', ...names)];
  out.push(
    ui.line(
      `  ${plural(total, 'agent')}`,
      ui.dim(' · '),
      `■ ${moved} moved by the router`,
      ui.dim(' · '),
      `□ ${total - moved} on Claude Code’s pick`,
    ),
  );
  const routed = Object.entries(s.routed).filter(([, c]) => c.agents > 0);
  if (routed.length) out.push(agentVerdict(ui, routed));
  return out;
}

// Agents per day from the period's first day, or the first recorded one, to today, with the busiest day.
function agentTrend(ui, s, period, now) {
  if (period === 'session' || period === 'today' || !s.perDay.length) return [];
  const counts = new Map(s.perDay);
  const start = periodRange(period, now).from ?? s.perDay[0][0];
  const [y, m, d] = start.split('-').map(Number);
  const days = [];
  for (let i = 0; ; i += 1) {
    const key = dayKey(new Date(y, m - 1, d + i).getTime());
    if (key > dayKey(now)) break;
    days.push([key, counts.get(key) ?? 0]);
  }
  if (days.length < 2) return [];
  const [peakDay, peak] = days.reduce((top, day) => (day[1] > top[1] ? day : top));
  // A long All period keeps its last days, as many as the row has room for.
  const values = days.map(([, n]) => n).slice(-(AGENT_ROW - 30));
  return [
    ui.line('  per day ', ui.text(sparkline(values), { bold: true }), ui.dim(`  peak ${peak} on ${dayLabel(peakDay)}`)),
  ];
}

// "+$0.44 ▲" against Claude Code's pick, in the savings colors; a dim dash when it rounds to nothing.
const pickDifference = (ui, value) =>
  value
    ? ui.text(`${signedUsd(value)} ${value > 0 ? '▲' : '▼'}`.padStart(11), { color: savingsColor(value) })
    : ui.dim('—'.padStart(9));

// What a routed model row holds: "2 moved up", or "1 kept, 2 down".
function moveText(m) {
  const kept = m.agents - m.moved;
  const other = m.moved - m.up - m.down;
  const parts = [
    kept ? `${kept} kept` : null,
    m.up ? `${m.up} up` : null,
    m.down ? `${m.down} down` : null,
    other ? `${other} moved` : null,
  ].filter(Boolean);
  if (parts.length > 1 || kept) return parts.join(', ');
  return `${m.moved} moved${m.up ? ' up' : m.down ? ' down' : ''}`;
}

// One row of the subagent table; open, the models it ran on with their cost, and its requests and retry proxies.
function agentRow(ui, view, actions, { id, name, counts, routed, why, narrow, columns }) {
  const open = view.usageOpen === id;
  const models = Object.entries(counts.models)
    .filter(([, m]) => m.agents > 0)
    .sort(byFamily);
  const marks = squares(
    ui,
    models.map(([model, m]) => [model, { agents: m.agents, moved: m.moved ?? 0 }]),
    AGENT_SQUARES - 3,
    false,
  );
  const t = modelTotals(counts);
  // A row none of whose requests had a price says so rather than $0.00.
  const priced = counts.pricedRequests > 0;
  const costCell = (value) => (priced ? usd(value).padStart(9) : ui.dim('no price'.padStart(9)));
  const out = [
    ui.line(
      '  ',
      ui.Button({
        key: `row-${id}`,
        label: open ? '▾' : '▸',
        plain: true,
        onPress: () => actions.usageOpen(open ? null : id),
      }),
      ' ',
      ui.cell(AGENT_TYPE, clipped(name, AGENT_TYPE)),
      ui.cell(AGENT_SQUARES, ui.line(...marks.parts, marks.rest ? ui.dim(`+${marks.rest}`) : null)),
      String(counts.agents).padStart(3),
      narrow ? null : costCell(t.usd),
      routed && priced ? pickDifference(ui, cents(t.usd - t.coreUsd)) : null,
      !routed && why && !narrow ? ui.dim(`  ${why}`) : null,
    ),
  ];
  if (!open) return out;
  for (const [model, m] of models)
    out.push(
      ui.line(
        '      ',
        ui.cell(17, colored(ui, model, `${m.moved ? '■' : '□'} ${modelName(model)}`)),
        ui.cell(15, ui.dim(routed ? moveText(m) : plural(m.agents, 'agent'))),
        narrow ? null : costCell(m.usd),
        routed && priced ? pickDifference(ui, cents(m.usd - m.coreUsd)) : null,
      ),
    );
  const notes = [
    `${(counts.requests / counts.agents).toFixed(1)} requests per agent`,
    routed ? `${counts.respawns || 'none'} respawned within 10 min` : null,
    counts.failures ? plural(counts.failures, 'classifier failure') : null,
    counts.pricedRequests < counts.requests ? `${counts.requests - counts.pricedRequests} requests not priced` : null,
  ].filter(Boolean);
  out.push(...dimLines(ui, `      ${notes.join(' · ')}`, columns));
  return out;
}

// Subagents in the chosen period: this session's record, or every session's in every project (one $.store per
// plugin install). A strip of every agent by the model it ran on, filled where the router moved it off Claude Code's
// pick, and the routed agents' cost against those picks. Then the routed types and the pass-throughs, each with its
// squares, agents and cost, opening to its models; a pass-through says why Claude Code picked.
function subagentUsage(ui, config, view, actions, period, now, columns) {
  const mode = config.subagentRouting;
  const record = readSubagentStore(period === 'session' ? view.subagentSession : view.subagentStore);
  const s = summarizeSubagents(record, periodRange(period, now));
  const first = Number.isFinite(record.since) ? dayKey(record.since) : null;
  const scope =
    period === 'session' ? 'this session' : `all projects · ${spanText(period, now, first) ?? 'nothing yet'}`;
  const out = [ui.line(ui.head('SUBAGENTS'), ui.dim(` · ${scope}   subagent routing ${mode}`))];
  const routed = Object.entries(s.routed)
    .filter(([, c]) => c.agents > 0)
    .sort((a, b) => b[1].agents - a[1].agents || (a[0] < b[0] ? -1 : 1));
  const passed = PASS_REASONS.filter((reason) => s.passed[reason]?.agents > 0).sort(
    (a, b) => s.passed[b].agents - s.passed[a].agents,
  );
  const undated = s.undated
    ? [
        ui.dim(
          `  + ${plural(s.undated.agents, 'agent')} from before 1.14.0, not split by model · ${usd(s.undated.usd)}`,
        ),
      ]
    : [];
  if (!routed.length && !passed.length) {
    const older = !s.undated && periodRange(period, now).from !== null && readSubagentStore(view.subagentStore).undated;
    return [
      ...out,
      ui.dim(
        mode === 'off'
          ? '  Not recorded: subagentRouting is off in router.json.'
          : `  No subagents ${PERIOD_PHRASE[period]}.`,
      ),
      ...undated,
      ...(older ? [ui.dim('  Agents from before 1.14.0 have no date: All shows them.')] : []),
    ];
  }
  const narrow = Number.isFinite(columns) && columns < AGENT_ROW;
  out.push(...agentSummary(ui, s, columns), ...agentTrend(ui, s, period, now), ...undated);
  const rowOf = (fields) => agentRow(ui, view, actions, { narrow, columns, ...fields });
  if (routed.length) {
    out.push(
      ui.text(' '),
      ui.line(ui.text('  ROUTED', { bold: true }), ui.dim(' · the router picked the model at spawn')),
      ui.dim(
        `    ${'type'.padEnd(AGENT_TYPE)}${'agents'.padEnd(AGENT_SQUARES + 3)}${narrow ? '' : 'cost'.padStart(9)}${'vs CC'.padStart(9)}`,
      ),
    );
    for (const [type, counts] of routed)
      out.push(...rowOf({ id: `subagent:${type}`, name: type, counts, routed: true }));
  }
  if (passed.length) {
    out.push(ui.text(' '), ui.line(ui.text('  NOT ROUTED', { bold: true }), ui.dim(' · Claude Code picked the model')));
    for (const reason of passed)
      out.push(
        ...rowOf({
          id: `subagent-pass:${reason}`,
          name: PASS_LABEL[reason],
          counts: s.passed[reason],
          routed: false,
          why: PASS_WHY[reason],
        }),
      );
  }
  out.push(
    ui.text(' '),
    ...dimLines(ui, '  ■ moved by the router · □ Claude Code’s pick · color: the model', columns),
    ...(routed.length ? dimLines(ui, '  vs CC: the same tokens on Claude Code’s pick, at list prices', columns) : []),
  );
  return out;
}

// This session's subagents on the Now tab: how many run now, the strip, and how routing paid off. Nothing without any.
function sessionAgentLines(ui, view, actions, columns) {
  const s = summarizeSubagents(readSubagentStore(view.subagentSession), { from: null, to: null });
  const running = view.subagentsRunning ?? 0;
  const any = [...Object.values(s.routed), ...Object.values(s.passed)].some((c) => c.agents > 0);
  if (!any && !running) return [];
  const head = ui.line(
    ui.head('SUBAGENTS'),
    ui.dim(' · this session'),
    running ? ui.text(` · ● ${running} running`, { color: 'yellow' }) : null,
    '  ',
    ui.Button({ key: 'usage-agents', label: 'Usage', onPress: () => actions.usageFor('session') }),
  );
  return [ui.text(' '), head, ...(any ? agentSummary(ui, s, columns) : [])];
}

const PERIOD_LABEL = { session: 'Session', today: 'Today', '7d': '7d', '30d': '30d', month: 'Month', all: 'All' };
// "No routed replies …" for each period.
const PERIOD_PHRASE = {
  session: 'this session',
  today: 'today',
  '7d': 'in the last 7 days',
  '30d': 'in the last 30 days',
  month: 'this month',
  all: 'yet',
};
const GROUPS = [
  ['activity', 'Activity'],
  ['model', 'Model'],
  ['tier', 'Tier'],
];
// What an open row lists: the routes of an activity, the activities of a model or a tier.
const CHILD_BY = { activity: 'route', model: 'activity', tier: 'activity' };
// The ledger's label column after its sign, and its amount column.
const LEDGER_LABEL = 20;
const LEDGER_AMOUNT = 9;
// The breakdown: the open mark, the name, replies, cost and vs yours; "mostly on" or the share only where it fits.
const NAME = 20;
const BREAKDOWN = 4 + NAME + 8 + 10 + 11;
const TAIL = 23;
// Bars at full scale: the routed share of your model, and the costliest row of What if.
const BAR = 22;
const SPARK = '▁▂▃▄▅▆▇█';

const dayLabel = (key) => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};
// "Opus 5.5 · high" for a cell's `id@effort`.
function routeText(route) {
  const at = route.lastIndexOf('@');
  const effort = route.slice(at + 1);
  return routeLabel(route.slice(0, at), effort === 'session' ? null : effort);
}
// A cents difference, so a row never reads "+$0.00" for a fraction of a cent.
const cents = (usd) => Math.round(usd * 100) / 100;
const differenceText = (ui, usdValue, width) => {
  const value = cents(usdValue);
  return ui.text(signedUsd(value).padStart(width), savingsColor(value) ? { color: savingsColor(value) } : {});
};

// A breakdown row's name: an activity as its verb, a tier in its color, a model or a route by name.
function groupName(ui, by, name) {
  if (name === 'none') return ui.dim(by === 'activity' ? 'no activity' : 'not routed');
  if (by === 'activity') return ui.activity(name);
  if (by === 'tier') return ui.tier(name);
  return ui.text(by === 'model' ? modelName(name) : routeText(name));
}

// The period buttons; `p` presses the one after the shown period, so it steps through them.
function periodRow(ui, period, actions) {
  const next = PERIODS[(PERIODS.indexOf(period) + 1) % PERIODS.length];
  return ui.line(
    ...PERIODS.flatMap((id) => [
      ui.Button({
        key: `period-${id}`,
        label: PERIOD_LABEL[id],
        ...(id === next ? { hotkey: 'p' } : {}),
        variant: id === period ? 'primary' : 'secondary',
        onPress: () => actions.period(id),
      }),
      ' ',
    ]),
    ui.dim('  p next'),
  );
}

// Whose replies the period holds and what each is compared with.
function scopeLine(ui, config, view, period, summary, now) {
  if (period === 'session') {
    const recorded = recordedModels(config, view, summary);
    if (recorded)
      return ui.dim(
        Object.keys(summary.yours).length > 1
          ? `this session · each reply vs the model /model selected: ${recorded}`
          : `this session · your model ${recorded}`,
      );
    const tier = yourTier(config, view);
    return ui.line(
      ui.dim('this session · your model '),
      tier ? ui.tier(tier, yourModel(view)) : ui.text(yourModel(view)),
    );
  }
  const span = spanText(period, now, summary.days[0]?.[0]) ?? 'no dated replies yet';
  return ui.dim(`all projects · ${span} · each session vs its own model`);
}

// The models a session's replies were priced against, when they are not the one `/model` selects now: after a
// `/model` change the record keeps each reply against the model selected when it ran. Null when they are.
function recordedModels(config, view, summary) {
  const ids = Object.keys(summary.yours);
  if (!ids.length || (ids.length === 1 && ids[0] === modelSpec(config, view.nativeModel)?.id)) return null;
  return ids.map(modelName).join(', ');
}

// The answer first: "Routing saved $1.84 (22%) vs your model", what it cost more, or why there is nothing to compare.
function headline(ui, config, view, period, r) {
  if (!r.replies) {
    // A reply is priced against your model, so on a model without a price none is counted.
    if (period === 'session' && !modelSpec(config, view.nativeModel))
      return [ui.dim(`${modelName(view.nativeModel)} has no list price in router.json models.`)];
    const off = period === 'session' && (view.phase === 'unavailable' || view.mode === 'manual');
    return [
      ui.dim(
        off
          ? `Routing is ${view.phase === 'unavailable' ? 'unavailable' : 'off'}: replies use your model and are not counted.`
          : `No routed replies ${PERIOD_PHRASE[period]}.`,
      ),
    ];
  }
  return [
    ui.line(
      ...verdictParts(ui, r),
      r.early ? ui.text(`   early sample · ${plural(r.replies, 'reply', 'replies')}`, { color: 'yellow' }) : null,
    ),
  ];
}

// "Routing saved $1.84 (22%) vs your model", or what it cost more: the text before the amount, the amount, the rest.
function verdictText(r) {
  const share = differenceShare(r)?.replace(/^[−+]/, '');
  return [
    r.differenceUsd < 0 ? 'Routing saved ' : r.differenceUsd > 0 ? 'Routing cost ' : 'Routing cost the same as',
    r.differenceUsd === 0 ? '' : `${usd(r.differenceUsd)}${share ? ` (${share})` : ''}`,
    r.differenceUsd < 0 ? ' vs your model' : r.differenceUsd > 0 ? ' more than your model' : ' your model',
  ];
}
// The verdict as line parts, the amount bold in the savings color.
function verdictParts(ui, r) {
  const [before, amount, after] = verdictText(r);
  return [before, amount ? ui.text(amount, { bold: true, color: savingsColor(r.differenceUsd) }) : '', after];
}

// Your model − cheaper models + stronger models + switch cache writes = routed, in whole cents that add up (readout).
function ledger(ui, config, view, { period, r, summary, legacy, columns }) {
  const tier = yourTier(config, view);
  const row = (sign, label, value, color, note = null, bold = false) =>
    ui.line(
      ui.dim(`  ${sign} `),
      ui.cell(LEDGER_LABEL, ui.text(label, bold ? { bold: true } : {})),
      ui.text(usd(value).padStart(LEDGER_AMOUNT), { ...(color ? { color } : {}), ...(bold ? { bold: true } : {}) }),
      note ? '   ' : null,
      note,
    );
  // The undated totals kept no switch count, so All with them names none.
  const switches = legacy?.replies ? null : summary.switches.tier + summary.switches.activity;
  const recorded = period === 'session' ? recordedModels(config, view, summary) : null;
  const saving = -r.cheaperUsd;
  const ratio = r.yoursUsd > 0 ? r.routedUsd / r.yoursUsd : null;
  const wide = !Number.isFinite(columns) || columns >= 4 + LEDGER_LABEL + LEDGER_AMOUNT + 3 + BAR + 16;
  const filled = ratio === null ? 0 : Math.max(0, Math.min(BAR, Math.round(ratio * BAR)));
  const out = [
    row(
      ' ',
      'Your model',
      r.yoursUsd,
      undefined,
      period !== 'session'
        ? ui.dim('each session’s own model')
        : recorded
          ? ui.dim(recorded)
          : tier
            ? ui.tier(tier, yourModel(view))
            : ui.text(yourModel(view)),
    ),
    row('−', 'Cheaper models', r.cheaperUsd, savingsColor(r.cheaperUsd)),
    row('+', 'Stronger models', r.strongerUsd, savingsColor(r.strongerUsd)),
    row(
      '+',
      'Switch cache writes',
      r.switchUsd,
      savingsColor(r.switchUsd),
      ui.dim(
        [
          switches === null ? null : plural(switches, 'route switch', 'route switches'),
          saving > 0 && r.switchUsd > 0 ? `${percent(r.switchUsd / saving)} of the saving` : null,
        ]
          .filter(Boolean)
          .join(' · '),
      ),
    ),
    row(
      '=',
      'Routed',
      r.routedUsd,
      undefined,
      wide && ratio !== null
        ? ui.line(
            ui.text('█'.repeat(filled), { color: 'cyan' }),
            ui.dim('░'.repeat(BAR - filled)),
            ui.dim(` ${ratio < 2 ? percent(ratio) : `×${ratio.toFixed(1)}`} of your model`),
          )
        : null,
      true,
    ),
  ];
  if (legacy?.replies)
    out.push(
      ...dimLines(
        ui,
        `    includes ${usd(legacy.routedUsd)} routed before dated records, kept without a breakdown`,
        columns,
      ),
    );
  return out;
}

// Replies, turns, tokens and the cache share of the input.
const statsLine = (ui, s) =>
  ui.dim(
    `  ${plural(s.replies, 'reply', 'replies')} · ${plural(s.turns, 'turn')} · input ${formatTokens(s.inputTokens)}` +
      ` · cache hit ${s.inputTokens ? percent(s.cacheReadTokens / s.inputTokens) : '—'} · output ${formatTokens(s.outputTokens)}`,
  );

// The period's cost by activity, model or tier, most first; `g` presses the next grouping. A row opens to what it
// holds and its cost parts. A narrow pane drops "mostly on" (or the share) before any number.
function breakdownLines(ui, view, actions, summary, columns) {
  const by = GROUPS.some(([id]) => id === view.usageGroup) ? view.usageGroup : 'activity';
  const next = GROUPS[(GROUPS.findIndex(([id]) => id === by) + 1) % GROUPS.length][0];
  const out = [
    ui.line(
      ui.head('BY  '),
      ...GROUPS.flatMap(([id, label]) => [
        ui.Button({
          key: `group-${id}`,
          label,
          ...(id === next ? { hotkey: 'g' } : {}),
          variant: id === by ? 'primary' : 'secondary',
          onPress: () => actions.usageGroup(id),
        }),
        ' ',
      ]),
      ui.dim('  g next'),
    ),
  ];
  const groups = breakdown(summary.cells, by);
  if (!groups.length) return [...out, ui.dim('  no routed replies in this period')];
  const tail = !Number.isFinite(columns) || columns >= BREAKDOWN + TAIL;
  const tailHead = by === 'model' ? 'share' : 'mostly on';
  out.push(
    ui.dim(
      `    ${''.padEnd(NAME)}${'replies'.padStart(8)}${'cost'.padStart(10)}${'vs yours'.padStart(11)}${tail ? `   ${tailHead}` : ''}`,
    ),
  );
  const numbers = (sums) => [
    `${String(sums[0]).padStart(8)}${usd(sums[1]).padStart(10)}`,
    differenceText(ui, sums[1] - sums[2], 11),
  ];
  for (const group of groups) {
    const id = `${by}:${group.name}`;
    const open = view.usageOpen === id;
    const route = by === 'model' ? null : mostlyOn(cellsWhere(summary.cells, by, group.name));
    out.push(
      ui.line(
        '  ',
        ui.Button({
          key: `row-${id}`,
          label: open ? '▾' : '▸',
          plain: true,
          onPress: () => actions.usageOpen(open ? null : id),
        }),
        ' ',
        ui.cell(NAME, groupName(ui, by, group.name)),
        ...numbers(group.sums),
        !tail
          ? null
          : by === 'model'
            ? ui.dim(`   ${percent(summary.routedUsd > 0 ? group.sums[1] / summary.routedUsd : 0)}`)
            : route
              ? ui.dim(`   ${routeText(route)}`)
              : null,
      ),
    );
    if (!open) continue;
    for (const child of group.children)
      out.push(ui.line('      ', ui.cell(NAME - 2, groupName(ui, CHILD_BY[by], child.name)), ...numbers(child.sums)));
    const [, , , cheaper, stronger, switched, input, , output] = group.sums;
    out.push(
      ...dimLines(
        ui,
        `      cheaper ${signedUsd(cents(cheaper))} · stronger ${signedUsd(cents(stronger))} · switch ${signedUsd(cents(switched))} · input ${formatTokens(input)} · output ${formatTokens(output)}`,
        columns,
      ),
    );
  }
  return out;
}

// What the period's tokens would cost on each model alone, as your model for every reply (compareModels), beside what
// routing spent and your own models; a model some reply had no price on is left out.
function compareLines(ui, summary) {
  const yours = Object.keys(summary.yours);
  const single = yours.length === 1 ? yours[0] : null;
  const rows = Object.entries(summary.whatIf)
    .filter(([, [n]]) => n === summary.replies)
    .map(([model, [, value]]) => ({
      label: `${modelName(model)}${model === single ? ' · yours' : ''}`,
      value,
      routed: false,
      yours: model === single,
    }));
  if (!rows.some((row) => row.yours))
    rows.push({
      label: yours.length > 1 ? 'Your models' : 'Your model',
      value: summary.yoursUsd,
      routed: false,
      yours: true,
    });
  rows.push({ label: 'Routed', value: summary.routedUsd, routed: true, yours: false });
  rows.sort((a, b) => a.value - b.value);
  const max = Math.max(...rows.map((row) => row.value));
  return [
    ...rows.map((row) => {
      const filled = max > 0 ? Math.max(0, Math.min(BAR, Math.round((row.value / max) * BAR))) : 0;
      return ui.line(
        '  ',
        ui.cell(22, ui.text(row.label, row.routed ? { bold: true } : {})),
        ui.text('█'.repeat(filled), { color: row.routed ? 'cyan' : 'gray' }),
        ' '.repeat(BAR - filled),
        usd(row.value).padStart(LEDGER_AMOUNT),
        row.routed ? '' : row.yours ? ui.dim('—'.padStart(11)) : differenceText(ui, row.value - summary.yoursUsd, 11),
      );
    }),
    ui.dim('  same tokens and output on each model alone · answer quality not measured'),
  ];
}

// Routed cost per hour, day or week as one line of blocks, a dot for a bucket without replies; and the What if switch.
function trendLines(ui, view, actions, summary, period, now) {
  const toggle = ui.Button({
    key: 'usage-compare',
    label: view.usageCompare ? 'Trend' : 'What if',
    hotkey: 'c',
    onPress: actions.usageCompare,
  });
  const t = trend(summary, period, now);
  if (t.values.length < 2) return [ui.line(ui.head('COST'), ui.dim('  one bucket so far   '), toggle)];
  const max = Math.max(...t.values);
  const glyphs = t.values.map((v) => (v > 0 ? SPARK[Math.min(7, Math.floor((v / max) * 8))] : '·')).join('');
  return [
    ui.line(
      ui.head(`COST BY ${t.unit.toUpperCase()} `),
      ui.text(glyphs, { color: 'cyan' }),
      ui.dim(`  peak ${usd(max)}   `),
      toggle,
    ),
  ];
}

// The evidence worth a look, each with the tab that changes it: the cell that carried most of the cost, the switch
// writes against the saving, the cell that ran above your model. Never which model to use.
function insightLines(ui, summary, actions, columns) {
  if (summary.replies < INSIGHT_REPLIES) return [];
  const list = insights(summary);
  if (!list.length) return [];
  return [
    ui.text(' '),
    ui.line(ui.head('WORTH A LOOK'), ui.dim(' · from the numbers; answer quality is not measured')),
    ...list.map((insight) => insightLine(ui, insight, actions, columns)),
  ];
}

// One finding with the tab that changes it.
function insightLine(ui, insight, actions, columns) {
  const where = ({ activity, tier }) => [
    ...(ACTIVITIES.includes(activity) ? [ui.activity(activity), ui.dim(' · ')] : []),
    TIERS.includes(tier) ? ui.tier(tier) : ui.dim('not routed'),
  ];
  const link = (insight) =>
    TIERS.includes(insight.tier)
      ? ui.Button({
          key: `insight-${insight.kind}`,
          label: 'Routes',
          onPress: () =>
            actions.openRoute(
              ACTIVITIES.includes(insight.activity) ? `${insight.activity}.${insight.tier}` : `tier.${insight.tier}`,
            ),
        })
      : null;
  return insight.kind === 'switch'
    ? ui.line(
        `  Switch cache writes used ${percent(insight.share)} of the cheaper-model saving  `,
        ui.Button({ key: 'insight-switch', label: 'Policy', onPress: () => actions.tab('policy') }),
      )
    : ui.line(
        '  ',
        ...where(insight),
        insight.kind === 'cost'
          ? ` carried ${percent(insight.share)} of the cost`
          : ` ran ${usd(insight.usd)} above your model`,
        insight.route && (!Number.isFinite(columns) || columns >= 90)
          ? ui.dim(` · mostly ${routeText(insight.route)}`)
          : null,
        '  ',
        link(insight),
      );
}

// Delete history waits for a second press, as nothing brings the records back.
function deleteLine(ui, view, actions) {
  if (!view.confirmDelete)
    return ui.Button({
      key: 'delete-history',
      label: 'Delete history',
      dimColor: true,
      onPress: () => actions.confirmDelete(true),
    });
  return ui.line(
    ui.text('Delete the usage, activity and subagent history of every session?  ', { color: 'yellow' }),
    ui.Button({ key: 'delete-confirm', label: 'Delete', variant: 'primary', onPress: actions.resetStats }),
    ' ',
    ui.Button({ key: 'delete-keep', label: 'Keep', onPress: () => actions.confirmDelete(false) }),
  );
}

// Answer first for the chosen period: routing against your model as a ledger that adds up, the tokens, the cost by
// activity, model or tier, the trend or What if, and what is worth a look. Subagents follow, for the same period.
function usageTab(ui, config, view, _usage, actions, _modelOptions, columns, now) {
  const period = PERIODS.includes(view.usagePeriod) ? view.usagePeriod : 'session';
  const record = readUsage(period === 'session' ? view.usageSession : view.usageStore);
  const summary = summarize(record, periodRange(period, now));
  // All adds the undated savings totals kept from before the usage records.
  const kept = period === 'all' ? allTime(view.usageStore, view.savingsStore) : null;
  const legacy = kept?.legacy ?? null;
  const r = readout(kept?.totals ?? summary);
  const out = [periodRow(ui, period, actions), scopeLine(ui, config, view, period, summary, now), ui.text(' ')];
  out.push(...headline(ui, config, view, period, r));
  if (r.replies) {
    out.push(ui.text(' '), ...ledger(ui, config, view, { period, r, summary, legacy, columns }));
    if (summary.replies) out.push(ui.text(' '), statsLine(ui, summary));
  }
  if (summary.replies) {
    out.push(ui.text(' '), ...breakdownLines(ui, view, actions, summary, columns), ui.text(' '));
    out.push(
      ...(view.usageCompare
        ? [
            ui.line(
              ui.head('WHAT IF'),
              ui.dim(' · the same tokens on one model   '),
              ui.Button({ key: 'usage-compare', label: 'Trend', hotkey: 'c', onPress: actions.usageCompare }),
            ),
            ...compareLines(ui, summary),
          ]
        : trendLines(ui, view, actions, summary, period, now)),
      ...insightLines(ui, summary, actions, columns),
    );
  }
  out.push(
    ui.text(' '),
    ...subagentUsage(ui, config, view, actions, period, now, columns),
    ui.text(' '),
    ...footer(ui, columns),
  );
  out.push(ui.text(' '), deleteLine(ui, view, actions));
  return out;
}

function helpLines(ui) {
  return [
    ui.text(' '),
    ui.head('ABOUT THESE NUMBERS'),
    ui.dim('Cost, context and cache are Claude readings. $ estimates use the'),
    ui.dim('list prices in router.json; plan prices are equivalents, not cash.'),
    ui.dim('Routing vs your model holds tokens and output length the same'),
    ui.dim('and does not measure answer quality. Cache benefit is before writes.'),
    ui.dim('The context bar uses the routed model’s window, 20% in reserve.'),
    ui.dim('A switch estimate prices 5m–1h cache writes; minus means cheaper.'),
  ];
}

import { compareRoutes } from './activity.mjs';
import { latencyP95, mostlyOn, readMetrics, readStore, storeSummary } from './activity-stats.mjs';
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
  bar,
  classifierLabel,
  classifierStatus,
  differenceShare,
  formatTokens,
  GATEWAY_CLEANUP,
  GATEWAY_SETTINGS,
  missingCredentials,
  missingText,
  modelName,
  percent,
  percentPair,
  probeOf,
  routeLabel,
  routeName,
  savingsColor,
  signedUsd,
  sinceDate,
  sparkline,
  strongerReplies,
  switchCount,
  TIER_COLOR,
  unavailableReason,
  usageMetrics,
  usd,
  whyText,
  yourModel,
} from './display.mjs';
import { cellForModel, isSameModel } from './route.mjs';
import {
  EARLY_REPLIES,
  emptyTotals,
  modelAlias,
  modelEntry,
  modelSpec,
  readout,
  readSavingsStore,
} from './savings.mjs';
import { PASS_REASONS, readSubagentStore } from './subagents.mjs';

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
const share = (value) => (value === null ? '—' : `${value}%`);
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
  { modelOptions = Object.keys(config.models), columns = null } = {},
) {
  const ui = kit(elements);
  const tab = TABS.some(([id]) => id === view.tab) ? view.tab : 'now';
  const body = { now: nowTab, routes: routesTab, policy: policyTab, classifier: classifierTab, usage: usageTab }[tab];
  return ui.Box({
    flexDirection: 'column',
    children: [
      ...header(ui, config, view, tab, actions),
      ...body(ui, config, view, usage, actions, modelOptions, columns),
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

// What runs next turn and why first; then the classifier's support per tier with pins, the recent replies, and the
// context and cost readings.
function nowTab(ui, config, view, usage, actions) {
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
    ui.text(' '),
    ui.line(
      ui.head('TIERS'),
      ui.dim(auto ? ` · ${label} support on the last turn · pin = next turn only` : ` · ${label} support`),
    ),
  ];
  for (const tier of LADDER) {
    const support = view.probabilities?.[tier];
    const meter = Number.isFinite(support) ? bar(support, 1, 10) : null;
    out.push(
      ui.line(
        view.tier === tier ? ui.tier(tier, '▶ ') : '  ',
        ui.tier(tier, tier.padEnd(8)),
        routeName(config, config.routes[tier]).padEnd(22),
        meter ? ui.text(meter.text, { color: TIER_COLOR[tier] }) : ui.dim('—'.padEnd(10)),
        meter ? ` ${percent(support).padStart(4)}  ` : '       ',
        auto ? ui.Button({ key: `pin-${tier}`, label: 'pin', onPress: () => actions.pin(tier) }) : null,
      ),
    );
  }
  if (!auto)
    out.push(ui.dim(unavailable ? '  Pins need routing, which is unavailable.' : '  Pins need routing on (o above).'));
  out.push(ui.text(' '), ...replies(ui, view));
  out.push(
    ui.text(' '),
    ui.gauge('Context  ', metrics.contextBar, contextSuffix(metrics)),
    ui.line(
      ui.text('Cache    ', { color: metrics.cacheBar.color }),
      metrics.cacheBar.percent === null
        ? ui.dim('no reply yet')
        : ui.text(`${metrics.cacheBar.percent}% reused on the last reply`, { color: metrics.cacheBar.color }),
      ui.dim('  ·  '),
      `cost ${dollars(metrics.cost)} `,
      ui.dim('by Claude'),
    ),
  );
  return out;
}

const verbShare = (text) => text.replace(/^(\S+)/, (name) => activityVerb(name));

// The last replies, one cell each colored by the tier that served it, a dot where routing did not choose; the switch
// count; the replies per tier, which is also the color key; and the replies per activity.
function replies(ui, view) {
  const tiers = view.tiers ?? [];
  if (!tiers.length) return [ui.head('LAST REPLIES'), ui.dim('  no replies yet')];
  const switches = switchCount((view.routes ?? []).slice(-tiers.length));
  const count = (list, value) => list.filter((item) => item === value).length;
  const notRouted = count(tiers, null);
  // A view from before 1.6 has fewer activities: they align from the newest.
  const activities = (view.activities ?? []).slice(-tiers.length);
  const used = ACTIVITIES.map((activity) => [activity, count(activities, activity)])
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  return [
    ui.line(
      ui.head(tiers.length === 1 ? 'LAST REPLY' : `LAST ${tiers.length} REPLIES`),
      ui.dim(` · ${plural(switches, 'model switch', 'model switches')}`),
    ),
    ui.line('  ', ...tiers.map((tier) => (tier ? ui.tier(tier, '█') : ui.dim('·')))),
    ui.line(
      '  ',
      ...TIERS.filter((tier) => tiers.includes(tier)).flatMap((tier) => [
        ui.tier(tier, '■ '),
        `${tier} ${count(tiers, tier)}  `,
      ]),
      notRouted ? ui.dim(`· not routed ${notRouted}`) : null,
    ),
    ...(used.length
      ? [
          ui.line(
            '  ',
            ...used.flatMap(([activity, n], i) => [
              ui.activity(activity),
              ui.dim(` ${n}${i < used.length - 1 ? ' · ' : ''}`),
            ]),
          ),
        ]
      : []),
  ];
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
    ...(storeSummary(readStore(view.activityStore)).labelled > 0
      ? [ui.text(' '), ...storeUsage(ui, view.activityStore, view.activityMetrics)]
      : []),
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

// The ACTIVITY table's columns before the cost, and the cost column.
const ACTIVITY_TABLE = 48;
const ACTIVITY_COST = 11;

// Session counts by activity: turns, requests, share, the estimated list price of their replies and the route most of
// them ran on; the switches by cause and the tool agreement. The counts kept across sessions are on
// the Classifier tab.
function activityUsage(ui, config, view, columns) {
  const stats = view.activityStats ?? null;
  const mode = config.activityRouting;
  if (mode === 'off' && !stats)
    return [
      ui.head('BY ACTIVITY · activity routing off'),
      ui.dim('  Not asked. Set activity routing to on in the Routes tab.'),
    ];
  const out = [ui.line(ui.head('BY ACTIVITY · this session'), ui.dim(`   activity routing ${mode}`))];
  const rows = Object.entries(stats?.byActivity ?? {}).filter(([, counts]) => counts?.turns > 0);
  if (!rows.length) out.push(ui.dim('  no activity readings yet'));
  else {
    const total = rows.reduce((sum, [, counts]) => sum + counts.turns, 0);
    // A partial sum would read as the whole: a cost shows only when every reply had a price.
    const cost = (counts) =>
      Number.isFinite(counts.routedUsd) && counts.pricedRequests === counts.requests ? usd(counts.routedUsd) : '—';
    const route = (counts) => {
      const key = mostlyOn(counts);
      if (!key) return '—';
      const at = key.lastIndexOf('@');
      const effort = key.slice(at + 1);
      return routeLabel(key.slice(0, at), effort === 'session' ? null : effort);
    };
    // A narrow pane drops "mostly on", then the cost, before any column it had before them.
    const widest = Math.max('mostly on'.length, ...rows.map(([, counts]) => route(counts).length));
    const fits = (width) => !Number.isFinite(columns) || width <= columns;
    const showCost = fits(ACTIVITY_TABLE + ACTIVITY_COST);
    const showRoute = showCost && fits(ACTIVITY_TABLE + ACTIVITY_COST + 3 + widest);
    out.push(
      ui.dim(
        `  ${''.padEnd(12)}${''.padEnd(10)}${'turns'.padStart(7)}${'requests'.padStart(10)}${'share'.padStart(7)}` +
          `${showCost ? 'est. cost'.padStart(ACTIVITY_COST) : ''}${showRoute ? '   mostly on' : ''}`,
      ),
    );
    for (const [name, counts] of rows.sort((a, b) => b[1].turns - a[1].turns)) {
      const share = counts.turns / total;
      out.push(
        ui.line(
          '  ',
          ui.cell(12, ui.activity(name)),
          ui.text(bar(share, 1, 10).text, { color: 'cyan' }),
          `${String(counts.turns).padStart(7)}${String(counts.requests).padStart(10)}${percent(share).padStart(7)}` +
            `${showCost ? cost(counts).padStart(ACTIVITY_COST) : ''}${showRoute ? `   ${route(counts)}` : ''}`,
        ),
      );
    }
  }
  if (stats) {
    const { tier, activity } = stats.switches;
    // Refused moves change no route.
    const refused = stats.lateral?.refused ?? 0;
    out.push(
      ui.text(
        `Switches   ${tier + activity} · ${tier} by tier · ${activity} by activity${refused ? ` · ${refused} refused` : ''}`,
      ),
    );
    const { matched, total } = stats.agreement;
    if (total > 0)
      out.push(ui.text(`Agreement  classifier vs tools: ${matched} of ${total} turns (${percent(matched / total)})`));
  }
  return out;
}

// Bars are this wide at the larger of routed and your model; the section drops them before any number when the pane is
// narrower than the table.
const SAVINGS_BAR = 22;
const SAVINGS_COLUMN = 15;
const SAVINGS_PARTS = ['    cheaper models', '    stronger than yours', '    cache writes from switches'];
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

// One readout cell of the Difference row: "too early" below EARLY_REPLIES replies, else the signed amount and share.
function differenceCell(ui, r) {
  if (!r) return '';
  if (r.early) return ui.dim('too early');
  const share = differenceShare(r);
  return ui.text(`${signedUsd(r.differenceUsd)}${share ? ` ${share}` : ''}`, {
    bold: true,
    color: savingsColor(r.differenceUsd),
  });
}

const partCell = (ui, value) => (value === null ? '' : ui.text(signedUsd(value), { color: savingsColor(value) }));

// A bar of `parts` ([usd, color]) at `scale` cells per dollar, filled to SAVINGS_BAR with dim cells. Each part ends at
// its rounded running total, so the parts add up to the bar.
function moneyBar(ui, parts, scale) {
  let at = 0;
  let sum = 0;
  const out = [];
  for (const [value, color] of parts) {
    sum += value;
    const end = Math.round(sum * scale);
    if (end > at) out.push(ui.text('█'.repeat(end - at), color ? { color } : {}));
    at = Math.max(at, end);
  }
  if (at < SAVINGS_BAR) out.push(ui.dim('░'.repeat(SAVINGS_BAR - at)));
  return out;
}

// The parts of a session readout past "too early": each part, the stronger replies, the two costs as bars (not in a
// narrow pane), the replies by tier and why routing spent more.
function savingsDetail(ui, view, { totals, session, across, row, tier, narrow, columns }) {
  const out = [];
  const savedPart = (key) => (across && !across.early ? partCell(ui, across[key]) : null);
  const stronger = strongerReplies(totals);
  out.push(
    row(ui.dim(SAVINGS_PARTS[0]), partCell(ui, session.cheaperUsd), savedPart('cheaperUsd')),
    row(ui.dim(SAVINGS_PARTS[1]), partCell(ui, session.strongerUsd), savedPart('strongerUsd')),
    ...(stronger.count
      ? dimLines(
          ui,
          `      ${stronger.count} repl${stronger.count === 1 ? 'y' : 'ies'} on ${stronger.several ? 'stronger models' : modelName(stronger.model)}`,
          columns,
        )
      : []),
    row(ui.dim(SAVINGS_PARTS[2]), partCell(ui, session.switchUsd), savedPart('switchUsd')),
    ui.text(' '),
  );
  const largest = Math.max(totals.routedUsd, totals.yoursUsd);
  if (!narrow && largest > 0) {
    const scale = SAVINGS_BAR / largest;
    const tiers = [...TIERS, 'none'];
    const routedParts = tiers.map((t) => [totals.tierUsd[t] ?? 0, TIER_COLOR[t]]);
    out.push(
      ui.line(ui.dim('  routed      '), ...moneyBar(ui, routedParts, scale), `  ${usd(session.routedUsd)}`),
      ui.line(
        ui.dim('  your model  '),
        ...moneyBar(ui, [[totals.yoursUsd, TIER_COLOR[tier]]], scale),
        `  ${usd(session.yoursUsd)}`,
      ),
    );
  }
  const shares = [...TIERS, 'none'].filter((t) => totals.tiers[t] > 0);
  out.push(
    ui.line(
      '  ',
      ...shares.flatMap((t, i) => [
        t === 'none' ? ui.dim('■ ') : ui.tier(t, '■ '),
        ui.dim(
          `${t === 'none' ? 'not routed' : t} ${percent(totals.tiers[t] / totals.replies)}${i === shares.length - 1 ? ' of replies' : '  '}`,
        ),
      ]),
    ),
  );
  if (session.differenceUsd > 0 && stronger.count && session.strongerUsd >= session.switchUsd) {
    const models = stronger.several ? 'stronger models' : modelName(stronger.model);
    out.push(
      ...dimLines(
        ui,
        `  Routing spent more than ${modelName(view.nativeModel)} alone because upper tiers ran on ${models}.`,
        columns,
      ),
      ...dimLines(ui, '  To spend less, pick cheaper models for those tiers in the Routes tab.', columns),
    );
  }
  return out;
}

// This session against each other priced model as yours, those past "too early", in router.json order:
// "Opus 5.5 saved $6.20 · Haiku 5.5 extra $1.10". Null when there is none.
function otherModels(config, view) {
  const current = modelAlias(config, view.nativeModel);
  const parts = Object.keys(config.models)
    .filter((alias) => alias !== current && modelEntry(view.savingsBy, alias))
    .map((alias) => [modelName(config.models[alias].id), readout(modelEntry(view.savingsBy, alias))])
    .filter(([, r]) => !r.early)
    .map(([name, r]) =>
      r.differenceUsd < 0
        ? `${name} saved ${usd(r.differenceUsd)}`
        : r.differenceUsd > 0
          ? `${name} extra ${usd(r.differenceUsd)}`
          : `${name} same cost`,
    );
  return parts.length ? parts.join(' · ') : null;
}

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

// ROUTING VS YOUR MODEL: what routed replies cost at list prices against the same tokens on the session's own model
// and effort, this session and since the last reset, split into its three parts; then the two costs as bars and the
// replies by tier. Below EARLY_REPLIES replies a column reads "too early"; with routing off or unavailable and no
// routed reply, one sentence says so.
function savingsSection(ui, config, view, columns) {
  const name = yourModel(view);
  const tier = yourTier(config, view);
  const title = [ui.head('ROUTING VS YOUR MODEL'), ui.dim(' · '), tier ? ui.tier(tier, name) : ui.text(name)];
  if (!modelSpec(config, view.nativeModel))
    return [ui.line(...title), ui.dim(`  ${modelName(view.nativeModel)} has no list price in router.json models.`)];
  const totals = view.savings ?? emptyTotals();
  const session = readout(totals);
  const store = readSavingsStore(view.savingsStore);
  let across = store.replies ? readout(store) : null;
  const same = 'Same tokens on your model';
  const unavailable = view.phase === 'unavailable';
  const quiet = (unavailable || view.mode === 'manual') && !session.replies;
  // The label column fits the longest label shown, two spaces before the amounts.
  const labels = [`  ${same}`, ...(quiet || session.early ? [] : SAVINGS_PARTS)];
  const widest = Math.max(...labels.map((text) => text.length)) + 2;
  const titleWidth = 'ROUTING VS YOUR MODEL · '.length + name.length;
  // The last column needs only its widest value, "−$11.42 −22%".
  const table = (label) => label + SAVINGS_COLUMN + (across ? 13 : 0);
  // The column heads share the title's line when it fits; a narrow pane puts them on their own and drops the bars,
  // and a narrower one the saved column too.
  let label = Math.max(titleWidth + 3, widest);
  const narrow = Number.isFinite(columns) && table(label) > columns;
  if (narrow) label = widest;
  if (narrow && table(label) > columns) across = null;
  const heads = [
    ui.cell(SAVINGS_COLUMN, ui.dim('this session')),
    across ? ui.dim(`since ${sinceDate(store.since)}`) : null,
  ];
  const row = (name, mine, saved = null) =>
    ui.line(ui.cell(label, name), ui.cell(SAVINGS_COLUMN, mine), across && saved !== null ? saved : null);
  // The saved column adds up sessions that each had their own model.
  const notes = () => [
    ui.text(' '),
    ...(across
      ? dimLines(ui, `  since ${sinceDate(store.since)}: each session compared with its own model`, columns)
      : []),
    ...footer(ui, columns),
  ];
  const out = narrow
    ? [ui.line(...title), ui.line(ui.cell(label, ''), ...heads)]
    : [ui.line(ui.cell(label, ui.line(...title)), ...heads)];
  if (quiet) {
    out.push(
      ...dimLines(
        ui,
        `  Routing is ${unavailable ? 'unavailable' : 'off'}: every reply this session used your model.`,
        columns,
      ),
      row('  Difference', '$0.00', differenceCell(ui, across)),
    );
    return [...out, ...notes()];
  }
  out.push(
    row('  Routed replies', usd(session.routedUsd), across ? usd(across.routedUsd) : null),
    row(`  ${same}`, usd(session.yoursUsd), across ? usd(across.yoursUsd) : null),
    row(ui.text('  Difference', { bold: true }), differenceCell(ui, session), differenceCell(ui, across)),
  );
  if (session.early) {
    out.push(
      ...dimLines(
        ui,
        `    ${session.replies} routed repl${session.replies === 1 ? 'y' : 'ies'} so far; the session figure appears after ${EARLY_REPLIES}`,
        columns,
      ),
    );
    return [...out, ...notes()];
  }
  const others = otherModels(config, view);
  if (others) out.push(...dimLines(ui, `  vs other models: ${others}`, columns));
  out.push(...savingsDetail(ui, view, { totals, session, across, row, tier, narrow, columns }));
  return [...out, ...notes()];
}

// The answer before the table: "Routing saved $1.84 (22%) this session vs Opus 5.5 · xhigh", or what it cost more.
// None before EARLY_REPLIES routed replies, or while the section says every reply used your model.
function savingsHeadline(ui, config, view) {
  if (!modelSpec(config, view.nativeModel)) return [];
  const session = readout(view.savings ?? emptyTotals());
  if (session.early || !session.replies) return [];
  const tier = yourTier(config, view);
  const name = yourModel(view);
  const share = differenceShare(session)?.replace(/^[−+]/, '');
  const amount = `${usd(session.differenceUsd)}${share ? ` (${share})` : ''}`;
  const verb = session.differenceUsd < 0 ? 'saved' : session.differenceUsd > 0 ? 'cost' : 'cost the same';
  return [
    ui.line(
      `Routing ${verb} `,
      session.differenceUsd === 0 ? '' : ui.text(amount, { bold: true, color: savingsColor(session.differenceUsd) }),
      session.differenceUsd > 0 ? ' more' : '',
      session.differenceUsd > 0 ? ' this session than ' : ' this session vs ',
      tier ? ui.tier(tier, name) : ui.text(name),
    ),
    ui.text(' '),
  ];
}

// Prices summed over the priced requests, and how many were not priced (a model without a price in router.json).
const pricedText = (text, counts) =>
  counts.pricedRequests < counts.requests ? `${text} (${counts.requests - counts.pricedRequests} unpriced)` : text;

// Subagent routing across sessions since the last reset. Per routed type: agents, how many the decision moved off
// core's model, requests per agent and respawns (the retry proxies), and core's cost against the routed one at list
// prices, with core's model estimated. Then the spawns that passed through, by reason, priced on the model they ran on.
function subagentUsage(ui, config, view, columns) {
  const mode = config.subagentRouting;
  const store = readSubagentStore(view.subagentStore);
  const out = [ui.line(ui.head('SUBAGENTS · across sessions'), ui.dim(`   subagent routing ${mode}`))];
  const rows = Object.entries(store.routed.on).filter(([, counts]) => counts.agents > 0);
  const passed = PASS_REASONS.filter((reason) => store.passed[reason]?.agents > 0);
  if (!rows.length && !passed.length)
    return [
      ...out,
      ui.dim(mode === 'off' ? '  Not recorded. Set subagentRouting to on in router.json.' : '  no subagents yet'),
    ];
  if (rows.length) {
    out.push(ui.dim('  core’s model (est.) → routed'));
    for (const [type, c] of rows.sort((a, b) => b[1].agents - a[1].agents)) {
      const cost = pricedText(`${usd(c.coreUsd)} → ${usd(c.routedUsd)}`, c);
      out.push(
        ui.text(
          `  ${type}  ${c.agents} agent${c.agents === 1 ? '' : 's'} · ${c.differs} moved · ${(c.requests / c.agents).toFixed(1)} req/agent · ${c.respawns} respawns · ${cost}`,
        ),
      );
      const choices = Object.entries(c.choices).map(([choice, n]) => `${choice} ${n}`);
      if (c.failures) choices.push(`${c.failures} classifier failures`);
      out.push(...dimLines(ui, `    ${choices.join(' · ')}`, columns));
    }
  }
  if (passed.length) {
    const sum = (field) => passed.reduce((total, reason) => total + store.passed[reason][field], 0);
    const total = { requests: sum('requests'), pricedRequests: sum('pricedRequests') };
    out.push(
      ui.text(`  Not routed  ${passed.map((reason) => `${reason} ${store.passed[reason].agents}`).join(' · ')}`),
      ui.dim(`    ${pricedText(`${usd(sum('usd'))} on the model they ran on`, total)}`),
    );
  }
  return out;
}

// Answer first: routing vs your model, then plan quota, then this session by activity. Claude's own readings fold to
// one line, with the detail and the estimates behind `details`.
function usageTab(ui, config, view, usage, actions, _modelOptions, columns) {
  const metrics = usageMetrics(config, view, usage);
  const history = view.history ?? [];
  const tiers = view.tiers ?? [];
  const glyphs = sparkline(history);
  const quota = (usage?.rateLimits ?? []).filter((limit) => Number.isFinite(limit.percentUsed));
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
  const detail = view.usageDetail
    ? [
        ui.dim(`  context observed ${formatTokens(metrics.observed)} · estimated ${formatTokens(view.contextTokens)}`),
        ui.dim(`  cache read ${formatTokens(view.cacheRead)} · written ${formatTokens(view.cacheWrite)} tokens`),
        ui.dim(`  output ${formatTokens(view.outputTokens)} tokens on the last reply`),
        ui.text(' '),
        ui.head('INPUT PER REPLY · lowest to highest'),
        trend,
        ui.text(' '),
        ui.head('ESTIMATES · configured list prices'),
        ui.text(`Cache hits saved      ${dollars(metrics.cacheBenefit)}`),
        Number.isFinite(view.estimate?.taxUsd)
          ? ui.text(`Switch cost           ${dollars(view.estimate.taxUsd)}`)
          : null,
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
      ]
    : [];
  return [
    ...savingsHeadline(ui, config, view),
    ...savingsSection(ui, config, view, columns),
    ...(quota.length
      ? [
          ui.text(' '),
          ui.head('PLAN QUOTA'),
          ...quota.map((limit) =>
            ui.gauge(`${limit.kind.replaceAll('_', ' ').padEnd(11)}`, bar(limit.percentUsed, 100), 'used'),
          ),
        ]
      : []),
    ui.text(' '),
    ...activityUsage(ui, config, view, columns),
    ui.text(' '),
    ...subagentUsage(ui, config, view, columns),
    ui.text(' '),
    ui.line(
      ui.head('CLAUDE READINGS'),
      `  cost ${dollars(metrics.cost)}`,
      ui.dim(' · '),
      ui.text(`context ${share(metrics.contextBar.percent)}`, { color: metrics.contextBar.color }),
      ui.dim(' · '),
      ui.text(`cache ${share(metrics.cacheBar.percent)}`, { color: metrics.cacheBar.color }),
      '  ',
      ui.Button({
        key: 'usage-detail',
        label: view.usageDetail ? 'less' : 'details',
        variant: view.usageDetail ? 'primary' : 'secondary',
        onPress: actions.usageDetail,
      }),
    ),
    ...detail,
    ui.text(' '),
    ui.line(
      ui.Button({ key: 'reset-stats', label: 'Reset stats', onPress: actions.resetStats }),
      ui.dim('  clears activity stats and routing vs your model, all sessions'),
    ),
    ui.dim('Press ? for what these estimates leave out.'),
  ];
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

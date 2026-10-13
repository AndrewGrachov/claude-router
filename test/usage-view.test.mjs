import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULTS } from '../lib/config.mjs';
import { renderPanel } from '../lib/panel.mjs';
import { recordUsage } from '../lib/usage.mjs';
import { controls, ELEMENTS, screen } from './harness.mjs';
import { at, NOW, OTHER, reply, SESSION, STORE } from './usage-fixtures.mjs';

const LEGACY = {
  version: 1,
  since: 1,
  replies: 400,
  routedUsd: 41.18,
  yoursUsd: 52.6,
  cheaperUsd: -14.9,
  strongerUsd: 0,
  switchUsd: 3.48,
};

const view = (props = {}) => ({
  mode: 'auto',
  phase: 'routed',
  credentials: { jev: null },
  tab: 'usage',
  nativeModel: 'claude-opus-5-5',
  nativeEffort: 'xhigh',
  usageSession: SESSION,
  usageStore: STORE,
  savingsStore: LEGACY,
  usagePeriod: 'session',
  ...props,
});
const recording = () => {
  const calls = [];
  const actions = new Proxy(
    {},
    {
      get:
        (_, name) =>
        (...args) =>
          calls.push([name, ...args]),
    },
  );
  return { calls, actions };
};
const render = (props = {}, { columns = 100, actions = recording().actions } = {}) =>
  renderPanel(ELEMENTS, DEFAULTS, view(props), null, actions, { columns, now: NOW });
const lines = (props, options) => screen(render(props, options));
const after = (all, head, count) => all.slice(all.indexOf(head), all.indexOf(head) + count);

test('the period row offers six periods, marks the one shown, and p presses the next one', () => {
  for (const [period, next] of [
    ['session', 'today'],
    ['today', '7d'],
    ['month', 'all'],
    ['all', 'session'],
  ]) {
    const { calls, actions } = recording();
    const buttons = controls(render({ usagePeriod: period }, { actions })).filter((c) => c.key.startsWith('period-'));
    assert.deepEqual(
      buttons.map((b) => b.label),
      ['Session', 'Today', '7d', '30d', 'Month', 'All'],
    );
    assert.deepEqual(
      buttons.filter((b) => b.variant === 'primary').map((b) => b.key),
      [`period-${period}`],
    );
    assert.deepEqual(
      buttons.filter((b) => b.hotkey).map((b) => [b.key, b.hotkey]),
      [[`period-${next}`, 'p']],
    );
    buttons.find((b) => b.key === `period-${next}`).onPress();
    assert.deepEqual(calls, [['period', next]]);
  }
  assert.equal(lines()[3], '[ Session ] [ Today ] [ 7d ] [ 30d ] [ Month ] [ All ]   p next');
});

test('the scope line says whose replies the period holds and what each is compared with', () => {
  for (const [period, expected] of [
    ['session', 'this session · your model Opus 5.5 · xhigh'],
    ['today', 'all sessions · today, Oct 13 · each session vs its own model'],
    ['7d', 'all sessions · Oct 7 – Oct 13 · each session vs its own model'],
    ['30d', 'all sessions · Sep 14 – Oct 13 · each session vs its own model'],
    ['month', 'all sessions · Oct 1 – Oct 13 · each session vs its own model'],
    ['all', 'all sessions · since Oct 1 · each session vs its own model'],
  ])
    assert.equal(lines({ usagePeriod: period })[4], expected, period);
});

test('the answer leads, then a ledger whose cents add up: your model − cheaper + stronger + switch writes = routed', () => {
  assert.deepEqual(after(lines(), 'Routing saved $4.70 (52%) vs your model', 9), [
    'Routing saved $4.70 (52%) vs your model',
    '',
    '    Your model              $9.00   Opus 5.5 · xhigh',
    '  − Cheaper models          $4.92',
    '  + Stronger models         $0.00',
    '  + Switch cache writes     $0.22   4 route switches · 4% of the saving',
    '  = Routed                  $4.30   ███████████░░░░░░░░░░░ 48% of your model',
    '',
    '  20 replies · 10 turns · input 22.0K · cache hit 73% · output 200',
  ]);
  assert.equal(
    lines({}, { columns: 72 }).find((line) => line.includes('= Routed')),
    '  = Routed                  $4.30',
  );
});

test('a period sums every session’s days in it, and All adds the undated totals with a note', () => {
  const week = lines({ usagePeriod: '7d' });
  assert.ok(week.includes('Routing saved $4.90 (52%) vs your model'), week.join('\n'));
  assert.ok(week.includes('    Your model              $9.50   each session’s own model'));
  const all = lines({ usagePeriod: 'all' });
  assert.ok(all.includes('Routing saved $16.52 (26%) vs your model'), all.join('\n'));
  assert.ok(all.includes('    includes $41.18 routed before dated records, kept without a breakdown'));
  assert.ok(!lines({ usagePeriod: 'month' }).some((line) => line.includes('before dated records')));
  assert.match(
    all.find((line) => line.includes('Switch cache writes')),
    /\$\d+\.\d\d {3}\d+% of the saving$/,
    'the undated totals kept no switch count',
  );
});

test('after /model selects another model, the session still names the model its replies were priced against', () => {
  const all = lines({ nativeModel: 'claude-sonnet-5-5', mode: 'manual' });
  assert.equal(all[4], 'this session · your model Opus 5.5');
  assert.ok(all.some((line) => line.startsWith('    Your model') && line.endsWith('Opus 5.5')));
});

test('a models key that names another model later keeps the history under the model that ran', () => {
  const config = {
    ...DEFAULTS,
    models: { ...DEFAULTS.models, opus: { ...DEFAULTS.models.opus, id: 'claude-fable-5-1' } },
  };
  const all = screen(
    renderPanel(ELEMENTS, config, view({ usageGroup: 'model' }), null, recording().actions, { columns: 100, now: NOW }),
  );
  assert.ok(
    all.some((line) => line.includes('▸ Opus 5.5')),
    all.join('\n'),
  );
  assert.ok(!all.some((line) => line.includes('Fable')));
});

test('a session whose /model changed names every model its replies were priced against', () => {
  const sonnet = { ...reply(at(2026, 10, 13, 14), 'explore'), yours: 'claude-sonnet-5-5' };
  const changed = recordUsage(SESSION, [sonnet], { now: at(2026, 10, 13, 14) });
  const all = lines({ usageSession: changed });
  assert.equal(all[4], 'this session · each reply vs the model /model selected: Opus 5.5, Sonnet 5.5');
  assert.ok(all.some((line) => line.startsWith('    Your model') && line.endsWith('Opus 5.5, Sonnet 5.5')));
});

test('without routed replies the tab says why, and below ten replies the answer is marked early', () => {
  for (const [props, expected] of [
    [{ usagePeriod: 'today', usageStore: OTHER }, 'No routed replies today.'],
    [{ usageSession: null }, 'No routed replies this session.'],
    [{ usageSession: null, mode: 'manual' }, 'Routing is off: replies use your model and are not counted.'],
    [
      { usageSession: null, phase: 'unavailable' },
      'Routing is unavailable: replies use your model and are not counted.',
    ],
    [{ usageSession: null, nativeModel: 'claude-mythos-1' }, 'Mythos-1 has no list price in router.json models.'],
  ]) {
    const shown = lines(props);
    assert.equal(shown[shown.indexOf('', 4) + 1], expected, expected);
    assert.ok(!shown.some((line) => line.startsWith('BY ')), expected);
  }
  assert.ok(
    lines({ usagePeriod: '30d', usageStore: OTHER }).includes(
      'Routing saved $0.40 (40%) vs your model   early sample · 2 replies',
    ),
  );
});

test('the breakdown groups by activity, model or tier, g presses the next grouping, and a row opens to its parts', () => {
  const { calls, actions } = recording();
  const tree = render({ usageOpen: 'activity:code' }, { actions });
  const groups = controls(tree).filter((c) => c.key.startsWith('group-'));
  assert.deepEqual(
    groups.map((g) => [g.label, g.variant, g.hotkey ?? null]),
    [
      ['Activity', 'primary', null],
      ['Model', 'secondary', 'g'],
      ['Tier', 'secondary', null],
    ],
  );
  assert.deepEqual(after(screen(tree), '                         replies      cost   vs yours   mostly on', 6), [
    '                         replies      cost   vs yours   mostly on',
    '  ▾ coding                    10     $3.80     −$1.20   Sonnet 5.5 · high',
    '      Opus 5.5 · xhigh         4     $2.00      $0.00',
    '      Sonnet 5.5 · high        6     $1.80     −$1.20',
    '      cheaper −$1.32 · stronger $0.00 · switch +$0.12 · input 11.0K · output 100',
    '  ▸ exploring                 10     $0.50     −$3.50   Haiku 5.5 · high',
  ]);
  controls(tree)
    .find((c) => c.key === 'row-activity:explore')
    .onPress();
  controls(tree)
    .find((c) => c.key === 'row-activity:code')
    .onPress();
  groups[1].onPress();
  assert.deepEqual(calls, [
    ['usageOpen', 'activity:explore'],
    ['usageOpen', null],
    ['usageGroup', 'model'],
  ]);
  const byModel = lines({ usageGroup: 'model' });
  assert.deepEqual(after(byModel, '                         replies      cost   vs yours   share', 4).slice(1), [
    '  ▸ Opus 5.5                   4     $2.00      $0.00   47%',
    '  ▸ Sonnet 5.5                 6     $1.80     −$1.20   42%',
    '  ▸ Haiku 5.5                 10     $0.50     −$3.50   12%',
  ]);
  const narrow = lines({ usageGroup: 'tier' }, { columns: 72 });
  assert.deepEqual(after(narrow, '                         replies      cost   vs yours', 2), [
    '                         replies      cost   vs yours',
    '  ▸ high                       4     $2.00      $0.00',
  ]);
});

test('c switches the trend for What if: the same tokens on each model alone, against yours', () => {
  const { calls, actions } = recording();
  const trend = render({}, { actions });
  assert.ok(screen(trend).includes('COST BY HOUR █▁▂█  peak $2.00   [ What if ]'), screen(trend).join('\n'));
  const toggle = controls(trend).find((c) => c.key === 'usage-compare');
  assert.equal(toggle.hotkey, 'c');
  toggle.onPress();
  assert.deepEqual(calls, [['usageCompare']]);
  const shown = lines({ usageCompare: true });
  assert.deepEqual(after(shown, 'WHAT IF · the same tokens on one model   [ Trend ]', 6), [
    'WHAT IF · the same tokens on one model   [ Trend ]',
    '  Haiku 5.5             ████                      $1.80     −$7.20',
    '  Routed                ███████████               $4.30',
    '  Sonnet 5.5            █████████████             $5.40     −$3.60',
    '  Opus 5.5 · yours      ██████████████████████    $9.00          —',
    '  same tokens and output on each model alone · answer quality not measured',
  ]);
  assert.ok(!shown.some((line) => line.startsWith('COST BY')));
});

test('what is worth a look links to the tab that changes it, and never names a model to use', () => {
  const { calls, actions } = recording();
  const tree = render({}, { actions });
  assert.deepEqual(after(screen(tree), 'WORTH A LOOK · from the numbers; answer quality is not measured', 2), [
    'WORTH A LOOK · from the numbers; answer quality is not measured',
    '  coding · high carried 47% of the cost · mostly Opus 5.5 · xhigh  [ Routes ]',
  ]);
  controls(tree)
    .find((c) => c.key === 'insight-cost')
    .onPress();
  assert.deepEqual(calls, [['openRoute', 'code.high']]);
  // Switch writes past 15% of the saving link to Policy, where the payback horizon is.
  const costly = recordUsage(SESSION, [reply(at(2026, 10, 13, 14), 'hard')], { now: NOW, switched: 'tier' });
  const heavy = { ...costly, days: structuredClone(costly.days) };
  for (const sums of Object.values(heavy.days['2026-10-13'].cells)) {
    sums[1] += 0.3;
    sums[5] += 0.3;
  }
  const switched = render({ usageSession: heavy }, { actions });
  assert.ok(
    screen(switched).includes('  Switch cache writes used 23% of the cheaper-model saving  [ Policy ]'),
    screen(switched).join('\n'),
  );
  controls(switched)
    .find((c) => c.key === 'insight-switch')
    .onPress();
  assert.deepEqual(calls.at(-1), ['tab', 'policy']);
  assert.ok(!lines({ usageSession: OTHER }).some((line) => line.startsWith('WORTH A LOOK')));
});

test('Delete history asks once more before every session’s records go', () => {
  const { calls, actions } = recording();
  const ask = controls(render({}, { actions })).find((c) => c.key === 'delete-history');
  assert.deepEqual([ask.label, ask.dimColor], ['Delete history', true]);
  ask.onPress();
  const confirm = render({ confirmDelete: true }, { actions });
  assert.ok(
    screen(confirm).includes('Delete the usage, activity and subagent history of every session?  [ Delete ] [ Keep ]'),
  );
  controls(confirm)
    .find((c) => c.key === 'delete-keep')
    .onPress();
  controls(confirm)
    .find((c) => c.key === 'delete-confirm')
    .onPress();
  assert.deepEqual(calls, [['confirmDelete', true], ['confirmDelete', false], ['resetStats']]);
});

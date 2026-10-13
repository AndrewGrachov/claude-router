import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULTS } from '../lib/config.mjs';
import { renderPanel } from '../lib/panel.mjs';
import { emptyUsage, INSIGHT_REPLIES, mergeUsage, recordUsage } from '../lib/usage.mjs';
import { controls, ELEMENTS, screen } from './harness.mjs';
import { at, NOW, OTHER, reply, SESSION, STORE } from './usage-fixtures.mjs';

const view = (props = {}) => ({
  mode: 'auto',
  phase: 'routed',
  credentials: { jev: null },
  tab: 'now',
  tier: 'high',
  selectedModel: 'claude-opus-5-5',
  effort: 'xhigh',
  nativeModel: 'claude-opus-5-5',
  usageSession: SESSION,
  usageStore: STORE,
  strip: { per: 1, cells: [{ low: 2 }, { medium: 1 }, { high: 1, low: 1 }, { none: 1 }] },
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
// Another session today: one code reply at 14:00, so today holds more than this session.
const BUSY_DAY = mergeUsage([SESSION, recordUsage(emptyUsage(), [reply(at(2026, 10, 13, 14), 'code')], { now: NOW })]);

test('one pin row names each tier with its support, marks the current tier and the pending pin, and pins on press', () => {
  const { calls, actions } = recording();
  const probabilities = { high: 0.88, medium: 0.07, low: 0.03 };
  const tree = render({ probabilities, pendingPin: 'medium' }, { actions });
  assert.ok(
    screen(tree).includes('Pin next   [ ▶ high 88% ] [ medium 7% ] [ low 3% ] [ micro — ]  next turn only'),
    screen(tree).join('\n'),
  );
  const pins = controls(tree).filter((c) => c.key.startsWith('pin-'));
  assert.deepEqual(
    pins.map((c) => [c.key, c.variant]),
    [
      ['pin-high', 'secondary'],
      ['pin-medium', 'primary'],
      ['pin-low', 'secondary'],
      ['pin-micro', 'secondary'],
    ],
  );
  pins[3].onPress();
  assert.deepEqual(calls, [['pin', 'micro']]);
  assert.ok(
    lines({ probabilities }, { columns: 70 }).includes(
      'Pin next   [ ▶ high 88% ] [ medium 7% ] [ low 3% ] [ micro — ]',
    ),
  );
});

test('the session shows since when, its replies and switches, the strip, the replies per tier and activity, and the verdict', () => {
  assert.deepEqual(after(lines({}), 'SESSION · since 09:00 · 20 routed replies · 4 route switches', 6), [
    'SESSION · since 09:00 · 20 routed replies · 4 route switches',
    '  ███·',
    '  ■ low 3  ■ medium 1  ■ high 1  · not routed 1',
    '  coding 10 · exploring 10',
    '  Routing saved $4.70 (52%) vs your model · switch writes $0.22  [ Usage ]',
    '',
  ]);
});

test('a strip cell shows the tier with most replies, the stronger one on a tie, and a dot where routing served most', () => {
  const strip = { per: 2, cells: [{ low: 1, high: 1 }, { micro: 2 }, { none: 1, low: 1 }, { none: 2 }] };
  assert.ok(lines({ strip }).includes('  ███·  2 replies per cell'));
  // Cells that are mostly unrouted still count every routed reply under its tier.
  assert.ok(lines({ strip }).includes('  ■ micro 2  ■ low 2  ■ high 1  · not routed 3'));
});

test('a strip that started after the session’s first reply, as after a restart, says since when', () => {
  const strip = { per: 1, cells: [{ low: 2 }, { high: 1 }], from: at(2026, 10, 13, 15) };
  assert.ok(lines({ strip }).includes('  ██  since 15:00'));
  assert.ok(lines({ strip: { ...strip, from: at(2026, 10, 13, 8) } }).includes('  ██'));
});

test('a narrow pane merges strip cells in pairs until the strip fits', () => {
  const strip = { per: 1, cells: Array.from({ length: 48 }, () => ({ low: 1 })) };
  for (const [columns, cells, note] of [
    [100, 48, ''],
    [52, 48, ''],
    [40, 12, '  4 replies per cell'],
    [30, 6, '  8 replies per cell'],
  ])
    assert.ok(lines({ strip }, { columns }).includes(`  ${'█'.repeat(cells)}${note}`), `${columns} columns`);
});

test('the last switch says when and between which tiers, or between routes when the tier stayed', () => {
  const switched = (from, to, activity, when = at(2026, 10, 13, 15) + 41 * 60_000) => ({
    lastSwitch: { at: when, from, to, activity },
  });
  const sonnet = { tier: 'low', model: 'claude-sonnet-5-5', effort: 'high' };
  const haiku = { tier: 'low', model: 'claude-haiku-5-5', effort: 'high' };
  for (const [props, expected] of [
    [
      switched({ ...sonnet, tier: 'medium' }, { tier: 'high', model: 'claude-opus-5-5', effort: 'xhigh' }, 'code'),
      '  last switch 15:41  medium → high · coding',
    ],
    [switched(sonnet, haiku, 'ops'), '  last switch 15:41  Sonnet 5.5 · high → Haiku 5.5 · high · running'],
    [
      switched(haiku, { ...sonnet, tier: 'medium' }, null, at(2026, 10, 12, 23)),
      '  last switch Oct 12 23:00  low → medium',
    ],
  ])
    assert.ok(lines(props).includes(expected), expected);
  assert.ok(!lines({}).some((line) => line.includes('last switch')));
});

test('today shows once another session added to it, and each Usage link opens its own period', () => {
  assert.ok(!lines({}).some((line) => line.startsWith('TODAY')), 'today is this session');
  // This session before and after midnight: today holds only its own replies, so it still repeats the session.
  const midnight = recordUsage(SESSION, [reply(at(2026, 10, 12, 23), 'code')], { now: at(2026, 10, 12, 23) });
  assert.ok(!lines({ usageSession: midnight, usageStore: mergeUsage([midnight]) }).some((l) => l.startsWith('TODAY')));
  // Another session today, and this session's yesterday adding as many replies: today still differs.
  const other = recordUsage(emptyUsage(), [reply(at(2026, 10, 13, 14), 'code')], { now: NOW });
  assert.ok(
    lines({ usageSession: midnight, usageStore: mergeUsage([midnight, other]) }).some((l) => l.startsWith('TODAY')),
  );
  const { calls, actions } = recording();
  const tree = render({ usageStore: BUSY_DAY }, { actions });
  assert.deepEqual(after(screen(tree), 'TODAY · 21 routed replies · 4 route switches', 2), [
    'TODAY · 21 routed replies · 4 route switches',
    '  Routing saved $4.90 (52%) vs your model · switch writes $0.24  [ Usage ]',
  ]);
  for (const key of ['usage-session', 'usage-today'])
    controls(tree)
      .find((c) => c.key === key)
      .onPress();
  assert.deepEqual(calls, [
    ['usageFor', 'session'],
    ['usageFor', 'today'],
  ]);
});

test('worth a look shows today’s first finding with its link, and nothing below the sample size', () => {
  const { calls, actions } = recording();
  const tree = render({}, { actions });
  assert.deepEqual(after(screen(tree), 'WORTH A LOOK · today', 2), [
    'WORTH A LOOK · today',
    '  coding · high carried 47% of the cost · mostly Opus 5.5 · xhigh  [ Routes ]',
  ]);
  controls(tree)
    .find((c) => c.key === 'insight-cost')
    .onPress();
  assert.deepEqual(calls, [['openRoute', 'code.high']]);
  const few = Array.from({ length: INSIGHT_REPLIES - 1 }, (_, i) => (i % 2 ? 'hard' : 'explore')).reduce(
    (record, kind) => recordUsage(record, [reply(at(2026, 10, 13, 10), kind)], { now: NOW }),
    emptyUsage(),
  );
  for (const usageStore of [few, OTHER])
    assert.ok(!lines({ usageStore }).some((line) => line.startsWith('WORTH A LOOK')));
});

test('a session without replies says so, and one with replies but no usage record shows the strip alone', () => {
  const empty = lines({ usageSession: null, usageStore: null, strip: null });
  assert.ok(empty.includes('SESSION · no replies yet'));
  assert.ok(!empty.some((line) => line.startsWith('TODAY') || line.startsWith('WORTH A LOOK')));
  const unpriced = lines({ usageSession: null, usageStore: null });
  assert.deepEqual(after(unpriced, 'SESSION · 6 replies', 3), [
    'SESSION · 6 replies',
    '  ███·',
    '  ■ low 3  ■ medium 1  ■ high 1  · not routed 1',
  ]);
  assert.ok(!unpriced.some((line) => line.startsWith('  Routing saved')));
});

test('a narrow pane drops the early-sample note first, then the switch writes, and keeps the verdict and its link', () => {
  const early = recordUsage(emptyUsage(), [reply(at(2026, 10, 13, 10), 'code')], { now: NOW });
  for (const [columns, expected] of [
    [100, '  Routing saved $0.20 (40%) vs your model · switch writes $0.02 · early sample  [ Usage ]'],
    [88, '  Routing saved $0.20 (40%) vs your model · switch writes $0.02  [ Usage ]'],
    [60, '  Routing saved $0.20 (40%) vs your model  [ Usage ]'],
  ])
    assert.ok(lines({ usageSession: early }, { columns }).includes(expected), `${columns} columns`);
});

test('the activities that do not fit the pane are counted, the most used shown first', () => {
  const kinds = ['code', 'code', 'explore', 'code', 'hard'];
  const mixed = kinds.reduce(
    (record, kind) => recordUsage(record, [reply(at(2026, 10, 13, 10), kind)], { now: NOW }),
    emptyUsage(),
  );
  assert.ok(lines({ usageSession: mixed }).includes('  coding 4 · exploring 1'));
  assert.ok(lines({ usageSession: mixed }, { columns: 20 }).includes('  coding 4 · +1 more'));
});

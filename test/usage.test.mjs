import assert from 'node:assert/strict';
import test from 'node:test';
import {
  allTime,
  breakdown,
  dayKey,
  daysBefore,
  emptyUsage,
  INSIGHT_REPLIES,
  insights,
  mergeUsage,
  periodRange,
  prunedUsage,
  RETAIN_DAYS,
  readUsage,
  recordUsage,
  replyEntry,
  summarize,
  trend,
} from '../lib/usage.mjs';

const at = (y, m, d, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const NOW = at(2026, 10, 13, 16);
const ALL = { from: null, to: null };
const USAGE = { input_tokens: 100, cache_read_input_tokens: 800, cache_creation_input_tokens: 200, output_tokens: 10 };
const PRICES = { routedUsd: 0.02, yoursUsd: 0.05, cheaperUsd: -0.035, strongerUsd: 0, switchUsd: 0.005 };

// One routed reply at `when`, priced against Opus as yours.
const entry = (when, { activity = 'code', tier = 'low', route = 'haiku@high', reply = PRICES } = {}) =>
  replyEntry({
    at: when,
    activity,
    tier,
    route,
    yours: 'opus',
    reply,
    replies: { haiku: { yoursUsd: 0.01 }, opus: { yoursUsd: reply.yoursUsd } },
    usage: USAGE,
  });
const turnOf = (record, entries, now, switched = null) => recordUsage(record, entries, { switched, now });

test('a day is the local calendar day, counted back by the calendar across month ends', () => {
  assert.equal(dayKey(at(2026, 10, 13, 0, 0)), '2026-10-13');
  assert.equal(dayKey(at(2026, 10, 12, 23, 59)), '2026-10-12');
  assert.equal(daysBefore(at(2026, 3, 2), 2), '2026-02-28');
  assert.equal(daysBefore(at(2026, 1, 1), 1), '2025-12-31');
});

test('days count by the calendar across daylight saving changes, at midnight too', (t) => {
  const tz = process.env.TZ;
  t.after(() => {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  });
  for (const [zone, [y, m, d, h], days, expected] of [
    ['America/New_York', [2026, 11, 3, 12], 6, '2026-10-28'],
    ['America/New_York', [2026, 3, 9, 0], 2, '2026-03-07'],
    ['America/Santiago', [2026, 9, 7, 0], 1, '2026-09-06'],
    ['America/Santiago', [2026, 9, 6, 12], 1, '2026-09-05'],
  ]) {
    process.env.TZ = zone;
    assert.equal(daysBefore(at(y, m, d, h), days), expected, `${zone} ${m}/${d}`);
  }
  process.env.TZ = 'America/Santiago';
  assert.equal(dayKey(at(2026, 9, 6, 0, 30)), '2026-09-06');
  process.env.TZ = 'America/New_York';
  const fallBack = trend(
    summarize(turnOf(emptyUsage(), [entry(at(2026, 10, 29))], at(2026, 10, 29)), ALL),
    '7d',
    at(2026, 11, 3),
  );
  assert.equal(fallBack.values.length, 7);
});

test('each period covers its calendar days, both ends included', () => {
  for (const [period, expected] of [
    ['today', { from: '2026-10-13', to: '2026-10-13' }],
    ['7d', { from: '2026-10-07', to: '2026-10-13' }],
    ['30d', { from: '2026-09-14', to: '2026-10-13' }],
    ['month', { from: '2026-10-01', to: '2026-10-13' }],
    ['all', ALL],
    ['session', ALL],
  ])
    assert.deepEqual(periodRange(period, NOW), expected, period);
});

test('a turn adds each reply on the day and hour it arrived, and itself and its switch on the day it ended', () => {
  const late = at(2026, 10, 12, 23, 59);
  const record = turnOf(
    emptyUsage(),
    [entry(late), entry(at(2026, 10, 13, 0, 1), { tier: 'high', route: 'opus@xhigh' })],
    at(2026, 10, 13, 0, 2),
    'tier',
  );
  assert.equal(record.since, at(2026, 10, 13, 0, 2));
  const [before, after] = [record.days['2026-10-12'], record.days['2026-10-13']];
  assert.deepEqual(before.cells, { 'code|low|haiku@high': [1, 0.02, 0.05, -0.035, 0, 0.005, 1100, 800, 10] });
  assert.deepEqual([before.hours, before.turns, before.switches], [{ 23: 0.02 }, 0, { tier: 0, activity: 0 }]);
  assert.deepEqual(Object.keys(after.cells), ['code|high|opus@xhigh']);
  assert.deepEqual([after.hours, after.turns, after.switches], [{ 0: 0.02 }, 1, { tier: 1, activity: 0 }]);
  assert.deepEqual(after.whatIf, { haiku: [1, 0.01], opus: [1, 0.05] });
  assert.deepEqual(after.yours, { opus: 1 });
  const again = turnOf(record, [entry(at(2026, 10, 13, 1))], at(2026, 10, 13, 1, 1), 'activity');
  assert.deepEqual(again.days['2026-10-13'].cells['code|low|haiku@high'][0], 1);
  assert.deepEqual(again.days['2026-10-13'].switches, { tier: 1, activity: 1 });
  assert.equal(again.since, record.since);
});

test('a turn without replies adds nothing, and days past the kept window leave the record', () => {
  const record = turnOf(emptyUsage(), [entry(at(2025, 1, 2))], at(2025, 1, 2));
  assert.equal(turnOf(record, [], NOW), record);
  const later = turnOf(record, [entry(NOW)], NOW);
  assert.deepEqual(Object.keys(later.days), ['2026-10-13']);
  assert.ok(RETAIN_DAYS > 365);
});

test('a stored record reads day by day: a bad day is dropped and the others stay; an unknown record is empty', () => {
  const good = turnOf(emptyUsage(), [entry(NOW)], NOW);
  const bad = { ...good.days['2026-10-13'], cells: { 'code|low': [1] } };
  assert.deepEqual(
    readUsage({ ...good, days: { ...good.days, '2026-10-12': bad, 'last week': good.days['2026-10-13'] } }),
    good,
  );
  for (const value of [
    null,
    'text',
    { version: 2, since: 1, days: {} },
    { version: 1, since: 'then', days: {} },
    { version: 1, since: 1 },
  ])
    assert.deepEqual(readUsage(value), emptyUsage(), JSON.stringify(value));
});

test('a model id holding | or @ keeps its day and groups under its whole id', () => {
  const record = readUsage(turnOf(emptyUsage(), [entry(NOW, { route: 'acme|fast@v2@high' })], NOW));
  const { cells } = summarize(record, ALL);
  assert.deepEqual(Object.keys(record.days), ['2026-10-13']);
  assert.deepEqual(
    breakdown(cells, 'model').map((group) => group.name),
    ['acme|fast@v2'],
  );
  assert.deepEqual(
    breakdown(cells, 'activity')[0].children.map((child) => child.name),
    ['acme|fast@v2@high'],
  );
});

test('a models key named after an Object method is counted like any other', () => {
  const odd = { ...entry(NOW), whatIf: { toString: 0.01, constructor: 0.02 }, yours: 'toString' };
  const once = turnOf(emptyUsage(), [odd], NOW);
  const twice = mergeUsage([once, turnOf(emptyUsage(), [odd], NOW)]);
  assert.deepEqual(once.days['2026-10-13'].whatIf.toString, [1, 0.01]);
  assert.deepEqual(twice.days['2026-10-13'].whatIf.constructor, [2, 0.04]);
  assert.equal(twice.days['2026-10-13'].yours.toString, 2);
});

test('a model id __proto__ is kept as its own entry, never as the prototype', () => {
  const odd = { ...entry(NOW), whatIf: JSON.parse('{"__proto__": 0.01}'), yours: '__proto__' };
  const day = mergeUsage([turnOf(emptyUsage(), [odd], NOW)]).days['2026-10-13'];
  assert.ok(Object.hasOwn(day.whatIf, '__proto__'));
  assert.deepEqual(Object.entries(day.whatIf), [['__proto__', [1, 0.01]]]);
  assert.deepEqual(Object.entries(day.yours), [['__proto__', 1]]);
});

test('a day with a negative count or cost does not read, apart from the cheaper part', () => {
  const record = turnOf(emptyUsage(), [entry(NOW)], NOW);
  const withCell = (sums) => ({
    ...record,
    days: { '2026-10-13': { ...record.days['2026-10-13'], cells: { 'code|low|haiku@high': sums } } },
  });
  assert.deepEqual(Object.keys(readUsage(withCell([1, 0.02, 0.05, -0.035, 0, 0.005, 1100, 800, 10])).days), [
    '2026-10-13',
  ]);
  assert.deepEqual(readUsage(withCell([1, -1, 1, -2, 0, 0, 0, 0, 0])).days, {});
  assert.deepEqual(readUsage(withCell([1, 0.02, 0.05, 0.1, 0, 0, 1100, 800, 10])).days, {});
});

test('records add up day by day, and one from before the last reset reads as empty', () => {
  const a = turnOf(emptyUsage(), [entry(NOW), entry(NOW)], NOW);
  const b = turnOf(emptyUsage(), [entry(at(2026, 10, 12))], at(2026, 10, 12));
  const merged = mergeUsage([a, b, 'garbage']);
  assert.deepEqual([merged.since, Object.keys(merged.days).sort()], [b.since, ['2026-10-12', '2026-10-13']]);
  assert.equal(merged.days['2026-10-13'].cells['code|low|haiku@high'][0], 2);
  assert.deepEqual(Object.keys(mergeUsage([a, b], at(2026, 10, 13, 0)).days), ['2026-10-13']);
});

test('a record with no day in the kept window goes, then the oldest past the cap; one that does not read whole stays', () => {
  const old = turnOf(emptyUsage(), [entry(at(2025, 1, 2))], at(2025, 1, 2));
  const unreadDay = { ...old, days: { '2025-01-02': { ...old.days['2025-01-02'], switches: { tier: 0 } } } };
  const on = (y, m, d) => turnOf(emptyUsage(), [entry(at(y, m, d))], at(y, m, d));
  const kept = [
    ['old', old],
    ['current', turnOf(old, [entry(NOW)], NOW)],
    ['later', { version: 9 }],
    ['unread', unreadDay],
  ];
  assert.deepEqual([...prunedUsage(kept, NOW)], ['old']);
  const many = [
    ['oct', on(2026, 10, 12)],
    ['aug', on(2026, 8, 1)],
    ['later', { version: 9 }],
    ['sep', on(2026, 9, 1)],
  ];
  assert.deepEqual([...prunedUsage(many, NOW, 2)].sort(), ['aug', 'sep']);
  assert.deepEqual([...prunedUsage(many, NOW, 4)], []);
});

test('a summary adds the days in its range: the readout sums, tokens, turns, switches and what-if', () => {
  let record = turnOf(emptyUsage(), [entry(at(2026, 10, 1))], at(2026, 10, 1), 'tier');
  record = turnOf(record, [entry(NOW), entry(NOW, { tier: 'high', route: 'opus@xhigh' })], NOW, 'activity');
  const today = summarize(record, periodRange('today', NOW));
  assert.deepEqual(
    [today.replies, today.turns, today.inputTokens, today.cacheReadTokens, today.outputTokens, today.switches],
    [2, 1, 2200, 1600, 20, { tier: 0, activity: 1 }],
  );
  assert.ok(Math.abs(today.routedUsd - 0.04) < 1e-9 && Math.abs(today.cheaperUsd + 0.07) < 1e-9);
  assert.deepEqual(today.whatIf, { haiku: [2, 0.02], opus: [2, 0.1] });
  const all = summarize(record, ALL);
  assert.deepEqual([all.replies, all.turns, all.days.map(([key]) => key)], [3, 2, ['2026-10-01', '2026-10-13']]);
});

test('a breakdown groups the cells by activity, model or tier, costliest first, each with what it holds', () => {
  const sums = (replies, routed, yours) => [replies, routed, yours, 0, 0, 0, 0, 0, 0];
  const cells = {
    'code|medium|sonnet@high': sums(3, 0.3, 0.5),
    'code|high|opus@xhigh': sums(1, 0.4, 0.4),
    'explore|low|haiku@high': sums(5, 0.1, 0.5),
    'none|low|haiku@medium': sums(2, 0.05, 0.2),
  };
  const byActivity = breakdown(cells, 'activity');
  assert.deepEqual(
    byActivity.map((g) => [g.name, g.sums[0], g.children.map((c) => c.name)]),
    [
      ['code', 4, ['opus@xhigh', 'sonnet@high']],
      ['explore', 5, ['haiku@high']],
      ['none', 2, ['haiku@medium']],
    ],
  );
  assert.deepEqual(
    breakdown(cells, 'model').map((g) => [g.name, g.children.map((c) => c.name)]),
    [
      ['opus', ['code']],
      ['sonnet', ['code']],
      ['haiku', ['explore', 'none']],
    ],
  );
  assert.deepEqual(
    breakdown(cells, 'tier').map((g) => g.name),
    ['high', 'medium', 'low'],
  );
  assert.deepEqual(breakdown({}, 'tier'), []);
});

test('the trend is per hour today, per day with zero for a quiet day, and per week past 45 days', () => {
  let record = turnOf(emptyUsage(), [entry(at(2026, 10, 13, 9)), entry(at(2026, 10, 13, 11))], NOW);
  record = turnOf(record, [entry(at(2026, 10, 10))], at(2026, 10, 10));
  const hours = trend(summarize(record, periodRange('today', NOW)), 'today', NOW);
  assert.deepEqual(hours, { unit: 'hour', values: [0.02, 0, 0.02], from: 9 });
  const days = trend(summarize(record, periodRange('7d', NOW)), '7d', NOW);
  assert.deepEqual(days, { unit: 'day', values: [0, 0, 0, 0.02, 0, 0, 0.04], from: '2026-10-07' });
  record = turnOf(record, [entry(at(2026, 8, 1))], at(2026, 8, 1));
  const weeks = trend(summarize(record, ALL), 'all', NOW);
  assert.equal(weeks.unit, 'week');
  assert.equal(weeks.values.length, Math.ceil(74 / 7));
  assert.ok(Math.abs(weeks.values.reduce((s, v) => s + v, 0) - 0.08) < 1e-9);
  assert.deepEqual(trend(summarize(emptyUsage(), ALL), 'all', NOW).values, []);
});

test('insights report the costly cell, switch writes against the saving, and replies above your model; none early', () => {
  const sums = (replies, routed, yours, cheaper, stronger, switched) => [
    replies,
    routed,
    yours,
    cheaper,
    stronger,
    switched,
    0,
    0,
    0,
  ];
  const summary = (cells) => {
    const total = Object.values(cells).reduce((a, b) => a.map((v, i) => v + b[i]));
    return { replies: total[0], routedUsd: total[1], cheaperUsd: total[3], switchUsd: total[5], cells };
  };
  const busy = summary({
    'code|high|opus@xhigh': sums(10, 3, 2, 0, 1, 0),
    'explore|low|haiku@high': sums(15, 1, 3, -2.5, 0, 0.5),
  });
  assert.deepEqual(insights(busy), [
    { kind: 'cost', activity: 'code', tier: 'high', share: 0.75, route: 'opus@xhigh' },
    { kind: 'switch', share: 0.2, usd: 0.5 },
    { kind: 'stronger', activity: 'code', tier: 'high', usd: 1, route: 'opus@xhigh' },
  ]);
  const quiet = summary({
    'code|low|haiku@high': sums(INSIGHT_REPLIES, 1, 2, -1, 0, 0.1),
    'code|medium|sonnet@high': sums(1, 1, 1, 0, 0, 0),
  });
  assert.deepEqual(insights(quiet), [{ kind: 'cost', activity: 'code', tier: 'low', share: 0.5, route: 'haiku@high' }]);
  assert.deepEqual(insights(summary({ 'code|high|opus@xhigh': sums(INSIGHT_REPLIES - 1, 3, 2, 0, 1, 0) })), []);
});

test('all time adds the usage records and the undated savings totals, since the earlier of the two', () => {
  const record = turnOf(emptyUsage(), [entry(NOW)], NOW);
  const legacy = {
    version: 1,
    since: 5,
    replies: 4,
    routedUsd: 1,
    yoursUsd: 2,
    cheaperUsd: -1,
    strongerUsd: 0,
    switchUsd: 0,
  };
  const { totals, since } = allTime(record, legacy);
  assert.equal(since, 5);
  assert.equal(totals.replies, 5);
  assert.ok(Math.abs(totals.routedUsd - 1.02) < 1e-9 && Math.abs(totals.cheaperUsd + 1.035) < 1e-9);
  assert.deepEqual(allTime(null, null).totals.replies, 0);
});

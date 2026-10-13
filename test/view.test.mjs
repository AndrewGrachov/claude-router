import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addToStrip,
  CLEARED_READINGS,
  continuationView,
  HISTORY,
  initialView,
  mergePairs,
  responseMetrics,
  STRIP_CELLS,
  switchView,
} from '../lib/view.mjs';

const usage = (input, read, write) => ({
  model: 'claude-haiku-4-5',
  input_tokens: input,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: write,
  output_tokens: 7,
});

test('responseMetrics sums the input counters and appends the reading with its tier', () => {
  const view = {
    ...initialView('claude-sonnet-5-5'),
    history: [10],
    tiers: ['low'],
    strip: { per: 1, cells: [{ low: 1 }], from: 3 },
  };
  assert.deepEqual(responseMetrics(view, { usage: usage(1, 2, 3) }, 'micro', 9), {
    actualModel: 'claude-haiku-4-5',
    cacheRead: 2,
    cacheWrite: 3,
    inputTokens: 6,
    outputTokens: 7,
    history: [10, 6],
    tiers: ['low', 'micro'],
    strip: { per: 1, cells: [{ low: 1 }, { micro: 1 }], from: 3 },
  });
});

test('responseMetrics keeps the trend when a counter is missing', () => {
  for (const [name, response] of [
    ['no usage', {}],
    ['no cache counters', { usage: { model: 'claude-haiku-4-5', input_tokens: 5 } }],
  ]) {
    const metrics = responseMetrics({ history: [1], tiers: ['low'] }, response, 'low');
    assert.equal(metrics.inputTokens, null, name);
    assert.equal('history' in metrics || 'tiers' in metrics || 'strip' in metrics, false, name);
  }
});

test('responseMetrics keeps the last HISTORY readings for the input trend, history and tiers in step', () => {
  const view = { history: Array.from({ length: HISTORY }, (_, i) => i), tiers: Array(HISTORY).fill('low') };
  const metrics = responseMetrics(view, { usage: usage(100, 0, 0) }, null);
  assert.equal(metrics.history.length, HISTORY);
  assert.equal(metrics.history[0], 1);
  assert.equal(metrics.history.at(-1), 100);
  assert.equal(metrics.tiers.length, HISTORY);
  assert.equal(metrics.tiers.at(-1), null);
});

test('the session strip spans every reply: a full strip merges pairs of cells and keeps every count', () => {
  const tiers = Array.from({ length: 200 }, (_, i) => ['low', 'high', null][i % 3]);
  const strip = tiers.reduce((built, tier) => addToStrip(built, tier), null);
  assert.ok(strip.cells.length <= STRIP_CELLS);
  assert.equal(strip.per, 8);
  const counts = {};
  for (const cell of strip.cells) for (const [key, n] of Object.entries(cell)) counts[key] = (counts[key] ?? 0) + n;
  assert.deepEqual(counts, { low: 67, high: 67, none: 66 });
  for (const cell of strip.cells.slice(0, -1))
    assert.equal(
      Object.values(cell).reduce((sum, n) => sum + n, 0),
      strip.per,
    );
});

test('a strip fills each cell before it starts the next, and merges only when a new cell has no room', () => {
  for (const [replies, per, cells] of [
    [1, 1, 1],
    [STRIP_CELLS, 1, STRIP_CELLS],
    [STRIP_CELLS + 1, 2, STRIP_CELLS / 2 + 1],
    [STRIP_CELLS + 2, 2, STRIP_CELLS / 2 + 1],
    [STRIP_CELLS * 2, 2, STRIP_CELLS],
    [STRIP_CELLS * 2 + 1, 4, STRIP_CELLS / 2 + 1],
  ]) {
    const strip = Array(replies)
      .fill('low')
      .reduce((built, tier) => addToStrip(built, tier), null);
    assert.deepEqual([strip.per, strip.cells.length], [per, cells], `${replies} replies`);
  }
});

test('a strip keeps when its first reply arrived', () => {
  assert.deepEqual(addToStrip(null, 'low', 7), { per: 1, cells: [{ low: 1 }], from: 7 });
  assert.equal(addToStrip(addToStrip(null, 'low', 7), 'high', 9).from, 7);
});

test('merging pairs adds the counts and keeps an odd last cell', () => {
  assert.deepEqual(mergePairs([{ low: 1 }, { low: 1, high: 1 }, { none: 2 }]), [{ low: 2, high: 1 }, { none: 2 }]);
});

test('a switch view keeps the tiers and routes it moved between and the activity', () => {
  const from = { tier: 'low', model: 'claude-haiku-5-5', effort: 'high', reason: 'same-tier' };
  const to = { tier: 'high', model: 'claude-opus-5-5', reason: 'jump' };
  assert.deepEqual(switchView(from, to, 'code', 5), {
    lastSwitch: {
      at: 5,
      from: { tier: 'low', model: 'claude-haiku-5-5', effort: 'high' },
      to: { tier: 'high', model: 'claude-opus-5-5', effort: null },
      activity: 'code',
    },
  });
});

test('a classifier switch clears its activity readings with its tier readings', () => {
  const view = {
    ...initialView('claude-sonnet-5-5'),
    adviceChoice: 'low',
    activityChoice: 'code',
    activityProbabilities: { code: 0.8 },
  };
  const cleared = { ...view, ...CLEARED_READINGS };
  for (const key of ['adviceChoice', 'activityChoice', 'activityProbabilities']) assert.equal(cleared[key], null, key);
});

test('continuationView carries the activity of the route only in on', () => {
  const decision = {
    model: 'claude-sonnet-5-5',
    effort: null,
    tier: null,
    reason: 'model-unavailable',
    activity: null,
  };
  const context = { tokens: 1000, known: true };
  for (const [mode, expected] of [
    ['on', null],
    ['off', undefined],
  ])
    assert.equal(continuationView({ activityRouting: mode }, decision, context).activity, expected, mode);
});

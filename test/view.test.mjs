import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLEARED_READINGS, continuationView, initialView, responseMetrics } from '../lib/view.mjs';

const usage = (input, read, write) => ({
  model: 'claude-haiku-4-5',
  input_tokens: input,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: write,
  output_tokens: 7,
});

test('responseMetrics sums the input counters and appends the reading with its tier and activity', () => {
  const view = {
    ...initialView('claude-sonnet-5-5'),
    history: [10],
    tiers: ['low'],
    activities: ['code'],
    routes: ['claude-sonnet-5-5@high'],
  };
  assert.deepEqual(responseMetrics(view, { usage: usage(1, 2, 3) }, 'micro', 'ops', 'claude-haiku-5-5@medium'), {
    actualModel: 'claude-haiku-4-5',
    cacheRead: 2,
    cacheWrite: 3,
    inputTokens: 6,
    outputTokens: 7,
    history: [10, 6],
    tiers: ['low', 'micro'],
    activities: ['code', 'ops'],
    routes: ['claude-sonnet-5-5@high', 'claude-haiku-5-5@medium'],
  });
});

test('responseMetrics keeps the trend when a counter is missing', () => {
  for (const [name, response] of [
    ['no usage', {}],
    ['no cache counters', { usage: { model: 'claude-haiku-4-5', input_tokens: 5 } }],
  ]) {
    const metrics = responseMetrics({ history: [1], tiers: ['low'] }, response, 'low');
    assert.equal(metrics.inputTokens, null, name);
    assert.equal('history' in metrics || 'tiers' in metrics || 'activities' in metrics, false, name);
  }
});

test('responseMetrics keeps the last 30 readings, history and tiers in step', () => {
  const view = { history: Array.from({ length: 30 }, (_, i) => i), tiers: Array(30).fill('low') };
  const metrics = responseMetrics(view, { usage: usage(100, 0, 0) }, null);
  assert.equal(metrics.history.length, 30);
  assert.equal(metrics.history[0], 1);
  assert.equal(metrics.history.at(-1), 100);
  assert.equal(metrics.tiers.length, 30);
  assert.equal(metrics.tiers.at(-1), null);
  assert.equal(metrics.activities.length, 1);
  assert.equal(metrics.activities.at(-1), null);
});

test('responseMetrics starts the activity strip for a view saved before 1.6', () => {
  const view = { history: [1, 2], tiers: ['low', 'low'] };
  assert.deepEqual(responseMetrics(view, { usage: usage(3, 0, 0) }, 'low', 'code').activities, ['code']);
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

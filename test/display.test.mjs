import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULTS, loadConfig } from '../lib/config.mjs';
import {
  activityDetailLines,
  bar,
  classifierStatus,
  formatTokens,
  missingCredentials,
  missingText,
  percentPair,
  routeLabel,
  sparkline,
  storeAgreementLine,
  switchCount,
  usageMetrics,
  whyText,
} from '../lib/display.mjs';

test('unknown metrics stay unknown and zero is a real reading', () => {
  assert.equal(formatTokens(null), 'unknown');
  assert.equal(formatTokens(0), '0');
  assert.equal(bar(null, 100).percent, null);
  assert.equal(bar(0, 100).percent, 0);
  assert.equal(bar(200, 100).percent, 200);
  assert.equal(bar(200, 100).text.length, 16);
});

test('a small-window model is measured against its own window, not the native session model', () => {
  const config = loadConfig({
    userFile: {
      models: {
        haiku: {
          id: 'claude-haiku-4-5',
          input: 1,
          output: 5,
          cacheRead: 0.1,
          longContext: null,
          contextWindow: 200_000,
          efforts: [],
        },
      },
    },
  });
  const metrics = usageMetrics(
    config,
    {
      actualModel: 'claude-haiku-4-5-20251001',
      contextTokens: 150_000,
      inputTokens: 150_000,
      outputTokens: 500,
      cacheRead: 120_000,
    },
    { context: { window: 1_000_000, tokens: 150_000 }, cost: { usd: 0.03 } },
  );
  assert.equal(metrics.window, 200_000);
  assert.equal(metrics.contextBar.percent, 75);
  assert.equal(metrics.cacheBar.percent, 80);
  assert.equal(metrics.cacheBar.color, 'green');
  assert.equal(metrics.cost, 0.03);
  assert.equal(metrics.cacheBenefit, 0.108);
});

test('unreported ledgers and model pricing produce no fake savings', () => {
  const metrics = usageMetrics(DEFAULTS, { nativeModel: 'unknown-model' }, { context: { window: 1_000_000 } });
  assert.equal(metrics.cost, null);
  assert.equal(metrics.window, null);
  assert.equal(metrics.cacheBenefit, null);
  assert.equal(metrics.reuse, null);
});

test('the trend chart scales from the lowest to the highest reading and refuses unknown readings', () => {
  for (const [values, expected] of [
    [[], 'no history yet'],
    [[5], '▄'],
    [[0, 0], '▄▄'],
    [[0, 7], '▁█'],
    [[0, 1, 2, 3, 4, 5, 6, 7], '▁▂▃▄▅▆▇█'],
    [[1, 4, 8], '▁▄█'],
    [[396_000, 400_000, 402_000], '▁▆█'],
    [[1, Number.NaN], 'no history yet'],
    [[1, Number.POSITIVE_INFINITY], 'no history yet'],
  ])
    assert.equal(sparkline(values), expected, JSON.stringify(values));
});

test('token counts switch unit at a thousand and a million', () => {
  for (const [value, expected] of [
    [0, '0'],
    [999, '999'],
    [999.4, '999'],
    [1000, '1.0K'],
    [12_345, '12.3K'],
    [1_000_000, '1.00M'],
    [1_234_567, '1.23M'],
    [Number.NaN, 'unknown'],
    [Number.POSITIVE_INFINITY, 'unknown'],
    [undefined, 'unknown'],
  ])
    assert.equal(formatTokens(value), expected, String(value));
});

test('a bar turns yellow above 60% and red above 80%, clamps its fill and knows no reading', () => {
  for (const [value, maximum, width, expected] of [
    [0, 1, 4, { text: '░░░░', percent: 0, color: 'green' }],
    [0.6, 1, 10, { text: '██████░░░░', percent: 60, color: 'green' }],
    [0.61, 1, 10, { text: '██████░░░░', percent: 61, color: 'yellow' }],
    [0.8, 1, 10, { text: '████████░░', percent: 80, color: 'yellow' }],
    [0.81, 1, 10, { text: '████████░░', percent: 81, color: 'red' }],
    [3, 2, 4, { text: '████', percent: 150, color: 'red' }],
    [-1, 1, 4, { text: '░░░░', percent: 0, color: 'green' }],
    [1, 0, 4, { text: 'unknown', percent: null, color: 'gray' }],
    [Number.NaN, 1, 4, { text: 'unknown', percent: null, color: 'gray' }],
    [null, 1, 4, { text: 'unknown', percent: null, color: 'gray' }],
  ])
    assert.deepEqual(bar(value, maximum, width), expected, `${value} of ${maximum}`);
});

test('a route label adds the effort only when there is one', () => {
  for (const [model, effort, expected] of [
    ['claude-opus-5-5', 'high', 'Opus 5.5 · high'],
    ['claude-haiku-4-5-20251001', null, 'Haiku 4.5'],
    ['claude-sonnet-5-5', undefined, 'Sonnet 5.5'],
    ['claude-sonnet-5-5', 0, 'Sonnet 5.5 · 0'],
  ])
    assert.equal(routeLabel(model, effort), expected);
});

test('a switch is a change of the route a reply went out with', () => {
  for (const [routes, expected, name] of [
    [[], 0, 'no replies'],
    [['haiku@high'], 0, 'one reply'],
    [['sonnet@high', 'sonnet@high'], 0, 'same route'],
    [['haiku@high', 'opus@xhigh', 'opus@xhigh'], 1, 'one change'],
    [['haiku@high', 'opus@xhigh', 'haiku@high'], 2, 'there and back'],
    [['haiku@high', null, 'opus@xhigh'], 0, 'an unrouted reply breaks no run'],
    [['sonnet@high', 'haiku@high'], 1, 'a move inside a tier: Sonnet for code, then Haiku for ops'],
    [['opus@medium', 'opus@high'], 1, 'an effort change'],
  ])
    assert.equal(switchCount(routes), expected, name);
});

test('a classifier status names the classifier and the setting it lacks', () => {
  const clef = loadConfig({ userFile: { classifier: 'clef' } });
  for (const [config, error, expected] of [
    [DEFAULTS, 'missing-key', 'Jev: no API key'],
    [clef, 'missing-key', 'Clef: no API token'],
    [clef, 'missing-account', 'Clef: no account ID'],
    [clef, 'timeout', 'Clef timed out'],
    [clef, 'auth', 'Clef rejected the key'],
    [clef, 'something-new', 'Clef something-new'],
  ])
    assert.equal(classifierStatus(config, error), expected);
  assert.equal(missingText(clef, 'jev', 'missing-key'), 'no API key');
});

test('a classifier that takes no key is not missing one before its credentials are read', () => {
  const unread = { credentials: null };
  assert.equal(missingCredentials(DEFAULTS, unread, 'ollama'), null);
  assert.equal(missingCredentials(DEFAULTS, unread, 'jev'), 'missing-key');
  assert.equal(missingCredentials(DEFAULTS, { credentials: { jev: null } }, 'jev'), null);
});

test('/router without a UI surface names the activity and its route, and nothing in off', () => {
  const haiku = { tier: 'low', selectedModel: 'claude-haiku-5-5', effort: 'high' };
  const ops = { activity: 'ops', activityChoice: 'ops', activityProbabilities: { ops: 0.81, code: 0.1 } };
  for (const [mode, view, expected] of [
    ['on', { ...haiku, ...ops }, ['Activity: ops (81%)', 'Route: low + ops → Haiku 5.5 · high (base)']],
    [
      'on',
      { ...haiku, activityChoice: 'uncertain', activityProbabilities: { uncertain: 0.5 } },
      ['Activity: uncertain (50%)', 'Route: low → Haiku 5.5 · high (base)'],
    ],
    ['on', { phase: 'ready' }, ['Activity: none yet']],
    ['off', { ...haiku, ...ops }, []],
  ])
    assert.deepEqual(activityDetailLines({ ...DEFAULTS, activityRouting: mode }, view), expected, `${mode}`);
});

test('the /router agreement line adds code, ops and explore only when those were answered', () => {
  const store = (confusion) => ({
    version: 1,
    confusion,
    runs: {},
    lateral: { taken: 0, refused: 0 },
  });
  for (const [name, activityStore, expected] of [
    ['no store', null, 'Agreement across sessions: no labelled turns yet'],
    ['a corrupted store', { version: 1 }, 'Agreement across sessions: no labelled turns yet'],
    ['only uncertain answers', store({ uncertain: { talk: 3 } }), 'Agreement across sessions: no labelled turns yet'],
    ['no code, ops or explore', store({ plan: { talk: 2, ops: 2 } }), 'Agreement across sessions: 2 of 4 turns (50%)'],
    [
      'with code, ops and explore',
      store({ code: { code: 9, read: 1 }, plan: { ops: 2 } }),
      'Agreement across sessions: 9 of 12 turns (75%) · code/ops/explore 9 of 10 (90%)',
    ],
  ])
    assert.equal(storeAgreementLine({ activityStore }), expected, name);
});

test('Why names the cell for an activity move or a stay on an override, and keeps the reason otherwise', () => {
  const on = { ...DEFAULTS, activityRouting: 'on' };
  for (const [name, config, view, expected] of [
    [
      'a move up to an override',
      on,
      { tier: 'low', activity: 'code', reason: 'activity-up' },
      'coding at low runs on Sonnet 5.5 · high',
    ],
    [
      'a move down to an override',
      on,
      { tier: 'medium', activity: 'ops', reason: 'activity-down' },
      'running at medium runs on Haiku 5.5 · high',
    ],
    [
      'a move to an activity on the base route',
      on,
      { tier: 'low', activity: 'ops', reason: 'activity-down' },
      'running at low runs on Haiku 5.5 · high',
    ],
    [
      'a move back to the base route',
      on,
      { tier: 'low', activity: null, reason: 'activity-down' },
      'low runs on its base route, Haiku 5.5 · high',
    ],
    [
      'a stay on an override',
      on,
      { tier: 'low', activity: 'debug', reason: 'same-tier' },
      'debugging at low runs on Sonnet 5.5 · high',
    ],
    [
      'a stay on a cell without an override',
      on,
      { tier: 'low', activity: 'ops', reason: 'same-tier' },
      'the task fits the current tier',
    ],
    [
      'a refused move on an override',
      on,
      { tier: 'low', activity: 'code', reason: 'activity-pending' },
      'a route for the activity does not pay back yet',
    ],
    ['a hold on an override', on, { tier: 'low', activity: 'code', reason: 'hold' }, 'staying after an escalation'],
    [
      'a tier move onto an override',
      on,
      { tier: 'low', activity: 'code', reason: 'downgrade' },
      'enough support for a cheaper model',
    ],
    ['before a turn', on, { tier: null, activity: null, reason: 'ready' }, 'ready for the next turn'],
  ])
    assert.equal(whyText(config, view), expected, name);
});

test('two compared shares keep whole percents unless rounding would make unequal values read as equal', () => {
  for (const [a, b, expected] of [
    [0.9, 0.8, ['90%', '80%']],
    [0.8, 0.8, ['80%', '80%']],
    [0.81, 0.8138, ['81.0%', '81.4%']],
    [0.805, 0.8138, ['80.5%', '81.4%']],
    [0.81401, 0.81404, ['81.40%', '81.40%']],
  ])
    assert.deepEqual(percentPair(a, b), expected, `${a} ${b}`);
});

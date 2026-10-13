import assert from 'node:assert/strict';
import test from 'node:test';
import { renderBand } from '../lib/band.mjs';
import { DEFAULTS } from '../lib/config.mjs';
import { savingsLine } from '../lib/display.mjs';
import { ELEMENTS, screen } from './harness.mjs';

const actions = new Proxy({}, { get: () => () => {} });
const SINCE = Date.parse('2026-10-10T12:00:00Z');
const STORE = {
  version: 1,
  since: SINCE,
  replies: 400,
  routedUsd: 41.18,
  yoursUsd: 52.6,
  cheaperUsd: -14.9,
  strongerUsd: 0,
  switchUsd: 3.48,
};
const SAVES = {
  replies: 64,
  routedUsd: 6.404,
  yoursUsd: 8.236,
  cheaperUsd: -2.31,
  strongerUsd: 0,
  switchUsd: 0.478,
  stronger: {},
};
const MORE = {
  replies: 41,
  routedUsd: 3.1,
  yoursUsd: 0.62,
  cheaperUsd: 0,
  strongerUsd: 2.31,
  switchUsd: 0.17,
  stronger: { 'claude-opus-5-5': 9 },
};
// One dated day kept by the usage records after the undated totals: −$2.00 more saved, on 10 replies.
const DATED = {
  version: 1,
  since: Date.parse('2026-10-12T12:00:00Z'),
  days: {
    '2026-10-12': {
      cells: { 'code|low|haiku@high': [10, 1, 3, -2, 0, 0, 10_000, 9_000, 100] },
      whatIf: {},
      yours: { opus: 10 },
      hours: { 12: 1 },
      turns: 4,
      switches: { tier: 1, activity: 0 },
    },
  },
};
const EARLY = { ...SAVES, replies: 3, routedUsd: 0.21, yoursUsd: 0.26, cheaperUsd: -0.06, switchUsd: 0.01 };
const OPUS = { nativeModel: 'claude-opus-5-5', nativeEffort: 'xhigh' };
const HAIKU = { nativeModel: 'claude-haiku-5-5', nativeEffort: 'high' };
const FOOTER = [
  '',
  '  API list prices · same tokens and output length · not a bill;',
  '  on a Claude plan it stands for quota · answer quality not measured',
];
const _SAVED_FOOTER = ['', '  since Oct 10: each session compared with its own model', ...FOOTER.slice(1)];

const view = (props) => ({
  mode: 'auto',
  phase: 'routed',
  tab: 'usage',
  credentials: { jev: null },
  tier: 'low',
  selectedModel: 'claude-haiku-5-5',
  actualModel: 'claude-haiku-5-5',
  effort: 'high',
  tiers: ['low', 'low', 'high'],
  routes: ['claude-haiku-5-5@high', 'claude-haiku-5-5@high', 'claude-opus-5-5@xhigh'],
  savingsStore: STORE,
  ...props,
});

test('the two-row band says the session against your model now, one scope, the answer kept when narrow', () => {
  const second = (props, columns = 140) =>
    screen(renderBand(ELEMENTS, DEFAULTS, view({ bandDetail: true, ...props }), null, { columns }, actions))[1];
  const SAME = { ...SAVES, replies: 20, routedUsd: 1, yoursUsd: 1, cheaperUsd: 0, switchUsd: 0 };
  for (const [props, columns, expected] of [
    [
      { ...OPUS, savings: SAVES },
      140,
      'session  saved $1.84 (22%) vs Opus 5.5 · xhigh  ·  64 replies  ·  cold-cache writes +$0.47',
    ],
    [
      { ...HAIKU, savings: MORE },
      140,
      'session  extra $2.48 (×5.0) vs Haiku 5.5 · high  ·  41 replies  ·  stronger models +$2.31',
    ],
    [
      { ...HAIKU, savings: { ...MORE, strongerUsd: 0.1, switchUsd: 2.38 } },
      140,
      'session  extra $2.48 (×5.0) vs Haiku 5.5 · high  ·  41 replies  ·  cold-cache writes +$2.38',
    ],
    [{ ...OPUS, savings: SAME }, 140, 'session  same cost as Opus 5.5 · xhigh  ·  20 replies'],
    [{ ...OPUS, savings: EARLY }, 140, 'session  3 replies · too early to compare'],
    [{ ...OPUS, savings: SAVES }, 66, 'session  saved $1.84 (22%) vs Opus 5.5 · xhigh  ·  64 replies'],
    [{ ...OPUS, savings: SAVES }, 50, 'session  saved $1.84 (22%) vs Opus 5.5 · xhigh'],
    [{ ...OPUS, savings: null }, 140, 'no replies yet'],
    [
      { nativeModel: 'claude-fable-5-1', nativeEffort: null, savings: null },
      140,
      'session  Fable 5.1 has no list price',
    ],
  ])
    assert.equal(second(props, columns), expected, `${columns}: ${JSON.stringify(props.savings?.replies)}`);
  const oneRow = screen(
    renderBand(ELEMENTS, DEFAULTS, view({ ...OPUS, savings: SAVES }), null, { columns: 140 }, actions),
  );
  assert.ok(!oneRow.join('\n').includes('session'));
});

test('/router without a surface says the session against your model in one line', () => {
  for (const [props, expected] of [
    [
      { ...OPUS, savings: SAVES },
      'vs your model (Opus 5.5 · xhigh): −$1.84 (−22%) this session, 64 replies, est. at list prices',
    ],
    [
      { ...HAIKU, savings: MORE },
      'vs your model (Haiku 5.5 · high): +$2.48 (×5.0) this session, 9 of 41 replies on Opus 5.5, est. at list prices',
    ],
    [{ ...OPUS, savings: EARLY }, 'vs your model (Opus 5.5 · xhigh): too early, 3 routed replies'],
    [
      { nativeModel: 'claude-sonnet-5-5', nativeEffort: 'medium', savings: null },
      'vs your model (Sonnet 5.5 · medium): no routed replies this session; −$11.42 (−22%) since Oct 10, each session compared with its own model',
    ],
    [
      { ...OPUS, phase: 'unavailable', savings: null },
      'vs your model (Opus 5.5 · xhigh): no routed replies this session; −$11.42 (−22%) since Oct 10, each session compared with its own model',
    ],
    [
      { ...OPUS, savings: null, savingsStore: 'corrupted' },
      'vs your model (Opus 5.5 · xhigh): no routed replies this session',
    ],
    [
      { ...OPUS, savings: null, usageStore: DATED },
      'vs your model (Opus 5.5 · xhigh): no routed replies this session; −$13.42 (−24%) since Oct 10, each session compared with its own model',
    ],
  ])
    assert.equal(savingsLine(view(props)), expected);
});

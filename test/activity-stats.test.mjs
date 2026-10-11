import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ALLOWED,
  advanceDown,
  advanceRun,
  agrees,
  emptyMetrics,
  emptySession,
  emptyStore,
  latencyP95,
  mergeMetrics,
  mergeStores,
  metricsAfterReset,
  mostlyOn,
  OBSERVED,
  readMetrics,
  readStore,
  recordMetrics,
  recordStore,
  recordTurn,
  storeAfterReset,
  storeSummary,
  turnActivity,
} from '../lib/activity-stats.mjs';
import { ACTIVITIES, DEFAULTS } from '../lib/config.mjs';

const turn = (extra = {}) => ({
  activity: 'code',
  answer: 'code',
  observed: 'code',
  requests: 3,
  inputTokens: 1000,
  outputTokens: 200,
  tierSwitches: 0,
  activitySwitches: 0,
  ...extra,
});

test('every activity allows a set of buckets, and agreement follows it', () => {
  assert.deepEqual(Object.keys(ALLOWED), ACTIVITIES);
  for (const [predicted, observed, expected] of [
    ['code', 'code', true],
    ['code', 'ops', false],
    ['code', 'docs', false],
    ['debug', 'code', true],
    ['debug', 'ops', true],
    ['debug', 'read', true],
    ['debug', 'talk', false],
    ['explore', 'read', true],
    ['explore', 'talk', true],
    ['explore', 'code', false],
    ['plan', 'docs', true],
    ['plan', 'ops', false],
    ['review', 'read', true],
    ['review', 'docs', false],
    ['ops', 'ops', true],
    ['ops', 'read', true],
    ['docs', 'docs', true],
    ['docs', 'code', false],
    ['uncertain', 'talk', false],
    [null, 'talk', false],
    ['code', undefined, false],
  ])
    assert.equal(agrees(predicted, observed), expected, `${predicted} vs ${observed}`);
  for (const buckets of Object.values(ALLOWED)) for (const b of buckets) assert.ok(OBSERVED.includes(b), b);
});

test('a session accumulates turns, requests and tokens per activity, and none without a label', () => {
  let session = emptySession();
  session = recordTurn(session, turn());
  session = recordTurn(session, turn({ requests: 2, inputTokens: 500, outputTokens: 50 }));
  session = recordTurn(session, turn({ activity: 'ops', observed: 'ops', requests: 1 }));
  session = recordTurn(session, turn({ activity: null, observed: 'talk', requests: 4 }));
  const unpriced = { routedUsd: null, pricedRequests: 0, routes: {} };
  assert.deepEqual(session.byActivity, {
    code: { turns: 2, requests: 5, inputTokens: 1500, outputTokens: 250, ...unpriced },
    ops: { turns: 1, requests: 1, inputTokens: 1000, outputTokens: 200, ...unpriced },
    none: { turns: 1, requests: 4, inputTokens: 1000, outputTokens: 200, ...unpriced },
  });
});

test('a session adds each activity’s reply cost, priced replies and routes, also to counts saved by 1.7.0', () => {
  const saved = { byActivity: { code: { turns: 1, requests: 2, inputTokens: 10, outputTokens: 1 } } };
  let session = { ...emptySession(), ...saved };
  session = recordTurn(session, turn({ routedUsd: null, pricedRequests: 0, routes: {} }));
  const { routedUsd, pricedRequests, routes } = session.byActivity.code;
  assert.deepEqual([routedUsd, pricedRequests, routes], [null, 0, {}]);
  session = recordTurn(session, turn({ routedUsd: 0.5, pricedRequests: 2, routes: { 'claude-sonnet-5-5@high': 2 } }));
  session = recordTurn(
    session,
    turn({
      routedUsd: 0.25,
      pricedRequests: 3,
      routes: { 'claude-sonnet-5-5@high': 1, 'claude-opus-5-5@medium': 3, bad: -1 },
    }),
  );
  const code = session.byActivity.code;
  assert.deepEqual(
    [code.routedUsd, code.pricedRequests, code.routes],
    [0.75, 5, { 'claude-sonnet-5-5@high': 3, 'claude-opus-5-5@medium': 3 }],
  );
  assert.deepEqual([code.turns, code.requests], [4, 11], 'the 1.7.0 replies stay unpriced');
});

test('mostlyOn picks the route with the most replies, ties in name order, none without replies', () => {
  for (const [routes, expected] of [
    [{ 'b@high': 2, 'a@high': 5 }, 'a@high'],
    [{ 'b@high': 3, 'a@medium': 3 }, 'a@medium'],
    [{}, null],
    [undefined, null],
  ])
    assert.equal(mostlyOn({ routes }), expected, JSON.stringify(routes));
});

test('session agreement compares the classifier answer, not the route label, and skips turns without one', () => {
  let session = emptySession();
  for (const [activity, answer, observed] of [
    ['code', 'code', 'code'],
    ['code', 'code', 'ops'],
    ['explore', 'explore', 'talk'],
    ['code', 'ops', 'ops'],
    ['code', null, 'code'],
    [null, null, 'code'],
    [null, null, 'talk'],
  ])
    session = recordTurn(session, turn({ activity, answer, observed }));
  assert.deepEqual(session.agreement, { matched: 3, total: 4 });
});

test('session switches add up', () => {
  let session = emptySession();
  for (const extra of [{ tierSwitches: 1 }, { activitySwitches: 2 }, {}, { tierSwitches: 1, activitySwitches: 1 }])
    session = recordTurn(session, turn(extra));
  assert.deepEqual(session.switches, { tier: 2, activity: 3 });
});

test('session lateral moves count taken and refused, also on a 1.7.0 view without them', () => {
  const { lateral: _, ...saved } = emptySession();
  let session = saved;
  for (const lateral of ['taken', 'refused', 'refused', null, 'bogus'])
    session = recordTurn(session, turn({ lateral }));
  assert.deepEqual(session.lateral, { taken: 1, refused: 2 });
});

test('recordTurn returns a new session and treats bad numbers as zero', () => {
  const before = emptySession();
  const after = recordTurn(
    before,
    turn({ requests: Number.NaN, inputTokens: -5, outputTokens: undefined, tierSwitches: 'x' }),
  );
  assert.deepEqual(before, emptySession());
  assert.deepEqual(after.byActivity.code, {
    turns: 1,
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    routedUsd: null,
    pricedRequests: 0,
    routes: {},
  });
  assert.deepEqual(after.switches, { tier: 0, activity: 0 });
});

test('the store counts a predicted x observed matrix, with none for a missing prediction', () => {
  let store = emptyStore();
  for (const [predicted, observed] of [
    ['code', 'code'],
    ['code', 'code'],
    ['code', 'ops'],
    ['uncertain', 'talk'],
    [null, 'read'],
  ])
    store = recordStore(store, { predicted, observed, runEnded: null, lateral: null });
  assert.deepEqual(store.confusion, {
    code: { code: 2, ops: 1 },
    uncertain: { talk: 1 },
    none: { read: 1 },
  });
});

test('the store buckets run lengths 1, 2, 3, 4 and 5 or more', () => {
  let store = emptyStore();
  for (const length of [1, 2, 2, 3, 4, 5, 6, 40])
    store = recordStore(store, {
      predicted: null,
      observed: 'talk',
      runEnded: { activity: 'ops', length },
      lateral: null,
    });
  assert.deepEqual(store.runs, { ops: [1, 2, 1, 1, 3] });
});

test('the store counts lateral outcomes', () => {
  let store = emptyStore();
  for (const lateral of ['taken', 'refused', 'refused', null, 'sideways'])
    store = recordStore(store, { predicted: 'ops', observed: 'ops', runEnded: null, lateral });
  assert.deepEqual(store.lateral, { taken: 1, refused: 2 });
});

test('the store drops labels it does not know, so its key set stays fixed', () => {
  const store = recordStore(emptyStore(), {
    predicted: '__proto__',
    observed: 'code',
    runEnded: { activity: 'uncertain', length: 2 },
    lateral: null,
  });
  assert.deepEqual(store, emptyStore());
  const badObserved = recordStore(emptyStore(), {
    predicted: 'code',
    observed: 'sleep',
    runEnded: { activity: 'code', length: 0 },
    lateral: null,
  });
  assert.deepEqual(badObserved, emptyStore());
});

test('recordStore does not change the store it was given', () => {
  const store = readStore(
    recordStore(emptyStore(), {
      predicted: 'code',
      observed: 'code',
      runEnded: { activity: 'code', length: 2 },
      lateral: 'taken',
    }),
  );
  const copy = structuredClone(store);
  recordStore(store, {
    predicted: 'code',
    observed: 'ops',
    runEnded: { activity: 'code', length: 9 },
    lateral: 'refused',
  });
  assert.deepEqual(store, copy);
});

test('readStore keeps a valid store and falls back to an empty one for any bad shape', () => {
  const valid = {
    version: 1,
    since: 7,
    confusion: { code: { code: 4, ops: 1 }, none: { talk: 2 } },
    runs: { code: [1, 0, 2, 0, 3] },
    lateral: { taken: 2, refused: 1 },
  };
  assert.deepEqual(readStore(valid), valid);
  assert.deepEqual(readStore(structuredClone(emptyStore())), emptyStore());
  const { since: _since, ...shared } = valid;
  assert.deepEqual(readStore(shared), { ...valid, since: null }, 'the shared key from before 1.10.3 has no since');
  const mutate = (change) => {
    const copy = structuredClone(valid);
    change(copy);
    return copy;
  };
  for (const [name, value] of [
    ['undefined', undefined],
    ['null', null],
    ['a string', '{"version":1}'],
    ['an array', []],
    ['an empty object', {}],
    ['a future version', mutate((v) => (v.version = 2))],
    ['no version', mutate((v) => delete v.version)],
    ['an extra top-level key', mutate((v) => (v.text = 'hello'))],
    ['a string since', mutate((v) => (v.since = '7'))],
    ['missing runs', mutate((v) => delete v.runs)],
    ['confusion as an array', mutate((v) => (v.confusion = []))],
    ['an unknown predicted row', mutate((v) => (v.confusion.guess = { code: 1 }))],
    ['an unknown observed bucket', mutate((v) => (v.confusion.code.sleep = 1))],
    ['a row that is not an object', mutate((v) => (v.confusion.code = 5))],
    ['a negative count', mutate((v) => (v.confusion.code.code = -1))],
    ['a fractional count', mutate((v) => (v.confusion.code.code = 1.5))],
    ['a string count', mutate((v) => (v.confusion.code.code = '4'))],
    ['a NaN count', mutate((v) => (v.lateral.taken = Number.NaN))],
    ['uncertain as a run activity', mutate((v) => (v.runs.uncertain = [0, 0, 0, 0, 0]))],
    ['too few run buckets', mutate((v) => (v.runs.code = [1, 2, 3, 4]))],
    ['too many run buckets', mutate((v) => (v.runs.code = [1, 2, 3, 4, 5, 6]))],
    ['runs as an object', mutate((v) => (v.runs.code = { 0: 1 }))],
    ['a non-count run bucket', mutate((v) => (v.runs.code[2] = null))],
    ['lateral missing a key', mutate((v) => delete v.lateral.refused)],
    ['lateral with an extra key', mutate((v) => (v.lateral.other = 1))],
  ])
    assert.deepEqual(readStore(value), emptyStore(), name);
});

test('a store saved before 1.10.1 reads back without its shadow readout and keeps its counts', () => {
  const saved = {
    version: 1,
    confusion: { code: { code: 4 } },
    runs: { code: [1, 0, 2, 0, 3] },
    lateral: { taken: 2, refused: 1 },
  };
  for (const shadow of [
    { differs: 3, turns: 10 },
    { differs: 3, turns: 10, estimated: 2, minUsd: -0.5, maxUsd: 0.25 },
    7,
  ]) {
    const before = { ...saved, shadow };
    assert.deepEqual(readStore(before), { ...saved, since: null });
    assert.deepEqual(before.shadow, shadow, 'the value read is not changed');
  }
});

test('the stats store holds only version, since, confusion, runs and lateral, whatever the turn measured', () => {
  const store = recordStore(
    emptyStore(),
    {
      predicted: 'code',
      observed: 'code',
      runEnded: { activity: 'code', length: 2 },
      lateral: 'taken',
      classifier: 'jev',
      adviceMs: 240,
      downMove: 'moved',
    },
    500,
  );
  assert.deepEqual(Object.keys(store), ['version', 'since', 'confusion', 'runs', 'lateral']);
  assert.equal(store.since, 500);
  assert.deepEqual(readStore(store), store);
});

test('recordStore keeps the first since and returns the store itself for a turn that counts nothing', () => {
  const empty = emptyStore();
  const nothing = { predicted: 'code', observed: null, runEnded: null, lateral: null };
  assert.equal(recordStore(empty, nothing, 500), empty);
  const once = recordStore(empty, { ...nothing, observed: 'code' }, 500);
  assert.equal(recordStore(once, { ...nothing, lateral: 'refused' }, 900).since, 500);
});

test('mergeStores adds up every record since the last reset, the shared one from before 1.10.3 included', () => {
  const record = (since, taken) => ({
    version: 1,
    since,
    confusion: { code: { code: 1 } },
    runs: { code: [1, 0, 0, 0, 0] },
    lateral: { taken, refused: 0 },
  });
  const shared = { ...record(null, 4) };
  delete shared.since;
  assert.deepEqual(mergeStores([record(200, 1), record(100, 2), shared, undefined, { version: 'bad' }]), {
    version: 1,
    since: 100,
    confusion: { code: { code: 3 } },
    runs: { code: [3, 0, 0, 0, 0] },
    lateral: { taken: 7, refused: 0 },
  });
  // A reset at 150 drops the record that started before it; the shared key is deleted by the reset itself.
  assert.deepEqual(mergeStores([record(200, 1), record(100, 2)], 150), record(200, 1));
  assert.deepEqual(storeAfterReset(record(100, 2), 150), emptyStore());
  assert.deepEqual(storeAfterReset(record(200, 1), 150), record(200, 1));
});

test('readMetrics keeps each part it can read and drops only a bad one', () => {
  const latency = { jev: [0, 0, 0, 0, 5, 1, ...Array(16).fill(0)] };
  const downMoves = { moves: 3, escalations: 1 };
  const valid = { version: 1, since: 5, latency, downMoves };
  const none = { moves: 0, escalations: 0 };
  assert.deepEqual(readMetrics(valid), valid);
  assert.deepEqual(readMetrics(structuredClone(emptyMetrics())), emptyMetrics());
  for (const [name, value, expected] of [
    ['undefined', undefined, emptyMetrics()],
    ['null', null, emptyMetrics()],
    ['an array', [], emptyMetrics()],
    ['a future version', { ...valid, version: 2 }, emptyMetrics()],
    ['no since', { ...valid, since: undefined }, { ...valid, since: null }],
    ['since as a string', { ...valid, since: '5' }, { ...valid, since: null }],
    ['latency as an array', { ...valid, latency: [] }, { ...valid, latency: {} }],
    ['too few latency buckets', { ...valid, latency: { jev: [1, 2] } }, { ...valid, latency: {} }],
    ['a negative latency count', { ...valid, latency: { jev: [-1, ...Array(21).fill(0)] } }, { ...valid, latency: {} }],
    [
      'more classifiers than the bound',
      { ...valid, latency: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`c${i}`, Array(22).fill(0)])) },
      { ...valid, latency: {} },
    ],
    ['downMoves missing a key', { ...valid, downMoves: { moves: 3 } }, { ...valid, downMoves: none }],
    [
      'downMoves with a string count',
      { ...valid, downMoves: { moves: '3', escalations: 1 } },
      { ...valid, downMoves: none },
    ],
  ])
    assert.deepEqual(readMetrics(value), expected, name);
});

test('the sessions’ metrics add up since the last reset, within the classifier bound', () => {
  const bucket = (i) => Array.from({ length: 22 }, (_, j) => (j === i ? 1 : 0));
  const record = (since, latency, moves, escalations) => ({
    version: 1,
    since,
    latency,
    downMoves: { moves, escalations },
  });
  const many = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`c${i}`, bucket(0)]));
  for (const [name, values, resetAt, expected] of [
    ['none', [], null, emptyMetrics()],
    [
      'two sessions',
      [record(20, { jev: bucket(0) }, 2, 1), record(10, { jev: bucket(3), clef: bucket(1) }, 1, 0)],
      null,
      record(10, { jev: [1, 0, 0, 1, ...Array(18).fill(0)], clef: bucket(1) }, 3, 1),
    ],
    [
      'one from before the reset',
      [record(5, { jev: bucket(0) }, 2, 1), record(20, {}, 1, 0)],
      10,
      record(20, {}, 1, 0),
    ],
    ['a bad and a missing value', [{ version: 2 }, undefined, record(20, {}, 1, 0)], null, record(20, {}, 1, 0)],
    ['ids past the bound', [record(1, many, 0, 0), record(2, { jev: bucket(0) }, 0, 0)], null, record(1, many, 0, 0)],
    [
      'a classifier id that names an Object.prototype member',
      [record(1, { toString: bucket(0) }, 0, 0), record(2, { toString: bucket(0) }, 0, 0)],
      null,
      record(1, { toString: bucket(0).map((n) => n * 2) }, 0, 0),
    ],
  ])
    assert.deepEqual(mergeMetrics(values, resetAt), expected, name);
  const merged = mergeMetrics([record(1, many, 0, 0), record(2, { jev: bucket(0) }, 0, 0)]);
  assert.deepEqual(readMetrics(merged), merged);
});

test('a turn that adds no reading leaves the record as it was; the first reading sets since', () => {
  const empty = emptyMetrics();
  assert.equal(recordMetrics(empty, { classifier: null, adviceMs: null, downMove: null, now: 7 }), empty);
  const first = recordMetrics(empty, { classifier: 'jev', adviceMs: 120, downMove: null, now: 7 });
  assert.equal(first.since, 7);
  assert.equal(recordMetrics(first, { classifier: null, adviceMs: null, downMove: 'moved', now: 9 }).since, 7);
  assert.equal(metricsAfterReset(first, 8).since, null);
  assert.equal(metricsAfterReset(first, 7), first);
});

test('advanceRun extends a run of the same activity and closes it on a change', () => {
  let run = null;
  const seen = [];
  for (const predicted of ['code', 'code', 'ops', 'code', 'code', 'code']) {
    const step = advanceRun(run, predicted);
    run = step.run;
    seen.push(step.ended);
  }
  assert.deepEqual(seen, [null, null, { activity: 'code', length: 2 }, { activity: 'ops', length: 1 }, null, null]);
  assert.deepEqual(run, { activity: 'code', length: 3 });
});

test('a missing or uncertain prediction ends the run and starts none', () => {
  for (const predicted of [null, 'uncertain', undefined, 'bogus']) {
    assert.deepEqual(advanceRun({ activity: 'plan', length: 4 }, predicted), {
      run: null,
      ended: { activity: 'plan', length: 4 },
    });
    assert.deepEqual(advanceRun(null, predicted), { run: null, ended: null });
  }
});

test('a run closed by advanceRun feeds the store', () => {
  let run = null;
  let store = emptyStore();
  for (const predicted of ['ops', 'ops', 'ops', 'code']) {
    const step = advanceRun(run, predicted);
    run = step.run;
    store = recordStore(store, { predicted, observed: 'ops', runEnded: step.ended, lateral: null });
  }
  assert.deepEqual(store.runs, { ops: [0, 0, 1, 0, 0] });
});

test('turnActivity labels a routed turn per mode and names what moved the route', () => {
  const config = (activityRouting) => ({ ...DEFAULTS, activityRouting });
  const advice = (choice, mass) => ({ activity: { choice, probabilities: { [choice]: mass } } });
  const sonnet = { model: 'claude-sonnet-5-5', effort: 'medium', tier: 'low' };
  const haiku = { model: 'claude-haiku-5-5', effort: 'high', tier: 'low' };
  const opus = { model: 'claude-opus-5-5', effort: 'medium', tier: 'medium' };
  for (const [name, mode, answer, previous, decision, expected] of [
    [
      'on: a lateral move down',
      'on',
      advice('ops', 0.81),
      sonnet,
      { ...haiku, activity: 'ops', reason: 'activity-down', lateral: 'taken' },
      { answer: 'ops', label: 'ops', predicted: 'ops', switched: 'activity', lateral: 'taken' },
    ],
    [
      'on: a refused move keeps the route',
      'on',
      advice('ops', 0.81),
      sonnet,
      { ...sonnet, activity: 'code', reason: 'activity-pending', lateral: 'refused' },
      { answer: 'ops', label: 'code', predicted: 'ops', switched: null, lateral: 'refused' },
    ],
    ...['hold', 'cash-gate'].map((reason) => [
      `on: a move refused by ${reason} is counted`,
      'on',
      advice('ops', 0.81),
      sonnet,
      { ...sonnet, activity: 'code', reason, lateral: 'refused' },
      { answer: 'ops', label: 'code', predicted: 'ops', switched: null, lateral: 'refused' },
    ]),
    [
      'on: a tier hold without a lateral move counts nothing',
      'on',
      advice('ops', 0.81),
      sonnet,
      { ...sonnet, activity: 'code', reason: 'hold', lateral: null },
      { answer: 'ops', label: 'code', predicted: 'ops', switched: null, lateral: null },
    ],
    [
      'on: a tier move',
      'on',
      advice('code', 0.9),
      haiku,
      { ...opus, activity: 'code', reason: 'upgrade' },
      { answer: 'code', label: 'code', predicted: 'code', switched: 'tier', lateral: null },
    ],
    [
      'on: an effort change is a switch',
      'on',
      null,
      sonnet,
      { ...sonnet, effort: 'high', activity: null, reason: 'context-fit' },
      { answer: null, label: null, predicted: null, switched: 'tier', lateral: null },
    ],
    [
      'on: a pin is no switch',
      'on',
      null,
      haiku,
      { ...opus, activity: null, reason: 'pinned', pinned: true },
      { answer: null, label: null, predicted: null, switched: null, lateral: null },
    ],
    [
      'on: uncertain is predicted but not a label',
      'on',
      advice('uncertain', 0.9),
      haiku,
      { ...haiku, activity: null, reason: 'hold' },
      { answer: null, label: null, predicted: 'uncertain', switched: null, lateral: null },
    ],
    [
      'off: nothing',
      'off',
      null,
      haiku,
      { ...haiku, activity: null, reason: 'hold' },
      { answer: null, label: null, predicted: null, switched: null, lateral: null },
    ],
  ])
    assert.deepEqual(turnActivity(config(mode), answer, previous, decision), { mode, ...expected }, name);
});

test('storeSummary counts labelled turns, agreement over activity rows, and the two largest disagreements', () => {
  const store = readStore({
    ...emptyStore(),
    confusion: {
      code: { code: 10, read: 3, ops: 1 },
      ops: { ops: 4, code: 3 },
      explore: { read: 5, talk: 1, code: 1 },
      plan: { talk: 2, ops: 1 },
      uncertain: { talk: 6 },
      none: { read: 2 },
    },
    lateral: { taken: 4, refused: 2 },
  });
  assert.deepEqual(storeSummary(store), {
    labelled: 39,
    agreement: { matched: 22, total: 31 },
    focus: { matched: 20, total: 28 },
    disagreements: [
      { predicted: 'code', observed: 'read', n: 3 },
      { predicted: 'ops', observed: 'code', n: 3 },
    ],
    lateral: { taken: 4, refused: 2 },
  });
  assert.deepEqual(storeSummary(emptyStore()), {
    labelled: 0,
    agreement: { matched: 0, total: 0 },
    focus: { matched: 0, total: 0 },
    disagreements: [],
    lateral: { taken: 0, refused: 0 },
  });
});

test('the metrics keep a bounded latency histogram per classifier and its p95 is a bucket bound', () => {
  let metrics = emptyMetrics();
  const turn = (classifier, adviceMs) => ({ classifier, adviceMs, downMove: null });
  for (const ms of [...Array(18).fill(240), 299, 301, 7000]) metrics = recordMetrics(metrics, turn('jev', ms));
  for (const ms of [null, -1, Number.NaN]) metrics = recordMetrics(metrics, turn('jev', ms));
  metrics = recordMetrics(metrics, turn(null, 100));
  assert.deepEqual(latencyP95(metrics.latency.jev), { ms: 350, over: false, turns: 21 });
  assert.deepEqual(latencyP95([...Array(21).fill(0), 3]), { ms: 5000, over: true, turns: 3 });
  assert.equal(latencyP95(undefined), null);
  assert.equal(latencyP95(Array(22).fill(0)), null);
  for (let i = 0; i < 12; i += 1) metrics = recordMetrics(metrics, turn(`c${i}`, 100));
  assert.equal(Object.keys(metrics.latency).length, 8);
  assert.ok(Object.hasOwn(metrics.latency, 'jev'));
  assert.deepEqual(readMetrics(metrics), metrics);
});

test('escalations after a cheaper activity move: a move starts the watch, one escalation or another route ends it', () => {
  const HAIKU = 'claude-haiku-5-5@high';
  const SONNET = 'claude-sonnet-5-5@high';
  const OPUS = 'claude-opus-5-5@xhigh';
  const on = (reason, route, extra = {}) => ({
    mode: 'on',
    reason,
    lateral: null,
    escalated: false,
    pinned: false,
    route,
    ...extra,
  });
  const down = on('activity-down', HAIKU, { lateral: 'taken' });
  const escalation = on('escalation', OPUS, { escalated: true });
  for (const [name, turns, events] of [
    ['an escalation right after', [down, escalation], ['moved', 'escalated']],
    ['an escalation after quiet turns', [down, on('same-tier', HAIKU), escalation], ['moved', null, 'escalated']],
    ['one escalation counts once', [down, escalation, escalation], ['moved', 'escalated', null]],
    ['another route ends the watch', [down, on('upgrade', SONNET), escalation], ['moved', null, null]],
    [
      'a pin and the return to the cheaper route keep the watch',
      [down, on('pinned', OPUS, { pinned: true }), on('same-tier', HAIKU), escalation],
      ['moved', null, null, 'escalated'],
    ],
    [
      'a return from a pin to another route ends it',
      [down, on('pinned', OPUS, { pinned: true }), on('upgrade', SONNET), escalation],
      ['moved', null, null, null],
    ],
    ['an escalation the cash gate held', [down, on('cash-gate', HAIKU, { escalated: true })], ['moved', 'escalated']],
    [
      'an escalation context-fit replaced',
      [down, on('context-fit', OPUS, { escalated: true })],
      ['moved', 'escalated'],
    ],
    [
      'a refused cheaper move starts nothing',
      [on('activity-pending', SONNET, { lateral: 'refused' }), escalation],
      [null, null],
    ],
    [
      'an off turn ends the watch',
      [down, { ...down, mode: 'off', reason: 'same-tier' }, escalation],
      ['moved', null, null],
    ],
  ]) {
    let after = null;
    const seen = turns.map((turn) => {
      const step = advanceDown(after, turn);
      after = step.after;
      return step.event;
    });
    assert.deepEqual(seen, events, name);
  }
  let metrics = emptyMetrics();
  for (const downMove of ['moved', 'escalated', 'moved', null, 'bogus'])
    metrics = recordMetrics(metrics, { classifier: null, adviceMs: null, downMove });
  assert.deepEqual(metrics.downMoves, { moves: 2, escalations: 1 });
});

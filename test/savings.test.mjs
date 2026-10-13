import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULTS, loadConfig } from '../lib/config.mjs';
import { resetHistory } from '../lib/route.mjs';
import {
  addReplies,
  addReply,
  compareModels,
  compareReply,
  EARLY_REPLIES,
  emptySavingsStore,
  emptyTotals,
  mergeSavingsStores,
  modelSpec,
  readout,
  readSavingsStore,
  requestUsd,
  sessionCacheTtl,
} from '../lib/savings.mjs';

const OPUS = { model: 'claude-opus-5-5', effort: 'xhigh' };
const OPUS_MEDIUM = { model: 'claude-opus-5-5', effort: 'medium' };
const SONNET = { model: 'claude-sonnet-5-5', effort: 'medium' };
const HAIKU = { model: 'claude-haiku-5-5', effort: 'high' };
const MINUTE = 60_000;
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

const usage = ({ input = 2, read = 0, write = 0, output = 500 } = {}) => ({
  input_tokens: input,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: write,
  output_tokens: output,
});

// Replies in order: `[route, counts, minutesAfterTheLast]`. Returns the totals and every reply.
function session(yours, replies, { ttl = '5m', config = DEFAULTS, state = null } = {}) {
  let totals = emptyTotals();
  let cache = state;
  let at = 0;
  const each = [];
  for (const [served, counts, minutes = 1] of replies) {
    at += minutes * MINUTE;
    const { state: next, reply } = compareReply(config, cache, { usage: usage(counts), served, yours, ttl, now: at });
    cache = next;
    each.push(reply);
    if (reply) totals = addReply(totals, reply);
  }
  return { totals, replies: each, state: cache };
}

// A growing conversation: each reply reads the last prompt and writes what was added since.
function conversation(routes, { start = 40_000, step = 3_000 } = {}) {
  let total = start;
  return routes.map((route, i) => {
    const counts = i === 0 ? { write: total } : { read: total - step, write: step };
    total += step;
    return [route, counts, 1, i === 0 ? null : 'low'];
  });
}

const sumOfParts = (r) => r.cheaperUsd + r.strongerUsd + r.switchUsd;

test('every reply splits its difference into cheaper, stronger and switch parts that sum to it exactly', () => {
  for (const [yours, routes] of [
    [OPUS, [OPUS, HAIKU, HAIKU, SONNET, OPUS, OPUS_MEDIUM, HAIKU]],
    [HAIKU, [HAIKU, OPUS, OPUS, SONNET, HAIKU]],
    [SONNET, [HAIKU, OPUS, SONNET, HAIKU]],
  ]) {
    const { replies } = session(yours, conversation(routes));
    for (const reply of replies) near(sumOfParts(reply), reply.routedUsd - reply.yoursUsd);
  }
});

test('cache writes from switches are never negative: your cache reads at least what the API read', () => {
  const routes = [HAIKU, HAIKU, SONNET, HAIKU];
  const replies = [
    [HAIKU, { read: 20_000, write: 20_000 }],
    [HAIKU, { read: 40_002, write: 3_000 }, 30],
    [SONNET, { write: 44_000 }],
    [HAIKU, { read: 44_000, write: 2_000 }, 90],
  ];
  assert.equal(routes.length, replies.length);
  for (const ttl of ['5m', '1h']) {
    const { replies: priced } = session(OPUS, replies, { ttl });
    for (const reply of priced) assert.ok(reply.switchUsd >= 0, `${ttl}: ${reply.switchUsd}`);
    near(priced[0].switchUsd, 0);
  }
});

test('a session that ran mostly on Haiku against Opus saves, net of the cache writes its switches paid', () => {
  const routes = [OPUS, ...Array(9).fill(HAIKU), OPUS, OPUS, HAIKU];
  const { totals } = session(OPUS, conversation(routes));
  assert.ok(totals.routedUsd < totals.yoursUsd);
  assert.ok(totals.cheaperUsd < 0);
  assert.equal(totals.strongerUsd, 0);
  assert.ok(totals.switchUsd > 0);
  near(sumOfParts(totals), totals.routedUsd - totals.yoursUsd);
  assert.equal(totals.replies, routes.length);
});

test('the first Haiku reply after Opus is priced against an Opus cache that reads the previous prompt', () => {
  const { replies } = session(OPUS, [
    [OPUS, { write: 40_000 }],
    [HAIKU, { write: 42_000 }],
  ]);
  // Opus reads 40,002 at 0.2 and writes 1,998 at 4 × 1.25; output 500 at 20.
  near(replies[1].yoursUsd, (4 * (2 + 1_998 * 1.25) + 0.2 * 40_002 + 20 * 500) / 1e6);
  near(replies[1].routedUsd, (0.1 * (2 + 42_000 * 1.25) + 0.5 * 500) / 1e6);
  assert.equal(replies[1].strongerModel, null);
});

test('a session whose model is Haiku costs more when harder turns run on Opus, and names Opus', () => {
  const routes = [HAIKU, OPUS, OPUS, OPUS, HAIKU, HAIKU];
  const { totals } = session(HAIKU, conversation(routes));
  assert.ok(totals.routedUsd > totals.yoursUsd);
  assert.equal(totals.cheaperUsd, 0);
  assert.ok(totals.strongerUsd > 0);
  assert.deepEqual(totals.stronger, { 'claude-opus-5-5': 3 });
  near(sumOfParts(totals), totals.routedUsd - totals.yoursUsd);
});

test('replies on your own route differ by exactly zero, whatever the API cached', () => {
  const replies = [
    [OPUS, { write: 40_000 }],
    [OPUS, { read: 40_000, write: 3_000 }],
    // A cache miss the API had, not a switch: yours is the same reply.
    [OPUS, { read: 0, write: 46_000 }, 20],
    [OPUS, { read: 30_000, write: 19_000, input: 400 }],
  ];
  const { totals } = session(OPUS, replies);
  assert.ok(totals.routedUsd > 0);
  assert.equal(totals.routedUsd, totals.yoursUsd);
  assert.deepEqual([totals.cheaperUsd, totals.strongerUsd, totals.switchUsd], [0, 0, 0]);
});

test('your cache reads the previous prompt only inside the session cache lifetime', () => {
  const state = { total: 50_000, at: 0, onYours: true, model: OPUS.model, effort: OPUS.effort };
  const counts = { input: 1_000, write: 59_000 };
  for (const [ttl, minutes, read, write] of [
    ['5m', 4, 50_000, 9_000],
    ['5m', 6, 0, 59_000],
    ['1h', 6, 50_000, 9_000],
    ['1h', 61, 0, 59_000],
  ]) {
    const { reply } = compareReply(DEFAULTS, state, {
      usage: usage(counts),
      served: HAIKU,
      yours: OPUS,
      ttl,
      now: minutes * MINUTE,
    });
    const multiplier = DEFAULTS.cache.writeMultiplier[ttl];
    near(reply.yoursUsd, (4 * (1_000 + write * multiplier) + 0.2 * read + 20 * 500) / 1e6);
  }
});

test('a compaction leaves your cache nothing to read, whether seen as a shrink or as a reset loop', () => {
  const after = { input: 2, write: 20_000 };
  const shrunk = compareReply(
    DEFAULTS,
    { total: 200_000, at: 0, onYours: false, ...OPUS },
    {
      usage: usage(after),
      served: HAIKU,
      yours: OPUS,
      ttl: '1h',
      now: MINUTE,
    },
  );
  near(shrunk.reply.yoursUsd, (4 * (2 + 20_000 * 2) + 20 * 500) / 1e6);
  // resetHistory clears the state: the next reply on your route is its own price again.
  const loop = resetHistory({
    generation: 0,
    state: {},
    would: null,
    yoursBy: { opus: { total: 9, at: 0, onYours: false } },
  });
  assert.deepEqual(loop.yoursBy, {});
  const fresh = compareReply(DEFAULTS, loop.yoursBy.opus ?? null, {
    usage: usage(after),
    served: OPUS,
    yours: OPUS,
    ttl: '1h',
    now: 0,
  });
  assert.equal(fresh.reply.yoursUsd, fresh.reply.routedUsd);
});

const SPLIT = { ...DEFAULTS, effortSplitsCache: true };

test('a new model for your model starts its cache cold, and so does a new effort where efforts split the cache', () => {
  for (const config of [DEFAULTS, SPLIT]) {
    const { state } = session(
      OPUS,
      [
        [OPUS, { write: 40_000 }],
        [HAIKU, { read: 40_000, write: 2_000 }],
      ],
      { config },
    );
    const next = { usage: usage({ write: 45_000 }), served: HAIKU, ttl: '5m', now: 3 * MINUTE };
    const cold = (yours) => compareReply(config, null, { ...next, yours });
    const changed = [SONNET, ...(config === SPLIT ? [OPUS_MEDIUM] : [])];
    for (const yours of changed) assert.deepEqual(compareReply(config, state, { ...next, yours }), cold(yours));
    const kept = [{ ...OPUS, model: 'claude-opus-5-5[1m]' }, ...(config === SPLIT ? [] : [OPUS_MEDIUM])];
    for (const yours of kept)
      assert.ok(compareReply(config, state, { ...next, yours }).reply.yoursUsd < cold(OPUS).reply.yoursUsd);
  }
});

test('the same model at another effort is no price difference: your cache, or only the cache a split switch rewrote', () => {
  const replies = (config) =>
    session(
      OPUS,
      [
        [OPUS, { write: 40_000 }],
        [OPUS_MEDIUM, { write: 43_000 }],
      ],
      { config },
    ).replies[1];
  const split = replies(SPLIT);
  assert.deepEqual([split.cheaperUsd, split.strongerUsd], [0, 0]);
  assert.ok(split.switchUsd > 0);
  const shared = replies(DEFAULTS);
  assert.deepEqual([shared.cheaperUsd, shared.strongerUsd, shared.switchUsd], [0, 0, 0]);
  assert.equal(shared.yoursUsd, shared.routedUsd);
});

test('Haiku above 100K prompt tokens prices every token at five times, your side included', () => {
  near(requestUsd(DEFAULTS.models.haiku, { input: 0, cacheRead: 100_000, cacheWrite: 0, output: 1_000 }, 1.25), 0.0015);
  near(
    requestUsd(DEFAULTS.models.haiku, { input: 0, cacheRead: 100_001, cacheWrite: 0, output: 1_000 }, 1.25),
    (0.05 * 100_001 + 2.5 * 1_000) / 1e6,
  );
  const { replies } = session(HAIKU, [
    [HAIKU, { write: 150_000 }],
    [OPUS, { write: 151_000 }],
  ]);
  near(replies[1].yoursUsd, (0.5 * (2 + 998 * 1.25) + 0.05 * 150_002 + 2.5 * 500) / 1e6);
});

test('a model without a configured price is not compared, and the cache simulation goes on', () => {
  const result = compareReply(DEFAULTS, null, {
    usage: usage({ write: 1_000 }),
    served: { model: 'gpt-x', effort: null },
    yours: OPUS,
    ttl: '5m',
    now: 0,
  });
  assert.equal(result.reply, null);
  assert.deepEqual(result.state, { total: 1_002, at: 0, onYours: false, ...OPUS });
  const unpriced = loadConfig({ userFile: { models: { opus: { output: undefined } } } });
  assert.equal(
    compareReply(unpriced, null, { usage: usage(), served: OPUS, yours: OPUS, ttl: '5m', now: 0 }).reply,
    null,
  );
  assert.equal(compareReply(DEFAULTS, null, { usage: { output_tokens: 1 }, served: OPUS, yours: OPUS }).reply, null);
});

test('a reply with an unknown cache lifetime is not compared, and the cache simulation goes on', () => {
  const result = compareReply(DEFAULTS, null, {
    usage: usage({ write: 1_000 }),
    served: HAIKU,
    yours: OPUS,
    ttl: null,
    now: 0,
  });
  assert.equal(result.reply, null);
  assert.deepEqual(result.state, { total: 1_002, at: 0, onYours: false, ...OPUS });
});

test('a served snapshot or a context suffix prices as its configured model', () => {
  for (const [id, expected] of [
    ['claude-opus-5-5', 'claude-opus-5-5'],
    ['claude-opus-5-5-20260101', 'claude-opus-5-5'],
    ['claude-opus-5-5[1m]', 'claude-opus-5-5'],
    ['claude-opus-5-5-preview', null],
    ['opus', null],
    [null, null],
  ])
    assert.equal(modelSpec(DEFAULTS, id)?.id ?? null, expected, String(id));
});

test('the cache lifetime follows Claude Code: forced 5m, then the env, the setting, the 1h flag, the plan', () => {
  const none = { force5m: undefined, envTtl: undefined, settingTtl: undefined, enable1h: undefined, subscriber: false };
  for (const [overrides, expected] of [
    [{}, '5m'],
    [{ subscriber: true }, '1h'],
    [{ enable1h: '1' }, '1h'],
    [{ enable1h: '0' }, '5m'],
    [{ settingTtl: '5m', subscriber: true }, '5m'],
    [{ envTtl: '1h', settingTtl: '5m' }, '1h'],
    [{ envTtl: '2h', subscriber: true }, '1h'],
    [{ force5m: 'true', envTtl: '1h', subscriber: true }, '5m'],
  ])
    assert.equal(sessionCacheTtl({ ...none, ...overrides }), expected, JSON.stringify(overrides));
});

test('the readout rounds to cents so the shown parts add up to the shown difference', () => {
  const totals = {
    ...emptyTotals(),
    replies: EARLY_REPLIES,
    routedUsd: 6.404,
    yoursUsd: 8.236,
    cheaperUsd: -2.314,
    strongerUsd: 0.004,
    switchUsd: 0.478,
  };
  const r = readout(totals);
  assert.deepEqual(
    [r.routedUsd, r.yoursUsd, r.differenceUsd, r.cheaperUsd, r.strongerUsd, r.early],
    [6.4, 8.24, -1.84, -2.31, 0, false],
  );
  near(r.switchUsd, 0.47);
  near(r.share, -184 / 824);
  assert.equal(readout({ ...totals, replies: EARLY_REPLIES - 1 }).early, true);
  assert.equal(readout(emptyTotals()).share, null);
});

test('rounding never flips a part’s sign or shows a part the session did not have', () => {
  for (const [usd, expected] of [
    [{ routedUsd: 0.094, yoursUsd: 0.098, cheaperUsd: -0.004, strongerUsd: 0, switchUsd: 0 }, [-0.01, -0.01, 0, 0]],
    [{ routedUsd: 0.096, yoursUsd: 0.098, cheaperUsd: -0.002, strongerUsd: 0, switchUsd: 0 }, [0, 0, 0, 0]],
    [{ routedUsd: 0.109, yoursUsd: 0.1, cheaperUsd: -0.001, strongerUsd: 0.006, switchUsd: 0.004 }, [0.01, 0, 0.01, 0]],
    [{ routedUsd: 0.1049, yoursUsd: 0.0989, cheaperUsd: 0, strongerUsd: 0.006, switchUsd: 0 }, [0, 0, 0, 0]],
    [{ routedUsd: 0.094, yoursUsd: 0.105, cheaperUsd: -0.004, strongerUsd: 0.005, switchUsd: 0 }, [-0.02, -0.02, 0, 0]],
    [{ routedUsd: 0.10928, yoursUsd: 0.10434, cheaperUsd: 0, strongerUsd: 0.00494, switchUsd: 0 }, [0.01, 0, 0.01, 0]],
    [{ routedUsd: 0.0951, yoursUsd: 0.1004, cheaperUsd: -0.0053, strongerUsd: 0, switchUsd: 0 }, [0, 0, 0, 0]],
  ]) {
    const r = readout({ ...emptyTotals(), replies: EARLY_REPLIES, ...usd });
    const shown = [r.differenceUsd, r.cheaperUsd, r.strongerUsd, r.switchUsd].map((part) => part + 0);
    assert.deepEqual(shown, expected, JSON.stringify(usd));
  }
});

test('a missing or corrupted savings store reads as empty, and a whole one as written', () => {
  for (const value of [
    undefined,
    null,
    'x',
    [],
    { version: 2 },
    { ...emptySavingsStore(), replies: -1 },
    { ...emptySavingsStore(), x: 1 },
  ])
    assert.deepEqual(readSavingsStore(value), emptySavingsStore());
  const kept = { ...emptySavingsStore(), since: 5, replies: 1, routedUsd: 1, yoursUsd: 3, cheaperUsd: -2 };
  assert.deepEqual(readSavingsStore(kept), kept);
});

test('the totals kept across sessions add up every session’s record since the earliest, skipping a corrupted one', () => {
  const record = (since, replies, usd) => ({
    ...emptySavingsStore(),
    since,
    replies,
    routedUsd: usd,
    yoursUsd: 2 * usd,
    cheaperUsd: -usd,
  });
  assert.deepEqual(mergeSavingsStores([record(9, 2, 1), { version: 9 }, record(5, 3, 0.5), undefined]), {
    ...record(5, 5, 1.5),
  });
  assert.deepEqual(mergeSavingsStores([]), emptySavingsStore());
  assert.deepEqual(mergeSavingsStores([record(9, 2, 1), record(5, 3, 0.5)], 7), record(9, 2, 1));
  assert.deepEqual(mergeSavingsStores([record(9, 2, 1)], 9), record(9, 2, 1));
});

test('a model named after an Object method keeps its own session totals and every other model’s', () => {
  const reply = { routedUsd: 1, yoursUsd: 2, cheaperUsd: -1, strongerUsd: 0, switchUsd: 0, strongerModel: null };
  const byModel = addReplies({}, { toString: reply, opus: reply });
  assert.deepEqual(
    [byModel.toString.replies, byModel.opus.replies, Object.keys(byModel)],
    [1, 1, ['toString', 'opus']],
  );
});

test('a reply that cannot be priced against your model, one named after an Object method, is no reply', () => {
  const config = {
    ...DEFAULTS,
    models: { ...DEFAULTS.models, toString: { ...DEFAULTS.models.haiku, id: 'claude-toy-1' } },
  };
  const input = { usage: usage({ write: 1000 }), served: OPUS, effort: 'high', now: 0, yours: 'claude-toy-1' };
  assert.equal(compareModels(config, {}, { ...input, ttl: 'never' }).reply, null);
  assert.equal(compareModels(config, {}, { ...input, ttl: '1h' }).reply.routedUsd > 0, true);
  const named = { ...DEFAULTS, models: { ...DEFAULTS.models, null: { ...DEFAULTS.models.haiku, id: 'claude-toy-2' } } };
  assert.equal(compareModels(named, {}, { ...input, ttl: '1h', yours: 'claude-fable-5-1' }).reply, null);
});

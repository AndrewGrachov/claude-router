import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULTS, loadConfig, resolveRoute } from '../lib/config.mjs';
import * as native from '../lib/cost.mjs';
import { decide, initialState } from '../lib/policy.mjs';
import { advice as adviceOf } from './helpers.mjs';

const now = 1_000_000;
const facts = {
  effort: 'xhigh',
  lastRoute: 'medium',
  lastRequest: { tokens: 150_000, outputTokens: 1500 },
  models: { 'claude-sonnet-5-5': { prefixTokens: 148_000, lastAt: now } },
};
const tiny = {
  id: 'claude-haiku-4-5',
  input: 1,
  output: 5,
  cacheRead: 0.1,
  contextWindow: 200_000,
  billing: 'plan',
  efforts: [],
};
const SONNET_MEDIUM = loadConfig({
  userFile: { models: { tiny }, routes: { medium: { model: 'sonnet', effort: 'xhigh' }, micro: { model: 'tiny' } } },
});
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);

test('native cache evidence is only a five-minute fresh estimate, never an inferred hour', () => {
  for (const [age, expected] of [
    [0, 'fresh'],
    [269_999, 'fresh'],
    [270_000, 'unknown'],
    [600_000, 'unknown'],
  ]) {
    assert.equal(native.cacheState({ prefixTokens: 100, lastAt: now - age }, now, DEFAULTS.cache), expected);
  }
  assert.equal(native.cacheState({ prefixTokens: 0, lastAt: now }, now, DEFAULTS.cache), 'unknown');
  assert.equal(native.cacheState({ prefixTokens: 100, lastAt: now + 1 }, now, DEFAULTS.cache), 'unknown');
});

test('cache identity preserves model snapshots and separates efforts only where they split the cache', () => {
  const config = loadConfig({
    userFile: {
      models: { haiku: { id: 'claude-haiku-5-5-20260101' } },
      routes: { low: { model: 'sonnet', effort: null } },
    },
  });
  const split = (cfg) => ({ ...cfg, effortSplitsCache: true });
  const key = (cfg, tier, sent) => native.routeCacheKey(cfg, resolveRoute(cfg, tier), sent);
  for (const [cfg, tier, sent, shared, separate] of [
    [config, 'micro', 'xhigh', 'claude-haiku-5-5-20260101', 'claude-haiku-5-5-20260101@medium'],
    [DEFAULTS, 'low', 'medium', 'claude-haiku-5-5', 'claude-haiku-5-5@high'],
    [SONNET_MEDIUM, 'micro', 'xhigh', 'claude-haiku-4-5', 'claude-haiku-4-5'],
    [config, 'medium', 'low', 'claude-opus-5-5', 'claude-opus-5-5@medium'],
    [SONNET_MEDIUM, 'medium', 'low', 'claude-sonnet-5-5', 'claude-sonnet-5-5@xhigh'],
    [config, 'low', 'medium', 'claude-sonnet-5-5', 'claude-sonnet-5-5@medium'],
    [config, 'low', 2000, 'claude-sonnet-5-5', 'claude-sonnet-5-5@2000'],
  ]) {
    assert.equal(key(cfg, tier, sent), shared, `${tier} ${sent}`);
    assert.equal(key(split(cfg), tier, sent), separate, `${tier} ${sent} split`);
  }
});

test('only the models that keep one cache across efforts share it, and never where the provider splits it', () => {
  for (const [id, shares] of [
    ['claude-opus-5-5', true],
    ['claude-sonnet-5-5[1m]', true],
    ['claude-haiku-5-5-20260101', true],
    ['claude-fable-5-1', true],
    ['claude-haiku-4-5', false],
    ['claude-opus-5', false],
    [undefined, false],
  ]) {
    assert.equal(native.effortSharesCache(DEFAULTS, id), shares, String(id));
    assert.equal(native.effortSharesCache({ ...DEFAULTS, effortSplitsCache: true }, id), false, `${id} split`);
  }
  assert.equal(native.cacheKey(DEFAULTS, 'claude-haiku-4-5', 'high'), 'claude-haiku-4-5@high');
  assert.equal(native.cacheKey(DEFAULTS, 'claude-haiku-5-5', null), 'claude-haiku-5-5');
});

test('every default model is checked against the shared-cache list', () => {
  // A new default model needs a decision: add it to EFFORT_SHARED_CACHE when its docs say efforts share one cache.
  for (const [alias, { id }] of Object.entries(DEFAULTS.models))
    assert.equal(native.effortSharesCache(DEFAULTS, id), true, `${alias} ${id}`);
});

test('bounds distinguish observed cached prefix from generated and uncached tokens', () => {
  const bounds = native.inputBounds(SONNET_MEDIUM, resolveRoute(SONNET_MEDIUM, 'medium'), 151_500, facts, now);
  near(bounds.min, 0.0366);
  near(bounds.max, 0.0436);
  near(native.coldWriteUsd(SONNET_MEDIUM, 'tiny', 151_500), 0.303);
});

test('unknown TTL keeps an optimistic incumbent scenario and a cold candidate upper cost', () => {
  const later = now + 600_000;
  const [micro, medium] = ['micro', 'medium'].map((tier) => resolveRoute(SONNET_MEDIUM, tier));
  near(native.switchingTaxUsd(SONNET_MEDIUM, micro, medium, facts, later), 0.2664);
  near(native.downgradeTaxUsd(SONNET_MEDIUM, micro, medium, facts, later, 5), 0.1683);
  const estimate = native.switchEconomics(SONNET_MEDIUM, micro, medium, facts, later);
  near(estimate.nextTurnUsd, 0.2589);
  near(estimate.laterTurnUsd, -0.02265);
  assert.equal(estimate.paybackTurns, 12);
  assert.equal(native.cacheState(facts.models['claude-sonnet-5-5'], later, SONNET_MEDIUM.cache), 'unknown');
});

test('the default policy accounts for bounded native switching costs', () => {
  const advice = adviceOf('micro', { micro: 0.92, medium: 0.08 });
  const state = { ...initialState(), votes: [{ tier: 'micro', turn: 0 }] };
  // Low runs on the micro model too, so no tier between the choice and the incumbent takes the move.
  const config = loadConfig({
    userFile: {
      models: { tiny },
      routes: { medium: { model: 'sonnet', effort: 'xhigh' }, low: { model: 'tiny' }, micro: { model: 'tiny' } },
    },
  });
  const args = { config, facts, advice, state, baseline: 'medium', now };
  const original = decide(args);
  const bounded = decide({ ...args, costs: native });
  assert.deepEqual(original, bounded);
  assert.equal(bounded.tier, 'medium');
  assert.equal(bounded.reason, 'downgrade-pending');
  near(bounded.estimate.threshold, 0.9 + (0.08 * 0.1683) / 0.6683);
  assert.deepEqual(decide(args), original);
});

test('an all-credits policy with no plan fallback stays rather than returning an undefined tier', () => {
  const config = loadConfig({
    userFile: {
      models: { opus: { billing: 'credits' }, sonnet: { billing: 'credits' }, haiku: { billing: 'credits' } },
      policy: { cashCapUsd: 0 },
    },
  });
  const result = decide({
    config,
    facts,
    advice: adviceOf('high', { high: 1 }),
    state: initialState(),
    baseline: 'medium',
    now,
    costs: native,
  });
  assert.equal(result.tier, 'medium');
  assert.equal(result.reason, 'cash-gate');
});

test('a long-context model bills every rate at its multiplier only for prompts over the threshold', () => {
  const haiku = DEFAULTS.models.haiku;
  for (const [tokens, k] of [
    [0, 1],
    [100_000, 1],
    [100_001, 5],
    [400_000, 5],
  ])
    assert.deepEqual(
      native.ratesAt(haiku, tokens),
      { input: 0.1 * k, cacheRead: 0.01 * k, output: 0.5 * k },
      `${tokens}`,
    );
  assert.deepEqual(native.ratesAt(DEFAULTS.models.opus, 400_000), { input: 4, cacheRead: 0.2, output: 20 });
  assert.equal(native.ratesAt({ input: 1, cacheRead: 0.1 }, 10).output, undefined);
});

test('a cold write to Haiku above 100K tokens is five times the short-prompt rate', () => {
  near(native.coldWriteUsd(DEFAULTS, 'haiku', 100_000), 0.02);
  near(native.coldWriteUsd(DEFAULTS, 'haiku', 200_000), 0.2);
});

test('effort clamping keeps supported levels and bounds unsupported levels', () => {
  for (const [wanted, supported, expected] of [
    ['xhigh', ['low', 'medium', 'high', 'max'], 'high'],
    ['max', ['low', 'medium', 'high', 'max'], 'max'],
    ['low', ['medium'], 'medium'],
    [undefined, ['low'], null],
    ['high', [], null],
  ])
    assert.equal(native.clampEffort(wanted, supported), expected);
});

test('context estimate uses both the previous output and the current measurement', () => {
  assert.equal(native.nextContextTokens({ lastRequest: { tokens: 100, outputTokens: 30 }, contextTokens: 120 }), 130);
  assert.equal(native.nextContextTokens({ lastRequest: { tokens: 100, outputTokens: 30 }, contextTokens: 160 }), 160);
  assert.equal(native.nextContextTokens({ contextTokens: 42 }), 42);
  assert.equal(native.nextContextTokens({}), 0);
});

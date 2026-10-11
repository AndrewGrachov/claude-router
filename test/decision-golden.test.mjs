import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { ACTIVITIES, loadConfig, TIERS } from '../lib/config.mjs';
import { decide, initialState } from '../lib/policy.mjs';
import { chooseRoute, continueRoute, emptyLoop } from '../lib/route.mjs';
import { advice, T0 } from './helpers.mjs';

// Routing decisions pinned across refactors. Regenerate with GOLDEN_WRITE=1 node --test test/decision-golden.test.mjs
// only for an intended decision change, and say why in the commit.
const FIXTURE = new URL('./fixtures/decision-golden.json', import.meta.url);

const NOW = T0 + 1_000_000;
const WARM = NOW - 60_000;
const STALE = NOW - 400_000;
const NATIVE = 'claude-haiku-5-5';
const tiny = {
  id: 'claude-haiku-4-5',
  input: 1,
  output: 5,
  cacheRead: 0.1,
  contextWindow: 200_000,
  billing: 'plan',
  efforts: [],
};
// The record is the 1.5 tier routing, so the configs route with activity routing off; the tests below run the same
// scenarios in the other modes.
const OFF = { activityRouting: 'off' };
const CONFIGS = {
  defaults: loadConfig({ userFile: OFF }),
  // Window diversity, a route that keeps the session effort and a model with no effort field.
  mixed: loadConfig({
    userFile: {
      ...OFF,
      models: { tiny },
      routes: { micro: { model: 'tiny' }, low: { model: 'sonnet', effort: null } },
    },
  }),
  metered: loadConfig({ userFile: { ...OFF, models: { opus: { billing: 'credits', input: 10 } } } }),
  allCredits: loadConfig({
    userFile: {
      ...OFF,
      models: { opus: { billing: 'credits' }, sonnet: { billing: 'credits' }, haiku: { billing: 'credits' } },
      policy: { cashCapUsd: 0 },
    },
  }),
};

// The cache key a tier's route uses, written out here so the fixture does not lean on the code under test: one cache
// per effort, except on the models that keep one cache across efforts (code.claude.com/docs/en/prompt-caching).
const EFFORT_SHARED = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'];
function keyOf(config, tier, sent) {
  const { model, effort } = config.routes[tier];
  const spec = config.models[model];
  const used = spec.efforts.length ? (effort ?? sent) : null;
  return used && !EFFORT_SHARED.includes(spec.id) ? `${spec.id}@${used}` : spec.id;
}

const SHAPES = {
  confident: (c) => ({ [c]: 0.97, uncertain: 0.03 }),
  split: (c) => ({ [c]: 0.8, [TIERS[TIERS.indexOf(c) === 0 ? 1 : TIERS.indexOf(c) - 1]]: 0.2 }),
  weak: (c) => ({ micro: 0.15, low: 0.15, medium: 0.15, high: 0.15, uncertain: 0.15, [c]: 0.4 }),
};
const adviceFor = (choice, shape, continuation = 0) =>
  choice === 'uncertain'
    ? advice('uncertain', { uncertain: 0.9, low: 0.1 }, { continuation })
    : advice(choice, SHAPES[shape](choice), { continuation });

function cacheModels(config, { cache, lastRoute, choice, tokens, effort }) {
  const entry = (at) => ({ lastAt: at, prefixTokens: tokens });
  const warm = {
    none: [],
    incumbent: [[lastRoute, WARM]],
    candidate: [[choice, WARM]],
    both: [
      [lastRoute, WARM],
      [choice, WARM],
    ],
    stale: [[lastRoute, STALE]],
  }[cache];
  return Object.fromEntries(
    warm.filter(([tier]) => TIERS.includes(tier)).map(([tier, at]) => [keyOf(config, tier, effort), entry(at)]),
  );
}

function scenario(config, s) {
  const {
    lastRoute = 'low',
    choice = 'low',
    shape = 'confident',
    prior = false,
    cache = 'incumbent',
    tokens = 20_000,
    output = 1_500,
    effort = 'medium',
    continuation = 0,
    noAdvice = false,
    failure = null,
    pin = null,
    contextKnown = true,
    historyMeasured = true,
    availableModels,
    ineligible = [],
    resolutions = {},
    factsRoute = lastRoute,
    nativeModel = NATIVE,
    activity,
  } = s;
  const state =
    s.state ?? (prior ? { ...initialState(), turn: 1, votes: [{ tier: choice, turn: 1 }] } : initialState());
  const models = s.models ?? cacheModels(config, { cache, lastRoute, choice, tokens, effort });
  const lastRequest = {
    model: config.models[config.routes[lastRoute].model].id,
    tokens,
    outputTokens: output,
    cacheReadTokens: tokens,
    cacheWriteTokens: 0,
    at: WARM,
  };
  const loop = {
    ...emptyLoop(config, nativeModel),
    lastRoute,
    lastActivity: null,
    state,
    models,
    resolutions,
    lastRequest,
    historyMeasured,
    ineligible,
  };
  const facts = {
    lastRoute: factsRoute,
    lastRequest,
    models,
    effort,
    failure,
    contextTokens: tokens,
    continuation: false,
    prompt: 'x',
    turns: [],
    pin: null,
    turnKey: 't',
    historyMeasured,
  };
  const tierAdvice = noAdvice ? null : adviceFor(choice, shape, continuation);
  const input = {
    facts,
    advice: tierAdvice && activity ? { ...tierAdvice, activity } : tierAdvice,
    pin,
    nativeModel,
    now: NOW,
  };
  return { loop, input: { ...input, contextKnown, availableModels } };
}

const record = (loop) => {
  const { tier, reason, model, effort, state, estimate, comparison } = loop.decision;
  return { tier, reason, model, effort, votes: state.votes.length, estimate, comparison, lastRoute: loop.lastRoute };
};

// `configs` and `activity` (an activity answer added to every advice) run the same scenarios in another mode; `view`
// reads each resulting loop.
function scenarios({ configs = CONFIGS, activity, view = record } = {}) {
  const routed = (configName, s) => {
    const config = configs[configName];
    const { loop, input } = scenario(config, { ...s, activity });
    return view(chooseRoute(config, loop, input));
  };
  const out = {};
  const add = (name, value) => {
    assert.ok(!Object.hasOwn(out, name), name);
    out[name] = value;
  };
  for (const configName of ['defaults', 'mixed']) {
    for (const lastRoute of TIERS) {
      for (const choice of [...TIERS, 'uncertain']) {
        for (const shape of Object.keys(SHAPES))
          for (const prior of [false, true])
            add(
              `${configName} ${lastRoute}->${choice} ${shape}${prior ? ' prior-vote' : ''}`,
              routed(configName, { lastRoute, choice, shape, prior }),
            );
        if (choice === 'uncertain') continue;
        for (const cache of ['none', 'candidate', 'both', 'stale'])
          add(
            `${configName} ${lastRoute}->${choice} cache-${cache}`,
            routed(configName, { lastRoute, choice, prior: true, cache }),
          );
        for (const tokens of [150_000, 600_000, 900_000])
          add(
            `${configName} ${lastRoute}->${choice} context-${tokens}`,
            routed(configName, { lastRoute, choice, prior: true, cache: 'both', tokens }),
          );
        add(
          `${configName} ${lastRoute}->${choice} continuation`,
          routed(configName, { lastRoute, choice, prior: true, continuation: 0.9 }),
        );
        add(
          `${configName} ${lastRoute}->${choice} weak-continuation`,
          routed(configName, { lastRoute, choice, prior: true, continuation: 0.5 }),
        );
        add(`${configName} ${lastRoute} pin-${choice}`, routed(configName, { lastRoute, choice, pin: choice }));
        add(
          `${configName} ${lastRoute} pin-${choice} large`,
          routed(configName, { lastRoute, choice, pin: choice, tokens: 600_000 }),
        );
      }
      add(`${configName} ${lastRoute} no-advice`, routed(configName, { lastRoute, noAdvice: true }));
      add(
        `${configName} ${lastRoute} escalation`,
        routed(configName, { lastRoute, choice: 'micro', failure: { signature: 'boom', index: 3 } }),
      );
      add(
        `${configName} ${lastRoute} escalation already-handled`,
        routed(configName, {
          lastRoute,
          choice: 'micro',
          prior: true,
          failure: { signature: 'boom', index: 3 },
          state: { ...initialState(), turn: 4, escalatedSignature: 'boom' },
        }),
      );
      add(
        `${configName} ${lastRoute} hold`,
        routed(configName, { lastRoute, choice: 'micro', state: { ...initialState(), turn: 1, holdUntilTurn: 3 } }),
      );
    }
  }
  // Session effort through a route that keeps it: none, a level, and a token budget.
  for (const effort of [null, 'high', 2000])
    for (const [lastRoute, choice] of [
      ['low', 'micro'],
      ['micro', 'low'],
      ['high', 'low'],
      ['low', 'medium'],
    ])
      for (const cache of ['incumbent', 'both'])
        add(
          `mixed effort-${effort} ${lastRoute}->${choice} cache-${cache}`,
          routed('mixed', { lastRoute, choice, prior: true, cache, effort, tokens: 150_000 }),
        );
  // Credits billing: a cold write above the cap is blocked, a warm one passes.
  for (const lastRoute of TIERS)
    for (const choice of TIERS)
      for (const cache of ['none', 'candidate'])
        for (const tokens of [20_000, 150_000])
          add(
            `metered ${lastRoute}->${choice} cache-${cache} context-${tokens}`,
            routed('metered', { lastRoute, choice, prior: true, cache, tokens }),
          );
  for (const lastRoute of TIERS) {
    add(
      `metered ${lastRoute} escalation`,
      routed('metered', { lastRoute, failure: { signature: 'boom', index: 3 }, tokens: 150_000 }),
    );
    add(`allCredits ${lastRoute}->high`, routed('allCredits', { lastRoute, choice: 'high', prior: true }));
    add(`allCredits ${lastRoute}->micro`, routed('allCredits', { lastRoute, choice: 'micro', prior: true }));
    add(
      `allCredits ${lastRoute} escalation`,
      routed('allCredits', { lastRoute, failure: { signature: 'boom', index: 3 } }),
    );
  }
  // An unknown incumbent falls back to the baseline.
  add('defaults no incumbent ->high', routed('defaults', { choice: 'high', prior: true, factsRoute: null }));
  add('defaults no incumbent ->micro', routed('defaults', { choice: 'micro', prior: true, factsRoute: null }));
  // Context the router cannot measure: a smaller window is not trusted.
  for (const lastRoute of ['low', 'medium'])
    for (const [contextKnown, historyMeasured] of [
      [false, true],
      [true, false],
      [false, false],
    ]) {
      const flags = `known-${contextKnown} measured-${historyMeasured}`;
      add(
        `mixed ${lastRoute}->micro ${flags}`,
        routed('mixed', { lastRoute, choice: 'micro', prior: true, cache: 'both', contextKnown, historyMeasured }),
      );
      add(
        `mixed ${lastRoute} pin-micro ${flags}`,
        routed('mixed', { lastRoute, choice: 'micro', pin: 'micro', contextKnown, historyMeasured }),
      );
    }
  // A history with no measured reply yet: one vote, no cache evidence.
  for (const configName of ['defaults', 'mixed'])
    for (const lastRoute of TIERS)
      for (const choice of TIERS)
        if (choice !== lastRoute)
          add(
            `${configName} fresh-history ${lastRoute}->${choice}`,
            routed(configName, { lastRoute, choice, cache: 'none', historyMeasured: false }),
          );
  // Models the session cannot use, by availability list or by an observed context overflow.
  for (const [label, extra] of [
    ['available-sonnet', { availableModels: ['sonnet'] }],
    ['available-haiku', { availableModels: ['haiku'] }],
    ['available-default', { availableModels: ['default'] }],
    ['available-none', { availableModels: [] }],
    ['ineligible-opus', { ineligible: ['claude-opus-5-5'] }],
    ['ineligible-haiku', { ineligible: ['claude-haiku-5-5'] }],
  ])
    for (const configName of ['defaults', 'mixed'])
      for (const [lastRoute, choice, pin] of [
        ['low', 'high', null],
        ['high', 'micro', null],
        ['low', 'high', 'high'],
        ['medium', 'micro', 'micro'],
      ])
        add(
          `${configName} ${label} ${lastRoute}->${choice}${pin ? ' pinned' : ''}`,
          routed(configName, {
            lastRoute,
            choice,
            pin,
            prior: true,
            cache: 'both',
            nativeModel: 'claude-sonnet-5-5',
            ...extra,
          }),
        );
  // A served snapshot id: its warm cache prices under the resolved id.
  for (const [lastRoute, choice] of [
    ['high', 'medium'],
    ['low', 'high'],
    ['medium', 'micro'],
  ])
    add(
      `defaults resolved-snapshot ${lastRoute}->${choice}`,
      routed('defaults', {
        lastRoute,
        choice,
        prior: true,
        tokens: 150_000,
        resolutions: { 'claude-opus-5-5': 'claude-opus-5-5-20260101' },
        models: {
          'claude-opus-5-5-20260101': { lastAt: WARM, prefixTokens: 150_000 },
          'claude-haiku-5-5': { lastAt: WARM, prefixTokens: 150_000 },
        },
      }),
    );
  // A tool continuation keeps the turn's route unless the context or the model list forbids it.
  for (const configName of ['defaults', 'mixed'])
    for (const tier of TIERS)
      for (const [label, extra] of [
        ['same', { contextTokens: 20_000, contextKnown: true }],
        ['grown', { contextTokens: 600_000, contextKnown: true }],
        ['grown-unknown', { contextTokens: 600_000, contextKnown: false }],
        ['unavailable', { contextTokens: 20_000, contextKnown: true, availableModels: ['sonnet'] }],
      ]) {
        const config = configs[configName];
        const { loop, input } = scenario(config, { lastRoute: 'low', choice: tier, pin: tier, activity });
        const chosen = chooseRoute(config, loop, input);
        add(
          `${configName} continue pin-${tier} ${label}`,
          view(continueRoute(config, chosen, { nativeModel: NATIVE, effort: 'medium', ...extra })),
        );
      }
  // The session model a fresh loop starts from.
  for (const configName of ['defaults', 'mixed'])
    for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-haiku-4-5', 'gpt-x'])
      add(`${configName} empty-loop ${model}`, { lastRoute: emptyLoop(configs[configName], model).lastRoute });
  // decide() on its own, with the default costs.
  for (const lastRoute of TIERS)
    for (const choice of TIERS) {
      const config = configs.defaults;
      const { input } = scenario(config, { lastRoute, choice, prior: true, cache: 'both', tokens: 150_000, activity });
      const state = { ...initialState(), turn: 1, votes: [{ tier: choice, turn: 1 }] };
      const d = decide({ config, facts: input.facts, advice: input.advice, state, baseline: 'low', now: NOW });
      add(`decide ${lastRoute}->${choice}`, {
        tier: d.tier,
        reason: d.reason,
        votes: d.state.votes.length,
        estimate: d.estimate,
      });
    }
  return out;
}

// Rounded so float noise in the last bits of a price does not count as a change; JSON drops undefined fields.
const normalize = (value) =>
  JSON.parse(JSON.stringify(value, (_, v) => (typeof v === 'number' ? Math.round(v * 1e9) / 1e9 : v)));

const current = normalize(scenarios());
if (process.env.GOLDEN_WRITE === '1') {
  const lines = Object.entries(current).map(([name, value]) => `  ${JSON.stringify(name)}: ${JSON.stringify(value)}`);
  writeFileSync(FIXTURE, `{\n${lines.join(',\n')}\n}\n`);
}
const golden = JSON.parse(readFileSync(FIXTURE, 'utf8'));

test('the golden scenarios are the same set as recorded', () => {
  assert.deepEqual(Object.keys(current), Object.keys(golden));
});

test('every golden scenario decides the same tier, reason, model, effort, estimate and comparison', () => {
  for (const [name, expected] of Object.entries(golden)) assert.deepEqual(current[name], expected, name);
});

const inMode = (activityRouting, extra = () => ({})) =>
  Object.fromEntries(Object.entries(CONFIGS).map(([name, c]) => [name, { ...c, activityRouting, ...extra(c) }]));
const label = (choice) => ({ choice, probabilities: { [choice]: 0.9, uncertain: 0.1 } });
const LABELS = ['code', 'ops', 'docs', 'explore', 'uncertain'].map(label);

test('off ignores the activity answer and decides as recorded', () => {
  for (const activity of LABELS) {
    const off = normalize(scenarios({ configs: inMode('off'), activity }));
    for (const [name, expected] of Object.entries(golden))
      assert.deepEqual(off[name], expected, `${activity.choice}: ${name}`);
  }
});

test('on with overrides equal to the base routes decides as recorded: equal routes never switch', () => {
  const flat = (c) => ({ activities: Object.fromEntries(ACTIVITIES.map((a) => [a, { ...c.routes }])) });
  for (const activity of LABELS) {
    const on = normalize(scenarios({ configs: inMode('on', flat), activity }));
    for (const [name, expected] of Object.entries(golden))
      assert.deepEqual(on[name], expected, `${activity.choice}: ${name}`);
  }
});

// `on`, the default, also finds the session model among the overrides (plan §6). Without an activity answer it decides
// as recorded, except that a Haiku session on routes without Haiku starts at the ops cell. A fallback never takes the
// Sonnet cell's `code` label for a turn without one.
test('on without an activity answer decides as recorded, except where the session model is an override model', () => {
  const on = normalize(scenarios({ configs: inMode('on') }));
  const differs = Object.keys(golden).filter((name) => !isDeepStrictEqual(on[name], golden[name]));
  assert.deepEqual(differs, ['mixed empty-loop claude-haiku-5-5']);
  assert.equal(on['mixed empty-loop claude-haiku-5-5'].lastRoute, 'medium');
});

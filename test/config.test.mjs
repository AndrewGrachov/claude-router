import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  ACTIVITIES,
  ACTIVITY_MODES,
  ACTIVITY_VALUES,
  activeClassifier,
  CLASSIFIER_OPTIONS,
  DEFAULTS,
  editActivity,
  effectiveActivities,
  loadConfig,
  resolveRoute,
  supportedVersion,
  TIERS,
  tuningOf,
  withActivities,
  withClassifier,
  withClassifierTimeout,
  withRoutes,
  withTuning,
} from '../lib/config.mjs';
import { routeEffort } from '../lib/cost.mjs';

test('defaults load without a user file, with Jev as the classifier', () => {
  const config = loadConfig();
  assert.deepEqual(config.routes.low, { model: 'haiku', effort: 'high' });
  assert.equal(config.baselineTier, 'low');
  assert.equal(config.classifier, 'jev');
  assert.deepEqual(Object.keys(config.classifiers), ['jev', 'clef', 'clef-flash', 'clef-omni', 'openai', 'ollama']);
});

test('user file overrides merge deeply and keep the rest', () => {
  const config = loadConfig({
    userFile: {
      policy: { cashCapUsd: 2 },
      routes: { medium: { model: 'sonnet', effort: 'max' } },
      baselineTier: 'medium',
    },
  });
  assert.equal(config.policy.cashCapUsd, 2);
  assert.equal(config.policy.upgradeVotes, DEFAULTS.policy.upgradeVotes);
  assert.deepEqual(config.routes.medium, { model: 'sonnet', effort: 'max' });
  assert.equal(config.baselineTier, 'medium');
});

for (const [name, userFile, message] of [
  ['unknown route model', { routes: { high: { model: 'gpt' } } }, /not in models/],
  ['bad effort', { routes: { high: { model: 'opus', effort: 'ultra' } } }, /effort/],
  ['negative price', { models: { opus: { input: -1 } } }, /input/],
  ['bad efforts list', { models: { opus: { efforts: ['huge'] } } }, /efforts/],
  ['mass above 1', { policy: { downgradeMass: 1.5 } }, /downgradeMass/],
  ['zero votes', { policy: { upgradeVotes: 0 } }, /upgradeVotes/],
  ['bad baseline', { baselineTier: 'ultra' }, /baselineTier/],
]) {
  test(`rejects ${name}`, () => {
    assert.throws(() => loadConfig({ userFile }), message);
  });
}

const fromDisk = (json) => JSON.parse(json);

for (const [name, userFile, message] of [
  ['an unknown top-level key', { routs: {} }, /routs/],
  ['an unknown tier', { routes: { ultra: { model: 'opus' } } }, /routes\.ultra/],
  ['an unknown route key', { routes: { high: { model: 'opus', effrt: 'max' } } }, /routes\.high\.effrt/],
  ['an unknown model key', { models: { opus: { inputt: 1 } } }, /models\.opus\.inputt/],
  ['an unknown policy key', { policy: { upgradeSlop: 1 } }, /policy\.upgradeSlop/],
  ['an unknown cache key', { cache: { ttl: 1 } }, /cache\.ttl/],
  ['an unknown classifier key', { classifiers: { jev: { url: 'x' } } }, /classifiers\.jev\.url/],
  ['an unknown context key', { context: { turns: 3 } }, /context\.turns/],
  ['a __proto__ key at the top', fromDisk('{"__proto__": {"log": false}}'), /__proto__/],
  ['a __proto__ model alias', fromDisk('{"models": {"__proto__": {}}}'), /models\.__proto__/],
  ['a __proto__ ttl', fromDisk('{"cache": {"ttlMs": {"__proto__": 1}}}'), /cache\.ttlMs\.__proto__/],
  ['a constructor model alias', { models: { constructor: {} } }, /models\.constructor/],
  ['a route to an inherited property', { routes: { low: { model: 'constructor' } } }, /routes\.low\.model/],
  ['a route to toString', { routes: { low: { model: 'toString' } } }, /routes\.low\.model/],
  ['a section that is not an object', { routes: 'opus' }, /routes must be an object/],
  ['a section that is an array', { policy: [] }, /policy must be an object/],
  ['a non-finite upgradeSlope', { policy: { upgradeSlope: 'steep' } }, /policy\.upgradeSlope/],
  ['a negative upgradeSlope', { policy: { upgradeSlope: -0.1 } }, /policy\.upgradeSlope/],
  ['a zero upgradePivotUsd', { policy: { upgradePivotUsd: 0 } }, /policy\.upgradePivotUsd/],
  ['a non-finite downgradeSlope', { policy: { downgradeSlope: 'steep' } }, /policy\.downgradeSlope/],
  ['a zero downgradePivotUsd', { policy: { downgradePivotUsd: 0 } }, /policy\.downgradePivotUsd/],
  ['a zero downgradeHorizonTurns', { policy: { downgradeHorizonTurns: 0 } }, /policy\.downgradeHorizonTurns/],
  ['a fractional downgradeHorizonTurns', { policy: { downgradeHorizonTurns: 1.5 } }, /policy\.downgradeHorizonTurns/],
  ['a non-numeric downgradeHorizonTurns', { policy: { downgradeHorizonTurns: 'x' } }, /policy\.downgradeHorizonTurns/],
  ['an infinite cashCapUsd', fromDisk('{"policy": {"cashCapUsd": 1e999}}'), /policy\.cashCapUsd/],
  [
    'an infinite classifier timeout',
    fromDisk('{"classifiers": {"jev": {"timeoutMs": 1e999}}}'),
    /classifiers\.jev\.timeoutMs/,
  ],
  ['an empty classifier endpoint', { classifiers: { clef: { endpoint: '' } } }, /classifiers\.clef\.endpoint/],
  ['a non-http endpoint', { classifiers: { jev: { endpoint: 'file:///etc/hosts' } } }, /classifiers\.jev\.endpoint/],
  [
    'a cleartext endpoint off this machine',
    { classifiers: { jev: { endpoint: 'http://proxy.example/v1' } } },
    /classifiers\.jev\.endpoint/,
  ],
  [
    'a cleartext endpoint that only starts like localhost',
    { classifiers: { jev: { endpoint: 'http://localhost.example/v1' } } },
    /classifiers\.jev\.endpoint/,
  ],
  ['a stray brace in an endpoint', { classifiers: { jev: { endpoint: 'https://x/{Account}' } } }, /placeholders/],
  ['a non-string classifier model', { classifiers: { jev: { model: 5 } } }, /classifiers\.jev\.model/],
  ['a key option that is not a plugin option', { classifiers: { jev: { keyOption: 'house_key' } } }, /keyOption/],
  ['an unknown classifier API', { classifiers: { jev: { api: 'anthropic' } } }, /classifiers\.jev\.api/],
  [
    'an endpoint setting that is not a plugin option',
    { classifiers: { jev: { endpoint: 'https://x/{region}/decide' } } },
    /classifiers\.jev\.endpoint/,
  ],
  ['an empty label', { classifiers: { jev: { label: '' } } }, /classifiers\.jev\.label/],
  [
    'a new classifier without a label',
    { classifiers: { house: { endpoint: 'https://x', model: 'm', keyOption: 'k', timeoutMs: 1 } } },
    /classifiers\.house\.label/,
  ],
  ['an active classifier that is not configured', { classifier: 'gpt' }, /classifier is not in classifiers/],
  ['an active classifier on an inherited property', { classifier: 'toString' }, /classifier is not in classifiers/],
  ['a __proto__ classifier id', fromDisk('{"classifiers": {"__proto__": {}}}'), /classifiers\.__proto__/],
  ['the 1.1 jev section', { jev: { timeoutMs: 900 } }, /scripts\/migrate-config\.mjs/],
  ['a zero write multiplier', { cache: { writeMultiplier: { '5m': 0 } } }, /cache\.writeMultiplier\.5m/],
  ['a negative ttl', { cache: { ttlMs: { '1h': -1 } } }, /cache\.ttlMs\.1h/],
  ['a negative warm margin', { cache: { warmMarginMs: -1 } }, /cache\.warmMarginMs/],
  ['zero recent turns', { context: { recentTurns: 0 } }, /context\.recentTurns/],
  ['an unknown activity', { activities: { write: { low: { model: 'sonnet' } } } }, /activities\.write/],
  ['uncertain as an activity', { activities: { uncertain: {} } }, /activities\.uncertain/],
  ['an unknown activity tier', { activities: { code: { ultra: {} } } }, /activities\.code\.ultra/],
  ['an unknown override key', { activities: { code: { low: { effrt: 'max' } } } }, /activities\.code\.low\.effrt/],
  ['an activity that is not an object', { activities: { code: 'sonnet' } }, /activities\.code must be an object/],
  ['an override that is not an object', { activities: { code: { low: 'sonnet' } } }, /activities\.code\.low must/],
  ['a __proto__ activity', fromDisk('{"activities": {"__proto__": {}}}'), /activities\.__proto__/],
  [
    'an override to an unknown model',
    { activities: { ops: { low: { model: 'gpt' } } } },
    /activities\.ops\.low\.model/,
  ],
  [
    'an override to an inherited property',
    { activities: { ops: { low: { model: 'toString' } } } },
    /activities\.ops\.low\.model/,
  ],
  [
    'an override with a bad effort',
    { activities: { code: { high: { effort: 'ultra' } } } },
    /activities\.code\.high\.effort/,
  ],
  ['an unknown activity mode', { activityRouting: 'auto' }, /activityRouting must be one of off, on/],
  ['activityMass above 1', { policy: { activityMass: 1.5 } }, /policy\.activityMass/],
  ['a negative activityMass', { policy: { activityMass: -0.1 } }, /policy\.activityMass/],
  ['fractional text chars', { context: { maxTextChars: 1.5 } }, /context\.maxTextChars/],
  ['an unknown long-context key', { models: { haiku: { longContext: { over: 1 } } } }, /longContext\.over/],
  ['a long context that is not an object', { models: { haiku: { longContext: 5 } } }, /longContext must be/],
  ['a fractional long-context threshold', { models: { haiku: { longContext: { above: 1.5 } } } }, /above/],
  ['a zero long-context multiplier', { models: { haiku: { longContext: { multiplier: 0 } } } }, /multiplier/],
]) {
  test(`strict router.json rejects ${name} instead of ignoring it`, () => {
    assert.throws(() => loadConfig({ userFile }), message);
  });
}

for (const [name, userFile] of [
  ['an array', []],
  ['a string', 'opus'],
  ['a number', 5],
]) {
  test(`rejects a router.json that is ${name}`, () => {
    assert.throws(() => loadConfig({ userFile }), /router\.json must be an object/);
  });
}

test('a long-context surcharge merges per field, and null removes it', () => {
  assert.deepEqual(loadConfig({}).models.haiku.longContext, { above: 100_000, multiplier: 5 });
  const raised = loadConfig({ userFile: { models: { haiku: { longContext: { above: 200_000 } } } } });
  assert.deepEqual(raised.models.haiku.longContext, { above: 200_000, multiplier: 5 });
  assert.equal(loadConfig({ userFile: { models: { haiku: { longContext: null } } } }).models.haiku.longContext, null);
  assert.equal(loadConfig({}).models.opus.longContext, undefined);
});

test('error messages name the field, never the value', () => {
  for (const userFile of [
    { routes: { high: { model: 'secret-model' } } },
    { routes: { high: { model: 'opus', effort: 'secret-effort' } } },
    { activities: { code: { low: { model: 'secret-model' } } } },
    { activities: { code: { low: { effort: 'secret-effort' } } } },
    { activityRouting: 'secret-mode' },
  ]) {
    assert.throws(
      () => loadConfig({ userFile }),
      (error) => !/secret/.test(error.message),
    );
  }
});

test('the documented example and a new model alias pass', () => {
  const config = loadConfig({
    userFile: {
      routes: { low: { model: 'sonnet', effort: 'high' }, micro: { model: 'mine' } },
      classifiers: { jev: { timeoutMs: 2500 } },
      models: { mine: { id: 'm', input: 1, cacheRead: 0.1, contextWindow: 200_000, billing: 'credits', efforts: [] } },
      cache: { ttlMs: { '5m': 300_000 }, warmMarginMs: 0 },
    },
  });
  assert.equal(config.routes.micro.model, 'mine');
  assert.equal(config.cache.ttlMs['1h'], DEFAULTS.cache.ttlMs['1h']);
});

test('a null route effort keeps the session effort and overrides a default effort', () => {
  const config = loadConfig({ userFile: { routes: { high: { model: 'opus', effort: null } } } });
  assert.equal(config.routes.high.effort, null);
});

test('withRoutes writes only the routes and baseline that differ from the defaults', () => {
  const defaults = { routes: structuredClone(DEFAULTS.routes), baselineTier: DEFAULTS.baselineTier };
  const edit = (tier, route) => ({ ...defaults, routes: { ...defaults.routes, [tier]: route } });
  for (const [name, file, draft, expected] of [
    [
      'defaults remove overrides',
      { routes: { low: { model: 'opus' } }, classifiers: { jev: { timeoutMs: 900 } } },
      defaults,
      { classifiers: { jev: { timeoutMs: 900 } } },
    ],
    [
      'changed model and effort',
      {},
      edit('medium', { model: 'sonnet', effort: 'xhigh' }),
      { routes: { medium: { model: 'sonnet', effort: 'xhigh' } } },
    ],
    [
      'session effort over a default effort',
      {},
      edit('high', { model: 'opus', effort: null }),
      { routes: { high: { model: 'opus', effort: null } } },
    ],
    [
      'the Sonnet ladder of 1.3',
      {},
      {
        ...defaults,
        routes: {
          ...defaults.routes,
          low: { model: 'sonnet', effort: null },
          micro: { model: 'haiku', effort: 'low' },
        },
      },
      { routes: { low: { model: 'sonnet', effort: null }, micro: { model: 'haiku', effort: 'low' } } },
    ],
    ['baseline', { baselineTier: 'micro' }, { ...defaults, baselineTier: 'medium' }, { baselineTier: 'medium' }],
  ]) {
    const loaded = loadConfig({ userFile: file });
    const written = withRoutes(file, { ...draft, base: { routes: loaded.routes, baselineTier: loaded.baselineTier } });
    assert.deepEqual(written, expected, name);
    loadConfig({ userFile: written });
  }
});

test('withRoutes keeps router.json edits made on disk after the session loaded it', () => {
  const base = loadConfig({});
  const draft = {
    routes: { ...structuredClone(DEFAULTS.routes), micro: { model: 'sonnet', effort: null } },
    baselineTier: DEFAULTS.baselineTier,
    base: { routes: base.routes, baselineTier: base.baselineTier },
  };
  const onDisk = { routes: { high: { model: 'sonnet' } }, baselineTier: 'medium' };
  assert.deepEqual(withRoutes(onDisk, draft), {
    routes: { micro: { model: 'sonnet', effort: null }, high: { model: 'sonnet' } },
    baselineTier: 'medium',
  });
});

test('withTuning writes only the tuning values the draft changed and keeps edits made on disk', () => {
  const defaults = tuningOf(loadConfig({}));
  for (const [name, onDisk, draft, saved, expected] of [
    [
      'a changed value joins the edits on disk',
      { classifiers: { jev: { timeoutMs: 900 } }, policy: { downgradeVotes: 3 } },
      { ...defaults, horizon: 10 },
      defaults,
      { classifiers: { jev: { timeoutMs: 900 } }, policy: { downgradeVotes: 3, downgradeHorizonTurns: 10 } },
    ],
    [
      'a value set back to its default is removed',
      { policy: { downgradeVotes: 3, upgradeVotes: 3 } },
      { ...defaults, downgradeVotes: 2 },
      { ...defaults, downgradeVotes: 3 },
      { policy: { upgradeVotes: 3 } },
    ],
    [
      'the last override removed drops its section',
      { policy: { cashCapUsd: 5 } },
      defaults,
      { ...defaults, cashCapUsd: 5 },
      {},
    ],
  ]) {
    assert.deepEqual(withTuning(onDisk, draft, saved), expected, name);
  }
});

test('a classifier can be selected, partly overridden or added', () => {
  const house = {
    label: 'House',
    endpoint: 'https://gateway.example/{cloudflare_account_id}/clef',
    model: 'clef',
    keyOption: 'cloudflare_api_token',
    timeoutMs: 800,
  };
  for (const [name, userFile, id, expected] of [
    ['the default', null, 'jev', DEFAULTS.classifiers.jev],
    ['Clef Flash', { classifier: 'clef-flash' }, 'clef-flash', DEFAULTS.classifiers['clef-flash']],
    [
      'a built-in with a longer deadline',
      { classifier: 'clef', classifiers: { clef: { timeoutMs: 4000 } } },
      'clef',
      { ...DEFAULTS.classifiers.clef, timeoutMs: 4000 },
    ],
    ['a new one', { classifier: 'house', classifiers: { house } }, 'house', { api: 'system-one', ...house }],
  ]) {
    const config = loadConfig({ userFile });
    assert.equal(config.classifier, id, name);
    assert.deepEqual(activeClassifier(config), expected, name);
    assert.deepEqual(config.classifiers.jev, DEFAULTS.classifiers.jev, name);
  }
});

test('withClassifier writes only a choice that differs from the default', () => {
  for (const [name, file, id, expected] of [
    ['a new choice', { policy: { cashCapUsd: 1 } }, 'clef', { policy: { cashCapUsd: 1 }, classifier: 'clef' }],
    ['a changed choice', { classifier: 'clef' }, 'clef-flash', { classifier: 'clef-flash' }],
    ['back to the default', { classifier: 'clef', routes: {} }, 'jev', { routes: {} }],
  ]) {
    const written = withClassifier(file, id);
    assert.deepEqual(written, expected, name);
    assert.equal(loadConfig({ userFile: written }).classifier, id, name);
  }
});

test('withClassifierTimeout writes only a deadline that differs from the default', () => {
  const house = {
    label: 'House',
    endpoint: 'https://jev-proxy.example.internal/v1/systemone',
    model: 'jev-1.13.0',
    keyOption: 'typesafe_api_key',
    timeoutMs: 1500,
  };
  for (const [name, file, id, timeoutMs, expected] of [
    [
      'a longer deadline',
      { classifier: 'clef' },
      'clef',
      4000,
      { classifier: 'clef', classifiers: { clef: { timeoutMs: 4000 } } },
    ],
    [
      'back to the default drops the override and empty sections',
      { classifier: 'clef', classifiers: { clef: { timeoutMs: 4000 } }, policy: { cashCapUsd: 1 } },
      'clef',
      DEFAULTS.classifiers.clef.timeoutMs,
      { classifier: 'clef', policy: { cashCapUsd: 1 } },
    ],
    [
      'other fields of the entry stay',
      { classifiers: { jev: { label: 'J', timeoutMs: 900 } } },
      'jev',
      DEFAULTS.classifiers.jev.timeoutMs,
      { classifiers: { jev: { label: 'J' } } },
    ],
    [
      'a new classifier keeps its whole entry',
      { classifier: 'house', classifiers: { house } },
      'house',
      3000,
      { classifier: 'house', classifiers: { house: { ...house, timeoutMs: 3000 } } },
    ],
  ]) {
    const written = withClassifierTimeout(file, id, timeoutMs);
    assert.deepEqual(written, expected, name);
    assert.equal(loadConfig({ userFile: written }).classifiers[id].timeoutMs, timeoutMs, name);
  }
});

test('classifiers read exactly the options plugin.json declares', () => {
  const manifest = JSON.parse(readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(manifest.userConfig).sort(), Object.keys(CLASSIFIER_OPTIONS).sort());
});

test('a keyless classifier needs no key option; a user entry speaks System One unless it names an API', () => {
  const config = loadConfig({
    userFile: {
      classifiers: {
        'local-proxy': {
          label: 'Proxy',
          endpoint: 'http://127.0.0.1:9/v1',
          model: 'm',
          keyOption: null,
          timeoutMs: 800,
        },
      },
    },
  });
  assert.equal(config.classifiers.ollama.keyOption, null);
  assert.equal(config.classifiers['local-proxy'].api, 'system-one');
  assert.equal(config.classifiers.openai.api, 'openai-decisions');
});

test('a loopback http endpoint passes for local stubs', () => {
  for (const endpoint of ['http://127.0.0.1:43171/delay', 'http://localhost/v1', 'http://[::1]:8080/v1']) {
    assert.equal(loadConfig({ userFile: { classifiers: { jev: { endpoint } } } }).classifiers.jev.endpoint, endpoint);
  }
});

test('the default micro and low routes are Haiku at their own effort whatever the session effort', () => {
  for (const [tier, effort] of [
    ['micro', 'medium'],
    ['low', 'high'],
  ]) {
    assert.deepEqual(DEFAULTS.routes[tier], { model: 'haiku', effort });
    for (const session of ['low', 'medium', 'high', 'xhigh', 'max', null])
      assert.equal(
        routeEffort(loadConfig({}), resolveRoute(loadConfig({}), tier), session),
        effort,
        `${tier} ${session}`,
      );
  }
});

test('activity routing defaults to on with Sonnet at high for low engineering work and Haiku for medium ops', () => {
  const config = loadConfig();
  assert.deepEqual(ACTIVITY_VALUES, [...ACTIVITIES, 'uncertain']);
  assert.deepEqual(ACTIVITY_MODES, ['off', 'on']);
  assert.equal(config.activityRouting, 'on');
  assert.equal(config.policy.activityMass, 0.6);
  const sonnet = { model: 'sonnet', effort: 'high' };
  assert.deepEqual(config.activities, {
    code: { low: sonnet },
    debug: { low: sonnet },
    plan: { low: sonnet },
    review: { low: sonnet },
    ops: { medium: { model: 'haiku', effort: 'high' } },
  });
});

test('resolveRoute runs the default matrix in every cell and the base route without an activity', () => {
  const config = loadConfig();
  const H_MED = { model: 'haiku', effort: 'medium' };
  const H_HIGH = { model: 'haiku', effort: 'high' };
  const S_HIGH = { model: 'sonnet', effort: 'high' };
  const O_MED = { model: 'opus', effort: 'medium' };
  const O_XH = { model: 'opus', effort: 'xhigh' };
  const engineering = [H_MED, S_HIGH, O_MED, O_XH];
  const matrix = {
    base: [H_MED, H_HIGH, O_MED, O_XH],
    code: engineering,
    debug: engineering,
    plan: engineering,
    review: engineering,
    ops: [H_MED, H_HIGH, H_HIGH, O_XH],
    explore: [H_MED, H_HIGH, O_MED, O_XH],
    docs: [H_MED, H_HIGH, O_MED, O_XH],
  };
  assert.deepEqual(Object.keys(matrix).slice(1).sort(), [...ACTIVITIES].sort());
  for (const [activity, routes] of Object.entries(matrix))
    TIERS.forEach((tier, i) => {
      assert.deepEqual(
        resolveRoute(config, tier, activity === 'base' ? null : activity),
        routes[i],
        `${activity} ${tier}`,
      );
    });
});

test('a user override merges per field over the built-in one', () => {
  const config = loadConfig({
    userFile: {
      activities: {
        code: { low: { effort: 'medium' }, high: { effort: 'max' } },
        review: { low: { model: 'opus' } },
        ops: { medium: { model: 'sonnet' } },
        docs: { low: { effort: null } },
      },
    },
  });
  assert.equal(config.activityRouting, 'on');
  for (const [tier, activity, expected] of [
    ['low', 'code', { model: 'sonnet', effort: 'medium' }],
    ['high', 'code', { model: 'opus', effort: 'max' }],
    ['low', 'review', { model: 'opus', effort: 'high' }],
    ['medium', 'ops', { model: 'sonnet', effort: 'high' }],
    ['low', 'docs', { model: 'haiku', effort: null }],
    ['low', 'debug', { model: 'sonnet', effort: 'high' }],
  ]) {
    assert.deepEqual(resolveRoute(config, tier, activity), expected, `${tier} ${activity}`);
  }
});

// What 1.6 pane saves and hand edits left in router.json: a mode other than its default, cells that differ
// from its Sonnet·medium overrides, and removed built-ins written as the tier's base route.
test('a 1.6 router.json loads unchanged: its mode and cells stay as written, other cells take the new defaults', () => {
  for (const [name, file, mode, cells] of [
    ['no activity keys', {}, 'on', [['low', 'code', { model: 'sonnet', effort: 'high' }]]],
    ['off', { activityRouting: 'off' }, 'off', []],
    [
      'a 1.6 removal of docs at low',
      { activities: { docs: { low: { model: 'haiku', effort: 'high' } } } },
      'on',
      [['low', 'docs', { model: 'haiku', effort: 'high' }]],
    ],
    [
      'a 1.6 Sonnet·medium cell for medium explore, written in full',
      { activityRouting: 'on', activities: { explore: { medium: { model: 'sonnet', effort: 'medium' } } } },
      'on',
      [
        ['medium', 'explore', { model: 'sonnet', effort: 'medium' }],
        ['medium', 'ops', { model: 'haiku', effort: 'high' }],
      ],
    ],
    [
      'a 1.6 effort-only cell now merges over the new built-in',
      { activities: { ops: { medium: { effort: 'low' } } } },
      'on',
      [['medium', 'ops', { model: 'haiku', effort: 'low' }]],
    ],
  ]) {
    const config = loadConfig({ userFile: file });
    assert.equal(config.activityRouting, mode, name);
    for (const [tier, activity, route] of cells)
      assert.deepEqual(resolveRoute(config, tier, activity), route, `${name}: ${tier} ${activity}`);
  }
});

test('a retired shadow mode reads as unset, and other unknown modes still throw', () => {
  for (const key of ['activityRouting', 'subagentRouting']) {
    assert.equal(loadConfig({ userFile: { [key]: 'shadow' } })[key], 'on', key);
    assert.throws(() => loadConfig({ userFile: { [key]: 'auto' } }), new RegExp(`${key} must be one of off, on`), key);
  }
  const both = loadConfig({
    userFile: { activityRouting: 'shadow', subagentRouting: 'shadow', baselineTier: 'medium' },
  });
  assert.deepEqual([both.activityRouting, both.subagentRouting, both.baselineTier], ['on', 'on', 'medium']);
});

test('a pane save drops a retired shadow mode from router.json', () => {
  const onDisk = { activityRouting: 'shadow', subagentRouting: 'shadow', baselineTier: 'medium' };
  const loaded = loadConfig({ userFile: onDisk });
  const draft = editActivity(draftOf(loaded), loaded, 'ops', 'low', 'model', 'sonnet');
  assert.deepEqual(withActivities(onDisk, draft), {
    baselineTier: 'medium',
    activities: { ops: { low: { model: 'sonnet', effort: 'high' } } },
  });
});

test('the documented activities example loads in every mode', () => {
  for (const activityRouting of ACTIVITY_MODES) {
    const config = loadConfig({
      userFile: {
        activityRouting,
        activities: {
          code: { high: { effort: 'max' } },
          review: { low: { model: 'opus', effort: 'medium' } },
        },
      },
    });
    assert.equal(config.activityRouting, activityRouting);
  }
});

// A pane route draft of `config`, as routeDraftOf builds it.
const draftOf = (config) => {
  const base = structuredClone({
    routes: config.routes,
    baselineTier: config.baselineTier,
    activities: config.activities,
    activityRouting: config.activityRouting,
  });
  return { ...structuredClone(base), base };
};

test('withActivities writes only the cells and mode that differ from the defaults', () => {
  const opusMax = { model: 'opus', effort: 'max' };
  for (const [name, file, edit, expected, routed] of [
    ['an untouched draft keeps the file', { activities: { code: { high: { effort: 'max' } } } }, (d) => d, null, []],
    [
      'an edited effort',
      {},
      (d, c) => editActivity(d, c, 'code', 'high', 'effort', 'max'),
      { activities: { code: { high: opusMax } } },
      [['high', 'code', opusMax]],
    ],
    [
      'a cell set back to its built-in value is removed',
      { activities: { code: { low: { model: 'opus', effort: 'high' } } }, context: { recentTurns: 4 } },
      (d, c) => editActivity(d, c, 'code', 'low', 'model', 'sonnet'),
      { context: { recentTurns: 4 } },
      [['low', 'code', { model: 'sonnet', effort: 'high' }]],
    ],
    [
      'a removed built-in is written as the base route',
      {},
      (d, c) => editActivity(d, c, 'code', 'low', 'remove'),
      { activities: { code: { low: { model: 'haiku', effort: 'high' } } } },
      [['low', 'code', { model: 'haiku', effort: 'high' }]],
    ],
    [
      'a removed built-in follows the base route in the file',
      { routes: { low: { model: 'sonnet', effort: 'low' } } },
      (d, c) => editActivity(d, c, 'review', 'low', 'remove'),
      {
        routes: { low: { model: 'sonnet', effort: 'low' } },
        activities: { review: { low: { model: 'sonnet', effort: 'low' } } },
      },
      [['low', 'review', { model: 'sonnet', effort: 'low' }]],
    ],
    [
      'the last user override removed drops the section',
      { activities: { review: { high: { model: 'sonnet' } } }, activityRouting: 'on' },
      (d, c) => editActivity(d, c, 'review', 'high', 'remove'),
      { activityRouting: 'on' },
      [['high', 'review', { model: 'opus', effort: 'xhigh' }]],
    ],
    [
      'a removed built-in added back is the built-in again',
      { activities: { code: { low: { model: 'haiku', effort: 'high' } } } },
      (d, c) => editActivity(d, c, 'code', 'low', 'add'),
      {},
      [['low', 'code', { model: 'sonnet', effort: 'high' }]],
    ],
    [
      'a model switched away and back keeps a partial cell as written',
      { activities: { code: { medium: { model: 'sonnet' } } } },
      (d, c) =>
        editActivity(editActivity(d, c, 'code', 'medium', 'model', 'opus'), c, 'code', 'medium', 'model', 'sonnet'),
      null,
      [['medium', 'code', { model: 'sonnet', effort: 'medium' }]],
    ],
    ['a mode other than the default', {}, (d) => ({ ...d, activityRouting: 'off' }), { activityRouting: 'off' }, []],
    ['the default mode is no key', { activityRouting: 'off' }, (d) => ({ ...d, activityRouting: 'on' }), {}, []],
  ]) {
    const loaded = loadConfig({ userFile: file });
    const written = withActivities(file, edit(draftOf(loaded), loaded));
    assert.deepEqual(written, expected ?? file, name);
    const reloaded = loadConfig({ userFile: written });
    for (const [tier, activity, route] of routed)
      assert.deepEqual(resolveRoute(reloaded, tier, activity), route, `${name}: ${tier} ${activity}`);
  }
});

test('withActivities keeps router.json edits made on disk after the session loaded it', () => {
  const loaded = loadConfig({});
  const draft = editActivity(draftOf(loaded), loaded, 'ops', 'low', 'model', 'sonnet');
  const onDisk = { activities: { review: { high: { effort: 'max' } } }, activityRouting: 'on' };
  assert.deepEqual(withActivities(onDisk, draft), {
    activities: { review: { high: { effort: 'max' } }, ops: { low: { model: 'sonnet', effort: 'high' } } },
    activityRouting: 'on',
  });
});

test('a draft edits only the activity cells it changed and follows the saved config elsewhere', () => {
  const loaded = loadConfig({});
  const draft = editActivity(draftOf(loaded), loaded, 'ops', 'low', 'effort', 'medium');
  const saved = loadConfig({ userFile: { activities: { code: { low: { effort: 'high' } } }, activityRouting: 'on' } });
  const { activities, activityRouting } = effectiveActivities(draft, saved);
  assert.deepEqual(activities.ops, { low: { model: 'haiku', effort: 'medium' }, medium: saved.activities.ops.medium });
  assert.deepEqual(activities.code, { low: { model: 'sonnet', effort: 'high' } });
  assert.equal(activityRouting, 'on');
  const routesOnly = { routes: loaded.routes, baselineTier: 'low', base: draftOf(loaded).base };
  assert.deepEqual(effectiveActivities(routesOnly, saved), { activities: saved.activities, activityRouting: 'on' });
  assert.equal(
    effectiveActivities(editActivity(draft, loaded, 'code', 'low', 'remove'), saved).activities.code,
    undefined,
  );
});

test('supportedVersion accepts Claude Code 2.1.289 and newer, with or without a prerelease', () => {
  for (const [version, supported] of [
    ['2.1.289', true],
    ['2.1.290-beta.1', true],
    ['2.2.0', true],
    ['3.0.0', true],
    ['2.1.288', false],
    ['2.0.999', false],
    ['1.9.400', false],
    ['2.1.289.1', false],
    ['2.1', false],
    ['', false],
    [undefined, false],
  ])
    assert.equal(supportedVersion(version), supported, String(version));
});

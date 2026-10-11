import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULTS, loadConfig } from '../lib/config.mjs';
import {
  cellForModel,
  chooseRoute,
  continueRoute,
  emptyLoop,
  isModelAllowed,
  isNativeFallback,
  nativeFacts,
  observedMove,
  observeResponse,
  prepareLoop,
  resetHistory,
} from '../lib/route.mjs';
import { advice as adviceOf, assistant, toolResult, user } from './helpers.mjs';

const now = 1_000_000;
const model = 'claude-haiku-5-5';
const context = {
  messages: [{ role: 'user', content: 'Do one small edit.' }],
  prompt: 'Do one small edit.',
  effort: 'medium',
  turnId: 't1',
  contextTokens: 10_000,
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
const SMALL_MICRO = loadConfig({ userFile: { models: { tiny }, routes: { micro: { model: 'tiny' } } } });
const advice = adviceOf('micro', { micro: 0.99, medium: 0.01 });
const input = (loop, overrides = {}, config = DEFAULTS) => ({
  facts: nativeFacts(config, loop, context),
  advice,
  pin: null,
  nativeModel: model,
  contextKnown: true,
  now,
  ...overrides,
});
const smallInput = (loop, overrides) => input(loop, overrides, SMALL_MICRO);
const usage = (overrides = {}) => ({
  model,
  input_tokens: 100,
  cache_read_input_tokens: 900,
  cache_creation_input_tokens: 200,
  output_tokens: 50,
  ...overrides,
});

test('switch comparison needs observed usage and preserves savings and added-cost scenarios', () => {
  const sonnet = 'claude-sonnet-5-5';
  const config = loadConfig({
    userFile: { models: { tiny }, routes: { micro: { model: 'tiny' }, low: { model: 'sonnet', effort: null } } },
  });
  const sonnetInput = (loop, overrides) => input(loop, { nativeModel: sonnet, ...overrides }, config);
  const initial = emptyLoop(config, sonnet);
  assert.equal(chooseRoute(config, initial, sonnetInput(initial)).decision.comparison, null);
  const observed = observeResponse(DEFAULTS, initial, {
    usage: usage({
      model: sonnet,
      input_tokens: 2000,
      cache_read_input_tokens: 140_000,
      cache_creation_input_tokens: 8000,
      output_tokens: 1500,
    }),
    requestedModel: sonnet,
    effort: 'medium',
    stopReason: 'end_turn',
    now,
  });
  const selected = chooseRoute(
    config,
    observed,
    sonnetInput(observed, {
      facts: nativeFacts(config, observed, { ...context, contextTokens: 151_500 }),
    }),
  );
  const comparison = selected.decision.comparison;
  assert.equal(comparison.candidate, 'micro');
  assert.equal(comparison.incumbent, 'low');
  assert.ok(comparison.minUsd < 0);
  assert.ok(comparison.maxUsd > 0);
  assert.equal(comparison.outputTokens, 1500);
  assert.equal(comparison.paybackTurns, 12);
});

test('a model without an output price still gets a finite input-only comparison', () => {
  const { output, ...inputOnly } = tiny;
  const config = loadConfig({ userFile: { models: { tiny: inputOnly }, routes: { micro: { model: 'tiny' } } } });
  const initial = emptyLoop(config, model);
  const observed = observeResponse(DEFAULTS, initial, {
    usage: usage({ input_tokens: 2000, cache_read_input_tokens: 140_000, cache_creation_input_tokens: 8000 }),
    requestedModel: model,
    effort: 'medium',
    stopReason: 'end_turn',
    now,
  });
  const facts = nativeFacts(config, observed, { ...context, contextTokens: 151_500 });
  const { comparison } = chooseRoute(config, observed, input(observed, { facts })).decision;
  assert.ok(Number.isFinite(comparison.minUsd) && Number.isFinite(comparison.maxUsd));
  assert.equal(comparison.paybackTurns, null);
});

test('native facts use engine turn ids and bounded prompt rather than tool output', () => {
  const facts = nativeFacts(DEFAULTS, emptyLoop(DEFAULTS, model), {
    ...context,
    prompt: 'x'.repeat(2000),
    messages: [{ role: 'user', content: [{ type: 'tool_result', content: 'PRIVATE_TOOL' }] }],
  });
  assert.equal(facts.turnKey, 't1');
  assert.equal(facts.prompt.length, DEFAULTS.context.maxTextChars);
  assert.equal(facts.pin, null);
  assert.equal(
    facts.turns.some((v) => v.text.includes('PRIVATE_TOOL')),
    false,
  );
});

test('fixing different tests keeps the route; repeating the same failure escalates', () => {
  const header =
    '> @alexeiled/claude-router@1.10.0 test\n' +
    '> node --test --test-timeout=8000 test/*.test.mjs experiments/mod-router/scripts/*.test.mjs\n\n';
  const failure = (name) => `${header}not ok 1 - ${name}\n  error: 'unauthorized'\n`;
  for (const [name, nextTest, tier, reason] of [
    ['progress to another test', 'logout', 'low', 'no-advice'],
    ['test name with a position', 'login at line 40', 'low', 'no-advice'],
    ['test name with different whitespace', 'login  at line 12', 'low', 'no-advice'],
    ['same failing test', 'login at line 12', 'medium', 'escalation'],
  ]) {
    const loop = emptyLoop(DEFAULTS, model);
    const facts = nativeFacts(DEFAULTS, loop, {
      ...context,
      messages: [
        user('fix the tests'),
        assistant('running', ['Bash']),
        toolResult(failure('login at line 12'), { isError: true }),
        assistant('editing', ['Edit']),
        toolResult(failure(nextTest), { isError: true }),
        user('continue'),
      ],
    });
    const { decision } = chooseRoute(DEFAULTS, loop, input(loop, { facts, advice: null }));
    assert.deepEqual([decision.tier, decision.reason], [tier, reason], name);
    assert.equal(decision.escalated, reason === 'escalation', name);
  }
});

test('a new or reset history switches on one vote; a measured one waits for the streak', () => {
  const initial = emptyLoop(DEFAULTS, model);
  const observed = observeResponse(DEFAULTS, initial, { usage: usage(), requestedModel: model, effort: 'high', now });
  const up = adviceOf('medium', { medium: 0.95, low: 0.05 });
  for (const [name, config, loop, vote, expected] of [
    ['session start, down', DEFAULTS, initial, advice, ['micro', 'downgrade']],
    ['session start, up', DEFAULTS, initial, up, ['medium', 'upgrade']],
    ['measured, down', DEFAULTS, observed, advice, ['low', 'downgrade-pending']],
    ['measured, up', DEFAULTS, observed, up, ['low', 'upgrade-pending']],
    ['history reset', DEFAULTS, resetHistory(observed), advice, ['micro', 'downgrade']],
    ['rewind', DEFAULTS, prepareLoop({ ...observed, lastMessageCount: 8 }, 4), up, ['medium', 'upgrade']],
    ['into a smaller window', SMALL_MICRO, emptyLoop(SMALL_MICRO, model), advice, ['low', 'context-unknown']],
  ]) {
    const { decision } = chooseRoute(config, loop, input(loop, { advice: vote }, config));
    assert.deepEqual([decision.tier, decision.reason], expected, name);
  }
});

test('native facts say whether this history has a measured reply', () => {
  const initial = emptyLoop(DEFAULTS, model);
  const observed = observeResponse(DEFAULTS, initial, { usage: usage(), requestedModel: model, effort: 'high', now });
  for (const [loop, measured] of [
    [initial, false],
    [observed, true],
    [resetHistory(observed), false],
  ])
    assert.equal(nativeFacts(DEFAULTS, loop, context).historyMeasured, measured);
});

test('pins and tool continuations do not replace the automatic incumbent or add votes', () => {
  const loop = emptyLoop(DEFAULTS, model);
  const pinned = chooseRoute(DEFAULTS, loop, input(loop, { pin: 'high' }));
  assert.equal(pinned.decision.model, 'claude-opus-5-5');
  assert.equal(pinned.lastRoute, loop.lastRoute);
  const continued = continueRoute(DEFAULTS, pinned, {
    nativeModel: model,
    contextTokens: 11_000,
    contextKnown: true,
    effort: 'medium',
  });
  assert.equal(continued.decision.model, 'claude-opus-5-5');
  assert.equal(continued.state.turn, 1);
  const resumed = chooseRoute(DEFAULTS, continued, input(continued, { advice: null }));
  assert.equal(resumed.decision.model, model);
});

test('large and unknown contexts cannot be pinned into a smaller window', () => {
  const loop = emptyLoop(SMALL_MICRO, model);
  const large = chooseRoute(
    SMALL_MICRO,
    loop,
    smallInput(loop, { pin: 'micro', facts: nativeFacts(SMALL_MICRO, loop, { ...context, contextTokens: 589_000 }) }),
  );
  assert.equal(large.decision.model, model);
  assert.equal(large.decision.reason, 'context-fit');
  const unknown = chooseRoute(SMALL_MICRO, loop, smallInput(loop, { pin: 'micro', contextKnown: false }));
  assert.equal(unknown.decision.model, model);
  assert.equal(unknown.decision.reason, 'context-unknown');
});

test('large tool results trigger fit without another turn vote', () => {
  const loop = observeResponse(DEFAULTS, emptyLoop(SMALL_MICRO, model), {
    usage: usage(),
    requestedModel: model,
    effort: 'medium',
    now,
  });
  const small = chooseRoute(SMALL_MICRO, loop, smallInput(loop, { pin: 'micro' }));
  const large = continueRoute(SMALL_MICRO, small, {
    nativeModel: model,
    contextTokens: 300_000,
    contextKnown: true,
    effort: 'medium',
  });
  assert.equal(large.decision.model, model);
  assert.equal(large.decision.reason, 'context-fit');
  assert.equal(large.state.turn, small.state.turn);
});

test('a local estimate alone cannot downgrade a new or reset history into a smaller window', () => {
  const initial = emptyLoop(SMALL_MICRO, model);
  const observed = observeResponse(DEFAULTS, initial, {
    usage: usage(),
    requestedModel: model,
    effort: 'medium',
    now,
  });
  assert.equal(chooseRoute(SMALL_MICRO, observed, smallInput(observed, { pin: 'micro' })).decision.tier, 'micro');
  for (const loop of [initial, resetHistory(observed)]) {
    const selected = chooseRoute(SMALL_MICRO, loop, smallInput(loop, { pin: 'micro' }));
    assert.equal(selected.decision.model, model);
    assert.equal(selected.decision.reason, 'context-unknown');
  }
});

test('allowed models handle exact versions and alias narrowing', () => {
  const sonnet = 'claude-sonnet-5-5';
  for (const [id, allowed, expected] of [
    [sonnet, undefined, true],
    [sonnet, [], false],
    [sonnet, ['sonnet'], true],
    [sonnet, ['sonnet', 'claude-sonnet-4-5'], false],
    ['claude-haiku-4-5-20251001', ['claude-haiku-4-5'], true],
    ['custom.provider/model', ['custom.provider/model'], true],
    [sonnet, ['default'], true],
    [sonnet, 'invalid', false],
  ])
    assert.equal(isModelAllowed(id, allowed, sonnet), expected);
});

test('a denied pin uses an allowed native model', () => {
  const loop = emptyLoop(DEFAULTS, model);
  const result = chooseRoute(DEFAULTS, loop, input(loop, { pin: 'high', availableModels: ['sonnet'] }));
  assert.equal(result.decision.model, model);
  assert.equal(result.decision.reason, 'model-unavailable');
});

test("a fallback to an unavailable route keeps the turn's activity or passes the session model through", () => {
  const sonnet = 'claude-sonnet-5-5';
  const withActivity = (choice, tier = 'low') => ({
    ...adviceOf(tier, { [tier]: 0.95, medium: 0.05 }),
    activity: { choice, probabilities: { [choice]: 0.95 } },
  });
  for (const [name, loop, overrides, expected] of [
    ['no activity answer', emptyLoop(DEFAULTS, model), {}, [null, null, sonnet, 'medium', 'model-unavailable']],
    ['a pin', emptyLoop(DEFAULTS, model), { pin: 'high' }, [null, null, sonnet, 'medium', 'model-unavailable']],
    [
      'another activity',
      emptyLoop(DEFAULTS, sonnet),
      { advice: withActivity('explore') },
      [null, null, sonnet, 'medium', 'model-unavailable'],
    ],
    [
      'the same activity',
      emptyLoop(DEFAULTS, sonnet),
      { advice: withActivity('code', 'high') },
      ['low', 'code', sonnet, 'high', 'model-unavailable'],
    ],
  ]) {
    const { decision } = chooseRoute(
      DEFAULTS,
      loop,
      input(loop, { nativeModel: sonnet, availableModels: ['sonnet'], ...overrides }),
    );
    assert.deepEqual(
      [decision.tier, decision.activity, decision.model, decision.effort, decision.reason],
      expected,
      name,
    );
  }
});

test('an unknown context also blocks smaller windows in the fallback search', () => {
  const loop = emptyLoop(SMALL_MICRO, model);
  const result = chooseRoute(SMALL_MICRO, loop, smallInput(loop, { contextKnown: false, availableModels: ['tiny'] }));
  assert.equal(result.decision.tier, null);
  assert.equal(result.decision.model, model);
});

test('observations count cached input only and never merge different dated snapshots', () => {
  const observed = observeResponse(DEFAULTS, emptyLoop(DEFAULTS, model), {
    usage: usage(),
    requestedModel: model,
    effort: 'medium',
    now,
  });
  // Haiku 5.5 keeps one cache across efforts; a provider that splits it keys each effort.
  assert.equal(observed.models[model].prefixTokens, 1100);
  assert.equal(observed.lastRequest.tokens, 1200);
  const split = observeResponse({ ...DEFAULTS, effortSplitsCache: true }, emptyLoop(DEFAULTS, model), {
    usage: usage(),
    requestedModel: model,
    effort: 'medium',
    now,
  });
  assert.deepEqual(Object.keys(split.models), [`${model}@medium`]);
  const dated = observeResponse(DEFAULTS, observed, {
    usage: usage({ model: 'claude-haiku-4-5-20251001' }),
    requestedModel: 'claude-haiku-4-5',
    effort: null,
    now,
  });
  assert.equal(dated.resolutions['claude-haiku-4-5'], 'claude-haiku-4-5-20251001');
  const moved = observeResponse(DEFAULTS, dated, {
    usage: usage({ model: 'claude-haiku-4-5-20270101' }),
    requestedModel: 'claude-haiku-4-5',
    effort: null,
    now,
  });
  assert.equal(Object.hasOwn(moved.resolutions, 'claude-haiku-4-5'), false);
  assert.equal(Object.hasOwn(moved.models, 'claude-haiku-4-5-20270101'), false);
});

test('incomplete usage cannot erase the last context measurement', () => {
  const loop = { ...emptyLoop(DEFAULTS, model), lastRequest: { tokens: 700_000, outputTokens: 10 } };
  for (const u of [
    usage({ input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
    usage({ input_tokens: -1 }),
  ]) {
    assert.equal(
      observeResponse(DEFAULTS, loop, { usage: u, requestedModel: model, effort: null, now }).lastRequest.tokens,
      700_000,
    );
  }
});

test('rewind clears votes and warmth but retains the context floor', () => {
  const loop = {
    ...emptyLoop(DEFAULTS, model),
    models: { seen: {} },
    lastMessageCount: 20,
    lastRequest: { tokens: 700_000, outputTokens: 50 },
    state: { turn: 10, votes: [{ tier: 'high' }], holdUntilTurn: 12 },
  };
  for (const result of [prepareLoop(loop, 10), resetHistory(loop)]) {
    assert.equal(result.turnId, loop.turnId);
    assert.deepEqual(result.models, {});
    assert.deepEqual(result.state.votes, []);
    assert.equal(result.lastRequest.tokens, 700_000);
    assert.equal(result.generation, 1);
  }
});

test('window-exceeded responses latch the model without a retry', () => {
  const loop = observeResponse(DEFAULTS, emptyLoop(SMALL_MICRO, model), {
    usage: usage(),
    requestedModel: model,
    effort: 'medium',
    now,
  });
  const failed = observeResponse(DEFAULTS, loop, {
    usage: null,
    requestedModel: 'claude-haiku-4-5',
    effort: null,
    stopReason: 'model_context_window_exceeded',
    now,
  });
  const result = chooseRoute(SMALL_MICRO, failed, smallInput(failed, { pin: 'micro' }));
  assert.equal(result.decision.model, model);
  assert.equal(result.decision.reason, 'model-unavailable');
});

test('isNativeFallback: a model the router neither saw nor chose is an engine fallback', () => {
  const routed = { engineModel: 'claude-sonnet-5-5', decision: { model: 'claude-haiku-4-5' } };
  for (const [name, loop, served, fallback] of [
    ['the engine model again', routed, 'claude-sonnet-5-5', false],
    ['the routed model echoed', routed, 'claude-haiku-4-5', false],
    ['a dated snapshot of the routed model', routed, 'claude-haiku-4-5-20251001', false],
    ['a third model', routed, 'claude-opus-5-5', true],
    ['a suspended loop', { ...routed, suspended: true }, 'claude-sonnet-5-5', true],
    ['nothing known yet', {}, 'claude-opus-5-5', false],
  ])
    assert.equal(isNativeFallback(loop, served), fallback, name);
});

test('cellForModel searches base routes first, and activity overrides only in on mode', () => {
  const custom = { userFile: { activities: { review: { high: { model: 'sonnet', effort: 'max' } } } } };
  for (const [mode, id, file, expected] of [
    ['off', 'claude-sonnet-5-5', {}, null],
    ['on', 'claude-sonnet-5-5', {}, { tier: 'low', activity: 'code' }],
    ['on', model, {}, { tier: 'low', activity: null }],
    ['on', 'claude-opus-5-5', {}, { tier: 'medium', activity: null }],
    ['on', 'gpt-x', {}, null],
    ['on', 'claude-sonnet-5-5', { baselineTier: 'high', ...custom.userFile }, { tier: 'high', activity: 'review' }],
  ]) {
    const config = loadConfig({ userFile: { ...file, activityRouting: mode } });
    assert.deepEqual(cellForModel(config, id), expected, `${mode} ${id}`);
    const loop = emptyLoop(config, id);
    assert.deepEqual(
      [loop.lastRoute, loop.lastActivity],
      [expected?.tier ?? config.baselineTier, expected?.activity ?? null],
      `${mode} ${id} loop`,
    );
  }
});

test('a tool continuation keeps the activity and fits the context through its route', () => {
  const config = loadConfig({
    userFile: { activityRouting: 'on', models: { tiny }, activities: { code: { low: { model: 'tiny' } } } },
  });
  const decision = { tier: 'low', activity: 'code', reason: 'activity-up', model: tiny.id, effort: null };
  const loop = { ...emptyLoop(config, model), decision };
  const go = (contextTokens) =>
    continueRoute(config, loop, { nativeModel: model, contextTokens, contextKnown: true, effort: 'medium' }).decision;
  assert.deepEqual(go(20_000), decision);
  const grown = go(300_000);
  assert.deepEqual(
    [grown.tier, grown.activity, grown.model, grown.effort, grown.reason],
    ['medium', 'code', 'claude-opus-5-5', 'medium', 'context-fit'],
  );
  const unavailable = continueRoute(config, loop, {
    nativeModel: model,
    contextTokens: 20_000,
    contextKnown: true,
    availableModels: ['sonnet'],
    effort: 'medium',
  }).decision;
  assert.deepEqual([unavailable.tier, unavailable.activity, unavailable.model], [null, null, model]);
});

test("a route the context outgrows moves up the activity's routes; an unknown context returns to the running cell", () => {
  const config = loadConfig({
    userFile: { activityRouting: 'on', models: { tiny }, activities: { code: { low: { model: 'tiny' } } } },
  });
  const label = { choice: 'code', probabilities: { code: 0.95, uncertain: 0.05 } };
  const loop = observeResponse(DEFAULTS, emptyLoop(config, model), {
    usage: usage(),
    requestedModel: model,
    effort: 'medium',
    now,
  });
  const large = { facts: nativeFacts(config, loop, { ...context, contextTokens: 300_000 }) };
  for (const [name, overrides, expected] of [
    ['fits', {}, ['low', 'code', 'activity-up', 'claude-haiku-4-5']],
    ['too large for the override', large, ['medium', 'code', 'context-fit', 'claude-opus-5-5']],
    ['unknown context', { contextKnown: false }, ['low', null, 'context-unknown', model]],
  ]) {
    const vote = adviceOf('low', { low: 0.99 });
    const { decision } = chooseRoute(
      config,
      loop,
      input(loop, { advice: { ...vote, activity: label }, ...overrides }, config),
    );
    assert.deepEqual([decision.tier, decision.activity, decision.reason, decision.model], expected, name);
  }
});

test('a turn moves up to the route its own tool calls show, never down, and not when pinned or off', () => {
  const on = loadConfig({ userFile: {} });
  const off = loadConfig({ userFile: { activityRouting: 'off' } });
  const routed = (config, activity, pinned = false) => ({
    ...emptyLoop(config, model),
    lastRoute: 'medium',
    lastActivity: activity,
    decision: { tier: 'medium', activity, model, effort: 'high', reason: 'activity-down', pinned },
  });
  for (const [name, config, loop, observed, expected] of [
    ['ops edits code', on, routed(on, 'ops'), 'code', ['code', 'claude-opus-5-5', 'medium', 'activity-up']],
    ['ops only runs commands', on, routed(on, 'ops'), 'ops', ['ops', model, 'high', 'activity-down']],
    ['ops only reads', on, routed(on, 'ops'), 'read', ['ops', model, 'high', 'activity-down']],
    ['pinned turn', on, routed(on, 'ops', true), 'code', ['ops', model, 'high', 'activity-down']],
    ['activity routing off', off, routed(off, 'ops'), 'code', ['ops', model, 'high', 'activity-down']],
  ]) {
    const facts = nativeFacts(config, loop, context);
    const { decision } = observedMove(config, loop, { observed, facts, contextKnown: true, now });
    assert.deepEqual([decision.activity, decision.model, decision.effort, decision.reason], expected, name);
  }
});

test('an observed move to a smaller window waits for a measured context, as a routed turn does', () => {
  const config = loadConfig({ userFile: { models: { tiny }, activities: { code: { medium: { model: 'tiny' } } } } });
  const loop = {
    ...emptyLoop(config, model),
    lastRoute: 'medium',
    lastActivity: 'ops',
    decision: { tier: 'medium', activity: 'ops', model, effort: 'high', reason: 'activity-down', pinned: false },
  };
  const facts = nativeFacts(config, loop, context);
  for (const [name, contextKnown, measured, expected] of [
    ['measured', true, true, 'claude-haiku-4-5'],
    ['context unknown', false, true, model],
    ['history not measured', true, false, model],
  ]) {
    const { decision } = observedMove(
      config,
      { ...loop, historyMeasured: measured },
      { observed: 'code', facts, contextKnown, now },
    );
    assert.equal(decision.model, expected, name);
  }
});

test('the first response a loop serves starts the dwell and the verification window', () => {
  const initial = { ...emptyLoop(DEFAULTS, model), lastMessageCount: 40 };
  const first = observeResponse(DEFAULTS, initial, { usage: usage(), requestedModel: model, effort: 'high', now });
  assert.deepEqual(first.switchedAt, { requests: 1, messageCount: 40 });
  const same = observeResponse(
    DEFAULTS,
    { ...first, lastMessageCount: 42 },
    { usage: usage(), requestedModel: model, effort: 'high', now },
  );
  assert.deepEqual(same.switchedAt, { requests: 1, messageCount: 40 });
});

test('a shortened history moves the checkpoint and edit cursors to its end and keeps the dwell', () => {
  const loop = {
    ...emptyLoop(DEFAULTS, model),
    lastMessageCount: 200,
    requests: 30,
    switchedAt: { requests: 25, messageCount: 180 },
    observedFrom: 190,
  };
  for (const [name, count, expected] of [
    ['compaction', 20, [{ requests: 25, messageCount: 20 }, 20]],
    ['growth', 210, [{ requests: 25, messageCount: 180 }, 190]],
  ]) {
    const next = prepareLoop(loop, count);
    assert.deepEqual([next.switchedAt, next.observedFrom], expected, name);
  }
  assert.equal(prepareLoop({ ...loop, switchedAt: null }, 20).switchedAt, null);
});

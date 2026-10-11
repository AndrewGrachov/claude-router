import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULTS } from '../lib/config.mjs';
import { modelAlias } from '../lib/savings.mjs';
import {
  answering,
  band,
  CONFIG,
  drain,
  harness,
  JEV_KEY,
  press,
  start,
  step,
  substituted,
  TINY_ROUTER,
  texts,
} from './harness.mjs';
import { assistant, jevResponse, toolResult, user } from './helpers.mjs';

// Your model's simulated cache: the one kept for the model /model selects.
const yours = (h) => h.loop().yoursBy[modelAlias(DEFAULTS, h.view().nativeModel)];

test('frozen native state reads do not restore consumed pins or drop first response usage', async () => {
  const h = harness();
  await start(h);
  await h.event('command.run', { command: 'router', args: 'pin high' });
  await drain(h.step(step));
  assert.equal(h.requests[0].model, 'claude-opus-5-5');
  assert.equal(h.view().pendingPin, null);
  assert.equal(h.view().actualModel, 'claude-opus-5-5');
  assert.equal(h.loop().lastRequest.tokens, 1100);
  assert.equal(h.loop().models['claude-opus-5-5'].prefixTokens, 1000);
});

test('on a provider that gives each effort its own cache, the loop keys the observed cache by effort', async () => {
  for (const [name, value] of [
    ['CLAUDE_CODE_USE_BEDROCK', '1'],
    ['CLAUDE_CODE_USE_VERTEX', 'true'],
    ['CLAUDE_CODE_USE_FOUNDRY', '1'],
    ['CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS', '1'],
    ['ANTHROPIC_BASE_URL', 'https://gateway.example'],
  ]) {
    const h = harness();
    h.env.set(name, value);
    await start(h);
    await h.event('command.run', { command: 'router', args: 'pin high' });
    await drain(h.step(step));
    assert.deepEqual(Object.keys(h.loop().models), ['claude-opus-5-5@xhigh'], name);
  }
});

test('a failed routed request leaves an engine-selected fallback untouched', async () => {
  const h = harness();
  await start(h);
  await h.event('command.run', { command: 'router', args: 'pin high' });
  await drain(h.step(step, { usage: null, stopReason: null }));
  await drain(h.step({ ...step, effort: 'low' }));
  assert.deepEqual(
    h.requests.map((r) => [r.model, r.effort]),
    [
      ['claude-opus-5-5', 'xhigh'],
      [step.model, 'low'],
    ],
  );
});

test('Manual clicked during advice cancels selection before an API request is rewritten', async () => {
  const h = harness({ typesafe_api_key: 'synthetic-key' });
  let httpCalls = 0;
  h.http(() => {
    httpCalls += 1;
    return new Promise(() => {});
  });
  await start(h);
  const pending = drain(h.step(step));
  for (let i = 0; i < 100 && !httpCalls; i += 1) await Promise.resolve();
  assert.equal(httpCalls, 1);
  const tree = await h.render();
  const buttons = [];
  function walk(node) {
    if (!node) return;
    if (node.type === 'Button') buttons.push(node.props);
    if (Array.isArray(node.props?.children)) node.props.children.forEach(walk);
  }
  walk(tree);
  await buttons.find((button) => button.key === 'manual').onPress();
  await pending;
  assert.equal(h.requests[0].model, step.model);
  assert.equal(h.preferences.get('mode:s1'), 'manual');
  assert.equal(h.view().mode, 'manual');
  assert.equal(h.view().actualModel, step.model);
  assert.equal(h.view().outputTokens, 10);
});

test('clear starts a new Auto session without changing the previous Manual preference', async () => {
  const h = harness();
  await start(h);
  await h.event('command.run', { command: 'router', args: 'off' });
  await h.event('session.end', { reason: 'clear' });
  h.clear();
  await h.event('command.run', { command: 'router', args: 'pin high' });
  await drain(h.step({ ...step, turnId: 't2' }));
  assert.equal(h.view().mode, 'auto');
  assert.equal(h.requests[0].model, 'claude-opus-5-5');
  assert.equal(h.preferences.get('mode:s1'), 'manual');
  assert.equal(h.preferences.get('mode:s2'), 'auto');
});

test('resume restores each selected session mode and ignores a process-wide override', async () => {
  const preferences = new Map([
    ['mode:s1', 'manual'],
    ['mode:s2', 'auto'],
  ]);
  const h = harness({}, preferences);
  h.env.set('JEV_ROUTER_MODE', 'manual');
  await start(h);
  await h.event('session.end', { reason: 'resume' });
  h.clear('s2');
  await h.event('command.run', { command: 'router', args: 'pin high' });
  await drain(h.step({ ...step, turnId: 't2' }));
  assert.equal(h.requests[0].model, 'claude-opus-5-5');
  assert.equal(h.view().mode, 'auto');
  await h.event('session.end', { reason: 'resume' });
  h.clear('s1');
  await h.event('command.run', { command: 'router', args: 'pin high' });
  await drain(h.step({ ...step, turnId: 't3' }));
  assert.equal(h.requests[1].model, step.model);
  assert.equal(h.view().mode, 'manual');
});

test('a fresh process restoring the same conversation keeps an explicit Manual baseline', async () => {
  const original = harness();
  await start(original);
  await original.event('command.run', { command: 'router', args: 'off' });
  const resumed = harness({}, original.preferences);
  await start(resumed);
  await resumed.event('command.run', { command: 'router', args: 'pin high' });
  await drain(resumed.step(step));
  assert.equal(resumed.view().mode, 'manual');
  assert.equal(resumed.view().pendingPin, null);
  assert.equal(resumed.requests[0].model, step.model);
});

test('the first turn of a session switches on one classifier answer', async () => {
  for (const [model, answer, expected] of [
    [
      'claude-haiku-5-5',
      jevResponse('medium', { micro: 0, low: 0.05, medium: 0.95, high: 0, uncertain: 0 }),
      ['claude-opus-5-5', 'medium', 'upgrade'],
    ],
    [
      'claude-opus-5-5',
      jevResponse('micro', { micro: 0.999, low: 0.001, medium: 0, high: 0, uncertain: 0 }),
      ['claude-haiku-5-5', 'medium', 'downgrade'],
    ],
  ]) {
    const h = harness({ typesafe_api_key: 'synthetic-key' });
    h.model(model);
    h.http(async () => ({ ok: true, status: 200, text: JSON.stringify(answer), headers: {} }));
    await start(h);
    await drain(h.step({ ...step, model }));
    assert.deepEqual([h.requests[0].model, h.requests[0].effort, h.loop().decision.reason], expected, model);
  }
});

test('a fresh session starts Auto on a model some route runs and Manual on any other', async () => {
  // With activity routing on, the default, Sonnet runs the code cell at low; with it off only the tier routes count.
  for (const [model, file, mode, effort] of [
    ['claude-opus-5-5', {}, 'auto', 'medium'],
    ['claude-haiku-5-5', {}, 'auto', 'high'],
    ['claude-sonnet-5-5', {}, 'auto', 'high'],
    ['claude-sonnet-5-5', { activityRouting: 'off' }, 'manual', 'low'],
    ['claude-fable-5-1', {}, 'manual', 'low'],
  ]) {
    const h = harness();
    h.files.set(CONFIG, JSON.stringify(file));
    h.model(model);
    await start(h);
    await drain(h.step({ ...step, model, effort: 'low' }));
    assert.equal(h.view().mode, mode, model);
    assert.equal(h.preferences.get('mode:s1'), mode, model);
    assert.deepEqual([h.requests[0].model, h.requests[0].effort], [model, effort], model);
  }
});

test('a fresh session on a model no tier routes to says why routing starts off, until the mode changes', async () => {
  const h = harness();
  h.files.set(CONFIG, JSON.stringify({ activityRouting: 'off' }));
  h.model('claude-sonnet-5-5');
  await start(h);
  const line = (await band(h)).line;
  assert.match(line, /Routing off .*every turn uses Sonnet 5\.5/);
  assert.match(line, /Sonnet 5\.5 is not a routing tier/);
  await h.event('command.run', { command: 'router', args: 'auto' });
  assert.doesNotMatch((await band(h)).line, /not a routing tier/);
});

test('a fresh session on a tier model shows no start reason', async () => {
  const h = harness();
  await start(h);
  assert.doesNotMatch((await band(h)).line, /not a routing tier/);
});

test('a band drawn before session start does not decide the start mode', async () => {
  const h = harness();
  h.model('claude-fable-5-1');
  await band(h);
  await start(h);
  await drain(h.step({ ...step, model: 'claude-fable-5-1' }));
  assert.equal(h.view().mode, 'manual');
  assert.equal(h.preferences.get('mode:s1'), 'manual');
  assert.equal(h.requests[0].model, 'claude-fable-5-1');
  assert.equal(h.requests[0].effort, step.effort);
});

test('subagents preserve their resolved model and never replace main metrics', async () => {
  const h = harness();
  await start(h);
  await h.event('command.run', { command: 'router', args: 'pin high' });
  await drain(h.step(step));
  const before = structuredClone(h.view());
  for (const model of ['claude-haiku-4-5', 'claude-sonnet-5-5']) {
    await drain(h.step({ ...step, agentId: 'worker', model, effort: 'low' }));
    assert.equal(h.requests.at(-1).model, model);
    assert.equal(h.requests.at(-1).effort, 'low');
    assert.deepEqual(h.view(), before);
  }
});

test('a continuation context-fit publishes the model actually requested', async () => {
  const h = harness();
  h.files.set(CONFIG, TINY_ROUTER);
  await start(h);
  await drain(h.step({ ...step, turnId: 'prime' }));
  await h.event('command.run', { command: 'router', args: 'pin micro' });
  await drain(h.step(step));
  h.usage({ context: { tokens: 1100, breakdown: { totalTokens: 300_000 } } });
  await drain(h.step({ ...step, index: 1, messageCount: 3 }));
  assert.equal(h.view().selectedModel, 'claude-haiku-5-5');
  assert.equal(h.view().actualModel, 'claude-haiku-5-5');
  assert.equal(h.view().effort, 'high');
  assert.equal(h.view().reason, 'context-fit');
  assert.equal(h.view().contextTokens, 300_000);
});

test('Manual requests refresh main metrics without rewriting models or effort', async () => {
  const h = harness();
  h.files.set(CONFIG, TINY_ROUTER);
  await start(h);
  await drain(h.step({ ...step, turnId: 'prime' }));
  await h.event('command.run', { command: 'router', args: 'pin micro' });
  await drain(h.step(step));
  assert.equal(h.view().actualModel, 'claude-haiku-4-5');
  h.model('claude-opus-5-5');
  await h.event('config.set', { key: 'model', origin: { kind: 'user' } });
  const manual = { ...step, turnId: 'manual', model: 'claude-opus-5-5', effort: 'low' };
  await drain(
    h.step(manual, {
      usage: {
        model: 'claude-opus-5-5',
        input_tokens: 300,
        cache_read_input_tokens: 500,
        cache_creation_input_tokens: 200,
        output_tokens: 55,
      },
    }),
  );
  assert.equal(h.requests[2].model, manual.model);
  assert.equal(h.requests[2].effort, 'low');
  assert.equal(h.view().nativeModel, manual.model);
  assert.equal(h.view().selectedModel, manual.model);
  assert.equal(h.view().actualModel, manual.model);
  assert.equal(h.view().inputTokens, 1000);
  assert.equal(h.view().outputTokens, 55);
  assert.equal(h.view().cacheRead, 500);
});

test('turn completion removes an interrupted choosing indicator', async () => {
  const h = harness({ typesafe_api_key: 'synthetic-key' });
  let calls = 0;
  h.http(() => {
    calls += 1;
    return new Promise(() => {});
  });
  await start(h);
  const pending = drain(h.step(step));
  for (let i = 0; i < 100 && !calls; i += 1) await Promise.resolve();
  assert.equal(h.view().phase, 'choosing');
  await h.event('turn.complete', { turnId: 't1' });
  await pending;
  assert.equal(h.view().phase, 'ready');
  assert.equal(h.view().actualModel, null);
  assert.equal(h.view().health.failures, 0);
});

test('an unsupported Claude version leaves the native request unchanged', async () => {
  const h = harness();
  h.version('2.1.288');
  await start(h);
  await h.event('command.run', { command: 'router', args: 'auto' });
  await h.event('command.run', { command: 'router', args: 'pin high' });
  await drain(h.step(step));
  assert.equal(h.view().phase, 'unavailable');
  assert.match(h.view().error, /2\.1\.289/);
  assert.equal(h.view().pendingPin, null);
  assert.equal(h.requests[0].model, step.model);
  assert.equal(h.requests[0].effort, step.effort);
});

test('while routing is unavailable, /router says why and its on, off and activity commands change nothing', async () => {
  const h = harness();
  h.version('2.1.288');
  await start(h);
  const command = async (args) => (await h.event('command.run', { command: 'router', args })).text;
  const why = 'Routing unavailable: requires Claude Code 2.1.289 or newer. Claude’s model is kept.';
  const mode = h.preferences.get('mode:s1');
  for (const args of ['auto', 'off', 'pin high', 'activities off']) assert.equal(await command(args), why, args);
  assert.equal(h.preferences.get('mode:s1'), mode);
  assert.equal(h.files.get(CONFIG), undefined);
  h.surfaces([]);
  const text = await command('');
  assert.equal(text.split('\n')[0], why);
  assert.doesNotMatch(text, /routing (on|off)/);
});

test('leftover v0.8 gateway settings pass requests through and name the keys to remove', async () => {
  const h = harness();
  h.env.set('ANTHROPIC_BASE_URL', 'http://127.0.0.1:43170');
  await start(h);
  await h.event('command.run', { command: 'router', args: 'pin high' });
  await drain(h.step(step));
  assert.equal(h.view().phase, 'unavailable');
  assert.match(h.view().error, /v0\.8 gateway settings remain/);
  assert.equal(h.requests[0].model, step.model);
  h.surfaces([]);
  const status = await h.event('command.run', { command: 'router', args: '' });
  assert.match(status.text, /ANTHROPIC_BASE_URL/);
  assert.match(status.text, /jev-router\[1m\]/);
  h.surfaces(['terminal']);
  assert.ok(texts(await h.render()).some((line) => /ANTHROPIC_BASE_URL/.test(line)));
});

test('project settings cannot redirect secure router configuration to another profile', async () => {
  const h = harness({ typesafe_api_key: 'synthetic-key' });
  h.settings({ env: { CLAUDE_CONFIG_DIR: '/fixture/untrusted' } });
  await start(h);
  await drain(h.step(step));
  assert.equal(h.view().phase, 'unavailable');
  assert.equal(h.requests[0].model, step.model);
  assert.equal(h.requests[0].effort, step.effort);
  assert.equal(h.files.size, 0);
});

test('a billed substitute keeps the rest of the turn native and the next turn routes again', async () => {
  const h = harness();
  await start(h);
  await h.event('command.run', { command: 'router', args: 'pin high' });
  await drain(h.step(step, substituted));
  await drain(h.step({ ...step, index: 1, effort: 'low' }));
  await h.event('turn.start', { turnId: 't2', text: 'Next edit.' });
  await h.event('command.run', { command: 'router', args: 'pin high' });
  await drain(h.step({ ...step, turnId: 't2' }));
  await drain(h.step({ ...step, turnId: 't2', index: 1 }));
  assert.deepEqual(
    h.requests.map((r) => [r.turnId, r.index, r.model]),
    [
      ['t1', 0, 'claude-opus-5-5'],
      ['t1', 1, step.model],
      ['t2', 0, 'claude-opus-5-5'],
      ['t2', 1, 'claude-opus-5-5'],
    ],
  );
});

test('a compaction inside a turn keeps its pin and a native fallback for the remaining steps', async () => {
  const h = harness();
  await start(h);
  await h.event('command.run', { command: 'router', args: 'pin high' });
  await drain(h.step(step));
  await h.event('session.compact', { trigger: 'auto' });
  await drain(h.step({ ...step, index: 1, messageCount: 0 }));
  await drain(h.step({ ...step, index: 2, model: 'claude-haiku-4-5' }));
  await h.event('session.compact', { trigger: 'auto' });
  await drain(h.step({ ...step, index: 3, model: 'claude-haiku-4-5' }));
  assert.deepEqual(
    h.requests.map((r) => r.model),
    ['claude-opus-5-5', 'claude-opus-5-5', 'claude-haiku-4-5', 'claude-haiku-4-5'],
  );
});

test('the engine echoing our routed model is not a fallback but a third model is', async () => {
  const h = harness();
  await start(h);
  await h.event('command.run', { command: 'router', args: 'pin high' });
  await drain(h.step(step));
  await drain(h.step({ ...step, index: 1, model: 'claude-opus-5-5' }));
  await drain(h.step({ ...step, index: 2, model: 'claude-haiku-4-5' }));
  assert.deepEqual(
    h.requests.map((r) => r.model),
    ['claude-opus-5-5', 'claude-opus-5-5', 'claude-haiku-4-5'],
  );
  assert.equal(h.view().reason, 'native-fallback');
});

test('an interrupt while the transcript is still loading never publishes choosing', async () => {
  const h = harness({ typesafe_api_key: 'synthetic-key' });
  let release;
  h.messages(() => new Promise((resolve) => (release = () => resolve([{ role: 'user', content: 'One edit.' }]))));
  let calls = 0;
  h.http(() => {
    calls += 1;
    return new Promise(() => {});
  });
  await start(h);
  const pending = drain(h.step(step));
  for (let i = 0; i < 100 && !release; i += 1) await Promise.resolve();
  await h.event('turn.complete', { turnId: 't1' });
  release();
  await pending;
  assert.equal(calls, 0);
  assert.notEqual(h.view().phase, 'choosing');
  assert.equal(h.requests[0].model, step.model);
});

test('clear after a manual /model choice on a non-baseline model starts Auto', async () => {
  const h = harness();
  await start(h);
  h.model('claude-opus-5-5');
  await h.event('command.run', { command: 'model', origin: { kind: 'user' } });
  assert.equal(h.preferences.get('mode:s1'), 'manual');
  await h.event('session.end', { reason: 'clear' });
  h.clear('s2');
  const pinned = await h.event('command.run', { command: 'router', args: 'pin micro' });
  assert.match(pinned.text, /pinned for the next turn/);
  await drain(h.step({ ...step, turnId: 't2', model: 'claude-opus-5-5' }));
  assert.equal(h.view().mode, 'auto');
  assert.equal(h.view().pendingPin, null);
  assert.equal(h.preferences.get('mode:s2'), 'auto');
});

test('replies record the tier that served them and the strip counts switches', async () => {
  const h = harness();
  await start(h);
  await h.event('command.run', { command: 'router', args: 'pin high' });
  await drain(h.step(step));
  await h.event('command.run', { command: 'router', args: 'off' });
  await drain(h.step({ ...step, turnId: 't2' }));
  assert.deepEqual(h.view().tiers, ['high', null]);
  assert.equal(h.view().history.length, 2);
  await drain(h.step({ ...step, turnId: 't3' }, { usage: null }));
  assert.equal(h.view().tiers.length, h.view().history.length);
  assert.ok(texts(await h.render()).some((line) => /0 model switches/.test(line)));
});

test('the router command opens the pane, switches modes and pins, with no setup or status forms', async () => {
  const h = harness();
  await start(h);
  assert.deepEqual(await h.event('command.run', { command: 'router', args: '' }), {});
  assert.match((await h.event('command.run', { command: 'router', args: 'off' })).text, /^Routing off:/);
  assert.match((await h.event('command.run', { command: 'router', args: 'auto' })).text, /^Routing on\./);
  assert.equal(h.commandCalls(), 0);
  assert.deepEqual(await h.event('command.run', { command: 'router', args: 'setup' }), {});
  assert.equal(h.commandCalls(), 0);
});

test('a substituted reply is not counted as the requested tier', async () => {
  const h = harness();
  await start(h);
  await h.event('command.run', { command: 'router', args: 'pin high' });
  await drain(h.step(step, substituted));
  assert.deepEqual(h.view().tiers, [null]);
});

test('a 1.1 router.json makes routing unavailable and points to the migration script', async () => {
  const h = harness();
  h.files.set(CONFIG, JSON.stringify({ jev: { timeoutMs: 900 } }));
  await start(h);
  assert.equal(h.view().phase, 'unavailable');
  assert.match(h.view().error, /migrate-config\.mjs/);
});

const LOW = { micro: 0, low: 0.95, medium: 0.05, high: 0, uncertain: 0 };
const STATS = 'activity:stats:v1';

// One whole turn on the session's `model`: its prompt, a routed step, then turn.complete over a transcript where the
// assistant called `tools`.
async function turn(h, turnId, model, tools = []) {
  await h.event('turn.start', { turnId, text: 'Next.' });
  h.messages(async () => [user('Next.')]);
  await drain(h.step({ ...step, turnId, model }));
  h.messages(async () => [user('Next.'), assistant('done', tools)]);
  await h.event('turn.complete', { turnId });
}

const reply = { turns: 1, requests: 1, inputTokens: 1100, outputTokens: 10 };
const MEDIUM = { micro: 0, low: 0.05, medium: 0.95, high: 0, uncertain: 0 };

test('with no router.json, a fresh session asks the activity and runs its default route', async () => {
  for (const [model, answer, activity, expected] of [
    ['claude-haiku-5-5', jevResponse('low', LOW, 0, { code: 0.9, ops: 0.1 }), 'code', ['claude-sonnet-5-5', 'high']],
    ['claude-opus-5-5', jevResponse('medium', MEDIUM, 0, { ops: 0.9, code: 0.1 }), 'ops', ['claude-haiku-5-5', 'high']],
    ['claude-haiku-5-5', jevResponse('low', LOW, 0, { explore: 0.9 }), 'explore', ['claude-haiku-5-5', 'high']],
  ]) {
    const h = harness(JEV_KEY);
    h.model(model);
    const bodies = answering(h, answer);
    await h.event('session.start', { cwd: '/fixture' });
    await turn(h, 't1', model, ['Edit']);
    assert.ok(bodies[0].questions.activity, activity);
    assert.deepEqual([h.requests[0].model, h.requests[0].effort], expected, activity);
    assert.equal(h.loop().decision.activity, activity);
  }
});

test('with activity routing on, an ops turn moves from Sonnet to Haiku inside its tier and records it', async () => {
  const h = harness(JEV_KEY);
  h.files.set(CONFIG, JSON.stringify({ activityRouting: 'on' }));
  h.model('claude-sonnet-5-5');
  answering(
    h,
    jevResponse('low', LOW, 0, { code: 0.9, ops: 0.1 }),
    jevResponse('low', LOW, 0, { ops: 0.81, code: 0.19 }),
  );
  await h.event('session.start', { cwd: '/fixture' });
  await turn(h, 't1', 'claude-sonnet-5-5', ['Edit']);
  assert.equal(h.view().mode, 'auto');
  assert.deepEqual([h.requests[0].model, h.requests[0].effort], ['claude-sonnet-5-5', 'high']);
  let line = (await band(h)).line;
  assert.match(line, / low {2}coding → Sonnet 5\.5 · high/);
  assert.match(line, /ctx \d+% · cache hit \d+%/);
  await turn(h, 't2', 'claude-sonnet-5-5', ['Bash']);
  assert.deepEqual([h.requests[1].model, h.requests[1].effort], ['claude-haiku-5-5', 'high']);
  assert.deepEqual([h.loop().decision.reason, h.loop().lastActivity], ['activity-down', 'ops']);
  assert.equal(h.toasts.length, 1);
  assert.match(h.toasts[0], /^Model changed: Sonnet 5\.5 · high → Haiku 5\.5 · high · running/);
  line = (await band(h)).line;
  assert.match(line, / low {2}running → Haiku 5\.5 · high/);
  assert.match(line, /↘ running/);
  assert.deepEqual(h.view().activities, ['code', 'ops']);
  const { byActivity, ...counts } = h.view().activityStats;
  assert.deepEqual(
    Object.fromEntries(Object.entries(byActivity).map(([name, { routedUsd, ...rest }]) => [name, rest])),
    {
      code: { ...reply, pricedRequests: 1, routes: { 'claude-sonnet-5-5@high': 1 } },
      ops: { ...reply, pricedRequests: 1, routes: { 'claude-haiku-5-5@high': 1 } },
    },
  );
  // Each activity's cost is its replies' share of the routed total.
  assert.ok(byActivity.ops.routedUsd > 0 && byActivity.code.routedUsd > byActivity.ops.routedUsd);
  assert.ok(Math.abs(byActivity.code.routedUsd + byActivity.ops.routedUsd - h.view().savings.routedUsd) < 1e-12);
  assert.deepEqual(counts, {
    switches: { tier: 0, activity: 1 },
    lateral: { taken: 1, refused: 0 },
    agreement: { matched: 2, total: 2 },
  });
  assert.deepEqual(h.preferences.get(STATS), {
    version: 1,
    confusion: { code: { code: 1 }, ops: { ops: 1 } },
    runs: { code: [1, 0, 0, 0, 0] },
    lateral: { taken: 1, refused: 0 },
  });
  const metrics = h.preferences.get('activity:metrics:v1:s1');
  assert.ok(Number.isFinite(metrics.since));
  assert.deepEqual(metrics, {
    version: 1,
    since: metrics.since,
    // Two timed classifier answers in the fastest bucket, and one cheaper activity move with no escalation yet.
    latency: { jev: [2, ...Array(21).fill(0)] },
    downMoves: { moves: 1, escalations: 0 },
  });
  assert.deepEqual(h.view().activityMetrics, metrics);

  await h.event('session.end', { reason: 'clear' });
  assert.deepEqual(h.preferences.get(STATS).runs, { code: [1, 0, 0, 0, 0], ops: [1, 0, 0, 0, 0] });
  h.clear('s2');
  await h.event('session.start', { cwd: '/fixture' });
  await turn(h, 't3', 'claude-sonnet-5-5', ['Bash']);
  assert.deepEqual(h.view().activities, ['ops']);
  assert.deepEqual(Object.keys(h.view().activityStats.byActivity), ['ops']);
  assert.equal(h.view().activityStats.byActivity.ops.turns, 1);

  const reloaded = harness(JEV_KEY, h.preferences);
  reloaded.files.set(CONFIG, JSON.stringify({ activityRouting: 'on' }));
  answering(reloaded, jevResponse('low', LOW, 0, { ops: 0.9 }));
  await reloaded.event('session.start', { cwd: '/fixture' });
  await turn(reloaded, 't1', 'claude-haiku-5-5', ['Bash']);
  assert.deepEqual(Object.keys(reloaded.view().activityStats.byActivity), ['ops']);
  assert.equal(reloaded.view().activityStats.byActivity.ops.turns, 1);
  assert.deepEqual(reloaded.preferences.get(STATS).confusion, { code: { code: 1 }, ops: { ops: 3 } });
});

test('a turn with activity routing off ends the watch after a cheaper activity move', async () => {
  const h = harness(JEV_KEY);
  h.files.set(
    CONFIG,
    JSON.stringify({ activityRouting: 'on', activities: { ops: { low: { model: 'haiku', effort: 'medium' } } } }),
  );
  h.model('claude-sonnet-5-5');
  answering(
    h,
    jevResponse('low', LOW, 0, { code: 0.9, ops: 0.1 }),
    jevResponse('low', LOW, 0, { ops: 0.81, code: 0.19 }),
  );
  await h.event('session.start', { cwd: '/fixture' });
  await turn(h, 't1', 'claude-sonnet-5-5', ['Edit']);
  await turn(h, 't2', 'claude-sonnet-5-5', ['Bash']);
  assert.equal(h.loop().decision.reason, 'activity-down');
  await h.event('command.run', { command: 'router', args: 'activities off' });
  await turn(h, 't3', 'claude-sonnet-5-5', ['Bash']);
  assert.notEqual(`${h.requests[2].model}@${h.requests[2].effort}`, `${h.requests[1].model}@${h.requests[1].effort}`);
  await h.event('command.run', { command: 'router', args: 'activities on' });
  const failing = [
    user('Fix the test.'),
    assistant('running', ['Bash']),
    toolResult('error: test_login failed', { isError: true }),
    assistant('editing', ['Edit']),
    toolResult('error: test_login failed', { isError: true }),
    user('Next.'),
  ];
  await h.event('turn.start', { turnId: 't4', text: 'Next.' });
  h.messages(async () => failing);
  await drain(h.step({ ...step, turnId: 't4', model: 'claude-sonnet-5-5' }));
  assert.equal(h.loop().decision.escalated, true);
  h.messages(async () => [...failing, assistant('done', ['Bash'])]);
  await h.event('turn.complete', { turnId: 't4' });
  assert.deepEqual(h.view().activityMetrics.downMoves, { moves: 1, escalations: 0 });
});

test('turning routing off ends the watch after a cheaper activity move', async () => {
  const h = harness(JEV_KEY);
  h.files.set(
    CONFIG,
    JSON.stringify({ activityRouting: 'on', activities: { ops: { low: { model: 'haiku', effort: 'medium' } } } }),
  );
  h.model('claude-sonnet-5-5');
  answering(
    h,
    jevResponse('low', LOW, 0, { code: 0.9, ops: 0.1 }),
    jevResponse('low', LOW, 0, { ops: 0.81, code: 0.19 }),
  );
  await h.event('session.start', { cwd: '/fixture' });
  await turn(h, 't1', 'claude-sonnet-5-5', ['Edit']);
  await turn(h, 't2', 'claude-sonnet-5-5', ['Bash']);
  assert.equal(h.loop().decision.reason, 'activity-down');
  await h.event('command.run', { command: 'router', args: 'off' });
  await turn(h, 't3', 'claude-sonnet-5-5', ['Bash']);
  assert.equal(h.requests[2].model, 'claude-sonnet-5-5');
  await h.event('command.run', { command: 'router', args: 'auto' });
  const failing = [
    user('Fix the test.'),
    assistant('running', ['Bash']),
    toolResult('error: test_login failed', { isError: true }),
    assistant('editing', ['Edit']),
    toolResult('error: test_login failed', { isError: true }),
    user('Next.'),
  ];
  await h.event('turn.start', { turnId: 't4', text: 'Next.' });
  h.messages(async () => failing);
  await drain(h.step({ ...step, turnId: 't4', model: 'claude-sonnet-5-5' }));
  assert.equal(h.loop().decision.escalated, true);
  h.messages(async () => [...failing, assistant('done', ['Bash'])]);
  await h.event('turn.complete', { turnId: 't4' });
  assert.deepEqual(h.view().activityMetrics.downMoves, { moves: 1, escalations: 0 });
});

test('a Manual turn ends the watch a cheaper move started while routing was turned off mid-turn', async () => {
  const h = harness(JEV_KEY);
  h.files.set(
    CONFIG,
    JSON.stringify({ activityRouting: 'on', activities: { ops: { low: { model: 'haiku', effort: 'medium' } } } }),
  );
  h.model('claude-sonnet-5-5');
  answering(
    h,
    jevResponse('low', LOW, 0, { code: 0.9, ops: 0.1 }),
    jevResponse('low', LOW, 0, { ops: 0.81, code: 0.19 }),
  );
  await h.event('session.start', { cwd: '/fixture' });
  await turn(h, 't1', 'claude-sonnet-5-5', ['Edit']);
  await h.event('turn.start', { turnId: 't2', text: 'Next.' });
  h.messages(async () => [user('Next.')]);
  await drain(h.step({ ...step, turnId: 't2', model: 'claude-sonnet-5-5' }));
  assert.equal(h.loop().decision.reason, 'activity-down');
  await h.event('command.run', { command: 'router', args: 'off' });
  h.messages(async () => [user('Next.'), assistant('done', ['Bash'])]);
  await h.event('turn.complete', { turnId: 't2' });
  await turn(h, 't3', 'claude-sonnet-5-5', ['Bash']);
  await h.event('command.run', { command: 'router', args: 'auto' });
  const failing = [
    user('Fix the test.'),
    assistant('running', ['Bash']),
    toolResult('error: test_login failed', { isError: true }),
    assistant('editing', ['Edit']),
    toolResult('error: test_login failed', { isError: true }),
    user('Next.'),
  ];
  await h.event('turn.start', { turnId: 't4', text: 'Next.' });
  h.messages(async () => failing);
  await drain(h.step({ ...step, turnId: 't4', model: 'claude-sonnet-5-5' }));
  assert.equal(h.loop().decision.escalated, true);
  h.messages(async () => [...failing, assistant('done', ['Bash'])]);
  await h.event('turn.complete', { turnId: 't4' });
  assert.equal(h.view().activityMetrics.downMoves.escalations, 0);
});

test('turning routing off mid-turn and straight back on does not keep the watch for that move', async () => {
  const h = harness(JEV_KEY);
  h.files.set(
    CONFIG,
    JSON.stringify({ activityRouting: 'on', activities: { ops: { low: { model: 'haiku', effort: 'medium' } } } }),
  );
  h.model('claude-sonnet-5-5');
  answering(
    h,
    jevResponse('low', LOW, 0, { code: 0.9, ops: 0.1 }),
    jevResponse('low', LOW, 0, { ops: 0.81, code: 0.19 }),
  );
  await h.event('session.start', { cwd: '/fixture' });
  await turn(h, 't1', 'claude-sonnet-5-5', ['Edit']);
  await h.event('turn.start', { turnId: 't2', text: 'Next.' });
  h.messages(async () => [user('Next.')]);
  await drain(h.step({ ...step, turnId: 't2', model: 'claude-sonnet-5-5' }));
  assert.equal(h.loop().decision.reason, 'activity-down');
  await h.event('command.run', { command: 'router', args: 'off' });
  h.messages(async () => [user('Next.'), assistant('done', ['Bash'])]);
  await h.event('turn.complete', { turnId: 't2' });
  await h.event('command.run', { command: 'router', args: 'auto' });
  const failing = [
    user('Fix the test.'),
    assistant('running', ['Bash']),
    toolResult('error: test_login failed', { isError: true }),
    assistant('editing', ['Edit']),
    toolResult('error: test_login failed', { isError: true }),
    user('Next.'),
  ];
  await h.event('turn.start', { turnId: 't4', text: 'Next.' });
  h.messages(async () => failing);
  await drain(h.step({ ...step, turnId: 't4', model: 'claude-sonnet-5-5' }));
  assert.equal(h.loop().decision.escalated, true);
  h.messages(async () => [...failing, assistant('done', ['Bash'])]);
  await h.event('turn.complete', { turnId: 't4' });
  assert.equal(h.view().activityMetrics.downMoves.escalations, 0);
});

test('turning routing off and back on before the turn finishes does not keep the watch for that move', async () => {
  const h = harness(JEV_KEY);
  h.files.set(
    CONFIG,
    JSON.stringify({ activityRouting: 'on', activities: { ops: { low: { model: 'haiku', effort: 'medium' } } } }),
  );
  h.model('claude-sonnet-5-5');
  answering(
    h,
    jevResponse('low', LOW, 0, { code: 0.9, ops: 0.1 }),
    jevResponse('low', LOW, 0, { ops: 0.81, code: 0.19 }),
  );
  await h.event('session.start', { cwd: '/fixture' });
  await turn(h, 't1', 'claude-sonnet-5-5', ['Edit']);
  await h.event('turn.start', { turnId: 't2', text: 'Next.' });
  h.messages(async () => [user('Next.')]);
  await drain(h.step({ ...step, turnId: 't2', model: 'claude-sonnet-5-5' }));
  assert.equal(h.loop().decision.reason, 'activity-down');
  await h.event('command.run', { command: 'router', args: 'off' });
  await h.event('command.run', { command: 'router', args: 'auto' });
  h.messages(async () => [user('Next.'), assistant('done', ['Bash'])]);
  await h.event('turn.complete', { turnId: 't2' });
  const failing = [
    user('Fix the test.'),
    assistant('running', ['Bash']),
    toolResult('error: test_login failed', { isError: true }),
    assistant('editing', ['Edit']),
    toolResult('error: test_login failed', { isError: true }),
    user('Next.'),
  ];
  await h.event('turn.start', { turnId: 't4', text: 'Next.' });
  h.messages(async () => failing);
  await drain(h.step({ ...step, turnId: 't4', model: 'claude-sonnet-5-5' }));
  assert.equal(h.loop().decision.escalated, true);
  h.messages(async () => [...failing, assistant('done', ['Bash'])]);
  await h.event('turn.complete', { turnId: 't4' });
  assert.equal(h.view().activityMetrics.downMoves.escalations, 0);
});

test('turning routing off and back on while the finished turn is recorded does not keep the watch for that move', async () => {
  const h = harness(JEV_KEY);
  h.files.set(
    CONFIG,
    JSON.stringify({ activityRouting: 'on', activities: { ops: { low: { model: 'haiku', effort: 'medium' } } } }),
  );
  h.model('claude-sonnet-5-5');
  answering(
    h,
    jevResponse('low', LOW, 0, { code: 0.9, ops: 0.1 }),
    jevResponse('low', LOW, 0, { ops: 0.81, code: 0.19 }),
  );
  await h.event('session.start', { cwd: '/fixture' });
  await turn(h, 't1', 'claude-sonnet-5-5', ['Edit']);
  await h.event('turn.start', { turnId: 't2', text: 'Next.' });
  h.messages(async () => [user('Next.')]);
  await drain(h.step({ ...step, turnId: 't2', model: 'claude-sonnet-5-5' }));
  assert.equal(h.loop().decision.reason, 'activity-down');
  const id = h.$.session.id;
  let reads = null;
  h.$.session.id = async () => {
    const sessionId = await id();
    // The second read after the messages is the record's last: routing goes off and back on while it is pending.
    if (reads !== null && ++reads === 2) {
      reads = null;
      await h.event('command.run', { command: 'router', args: 'off' });
      await h.event('command.run', { command: 'router', args: 'auto' });
    }
    return sessionId;
  };
  h.messages(async () => {
    reads = 0;
    return [user('Next.'), assistant('done', ['Bash'])];
  });
  await h.event('turn.complete', { turnId: 't2' });
  h.$.session.id = id;
  const failing = [
    user('Fix the test.'),
    assistant('running', ['Bash']),
    toolResult('error: test_login failed', { isError: true }),
    assistant('editing', ['Edit']),
    toolResult('error: test_login failed', { isError: true }),
    user('Next.'),
  ];
  await h.event('turn.start', { turnId: 't4', text: 'Next.' });
  h.messages(async () => failing);
  await drain(h.step({ ...step, turnId: 't4', model: 'claude-sonnet-5-5' }));
  assert.equal(h.loop().decision.escalated, true);
  h.messages(async () => [...failing, assistant('done', ['Bash'])]);
  await h.event('turn.complete', { turnId: 't4' });
  assert.equal(h.view().activityMetrics.downMoves.escalations, 0);
});

test('with activity routing on, a turn without an activity answer keeps the activity but ends the run', async () => {
  const h = harness(JEV_KEY);
  h.files.set(CONFIG, JSON.stringify({ activityRouting: 'on' }));
  h.model('claude-sonnet-5-5');
  answering(h, jevResponse('low', LOW, 0, { code: 0.9, ops: 0.1 }), jevResponse('low', LOW, 0));
  await h.event('session.start', { cwd: '/fixture' });
  await turn(h, 't1', 'claude-sonnet-5-5', ['Edit']);
  await turn(h, 't2', 'claude-sonnet-5-5', ['Edit']);
  assert.equal(h.loop().lastActivity, 'code');
  assert.deepEqual(h.view().activities, ['code', 'code']);
  assert.deepEqual(h.preferences.get(STATS).runs, { code: [1, 0, 0, 0, 0] });
});

test('the classifier latency is the wait for its answer, not the routing after it', async () => {
  const h = harness(JEV_KEY);
  h.files.set(CONFIG, JSON.stringify({ activityRouting: 'on' }));
  answering(h, jevResponse('low', LOW, 0, { code: 0.9, ops: 0.1 }));
  await h.event('session.start', { cwd: '/fixture' });
  const set = h.$.state.set;
  h.$.state.set = async (...args) => {
    await new Promise((resolve) => setTimeout(resolve, 120));
    return set(...args);
  };
  await turn(h, 't1', 'claude-sonnet-5-5', ['Edit']);
  assert.deepEqual(h.preferences.get('activity:metrics:v1:s1').latency.jev, [1, ...Array(21).fill(0)]);
});

test('the counts across sessions reach the view and survive a restart', async () => {
  const h = harness(JEV_KEY);
  answering(h, jevResponse('low', LOW, 0, { code: 0.9, ops: 0.1 }));
  await h.event('session.start', { cwd: '/fixture' });
  await turn(h, 't1', 'claude-haiku-5-5', ['Edit']);
  await turn(h, 't2', 'claude-haiku-5-5', ['Edit']);
  assert.deepEqual(h.view().activityStore, h.preferences.get(STATS));
  await press(h, 'tab-usage');
  const lines = texts(await h.render());
  assert.ok(lines.includes('Agreement  classifier vs tools: 2 of 2 turns (100%)'));
  h.surfaces([]);
  const detail = async (r) => (await r.event('command.run', { command: 'router', args: '' })).text;
  assert.match(
    await detail(h),
    /^Agreement across sessions: 2 of 2 turns \(100%\) · code\/ops\/explore 2 of 2 \(100%\)$/m,
  );
  await h.event('session.end', { reason: 'clear' });

  const reloaded = harness(JEV_KEY, h.preferences);
  await reloaded.event('session.start', { cwd: '/fixture' });
  assert.equal(reloaded.view().activityStats, null);
  assert.deepEqual(reloaded.view().activityStore, h.preferences.get(STATS));
  await press(reloaded, 'tab-classifier');
  assert.ok(texts(await reloaded.render()).includes('Labelled   2 turns'));
});

test('a corrupted or unreadable stats store shows an empty readout and never breaks the session', async () => {
  for (const [name, preferences] of [
    ['corrupted', new Map([[STATS, { version: 1, confusion: 'text' }]])],
    [
      'unreadable',
      {
        get: (key) => {
          if (key === STATS) throw new Error('store down');
        },
        set: () => {},
      },
    ],
  ]) {
    const h = harness(JEV_KEY, preferences);
    await h.event('session.start', { cwd: '/fixture' });
    assert.equal(h.view().phase, 'ready', name);
    await press(h, 'tab-classifier');
    const lines = texts(await h.render());
    assert.ok(!lines.includes('ACROSS SESSIONS · since the last reset'), name);
    h.surfaces([]);
    const { text } = await h.event('command.run', { command: 'router', args: '' });
    assert.match(text, /^Agreement across sessions: no labelled turns yet$/m, name);
  }
});

test('/router activities writes the mode to router.json, off stops the question, and Undo restores it', async () => {
  const h = harness(JEV_KEY);
  const bodies = answering(h, jevResponse('low', LOW, 0, { code: 0.9, ops: 0.1 }));
  await h.event('session.start', { cwd: '/fixture' });
  await turn(h, 't1', 'claude-haiku-5-5');
  assert.ok(bodies[0].questions.activity);
  const command = async (args) => (await h.event('command.run', { command: 'router', args })).text;
  assert.equal(await command('activities later'), 'Choose activities off, on.');
  assert.equal(await command('activities on'), 'Activity routing is already on.');
  assert.equal(await command('activities off'), 'Saved: activity routing on → off. Applies from the next turn.');
  assert.deepEqual(JSON.parse(h.files.get(CONFIG)), { activityRouting: 'off' });
  await turn(h, 't2', 'claude-haiku-5-5');
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1].questions.activity, undefined);
  assert.equal(h.view().activity, null);
  assert.equal(h.view().activityStats.byActivity.code.turns, 1);
  assert.equal(h.view().activityStats.byActivity.none, undefined);
  await press(h, 'undo');
  assert.deepEqual(JSON.parse(h.files.get(CONFIG)), {});
  await turn(h, 't3', 'claude-haiku-5-5');
  assert.ok(bodies[2].questions.activity);
});

test('a failing stats store or transcript never breaks a turn', async () => {
  const saved = new Map();
  const store = {
    get: (key) => {
      if (key === STATS) throw new Error('store down');
      return saved.get(key);
    },
    set: (key, value) => {
      if (key === STATS) throw new Error('store down');
      return saved.set(key, value);
    },
  };
  const h = harness(JEV_KEY, store);
  answering(h, jevResponse('low', LOW, 0, { code: 0.9, ops: 0.1 }));
  await h.event('session.start', { cwd: '/fixture' });
  await turn(h, 't1', 'claude-haiku-5-5', ['Edit']);
  assert.equal(h.requests[0].model, 'claude-sonnet-5-5');
  assert.equal(h.view().activityStats.byActivity.code.turns, 1);
  await h.event('turn.start', { turnId: 't2', text: 'Next.' });
  await drain(h.step({ ...step, turnId: 't2' }));
  h.messages(() => Promise.reject(new Error('transcript gone')));
  await h.event('turn.complete', { turnId: 't2' });
  assert.equal(h.requests.length, 2);
  assert.equal(h.view().activityStats.byActivity.code.turns, 1);
  await h.event('session.end', { reason: 'clear' });
});

test('a turn finishing while the session changes records nothing into the new session', async () => {
  const h = harness(JEV_KEY);
  answering(h, jevResponse('low', LOW, 0, { code: 0.9, ops: 0.1 }));
  await h.event('session.start', { cwd: '/fixture' });
  await turn(h, 't1', 'claude-haiku-5-5', ['Edit']);
  await h.event('turn.start', { turnId: 't2', text: 'Next.' });
  await drain(h.step({ ...step, turnId: 't2' }));
  let release;
  h.messages(() => new Promise((resolve) => (release = () => resolve([user('Next.'), assistant('done', ['Edit'])]))));
  const completing = h.event('turn.complete', { turnId: 't2' });
  for (let i = 0; i < 100 && !release; i += 1) await Promise.resolve();
  await h.event('session.end', { reason: 'clear' });
  h.clear('s2');
  await h.event('session.start', { cwd: '/fixture' });
  release();
  await completing;
  assert.equal(h.view().activityStats, null);
  assert.deepEqual(h.preferences.get(STATS).confusion, { code: { code: 1 } });
  assert.deepEqual(h.preferences.get(STATS).runs, { code: [1, 0, 0, 0, 0] });
});

test('a session ending while a turn writes its stats leaves no run in the new session', async () => {
  const h = harness(JEV_KEY);
  answering(h, jevResponse('low', LOW, 0, { code: 0.9, ops: 0.1 }));
  await h.event('session.start', { cwd: '/fixture' });
  await turn(h, 't1', 'claude-haiku-5-5', ['Edit']);
  await h.event('turn.start', { turnId: 't2', text: 'Next.' });
  await drain(h.step({ ...step, turnId: 't2' }));
  h.messages(async () => [user('Next.'), assistant('done', ['Edit'])]);
  const set = h.$.state.set;
  let release;
  h.$.state.set = async (ref, value, options) => {
    if (ref.key === 'view' && value.activityStats && !release) await new Promise((resolve) => (release = resolve));
    return set(ref, value, options);
  };
  const completing = h.event('turn.complete', { turnId: 't2' });
  for (let i = 0; i < 100 && !release; i += 1) await Promise.resolve();
  h.$.state.set = set;
  await h.event('session.end', { reason: 'clear' });
  h.clear('s2');
  await h.event('session.start', { cwd: '/fixture' });
  release();
  await completing;
  await h.event('session.end', { reason: 'clear' });
  assert.deepEqual(h.preferences.get(STATS).runs, { code: [0, 1, 0, 0, 0] });
});

test('a Sonnet session limited to Sonnet keeps its effort on a turn the code cell was not chosen for', async () => {
  const sonnet = 'claude-sonnet-5-5';
  const h = harness(JEV_KEY);
  h.settings({ availableModels: ['sonnet'] });
  h.model(sonnet);
  answering(h, jevResponse('low', LOW, 0, { explore: 0.95, code: 0.05 }));
  await start(h);
  await drain(h.step({ ...step, model: sonnet, effort: 'low' }));
  assert.deepEqual(
    [h.requests[0].model, h.requests[0].effort, h.view().tier, h.view().activity],
    [sonnet, 'low', null, null],
  );
});

test('with activity routing on, a continuation that falls back to the native model drops the activity label', async () => {
  const h = harness(JEV_KEY);
  h.files.set(CONFIG, JSON.stringify({ activityRouting: 'on' }));
  answering(h, jevResponse('low', LOW, 0, { code: 0.95, ops: 0.05 }));
  await h.event('session.start', { cwd: '/fixture' });
  await h.event('turn.start', { turnId: 't1', text: 'Next.' });
  await drain(h.step(step));
  assert.deepEqual([h.requests[0].model, h.view().activity], ['claude-sonnet-5-5', 'code']);
  h.settings({ availableModels: ['haiku'] });
  await drain(h.step({ ...step, index: 1, messageCount: 3 }));
  assert.deepEqual([h.requests[1].model, h.view().tier, h.view().activity], ['claude-haiku-5-5', null, null]);
});

const SAVINGS = 'savings:v1:';

test('a routed reply is priced against your model in the session totals and, at turn end, the store', async () => {
  // A plan subscriber's replies report plan rate limits, and Claude Code then caches the main conversation for 1h.
  for (const [rateLimits, writeMultiplier] of [
    [[], 1.25],
    [[{ kind: 'five_hour', percentUsed: 10 }], 2],
  ]) {
    const h = harness(JEV_KEY);
    answering(h, jevResponse('low', LOW));
    h.usage({ startedAt: 0, context: { tokens: 8000 }, rateLimits });
    await h.event('session.start', { cwd: '/fixture' });
    await turn(h, 't1', 'claude-haiku-5-5');
    assert.deepEqual([h.requests[0].model, h.requests[0].effort], ['claude-haiku-5-5', 'high']);
    // Haiku at high against the session's Haiku at medium: one price, and the API read what a single cache would.
    const usd = (0.1 * (100 + 200 * writeMultiplier) + 0.01 * 800 + 0.5 * 10) / 1e6;
    const { savings } = h.view();
    assert.equal(savings.replies, 1);
    assert.ok(Math.abs(savings.routedUsd - usd) < 1e-12);
    assert.equal(savings.yoursUsd, savings.routedUsd);
    assert.deepEqual(savings.tiers, { low: 1 });
    // Haiku 5.5 keeps one cache across efforts, so the reply ran on your cache.
    assert.deepEqual([yours(h).total, yours(h).onYours], [1100, true]);
    assert.equal(h.preferences.get(`${SAVINGS}s1`).replies, 1);
    assert.ok(Number.isFinite(h.preferences.get(`${SAVINGS}s1`).since));
    assert.deepEqual(h.view().savingsStore, h.preferences.get(`${SAVINGS}s1`));
  }
});

test('a /model change shows the whole session against the new model; the store keeps each reply against its own', async () => {
  const h = harness(JEV_KEY);
  answering(h, jevResponse('low', LOW));
  h.usage({ startedAt: 0, context: { tokens: 8000 }, rateLimits: [] });
  await h.event('session.start', { cwd: '/fixture' });
  await turn(h, 't1', 'claude-haiku-5-5');
  const { savingsBy } = h.view();
  assert.deepEqual(Object.keys(savingsBy).sort(), ['haiku', 'opus', 'sonnet']);
  assert.deepEqual(h.view().savings, savingsBy.haiku);
  assert.ok(
    savingsBy.opus.yoursUsd > savingsBy.sonnet.yoursUsd && savingsBy.sonnet.yoursUsd > savingsBy.haiku.yoursUsd,
  );
  h.model('claude-opus-5-5');
  await h.event('command.run', { command: 'model', origin: { kind: 'user' } });
  assert.deepEqual(h.view().savings, savingsBy.opus);
  assert.equal(h.preferences.get(`${SAVINGS}s1`).yoursUsd, savingsBy.haiku.yoursUsd);
});

test('opening the pane while a turn writes its saved total counts the turn once', async () => {
  let gate = null;
  const preferences = new (class extends Map {
    set(key, value) {
      super.set(key, value);
      if (!gate || !key.startsWith(SAVINGS)) return this;
      gate.reached();
      return gate.written;
    }
  })();
  const h = harness(JEV_KEY, preferences);
  answering(h, jevResponse('low', LOW));
  await h.event('session.start', { cwd: '/fixture' });
  await h.event('turn.start', { turnId: 't1', text: 'Next.' });
  await drain(h.step({ ...step, model: 'claude-haiku-5-5' }));
  const reached = Promise.withResolvers();
  const written = Promise.withResolvers();
  gate = { reached: reached.resolve, written: written.promise };
  const completing = h.event('turn.complete', { turnId: 't1' });
  await reached.promise;
  gate = null;
  await h.event('command.run', { command: 'router', args: '' });
  written.resolve();
  await completing;
  assert.equal(h.view().savingsStore.replies, 1);
  await h.event('command.run', { command: 'router', args: '' });
  assert.equal(h.view().savingsStore.replies, 1);
});

test('two sessions finishing turns at the same moment both add to the totals kept across sessions', async () => {
  const writes = [];
  let gated = false;
  // Each write lands only once both sessions have sent theirs.
  const preferences = new (class extends Map {
    set(key, value) {
      if (!gated || !key.startsWith(SAVINGS)) return super.set(key, value);
      const { promise, resolve } = Promise.withResolvers();
      writes.push(() => resolve(super.set(key, value)));
      if (writes.length === 2) for (const write of writes) write();
      return promise;
    }
  })();
  const sessions = [harness(JEV_KEY, preferences), harness(JEV_KEY, preferences)];
  sessions[1].clear('s2');
  for (const h of sessions) {
    answering(h, jevResponse('low', LOW));
    await h.event('session.start', { cwd: '/fixture' });
    await h.event('turn.start', { turnId: 't1', text: 'Next.' });
    await drain(h.step({ ...step, model: 'claude-haiku-5-5' }));
  }
  gated = true;
  await Promise.all(sessions.map((h) => h.event('turn.complete', { turnId: 't1' })));
  gated = false;
  assert.equal(writes.length, 2);
  await sessions[0].event('command.run', { command: 'router', args: '' });
  assert.equal(sessions[0].view().savingsStore.replies, 2);
});

test('two sessions finishing turns at the same moment both add to the metrics kept across sessions', async () => {
  const writes = [];
  let gated = false;
  // Each write lands only once both sessions have sent theirs.
  const preferences = new (class extends Map {
    set(key, value) {
      if (!gated || !key.startsWith('activity:metrics:')) return super.set(key, value);
      const { promise, resolve } = Promise.withResolvers();
      writes.push(() => resolve(super.set(key, value)));
      if (writes.length === 2) for (const write of writes) write();
      return promise;
    }
  })();
  const sessions = [harness(JEV_KEY, preferences), harness(JEV_KEY, preferences)];
  sessions[1].clear('s2');
  for (const h of sessions) {
    answering(h, jevResponse('low', LOW, 0, { code: 0.9, ops: 0.1 }));
    await h.event('session.start', { cwd: '/fixture' });
    await h.event('turn.start', { turnId: 't1', text: 'Next.' });
    await drain(h.step({ ...step, model: 'claude-haiku-5-5' }));
  }
  gated = true;
  await Promise.all(sessions.map((h) => h.event('turn.complete', { turnId: 't1' })));
  gated = false;
  assert.equal(writes.length, 2);
  await sessions[0].event('command.run', { command: 'router', args: '' });
  assert.deepEqual(sessions[0].view().activityMetrics.latency.jev, [2, ...Array(21).fill(0)]);
});

test('a Reset in one session drops what another session still holds from before it', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
  const preferences = new Map();
  const [a, b] = [harness(JEV_KEY, preferences), harness(JEV_KEY, preferences)];
  b.clear('s2');
  answering(b, jevResponse('low', LOW));
  await b.event('session.start', { cwd: '/fixture' });
  await turn(b, 't1', 'claude-haiku-5-5');
  assert.equal(preferences.get(`${SAVINGS}s2`).replies, 1);
  await a.event('session.start', { cwd: '/fixture' });
  t.mock.timers.tick(1);
  await press(a, 'tab-usage');
  await press(a, 'reset-stats');
  t.mock.timers.tick(1);
  const before = preferences.get(`${SAVINGS}s2`);
  assert.equal(before, undefined);
  await turn(b, 't2', 'claude-haiku-5-5');
  const record = preferences.get(`${SAVINGS}s2`);
  assert.equal(record.replies, 1);
  assert.deepEqual([preferences.get('savings:reset:v1'), record.since], [1_001, 1_002]);
  assert.equal(b.view().savingsStore.replies, 1);
  await a.event('command.run', { command: 'router', args: '' });
  assert.equal(a.view().savingsStore.replies, 1);
});

test('a Reset in one session drops the metrics another session still holds from before it', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
  const preferences = new Map();
  const [a, b] = [harness(JEV_KEY, preferences), harness(JEV_KEY, preferences)];
  b.clear('s2');
  answering(b, jevResponse('low', LOW, 0, { code: 0.9, ops: 0.1 }));
  await b.event('session.start', { cwd: '/fixture' });
  await turn(b, 't1', 'claude-haiku-5-5', ['Edit']);
  assert.deepEqual(preferences.get('activity:metrics:v1:s2').latency.jev, [1, ...Array(21).fill(0)]);
  await a.event('session.start', { cwd: '/fixture' });
  t.mock.timers.tick(1);
  await press(a, 'tab-usage');
  await press(a, 'reset-stats');
  assert.equal(preferences.get('activity:metrics:v1:s2'), undefined);
  t.mock.timers.tick(1);
  await turn(b, 't2', 'claude-haiku-5-5', ['Edit']);
  const record = preferences.get('activity:metrics:v1:s2');
  assert.deepEqual([record.since, record.latency.jev], [1_002, [1, ...Array(21).fill(0)]]);
  await a.event('command.run', { command: 'router', args: '' });
  assert.deepEqual(a.view().activityMetrics.latency.jev, [1, ...Array(21).fill(0)]);
});

test('a Reset in one session drops the other sessions’ totals another session read before it', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
  const preferences = new Map();
  const [a, b] = [harness(JEV_KEY, preferences), harness(JEV_KEY, preferences)];
  b.clear('s2');
  answering(a, jevResponse('low', LOW));
  answering(b, jevResponse('low', LOW));
  await a.event('session.start', { cwd: '/fixture' });
  await turn(a, 't1', 'claude-haiku-5-5');
  await b.event('session.start', { cwd: '/fixture' });
  assert.equal(b.view().savingsStore.replies, 1);
  t.mock.timers.tick(1);
  await press(a, 'tab-usage');
  await press(a, 'reset-stats');
  t.mock.timers.tick(1);
  await turn(b, 't1', 'claude-haiku-5-5');
  assert.equal(b.view().savingsStore.replies, 1);
  assert.equal(b.view().savingsStore.since, 1_002);
});

test('with routing off a reply is not counted, and your model’s cache still follows it', async () => {
  const h = harness(JEV_KEY);
  await h.event('session.start', { cwd: '/fixture' });
  await h.event('command.run', { command: 'router', args: 'off' });
  await turn(h, 't1', 'claude-haiku-5-5');
  assert.equal(h.requests[0].effort, 'medium');
  assert.equal(h.view().savings, null);
  assert.deepEqual([yours(h).total, yours(h).onYours], [1100, true]);
  assert.equal(h.preferences.get(`${SAVINGS}s1`), undefined);
  h.surfaces([]);
  const { text } = await h.event('command.run', { command: 'router', args: '' });
  assert.match(text, /^vs your model \(Haiku 5\.5 · medium\): no routed replies this session$/m);
});

test('a session usage without rate limits prices cache writes at five minutes', async () => {
  const h = harness(JEV_KEY);
  answering(h, jevResponse('low', LOW));
  h.usage({ startedAt: 0, context: { tokens: 8000 } });
  await h.event('session.start', { cwd: '/fixture' });
  await turn(h, 't1', 'claude-haiku-5-5');
  const usd = (0.1 * (100 + 200 * 1.25) + 0.01 * 800 + 0.5 * 10) / 1e6;
  assert.equal(h.view().savings.replies, 1);
  assert.ok(Math.abs(h.view().savings.routedUsd - usd) < 1e-12);
});

test('turns on an unchanged session model and effort keep your model’s cache warm', async () => {
  const h = harness(JEV_KEY);
  // Each effort its own cache, so the replies at high are off your Haiku at medium and its cache is simulated.
  h.env.set('CLAUDE_CODE_USE_BEDROCK', '1');
  answering(h, jevResponse('low', LOW));
  h.usage({ startedAt: 0, context: { tokens: 8000 } });
  await h.event('session.start', { cwd: '/fixture' });
  await turn(h, 't1', 'claude-haiku-5-5');
  await turn(h, 't2', 'claude-haiku-5-5');
  assert.deepEqual(
    h.requests.map((request) => request.effort),
    ['high', 'high'],
  );
  assert.deepEqual([yours(h).model, yours(h).effort], ['claude-haiku-5-5', 'medium']);
  const first = (0.1 * (100 + 200 * 1.25) + 0.01 * 800 + 0.5 * 10) / 1e6;
  // The second reply reads the whole previous prompt on your model's cache and writes nothing.
  const warm = (0.1 * 100 + 0.01 * 1_000 + 0.5 * 10) / 1e6;
  assert.ok(Math.abs(h.view().savings.yoursUsd - (first + warm)) < 1e-12);
});

test('a reply whose cache lifetime cannot be read is not counted, and your model’s cache still follows it', async () => {
  const h = harness(JEV_KEY);
  h.env.set('CLAUDE_CODE_USE_BEDROCK', '1');
  answering(h, jevResponse('low', LOW));
  await h.event('session.start', { cwd: '/fixture' });
  await h.event('command.run', { command: 'router', args: 'off' });
  await turn(h, 't1', 'claude-haiku-5-5');
  assert.equal(yours(h).onYours, true);
  await h.event('command.run', { command: 'router', args: 'auto' });
  const usage = h.$.session.usage;
  h.$.session.usage = async () => {
    throw new Error('usage unavailable');
  };
  await turn(h, 't2', 'claude-haiku-5-5');
  assert.equal(h.requests.at(-1).effort, 'high');
  assert.equal(h.view().savings, null);
  assert.equal(yours(h).onYours, false);
  h.$.session.usage = usage;
  await turn(h, 't3', 'claude-haiku-5-5');
  assert.equal(h.view().savings.replies, 1);
});

test('a corrupted saved total never breaks a turn', async () => {
  const h = harness(JEV_KEY, new Map([[`${SAVINGS}s1`, { version: 9, replies: 'many' }]]));
  answering(h, jevResponse('low', LOW));
  await h.event('session.start', { cwd: '/fixture' });
  assert.equal(h.view().savingsStore.replies, 0);
  await turn(h, 't1', 'claude-haiku-5-5');
  assert.equal(h.requests.length, 1);
  assert.equal(h.view().savings.replies, 1);
  assert.equal(h.preferences.get(`${SAVINGS}s1`).replies, 1);
});

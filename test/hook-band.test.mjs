import assert from 'node:assert/strict';
import test from 'node:test';
import { band, CONFIG, controls, drain, harness, start, step, texts } from './harness.mjs';

test('the band shows the tier meter, route, reason and context after a routed reply', async () => {
  const h = harness();
  await start(h);
  await h.event('command.run', { command: 'router', args: 'pin high' });
  await drain(h.step(step));
  const { line, controls: buttons } = await band(h);
  assert.match(line, /▂▄▆█ high {2}Opus 5\.5 · xhigh/);
  assert.match(line, /⏵ pinned/);
  assert.match(line, /ctx \d+% · cache hit \d+%/);
  assert.ok(buttons.some((node) => node.key === 'details'));
  assert.doesNotMatch(line, /Jev Router/);
});

test('a narrow band drops context and reason before the route', async () => {
  const h = harness();
  await start(h);
  await h.event('command.run', { command: 'router', args: 'pin high' });
  await drain(h.step(step));
  const { line } = await band(h, { bodyColumns: 40 });
  assert.match(line, /high {2}Opus 5\.5 · xhigh/);
  assert.doesNotMatch(line, /ctx|pinned/);
});

test('the band yields to a survey and says how a subagent got its model', async () => {
  const h = harness();
  await start(h);
  assert.equal((await band(h, { hasSurvey: true })).tree.component, 'AbovePrompt');
  assert.match((await band(h, { view: { agentId: 'a1' } })).line, /subagent model chosen at spawn/);
  const off = harness();
  off.files.set(CONFIG, JSON.stringify({ subagentRouting: 'off' }));
  await start(off);
  assert.match((await band(off, { view: { agentId: 'a1' } })).line, /subagents keep their own model/);
});

test('in a subagent’s transcript the band names its model and who picked it', async () => {
  const h = harness();
  await start(h);
  const spawn = (extra) => ({
    tool_use_id: 'toolu_1',
    prompt: 'Find where the cache key is built.',
    subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    fork: false,
    ...extra,
  });
  await h.spawn(spawn(), { model: 'claude-haiku-5-5', agentId: 'a1' });
  await h.spawn(spawn({ workflow: { runId: 'wf_1', agentIndex: 1 } }), { model: 'claude-opus-5-5', agentId: 'w1' });
  const routed = (columns) => band(h, { view: { agentId: 'a1' }, bodyColumns: columns });
  assert.equal((await routed(120)).line, '○ Router · ■ Haiku 5.5 · moved down by the router · Claude Code: Opus 5.5');
  assert.equal((await routed(50)).line, '○ Router · ■ Haiku 5.5 · moved down by the router');
  assert.equal(
    (await band(h, { view: { agentId: 'w1' } })).line,
    '○ Router · □ Opus 5.5 · Claude Code’s pick: the workflow sets it',
  );
});

test('the band offers Routing on in Manual mode and a key button without a key', async () => {
  const h = harness();
  await start(h);
  await drain(h.step(step));
  let view = await band(h);
  assert.match(view.line, /⚠ Jev: no API key .*Haiku 5\.5.* {2}· {2}keeping model/);
  await view.controls.find((node) => node.key === 'band-key').onPress();
  assert.equal(h.commandCalls(), 1);
  await h.event('command.run', { command: 'router', args: 'off' });
  view = await band(h);
  assert.match(view.line, /Routing off .*every turn uses Haiku 5\.5/);
  await view.controls.find((node) => node.key === 'band-auto').onPress();
  assert.equal(h.view().mode, 'auto');
});

test('the band hover row pins, unpins and switches to two rows', async () => {
  const preferences = new Map();
  const h = harness({}, preferences);
  await start(h);
  await (await band(h)).controls.find((node) => node.key === 'band-pin-medium').onPress();
  assert.equal(h.view().pendingPin, 'medium');
  assert.match(h.toasts.at(-1), /medium pinned/);
  await (await band(h)).controls.find((node) => node.key === 'band-unpin').onPress();
  assert.equal(h.view().pendingPin, null);
  await (await band(h)).controls.find((node) => node.key === 'band-detail').onPress();
  assert.equal(preferences.get('band:detail'), true);
  await h.event('command.run', { command: 'router', args: 'pin low' });
  await drain(h.step(step));
  assert.match((await band(h)).line, /session {2}1 reply · too early to compare/);
});

test('a route change raises one toast with the old and new model; a pin does not', async () => {
  const h = harness();
  await start(h);
  await h.event('command.run', { command: 'router', args: 'pin high' });
  await drain(h.step(step));
  assert.equal(h.toasts.length, 0);
  await h.event('turn.start', { turnId: 't2', text: 'Next.' });
  await drain(h.step({ ...step, turnId: 't2' }));
  assert.equal(h.toasts.length, 1);
  assert.match(h.toasts[0], /^Model changed: Opus 5\.5 · xhigh → Haiku 5\.5 · high · /);
});

test('the spinner says Choosing model only while the classifier runs', async () => {
  const h = harness({ typesafe_api_key: 'synthetic-key' });
  let calls = 0;
  h.http(() => {
    calls += 1;
    return new Promise(() => {});
  });
  await start(h);
  const spinner = { word: 'Baking', message: null, suffix: '…', mode: 'requesting' };
  assert.equal((await h.component('Spinner', spinner)).props.message, null);
  void drain(h.step(step));
  for (let i = 0; i < 100 && !calls; i += 1) await Promise.resolve();
  assert.equal((await h.component('Spinner', spinner)).props.message, 'Choosing model');
  assert.equal(
    (await h.component('Spinner', { ...spinner, message: 'Waiting for permission' })).props.message,
    'Waiting for permission',
  );
});

test('the footer labels routing off', async () => {
  const h = harness();
  await start(h);
  assert.deepEqual((await h.component('SessionMode', { modes: ['focus'] })).props.modes, ['focus']);
  await h.event('command.run', { command: 'router', args: 'off' });
  assert.deepEqual((await h.component('SessionMode', { modes: ['focus'] })).props.modes, ['focus', 'routing off']);
});

test('a narrow band never exceeds its width: optional parts drop, then the route is cut', async () => {
  const h = harness();
  await start(h);
  await drain(h.step(step));
  const widthOf = (line) => [...line].length;
  for (const [columns, expected] of [
    [120, /⚠ Jev: no API key .*Haiku 5\.5.* {2}· {2}keeping model/],
    [60, /⚠ Jev: no API key/],
    [30, /⚠ Jev: no API key/],
  ]) {
    const { tree } = await band(h, { bodyColumns: columns });
    const row = tree.props.children[1].props.children[0];
    const line = texts(row).join('');
    const buttons = controls(row)
      .map((node) => (node.plain ? node.label : `[ ${node.label} ]`))
      .join('');
    assert.match(line, expected, `at ${columns}`);
    assert.ok(widthOf(line) + widthOf(buttons) <= columns, `${columns}: ${line}${buttons}`);
  }
});

test('two presses on one drawn band toggle two rows on and off again', async () => {
  const preferences = new Map();
  const h = harness({}, preferences);
  await start(h);
  const detail = (await band(h)).controls.find((node) => node.key === 'band-detail');
  await detail.onPress();
  await detail.onPress();
  assert.equal(h.view().bandDetail, false);
  assert.equal(preferences.get('band:detail'), false);
});

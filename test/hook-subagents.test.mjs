import assert from 'node:assert/strict';
import test from 'node:test';
import { modelTotals, readSubagentStore, SUBAGENT_PREFIX, summarizeSubagents } from '../lib/subagents.mjs';
import { answering, CONFIG, drain, harness, JEV_KEY, press, screen, step } from './harness.mjs';
import { jevResponse } from './helpers.mjs';

const ENGINE = { plugin: 'engine', tier: 'core' };
const spawnInput = (extra = {}) => ({
  tool_use_id: 'toolu_1',
  prompt: 'Find where the cache key is built.',
  description: 'Locate cache key',
  subagentType: 'Explore',
  provider: ENGINE,
  parentModel: 'claude-opus-5-5',
  permissionMode: 'default',
  background: false,
  fork: false,
  ...extra,
});
const HARD = jevResponse('high', { micro: 0, low: 0, medium: 0.1, high: 0.9, uncertain: 0 });
const LOW = jevResponse('low', { micro: 0, low: 0.9, medium: 0.1, high: 0, uncertain: 0 });

async function started(file = {}, options = JEV_KEY) {
  const h = harness(options);
  h.files.set(CONFIG, JSON.stringify(file));
  await h.event('session.start', { cwd: '/fixture' });
  return h;
}

// One reply of the agent's loop and its turn's end, so its counts reach the store.
async function finish(h, agentId, model) {
  await drain(h.step({ ...step, turnId: `${agentId}-t`, agentId, model }));
  await h.event('turn.complete', { turnId: `${agentId}-t`, agentId });
}

const stored = (h) => h.preferences.get(`${SUBAGENT_PREFIX}s1`);
const kept = (h) => summarizeSubagents(readSubagentStore(stored(h)), { from: null, to: null });
const routedOf = (h, type) => {
  const counts = kept(h).routed[type];
  return { ...counts, ...modelTotals(counts), agents: counts.agents };
};

test('on, the default, spawns a listed type on its model, by full id', async () => {
  const h = await started();
  const { answer, sent } = await h.spawn(spawnInput());
  assert.equal(sent.model, 'claude-haiku-5-5');
  assert.equal(answer.model, 'claude-haiku-5-5');
  await finish(h, 'a1', 'claude-haiku-5-5');
  const counts = routedOf(h, 'Explore');
  assert.deepEqual(
    [counts.agents, counts.moved, counts.down, Object.keys(counts.models)],
    [1, 1, 1, ['claude-haiku-5-5']],
  );
  assert.ok(counts.usd < counts.coreUsd);
});

const PLUGINS = '/fixture/team/plugins';
// cc-thingz as installed: JSON frontmatter, runner pinned to Haiku, engineer inheriting.
function installCcThingz(h, runner = { model: 'haiku' }) {
  h.files.set(
    `${PLUGINS}/installed_plugins.json`,
    JSON.stringify({
      version: 2,
      plugins: {
        'discovery@cc-thingz': [{ scope: 'user', installPath: `${PLUGINS}/cache/discovery` }],
        'dev-flow@cc-thingz': [{ scope: 'user', installPath: `${PLUGINS}/cache/dev-flow` }],
      },
    }),
  );
  h.files.set(
    `${PLUGINS}/cache/discovery/agents/runner.md`,
    `---\n${JSON.stringify({ name: 'runner', ...runner })}\n---\nRun.`,
  );
  h.files.set(`${PLUGINS}/cache/dev-flow/agents/engineer.md`, '---\nname: engineer\nmodel: inherit\n---\nEdit.');
}
const ccThingz = (name) =>
  spawnInput({ subagentType: name, provider: { plugin: `${name.split(':')[0]}@cc-thingz`, tier: 'user' } });

test('a fork, a workflow agent, an explicit model, a teammate, a pinned agent and an unreadable one pass through in on', async () => {
  const h = await started();
  installCcThingz(h);
  // A project agent named Explore replaces the built-in and pins Sonnet.
  h.files.set('/fixture/project/.claude/agents/explore.md', '---\nname: Explore\nmodel: sonnet\n---\n');
  const cases = [
    ['fork', spawnInput({ fork: true, subagentType: 'fork' })],
    ['explicit', spawnInput({ model: 'opus' })],
    ['teammate', spawnInput({ isTeammate: true, background: true })],
    ['workflow', spawnInput({ subagentType: 'workflow-subagent', workflow: { runId: 'wf_1', agentIndex: 1 } })],
    ['pinned', spawnInput({ provider: { plugin: 'project', tier: 'user' } })],
    ['pinned', ccThingz('discovery:runner')],
    ['unknown', ccThingz('dev-flow:reviewer')],
    ['unlisted', spawnInput({ subagentType: 'statusline-setup' })],
  ];
  for (const [i, [reason, input]] of cases.entries()) {
    const agentId = `p${i}`;
    const { sent } = await h.spawn(input, { model: 'claude-opus-5-5', agentId });
    assert.equal(sent, input, `${reason} ${input.subagentType}`);
    await finish(h, agentId, 'claude-opus-5-5');
  }
  const { passed } = kept(h);
  assert.deepEqual(Object.fromEntries(Object.entries(passed).map(([reason, counts]) => [reason, counts.agents])), {
    fork: 1,
    explicit: 1,
    teammate: 1,
    workflow: 1,
    pinned: 2,
    unknown: 1,
    unlisted: 1,
  });
  assert.ok(passed.workflow.models['claude-opus-5-5'].usd > 0);
});

test('an agent that inherits, names no model or allows routing is classified from its installed definition', async () => {
  const h = await started();
  installCcThingz(h, { model: 'haiku', modelRouting: 'auto' });
  answering(h, HARD);
  assert.equal((await h.spawn(ccThingz('dev-flow:engineer'))).sent.model, 'claude-opus-5-5');
  const { sent } = await h.spawn(ccThingz('discovery:runner'), (e) => ({ model: e.model, agentId: 'r1' }));
  assert.equal(sent.model, 'claude-opus-5-5');
  await finish(h, 'r1', 'claude-opus-5-5');
  // Without the router the runner runs on its own Haiku: that is core's side of the comparison.
  const runner = routedOf(h, 'discovery:runner');
  assert.ok(runner.usd > runner.coreUsd);
  assert.equal(runner.up, 1);
  const user = await started();
  user.files.set('/fixture/team/agents/helper.md', '---\nname: helper\n---\n');
  answering(user, HARD);
  const helper = spawnInput({ subagentType: 'helper', provider: { plugin: 'user', tier: 'user' } });
  assert.equal((await user.spawn(helper)).sent.model, 'claude-opus-5-5');
});

test('a listed plugin agent is routed by its listing', async () => {
  const h = await started({ subagents: { types: { 'dev-flow:reviewer': 'sonnet' } } });
  assert.equal((await h.spawn(ccThingz('dev-flow:reviewer'))).sent.model, 'claude-sonnet-5-5');
});

test('a classify type asks with the task text alone and runs a clearly hard task on heavy', async () => {
  const h = await started({ subagentRouting: 'on' });
  const bodies = answering(h, HARD);
  const { sent } = await h.spawn(spawnInput({ subagentType: 'general-purpose', prompt: 'Design the cache layer.' }));
  assert.equal(sent.model, 'claude-opus-5-5');
  assert.deepEqual(bodies[0].state, {
    currentRequest: { text: 'Locate cache key\nDesign the cache layer.' },
    recentDialogue: [],
  });
});

test('a classifier failure keeps core’s model and counts the failure', async () => {
  const h = await started({ subagentRouting: 'on' });
  h.http(async () => ({ ok: false, status: 400, text: '', headers: {} }));
  const input = spawnInput({ subagentType: 'general-purpose' });
  const { sent } = await h.spawn(input);
  assert.equal(sent, input);
  await finish(h, 'a1', 'claude-opus-5-5');
  const counts = routedOf(h, 'general-purpose');
  assert.deepEqual([counts.agents, counts.moved, counts.failures], [1, 0, 1]);
});

test('spawn failures pause only the spawn path’s classifier, never main-turn routing', async () => {
  const h = await started({ subagentRouting: 'on' });
  h.http(async () => ({ ok: false, status: 400, text: '', headers: {} }));
  for (let i = 0; i < 4; i += 1) await h.spawn(spawnInput({ subagentType: 'general-purpose' }));
  const bodies = answering(h, LOW);
  await h.spawn(spawnInput({ subagentType: 'general-purpose' }));
  assert.equal(bodies.length, 0);
  await h.event('turn.start', { turnId: 't1', text: 'One edit.' });
  await drain(h.step(step));
  assert.equal(bodies.length, 1);
  assert.equal(h.view().health.failures, 0);
});

test('without a classifier key, a classify type keeps core’s model; a type with a model still routes', async () => {
  const h = await started({ subagentRouting: 'on' }, {});
  const input = spawnInput({ subagentType: 'Plan' });
  assert.equal((await h.spawn(input)).sent, input);
  assert.equal((await h.spawn(spawnInput())).sent.model, 'claude-haiku-5-5');
});

test('agents spawned at once each get the classifier’s answer', async () => {
  const h = await started({ subagentRouting: 'on' });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  h.http(async () => {
    await gate;
    return { ok: true, status: 200, text: JSON.stringify(LOW), headers: {} };
  });
  const both = Promise.all(
    [1, 2].map((n) => h.spawn(spawnInput({ subagentType: 'general-purpose' }), { model: 'x', agentId: `g${n}` })),
  );
  release();
  for (const { sent } of await both) assert.equal(sent.model, 'claude-sonnet-5-5');
});

test('on waits for the classifier before the agent starts', async () => {
  const h = await started();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  h.http(async () => {
    await gate;
    return { ok: true, status: 200, text: JSON.stringify(LOW), headers: {} };
  });
  let spawned = false;
  const spawning = h.spawn(spawnInput({ subagentType: 'general-purpose' }), (sent) => {
    spawned = true;
    return { model: sent.model, agentId: 'a1' };
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(spawned, false);
  release();
  await spawning;
  await finish(h, 'a1', 'claude-sonnet-5-5');
  assert.deepEqual(Object.keys(routedOf(h, 'general-purpose').models), ['claude-sonnet-5-5']);
});

test('a model availableModels blocks keeps core’s model', async () => {
  const h = await started({ subagentRouting: 'on' });
  h.settings({ availableModels: ['opus', 'sonnet'] });
  const input = spawnInput();
  assert.equal((await h.spawn(input)).sent, input);
});

test('settings that cannot be read keep core’s model, as they may limit the models', async () => {
  const h = await started({ subagentRouting: 'on' });
  h.$.settings.read = async () => {
    throw new Error('settings unreadable');
  };
  const input = spawnInput();
  assert.equal((await h.spawn(input)).sent, input);
});

test('an agent definition that could not be read is read again on the next spawn', async () => {
  const h = await started();
  installCcThingz(h, { model: 'haiku', modelRouting: 'auto' });
  answering(h, HARD);
  const read = h.$.fs.read;
  h.$.fs.read = async () => {
    throw new Error('file busy');
  };
  const input = ccThingz('dev-flow:engineer');
  assert.equal((await h.spawn(input)).sent, input);
  h.$.fs.read = read;
  assert.equal((await h.spawn(input)).sent.model, 'claude-opus-5-5');
});

test('off, routing off and a failing hook all spawn as Claude Code would', async () => {
  const off = await started({ subagentRouting: 'off' });
  const input = spawnInput();
  assert.equal((await off.spawn(input)).sent, input);
  await finish(off, 'a1', 'claude-opus-5-5');
  assert.equal(stored(off), undefined);

  const manual = await started({ subagentRouting: 'on' });
  await manual.event('command.run', { command: 'router', args: 'off' });
  assert.equal((await manual.spawn(input)).sent, input);

  const failing = await started({ subagentRouting: 'on' });
  failing.$.session.id = async () => {
    throw new Error('host lost');
  };
  const { answer, sent } = await failing.spawn(input);
  assert.equal(sent, input);
  assert.equal(answer.agentId, 'a1');
});

test('a subagent’s steps run as Claude Code sent them', async () => {
  const h = await started({ subagentRouting: 'on' });
  await h.spawn(spawnInput());
  const agentStep = { ...step, agentId: 'a1', model: 'claude-haiku-5-5', effort: 'high' };
  await drain(h.step(agentStep));
  assert.deepEqual(h.requests.at(-1), agentStep);
});

test('a spawn of a type its parent just finished one of counts as a respawn', async () => {
  const h = await started();
  await h.spawn(spawnInput(), { model: 'claude-haiku-5-5', agentId: 'a1' });
  await finish(h, 'a1', 'claude-haiku-5-5');
  await h.spawn(spawnInput(), { model: 'claude-haiku-5-5', agentId: 'a2' });
  await h.spawn(spawnInput({ parentAgentId: 'a9' }), { model: 'claude-haiku-5-5', agentId: 'a3' });
  await finish(h, 'a2', 'claude-haiku-5-5');
  await finish(h, 'a3', 'claude-haiku-5-5');
  const counts = routedOf(h, 'Explore');
  assert.deepEqual([counts.agents, counts.respawns], [3, 1]);
});

test('an agent still running when the session ends is counted, and Delete history clears the subagent records', async () => {
  const h = await started();
  await h.spawn(spawnInput());
  await drain(h.step({ ...step, agentId: 'a1', model: 'claude-haiku-5-5' }));
  await h.event('session.end', { reason: 'clear', sessionId: 's1' });
  assert.equal(routedOf(h, 'Explore').requests, 1);

  const r = await started();
  await r.spawn(spawnInput());
  await finish(r, 'a1', 'claude-haiku-5-5');
  await press(r, 'tab-usage');
  await press(r, 'delete-history');
  await press(r, 'delete-confirm');
  assert.equal(stored(r), undefined);
  assert.deepEqual([r.view().subagentStore.days, r.view().subagentSession.days], [{}, {}]);
});

test('Usage and Now show the session’s agents by model, who picked it, and what routing saved', async () => {
  const h = await started();
  await h.spawn(spawnInput());
  assert.equal(h.view().subagentsRunning, 1);
  // A long agent step, so its cost and its difference from core's model show in cents.
  const usage = { input_tokens: 20_000, cache_read_input_tokens: 400_000, cache_creation_input_tokens: 50_000 };
  await drain(
    h.step(
      { ...step, turnId: 'a1-t', agentId: 'a1', model: 'claude-haiku-5-5' },
      { usage: { ...usage, model: 'claude-haiku-5-5', output_tokens: 8_000 } },
    ),
  );
  await h.event('turn.complete', { turnId: 'a1-t', agentId: 'a1' });
  assert.equal(h.view().subagentsRunning, 0);
  await h.spawn(spawnInput({ workflow: { runId: 'wf_1', agentIndex: 1 } }), {
    model: 'claude-opus-5-5',
    agentId: 'w1',
  });
  const now = screen(await h.render()).join('\n');
  assert.match(now, /SUBAGENTS · this session · ● 1 running {2}\[ Usage \]/);
  assert.match(now, /1 agent · ■ 1 moved by the router · □ 0 on Claude Code’s pick/);
  await finish(h, 'w1', 'claude-opus-5-5');
  await press(h, 'tab-usage');
  const lines = screen(await h.render());
  const at = lines.findIndex((line) => line.startsWith('SUBAGENTS · this session'));
  assert.ok(at >= 0, lines.join('\n'));
  const block = lines.slice(at).join('\n');
  assert.match(lines[at], /subagent routing on/);
  assert.match(block, /■□ {2}Haiku 5\.5 1 · Opus 5\.5 1/);
  assert.match(block, /2 agents · ■ 1 moved by the router · □ 1 on Claude Code’s pick/);
  assert.match(block, /Routing saved \$\d+\.\d\d \(\d+%\) on 1 routed agent/);
  assert.match(block, /▸ Explore +■ +1 +\$\d+\.\d\d +−\$\d+\.\d\d ▼/);
  assert.match(block, /▸ workflow agent +□ +1 +\$0\.00 {2}the workflow sets it/);
  await press(h, 'row-subagent:Explore');
  const open = screen(await h.render()).join('\n');
  assert.match(open, /▾ Explore/);
  assert.match(open, /■ Haiku 5\.5 +1 moved down/);
  assert.match(open, /1\.0 requests per agent · none respawned within 10 min/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULTS, loadConfig } from '../lib/config.mjs';
import { requestUsd, subagentCacheTtl } from '../lib/savings.mjs';
import {
  addAgentReply,
  agentFrontmatter,
  classifiedAlias,
  coreModelOf,
  emptySubagentStore,
  flushedAgent,
  mergeSubagentStores,
  passReason,
  readSubagentStore,
  recordAgent,
  spawnPrompt,
  spawnRecord,
  subagentsAfterReset,
  typeRoute,
} from '../lib/subagents.mjs';
import { advice } from './helpers.mjs';

const ENGINE = { plugin: 'engine', tier: 'core' };
const spawn = (extra = {}) => ({
  tool_use_id: 'toolu_1',
  prompt: 'Find where the cache key is built.',
  description: 'Locate cache key',
  subagentType: 'Explore',
  provider: ENGINE,
  parentModel: 'claude-opus-5-5',
  background: false,
  fork: false,
  ...extra,
});
const withTypes = (types) => loadConfig({ userFile: { subagents: { types } } });

const PINNED = { name: 'runner', model: 'haiku', modelRouting: null };
const INHERITS = { name: 'engineer', model: 'inherit', modelRouting: null };
const plugin = (name, extra = {}) =>
  spawn({ subagentType: name, provider: { plugin: `${name.split(':')[0]}@cc-thingz`, tier: 'user' }, ...extra });

test('a spawn passes through for a fork, a workflow agent, an explicit model, a teammate, an unlisted built-in, a pin or an unknown definition', () => {
  for (const [name, input, definition, reason] of [
    ['built-in Explore', spawn(), null, null],
    ['general-purpose', spawn({ subagentType: 'general-purpose' }), null, null],
    ['fork', spawn({ fork: true, subagentType: 'fork' }), null, 'fork'],
    ['workflow agent', spawn({ workflow: { runId: 'wf_1', agentIndex: 1 } }), null, 'workflow'],
    [
      'workflow agent({ model })',
      spawn({ workflow: { runId: 'wf_1', agentIndex: 2 }, model: 'sonnet' }),
      null,
      'workflow',
    ],
    ['explicit model', spawn({ model: 'opus' }), null, 'explicit'],
    ['teammate', spawn({ isTeammate: true }), null, 'teammate'],
    ['unlisted built-in', spawn({ subagentType: 'statusline-setup' }), null, 'unlisted'],
    ['plugin agent without a readable definition', plugin('dev-flow:engineer'), null, 'unknown'],
    ['plugin agent that inherits', plugin('dev-flow:engineer'), INHERITS, null],
    ['plugin agent with no model', plugin('dev-flow:engineer'), { ...INHERITS, model: null }, null],
    ['pinned plugin agent', plugin('discovery:runner'), PINNED, 'pinned'],
    ['pinned agent that allows routing', plugin('discovery:runner'), { ...PINNED, modelRouting: 'auto' }, null],
  ])
    assert.equal(passReason(DEFAULTS, input, definition), reason, name);
});

test('a routable agent is classified; a key without a colon routes only the built-in of that name', () => {
  const project = { plugin: 'project', tier: 'user' };
  assert.deepEqual(typeRoute(DEFAULTS, spawn()), { route: 'haiku' });
  assert.deepEqual(typeRoute(DEFAULTS, plugin('dev-flow:reviewer'), INHERITS), { route: 'classify' });
  // A project agent named Explore replaces the built-in: its own definition decides, not the Explore listing.
  assert.deepEqual(typeRoute(DEFAULTS, spawn({ provider: project }), PINNED), { pass: 'pinned' });
  assert.deepEqual(typeRoute(DEFAULTS, spawn({ provider: project }), INHERITS), { route: 'classify' });
  assert.deepEqual(typeRoute(DEFAULTS, spawn({ provider: project })), { pass: 'unknown' });
});

test('a listed plugin agent routes from its own plugin even if pinned, and null never routes a type', () => {
  const config = withTypes({ 'dev-flow:reviewer': 'sonnet', 'dev-flow:engineer': null, Explore: null });
  assert.deepEqual(typeRoute(config, plugin('dev-flow:reviewer'), PINNED), { route: 'sonnet' });
  const other = spawn({ subagentType: 'dev-flow:reviewer', provider: { plugin: 'other@x', tier: 'user' } });
  assert.deepEqual(typeRoute(config, other, PINNED), { pass: 'pinned' });
  assert.equal(passReason(config, plugin('dev-flow:engineer'), INHERITS), 'unlisted');
  assert.equal(passReason(config, spawn()), 'unlisted');
  assert.deepEqual(typeRoute(config, spawn({ subagentType: 'Plan' })), { route: 'classify' });
});

test('agent frontmatter is read from YAML or a one-line JSON object, top-level scalars only', () => {
  for (const [name, text, expected] of [
    [
      'yaml',
      '---\nname: engineer\nmodel: inherit\ndescription: x\n---\nbody',
      { name: 'engineer', model: 'inherit', modelRouting: null },
    ],
    [
      'quoted with comment',
      '---\nname: \'runner\'\nmodel: "haiku"  # cheap\nmodelRouting: auto\n---\n',
      { name: 'runner', model: 'haiku', modelRouting: 'auto' },
    ],
    [
      'json',
      '---\n{"name":"runner","model":"haiku","modelRouting":"auto","tools":["Read"]}\n---\n',
      { name: 'runner', model: 'haiku', modelRouting: 'auto' },
    ],
    ['no model', '---\nname: advisor\n---\n', { name: 'advisor', model: null, modelRouting: null }],
    [
      'nested key is not top-level',
      '---\nname: a\nexperimental:\n  model: opus\n---\n',
      { name: 'a', model: null, modelRouting: null },
    ],
    ['broken json', '---\n{"name":\n---\n', null],
    ['no frontmatter', '# Title\nmodel: opus', null],
    ['not text', undefined, null],
  ])
    assert.deepEqual(agentFrontmatter(text), expected, name);
});

test('the config rejects a type route that is not a models key or classify, and models that do not exist', () => {
  for (const [file, message] of [
    [{ subagentRouting: 'always' }, /subagentRouting must be one of off, on/],
    [{ subagents: { types: { Explore: 'gpt' } } }, /subagents\.types\.Explore must be a models key, classify or null/],
    [{ subagents: { heavy: 'gpt' } }, /subagents\.heavy is not in models/],
    [{ subagents: { heavyMass: 1.5 } }, /subagents\.heavyMass must be between 0 and 1/],
    [{ subagents: { models: {} } }, /subagents\.models is not a known key/],
    [{ subagents: { types: [] } }, /subagents\.types must be an object/],
  ])
    assert.throws(() => loadConfig({ userFile: file }), message);
  assert.equal(DEFAULTS.subagentRouting, 'on');
});

test('classify picks heavy only for a clearly hard task, light for exploration or the smallest tier', () => {
  const explore = (p) => ({ choice: 'explore', probabilities: { explore: p } });
  for (const [name, answer, alias] of [
    ['no advice', null, null],
    ['clearly hard', advice('high', { high: 0.85, medium: 0.15 }), 'opus'],
    ['hard below heavyMass', advice('high', { high: 0.6, medium: 0.4 }), 'sonnet'],
    ['explores', { ...advice('medium', { medium: 0.9 }), activity: explore(0.8) }, 'haiku'],
    ['explores below activityMass', { ...advice('medium', { medium: 0.9 }), activity: explore(0.5) }, 'sonnet'],
    ['hard exploration', { ...advice('high', { high: 0.9 }), activity: explore(0.9) }, 'opus'],
    ['micro', advice('micro', { micro: 0.7 }), 'haiku'],
    ['low', advice('low', { low: 0.9 }), 'sonnet'],
    ['uncertain', advice('uncertain', { uncertain: 0.9 }), 'sonnet'],
  ])
    assert.equal(classifiedAlias(DEFAULTS, answer), alias, name);
});

test('the classifier sees only the description and the prompt, clipped as a main prompt', () => {
  assert.equal(spawnPrompt(DEFAULTS, spawn()), 'Locate cache key\nFind where the cache key is built.');
  const long = spawnPrompt(DEFAULTS, spawn({ prompt: 'x'.repeat(5000) }));
  assert.equal(long.length, DEFAULTS.context.maxTextChars);
  assert.equal(spawnPrompt(DEFAULTS, spawn({ description: '' })), 'Find where the cache key is built.');
});

test('core’s model is CLAUDE_CODE_SUBAGENT_MODEL, except for Explore and Plan without FORCE, else the parent’s', () => {
  const gp = spawn({ subagentType: 'general-purpose' });
  for (const [name, input, env, model] of [
    ['no variable', gp, {}, 'claude-opus-5-5'],
    ['an alias', gp, { envModel: 'sonnet' }, 'claude-sonnet-5-5'],
    ['a full id', gp, { envModel: 'claude-haiku-5-5' }, 'claude-haiku-5-5'],
    ['inherit', gp, { envModel: 'inherit' }, 'claude-opus-5-5'],
    ['Explore ignores it', spawn(), { envModel: 'sonnet' }, 'claude-opus-5-5'],
    ['Plan ignores it', spawn({ subagentType: 'Plan' }), { envModel: 'sonnet' }, 'claude-opus-5-5'],
    ['FORCE applies it to Explore', spawn(), { envModel: 'sonnet', force: true }, 'claude-sonnet-5-5'],
    ['a pinned definition', gp, { envModel: 'sonnet', definition: PINNED }, 'claude-haiku-5-5'],
    ['an inheriting definition', gp, { definition: INHERITS }, 'claude-opus-5-5'],
    ['FORCE beats a pin', gp, { envModel: 'sonnet', force: true, definition: PINNED }, 'claude-sonnet-5-5'],
  ])
    assert.equal(coreModelOf(DEFAULTS, input, env), model, name);
});

test('a subagent’s cache lifetime is five minutes, a subscription included, unless a variable or setting says 1h', () => {
  for (const [input, ttl] of [
    [{}, '5m'],
    [{ envTtl: '1h' }, '1h'],
    [{ settingTtl: '1h' }, '1h'],
    [{ enable1h: '1' }, '1h'],
    [{ force5m: '1', envTtl: '1h' }, '5m'],
    [{ envTtl: '2h', settingTtl: '1h' }, '1h'],
  ])
    assert.equal(subagentCacheTtl(input), ttl, JSON.stringify(input));
});

const usage = (model, { input = 2_000, read = 140_000, write = 8_000, output = 1_000 } = {}) => ({
  model,
  input_tokens: input,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: write,
  output_tokens: output,
});
const record = (extra = {}) =>
  spawnRecord({
    sessionId: 's1',
    spawn: spawn(),
    pass: null,
    choice: 'haiku',
    routedModel: 'claude-haiku-5-5',
    coreModel: 'claude-opus-5-5',
    failed: false,
    respawn: false,
    ...extra,
  });

test('a reply is priced on the model it ran on and on core’s, Haiku at its long-context rate', () => {
  const agent = addAgentReply(DEFAULTS, record({ coreModel: 'claude-haiku-5-5' }), usage('claude-opus-5-5'), '5m');
  const counts = { input: 2_000, cacheRead: 140_000, cacheWrite: 8_000, output: 1_000 };
  assert.equal(agent.requests, 1);
  assert.equal(agent.pricedRequests, 1);
  assert.equal(agent.actualUsd, requestUsd(DEFAULTS.models.opus, counts, 1.25));
  assert.equal(agent.otherUsd, requestUsd(DEFAULTS.models.haiku, counts, 1.25));
  // 150K tokens of prompt: Haiku 5.5 bills every rate at five times above 100K.
  const haiku = (0.5 * (2_000 + 8_000 * 1.25) + 0.05 * 140_000 + 2.5 * 1_000) / 1e6;
  assert.ok(Math.abs(agent.otherUsd - haiku) < 1e-12);
  assert.equal(
    addAgentReply(DEFAULTS, record({ coreModel: 'claude-haiku-5-5' }), usage('claude-opus-5-5'), '1h').actualUsd,
    requestUsd(DEFAULTS.models.opus, counts, 2),
  );
});

test('on prices the reply on the routed model and the same tokens on core’s; a pass-through only on its own', () => {
  const on = addAgentReply(DEFAULTS, record(), usage('claude-haiku-5-5'), '5m');
  assert.ok(on.actualUsd < on.otherUsd);
  const passed = addAgentReply(DEFAULTS, record({ pass: 'workflow', choice: null }), usage('claude-opus-5-5'), '5m');
  assert.equal(passed.pricedRequests, 1);
  assert.equal(passed.otherUsd, 0);
});

test('a reply without a price or with incomplete usage is counted as a request and not priced', () => {
  for (const reply of [usage('claude-fable-5-1'), { model: 'claude-opus-5-5', input_tokens: 1 }, null]) {
    const agent = addAgentReply(DEFAULTS, record(), reply, '5m');
    assert.deepEqual([agent.requests, agent.pricedRequests, agent.actualUsd], [1, 0, 0]);
  }
  const unpricedOther = addAgentReply(DEFAULTS, record({ coreModel: 'gpt-x' }), usage('claude-opus-5-5'), '5m');
  assert.equal(unpricedOther.pricedRequests, 0);
});

test('an agent counts once across flushes, and its requests and prices each time', () => {
  let agent = addAgentReply(DEFAULTS, record({ respawn: true }), usage('claude-haiku-5-5'), '5m');
  let store = recordAgent(emptySubagentStore(), agent, 1_000);
  agent = addAgentReply(DEFAULTS, flushedAgent(agent), usage('claude-haiku-5-5'), '5m');
  store = recordAgent(store, agent, 2_000);
  assert.equal(recordAgent(store, flushedAgent(agent), 3_000), store);
  const counts = store.routed.on.Explore;
  assert.deepEqual(
    [counts.agents, counts.differs, counts.requests, counts.respawns, counts.failures, counts.choices],
    [1, 1, 2, 1, 0, { haiku: 1 }],
  );
  assert.ok(counts.coreUsd > counts.routedUsd);
  assert.equal(store.since, 1_000);
});

test('a decision that kept core’s model does not count as moved, and a classifier failure is counted', () => {
  const kept = record({ choice: 'core', routedModel: 'claude-opus-5-5', failed: true });
  const counts = recordAgent(emptySubagentStore(), kept, 1).routed.on.Explore;
  assert.deepEqual([counts.agents, counts.differs, counts.failures, counts.choices], [1, 0, 1, { core: 1 }]);
});

test('pass-throughs count by reason, and stores merge, reset and read back from bad values', () => {
  const passed = { ...record({ pass: 'workflow', choice: null }), requests: 3, pricedRequests: 3, actualUsd: 0.5 };
  const one = recordAgent(emptySubagentStore(), passed, 10);
  const two = recordAgent(recordAgent(emptySubagentStore(), record(), 20), passed, 20);
  const merged = mergeSubagentStores([one, two, null, { version: 9 }]);
  assert.deepEqual(merged.passed.workflow, { agents: 2, requests: 6, pricedRequests: 6, usd: 1 });
  assert.equal(merged.routed.on.Explore.agents, 1);
  assert.equal(merged.since, 10);
  assert.equal(mergeSubagentStores([one, two], 15).passed.workflow.agents, 1);
  assert.deepEqual(subagentsAfterReset(one, 15), emptySubagentStore());
  assert.equal(subagentsAfterReset(one, 5), one);
  const bad = {
    ...one,
    passed: { workflow: { agents: -1 }, fork: 'x' },
    routed: { on: { Explore: { agents: 1 } } },
  };
  assert.deepEqual(readSubagentStore(bad), { version: 1, since: 10, routed: { on: {} }, passed: {} });
  assert.deepEqual(readSubagentStore('junk'), emptySubagentStore());
});

test('a store saved before 1.10.1 keeps its routed counts and drops the shadow ones', () => {
  const counts = {
    agents: 2,
    differs: 1,
    requests: 4,
    pricedRequests: 4,
    coreUsd: 1,
    routedUsd: 0.5,
    respawns: 0,
    failures: 0,
  };
  const saved = { version: 1, since: 10, routed: { shadow: { Plan: counts }, on: { Explore: counts } }, passed: {} };
  const read = readSubagentStore(saved);
  assert.deepEqual(read.routed, { on: { Explore: { ...counts, choices: {} } } });
  assert.deepEqual(mergeSubagentStores([saved]).routed, read.routed);
});

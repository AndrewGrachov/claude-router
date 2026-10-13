import assert from 'node:assert/strict';
import test from 'node:test';
import { bandSegments } from '../lib/band.mjs';
import { DEFAULTS, editActivity, loadConfig } from '../lib/config.mjs';
import { GATEWAY_CLEANUP, GATEWAY_SETTINGS, TIER_COLOR } from '../lib/display.mjs';
import { renderPanel, routeDraftOf, routingChanges } from '../lib/panel.mjs';
import { isSameModel } from '../lib/route.mjs';
import { controls, ELEMENTS, screen, texts } from './harness.mjs';

const actions = new Proxy({}, { get: () => () => {} });
const KEYS_SET = { jev: null, clef: null, 'clef-flash': null, 'clef-omni': null };
const view = (props = {}) => ({ mode: 'auto', phase: 'routed', credentials: KEYS_SET, tab: 'now', ...props });
const pane = (props, usage = null, paneActions = actions) =>
  renderPanel(ELEMENTS, DEFAULTS, view(props), usage, paneActions);

test('the band, the pane and the router agree on which served model is a fallback', () => {
  for (const [selectedModel, actualModel, fallback] of [
    ['claude-sonnet-5-5', 'claude-sonnet-5-5', false],
    ['claude-haiku-4-5', 'claude-haiku-4-5-20251001', false],
    ['claude-sonnet-5-5', 'claude-sonnet-5-5-20260101', true],
    ['claude-sonnet-5-5', 'claude-opus-5-5', true],
  ]) {
    const routed = { tier: 'low', selectedModel, actualModel, effort: 'medium' };
    const band = bandSegments(DEFAULTS, view(routed), null, actions).flatMap((s) => s.parts);
    const label = `${selectedModel} served as ${actualModel}`;
    assert.equal(!isSameModel(selectedModel, actualModel), fallback, label);
    assert.equal(
      band.some((p) => p.text === ' fallback'),
      fallback,
      label,
    );
    assert.equal(texts(pane(routed)).includes('Served     '), fallback, label);
  }
});

test('the pane header is one line: the on/off pair with its o and f hotkeys, then the classifier state', () => {
  for (const [mode, expected] of [
    [
      'auto',
      [
        ['auto', '◉ on', 'o', 'primary'],
        ['manual', '○ off', 'f', 'secondary'],
      ],
    ],
    [
      'manual',
      [
        ['auto', '○ on', 'o', 'secondary'],
        ['manual', '◉ off', 'f', 'primary'],
      ],
    ],
  ]) {
    const pressed = [];
    const tree = pane({ mode, adviceMs: 347 }, null, { ...actions, mode: (to) => pressed.push(to) });
    const pair = controls(tree).filter((c) => c.key === 'auto' || c.key === 'manual');
    assert.deepEqual(
      pair.map((c) => [c.key, c.label, c.hotkey, c.variant]),
      expected,
      mode,
    );
    for (const c of pair) c.onPress();
    assert.deepEqual(pressed, ['auto', 'manual'], mode);
    const [first] = screen(tree);
    assert.equal(first, `ROUTING  [ ${expected[0][1]} ] [ ${expected[1][1]} ]  Jev ready · 347 ms`, mode);
  }
});

test('five tabs take the digits 1 to 5, and a draft marks the tab whose settings it changes', () => {
  const tabs = (props) =>
    controls(pane(props))
      .filter((c) => c.key.startsWith('tab-'))
      .map((c) => [c.key, c.label, c.hotkey]);
  assert.deepEqual(tabs({}), [
    ['tab-now', 'Now', '1'],
    ['tab-routes', 'Routes', '2'],
    ['tab-policy', 'Policy', '3'],
    ['tab-classifier', 'Classifier', '4'],
    ['tab-usage', 'Usage', '5'],
  ]);
  const config = loadConfig();
  const routeEdit = editActivity(routeDraftOf(config, {}), config, 'code', 'high', 'add');
  const labels = (props) => tabs(props).map(([, label]) => label);
  assert.deepEqual(
    labels({ routeDraft: { ...routeEdit, activities: { code: { high: { model: 'opus', effort: 'max' } } } } }).slice(
      1,
      3,
    ),
    ['Routes ●', 'Policy'],
  );
  assert.deepEqual(labels({ tuning: { horizon: 10 } }).slice(1, 3), ['Routes', 'Policy ●']);
  assert.deepEqual(labels({ routeDraft: { ...routeDraftOf(config, {}), baselineTier: 'micro' } }).slice(1, 3), [
    'Routes',
    'Policy ●',
  ]);
  // A tab saved by an older version falls back to Now.
  assert.equal(screen(pane({ tab: 'routing' }))[3].startsWith('Next turn'), true);
});

test('while routing is unavailable the header says why and offers no on/off or pins', () => {
  for (const [error, reason, cleanup] of [
    ['requires Claude Code 2.1.289 or newer', 'requires Claude Code 2.1.289 or newer', false],
    [GATEWAY_SETTINGS, 'v0.8 gateway settings remain', true],
  ]) {
    const tree = pane({ phase: 'unavailable', error, tier: null });
    const lines = texts(tree);
    assert.deepEqual(lines.slice(0, 5), ['ROUTING', '  ', 'unavailable', '  Claude’s model is kept', reason], reason);
    assert.equal(lines.includes(GATEWAY_CLEANUP[0]), cleanup, reason);
    assert.ok(!lines.some((line) => /Jev ready|keeping the model/.test(line)), reason);
    assert.ok(lines.includes('  Pins need routing, which is unavailable.'), reason);
    const keys = controls(tree).map((c) => c.key);
    for (const key of ['auto', 'manual', 'pin-low']) assert.ok(!keys.includes(key), `${reason}: ${key}`);
  }
});

test('a pending pin shows on the Now tab with unpin', () => {
  let unpinned = 0;
  const tree = pane({ tier: 'low', selectedModel: 'claude-sonnet-5-5', pendingPin: 'high' }, null, {
    ...actions,
    unpin: () => {
      unpinned += 1;
    },
  });
  const lines = texts(tree);
  const at = lines.indexOf('Pinned     ');
  assert.deepEqual(lines.slice(at, at + 3), ['Pinned     ', 'next turn → ', 'high']);
  controls(tree)
    .find((c) => c.key === 'unpin')
    .onPress();
  assert.equal(unpinned, 1);
  assert.ok(!texts(pane({ tier: 'low', selectedModel: 'claude-sonnet-5-5' })).includes('Pinned     '));
});

test('help explains what the numbers are and that savings are not measured', () => {
  const lines = texts(pane({ help: true }));
  const at = lines.indexOf('ABOUT THESE NUMBERS');
  assert.deepEqual(lines.slice(at, at + 7), [
    'ABOUT THESE NUMBERS',
    'Cost, context and cache are Claude readings. $ estimates use the',
    'list prices in router.json; plan prices are equivalents, not cash.',
    'Routing vs your model holds tokens and output length the same',
    'and does not measure answer quality. Cache benefit is before writes.',
    'The context bar uses the routed model’s window, 20% in reserve.',
    'A switch estimate prices 5m–1h cache writes; minus means cheaper.',
  ]);
  assert.ok(!texts(pane({ help: false })).includes('ABOUT THESE NUMBERS'));
});

test('the Now tab says what runs next turn and why: the tier, the model, the support it weighed and the switch cost', () => {
  const estimate = { threshold: 0.82, upgradeMass: 0.88, taxUsd: 0.476 };
  const routed = { tier: 'high', selectedModel: 'claude-opus-5-5', effort: 'xhigh', reason: 'jump', estimate };
  assert.deepEqual(screen(pane(routed)).slice(3, 6), [
    'Next turn  ▌high  Opus 5.5 · xhigh',
    'Why        clear need for a stronger model',
    '           Jev gave stronger tiers 88% (needs 82%) · switch ≈ $0.48',
  ]);
  const down = { ...routed, estimate: { threshold: 0.9, downgradeMass: 0.93 } };
  assert.equal(screen(pane(down))[5], '           Jev gave cheaper tiers 93% (needs 90%)');
  // Routing off: the /model choice runs, no support line, and the pins say what they need.
  const off = screen(pane({ ...routed, mode: 'manual', selectedModel: null, nativeModel: 'claude-opus-5-5' }));
  assert.equal(off[3], 'Next turn  ▌high  Opus 5.5 · xhigh  your /model choice, routing off');
  assert.ok(!off.some((line) => line.includes('needs 82%')));
  assert.ok(off.includes('  Pins need routing on (o above).'));
});

const recording = () => {
  const calls = [];
  return {
    calls,
    actions: new Proxy(
      {},
      {
        get:
          (_, name) =>
          (...args) =>
            calls.push([name, ...args]),
      },
    ),
  };
};
const sonnetLow = { tier: 'low', selectedModel: 'claude-sonnet-5-5', effort: 'high', activity: 'code' };
const haikuLow = { tier: 'low', selectedModel: 'claude-haiku-5-5', effort: 'high', activity: 'code' };
const reading = { activityChoice: 'code', activityProbabilities: { code: 0.81, ops: 0.09, explore: 0.06, plan: 0 } };

test('the Now tab names the activity as a verb and marks an override', () => {
  for (const [mode, props, first] of [
    ['on', sonnetLow, 'Next turn  ▌low  Sonnet 5.5 · high   override · low runs Haiku 5.5 · high'],
    ['on', { ...haikuLow, activity: 'ops' }, 'Next turn  ▌low  Haiku 5.5 · high'],
    ['off', haikuLow, 'Next turn  ▌low  Haiku 5.5 · high'],
  ]) {
    const config = { ...DEFAULTS, activityRouting: mode };
    const lines = screen(renderPanel(ELEMENTS, config, view({ ...props, ...reading }), null, actions));
    const name = `${mode} ${JSON.stringify(props)}`;
    assert.equal(lines[3], first, name);
    assert.equal(
      lines[4],
      mode === 'off' ? 'Why        ready' : 'Activity   coding 81%   running 9% · exploring 6%   applies at 60%+',
      name,
    );
  }
  const why = screen(renderPanel(ELEMENTS, DEFAULTS, view({ ...sonnetLow, reason: 'activity-up' }), null, actions));
  assert.ok(why.includes('Why        coding at low runs on Sonnet 5.5 · high'));
  const unsure = { activityChoice: 'uncertain', activityProbabilities: { uncertain: 0.94, explore: 0.03 } };
  const nodes = [];
  (function walk(node) {
    if (node?.type === 'Text') nodes.push(node.props);
    if (Array.isArray(node?.props?.children)) node.props.children.forEach(walk);
  })(renderPanel(ELEMENTS, DEFAULTS, view({ ...haikuLow, activity: null, ...unsure }), null, actions));
  assert.deepEqual(
    nodes.find((n) => n.children === 'uncertain'),
    { children: 'uncertain', dimColor: true },
    'uncertain is not drawn as an activity',
  );
  const verb = texts(renderPanel(ELEMENTS, DEFAULTS, view({ ...sonnetLow, ...reading }), null, actions));
  assert.ok(verb.includes('coding'), 'the activity is its own orange italic Text');
});

test('the last replies show the tiers as a strip with the switch count, the replies per tier and per activity', () => {
  const lines = screen(
    pane({
      tiers: ['low', null, 'medium', 'low'],
      activities: ['ops', null, 'docs'],
      routes: ['h@high', null, 'o@medium', 'h@high'],
    }),
  );
  const at = lines.indexOf('LAST 4 REPLIES · 1 model switch');
  assert.deepEqual(lines.slice(at + 1, at + 4), [
    '  █·██',
    '  ■ low 2  ■ medium 1  · not routed 1',
    '  running 1 · documenting 1',
  ]);
  assert.ok(screen(pane({ tiers: ['micro'], routes: ['h@medium'] })).includes('LAST REPLY · 0 model switches'));
  const untagged = screen(pane({ tiers: ['low', 'medium'], activities: [], routes: ['h@high', 'o@medium'] }));
  const head = untagged.indexOf('LAST 2 REPLIES · 1 model switch');
  assert.deepEqual(untagged.slice(head + 1, head + 4), ['  ██', '  ■ low 1  ■ medium 1', '']);
  assert.ok(screen(pane({})).includes('  no replies yet'));
});

const routesTab = (config, routeDraft = null, props = {}, paneActions = actions, options = {}) =>
  renderPanel(ELEMENTS, config, view({ tab: 'routes', routeDraft, ...props }), null, paneActions, options);
const grid = (tree) => {
  const lines = screen(tree);
  const at = lines.findIndex((l) => l.trim().startsWith('micro'));
  return lines.slice(at, at + 10);
};
const editor = (tree) => {
  const lines = screen(tree);
  const at = lines.findIndex((l) => l.startsWith('  · runs the tier’s model'));
  return lines.slice(
    at + 2,
    lines.findIndex((l, i) => i > at + 2 && l === ''),
  );
};

test('the Routes tab is one grid: the tiers’ own models on top, built-in overrides marked, one cache per model', () => {
  const tree = routesTab(DEFAULTS);
  assert.deepEqual(grid(tree), [
    '              micro           low             medium          high',
    'every turn    haiku·medium    haiku·high      opus·medium     opus·xhigh',
    'coding        ·               sonnet·high°    ·               ·',
    'debugging     ·               sonnet·high°    ·               ·',
    'exploring     ·               ·               ·               ·',
    'planning      ·               sonnet·high°    ·               ·',
    'reviewing     ·               sonnet·high°    ·               ·',
    'running       ·               ·               haiku·high°     ·',
    'documenting   ·               ·               ·               ·',
    '  · runs the tier’s model   ° built-in default   ● unsaved',
  ]);
  const lines = screen(tree);
  assert.ok(lines.includes('Select a cell to change its model and effort.'));
  assert.equal(
    lines.find((l) => l.includes('prompt cache')),
    '3 prompt caches in use: one per model; effort changes keep it. A switch to a',
  );
  // Where the provider caches each effort apart, each tier and override route is its own cache.
  const split = screen(routesTab({ ...DEFAULTS, effortSplitsCache: true }));
  assert.equal(
    split.find((l) => l.includes('prompt cache')),
    '5 prompt caches in use: one per model + effort. A switch to a cold cache',
  );
  assert.ok(!lines.some((line) => line.startsWith('!')));
  // A narrow pane shortens the efforts and keeps a space between the cells.
  const narrow = grid(routesTab(DEFAULTS, null, {}, actions, { columns: 70 }));
  assert.equal(narrow[1], 'every turn    haiku·med     haiku·high    opus·med      opus·xh');
  assert.equal(narrow[2], 'coding        ·             sonnet·high°  ·             ·');
});

test('the activity mode leads the Routes tab, and a line says when the overrides do not run', () => {
  for (const [mode, hint, state] of [
    ['on', 'an activity can change its tier’s model', null],
    ['off', 'not asked; every turn runs its tier’s model', 'Activity overrides not in use: activity routing is off'],
  ]) {
    const tree = routesTab({ ...DEFAULTS, activityRouting: mode });
    assert.equal(controls(tree).find((c) => c.key === 'activity-mode').value, mode);
    const lines = screen(tree);
    assert.equal(lines[4], `${`Activity routing: ${mode} ▾`.padEnd(28)}${hint}`, mode);
    assert.equal(lines[5] === '' ? null : lines[5], state, mode);
  }
  for (const [props, state] of [
    [{ mode: 'manual' }, 'Activity overrides not in use: routing is off'],
    [
      { phase: 'unavailable', error: 'invalid router configuration' },
      'Activity overrides not in use: routing is unavailable',
    ],
  ]) {
    const lines = screen(routesTab(DEFAULTS, null, props));
    assert.ok(lines.includes(state), JSON.stringify(props));
  }
  // A draft mode runs nothing until Save: the line follows the saved mode and says what Save changes.
  for (const [saved, drafted, state] of [
    ['on', 'off', 'Activity overrides in use · not in use after Save'],
    ['off', 'on', 'Activity overrides not in use: activity routing is off · in use after Save'],
  ]) {
    const config = { ...DEFAULTS, activityRouting: saved };
    const lines = screen(routesTab(config, { ...routeDraftOf(config, {}), activityRouting: drafted }));
    assert.ok(lines.includes(state), `${saved} → ${drafted}: ${lines[5]}`);
  }
});

test('a selected activity cell edits its model and effort, says what it is, and offers the ways back', () => {
  const config = loadConfig();
  let draft = routeDraftOf(config, {});
  draft = editActivity(draft, config, 'review', 'low', 'model', 'opus');
  const reviewing = routesTab(config, draft, { routeCell: 'review.low' });
  assert.equal(grid(reviewing)[6], 'reviewing     ·              ▸opus·high●      ·               ·');
  assert.deepEqual(editor(reviewing), [
    'reviewing at low      opus ▾        high ▾      ●',
    '                      your override',
    '                      [ Use tier model: Haiku 5.5 · high ] [ Restore default: Sonnet 5.5 · high ]',
    '                      ! stronger than the tier above',
  ]);
  // Opus at a new effort is one more cache only where the provider caches each effort apart.
  const split = { ...config, effortSplitsCache: true };
  assert.deepEqual(
    editor(
      routesTab(split, editActivity(routeDraftOf(split, {}), split, 'review', 'low', 'model', 'opus'), {
        routeCell: 'review.low',
      }),
    ).slice(3),
    [
      '                      ! stronger than the tier above',
      '                      ! a model + effort only this cell uses: one more cache',
    ],
  );
  assert.deepEqual(editor(routesTab(config, null, { routeCell: 'code.low' })), [
    'coding at low         sonnet ▾      high ▾',
    '                      built-in default',
    '                      [ Use tier model: Haiku 5.5 · high ]',
  ]);
  assert.deepEqual(editor(routesTab(config, null, { routeCell: 'docs.high' })), [
    'documenting at high   opus ▾        xhigh ▾',
    '                      runs the tier’s model',
  ]);
});

test('a removed built-in override shows the tier’s model and can be restored', () => {
  const config = loadConfig({ userFile: { activities: { code: { low: { model: 'haiku', effort: 'high' } } } } });
  const tree = routesTab(config, null, { routeCell: 'code.low' });
  assert.equal(grid(tree)[2], 'coding        ·              ▸·               ·               ·');
  assert.deepEqual(editor(tree), [
    'coding at low         haiku ▾       high ▾',
    '                      runs the tier’s model; the built-in default is removed',
    '                      [ Restore default: Sonnet 5.5 · high ]',
  ]);
  assert.equal(routingChanges(config, view()).count, 0);
});

test('a selected tier cell edits the tier’s own model and shows its prices, and identical tiers are flagged', () => {
  const tree = routesTab(DEFAULTS, null, { routeCell: 'tier.medium' });
  assert.deepEqual(editor(tree), [
    'medium · every turn   opus ▾        medium ▾',
    '                      $4 in · $20 out per M tokens · 1M window',
  ]);
  const same = {
    ...routeDraftOf(DEFAULTS, {}),
    routes: { ...DEFAULTS.routes, micro: { model: 'haiku', effort: 'high' } },
  };
  assert.ok(
    screen(routesTab(DEFAULTS, same)).includes(
      '! micro and low run the same model and effort: that step changes nothing',
    ),
  );
});

test('a route that leaves the effort to the session reads inherit in the grid', () => {
  const draft = {
    ...routeDraftOf(DEFAULTS, {}),
    routes: { ...DEFAULTS.routes, micro: { model: 'haiku', effort: null } },
  };
  assert.equal(grid(routesTab(DEFAULTS, draft))[1].split(/\s{2,}/)[1], 'haiku·inherit●');
  const narrow = grid(routesTab(DEFAULTS, draft, {}, actions, { columns: 70 }));
  assert.equal(narrow[1].split(/\s{2,}/)[1], 'haiku·inh●');
});

test('a cell on its tier’s model that equals its built-in default does not say the default is removed', () => {
  const draft = {
    ...routeDraftOf(DEFAULTS, {}),
    routes: { ...DEFAULTS.routes, medium: { model: 'haiku', effort: 'high' } },
  };
  assert.deepEqual(editor(routesTab(DEFAULTS, draft, { routeCell: 'ops.medium' })).slice(1), [
    '                      runs the tier’s model',
  ]);
});

test('the one-more-cache warning counts the overrides in every activity mode', () => {
  // Sonnet runs one tier and four built-in overrides: no cell is alone on it.
  const sonnetTier = (mode) => ({
    ...DEFAULTS,
    activityRouting: mode,
    routes: { ...DEFAULTS.routes, medium: { model: 'sonnet', effort: 'xhigh' } },
  });
  for (const mode of ['on', 'off'])
    assert.ok(
      !screen(routesTab(sonnetTier(mode), null, { routeCell: 'code.low' })).some((l) => l.includes('one more cache')),
      mode,
    );
  // Where efforts cache apart, Haiku at max for one cell is a new cache.
  for (const mode of ['on', 'off']) {
    const config = { ...DEFAULTS, activityRouting: mode, effortSplitsCache: true };
    const draft = editActivity(routeDraftOf(config, {}), config, 'ops', 'low', 'effort', 'max');
    assert.ok(
      screen(routesTab(config, draft, { routeCell: 'ops.low' })).includes(
        '                      ! a model + effort only this cell uses: one more cache',
      ),
      mode,
    );
  }
});

test('the Routes controls call the pane actions with the cell they edit', () => {
  const { calls, actions: recorded } = recording();
  const found = (key, routeCell) =>
    controls(routesTab(DEFAULTS, null, { routeCell }, recorded)).find((c) => c.key === key);
  found('activity-mode').onSelect('off');
  found('cell-code-high').onPress();
  found('cell-tier-low').onPress();
  found('activity-code-low-model', 'code.low').onSelect('opus');
  found('activity-code-low-effort', 'code.low').onSelect('session');
  found('activity-ops-medium-effort', 'ops.medium').onSelect('medium');
  found('activity-tier-ops-medium', 'ops.medium').onPress();
  found('route-low-model', 'tier.low').onSelect('sonnet');
  found('route-low-effort', 'tier.low').onSelect('max');
  const removed = loadConfig({ userFile: { activities: { code: { low: { model: 'haiku', effort: 'high' } } } } });
  controls(routesTab(removed, null, { routeCell: 'code.low' }, recorded))
    .find((c) => c.key === 'activity-default-code-low')
    .onPress();
  assert.deepEqual(calls, [
    ['activityMode', 'off'],
    ['selectCell', 'code.high'],
    ['selectCell', 'tier.low'],
    ['activityModel', 'code', 'low', 'opus'],
    ['activityEffort', 'code', 'low', null],
    ['activityEffort', 'ops', 'medium', 'medium'],
    ['removeActivity', 'ops', 'medium'],
    ['routeModel', 'low', 'sonnet'],
    ['routeEffort', 'low', 'max'],
    ['restoreActivity', 'code', 'low'],
  ]);
  const effort = found('activity-code-low-effort', 'code.low');
  assert.deepEqual(effort.options[0], { value: 'session', label: 'inherit' });
});

test('the draft lists activity edits and the mode in the router.json diff on Routes and Policy, and counts them elsewhere', () => {
  const config = loadConfig();
  let draft = routeDraftOf(config, {});
  draft = editActivity(draft, config, 'code', 'high', 'effort', 'max');
  draft = editActivity(draft, config, 'review', 'low', 'remove');
  draft = { ...draft, activityRouting: 'off' };
  const changes = routingChanges(config, view({ routeDraft: draft }));
  assert.deepEqual(changes.cells, [
    ['code', 'high'],
    ['review', 'low'],
  ]);
  assert.equal(changes.mode, true);
  assert.equal(changes.count, 3);
  for (const tab of ['routes', 'policy']) {
    const lines = screen(renderPanel(ELEMENTS, config, view({ tab, routeDraft: draft }), null, actions));
    const at = lines.indexOf('router.json changes:');
    assert.deepEqual(
      lines.slice(at + 1, at + 8),
      [
        '- activities.code.high           no override',
        '+ activities.code.high           Opus 5.5 · max',
        '- activities.review.low          Sonnet 5.5 · high',
        '+ activities.review.low          no override',
        '- activityRouting                on',
        '+ activityRouting                off',
        '● 3 unsaved routing changes  [ Save ] [ Discard ]',
      ],
      tab,
    );
  }
  const now = screen(renderPanel(ELEMENTS, config, view({ routeDraft: draft }), null, actions));
  assert.ok(!now.includes('router.json changes:'));
  assert.ok(now.includes('● 3 unsaved routing changes  [ Save ] [ Discard ]  listed on Routes and Policy'));
  assert.equal(routingChanges(config, view()).count, 0);
});

test('the Policy tab puts each control in its sentence and names the default beside a changed value', () => {
  const policy = (props = {}, config = DEFAULTS, paneActions = actions) =>
    renderPanel(ELEMENTS, config, view({ tab: 'policy', ...props }), null, paneActions);
  const lines = screen(policy());
  const at = lines.indexOf('POLICY · how readily the router changes models · edit, then Save');
  assert.deepEqual(lines.slice(at + 2, at + 12), [
    'Start        at low ▾',
    '             when the session’s model is no tier’s model',
    'Going down   after 2 ▾ agreeing turns',
    '             if a cache write pays back within 5 ▾',
    'Going up     needs Jev support of 75%, up to 90% as the switch costs more',
    'Activities   apply at 0.6 ▾ certainty or more',
    '             else a new task runs its tier’s model; a continuation keeps it',
    'Credits      cap one cold cache write at 2 ▾',
    '             no model in router.json bills credits, so this has no effect',
    '',
  ]);
  const changed = screen(
    policy({ tuning: { downgradeVotes: 3 }, routeDraft: { ...routeDraftOf(DEFAULTS, {}), baselineTier: 'micro' } }),
  );
  assert.ok(changed.includes('Start        at micro ▾ ● default low'));
  assert.ok(changed.includes('Going down   after 3 ▾ agreeing turns ● default 2'));
  const credits = {
    ...DEFAULTS,
    models: { ...DEFAULTS.models, opus: { ...DEFAULTS.models.opus, billing: 'credits' } },
  };
  assert.ok(screen(policy({}, credits)).includes('             on a model that bills credits'));
  const { calls, actions: recorded } = recording();
  const found = (key) => controls(policy({}, DEFAULTS, recorded)).find((c) => c.key === key);
  found('baseline').onSelect('medium');
  found('horizon').onSelect('10');
  found('activityMass').onSelect('0.8');
  found('reset-policy').onPress();
  assert.deepEqual(calls, [
    ['baseline', 'medium'],
    ['tune', 'horizon', 10],
    ['tune', 'activityMass', 0.8],
    ['resetPolicy'],
  ]);
  assert.deepEqual(
    found('horizon').options.map((o) => o.label),
    ['1 turn', '3 turns', '5 turns', '10 turns'],
  );
});

const STATS = {
  byActivity: {
    code: {
      turns: 12,
      requests: 71,
      inputTokens: 0,
      outputTokens: 0,
      routedUsd: 4.213,
      pricedRequests: 71,
      routes: { 'claude-sonnet-5-5@high': 60, 'claude-opus-5-5@medium': 11 },
    },
    explore: {
      turns: 5,
      requests: 22,
      inputTokens: 0,
      outputTokens: 0,
      routedUsd: 0.31,
      pricedRequests: 22,
      routes: { 'claude-haiku-5-5@session': 22 },
    },
    // Counts saved by 1.7.0: no cost or routes.
    none: { turns: 3, requests: 3, inputTokens: 0, outputTokens: 0 },
  },
  switches: { tier: 4, activity: 5 },
  agreement: { matched: 19, total: 22 },
};
const STORE = {
  version: 1,
  confusion: { code: { code: 10, read: 3 }, ops: { ops: 4, code: 1 }, debug: { code: 2 }, uncertain: { talk: 2 } },
  runs: {},
  lateral: { taken: 4, refused: 2 },
};
const METRICS = {
  version: 1,
  latency: { jev: [0, 0, 0, 3, 15, 1, 1, ...Array(15).fill(0)], openai: [9, ...Array(21).fill(0)] },
  downMoves: { moves: 12, escalations: 1 },
};
const HEAD = `${' '.repeat(26)}turns  requests  share  est. cost`;
const SESSION_LINES = [
  'BY ACTIVITY · this session',
  '   activity routing on',
  `${HEAD}   mostly on`,
  '  ',
  'coding',
  '██████░░░░',
  '     12        71    60%      $4.21   Sonnet 5.5 · high',
  '  ',
  'exploring',
  '███░░░░░░░',
  '      5        22    25%      $0.31   Haiku 5.5',
  '  ',
  'none',
  '██░░░░░░░░',
  '      3         3    15%          —   —',
  'Switches   9 · 4 by tier · 5 by activity',
  'Agreement  classifier vs tools: 19 of 22 turns (86%)',
];
const OFF_LINES = ['BY ACTIVITY · activity routing off', '  Not asked. Set activity routing to on in the Routes tab.'];
const ACROSS = 'ACROSS SESSIONS · since the last reset';
const ACROSS_LINES = [
  ACROSS,
  'Labelled   22 turns',
  'Agreement  classifier vs tools: 16 of 20 turns (80%)',
  'Code/ops/explore  classifier vs tools: 14 of 18 turns (78%)',
  'Mismatch   code → read 3 · ops → code 1',
  'Activity moves  4 taken · 2 refused',
  'Escalations  after a cheaper activity move: 1 in 12 moves',
];
const usageLines = (mode, props, paneActions = actions, options = {}) =>
  texts(
    renderPanel(
      ELEMENTS,
      { ...DEFAULTS, activityRouting: mode },
      view({ tab: 'usage', activityMetrics: METRICS, ...props }),
      null,
      paneActions,
      options,
    ),
  );

test('the Usage tab shows this session by activity in each mode, and the counts across sessions are not on it', () => {
  const ops = { ...STATS, byActivity: { ops: STATS.byActivity.code }, agreement: { matched: 0, total: 0 } };
  for (const [name, mode, activityStats, expected] of [
    ['off, nothing recorded', 'off', null, OFF_LINES],
    [
      'on, nothing yet',
      'on',
      null,
      ['BY ACTIVITY · this session', '   activity routing on', '  no activity readings yet'],
    ],
    ['on, with data', 'on', STATS, SESSION_LINES],
    [
      'on, with refused activity moves',
      'on',
      { ...ops, lateral: { taken: 5, refused: 2 } },
      [
        'BY ACTIVITY · this session',
        '   activity routing on',
        `${HEAD}   mostly on`,
        '  ',
        'running',
        '██████████',
        '     12        71   100%      $4.21   Sonnet 5.5 · high',
        'Switches   9 · 4 by tier · 5 by activity · 2 refused',
      ],
    ],
  ]) {
    const { calls, actions: recorded } = recording();
    const lines = usageLines(mode, { activityStats, activityStore: STORE }, recorded);
    const at = lines.findIndex((l) => l.startsWith('BY ACTIVITY'));
    assert.deepEqual(
      lines.slice(at, at + expected.length + 2),
      [...expected, ' ', 'SUBAGENTS · across sessions'],
      name,
    );
    assert.ok(!lines.includes(ACROSS), `${name}: the counts across sessions are on the Classifier tab`);
    renderPanel(ELEMENTS, DEFAULTS, view({ tab: 'usage' }), null, recorded);
    const tree = renderPanel(ELEMENTS, DEFAULTS, view({ tab: 'usage' }), null, recorded);
    controls(tree)
      .find((c) => c.key === 'reset-stats')
      .onPress();
    assert.deepEqual(calls, [['resetStats']], `${name}: the stored counts can always be reset`);
  }
});

test('the Usage tab folds Claude’s readings to one line, and details show them with the trend and the estimates', () => {
  const comparison = { incumbent: 'low', candidate: 'high', minUsd: -0.0123, maxUsd: 0.5, paybackTurns: 3 };
  const props = {
    comparison,
    history: [1000, 5000],
    tiers: ['micro', 'low', 'high'],
    cacheRead: 900,
    inputTokens: 1000,
  };
  const usage = { context: { tokens: 400_000 }, cost: { usd: 18.003 } };
  const folded = screen(renderPanel(ELEMENTS, DEFAULTS, view({ tab: 'usage', ...props }), usage, actions));
  assert.ok(folded.includes('CLAUDE READINGS  cost $18.003 · context 40% · cache 90%  [ details ]'));
  assert.ok(!folded.some((line) => line.startsWith('Compared tiers') || line.startsWith('INPUT PER REPLY')));
  const { calls, actions: recorded } = recording();
  const tree = renderPanel(ELEMENTS, DEFAULTS, view({ tab: 'usage', usageDetail: true, ...props }), usage, recorded);
  const lines = texts(tree);
  const at = lines.indexOf('Compared tiers        low → high');
  assert.deepEqual(lines.slice(at, at + 3), [
    'Compared tiers        low → high',
    'Next-turn difference  −$0.012 to +$0.500',
    'Payback               3 later turns',
  ]);
  controls(tree)
    .find((c) => c.key === 'usage-detail')
    .onPress();
  assert.deepEqual(calls, [['usageDetail']]);
  const nodes = [];
  (function walk(node) {
    if (node?.type === 'Text') nodes.push(node.props);
    if (Array.isArray(node?.props?.children)) node.props.children.forEach(walk);
  })(tree);
  const trend = nodes.findIndex((n) => n.children === '▁');
  assert.deepEqual(
    nodes.slice(trend, trend + 3).map((n) => [n.children, n.color ?? null]),
    [
      ['▁', TIER_COLOR.low],
      ['█', TIER_COLOR.high],
      ['  1.0K … 5.0K', null],
    ],
  );
  const empty = screen(renderPanel(ELEMENTS, DEFAULTS, view({ tab: 'usage' }), null, actions));
  assert.ok(empty.includes('CLAUDE READINGS  cost not reported · context — · cache —  [ details ]'));
});

test('the Usage tab puts plan quota under routing vs your model', () => {
  const usage = {
    rateLimits: [
      { kind: 'five_hour', percentUsed: 48 },
      { kind: 'seven_day', percentUsed: null },
    ],
  };
  const lines = screen(renderPanel(ELEMENTS, DEFAULTS, view({ tab: 'usage' }), usage, actions));
  const at = lines.indexOf('PLAN QUOTA');
  assert.ok(at > lines.findIndex((line) => line.startsWith('ROUTING VS YOUR MODEL')));
  assert.equal(lines[at + 1], 'five hour  ████████░░░░░░░░  48%  used');
  assert.ok(!lines.some((line) => line.startsWith('seven day')));
  assert.ok(!screen(renderPanel(ELEMENTS, DEFAULTS, view({ tab: 'usage' }), null, actions)).includes('PLAN QUOTA'));
});

const classifierLines = (props, config = { ...DEFAULTS, activityRouting: 'on' }) =>
  screen(renderPanel(ELEMENTS, config, view({ tab: 'classifier', ...props }), null, actions));

test('the Classifier tab shows the counts across sessions when there are any', () => {
  for (const [name, activityStore, expected] of [
    ['counts from earlier sessions', STORE, ACROSS_LINES],
    ['nothing recorded', null, []],
    ['a corrupted store', 'garbage', []],
    [
      'no code, ops or explore answers',
      {
        ...STORE,
        confusion: { debug: { code: 2, talk: 1 } },
        lateral: { taken: 0, refused: 0 },
      },
      [
        ACROSS,
        'Labelled   3 turns',
        'Agreement  classifier vs tools: 2 of 3 turns (67%)',
        'Mismatch   debug → talk 1',
        'Escalations  after a cheaper activity move: 1 in 12 moves',
      ],
    ],
    ['a store saved with the retired shadow readout', { ...STORE, shadow: { differs: 6, turns: 18 } }, ACROSS_LINES],
  ]) {
    const lines = classifierLines({ activityStore, activityMetrics: METRICS });
    const at = lines.indexOf(ACROSS);
    assert.deepEqual(at < 0 ? [] : lines.slice(at, at + expected.length), expected, name);
  }
});

test('the deadline line compares the active classifier’s wait with its deadline', () => {
  const deadline = (props, config) => classifierLines(props, config).find((line) => line.startsWith('Deadline'));
  assert.equal(deadline({ activityMetrics: METRICS }), 'Deadline    1500 ▾      p95 ≤ 350 ms over 20 turns');
  assert.equal(deadline({ activityMetrics: null }), 'Deadline    1500 ▾      p95 299 ms in its probe');
  assert.equal(
    deadline({ activityMetrics: { ...METRICS, latency: { jev: [1, 2, 3] } } }),
    'Deadline    1500 ▾      p95 299 ms in its probe',
  );
  const slow = {
    ...DEFAULTS,
    classifiers: { ...DEFAULTS.classifiers, jev: { ...DEFAULTS.classifiers.jev, timeoutMs: 500 } },
  };
  assert.equal(
    deadline({ activityMetrics: null }, { ...slow, classifier: 'ollama' }),
    'Deadline    5000 ▾      p95 3483 ms in its probe',
  );
  assert.equal(
    deadline({ activityMetrics: { ...METRICS, latency: { jev: [0, 0, 0, 3, 15, 1, 1, ...Array(15).fill(0)] } } }, slow),
    'Deadline    500 ▾       p95 ≤ 350 ms over 20 turns',
  );
  const over = { ...METRICS, latency: { jev: [...Array(21).fill(0), 20] } };
  assert.match(deadline({ activityMetrics: over }), /p95 > \d+ ms over 20 turns: slower than the deadline$/);
  // A classifier id that names an Object.prototype member reads no latency rather than the prototype's function.
  const proto = { ...DEFAULTS.classifiers.jev, label: 'Proto', model: 'proto-1' };
  const config = { ...DEFAULTS, classifier: 'toString', classifiers: { toString: proto } };
  assert.equal(deadline({ activityMetrics: METRICS }, config), 'Deadline    1500 ▾      no wait measured yet');
});

test('a classifier on this machine says so where the prompt goes', () => {
  const lines = classifierLines({}, { ...DEFAULTS, classifier: 'ollama' });
  assert.ok(lines.some((line) => /^\[ ◉ Ollama\s+\] this machine/.test(line)));
  assert.ok(lines.includes('Sends       prompt + 6 recent turns → this machine'));
  assert.ok(lines.includes('Health      not paused · 0 recent failures'));
});

test('where the prompt goes names the host the request reaches', () => {
  const at = (endpoint) => {
    const ollama = { ...DEFAULTS.classifiers.ollama, endpoint };
    const config = { ...DEFAULTS, classifier: 'ollama', classifiers: { ...DEFAULTS.classifiers, ollama } };
    return classifierLines({}, config).find((line) => line.startsWith('Sends'));
  };
  assert.equal(at('http://[::1]:11434/api/chat'), 'Sends       prompt + 6 recent turns → this machine');
  assert.equal(at('http://127.0.0.1:11434/api/chat'), 'Sends       prompt + 6 recent turns → this machine');
  assert.equal(at('https://localhost:x@evil.example/api'), 'Sends       prompt + 6 recent turns → evil.example');
  assert.equal(
    at('https://localhost.evil.example/api'),
    'Sends       prompt + 6 recent turns → localhost.evil.example',
  );
});

test('an activity shows its cost only when every reply was priced', () => {
  const code = STATS.byActivity.code;
  for (const [name, counts, expected] of [
    ['all priced', code, '     12        71   100%      $4.21   Sonnet 5.5 · high'],
    ['one reply unpriced', { ...code, pricedRequests: 70 }, '     12        71   100%          —   Sonnet 5.5 · high'],
    [
      'a 1.7.0 row priced after an upgrade',
      { ...code, routedUsd: 0.05, pricedRequests: undefined },
      '     12        71   100%          —   Sonnet 5.5 · high',
    ],
  ]) {
    const lines = usageLines('on', { activityStats: { ...STATS, byActivity: { code: counts } } });
    assert.equal(lines[lines.indexOf('coding') + 2], expected, name);
  }
});

test('a narrow Usage tab drops mostly on, then the cost, before the activity counts', () => {
  for (const [columns, header] of [
    [null, `${HEAD}   mostly on`],
    [79, `${HEAD}   mostly on`],
    [78, HEAD],
    [59, HEAD],
    [58, `${' '.repeat(26)}turns  requests  share`],
  ]) {
    const lines = usageLines('on', { activityStats: STATS }, actions, { columns });
    assert.equal(lines[lines.indexOf('   activity routing on') + 1], header, String(columns));
  }
});

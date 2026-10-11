import assert from 'node:assert/strict';
import test from 'node:test';
import { bandSegments, fitSegments, renderBand, switchToast } from '../lib/band.mjs';
import { DEFAULTS } from '../lib/config.mjs';
import { GATEWAY_SETTINGS } from '../lib/display.mjs';

const ROUTER_BUTTON_COLUMNS = 8;
const SIXTY_COLUMNS = 60 - ROUTER_BUTTON_COLUMNS;
const actions = new Proxy({}, { get: () => () => {} });
const routes = [
  ['low', 'claude-sonnet-5-5', 'medium'],
  ['medium', 'claude-opus-5-5', 'medium'],
  ['high', 'claude-opus-5-5', 'xhigh'],
];

test('a 60-column band keeps the missing-credential warning and Set up beside the Router button for every classifier and route', () => {
  for (const id of Object.keys(DEFAULTS.classifiers)) {
    const config = { ...DEFAULTS, classifier: id };
    for (const error of ['missing-key', 'missing-account']) {
      for (const [tier, selectedModel, effort] of routes) {
        const view = { mode: 'auto', phase: 'routed', tier, selectedModel, effort, error };
        const parts = fitSegments(bandSegments(config, view, null, actions), SIXTY_COLUMNS).flatMap((s) => s.parts);
        const label = `${id} ${error} on ${tier}`;
        assert.ok(
          parts.some((p) => p.text?.startsWith(`⚠ ${DEFAULTS.classifiers[id].label}: no `)),
          label,
        );
        assert.ok(
          parts.some((p) => p.button?.key === 'band-key'),
          label,
        );
      }
    }
  }
});

test('a wide band shows the warning, the route kept and the reason', () => {
  const config = { ...DEFAULTS, classifier: 'clef-flash' };
  const view = { mode: 'auto', phase: 'routed', tier: 'medium', selectedModel: 'claude-opus-5-5', effort: 'medium' };
  const text = (error) =>
    fitSegments(bandSegments(config, { ...view, error }, null, actions), 112)
      .flatMap((s) => s.parts)
      .map((p) => p.text ?? `[${p.button.label}]`)
      .join(' ');
  assert.match(text('missing-account'), /⚠ Clef Flash: no account ID \[Set up\].*Opus 5\.5 · medium.*keeping model/);
  assert.match(text('timeout'), /⚠ Clef Flash timed out \[Details\].*Opus 5\.5 · medium.*keeping model/);
});

const line = (segments) =>
  segments
    .flatMap((s) => s.parts)
    .map((p) => p.text ?? `[${p.button.label}]`)
    .join('');
const plain = (priority, ...texts) => ({ priority, parts: texts.map((text) => ({ text, style: {} })) });

test('an unavailable router names the cause, or the gateway leftovers, beside Fix', () => {
  for (const [error, expected] of [
    ['bad router.json', '✕ Routing unavailablebad router.json[Fix]'],
    [GATEWAY_SETTINGS, '✕ Routing unavailablev0.8 gateway settings remain[Fix]'],
    [null, '✕ Routing unavailableunknown error[Fix]'],
  ])
    assert.equal(line(bandSegments(DEFAULTS, { mode: 'auto', phase: 'unavailable', error }, null, actions)), expected);
});

const element = (type) => (props) => ({ type, props });
const elements = { Box: element('Box'), Text: element('Text'), Button: element('Button') };
const drawn = (node) => {
  if (node.type === 'Text') return node.props.children;
  if (node.type === 'Button') return node.props.plain ? node.props.label : `[ ${node.props.label} ]`;
  return node.props.children.filter(Boolean).map(drawn).join('');
};
const buttonsOf = (node) =>
  node.type === 'Button'
    ? [node.props]
    : node.type === 'Box'
      ? node.props.children.filter(Boolean).flatMap(buttonsOf)
      : [];

const modeBands = {
  auto: {
    view: {
      mode: 'auto',
      phase: 'routed',
      tier: 'high',
      selectedModel: 'claude-opus-5-5',
      effort: 'xhigh',
      reason: 'jump',
    },
    reading: '▂▄▆█ high  Opus 5.5 · xhigh',
    control: { key: 'band-manual', label: 'Turn off', row: 'hover' },
  },
  manual: {
    view: { mode: 'manual', phase: 'manual', nativeModel: 'claude-sonnet-5-5', reason: 'model selected manually' },
    reading: '○ Routing off [ Turn on ]',
    control: { key: 'band-auto', label: 'Turn on', row: 'main' },
  },
};

test('each mode draws one mode control, on one row, and the band fits at 60, 80 and 120 columns', () => {
  for (const [mode, { view, reading, control }] of Object.entries(modeBands)) {
    for (const columns of [60, 80, 120]) {
      const [main, , hover] = renderBand(elements, DEFAULTS, view, null, { columns }, actions).props.children;
      const name = `${mode} at ${columns}`;
      assert.ok(drawn(main).length <= columns, `${name}: ${drawn(main)}`);
      assert.ok(drawn(hover).length <= columns, `${name}: ${drawn(hover)}`);
      assert.ok(drawn(main).startsWith(reading), name);
      if (mode === 'manual') assert.match(drawn(main), /Sonnet 5\.5/, name);
      const modeButtons = (row) => buttonsOf(row).filter((b) => b.key === 'band-auto' || b.key === 'band-manual');
      assert.deepEqual(
        modeButtons(control.row === 'main' ? main : hover).map((b) => [b.key, b.label]),
        [[control.key, control.label]],
        name,
      );
      assert.deepEqual(modeButtons(control.row === 'main' ? hover : main), [], name);
    }
  }
});

test('the hover row drops routing on, then 2 rows, then the pin label, then the pins, and keeps Turn off', () => {
  const { view } = modeBands.auto;
  for (const [columns, expected] of [
    [120, 'pin next turn [ micro ] [ low ] [ medium ] [ high ]  routing on [ Turn off ]  [ 2 rows ]'],
    [80, 'pin next turn [ micro ] [ low ] [ medium ] [ high ]  [ Turn off ]  [ 2 rows ]'],
    [70, 'pin next turn [ micro ] [ low ] [ medium ] [ high ]  [ Turn off ]'],
    [60, '[ micro ] [ low ] [ medium ] [ high ]  [ Turn off ]'],
    [40, '[ Turn off ]'],
  ])
    assert.equal(
      drawn(renderBand(elements, DEFAULTS, view, null, { columns }, actions).props.children[2]),
      expected,
      `${columns} columns`,
    );
});

test('a narrow two-row band keeps 1 row beside Turn off, the only way back to one row', () => {
  const view = { ...modeBands.auto.view, bandDetail: true };
  for (const [columns, expected] of [
    [60, '[ Turn off ]  [ 1 row ]'],
    [40, '[ Turn off ]  [ 1 row ]'],
  ])
    assert.equal(
      drawn(renderBand(elements, DEFAULTS, view, null, { columns }, actions).props.children[2]),
      expected,
      `${columns} columns`,
    );
});

test('a narrow manual band drops the explanation, then the model, then the word Routing, and keeps Turn on', () => {
  const { view } = modeBands.manual;
  for (const [columns, expected] of [
    [80, '○ Routing off [ Turn on ]  ·  every turn uses Sonnet 5.5 (/model)  Router'],
    [60, '○ Routing off [ Turn on ]  ·  Sonnet 5.5 (/model)  Router'],
    [52, '○ Routing off [ Turn on ]  ·  Sonnet 5.5  Router'],
    [48, '○ Routing off [ Turn on ]  ·  Sonnet 5.5  Router'],
    [44, '○ Routing off [ Turn on ]  Router'],
    [40, '○ Routing off [ Turn on ]  Router'],
    [30, '○ off [ Turn on ]  Router'],
  ]) {
    const main = renderBand(elements, DEFAULTS, view, null, { columns }, actions).props.children[0];
    assert.equal(drawn(main), expected, `${columns} columns`);
    assert.ok(drawn(main).length <= columns, `${columns} columns`);
    assert.ok(
      buttonsOf(main).some((b) => b.key === 'band-auto'),
      `${columns} columns`,
    );
  }
});

test('a turn being classified shows an accent meter and the classifier deadline', () => {
  const segments = bandSegments(DEFAULTS, { mode: 'auto', phase: 'choosing', tier: 'medium' }, null, actions);
  assert.equal(line(segments), '▂▄▆█ choosing for this turn…Jev · 1.5 s deadline');
  assert.ok(segments[0].parts.slice(0, 4).every((p) => p.style.color && !p.style.dimColor));
});

test('a narrow band drops the highest priority first, the later one on a tie', () => {
  const segments = [plain(0, 'main'), plain(2, 'two-a'), plain(1, 'one'), plain(2, 'two-b')];
  for (const [columns, expected] of [
    [100, ['main', 'two-a', 'one', 'two-b']],
    [27, ['main', 'two-a', 'one']],
    [20, ['main', 'one']],
    [4, ['main']],
  ])
    assert.deepEqual(
      fitSegments(segments, columns).map((s) => line([s])),
      expected,
      `${columns} columns`,
    );
});

test('a first segment wider than the band is cut with an ellipsis and the rest go', () => {
  const kept = fitSegments([plain(0, '⚠ ', 'Clef Flash: no account ID'), plain(0, 'Set up')], 12);
  assert.deepEqual(
    kept.map((s) => line([s])),
    ['⚠ Clef Flas…'],
  );
});

test('a cut keeps buttons whole and leaves a part too short to cut', () => {
  const segment = {
    priority: 0,
    parts: [
      { text: 'route kept here', style: {} },
      { button: { key: 'b', label: 'Details' } },
      { text: '!', style: {} },
    ],
  };
  assert.equal(line(fitSegments([segment], 20)), 'route k…[Details]!');
});

const activityBand = {
  on: {
    view: {
      mode: 'auto',
      phase: 'routed',
      tier: 'low',
      selectedModel: 'claude-sonnet-5-5',
      effort: 'medium',
      activity: 'code',
      reason: 'activity-up',
      estimate: { threshold: 0.79, upgradeMass: 0.82 },
    },
    label: 'coding → ',
    route: 'Sonnet 5.5 · medium',
    reason: '↗ coding',
  },
};

test('a narrow band drops the activity before the reason and keeps the tier and the route in use', () => {
  for (const [mode, { view, label, route, reason }] of Object.entries(activityBand)) {
    for (const [columns, activity, why] of [
      [120, true, true],
      [80, true, true],
      [52, false, true],
      [42, false, false],
    ]) {
      const config = { ...DEFAULTS, activityRouting: mode };
      const kept = fitSegments(bandSegments(config, view, null, actions), columns - ROUTER_BUTTON_COLUMNS);
      const parts = kept.flatMap((s) => s.parts);
      const name = `${mode} at ${columns}`;
      assert.ok(line(kept).length <= columns - ROUTER_BUTTON_COLUMNS, name);
      assert.ok(line(kept).startsWith(`▂▄▆█ low  ${activity ? label : ''}${route}`), name);
      assert.equal(
        parts.some((p) => p.text === reason),
        why,
        name,
      );
      const tag = parts.find((p) => p.text === label);
      assert.equal(Boolean(tag), activity, name);
      if (tag) assert.deepEqual(tag.style, { color: '#d77757', italic: true }, name);
    }
  }
});

test('routing off by activity shows no activity in the band', () => {
  const config = { ...DEFAULTS, activityRouting: 'off' };
  assert.ok(!line(bandSegments(config, activityBand.on.view, null, actions)).includes('coding →'));
});

test('activity moves name their activity in the band and the switch toast', () => {
  const config = { ...DEFAULTS, activityRouting: 'on' };
  const routed = { mode: 'auto', phase: 'routed', tier: 'low', selectedModel: 'claude-haiku-5-5', effort: 'high' };
  const reasonOf = (view) =>
    bandSegments(config, { ...routed, ...view }, null, actions).find((s) => s.priority === 1 && s.parts[0].text)
      ?.parts[0].text;
  const probabilities = { ops: 0.81, code: 0.1 };
  for (const [view, expected] of [
    [{ reason: 'activity-up', activity: 'code' }, '↗ coding'],
    [{ reason: 'activity-down', activity: 'ops' }, '↘ running'],
    [{ reason: 'activity-down', activity: null }, '↘ base'],
    [
      { reason: 'activity-pending', activity: 'code', activityChoice: 'ops', activityProbabilities: probabilities },
      '… running: not worth a switch',
    ],
    [
      { reason: 'activity-pending', activity: 'code', activityChoice: 'ops', activityProbabilities: { ops: 0.4 } },
      '… base: not worth a switch',
    ],
  ])
    assert.equal(reasonOf(view), expected, JSON.stringify(view));
  const sonnet = { model: 'claude-sonnet-5-5', effort: 'medium' };
  const haiku = { model: 'claude-haiku-5-5', effort: 'high' };
  assert.equal(
    switchToast(config, sonnet, { ...haiku, reason: 'activity-down', activity: 'ops' }, null),
    'Model changed: Sonnet 5.5 · medium → Haiku 5.5 · high · running',
  );
  assert.equal(
    switchToast(config, haiku, { ...sonnet, reason: 'upgrade', activity: 'code' }, null),
    'Model changed: Haiku 5.5 · high → Sonnet 5.5 · medium · upgrade',
  );
});

test('a held switch shows the classifier against its bar without a rounding tie, and the switch cost', () => {
  const held = {
    mode: 'auto',
    phase: 'routed',
    tier: 'low',
    selectedModel: 'claude-haiku-5-5',
    effort: 'high',
    activity: 'review',
    reason: 'activity-pending',
    estimate: { taxUsd: 0.37, threshold: 0.8138, upgradeMass: 0.81 },
  };
  const at = (columns) =>
    fitSegments(bandSegments(DEFAULTS, held, null, actions), columns)
      .map((s) => line([s]))
      .join('  ·  ');
  assert.match(at(200), /Jev 81\.0% < 81\.4% {2}· {2}switch cost ≈ \$0\.37$/);
  assert.match(at(100), /Jev 81\.0% < 81\.4%$/);
  const free = { ...held, estimate: { taxUsd: 0, threshold: 0.75, upgradeMass: 0.6 } };
  assert.match(line(bandSegments(DEFAULTS, free, null, actions)), /Jev 60% < 75%$/);
});

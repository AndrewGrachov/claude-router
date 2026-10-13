// Draws the band and pane pictures in docs/ from the real render functions, with sample readings.
// Run after a UI change: npm run docs:images. The layout is a plain row/column flow, not Claude Code's renderer.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderBand } from '../lib/band.mjs';
import { loadConfig } from '../lib/config.mjs';
import { renderPanel, routeDraftOf } from '../lib/panel.mjs';

const OUT = fileURLToPath(new URL('../docs', import.meta.url));
const config = { ...loadConfig(), nativePath: '~/.claude/router.json' };
const element = (type) => (props) => ({ type, props });
const elements = { Box: element('Box'), Text: element('Text'), Button: element('Button'), Select: element('Select') };
const noop = () => {};
const actions = new Proxy({}, { get: () => noop });

const COLORS = { cyan: '#5fafd7', yellow: '#d7af5f', green: '#87d787', red: '#e06c6c', gray: '#7c7c7c' };
const FG = '#d0d0d0';
const DIM = '#7c7c7c';
const ACCENT = '#87afff';
const INK = '#0d1016';
const BUTTON = '#2e3340';

// Layout: a node becomes lines of runs; each run is { text, fill, bold, italic, bg }, bg being a chip behind the text.
const width = (line) => line.reduce((n, r) => n + [...r.text].length, 0);
const pad = (lines, w) =>
  lines.map((line) => (width(line) < w ? [...line, { text: ' '.repeat(w - width(line)) }] : line));
function lay(node, { hover }) {
  if (!node) return [];
  const { type, props } = node;
  if (type === 'Text') {
    const fill = props.dimColor ? DIM : (COLORS[props.color] ?? props.color ?? FG);
    return [[{ text: props.children ?? '', fill, bold: props.bold, italic: props.italic, bg: props.backgroundColor }]];
  }
  if (type === 'Button') {
    const text = props.plain ? props.label : `[ ${props.label} ]`;
    if (props.plain) return [[{ text, fill: props.dimColor ? DIM : FG }]];
    if (props.variant === 'primary') return [[{ text, fill: INK, bold: true, bg: ACCENT }]];
    return [[{ text, fill: props.dimColor ? DIM : FG, bg: BUTTON }]];
  }
  if (type === 'Select') {
    const picked = props.options.find((o) => o.value === props.value)?.label ?? props.value;
    return [[{ text: `${props.label ? `${props.label}: ` : ''}${picked} ▾`, fill: FG }]];
  }
  // Box
  if (props.display === 'none' && !hover) return [];
  const children = (Array.isArray(props.children) ? props.children : [props.children]).filter(Boolean);
  let lines;
  if (props.flexDirection === 'column') lines = children.flatMap((child) => lay(child, { hover }));
  else {
    const blocks = children.map((child) => lay(child, { hover })).filter((b) => b.length);
    const height = Math.max(1, ...blocks.map((b) => b.length));
    lines = Array.from({ length: height }, () => []);
    for (const block of blocks) {
      const w = Math.max(0, ...block.map(width));
      const padded = pad(block, w);
      for (let i = 0; i < height; i += 1) lines[i].push(...(padded[i] ?? [{ text: ' '.repeat(w) }]));
    }
  }
  return props.width ? pad(lines, props.width) : lines;
}

const CW = 7.8;
const LH = 19;
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function runsSvg(lines, x0, y0) {
  const out = [];
  lines.forEach((line, row) => {
    let col = 0;
    for (const run of line) {
      const x = x0 + col * CW;
      const width = [...run.text].length * CW;
      if (run.bg && run.text.trim()) {
        out.push(
          `<rect x="${x.toFixed(1)}" y="${y0 + row * LH - 14}" width="${width.toFixed(1)}" height="18" rx="4" fill="${run.bg}"/>`,
        );
      }
      if (run.text.trim()) {
        out.push(
          `<text x="${x.toFixed(1)}" y="${y0 + row * LH}" fill="${run.fill ?? FG}"${run.bold ? ' font-weight="700"' : ''}${run.italic ? ' font-style="italic"' : ''} xml:space="preserve">${esc(run.text)}</text>`,
        );
      }
      col += [...run.text].length;
    }
  });
  return out.join('\n');
}

function svg({ title, desc, body, w, h }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" role="img" aria-labelledby="title desc">
  <title id="title">${esc(title)}</title>
  <desc id="desc">${esc(desc)}</desc>
  <style>
    text { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace; font-size: 13px; }
    .cap { font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; font-size: 12px; fill: #9a988f; }
  </style>
  <rect width="${w}" height="${h}" rx="8" fill="#1c1c1c"/>
${body}
</svg>
`;
}

const base = {
  phase: 'routed',
  mode: 'auto',
  nativeModel: 'claude-haiku-5-5',
  selectedModel: 'claude-opus-5-5',
  actualModel: 'claude-opus-5-5',
  tier: 'high',
  effort: 'xhigh',
  reason: 'jump',
  error: null,
  credentials: {
    jev: null,
    clef: 'missing-key',
    'clef-flash': 'missing-key',
    'clef-omni': 'missing-key',
    openai: 'missing-key',
    ollama: null,
  },
  adviceMs: 347,
  probabilities: { micro: 0.02, low: 0.03, medium: 0.07, high: 0.88, uncertain: 0 },
  estimate: { threshold: 0.82, upgradeMass: 0.88, taxUsd: 0.476 },
  contextTokens: 401_800,
  contextKnown: true,
  inputTokens: 402_400,
  cacheRead: 400_600,
  cacheWrite: 1_800,
  outputTokens: 499,
  history: [
    361_000, 364_000, 366_000, 369_000, 371_000, 372_000, 375_000, 378_000, 380_000, 383_000, 386_000, 388_000, 390_000,
    392_000, 395_000, 396_000, 398_000, 399_000, 401_000, 402_400,
  ],
  tiers: [...'llllllddllllhhhhhhhh'].map((c) => ({ l: 'low', d: 'medium', h: 'high' })[c]),
  activities: [...'eeccoocceeppcccccccc'].map((c) => ({ c: 'code', e: 'explore', o: 'ops', p: 'plan' })[c]),
  // What served each reply: Haiku at low, Sonnet for low coding and planning, Opus at medium and high.
  routes: [...'hhsshhsshhoossOOOOOO'].map(
    (c) =>
      ({
        h: 'claude-haiku-5-5@high',
        s: 'claude-sonnet-5-5@high',
        o: 'claude-opus-5-5@medium',
        O: 'claude-opus-5-5@xhigh',
      })[c],
  ),
  activity: 'code',
  activityChoice: 'code',
  activityProbabilities: { code: 0.84, debug: 0.08, plan: 0.05, uncertain: 0.03 },
  wouldRoute: { activity: 'code', tier: 'high', model: 'claude-opus-5-5', effort: 'xhigh', reason: 'jump' },
  pendingPin: null,
  comparison: null,
  health: { failures: 0, pausedUntil: 0 },
  configPath: '~/.claude/router.json',
  tab: 'now',
  help: false,
  bandDetail: false,
};
const usage = {
  context: { tokens: 402_400 },
  cost: { usd: 18.003 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 48 },
    { kind: 'seven_day', percentUsed: 43 },
  ],
};

// Routing vs your model: a session on Opus 5.5 at xhigh that routing ran mostly on cheaper tiers.
const yours = { nativeModel: 'claude-opus-5-5', nativeEffort: 'xhigh' };
const savings = {
  replies: 64,
  routedUsd: 6.404,
  yoursUsd: 8.236,
  cheaperUsd: -2.31,
  strongerUsd: 0,
  switchUsd: 0.478,
  tiers: { micro: 12, low: 26, medium: 17, high: 9 },
  tierUsd: { micro: 0.4, low: 2.3, medium: 2.1, high: 1.6 },
  stronger: {},
};
// The same session against each model in router.json: /model on Sonnet or Haiku would have shown routing costing more.
const savingsBy = {
  opus: savings,
  sonnet: { ...savings, yoursUsd: 4.118, cheaperUsd: 0, strongerUsd: 1.808 },
  haiku: { ...savings, yoursUsd: 0.206, cheaperUsd: 0, strongerUsd: 5.72 },
};
const savingsStore = {
  version: 1,
  since: Date.parse('2026-10-03T12:00:00Z'),
  replies: 412,
  routedUsd: 41.18,
  yoursUsd: 52.6,
  cheaperUsd: -14.9,
  strongerUsd: 0,
  switchUsd: 3.48,
};

// ---- band states ----
const COLUMNS = 112;
const states = [
  ['Routing on: routed to the high tier on a clear jump', base, false],
  [
    'Two rows, with the hover row shown: the session against your model, pins, Turn off',
    { ...base, ...yours, bandDetail: true, savings, estimate: null },
    true,
  ],
  [
    'A pin waits for the next turn; ✕ cancels it',
    {
      ...base,
      tier: 'low',
      selectedModel: 'claude-haiku-5-5',
      actualModel: 'claude-haiku-5-5',
      effort: 'high',
      activity: 'ops',
      reason: 'same-tier',
      estimate: null,
      pendingPin: 'medium',
    },
    false,
  ],
  [
    'No classifier key: routing keeps the model and offers Set up',
    {
      ...base,
      tier: 'low',
      selectedModel: 'claude-haiku-5-5',
      actualModel: 'claude-haiku-5-5',
      effort: 'high',
      reason: 'no-advice',
      activity: null,
      error: 'missing-key',
      credentials: {
        jev: 'missing-key',
        clef: 'missing-key',
        'clef-flash': 'missing-key',
        'clef-omni': 'missing-key',
        openai: 'missing-key',
        ollama: null,
      },
      estimate: null,
    },
    false,
  ],
  [
    'Routing off: /model chose the model; Turn on resumes routing',
    { ...base, mode: 'manual', reason: 'model selected manually', nativeModel: 'claude-sonnet-5-5' },
    false,
  ],
  [
    'Activity routing on: an ops turn at medium moves from Opus to Haiku',
    {
      ...base,
      tier: 'medium',
      selectedModel: 'claude-haiku-5-5',
      actualModel: 'claude-haiku-5-5',
      effort: 'high',
      activity: 'ops',
      reason: 'activity-down',
      estimate: null,
    },
    false,
  ],
];
let y = 30;
const parts = [];
for (const [caption, view, hover] of states) {
  const tree = renderBand(elements, config, view, usage, { columns: COLUMNS }, actions);
  const lines = lay(tree, { hover });
  parts.push(`<text class="cap" x="20" y="${y}">${esc(caption)}</text>`);
  parts.push(
    `<rect x="12" y="${y + 8}" width="${COLUMNS * CW + 24}" height="${lines.length * LH + 10}" rx="5" fill="#232323"/>`,
  );
  parts.push(runsSvg(lines, 24, y + 8 + 18));
  y += 8 + lines.length * LH + 10 + 28;
}
writeFileSync(
  `${OUT}/router-band.svg`,
  svg({
    title: 'The Router band above the Claude Code prompt',
    desc: 'Six band states drawn by the router code: routed to high, two rows with the hover row, a pending pin, a missing classifier key, routing off, and an activity move with activity routing on.',
    body: parts.join('\n'),
    w: Math.ceil(COLUMNS * CW + 48),
    h: y - 14,
  }),
);

// ---- pane tabs ----
const activityStore = {
  version: 1,
  confusion: { code: { code: 40, read: 4 }, ops: { ops: 18, read: 3, code: 1 }, explore: { read: 12, talk: 5 } },
  runs: {},
  lateral: { taken: 9, refused: 4 },
};
function pane(view, title, desc, file, paneConfig = config) {
  const tree = renderPanel(elements, paneConfig, view, usage, actions, { modelOptions: Object.keys(config.models) });
  const lines = lay(tree, { hover: false }).filter((line, i, all) => i < all.length - 1 || width(line) > 0);
  const cols = Math.max(...lines.map(width), 70);
  const w = Math.ceil(cols * CW + 48);
  const h = lines.length * LH + 40;
  const body = `<rect x="10" y="10" width="${w - 20}" height="${h - 20}" rx="6" fill="none" stroke="#3f5f8f"/>\n${runsSvg(lines, 24, 34)}`;
  writeFileSync(`${OUT}/${file}`, svg({ title, desc, body, w, h }));
}
pane(
  base,
  'Router pane, Now tab',
  'What runs next turn: tier, model and activity, with the reason and the classifier support it weighed; classifier support per tier with pin buttons; the last 20 replies colored by tier with the switch count and the replies per tier and per activity; and context, cache and cost.',
  'router-pane-now.svg',
);
const draft = {
  ...routeDraftOf(config, {}),
  routes: { ...config.routes, medium: { model: 'sonnet', effort: 'xhigh' } },
  activities: { ...config.activities, code: { ...config.activities.code, high: { model: 'opus', effort: 'max' } } },
};
pane(
  { ...base, tab: 'routes', routeDraft: draft, routeCell: 'code.high' },
  'Router pane, Routes tab',
  'The activity routing mode, then one grid of tiers by activities: the tiers’ own models on top, each activity override in its cell with built-in defaults marked °, unsaved edits ●; the editor of the selected cell, coding at high, with Use tier model; the model setups in use; and the unsaved router.json changes with Save and Discard.',
  'router-pane-routes.svg',
);
pane(
  { ...base, tab: 'policy', tuning: { downgradeVotes: 3 }, tuningBase: null, configPath: '~/.claude/router.json' },
  'Router pane, Policy tab',
  'Each policy control inside the sentence it completes: the start tier, votes and payback horizon for going down, the support needed to go up, the activity threshold and the credits cap, with the default shown beside a changed value, the router.json file, and the unsaved change with Save and Discard.',
  'router-pane-policy.svg',
);
pane(
  {
    ...base,
    tab: 'classifier',
    adviceMs: null,
    credentials: {
      jev: 'missing-key',
      clef: null,
      'clef-flash': null,
      'clef-omni': null,
      openai: 'missing-key',
      ollama: null,
    },
    notice: 'Saved: classifier Clef → Clef Flash. Applies from the next turn.',
    lastWrite: { label: 'classifier Clef → Clef Flash', leaves: [{ path: ['classifier'], value: 'clef' }] },
    activityStore,
    activityMetrics: { version: 1, latency: {}, downMoves: { moves: 7, escalations: 0 } },
  },
  'Router pane, Classifier tab',
  'One row per classifier to compare: where the prompt goes, its activity probe, its p95 wait and whether its credentials are complete, with Set up for a missing Jev API key; the active classifier’s deadline against its wait, the host that receives the prompt, health and credentials; the agreement with tools across sessions; and Undo after a switch.',
  'router-pane-classifier.svg',
  { ...config, classifier: 'clef-flash' },
);
pane(
  {
    ...base,
    ...yours,
    tab: 'usage',
    savings,
    savingsBy,
    savingsStore,
    activityStats: {
      byActivity: {
        code: {
          turns: 14,
          requests: 41,
          inputTokens: 0,
          outputTokens: 0,
          routedUsd: 3.12,
          pricedRequests: 41,
          routes: { 'claude-sonnet-5-5@high': 30, 'claude-opus-5-5@xhigh': 11 },
        },
        ops: {
          turns: 6,
          requests: 15,
          inputTokens: 0,
          outputTokens: 0,
          routedUsd: 0.41,
          pricedRequests: 15,
          routes: { 'claude-haiku-5-5@high': 15 },
        },
        explore: {
          turns: 4,
          requests: 8,
          inputTokens: 0,
          outputTokens: 0,
          routedUsd: 0.38,
          pricedRequests: 8,
          routes: { 'claude-haiku-5-5@high': 8 },
        },
      },
      switches: { tier: 5, activity: 3 },
      lateral: { taken: 3, refused: 1 },
      agreement: { matched: 21, total: 24 },
    },
    activityStore,
    activityMetrics: {
      version: 1,
      latency: { jev: [0, 0, 12, 40, 24, 3, 2, ...Array(15).fill(0)] },
      downMoves: { moves: 7, escalations: 0 },
    },
  },
  'Router pane, Usage tab',
  'The answer first, routing saved $1.84 (22%) against Opus 5.5 at xhigh; then routed replies against the same tokens on your model, this session and since the last reset, the difference split into cheaper models, stronger models and switch cache writes, the two costs as bars and the replies by tier; plan quota; this session by activity with estimated cost and route; and Claude’s readings on one line with details.',
  'router-pane-usage.svg',
);
console.log(`wrote router-band.svg and the Now, Routes, Policy, Classifier and Usage pane pictures to ${OUT}`);

import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyStore } from '../lib/activity-stats.mjs';
import { readUsage, summarize } from '../lib/usage.mjs';
import {
  CLEF_FLASH_ANSWER,
  CLOUDFLARE_KEYS,
  CONFIG,
  controls,
  drain,
  harness,
  press,
  start,
  step,
  TINY_ROUTER,
  texts,
} from './harness.mjs';
import { jevResponse, savedCounts } from './helpers.mjs';

test('clear discards unsaved tuning and preserves active configuration', async () => {
  const h = harness();
  await start(h);
  await press(h, 'tab-routes');
  await press(h, 'tab-policy');
  await press(h, 'horizon', '10');
  assert.equal(h.view().tuning.horizon, 10);
  await h.event('session.end', { reason: 'clear' });
  h.clear();
  await drain(h.step({ ...step, turnId: 't2' }));
  assert.equal(h.view().tuning, null);
  await press(h, 'tab-policy');
  assert.equal(controls(await h.render()).find((node) => node.key === 'horizon').value, '5');
});

test('saved tuning cannot change a classification already in progress', async () => {
  const h = harness({ typesafe_api_key: 'synthetic-key' });
  let resolve;
  h.http(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await start(h);
  const pending = drain(h.step(step));
  for (let i = 0; i < 100 && !resolve; i += 1) await Promise.resolve();
  assert.ok(resolve);
  await press(h, 'tab-routes');
  await press(h, 'tab-policy');
  await press(h, 'downgradeVotes', '1');
  await press(h, 'save-routing');
  resolve({
    status: 200,
    ok: true,
    headers: {},
    text: JSON.stringify({
      answers: {
        route: {
          type: 'choice',
          choice: 'micro',
          confidence: 0.999,
          probabilities: { micro: 0.999, low: 0.001, medium: 0, high: 0 },
        },
        continuation: { type: 'noul', noul: 0 },
      },
    }),
  });
  await pending;
  assert.equal(h.requests[0].model, step.model);
  assert.equal(h.view().probabilities.micro, 0.999);
  await press(h, 'tab-now');
  assert.ok(texts(await h.render()).some((line) => /100%/.test(line)));
});

test('a saved route edit writes router.json and routes the next turn', async () => {
  const h = harness();
  await start(h);
  await press(h, 'tab-routes');
  await press(h, 'tab-routes');
  await press(h, 'cell-tier-medium');
  await press(h, 'route-medium-model', 'sonnet');
  await press(h, 'tab-routes');
  await press(h, 'cell-tier-medium');
  await press(h, 'route-medium-effort', 'xhigh');
  assert.ok(texts(await h.render()).some((line) => /\+ routes\.medium\s+Sonnet 5\.5 · xhigh/.test(line)));
  await press(h, 'save-routing');
  assert.deepEqual(JSON.parse(h.files.get(CONFIG)), { routes: { medium: { model: 'sonnet', effort: 'xhigh' } } });
  assert.equal(h.view().routeDraft, null);
  assert.match(h.view().notice, /^Saved: 1 routing change\. Applies from the next turn\.$/);
  await h.event('turn.start', { turnId: 't2', text: 'Next.' });
  await h.event('command.run', { command: 'router', args: 'pin medium' });
  await drain(h.step({ ...step, turnId: 't2' }));
  assert.deepEqual([h.requests[0].model, h.requests[0].effort], ['claude-sonnet-5-5', 'xhigh']);
});

test('session effort on a tier sends the effort Claude Code asked for', async () => {
  const h = harness();
  await start(h);
  await press(h, 'tab-routes');
  await press(h, 'tab-routes');
  await press(h, 'cell-tier-high');
  await press(h, 'route-high-effort', 'session');
  await press(h, 'save-routing');
  assert.deepEqual(JSON.parse(h.files.get(CONFIG)).routes.high, { model: 'opus', effort: null });
  await h.event('turn.start', { turnId: 't2', text: 'Next.' });
  await h.event('command.run', { command: 'router', args: 'pin high' });
  await drain(h.step({ ...step, turnId: 't2', effort: 'low' }));
  assert.deepEqual([h.requests[0].model, h.requests[0].effort], ['claude-opus-5-5', 'low']);
});

test('reset to defaults removes saved route overrides and keeps other settings', async () => {
  const h = harness();
  h.files.set(CONFIG, JSON.stringify({ routes: { low: { model: 'opus' } }, classifiers: { jev: { timeoutMs: 900 } } }));
  await start(h);
  await press(h, 'tab-routes');
  await press(h, 'reset-routes');
  await press(h, 'save-routing');
  assert.deepEqual(JSON.parse(h.files.get(CONFIG)), { classifiers: { jev: { timeoutMs: 900 } } });
});

test('a model without effort levels has no effort control and drops the chosen effort', async () => {
  const h = harness();
  h.files.set(CONFIG, TINY_ROUTER);
  await start(h);
  await press(h, 'tab-routes');
  await press(h, 'cell-tier-micro');
  assert.equal(
    controls(await h.render()).find((node) => node.key === 'route-micro-effort'),
    undefined,
  );
  await press(h, 'tab-routes');
  await press(h, 'cell-tier-high');
  await press(h, 'route-high-model', 'tiny');
  assert.deepEqual(h.view().routeDraft.routes.high, { model: 'tiny', effort: null });
  assert.equal(
    controls(await h.render()).find((node) => node.key === 'route-high-effort'),
    undefined,
  );
});

test('model choices follow the availableModels allowlist', async () => {
  const h = harness();
  h.settings({ availableModels: ['sonnet'] });
  await start(h);
  await press(h, 'tab-routes');
  await press(h, 'cell-tier-low');
  const select = controls(await h.render()).find((node) => node.key === 'route-low-model');
  assert.deepEqual(
    select.options.map((option) => option.value),
    ['haiku', 'sonnet'],
  );
});

test('a save that fails validation names the setting, leaves router.json unchanged and keeps the draft', async () => {
  for (const [content, reason] of [
    [JSON.stringify({ policy: { cashCapUsd: -1 } }), /policy\.cashCapUsd must be a non-negative number/],
    ['{ "routes": ', /router\.json is not valid JSON/],
  ]) {
    const h = harness();
    await start(h);
    h.files.set(CONFIG, content);
    await press(h, 'tab-routes');
    await press(h, 'tab-routes');
    await press(h, 'cell-tier-medium');
    await press(h, 'route-medium-model', 'sonnet');
    await press(h, 'save-routing');
    assert.match(h.view().notice, reason);
    assert.match(h.view().notice, /unchanged/);
    assert.equal(h.files.get(CONFIG), content);
    assert.deepEqual(h.view().routeDraft.routes.medium, { model: 'sonnet', effort: 'medium' });
  }
});

test('the pane refuses to save through a symlinked router.json', async () => {
  const h = harness();
  await start(h);
  h.files.set(CONFIG, '{}');
  h.links.add(CONFIG);
  await press(h, 'tab-routes');
  await press(h, 'tab-routes');
  await press(h, 'cell-tier-medium');
  await press(h, 'route-medium-model', 'sonnet');
  await press(h, 'save-routing');
  assert.match(h.view().notice, /symlink/);
  assert.equal(h.files.get(CONFIG), '{}');
  await press(h, 'tab-routes');
  await press(h, 'tab-policy');
  await press(h, 'horizon', '10');
  await press(h, 'save-routing');
  assert.match(h.view().notice, /symlink/);
  assert.equal(h.files.get(CONFIG), '{}');
});

test('a tuning save writes only the changed value and keeps edits made on disk', async () => {
  const h = harness();
  await start(h);
  h.files.set(CONFIG, JSON.stringify({ classifiers: { jev: { timeoutMs: 900 } } }));
  await press(h, 'tab-routes');
  await press(h, 'tab-policy');
  await press(h, 'horizon', '10');
  await press(h, 'save-routing');
  assert.deepEqual(JSON.parse(h.files.get(CONFIG)), {
    classifiers: { jev: { timeoutMs: 900 } },
    policy: { downgradeHorizonTurns: 10 },
  });
});

test('the activity threshold is a policy draft: Save writes only a difference from the default, and Undo', async () => {
  const h = harness({ typesafe_api_key: 'synthetic-key' });
  const LOW = { micro: 0, low: 0.95, medium: 0.05, high: 0, uncertain: 0 };
  h.http(async () => ({
    ok: true,
    status: 200,
    headers: {},
    text: JSON.stringify(jevResponse('low', LOW, 0, { code: 0.79, ops: 0.21 })),
  }));
  await h.event('session.start', { cwd: '/fixture' });
  await press(h, 'tab-policy');
  const threshold = controls(await h.render()).find((c) => c.key === 'activityMass');
  assert.deepEqual(
    threshold.options.map((o) => o.label),
    ['50%', '60%', '70%', '80%'],
  );
  assert.equal(threshold.value, '0.6');
  await press(h, 'tab-policy');
  await press(h, 'activityMass', '0.8');
  assert.equal(h.files.get(CONFIG), undefined);
  const lines = texts(await h.render());
  const at = lines.indexOf('router.json changes:');
  assert.deepEqual(lines.slice(at + 1, at + 3), [
    '- policy.activityMass            60%',
    '+ policy.activityMass            80%',
  ]);
  await press(h, 'save-routing');
  assert.deepEqual(JSON.parse(h.files.get(CONFIG)), { policy: { activityMass: 0.8 } });
  // A code reading of 79% clears the upgrade bar but not the new threshold: the tier route runs, not the code override.
  await h.event('turn.start', { turnId: 't1', text: 'One edit.' });
  await drain(h.step(step));
  assert.deepEqual([h.requests[0].model, h.requests[0].effort], ['claude-haiku-5-5', 'high']);
  await press(h, 'tab-policy');
  await press(h, 'activityMass', '0.6');
  await press(h, 'save-routing');
  assert.deepEqual(JSON.parse(h.files.get(CONFIG)), {});
  await press(h, 'undo');
  assert.deepEqual(JSON.parse(h.files.get(CONFIG)), { policy: { activityMass: 0.8 } });
});

test('one routing save writes routes and policy together and keeps edits made on disk', async () => {
  const h = harness();
  await start(h);
  await press(h, 'tab-routes');
  await press(h, 'tab-routes');
  await press(h, 'cell-tier-micro');
  await press(h, 'route-micro-model', 'sonnet');
  await press(h, 'tab-policy');
  await press(h, 'horizon', '10');
  h.files.set(
    CONFIG,
    JSON.stringify({ routes: { high: { model: 'sonnet' } }, classifiers: { jev: { timeoutMs: 900 } } }),
  );
  await press(h, 'save-routing');
  assert.deepEqual(JSON.parse(h.files.get(CONFIG)), {
    routes: { micro: { model: 'sonnet', effort: 'medium' }, high: { model: 'sonnet' } },
    classifiers: { jev: { timeoutMs: 900 } },
    policy: { downgradeHorizonTurns: 10 },
  });
  assert.equal(h.view().notice, 'Saved: 2 routing changes. Applies from the next turn.');
  await press(h, 'tab-policy');
  await press(h, 'downgradeVotes', '3');
  h.files.set(CONFIG, JSON.stringify({ classifiers: { jev: { timeoutMs: 3000 } } }));
  await press(h, 'tab-routes');
  await press(h, 'cell-tier-micro');
  await press(h, 'route-micro-model', 'haiku');
  await press(h, 'save-routing');
  assert.deepEqual(JSON.parse(h.files.get(CONFIG)), {
    classifiers: { jev: { timeoutMs: 3000 } },
    policy: { downgradeVotes: 3 },
  });
});

test('Undo puts back only what the routing save changed, keeping an edit made on disk', async () => {
  const h = harness();
  await start(h);
  h.files.set(CONFIG, JSON.stringify({ routes: { low: { model: 'opus' } }, policy: { cashCapUsd: 5 } }));
  await press(h, 'tab-routes');
  await press(h, 'tab-routes');
  await press(h, 'cell-tier-medium');
  await press(h, 'route-medium-model', 'sonnet');
  await press(h, 'tab-policy');
  await press(h, 'horizon', '10');
  await press(h, 'save-routing');
  h.files.set(CONFIG, JSON.stringify({ ...JSON.parse(h.files.get(CONFIG)), classifier: 'clef' }));
  await press(h, 'tab-usage');
  await press(h, 'undo');
  assert.deepEqual(JSON.parse(h.files.get(CONFIG)), {
    routes: { low: { model: 'opus' } },
    policy: { cashCapUsd: 5 },
    classifier: 'clef',
  });
  assert.equal(h.view().lastWrite, null);
});

test('the deadline has Undo too', async () => {
  const h = harness();
  await start(h);
  await press(h, 'tab-classifier');
  await press(h, 'timeoutMs', '500');
  assert.deepEqual(JSON.parse(h.files.get(CONFIG)), { classifiers: { jev: { timeoutMs: 500 } } });
  await press(h, 'undo');
  assert.deepEqual(JSON.parse(h.files.get(CONFIG)), {});
});

test('Undo writes back what the file held before the save, not what the session loaded', async () => {
  const h = harness();
  h.files.set(CONFIG, JSON.stringify({ routes: { high: { model: 'sonnet' } } }));
  await start(h);
  h.files.set(CONFIG, JSON.stringify({ routes: { high: { model: 'sonnet' } }, policy: { downgradeHorizonTurns: 3 } }));
  await press(h, 'tab-routes');
  await press(h, 'tab-routes');
  await press(h, 'cell-tier-high');
  await press(h, 'route-high-effort', 'low');
  await press(h, 'tab-policy');
  await press(h, 'horizon', '10');
  await press(h, 'save-routing');
  assert.deepEqual(JSON.parse(h.files.get(CONFIG)), {
    routes: { high: { model: 'sonnet', effort: 'low' } },
    policy: { downgradeHorizonTurns: 10 },
  });
  await press(h, 'undo');
  assert.deepEqual(JSON.parse(h.files.get(CONFIG)), {
    routes: { high: { model: 'sonnet' } },
    policy: { downgradeHorizonTurns: 3 },
  });
});

test('after an Undo, a pending draft compares against the restored values, so picking an undone value again saves', async () => {
  const h = harness();
  await start(h);
  await press(h, 'tab-routes');
  await press(h, 'tab-policy');
  await press(h, 'cashCapUsd', '5');
  await press(h, 'tab-routes');
  await press(h, 'cell-tier-high');
  await press(h, 'route-high-model', 'sonnet');
  await press(h, 'save-routing');
  await press(h, 'tab-policy');
  await press(h, 'downgradeVotes', '3');
  await press(h, 'tab-routes');
  await press(h, 'cell-tier-micro');
  await press(h, 'route-micro-model', 'sonnet');
  await press(h, 'undo');
  assert.deepEqual(JSON.parse(h.files.get(CONFIG)), {});
  await press(h, 'cell-tier-high');
  assert.equal(controls(await h.render()).find((node) => node.key === 'route-high-model').value, 'opus');
  await press(h, 'tab-policy');
  await press(h, 'cashCapUsd', '5');
  await press(h, 'tab-routes');
  await press(h, 'cell-tier-high');
  await press(h, 'route-high-model', 'sonnet');
  await press(h, 'save-routing');
  assert.deepEqual(JSON.parse(h.files.get(CONFIG)), {
    routes: { micro: { model: 'sonnet', effort: 'medium' }, high: { model: 'sonnet', effort: 'xhigh' } },
    policy: { downgradeVotes: 3, cashCapUsd: 5 },
  });
});

test('the pane opens without the last notice and keeps Undo for the last write', async () => {
  const h = harness();
  await start(h);
  await press(h, 'tab-classifier');
  await press(h, 'timeoutMs', '500');
  assert.match(h.view().notice, /^Saved:/);
  await h.event('command.run', { command: 'router', args: '' });
  assert.equal(h.view().notice, null);
  const pane = await h.render();
  assert.ok(texts(pane).some((line) => /^Last change: Jev deadline 1500 → 500 ms/.test(line)));
  assert.ok(controls(pane).some((node) => node.key === 'undo'));
});

test('a reset notice counts only its own section', async () => {
  const h = harness();
  await start(h);
  await press(h, 'tab-routes');
  await press(h, 'tab-routes');
  await press(h, 'cell-tier-medium');
  await press(h, 'route-medium-model', 'sonnet');
  await press(h, 'tab-policy');
  await press(h, 'reset-policy');
  assert.equal(h.view().notice, 'Policy already at defaults.');
  await press(h, 'discard-routing');
  await press(h, 'tab-policy');
  await press(h, 'horizon', '10');
  await press(h, 'tab-routes');
  await press(h, 'reset-routes');
  assert.equal(h.view().notice, 'Routes already at defaults.');
});

test('Reset policy after an Undo compares against the saved values, not an older draft', async () => {
  const h = harness();
  h.files.set(CONFIG, JSON.stringify({ policy: { cashCapUsd: 5 } }));
  await start(h);
  await press(h, 'tab-routes');
  await press(h, 'tab-policy');
  await press(h, 'cashCapUsd', '2');
  await press(h, 'save-routing');
  await press(h, 'tab-policy');
  await press(h, 'horizon', '10');
  await press(h, 'undo');
  assert.deepEqual(JSON.parse(h.files.get(CONFIG)), { policy: { cashCapUsd: 5 } });
  await press(h, 'tab-policy');
  await press(h, 'reset-policy');
  assert.match(h.view().notice, /^Policy defaults loaded/);
  await press(h, 'save-routing');
  assert.deepEqual(JSON.parse(h.files.get(CONFIG)), {});
});

test('policy defaults load as a draft and Save removes the overrides', async () => {
  const h = harness();
  h.files.set(CONFIG, JSON.stringify({ policy: { downgradeVotes: 3, cashCapUsd: 5, upgradeVotes: 3 } }));
  await start(h);
  await press(h, 'tab-routes');
  await press(h, 'tab-policy');
  await press(h, 'reset-policy');
  assert.equal(JSON.parse(h.files.get(CONFIG)).policy.downgradeVotes, 3);
  await press(h, 'save-routing');
  assert.deepEqual(JSON.parse(h.files.get(CONFIG)), { policy: { upgradeVotes: 3 } });
  await press(h, 'tab-policy');
  await press(h, 'reset-policy');
  assert.equal(h.view().notice, 'Policy already at defaults.');
  assert.equal(
    controls(await h.render()).find((node) => node.key === 'save-routing'),
    undefined,
  );
});

test('an unsaved routing draft shows on every tab, Discard drops it, and a new session clears it', async () => {
  const h = harness();
  await start(h);
  await press(h, 'tab-routes');
  await press(h, 'tab-routes');
  await press(h, 'cell-tier-medium');
  await press(h, 'route-medium-model', 'sonnet');
  await press(h, 'tab-classifier');
  let pane = await h.render();
  assert.equal(controls(pane).find((node) => node.key === 'tab-routes').label, 'Routes ●');
  assert.ok(texts(pane).includes('● 1 unsaved routing change  '));
  assert.ok(controls(pane).some((node) => node.key === 'save-routing'));
  await press(h, 'discard-routing');
  pane = await h.render();
  assert.equal(controls(pane).find((node) => node.key === 'tab-routes').label, 'Routes');
  assert.equal(
    controls(pane).find((node) => node.key === 'save-routing'),
    undefined,
  );
  await press(h, 'tab-routes');
  await press(h, 'tab-policy');
  await press(h, 'baseline', 'medium');
  await h.event('session.start', { cwd: '/fixture' });
  assert.equal(h.view().routeDraft, null);
});

test('Manual mode shows no pin buttons', async () => {
  const h = harness();
  await start(h);
  assert.ok(controls(await h.render()).some((node) => node.key === 'pin-high'));
  await press(h, 'manual');
  const pane = await h.render();
  assert.ok(!controls(pane).some((node) => node.key.startsWith('pin-')));
  assert.ok(texts(pane).includes('needs routing on (o above)'));
});

test('a classifier row switches at once, Undo from any tab returns to the previous one, and a switch clears the old health', async () => {
  const h = harness({ typesafe_api_key: 'synthetic-key', ...CLOUDFLARE_KEYS });
  h.http(async () => ({ ok: false, status: 401, text: '', headers: {} }));
  await start(h);
  await drain(h.step(step));
  assert.equal(h.view().health.failures, 1);
  await press(h, 'tab-classifier');
  await press(h, 'classifier-clef-flash');
  assert.deepEqual(JSON.parse(h.files.get(CONFIG)), { classifier: 'clef-flash' });
  assert.deepEqual(h.view().health, { failures: 0, pausedUntil: 0, classifier: 'clef-flash' });
  let pane = await h.render();
  assert.equal(controls(pane).find((node) => node.key === 'classifier-clef-flash').label, '◉ Clef Flash');
  assert.equal(controls(pane).find((node) => node.key === 'classifier-jev').label, '○ Jev       ');
  assert.equal(controls(pane).find((node) => node.key === 'timeoutMs').value, '3000');
  assert.ok(
    texts(pane).some((line) => /^Saved: classifier Jev → Clef Flash\. Applies from the next turn\./.test(line)),
  );
  assert.ok(texts(pane).includes('prompt + 6 recent turns → api.cloudflare.com'));
  await press(h, 'tab-now');
  await press(h, 'undo');
  assert.deepEqual(JSON.parse(h.files.get(CONFIG)), {});
  assert.equal(h.view().notice, 'Undid: classifier Jev → Clef Flash.');
  await press(h, 'tab-classifier');
  pane = await h.render();
  assert.equal(
    controls(pane).find((node) => node.key === 'undo'),
    undefined,
  );
  assert.equal(controls(pane).find((node) => node.key === 'timeoutMs').value, '1500');
  await press(h, 'classifier-clef-flash');
  const calls = [];
  h.http(async (url) => {
    calls.push(url);
    return { ok: true, status: 200, text: CLEF_FLASH_ANSWER, headers: {} };
  });
  await h.event('turn.start', { turnId: 't2', text: 'Rename x.' });
  await drain(h.step({ ...step, turnId: 't2' }));
  assert.match(calls[0], /clef-flash$/);
  await press(h, 'tab-now');
  assert.equal(h.view().lastWrite.label, 'classifier Jev → Clef Flash');
});

test('the deadline saves at once for the active classifier and its default is written as nothing', async () => {
  const h = harness();
  await start(h);
  await press(h, 'tab-classifier');
  await press(h, 'classifier-clef');
  await press(h, 'timeoutMs', '1500');
  assert.deepEqual(JSON.parse(h.files.get(CONFIG)), { classifier: 'clef', classifiers: { clef: { timeoutMs: 1500 } } });
  assert.match(h.view().notice, /^Saved: Clef deadline 3000 → 1500 ms\./);
  await press(h, 'timeoutMs', '3000');
  assert.deepEqual(JSON.parse(h.files.get(CONFIG)), { classifier: 'clef' });
});

test('a new session keeps classifier health only while the classifier is the same', async () => {
  const h = harness({ typesafe_api_key: 'synthetic-key', ...CLOUDFLARE_KEYS });
  h.http(async () => ({ ok: false, status: 401, text: '', headers: {} }));
  await start(h);
  await drain(h.step(step));
  await h.event('session.start', { cwd: '/fixture' });
  assert.equal(h.view().health.failures, 1);
  h.files.set(CONFIG, JSON.stringify({ classifier: 'clef' }));
  await h.event('session.start', { cwd: '/fixture' });
  assert.deepEqual(h.view().health, { failures: 0, pausedUntil: 0, classifier: 'clef' });
  assert.equal(h.view().adviceMs, null);
});

test('a switch clears the previous classifier readings, so no label claims them', async () => {
  const h = harness({ typesafe_api_key: 'synthetic-key', ...CLOUDFLARE_KEYS });
  h.http(async () => ({
    ok: true,
    status: 200,
    text: JSON.stringify(jevResponse('high', { micro: 0, low: 0.05, medium: 0.05, high: 0.9, uncertain: 0 })),
    headers: {},
  }));
  await start(h);
  await drain(h.step(step));
  assert.equal(h.view().probabilities.high, 0.9);
  await press(h, 'tab-classifier');
  await press(h, 'classifier-clef');
  for (const field of ['adviceMs', 'adviceChoice', 'probabilities', 'estimate', 'error'])
    assert.equal(h.view()[field], null, field);
  await press(h, 'tab-now');
  const pane = await h.render();
  assert.ok(texts(pane).some((line) => /^Clef ready/.test(line)));
  assert.ok(!texts(pane).some((line) => /Clef gave/.test(line)));
  const pins = controls(pane).filter((c) => c.key.startsWith('pin-'));
  assert.deepEqual(
    pins.map((c) => c.label),
    ['▶ high —', 'medium —', 'low —', 'micro —'],
  );
});

test('a turn classified when the switch lands keeps its route, and its answer touches neither health nor status', async () => {
  const h = harness({ typesafe_api_key: 'synthetic-key', ...CLOUDFLARE_KEYS });
  // Activity routing off: Sonnet runs no route, so the policy route differs from the engine model.
  h.files.set(CONFIG, JSON.stringify({ routes: { low: { model: 'opus' } }, activityRouting: 'off' }));
  h.model('claude-sonnet-5-5');
  let release;
  h.http(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await start(h);
  await h.event('command.run', { command: 'router', args: 'auto' });
  const turn = drain(h.step({ ...step, model: 'claude-sonnet-5-5' }));
  for (let i = 0; i < 20 && !release; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(release, 'the Jev request is in flight');
  await press(h, 'tab-classifier');
  await press(h, 'classifier-clef-flash');
  release({ ok: false, status: 401, text: '', headers: {} });
  await turn;
  assert.equal(h.requests[0].model, 'claude-opus-5-5', 'the policy route, not the engine model');
  assert.notEqual(h.view().reason, 'manual');
  assert.deepEqual(JSON.parse(h.files.get(CONFIG)).classifier, 'clef-flash');
  assert.deepEqual(h.view().health, { failures: 0, pausedUntil: 0, classifier: 'clef-flash' });
  assert.equal(h.view().error, null);
});

test('a pane save that adopts a hand-edited classifier starts it clean', async () => {
  const h = harness({ typesafe_api_key: 'synthetic-key', ...CLOUDFLARE_KEYS });
  h.http(async () => ({ ok: false, status: 401, text: '', headers: {} }));
  await start(h);
  await drain(h.step(step));
  assert.equal(h.view().health.failures, 1);
  h.files.set(CONFIG, JSON.stringify({ classifier: 'clef' }));
  await press(h, 'tab-routes');
  await press(h, 'tab-policy');
  await press(h, 'horizon', '10');
  await press(h, 'save-routing');
  assert.deepEqual(JSON.parse(h.files.get(CONFIG)), { classifier: 'clef', policy: { downgradeHorizonTurns: 10 } });
  assert.deepEqual(h.view().health, { failures: 0, pausedUntil: 0, classifier: 'clef' });
  assert.equal(h.view().error, null);
  assert.equal(h.view().adviceMs, null);
});

test('a classifier switch while routing is unavailable keeps the unavailable reason', async () => {
  const h = harness();
  h.version('2.1.200');
  await start(h);
  const reason = h.view().error;
  assert.equal(h.view().phase, 'unavailable');
  await press(h, 'tab-classifier');
  await press(h, 'classifier-clef');
  assert.deepEqual(JSON.parse(h.files.get(CONFIG)), { classifier: 'clef' });
  assert.equal(h.view().error, reason);
});

test('a classifier switch that cannot write leaves the classifier and router.json unchanged', async () => {
  const h = harness();
  h.files.set(CONFIG, '{}');
  h.links.add(CONFIG);
  await start(h);
  await press(h, 'tab-classifier');
  await press(h, 'classifier-clef');
  assert.match(h.view().notice, /Not saved: router\.json is a symlink/);
  assert.equal(h.files.get(CONFIG), '{}');
  assert.equal(controls(await h.render()).find((node) => node.key === 'classifier-jev').label, '◉ Jev       ');
  assert.ok(texts(await h.render()).some((line) => /^Jev: no API key/.test(line)));
});

test('two presses on one drawn pane open and close help again', async () => {
  const h = harness();
  await start(h);
  const help = controls(await h.render()).find((node) => node.key === 'help');
  await help.onPress();
  await help.onPress();
  assert.equal(h.view().help, false);
});

test('activity edits join the routing draft: Save writes them with the mode, and Undo removes them', async () => {
  const h = harness();
  await start(h);
  await press(h, 'tab-routes');
  await press(h, 'activity-mode', 'off');
  await press(h, 'tab-routes');
  await press(h, 'cell-code-low');
  await press(h, 'activity-code-low-model', 'opus');
  await press(h, 'tab-routes');
  await press(h, 'cell-ops-medium');
  await press(h, 'activity-tier-ops-medium');
  await press(h, 'tab-routes');
  await press(h, 'cell-review-high');
  await press(h, 'activity-review-high-effort', 'max');
  await press(h, 'save-routing');
  assert.match(h.view().notice, /^Saved: 4 routing changes\./);
  assert.deepEqual(JSON.parse(h.files.get(CONFIG)), {
    activities: {
      code: { low: { model: 'opus', effort: 'high' } },
      review: { high: { model: 'opus', effort: 'max' } },
      ops: { medium: { model: 'opus', effort: 'medium' } },
    },
    activityRouting: 'off',
  });
  assert.equal(h.view().routeDraft, null);
  await press(h, 'undo');
  assert.deepEqual(JSON.parse(h.files.get(CONFIG)), {});
});

test('a pending activity edit survives another pane write and saves later', async () => {
  const h = harness();
  await start(h);
  await press(h, 'tab-routes');
  await press(h, 'tab-routes');
  await press(h, 'cell-code-low');
  await press(h, 'activity-code-low-model', 'opus');
  await press(h, 'tab-classifier');
  await press(h, 'timeoutMs', '500');
  assert.deepEqual(h.view().routeDraft.activities.code.low, { model: 'opus', effort: 'high' });
  await press(h, 'tab-routes');
  await press(h, 'save-routing');
  assert.deepEqual(JSON.parse(h.files.get(CONFIG)), {
    classifiers: { jev: { timeoutMs: 500 } },
    activities: { code: { low: { model: 'opus', effort: 'high' } } },
  });
});

test('Delete history clears usage, activity and subagent records, the session counts and the saved ones', async () => {
  const h = harness({ typesafe_api_key: 'synthetic-key' });
  h.http(async () => ({
    ok: true,
    status: 200,
    headers: {},
    text: JSON.stringify(
      jevResponse('low', { micro: 0, low: 0.95, medium: 0.05, high: 0, uncertain: 0 }, 0, { code: 0.9, ops: 0.1 }),
    ),
  }));
  await start(h);
  await drain(h.step(step));
  await h.event('turn.complete', { turnId: 't1' });
  assert.equal(h.view().activityStats.byActivity.code.turns, 1);
  assert.deepEqual(h.preferences.get('activity:stats:v1:s1').confusion, { code: { talk: 1 } });
  h.preferences.set('activity:stats:v1:s0', h.preferences.get('activity:stats:v1:s1'));
  h.preferences.set('activity:stats:v1', {
    version: 1,
    confusion: { ops: { ops: 2 } },
    runs: {},
    lateral: { taken: 1, refused: 0 },
  });
  assert.deepEqual(h.view().activityStore.confusion, { code: { talk: 1 } });
  assert.equal(h.view().savings.replies, 1);
  assert.equal(summarize(readUsage(h.preferences.get('usage:v1:s1')), { from: null, to: null }).replies, 1);
  assert.equal(h.preferences.get('savings:v1:s1'), undefined);
  assert.ok(h.preferences.get('activity:metrics:v1:s1').latency.jev);
  h.preferences.set('activity:metrics:v1:s0', h.preferences.get('activity:metrics:v1:s1'));
  h.preferences.set('usage:v1:s0', h.preferences.get('usage:v1:s1'));
  h.preferences.set('savings:v1:s0', {
    version: 1,
    since: 1,
    replies: 4,
    routedUsd: 1,
    yoursUsd: 2,
    cheaperUsd: -1,
    strongerUsd: 0,
    switchUsd: 0,
  });
  await press(h, 'tab-usage');
  await press(h, 'delete-history');
  await press(h, 'delete-confirm');
  assert.equal(h.view().activityStats, null);
  assert.equal(h.view().savings, null);
  assert.deepEqual(h.view().activityStore, emptyStore());
  assert.equal(h.view().savingsStore.replies, 0);
  assert.deepEqual([h.view().usageStore.days, h.view().usageSession.days, h.view().confirmDelete], [{}, {}, false]);
  assert.deepEqual(
    [...h.preferences.keys()].filter((key) => key.startsWith('savings:') || key.startsWith('usage:v1:')),
    ['savings:reset:v1'],
  );
  assert.ok(Number.isFinite(h.preferences.get('savings:reset:v1')));
  assert.equal(h.view().notice, 'History deleted: usage, activity and subagent records of every session.');
  await press(h, 'tab-classifier');
  assert.ok(!texts(await h.render()).includes('ACROSS SESSIONS · since the last reset'));
  assert.deepEqual(
    [...h.preferences.keys()].filter((key) => key.startsWith('activity:')),
    [],
  );
  assert.deepEqual(h.view().activityMetrics, {
    version: 1,
    since: null,
    latency: {},
    downMoves: { moves: 0, escalations: 0 },
  });
});

test('opening the pane reloads the counts another session added', async () => {
  const h = harness();
  await start(h);
  assert.equal(h.view().activityStore.lateral.taken, 0);
  h.preferences.set('activity:stats:v1', {
    version: 1,
    confusion: { ops: { ops: 3 } },
    runs: {},
    lateral: { taken: 2, refused: 0 },
  });
  h.preferences.set('activity:stats:v1:s0', {
    version: 1,
    since: 1,
    confusion: { code: { code: 1 } },
    runs: {},
    lateral: { taken: 1, refused: 0 },
  });
  await h.event('command.run', { command: 'router', args: '' });
  assert.equal(h.view().activityStore.lateral.taken, 3);
  await press(h, 'tab-classifier');
  const lines = texts(await h.render());
  assert.ok(lines.includes('Agreement  classifier vs tools: 4 of 4 turns (100%)'));
  assert.ok(lines.includes('Code/ops/explore  classifier vs tools: 4 of 4 turns (100%)'));
});

test('Delete history during a turn completion is not undone by that turn', async () => {
  const RESET = 'savings:reset:v1';
  const earlier = {
    version: 1,
    since: 1,
    confusion: { code: { code: 4 } },
    runs: {},
    lateral: { taken: 2, refused: 1 },
  };
  let gate = null;
  const preferences = new (class extends Map {
    get(key) {
      if (key !== RESET || !gate) return super.get(key);
      // The turn reads the marker once per record it writes, and may read it for several at once.
      const { promise, resolve } = Promise.withResolvers();
      gate.waiting.push(resolve);
      gate.reached();
      return promise;
    }
  })([['activity:stats:v1:s1', earlier]]);
  const h = harness({ typesafe_api_key: 'synthetic-key' }, preferences);
  h.http(async () => ({
    ok: true,
    status: 200,
    headers: {},
    text: JSON.stringify(
      jevResponse('low', { micro: 0, low: 0.95, medium: 0.05, high: 0, uncertain: 0 }, 0, { code: 0.9, ops: 0.1 }),
    ),
  }));
  await start(h);
  await drain(h.step(step));
  const reached = Promise.withResolvers();
  gate = { reached: reached.resolve, waiting: [] };
  const completing = h.event('turn.complete', { turnId: 't1' });
  await reached.promise;
  const read = gate;
  await press(h, 'tab-usage');
  gate = null;
  await press(h, 'delete-history');
  await press(h, 'delete-confirm');
  // The marker as the turn read it, before the reset wrote it.
  for (const resolve of read.waiting) resolve(undefined);
  await completing;
  assert.equal(h.view().notice, 'History deleted: usage, activity and subagent records of every session.');
  assert.deepEqual(savedCounts(h.preferences), {
    version: 1,
    confusion: {},
    runs: {},
    lateral: { taken: 0, refused: 0 },
  });
  assert.deepEqual(h.view().activityStore, emptyStore());
});

test('Delete history while a turn writes its counts leaves the readout empty', async () => {
  const STORE = 'activity:stats:v1:s1';
  let gate = null;
  const preferences = new (class extends Map {
    set(key, value) {
      super.set(key, value);
      if (key !== STORE || !gate) return this;
      const { promise, resolve } = Promise.withResolvers();
      gate.resolve = resolve;
      gate.reached();
      return promise;
    }
  })();
  const h = harness({ typesafe_api_key: 'synthetic-key' }, preferences);
  h.http(async () => ({
    ok: true,
    status: 200,
    headers: {},
    text: JSON.stringify(
      jevResponse('low', { micro: 0, low: 0.95, medium: 0.05, high: 0, uncertain: 0 }, 0, { code: 0.9, ops: 0.1 }),
    ),
  }));
  await start(h);
  await drain(h.step(step));
  const reached = Promise.withResolvers();
  gate = { reached: reached.resolve };
  const completing = h.event('turn.complete', { turnId: 't1' });
  await reached.promise;
  const write = gate;
  gate = null;
  await press(h, 'tab-usage');
  await press(h, 'delete-history');
  await press(h, 'delete-confirm');
  write.resolve();
  await completing;
  assert.equal(h.preferences.get(STORE), undefined);
  assert.equal(h.preferences.get('activity:metrics:v1:s1'), undefined);
  assert.deepEqual(h.view().activityMetrics.latency, {});
  assert.deepEqual(h.view().activityStore, emptyStore());
  await press(h, 'tab-classifier');
  assert.ok(!texts(await h.render()).includes('ACROSS SESSIONS · since the last reset'));
});

test('a 1.6 removal of a cell 1.7 no longer overrides shows as no effect, and remove drops it from router.json', async () => {
  const h = harness();
  h.files.set(CONFIG, JSON.stringify({ activities: { docs: { low: { model: 'haiku', effort: 'high' } } } }));
  await start(h);
  await press(h, 'tab-routes');
  await press(h, 'cell-docs-low');
  assert.ok(texts(await h.render()).includes('same as the tier’s model: no effect'));
  await press(h, 'activity-tier-docs-low');
  await press(h, 'save-routing');
  assert.deepEqual(JSON.parse(h.files.get(CONFIG)), {});
  const pane = await h.render();
  assert.ok(texts(pane).includes('runs the tier’s model'));
  assert.ok(!controls(pane).some((c) => c.key === 'activity-tier-docs-low'));
});

test('Reset routes keeps pending activity edits and the mode', async () => {
  const h = harness();
  await start(h);
  await press(h, 'tab-routes');
  await press(h, 'activity-mode', 'off');
  await press(h, 'tab-routes');
  await press(h, 'cell-code-low');
  await press(h, 'activity-code-low-model', 'opus');
  await press(h, 'reset-routes');
  assert.equal(h.view().notice, 'Routes already at defaults.');
  await press(h, 'save-routing');
  assert.deepEqual(JSON.parse(h.files.get(CONFIG)), {
    activities: { code: { low: { model: 'opus', effort: 'high' } } },
    activityRouting: 'off',
  });
});

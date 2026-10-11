import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseAnswers } from '../lib/classifier-apis.mjs';
import { ClassifierClient } from '../lib/classifier-client.mjs';
import { ACTIVITY_STEP_MIN_MS, RETRY_DELAY_MS } from '../lib/classifier-contract.mjs';
import { DEFAULTS, loadConfig } from '../lib/config.mjs';
import { jevResponse } from './helpers.mjs';

const answer = jevResponse('medium', { micro: 0, low: 0, medium: 0.9, high: 0.1, uncertain: 0 });
const FILLED_ENDPOINT = 'https://classifier.test/v1/resolved';
const ok = () => ({ ok: true, status: 200, text: JSON.stringify(answer), headers: {} });
const flush = async () => {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
};

function clock() {
  let now = 0;
  const timers = new Set();
  const sleep = (ms, { signal } = {}) =>
    new Promise((resolve, reject) => {
      const timer = {
        at: now + ms,
        resolve: () => {
          timers.delete(timer);
          resolve();
        },
      };
      const abort = () => {
        timers.delete(timer);
        reject(new Error('aborted'));
      };
      if (signal?.aborted) return abort();
      signal?.addEventListener('abort', abort, { once: true });
      timers.add(timer);
    });
  return {
    now: () => now,
    sleep,
    advance: async (ms) => {
      now += ms;
      for (const timer of [...timers]) if (timer.at <= now) timer.resolve();
      await flush();
    },
  };
}

function input(timing, request) {
  return {
    request,
    sleep: timing.sleep,
    config: DEFAULTS,
    apiKey: 'synthetic-test-key',
    endpoint: FILLED_ENDPOINT,
    prompt: 'One small edit.',
    turns: [],
  };
}

test('a keyless classifier sends no credential and reads its local answer', async () => {
  const timing = clock();
  const ollama = new ClassifierClient({ now: timing.now });
  const local = readFileSync(new URL('./fixtures/ollama-route-response.json', import.meta.url), 'utf8');
  const result = await ollama.ask({
    ...input(timing, async (url, init) => {
      assert.equal(url, FILLED_ENDPOINT);
      assert.equal(Object.hasOwn(init.headers, 'authorization'), false);
      assert.equal(JSON.parse(init.body).think, false);
      return { ok: true, status: 200, text: local, headers: {} };
    }),
    config: loadConfig({ userFile: { classifier: 'ollama' } }),
    apiKey: null,
  });
  assert.equal(result.error, null);
  assert.equal(result.advice.choice, 'medium');
});

test('native Jev sends the shared contract and reads text and plain headers', async () => {
  const timing = clock();
  const jev = new ClassifierClient({ now: timing.now });
  const result = await jev.ask(
    input(timing, async (url, init) => {
      assert.equal(url, FILLED_ENDPOINT);
      assert.equal(init.headers.authorization, 'Bearer synthetic-test-key');
      assert.equal(JSON.parse(init.body).state.currentRequest.text, 'One small edit.');
      assert.equal(Object.hasOwn(init, 'signal'), false);
      return ok();
    }),
  );
  assert.equal(result.error, null);
  assert.equal(result.advice.choice, 'medium');
});

test('the deadline is the active classifier deadline', async () => {
  for (const id of Object.keys(DEFAULTS.classifiers)) {
    const timing = clock();
    const jev = new ClassifierClient({ now: timing.now });
    const config = { ...DEFAULTS, classifier: id };
    const pending = jev.ask({ ...input(timing, () => new Promise(() => {})), config });
    await flush();
    await timing.advance(DEFAULTS.classifiers[id].timeoutMs - 1);
    assert.equal(jev.active, true, id);
    await timing.advance(1);
    assert.equal((await pending).error, 'timeout', id);
  }
});

test('a timed-out request occupies the slot until settlement, and its late success changes no health', async () => {
  const timing = clock();
  const jev = new ClassifierClient({ now: timing.now });
  let finish;
  let requests = 0;
  const request = () => {
    requests += 1;
    return new Promise((resolve) => {
      finish = resolve;
    });
  };
  const pending = jev.ask(input(timing, request));
  await flush();
  await timing.advance(1500);
  assert.equal((await pending).error, 'timeout');
  for (let i = 0; i < 20; i += 1) assert.equal((await jev.ask(input(timing, request))).error, 'busy');
  assert.equal(requests, 1);
  assert.equal(jev.snapshot().failures, 1);
  finish(ok());
  await flush();
  assert.equal(jev.snapshot().failures, 1);
  assert.equal((await jev.ask(input(timing, async () => ok()))).error, null);
  assert.equal(jev.snapshot().failures, 0);
});

test('native retry uses Retry-After inside the same total deadline', async () => {
  const timing = clock();
  const jev = new ClassifierClient({ now: timing.now });
  let requests = 0;
  const pending = jev.ask(
    input(timing, async () =>
      ++requests === 1 ? { ok: false, status: 503, text: '', headers: { 'retry-after': '0.2' } } : ok(),
    ),
  );
  await flush();
  await timing.advance(199);
  assert.equal(requests, 1);
  await timing.advance(1);
  assert.equal((await pending).error, null);
  assert.equal(requests, 2);
});

test('the admission slot stays occupied during retry backoff', async () => {
  const timing = clock();
  const jev = new ClassifierClient({ now: timing.now });
  let requests = 0;
  const args = input(timing, async () => (++requests === 1 ? { ok: false, status: 503, headers: {} } : ok()));
  const pending = jev.ask(args);
  await flush();
  assert.equal((await jev.ask(args)).error, 'busy');
  assert.equal(requests, 1);
  await timing.advance(100);
  assert.equal((await pending).error, null);
  assert.equal(requests, 2);
});

test('retry beyond the remaining budget is not sent', async () => {
  const timing = clock();
  const jev = new ClassifierClient({ now: timing.now });
  let requests = 0;
  const result = await jev.ask(
    input(timing, async () => {
      requests += 1;
      return { ok: false, status: 503, headers: { 'retry-after': '10' } };
    }),
  );
  assert.equal(result.error, 'timeout');
  assert.equal(requests, 1);
});

test('abort does not count as an outage or allow an overlapping request', async () => {
  const timing = clock();
  const jev = new ClassifierClient({ now: timing.now });
  let finish;
  const args = input(
    timing,
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const controller = new AbortController();
  const pending = jev.ask({ ...args, signal: controller.signal });
  await flush();
  controller.abort();
  assert.equal((await pending).error, 'cancelled');
  assert.equal(jev.snapshot().failures, 0);
  assert.equal((await jev.ask(args)).error, 'busy');
  finish(ok());
  await flush();
});

test('three failed attempts pause Jev, then one success resumes it', async () => {
  const timing = clock();
  const jev = new ClassifierClient({ now: timing.now });
  let requests = 0;
  const failed = input(timing, async () => {
    requests += 1;
    return { ok: false, status: 401 };
  });
  for (let i = 0; i < 3; i += 1) assert.equal((await jev.ask(failed)).error, 'auth');
  assert.equal((await jev.ask(failed)).error, 'paused');
  assert.equal(requests, 3);
  await timing.advance(60_000);
  assert.equal((await jev.ask(input(timing, async () => ok()))).error, null);
  assert.deepEqual(jev.snapshot(), { failures: 0, pausedUntil: 0 });
});

test('missing credentials and policy refusal do not retry or count as provider outages', async () => {
  const timing = clock();
  const jev = new ClassifierClient({ now: timing.now });
  let calls = 0;
  const args = input(timing, async () => {
    calls += 1;
    throw new Error('Network access from plugins denied');
  });
  assert.equal((await jev.ask({ ...args, apiKey: null })).error, 'missing-key');
  assert.equal((await jev.ask({ ...args, endpoint: null })).error, 'missing-account');
  assert.equal((await jev.ask(args)).error, 'policy');
  assert.equal(calls, 1);
  assert.equal(jev.snapshot().failures, 0);
});

test('a refused connection is a transport failure: it retries and counts toward the breaker', async () => {
  const timing = clock();
  const jev = new ClassifierClient({ now: timing.now });
  let calls = 0;
  const pending = jev.ask(
    input(timing, async () => {
      calls += 1;
      throw new Error('connect ECONNREFUSED 127.0.0.1:443');
    }),
  );
  await flush();
  await timing.advance(RETRY_DELAY_MS);
  assert.equal((await pending).error, 'unreachable');
  assert.equal(calls, 2);
  assert.equal(jev.snapshot().failures, 1);
});

test('malformed responses reveal no provider text and invalid probability shapes fail at the contract boundary', async () => {
  const timing = clock();
  const jev = new ClassifierClient({ now: timing.now });
  for (const text of [
    'PRIVATE_PROMPT',
    JSON.stringify({ answers: { route: { type: 'choice', choice: 'PRIVATE_PROMPT', probabilities: {} } } }),
  ]) {
    const result = await jev.ask(input(timing, async () => ({ ...ok(), text })));
    assert.deepEqual(result, { advice: null, error: 'malformed' });
  }
  for (const probabilities of [null, []])
    assert.throws(
      () => parseAnswers(DEFAULTS, { answers: { route: { type: 'choice', choice: 'medium', probabilities } } }),
      /malformed/,
    );
});

const ollamaTimeout = DEFAULTS.classifiers.ollama.timeoutMs;
const localAnswer = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const routeAnswer = localAnswer('ollama-route-response.json');
const activityAnswer = localAnswer('ollama-activity-response.json');
const local = (text) => ({ ok: true, status: 200, text, headers: {} });
const never = () => new Promise(() => {});

// Ollama input whose route request answers at once and whose activity request is `step(body)`.
function ollamaInput(timing, step, activityRouting = 'on') {
  const bodies = [];
  const args = {
    ...input(timing, async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return bodies.length === 1 ? local(routeAnswer) : step();
    }),
    config: loadConfig({ userFile: { classifier: 'ollama', activityRouting } }),
    apiKey: null,
  };
  return { args, bodies };
}

test('Ollama asks the activity in a second request and returns both answers', async () => {
  const timing = clock();
  const client = new ClassifierClient({ now: timing.now });
  const { args, bodies } = ollamaInput(timing, async () => local(activityAnswer));
  const result = await client.ask(args);
  assert.equal(result.error, null);
  assert.equal(result.advice.choice, 'medium');
  assert.equal(result.advice.activity.choice, 'code');
  assert.equal(bodies.length, 2);
  assert.match(bodies[1].messages[1].content, /Which activity/);
});

test('with activity routing off Ollama sends one request and reads no activity', async () => {
  const timing = clock();
  const client = new ClassifierClient({ now: timing.now });
  const { args, bodies } = ollamaInput(timing, async () => local(activityAnswer), 'off');
  const result = await client.ask(args);
  assert.equal(result.advice.activity, null);
  assert.equal(bodies.length, 1);
});

test('an Ollama activity step that times out keeps the route advice, counts no failure, and holds the slot', async () => {
  const timing = clock();
  const client = new ClassifierClient({ now: timing.now });
  let finish;
  const { args } = ollamaInput(
    timing,
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = client.ask(args);
  await flush();
  await timing.advance(ollamaTimeout);
  const result = await pending;
  assert.equal(result.error, null);
  assert.equal(result.advice.choice, 'medium');
  assert.equal(result.advice.activity, null);
  assert.deepEqual(client.snapshot(), { failures: 0, pausedUntil: 0 });
  assert.equal((await client.ask(args)).error, 'busy');
  finish(local(activityAnswer));
  await flush();
  assert.equal((await client.ask(ollamaInput(timing, async () => local(activityAnswer)).args)).error, null);
});

for (const [name, step] of [
  ['a transport error', async () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:11434'))],
  ['an HTTP error', async () => ({ ok: false, status: 500, text: '', headers: {} })],
  ['text that is not JSON', async () => local('A')],
  ['an answer with no letters', async () => local(JSON.stringify({ logprobs: [{ top_logprobs: [] }] }))],
]) {
  test(`an Ollama activity step with ${name} reads as no activity, without a retry or a failure`, async () => {
    const timing = clock();
    const client = new ClassifierClient({ now: timing.now, health: { failures: 2 } });
    const { args, bodies } = ollamaInput(timing, step);
    const result = await client.ask(args);
    assert.equal(result.error, null);
    assert.equal(result.advice.choice, 'medium');
    assert.equal(result.advice.activity, null);
    assert.equal(bodies.length, 2);
    assert.equal(client.snapshot().failures, 0);
  });
}

for (const [left, asked] of [
  [ACTIVITY_STEP_MIN_MS - 1, false],
  [ACTIVITY_STEP_MIN_MS, true],
]) {
  test(`with ${left} ms of the deadline left the activity step is ${asked ? 'sent' : 'skipped'}`, async () => {
    const timing = clock();
    const client = new ClassifierClient({ now: timing.now });
    let requests = 0;
    const pending = client.ask({
      ...ollamaInput(timing).args,
      request: async () =>
        ++requests === 1 ? timing.sleep(ollamaTimeout - left).then(() => local(routeAnswer)) : local(activityAnswer),
    });
    await flush();
    await timing.advance(ollamaTimeout - left);
    const result = await pending;
    assert.equal(result.error, null);
    assert.equal(requests, asked ? 2 : 1);
    assert.equal(result.advice.activity?.choice ?? null, asked ? 'code' : null);
  });
}

test('abort during the Ollama activity step cancels and counts no failure', async () => {
  const timing = clock();
  const client = new ClassifierClient({ now: timing.now });
  const controller = new AbortController();
  const { args, bodies } = ollamaInput(timing, never);
  const pending = client.ask({ ...args, signal: controller.signal });
  await flush();
  assert.equal(bodies.length, 2);
  controller.abort();
  assert.deepEqual(await pending, { advice: null, error: 'cancelled' });
  assert.equal(client.snapshot().failures, 0);
});

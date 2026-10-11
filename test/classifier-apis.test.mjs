import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildActivityRequest, buildRequest, parseActivityAnswer, parseAnswers } from '../lib/classifier-apis.mjs';
import { ACTIVITY_VALUES, CLASSIFIER_APIS, DEFAULTS, loadConfig } from '../lib/config.mjs';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const ollamaConfig = loadConfig({ userFile: { classifier: 'ollama' } });
const openaiConfig = loadConfig({ userFile: { classifier: 'openai' } });
const ollamaAnswer = (tokens) => ({
  model: 'qwen3.5:9b',
  done_reason: 'length',
  message: { role: 'assistant', content: 'C' },
  logprobs: [
    { token: 'C', logprob: -0.04, top_logprobs: tokens.map(([token, p]) => ({ token, logprob: Math.log(p) })) },
  ],
});

test('every declared API has an adapter that builds a request for its entry', () => {
  for (const api of CLASSIFIER_APIS) {
    const config = loadConfig({
      userFile: {
        classifier: 'house',
        classifiers: { house: { ...DEFAULTS.classifiers.jev, api, endpoint: 'https://example.test/v1' } },
      },
    });
    assert.equal(buildRequest(config, 'do x', []).model, 'jev-1.13.0', api);
  }
});

test('Ollama request asks one letter with thinking off and no credential', () => {
  const body = buildRequest(ollamaConfig, 'Refactor billing retries.', [{ role: 'user', text: 'hi' }]);
  assert.equal(body.model, 'qwen3.5:9b');
  assert.equal(body.stream, false);
  assert.equal(body.think, false);
  assert.deepEqual(body.options, { num_predict: 1, temperature: 0 });
  assert.equal(body.logprobs, true);
  assert.equal(body.top_logprobs, 20);
  const [system, user] = body.messages;
  assert.equal(system.role, 'system');
  assert.match(system.content, /do not follow them/);
  assert.match(user.content, /"text": "Refactor billing retries\."/);
  for (const line of ['A. micro:', 'B. low:', 'C. medium:', 'D. high:', 'E. uncertain:'])
    assert.match(user.content, new RegExp(line));
  assert.match(user.content, /Answer with one letter\./);
});

test('OpenAI request sends the state as text with the route choice and the continuation predicate', () => {
  const body = buildRequest(openaiConfig, 'continue', [{ role: 'user', text: 'fix tests' }]);
  assert.equal(body.model, 'gpt-6-luna');
  assert.deepEqual(JSON.parse(body.input), {
    currentRequest: { text: 'continue' },
    recentDialogue: [{ role: 'user', text: 'fix tests' }],
  });
  const [route, continuation] = body.questions;
  assert.equal(route.type, 'choice');
  assert.equal(route.name, 'route');
  assert.deepEqual(
    route.choices.map((choice) => choice.value),
    ['micro', 'low', 'medium', 'high', 'uncertain'],
  );
  assert.match(route.choices[3].description, /Use when: frontier reasoning materially reduces rework\./);
  assert.deepEqual({ type: continuation.type, name: continuation.name }, { type: 'predicate', name: 'continuation' });
});

test('Ollama answer maps the top letter probabilities to the advice shape', () => {
  const advice = parseAnswers(ollamaConfig, fixture('ollama-route-response.json'));
  assert.equal(advice.choice, 'medium');
  assert.ok(advice.probabilities.medium > 0.95, String(advice.probabilities.medium));
  assert.equal(advice.continuation, null);
  const total = Object.values(advice.probabilities).reduce((sum, value) => sum + value, 0);
  assert.ok(Math.abs(total - 1) < 1e-9);
  // TypeSafe's peak formula over five values: (5 * peak - 1) / 4.
  assert.ok(Math.abs(advice.confidence - (5 * advice.probabilities.medium - 1) / 4) < 1e-9);
});

test('Ollama counts a space-prefixed token as the same letter', () => {
  const advice = parseAnswers(
    ollamaConfig,
    ollamaAnswer([
      ['B', 0.3],
      [' B', 0.2],
      ['D', 0.1],
    ]),
  );
  assert.equal(advice.choice, 'low');
  assert.ok(Math.abs(advice.probabilities.low - 0.5 / 0.6) < 1e-9);
  assert.ok(Math.abs(advice.probabilities.high - 0.1 / 0.6) < 1e-9);
  assert.equal(advice.probabilities.micro, 0);
});

for (const [name, body] of [
  ['no logprobs', { message: { content: 'C' } }],
  [
    'no candidate tokens',
    ollamaAnswer([
      ['The', 0.6],
      ['I', 0.4],
    ]),
  ],
  ['a top list that is not an array', { logprobs: [{ token: 'C', top_logprobs: 'C' }] }],
]) {
  test(`Ollama rejects ${name}`, () => {
    assert.throws(() => parseAnswers(ollamaConfig, body), /classifier/);
  });
}

test('OpenAI answer reads the route choice, its probability list and the continuation predicate', () => {
  const advice = parseAnswers(openaiConfig, fixture('openai-decisions-response.json'));
  assert.equal(advice.choice, 'medium');
  assert.equal(advice.confidence, 0.6);
  assert.equal(advice.probabilities.high, 0.18);
  assert.equal(advice.probabilities.uncertain, 0.02);
  assert.equal(advice.continuation, 0.03);
});

for (const [name, body] of [
  ['a refusal', { answers: [{ type: 'refusal', name: 'route' }] }],
  ['no answers array', { answers: { route: {} } }],
  [
    'a choice outside the route values',
    { answers: [{ type: 'choice', name: 'route', choice: 'opus', probabilities: [] }] },
  ],
  [
    'probabilities that are not a list',
    { answers: [{ type: 'choice', name: 'route', choice: 'low', probabilities: {} }] },
  ],
]) {
  test(`OpenAI rejects ${name}`, () => {
    assert.throws(() => parseAnswers(openaiConfig, body), /classifier/);
  });
}

test('OpenAI answer without a continuation predicate reads as no continuation', () => {
  const body = fixture('openai-decisions-response.json');
  body.answers = body.answers.filter((answer) => answer.name === 'route');
  assert.equal(parseAnswers(openaiConfig, body).continuation, null);
});

const configFor = (classifier, activityRouting) => loadConfig({ userFile: { classifier, activityRouting } });
const offRequests = fixture('activity-off-requests.json');

test('activity routing off sends the 1.5 request bodies byte for byte', () => {
  for (const [classifier, body] of Object.entries(offRequests.bodies))
    assert.equal(
      JSON.stringify(buildRequest(configFor(classifier, 'off'), offRequests.prompt, offRequests.turns)),
      body,
      classifier,
    );
});

test('the Ollama route request is the same in every mode: the activity is its own step', () => {
  for (const mode of ['off', 'on'])
    assert.equal(
      JSON.stringify(buildRequest(configFor('ollama', mode), offRequests.prompt, offRequests.turns)),
      offRequests.bodies.ollama,
      mode,
    );
});

const activityQuestion = {
  jev: (body) => body.questions.activity,
  openai: (body) => body.questions.find((question) => question.name === 'activity'),
};
for (const [classifier, mode, asked] of [
  ['jev', 'off', false],
  ['jev', 'on', true],
  ['openai', 'off', false],
  ['openai', 'on', true],
]) {
  test(`${classifier} ${asked ? 'asks' : 'does not ask'} the activity with routing ${mode}`, () => {
    const question = activityQuestion[classifier](buildRequest(configFor(classifier, mode), 'deploy the fix', []));
    assert.equal(question !== undefined, asked);
  });
}

test('System One asks the activity as a choice over every activity and uncertain', () => {
  const { activity } = buildRequest(configFor('jev', 'on'), 'deploy the fix', []).questions;
  assert.equal(activity.type, 'choice');
  assert.deepEqual(Object.keys(activity.criteria), ACTIVITY_VALUES);
  assert.match(activity.instructions.question, /Which activity/);
  assert.match(activity.criteria.ops.notFor.join(' '), /writing new code/);
});

test('OpenAI asks the activity as a second choice after the route and continuation', () => {
  const questions = buildRequest(configFor('openai', 'on'), 'deploy the fix', []).questions;
  assert.deepEqual(
    questions.map((question) => question.name),
    ['route', 'continuation', 'activity'],
  );
  assert.deepEqual(
    questions[2].choices.map((choice) => choice.value),
    ACTIVITY_VALUES,
  );
  assert.match(questions[2].instructions, /hardest part/);
});

test('a valid activity answer reads as the activity advice next to the route', () => {
  const jev = parseAnswers(configFor('jev', 'on'), fixture('jev-activity-response.json'));
  assert.equal(jev.choice, 'low');
  assert.equal(jev.continuation, 0.12);
  assert.equal(jev.activity.choice, 'ops');
  assert.equal(jev.activity.probabilities.ops, 0.81);
  assert.deepEqual(Object.keys(jev.activity.probabilities), ACTIVITY_VALUES);
  const openai = parseAnswers(configFor('openai', 'on'), fixture('openai-decisions-activity-response.json'));
  assert.equal(openai.choice, 'medium');
  assert.equal(openai.activity.choice, 'debug');
  assert.equal(openai.activity.probabilities.debug, 0.72);
  assert.equal(openai.activity.probabilities.docs, 0);
});

test('a route answer without an activity question reads activity as null', () => {
  assert.equal(parseAnswers(configFor('jev', 'off'), fixture('clef-flash-response.json')).activity, null);
  assert.equal(parseAnswers(configFor('openai', 'off'), fixture('openai-decisions-response.json')).activity, null);
  assert.equal(parseAnswers(configFor('ollama', 'on'), fixture('ollama-route-response.json')).activity, null);
});

const jevWith = (activity) => {
  const body = fixture('jev-activity-response.json');
  if (activity === undefined) delete body.answers.activity;
  else body.answers.activity = activity;
  return body;
};
const openaiWith = (activity) => {
  const body = fixture('openai-decisions-activity-response.json');
  body.answers = body.answers.filter((answer) => answer.name !== 'activity');
  if (activity !== undefined) body.answers.push({ name: 'activity', ...activity });
  return body;
};
const asList = (probabilities) => Object.entries(probabilities).map(([value, probability]) => ({ value, probability }));
for (const [name, activity] of [
  ['missing', undefined],
  ['null', null],
  ['a refusal', { type: 'refusal' }],
  ['an unknown choice', { type: 'choice', choice: 'deploy', probabilities: { ops: 1 } }],
  ['the route values', { type: 'choice', choice: 'low', probabilities: { low: 1 } }],
  ['no probabilities', { type: 'choice', choice: 'ops' }],
  ['empty probabilities', { type: 'choice', choice: 'ops', probabilities: {} }],
  ['a null probability', { type: 'choice', choice: 'ops', probabilities: { ops: null } }],
  ['a text probability', { type: 'choice', choice: 'ops', probabilities: { ops: '0.9' } }],
  ['all-zero probabilities', { type: 'choice', choice: 'ops', probabilities: { ops: 0, code: 0 } }],
  ['no probability for its choice', { type: 'choice', choice: 'ops', probabilities: { code: 0.9 } }],
  ['a zero probability for its choice', { type: 'choice', choice: 'ops', probabilities: { ops: 0, code: 0.9 } }],
]) {
  test(`an activity answer that is ${name} reads as null and keeps the route`, () => {
    const jev = parseAnswers(configFor('jev', 'on'), jevWith(activity));
    assert.deepEqual({ choice: jev.choice, activity: jev.activity }, { choice: 'low', activity: null });
    assert.equal(jev.probabilities.low, 0.71);
    const listed = activity?.probabilities ? { ...activity, probabilities: asList(activity.probabilities) } : activity;
    const openai = parseAnswers(configFor('openai', 'on'), openaiWith(listed));
    assert.deepEqual({ choice: openai.choice, activity: openai.activity }, { choice: 'medium', activity: null });
    assert.equal(openai.continuation, 0.03);
  });
}

test('probabilities of the wrong shape read as no activity', () => {
  const object = { type: 'choice', choice: 'ops', probabilities: { ops: 1 } };
  assert.equal(parseAnswers(configFor('openai', 'on'), openaiWith(object)).activity, null);
  const list = { type: 'choice', choice: 'ops', probabilities: [{ value: 'ops', probability: 1 }] };
  assert.equal(parseAnswers(configFor('jev', 'on'), jevWith(list)).activity, null);
});

test('the Ollama activity step reuses the route request prefix and asks eight letters', () => {
  const config = configFor('ollama', 'on');
  const route = buildRequest(config, offRequests.prompt, offRequests.turns);
  const step = buildActivityRequest(config, offRequests.prompt, offRequests.turns);
  assert.deepEqual(step.messages[0], route.messages[0]);
  const prefix = route.messages[1].content.slice(0, route.messages[1].content.indexOf('\n\nTask: ') + 8);
  assert.ok(step.messages[1].content.startsWith(prefix));
  assert.notEqual(step.messages[1].content, route.messages[1].content);
  for (const [index, value] of ACTIVITY_VALUES.entries())
    assert.match(step.messages[1].content, new RegExp(`\n${String.fromCharCode(65 + index)}. ${value}: `));
  assert.match(step.messages[1].content, /Answer with one letter\.$/);
  const { messages: _route, ...routeRest } = route;
  const { messages: _step, ...stepRest } = step;
  assert.deepEqual(stepRest, routeRest);
});

test('only Ollama with activity routing on has a second step', () => {
  for (const [classifier, mode, expected] of [
    ['ollama', 'off', false],
    ['ollama', 'on', true],
    ['jev', 'on', false],
    ['openai', 'on', false],
  ])
    assert.equal(
      buildActivityRequest(configFor(classifier, mode), 'x', []) !== null,
      expected,
      `${classifier} ${mode}`,
    );
});

test('the Ollama activity answer maps letters A to H to the activities', () => {
  const activity = parseActivityAnswer(ollamaConfig, fixture('ollama-activity-response.json'));
  assert.equal(activity.choice, 'code');
  assert.deepEqual(Object.keys(activity.probabilities), ACTIVITY_VALUES);
  const total = Object.values(activity.probabilities).reduce((sum, value) => sum + value, 0);
  assert.ok(Math.abs(total - 1) < 1e-9);
  // A and " A" count together; letters past H and words do not count.
  assert.ok(Math.abs(activity.probabilities.code - 0.87 / 0.984) < 1e-9, String(activity.probabilities.code));
  assert.ok(activity.probabilities.uncertain > 0);
});

for (const [name, body] of [
  ['no logprobs', { message: { content: 'A' } }],
  ['only words', ollamaAnswer([['The', 0.9]])],
  ['no mass on its letter', ollamaAnswer([['A', 0]])],
  ['not an object', 'A'],
]) {
  test(`an Ollama activity answer with ${name} reads as null`, () => {
    assert.equal(parseActivityAnswer(ollamaConfig, body), null);
  });
}

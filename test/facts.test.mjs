import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractFacts as factsFromRequest, observedActivity, promptIndex, verifiedSince } from '../lib/facts.mjs';
import { assistant, body, memory, toolResult, user } from './helpers.mjs';

const CONTEXT = { recentTurns: 4, maxTextChars: 30 };

const system = (text, extra = []) => ({ role: 'system', content: [{ type: 'text', text }, ...extra] });

test('a system message after the user message, where Claude Code 2.1.x puts hook output, does not hide the prompt', () => {
  const facts = factsFromRequest(
    body([user('fix the bug'), system('hook said x'), assistant('done'), user('now the tests'), system('hook')]),
    memory(),
    CONTEXT,
  );
  assert.equal(facts.prompt, 'now the tests');
  assert.equal(facts.continuation, false);
  assert.deepEqual(
    facts.turns.map((t) => [t.role, t.text]),
    [
      ['user', 'fix the bug'],
      ['assistant', 'done'],
    ],
  );
});

test('a trailing tool result is a continuation with no prompt, also behind a system message', () => {
  for (const [name, messages] of [
    ['tool result last', [user('run tests'), assistant('running', ['Bash']), toolResult('ok')]],
    [
      'system message after the tool result',
      [user('fix'), system('hook'), assistant('reading', ['Read']), toolResult('ok'), system('hook')],
    ],
  ]) {
    const facts = factsFromRequest(body(messages), memory(), CONTEXT);
    assert.equal(facts.continuation, true, name);
    assert.equal(facts.prompt, '', name);
  }
});

test('a new user turn yields the prompt without system reminders', () => {
  const b = body([
    user('fix the bug'),
    assistant('done'),
    {
      role: 'user',
      content: [
        { type: 'text', text: '<system-reminder>x</system-reminder>' },
        { type: 'text', text: 'now the tests' },
      ],
    },
  ]);
  const facts = factsFromRequest(b, memory(), CONTEXT);
  assert.equal(facts.prompt, 'now the tests');
  assert.equal(facts.continuation, false);
  assert.deepEqual(
    facts.turns.map((t) => t.role),
    ['user', 'assistant'],
  );
});

test('turns keep only the most recent ones, each clipped', () => {
  const messages = [];
  for (let i = 0; i < 10; i += 1) messages.push(user(`prompt ${i} ${'x'.repeat(80)}`), assistant(`answer ${i}`));
  const facts = factsFromRequest(body(messages), memory(), CONTEXT);
  assert.deepEqual(facts.turns, [
    { role: 'user', text: 'prompt 8 xxxx […] xxxxxxxxxxxx' },
    { role: 'assistant', text: 'answer 8' },
    { role: 'user', text: 'prompt 9 xxxx […] xxxxxxxxxxxx' },
    { role: 'assistant', text: 'answer 9' },
  ]);
});

test('repeated failure needs the same signature with an edit attempt between', () => {
  const same = body([
    user('go'),
    assistant('a', ['Bash']),
    toolResult('Error: test_login failed\n    at login (test/login.mjs:12:4)', { isError: true }),
    assistant('b', ['Edit']),
    toolResult('Error: test_login failed\n    at login (test/login.mjs:40:9)', { isError: true }),
  ]);
  const failure = factsFromRequest(same, memory(), CONTEXT).failure;
  assert.equal(failure.index, 4);
  assert.ok(failure.signature);
  const noEdit = body([
    user('go'),
    assistant('a', ['Bash']),
    toolResult('Error: x', { isError: true }),
    assistant('b'),
    toolResult('Error: x', { isError: true }),
  ]);
  assert.equal(factsFromRequest(noEdit, memory(), CONTEXT).failure, null);
});

test('failure matching uses the whole diagnostic without erasing test names or error values', () => {
  const header =
    '> @alexeiled/claude-router@1.10.0 test\n' +
    '> node --test --test-timeout=8000 test/*.test.mjs experiments/mod-router/scripts/*.test.mjs\n\n';
  const failure = (name, error) => `${header}not ok 1 - ${name}\n  error: '${error}'\n`;
  for (const [name, before, after, repeated] of [
    [
      'different tests after the npm header',
      failure('login', 'unauthorized'),
      failure('logout', 'unauthorized'),
      false,
    ],
    ['numeric test names', failure('case_1', 'unauthorized'), failure('case_2', 'unauthorized'), false],
    ['case-sensitive test names', failure('Login', 'unauthorized'), failure('login', 'unauthorized'), false],
    [
      'changed numeric error values',
      failure('login', 'expected 200, got 401'),
      failure('login', 'expected 200, got 403'),
      false,
    ],
    [
      'changed error after a long prefix',
      `${'common output '.repeat(100)}error: login`,
      `${'common output '.repeat(100)}error: logout`,
      false,
    ],
    ['different ports', 'Error: refused api.example.com:8080', 'Error: refused api.example.com:9090', false],
    ['test names containing line numbers', failure('line 1', 'unauthorized'), failure('line 2', 'unauthorized'), false],
    [
      'test names containing positions',
      failure('fails at line 12', 'unauthorized'),
      failure('fails at line 40', 'unauthorized'),
      false,
    ],
    [
      'error values containing positions',
      failure('login', 'expected at line 12'),
      failure('login', 'expected at line 40'),
      false,
    ],
    [
      'error values containing source positions',
      failure('login', 'expected file.js:12:4'),
      failure('login', 'expected file.js:40:9'),
      false,
    ],
    [
      'error values containing whitespace',
      failure('login', 'expected "a  b"'),
      failure('login', 'expected "a b"'),
      false,
    ],
    ['test names containing whitespace', failure('a  b', 'unauthorized'), failure('a b', 'unauthorized'), false],
    ['error values containing timings', 'Error: expected (12 ms)', 'Error: expected (45 ms)', false],
    ['same long diagnostic', failure('login', 'unauthorized'), failure('login', 'unauthorized'), true],
    ['empty errors', '', '', false],
    [
      'reminder-only errors',
      '<system-reminder>first</system-reminder>',
      '<system-reminder>second</system-reminder>',
      false,
    ],
    [
      'line numbers, stack positions and TAP timings',
      `${failure('login', 'unauthorized')}  at login (test/login.test.mjs:12:4)\n  location: 'test/login.test.mjs:12:4'\n  duration_ms: 12.3\n# duration_ms 20.4\n`,
      `${failure('login', 'unauthorized')}  at login (test/login.test.mjs:40:9)\n  location: 'test/login.test.mjs:40:9'\n  duration_ms: 45.6\n# duration_ms 60.7\n`,
      true,
    ],
    ['ANSI colors', failure('login', 'unauthorized'), `\u001b[31m${failure('login', 'unauthorized')}\u001b[0m`, true],
    ['Jest test timings', '✕ login (12 ms)\nError: unauthorized', '✕ login (45 ms)\nError: unauthorized', true],
    ['line endings', 'Error: unauthorized\n  at login', 'Error: unauthorized\r\n  at login', true],
  ]) {
    const facts = factsFromRequest(
      body([
        user('fix the tests'),
        assistant('running', ['Bash']),
        toolResult(before, { isError: true }),
        assistant('editing', ['Edit']),
        toolResult(after, { isError: true }),
      ]),
      memory(),
      CONTEXT,
    );
    assert.equal(facts.failure !== null, repeated, name);
    if (repeated) {
      assert.equal(facts.failure.index, 4, name);
      assert.ok(facts.failure.signature.length > 0 && facts.failure.signature.length <= 120, name);
    }
  }
});

test('repeated failures must fall within the 40-message lookback', () => {
  for (const [extra, repeated] of [
    [38, true],
    [39, false],
    [41, false],
  ]) {
    const facts = factsFromRequest(
      body([
        user('fix'),
        assistant('running', ['Bash']),
        toolResult('Error: login', { isError: true }),
        assistant('editing', ['Edit']),
        toolResult('Error: login', { isError: true }),
        ...Array.from({ length: extra }, () => assistant('waiting')),
      ]),
      memory(),
      CONTEXT,
    );
    assert.equal(facts.failure !== null, repeated, `${extra} later messages`);
  }
});

test('memory fields pass through', () => {
  const m = memory({ lastRoute: 'high', models: { a: 1 } });
  const facts = factsFromRequest(body([user('x')]), m, CONTEXT);
  assert.equal(facts.lastRoute, 'high');
  assert.deepEqual(facts.models, { a: 1 });
});

test('the prompt and earlier turns sent to Jev are capped at maxTextChars, keeping head and tail', () => {
  for (const [name, messages, context, read, expected] of [
    [
      'a long prompt',
      [user(`HEAD-${'x'.repeat(10_000)}-TAIL`)],
      CONTEXT,
      (f) => f.prompt,
      'HEAD-xxxxxxxx […] xxxxxxx-TAIL',
    ],
    ['a prompt within the cap', [user('fix the flaky test')], CONTEXT, (f) => f.prompt, 'fix the flaky test'],
    [
      'a long earlier turn',
      [user(`START-${'y'.repeat(500)}-END`), assistant('ok'), user('next')],
      CONTEXT,
      (f) => f.turns[0].text,
      'START-yyyyyyy […] yyyyyyyy-END',
    ],
    ['a cap smaller than the marker', [user('abcdefgh')], { ...CONTEXT, maxTextChars: 2 }, (f) => f.prompt, 'ab'],
  ]) {
    assert.equal(read(factsFromRequest(body(messages), memory(), context)), expected, name);
  }
});

test('the current user message is the prompt only, not also the last turn', () => {
  const facts = factsFromRequest(
    body([user('first task'), assistant('done'), user('CURRENT-MARKER now this')]),
    memory(),
    CONTEXT,
  );
  assert.equal(facts.prompt, 'CURRENT-MARKER now this');
  assert.deepEqual(
    facts.turns.map((t) => t.text),
    ['first task', 'done'],
  );
});

test('a trailing tool result with text is not a turn either', () => {
  const trailing = {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: 'ok' }] },
      { type: 'text', text: 'TRAILING-MARKER' },
    ],
  };
  const facts = factsFromRequest(body([user('go'), assistant('running', ['Bash']), trailing]), memory(), CONTEXT);
  assert.deepEqual(
    facts.turns.map((t) => t.text),
    ['go', 'running'],
  );
});

test('a history that ends with the assistant keeps it as the last turn', () => {
  const facts = factsFromRequest(body([user('go'), assistant('LAST-ASSISTANT')]), memory(), CONTEXT);
  assert.equal(facts.turns.at(-1).text, 'LAST-ASSISTANT');
  assert.equal(facts.prompt, '');
});

const step = (...calls) => ({
  role: 'assistant',
  content: [
    { type: 'text', text: 'ok' },
    ...calls.map(([name, input]) => ({ type: 'tool_use', id: 't', name, input })),
  ],
});
const edit = (path, name = 'Edit') => [name, { file_path: path }];
const bash = (command) => ['Bash', { command }];

test('observedActivity labels a finished turn from its tool calls, first match wins', () => {
  for (const [name, calls, expected] of [
    ['no tools', [], 'talk'],
    ['edit of source', [step(edit('/repo/lib/a.mjs'))], 'code'],
    ['write of a new file', [step(edit('/repo/src/new.ts', 'Write'))], 'code'],
    ['multi-edit', [step(edit('/repo/a.go', 'MultiEdit'))], 'code'],
    ['notebook edit', [step(['NotebookEdit', { notebook_path: '/repo/a.ipynb' }])], 'code'],
    ['edit without a path', [step(['Edit', {}])], 'code'],
    ['markdown only', [step(edit('/repo/README.md'))], 'docs'],
    ['mdx, rst and txt', [step(edit('/r/a.MDX'), edit('/r/b.rst'), edit('/r/c.txt'))], 'docs'],
    ['a file under docs/', [step(edit('/repo/docs/diagram.svg'))], 'docs'],
    ['a docs-like name is not docs/', [step(edit('/repo/mydocs/a.mjs'), edit('/repo/lib/docs.mjs'))], 'code'],
    ['docs then source', [step(edit('/repo/README.md')), step(edit('/repo/lib/a.mjs'))], 'code'],
    ['source then docs', [step(edit('/repo/lib/a.mjs')), step(edit('/repo/README.md'))], 'code'],
    ['edit and Bash', [step(bash('npm test'), edit('/repo/lib/a.mjs'))], 'code'],
    ['docs edit and Bash', [step(bash('git commit -m x'), edit('/repo/CHANGELOG.md'))], 'docs'],
    ['test runner', [step(bash('npm test'))], 'ops'],
    ['git commit', [step(bash('git commit -am wip'))], 'ops'],
    ['git push', [step(bash('git push origin main'))], 'ops'],
    ['Bash with no command', [step(['Bash', {}])], 'ops'],
    ['read-only commands', [step(bash('ls -la'), bash('cat a.txt'), bash('rg foo lib'), bash('head -5 a'))], 'read'],
    [
      'read-only git',
      [step(bash('git status'), bash('git log --oneline'), bash('git diff'), bash('git show HEAD'))],
      'read',
    ],
    ['read-only pipeline', [step(bash('cd lib && grep -rn "a;b" . | head -20'))], 'read'],
    ['stderr redirect', [step(bash('ls missing 2>&1'), bash('find . -name x 2>/dev/null'))], 'read'],
    ['a pattern with > inside quotes', [step(bash("rg '=>' lib"))], 'read'],
    ['a write in the background', [step(bash('ls & rm -rf build'))], 'ops'],
    ['output redirect', [step(bash('cat a > b'))], 'ops'],
    ['append redirect', [step(bash('ls >> out.txt'))], 'ops'],
    ['read piped into a writer', [step(bash('cat a | tee b'))], 'ops'],
    ['read then a write in a list', [step(bash('ls; rm -rf build'))], 'ops'],
    ['command substitution', [step(bash('cat $(echo a)'))], 'ops'],
    ['command substitution in double quotes', [step(bash('ls "$(mktemp -d)"'))], 'ops'],
    ['backticks', [step(bash('cat `echo a`'))], 'ops'],
    ['backticks in double quotes', [step(bash('cat "`mktemp`"'))], 'ops'],
    ['substitution syntax in single quotes', [step(bash("rg '$(' lib"))], 'ops'],
    ['find with -exec', [step(bash('find . -name x -exec rm {} +'))], 'ops'],
    ['find with -delete', [step(bash('find . -name x -delete'))], 'ops'],
    ['git add is not read-only', [step(bash('git add -A'))], 'ops'],
    ['read-only Bash and a test run', [step(bash('ls')), step(bash('npm test'))], 'ops'],
    ['Read, Grep, Glob', [step(['Read', {}], ['Grep', {}], ['Glob', {}])], 'read'],
    ['web tools', [step(['WebFetch', {}], ['WebSearch', {}], ['ToolSearch', {}])], 'read'],
    ['subagent and MCP tools', [step(['Task', {}], ['mcp__docs__search', {}])], 'read'],
    ['subagent beside an edit', [step(['Agent', {}], edit('/repo/a.py'))], 'code'],
  ]) {
    const messages = [user('go'), ...calls.flatMap((c) => [c, toolResult('ok')]), assistant('done')];
    assert.equal(observedActivity(messages, 0), expected, name);
  }
});

test('observedActivity reads only the calls after the turn prompt', () => {
  const messages = [
    user('first'),
    step(edit('/repo/a.mjs')),
    toolResult('ok'),
    assistant('done'),
    user('second'),
    step(['Read', {}]),
    toolResult('ok'),
    assistant('done'),
  ];
  assert.equal(observedActivity(messages, 0), 'code');
  assert.equal(observedActivity(messages, 4), 'read');
  assert.equal(observedActivity(messages, 7), 'talk');
  assert.equal(observedActivity(messages, -1), 'code');
});

test('observedActivity ignores system messages, user tool results and malformed content', () => {
  const messages = [
    user('go'),
    system('hook', [{ type: 'tool_use', name: 'Edit', input: { file_path: 'a.mjs' } }]),
    { role: 'user', content: 'plain string' },
    { role: 'assistant', content: 'plain string' },
    null,
    { role: 'assistant' },
    step(['Edit', null]),
  ];
  assert.equal(observedActivity(messages, 0), 'code');
  assert.equal(observedActivity(messages.slice(0, -1), 0), 'talk');
  assert.equal(observedActivity([], 0), 'talk');
});

test('promptIndex finds the last user prompt, past tool results and system messages', () => {
  for (const [name, messages, expected] of [
    ['empty', [], -1],
    ['prompt only', [user('go')], 0],
    ['string prompt', [{ role: 'user', content: 'go' }, assistant('ok')], 0],
    ['a finished tool turn', [user('a'), assistant('ok'), user('b'), step(['Read', {}]), toolResult('ok')], 2],
    ['system after the prompt', [user('a'), system('hook'), step(['Read', {}]), toolResult('ok'), assistant('ok')], 0],
    ['tool results only', [toolResult('ok'), assistant('ok')], -1],
    ['malformed entries', [null, user('a'), { role: 'user' }], 2],
  ])
    assert.equal(promptIndex(messages), expected, name);
});

test("verifiedSince counts a check whose status is the command's: checkers and launcher subcommands, alone or in an && list", () => {
  const passed = (command) =>
    verifiedSince(
      [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: { command } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', is_error: false }] },
      ],
      0,
    );
  for (const [command, expected] of [
    ['npm test', true],
    ['npm run test:unit', true],
    ['cd app && CI=1 npm run check', true],
    ['uv run pytest -q', true],
    ['go test ./...', true],
    ['node --test test/a.test.mjs', true],
    ['./node_modules/.bin/tsc -p tsconfig.json', true],
    ['make lint', true],
    ['node scripts/build-index.mjs', false],
    ['cat sum.test.js', false],
    ['git log --grep test', false],
    ['python -m pytest', true],
    ['npm test 2>&1', true],
    ['npx vitest run', true],
    ['npm install --save-dev vitest', false],
    ['npm ls eslint', false],
    ['npm test; git status --short', false],
    ['npm test || true', false],
    ['npm test 2>&1 | tail -5', false],
    ['npm test &', false],
    ['tsc --version', false],
    ['pytest --help', false],
    ['npx tsc --version', false],
    ['npm --prefix test install', false],
    ['make -C app lint', false],
  ])
    assert.equal(passed(command), expected, command);
});

test('verifiedSince does not take a check sent to the background as passed', () => {
  const launch = (input) => [
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'npm test', ...input } }],
    },
  ];
  const result = (text) => ({
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'a', is_error: false, content: [{ type: 'text', text }] }],
  });
  for (const [name, messages, expected] of [
    ['finished', [...launch({}), result('42 passing')], true],
    [
      'run in background',
      [...launch({ run_in_background: true }), result('Command running in background with ID: b1')],
      false,
    ],
    [
      'moved after a timeout',
      [
        ...launch({}),
        result('Command did not complete within its 120s timeout and was moved to the background (ID: b2).'),
      ],
      false,
    ],
  ])
    assert.equal(verifiedSince(messages, 0), expected, name);
});

test('verifiedSince is true only when the last check since the index passed', () => {
  const bash = (id, command) => ({
    role: 'assistant',
    content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }],
  });
  const ran = (id, isError = false) => ({
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, is_error: isError }],
  });
  for (const [name, messages, from, expected] of [
    ['a passed test run', [bash('a', 'npm test'), ran('a')], 0, true],
    ['a failed build', [bash('a', 'cargo build'), ran('a', true)], 0, false],
    ['a fix after a failure', [bash('a', 'npm test'), ran('a', true), bash('b', 'npm test'), ran('b')], 0, true],
    ['a failure after a pass', [bash('a', 'npm test'), ran('a'), bash('b', 'npm test'), ran('b', true)], 0, false],
    ['no check, only commands', [bash('a', 'git status'), ran('a')], 0, false],
    ['a check before the index', [bash('a', 'npm test'), ran('a'), bash('b', 'ls'), ran('b')], 2, false],
    ['a check still running', [bash('a', 'npm test')], 0, false],
    [
      'a read of a test file after a failure',
      [bash('a', 'npm test'), ran('a', true), bash('b', 'git diff -- test/router.test.mjs'), ran('b')],
      0,
      false,
    ],
    [
      'a search for a test word after a failure',
      [bash('a', 'npm test'), ran('a', true), bash('b', 'rg test package.json'), ran('b')],
      0,
      false,
    ],
    ['a check word inside quotes', [bash('a', 'git commit -m "fix tests; npm test"'), ran('a')], 0, false],
  ])
    assert.equal(verifiedSince(messages, from), expected, name);
});

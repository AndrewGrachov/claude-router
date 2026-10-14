import assert from 'node:assert/strict';
import test from 'node:test';
import {
  band,
  CLEF_FLASH_ANSWER,
  CLOUDFLARE_KEYS,
  CONFIG,
  controls,
  drain,
  harness,
  press,
  start,
  step,
  texts,
} from './harness.mjs';

test('the key button opens the secure plugin dialog and leaves a prompt draft alone', async () => {
  const h = harness();
  await start(h);
  h.draft('unfinished task');
  await press(h, 'key');
  assert.equal(h.commandCalls(), 1);
  assert.equal(h.draft(), 'unfinished task');
});

test('the key button is on the Classifier tab once a key is set', async () => {
  const h = harness({ typesafe_api_key: 'synthetic-key' });
  await start(h);
  assert.equal(
    controls(await h.render()).find((node) => node.key === 'key'),
    undefined,
  );
  await press(h, 'tab-classifier');
  await press(h, 'key');
  assert.equal(h.commandCalls(), 1);
});

test('each classifier reads its key option, then the environment variables named after it', async () => {
  for (const [name, options, env, expected] of [
    [
      'plugin options',
      CLOUDFLARE_KEYS,
      {},
      {
        jev: 'missing-key',
        clef: null,
        'clef-flash': null,
        'clef-omni': null,
        openai: 'missing-key',
        gateway: 'missing-key',
        ollama: null,
      },
    ],
    [
      'environment variables',
      {},
      { TYPESAFE_API_KEY: 'k', CLOUDFLARE_API_TOKEN: 't', CLOUDFLARE_ACCOUNT_ID: 'a' },
      {
        jev: null,
        clef: null,
        'clef-flash': null,
        'clef-omni': null,
        openai: 'missing-key',
        gateway: 'missing-key',
        ollama: null,
      },
    ],
    [
      'an OpenAI environment variable',
      {},
      { OPENAI_API_KEY: 'o' },
      {
        jev: 'missing-key',
        clef: 'missing-key',
        'clef-flash': 'missing-key',
        'clef-omni': 'missing-key',
        openai: null,
        gateway: 'missing-key',
        ollama: null,
      },
    ],
    [
      'a token without an account',
      { cloudflare_api_token: '  ' },
      { CLAUDE_PLUGIN_OPTION_CLOUDFLARE_API_TOKEN: 't' },
      {
        jev: 'missing-key',
        clef: 'missing-account',
        'clef-flash': 'missing-account',
        'clef-omni': 'missing-account',
        openai: 'missing-key',
        gateway: 'missing-key',
        ollama: null,
      },
    ],
  ]) {
    const h = harness(options);
    for (const [key, value] of Object.entries(env)) h.env.set(key, value);
    await start(h);
    assert.deepEqual(h.view().credentials, expected, name);
  }
});

test('every classifier option has both environment fallbacks', async () => {
  const cloudflare = { cloudflare_api_token: 't', cloudflare_account_id: 'a' };
  for (const [variable, options, id] of [
    ['TYPESAFE_API_KEY', {}, 'jev'],
    ['CLAUDE_PLUGIN_OPTION_TYPESAFE_API_KEY', {}, 'jev'],
    ['CLOUDFLARE_API_TOKEN', { cloudflare_account_id: 'a' }, 'clef'],
    ['CLAUDE_PLUGIN_OPTION_CLOUDFLARE_API_TOKEN', { cloudflare_account_id: 'a' }, 'clef'],
    ['CLOUDFLARE_ACCOUNT_ID', { cloudflare_api_token: 't' }, 'clef'],
    ['CLAUDE_PLUGIN_OPTION_CLOUDFLARE_ACCOUNT_ID', { cloudflare_api_token: 't' }, 'clef'],
  ]) {
    const h = harness(options);
    h.env.set(variable, 'value');
    await start(h);
    assert.equal(h.view().credentials[id], null, variable);
  }
  const h = harness(cloudflare);
  await start(h);
  assert.equal(h.view().credentials.jev, 'missing-key');
});

for (const [id, label] of [
  ['clef-flash', 'Clef Flash'],
  ['clef-omni', 'Clef Omni'],
]) {
  test(`${label} classifies through its filled endpoint and reads the Cloudflare envelope`, async () => {
    const h = harness(CLOUDFLARE_KEYS);
    h.files.set(CONFIG, JSON.stringify({ classifier: id }));
    const calls = [];
    h.http(async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, text: CLEF_FLASH_ANSWER, headers: {} };
    });
    await start(h);
    await drain(h.step(step));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `https://api.cloudflare.com/client/v4/accounts/acct-1/ai/run/@cf/cloudflare/${id}`);
    assert.equal(calls[0].init.headers.authorization, 'Bearer synthetic-token');
    assert.equal(JSON.parse(calls[0].init.body).model, id);
    assert.equal(h.view().error, null);
    assert.equal(h.view().adviceChoice, 'micro');
    assert.ok(texts(await h.render()).some((line) => line.startsWith(`${label} ready`)));
  });
}

const GATEWAY_OPTIONS = {
  gateway_url: 'https://litellm.example.internal',
  gateway_model: 'cloudflare/clef-flash',
  gateway_api_key: 'synthetic-gateway-key',
};

test('the Gateway classifier asks the gateway URL with the gateway model and a bearer key, all from plugin options', async () => {
  const h = harness(GATEWAY_OPTIONS);
  h.files.set(CONFIG, JSON.stringify({ classifier: 'gateway' }));
  const calls = [];
  h.http(async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, text: CLEF_FLASH_ANSWER, headers: {} };
  });
  await start(h);
  await drain(h.step(step));
  assert.equal(h.view().credentials.gateway, null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://litellm.example.internal/v1/systemone');
  assert.equal(calls[0].init.headers.authorization, 'Bearer synthetic-gateway-key');
  assert.equal(JSON.parse(calls[0].init.body).model, 'cloudflare/clef-flash');
  assert.equal(h.view().adviceChoice, 'micro');
  await press(h, 'tab-classifier');
  const pane = texts(await h.render());
  assert.ok(pane.some((line) => line.includes('your gateway URL')));
  assert.ok(pane.some((line) => line.startsWith('Gateway ready')));
});

test('each gateway setting reads its plugin option before its environment variables', async () => {
  for (const [name, options, env, url, model, auth] of [
    [
      'plugin options win',
      GATEWAY_OPTIONS,
      { LITELLM_API_KEY: 'env', LITELLM_API_BASE: 'https://env.example' },
      'https://litellm.example.internal/v1/systemone',
      'cloudflare/clef-flash',
      'Bearer synthetic-gateway-key',
    ],
    [
      'LiteLLM variables',
      { gateway_model: 'jev' },
      { LITELLM_API_KEY: 'env-key', LITELLM_API_BASE: 'https://env.example/v1' },
      'https://env.example/v1/systemone',
      'jev',
      'Bearer env-key',
    ],
    [
      'exported plugin options',
      {},
      {
        CLAUDE_PLUGIN_OPTION_GATEWAY_API_KEY: 'exported',
        CLAUDE_PLUGIN_OPTION_GATEWAY_URL: 'http://127.0.0.1:4000',
        CLAUDE_PLUGIN_OPTION_GATEWAY_MODEL: 'jev',
      },
      'http://127.0.0.1:4000/v1/systemone',
      'jev',
      'Bearer exported',
    ],
  ]) {
    const h = harness(options);
    for (const [key, value] of Object.entries(env)) h.env.set(key, value);
    h.files.set(CONFIG, JSON.stringify({ classifier: 'gateway' }));
    const calls = [];
    h.http(async (requested, init) => {
      calls.push({ requested, init });
      return { ok: true, status: 200, text: CLEF_FLASH_ANSWER, headers: {} };
    });
    await start(h);
    await drain(h.step(step));
    assert.equal(calls[0]?.requested, url, name);
    assert.equal(JSON.parse(calls[0].init.body).model, model, name);
    assert.equal(calls[0].init.headers.authorization, auth, name);
  }
});

test('a Gateway classifier without its settings, or on a cleartext URL, sends nothing and names what to fix', async () => {
  for (const [name, options, env, missing, warning] of [
    ['no key', { gateway_url: 'https://gw.example', gateway_model: 'jev' }, {}, 'missing-key', /⚠ Gateway: no API key/],
    ['no URL', { gateway_api_key: 'k', gateway_model: 'jev' }, {}, 'missing-account', /⚠ Gateway: no URL or model/],
    [
      'no model',
      { gateway_api_key: 'k', gateway_url: 'https://gw.example' },
      {},
      'missing-account',
      /⚠ Gateway: no URL or model/,
    ],
    [
      'cleartext off this machine',
      { gateway_api_key: 'k', gateway_url: 'http://gw.example', gateway_model: 'jev' },
      {},
      'bad-url',
      /⚠ Gateway: URL must be https/,
    ],
    [
      'a generic GATEWAY_API_KEY is not read',
      { gateway_url: 'https://gw.example', gateway_model: 'jev' },
      { GATEWAY_API_KEY: 'other-tool' },
      'missing-key',
      /no API key/,
    ],
  ]) {
    const h = harness(options);
    for (const [key, value] of Object.entries(env)) h.env.set(key, value);
    h.files.set(CONFIG, JSON.stringify({ classifier: 'gateway' }));
    h.http(async () => assert.fail(`${name}: no request`));
    await start(h);
    await drain(h.step(step));
    assert.equal(h.view().credentials.gateway, missing, name);
    assert.equal(h.view().error, missing, name);
    const view = await band(h);
    assert.match(view.line, warning, name);
    assert.ok(
      view.controls.some((node) => node.key === 'band-key'),
      name,
    );
  }
});

test('a missing account warns in the band and the pane and offers the key dialog', async () => {
  const h = harness({ cloudflare_api_token: 'synthetic-token' });
  h.files.set(CONFIG, JSON.stringify({ classifier: 'clef' }));
  h.http(async () => assert.fail('no request without an account'));
  await start(h);
  await drain(h.step(step));
  assert.equal(h.view().error, 'missing-account');
  const view = await band(h);
  assert.match(view.line, /⚠ Clef: no account ID .*Haiku 5\.5.* {2}· {2}keeping model/);
  await view.controls.find((node) => node.key === 'band-key').onPress();
  assert.equal(h.commandCalls(), 1);
  assert.ok(texts(await h.render()).includes('Clef: no account ID'));
});

test('a classifier without credentials names the missing setting and offers Set up on its own row', async () => {
  const h = harness(CLOUDFLARE_KEYS);
  await start(h);
  await press(h, 'tab-classifier');
  const pane = await h.render();
  assert.ok(texts(pane).includes('○ no API key  '));
  assert.ok(controls(pane).some((node) => node.key === 'key-jev' && node.label === 'Set up'));
  assert.equal(
    controls(pane).find((node) => node.key === 'key-clef'),
    undefined,
  );
  await press(h, 'key-jev');
  assert.equal(h.commandCalls(), 1);
});

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadConfig } from '../lib/config.mjs';
import { migrateConfig, migrateFile } from '../scripts/migrate-config.mjs';

const old = {
  gateway: { port: 5000, alias: 'private', baselineTier: 'medium', auxiliaryTier: 'micro', idleShutdownMs: 0 },
  routes: { micro: { model: 'custom' } },
  models: {
    custom: {
      id: 'my-model',
      input: 3,
      output: 7,
      cacheRead: 0.15,
      contextWindow: 500000,
      billing: 'credits',
      efforts: ['high'],
      features: [],
      maxOutput: 64000,
    },
  },
  policy: { cashCapUsd: 4, downgradeVotes: 3 },
  cache: { warmMarginMs: 10000 },
  jev: { timeoutMs: 2000 },
  context: { recentTurns: 8 },
  log: false,
};

test('migration preserves custom routes, prices and policy without mutating the old config', () => {
  const before = structuredClone(old);
  const migrated = migrateConfig(old);
  assert.deepEqual(old, before);
  assert.equal(migrated.baselineTier, 'medium');
  assert.equal(migrated.gateway, undefined);
  assert.equal(migrated.log, undefined);
  assert.deepEqual(migrated.routes, old.routes);
  assert.deepEqual(
    migrated.models.custom,
    Object.fromEntries(Object.entries(old.models.custom).filter(([key]) => !['features', 'maxOutput'].includes(key))),
  );
  for (const key of ['policy', 'cache', 'context']) assert.deepEqual(migrated[key], old[key]);
  assert.equal(migrated.jev, undefined);
  assert.deepEqual(migrated.classifiers, { jev: old.jev });
  assert.equal(loadConfig({ userFile: migrated }).routes.micro.model, 'custom');
  assert.deepEqual(migrateConfig(migrated), migrated);
});

test('old config gives an actionable migration error', () => {
  for (const userFile of [old, { log: true }, { models: { haiku: { maxOutput: 64000 } } }])
    assert.throws(() => loadConfig({ userFile }), /scripts\/migrate-config\.mjs/);
});

test('migration rejects conflicts, unknown keys and unsafe object keys', () => {
  for (const file of [
    { ...old, baselineTier: 'high' },
    { gateway: { prot: 123 } },
    { ...old, policy: { cashCapUsd: -1 } },
    JSON.parse('{"gateway":{"__proto__":{}}}'),
    JSON.parse('{"models":{"__proto__":{}}}'),
    { jev: { url: 'https://x' } },
    { jev: 'fast' },
    JSON.parse('{"jev":{"__proto__":{}}}'),
  ])
    assert.throws(() => migrateConfig(file));
});

test('file conversion backs up exact bytes and never overwrites an existing backup', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'router-migration-'));
  t.after(() => rm(directory, { recursive: true }));
  const path = join(directory, 'router.json');
  const original = JSON.stringify(old);
  await writeFile(path, original, { mode: 0o600 });
  const backup = await migrateFile(path);
  assert.equal(await readFile(backup, 'utf8'), original);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), migrateConfig(old));
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(directory)).sort(), ['router.json', 'router.json.v0.8.backup']);
  assert.equal(await migrateFile(path), null);
  await writeFile(path, original);
  await assert.rejects(migrateFile(path), {
    code: 'EEXIST',
    message: `${backup} already exists: move it away, then run again`,
  });
  assert.equal(await readFile(path, 'utf8'), original);
  assert.equal(await readFile(backup, 'utf8'), original);
});

test('a symlinked router.json is refused and left as it is', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'router-migration-'));
  t.after(() => rm(directory, { recursive: true }));
  const source = join(directory, 'dotfiles-router.json');
  const path = join(directory, 'router.json');
  await writeFile(source, JSON.stringify(old));
  await symlink(source, path);
  await assert.rejects(migrateFile(path), { message: `${path} is a symlink: migrate the file it points to` });
  assert.equal(await readFile(source, 'utf8'), JSON.stringify(old));
  assert.deepEqual((await readdir(directory)).sort(), ['dotfiles-router.json', 'router.json']);
  // An already native file behind a symlink needs no write, so it is not refused.
  await writeFile(source, JSON.stringify(migrateConfig(old)));
  assert.equal(await migrateFile(path), null);
});

test('a failed write leaves router.json as it was, removes the backup and keeps a file it did not make', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'router-migration-'));
  t.after(() => rm(directory, { recursive: true }));
  const path = join(directory, 'router.json');
  await writeFile(path, JSON.stringify(old));
  // Something already in the temporary file's place makes its write fail.
  const temp = `${path}.${process.pid}.tmp`;
  await mkdir(temp);
  await assert.rejects(migrateFile(path), { code: 'EEXIST' });
  assert.equal(await readFile(path, 'utf8'), JSON.stringify(old));
  assert.deepEqual((await readdir(directory)).sort(), ['router.json', `router.json.${process.pid}.tmp`]);
});

test('a 1.1 file moves its jev section to classifiers.jev and is backed up beside a 0.8 backup', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'router-migration-'));
  t.after(() => rm(directory, { recursive: true }));
  const path = join(directory, 'router.json');
  const v11 = { routes: { low: { model: 'opus' } }, jev: { timeoutMs: 900, model: 'jev-1.14.0' } };
  const original = JSON.stringify(v11);
  await writeFile(path, original);
  await writeFile(`${path}.v0.8.backup`, 'an earlier migration');
  const backup = await migrateFile(path);
  assert.equal(backup, `${path}.v1.1.backup`);
  assert.equal(await readFile(backup, 'utf8'), original);
  const migrated = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(migrated, { routes: v11.routes, classifiers: { jev: v11.jev } });
  const config = loadConfig({ userFile: migrated });
  assert.equal(config.classifier, 'jev');
  assert.equal(config.classifiers.jev.timeoutMs, 900);
  assert.equal(config.classifiers.jev.model, 'jev-1.14.0');
  assert.equal(await migrateFile(path), null);
  assert.deepEqual(migrateConfig({ jev: {} }), {});
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

test('mutation queue recovers after a rejected mutation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vpn-store-'));
  process.env.DATA_DIR = root;
  const moduleUrl = `${pathToFileURL(path.resolve('lib/store.js')).href}?queue-test=${Date.now()}`;
  const { mutateStore, readStore } = await import(moduleUrl);
  await assert.rejects(mutateStore(() => { throw new Error('expected failure'); }), /expected failure/);
  await mutateStore(db => { db.settings.queueRecovered = true; });
  assert.equal((await readStore()).settings.queueRecovered, true);
  delete process.env.DATA_DIR;
  await fs.rm(root, { recursive: true, force: true });
});

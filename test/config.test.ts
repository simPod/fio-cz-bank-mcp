import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadAccounts } from '../src/config.js';

test('loads named accounts from token references, defaults to read-only, and never reports token values on errors', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'fio-mcp-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'accounts.json');
  const config = { accounts: [
    { name: 'personal', accountNumber: '123', currency: 'CZK', tokenEnv: 'PERSONAL', canSubmit: true },
    { name: 'business', accountNumber: '456', currency: 'EUR', tokenEnv: 'BUSINESS' },
  ] };
  await writeFile(path, JSON.stringify(config));
  const token = 'a'.repeat(64);
  const env = { FIO_CONFIG_PATH: path, PERSONAL: token, BUSINESS: 'b'.repeat(64) };
  const accounts = await loadAccounts(env);
  assert.equal(accounts[0]?.token, token);
  assert.equal(accounts[1]?.canSubmit, false);
  for (const invalid of [`${token}invalid`, `${token}\n`]) {
    await assert.rejects(loadAccounts({ ...env, PERSONAL: invalid }), (error: unknown) => {
      assert(error instanceof Error);
      assert(!error.message.includes(token));
      return true;
    });
  }
  const personal = config.accounts[0];
  assert(personal);
  personal.currency = 'EUR';
  await writeFile(path, JSON.stringify(config));
  await assert.rejects(loadAccounts(env), /Only CZK source accounts/);
  personal.currency = 'CZK';
  const business = config.accounts[1];
  assert(business);
  business.name = 'personal';
  await writeFile(path, JSON.stringify(config));
  await assert.rejects(loadAccounts(env), /names must be unique/);
});

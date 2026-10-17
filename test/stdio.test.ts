import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const entrypoint = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const token = 'a'.repeat(64);

for (const era of ['legacy', 'modern']) {
  test(`built stdio server supports ${era} discovery, local accounts, and shutdown`, { timeout: 10_000 }, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'fio-stdio-'));
    const configPath = join(directory, 'accounts.json');
    const client = new Client({ name: 'stdio-test', version: '1' }, era === 'modern'
      ? { versionNegotiation: { mode: { pin: '2026-07-28' } } }
      : {});
    t.after(async () => {
      await client.close();
      await rm(directory, { recursive: true, force: true });
    });
    await writeFile(configPath, JSON.stringify({ accounts: [
      { name: 'fixture', accountNumber: '1234567890', currency: 'CZK', tokenEnv: 'FIO_STDIO_TEST_TOKEN', canSubmit: false },
    ] }), { mode: 0o600 });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entrypoint],
      env: { FIO_CONFIG_PATH: configPath, FIO_STDIO_TEST_TOKEN: token },
      stderr: 'pipe',
    });
    let stderr = '';
    transport.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    const protocolErrors: Error[] = [];
    client.onerror = (error) => { protocolErrors.push(error); };

    await client.connect(transport);
    assert.equal(client.getProtocolEra(), era);
    if (era === 'modern') assert.equal(client.getNegotiatedProtocolVersion(), '2026-07-28');
    const pid = transport.pid;
    assert(pid !== null);
    const tools = await client.listTools();
    assert(tools.tools.some((tool) => tool.name === 'list_accounts'));
    const accounts = await client.callTool({ name: 'list_accounts', arguments: {} });
    assert.deepEqual(accounts.structuredContent, { accounts: [
      { name: 'fixture', accountNumber: '1234567890', currency: 'CZK', bankCode: '2010', canSubmit: false },
    ] });
    assert(!JSON.stringify([tools, accounts]).includes(token));

    await client.close();
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    assert.deepEqual(protocolErrors, []);
    assert.equal(stderr, '');
  });
}

test('built server fails startup without configuration and keeps stdout clean', { timeout: 5_000 }, async (t) => {
  const child = spawn(process.execPath, [entrypoint], {
    env: { FIO_CONFIG_PATH: '', FIO_STDIO_TEST_TOKEN: token },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  await once(child, 'close');
  assert.equal(child.exitCode, 1);
  assert.equal(child.signalCode, null);
  assert.equal(stdout, '');
  assert.equal(stderr, 'Set FIO_CONFIG_PATH to your local accounts JSON file.\n');
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { ElicitResult } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import type { Account, BankClient, ImportResult, Statement } from '../src/contracts.js';
import { createServer } from '../src/server.js';

const accounts: Account[] = [
  { name: 'personal', accountNumber: '123', currency: 'CZK', token: 'a'.repeat(64), canSubmit: true },
  { name: 'business', accountNumber: '456', currency: 'EUR', token: 'b'.repeat(64), canSubmit: false },
];
const payment = { recipientAccount: '19-2000145399', bankCode: '0800', amount: '123.45', date: '2099-11-20', variableSymbol: '000789', message: 'Invoice 789' };
const accepted: ImportResult = { status: 'ok', errorCode: '0', batchIds: ['987'], messages: [], details: [] };

function data(response: { structuredContent?: unknown }): Record<string, unknown> {
  return z.record(z.string(), z.unknown()).parse(response.structuredContent);
}

async function connect(bank: BankClient, answer?: () => ElicitResult, modern = false) {
  const server = createServer(accounts, bank);
  const client = new Client({ name: 'test-host', version: '1' }, {
    ...(answer ? { capabilities: { elicitation: { form: {} } } } : {}),
    versionNegotiation: { mode: modern ? { pin: '2026-07-28' } : 'legacy' },
  });
  const prompts: string[] = [];
  if (answer) client.setRequestHandler('elicitation/create', async (request) => {
    assert(request.params.mode !== 'url');
    prompts.push(request.params.message);
    return answer();
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(() => server, { transport: serverTransport });
  await client.connect(clientTransport);
  return { client, prompts, close: async () => { await client.close(); await handle.close(); } };
}

function noReads(): Promise<Statement> {
  assert.fail('Payment preparation must not read the bank.');
}

test('reads the explicitly selected account and reports booked balance, not available funds', async (t) => {
  const requested: string[] = [];
  const bank: BankClient = {
    async getStatement(token, dateFrom, dateTo) {
      requested.push(token);
      return { accountNumber: '000456', currency: 'EUR', iban: 'CZEXAMPLE', openingBalance: '100.01', closingBalance: '87.66', dateFrom, dateTo, transactions: [{ id: '9007199254740993', amount: '-12.35', currency: 'EUR', date: dateFrom }] };
    },
    async importPayments() { assert.fail('Read tools must never submit payments.'); },
  };
  const host = await connect(bank);
  t.after(host.close);
  const balance = await host.client.callTool({ name: 'get_balance', arguments: { account: 'business' } });
  assert.equal(data(balance).bookedBalance, '87.66');
  assert.equal(data(balance).currency, 'EUR');
  assert.equal(data(balance).availableBalance, undefined);
  const history = await host.client.callTool({ name: 'get_transactions', arguments: { account: 'business', dateFrom: '2026-01-01', dateTo: '2026-01-31' } });
  assert.deepEqual(data(history).transactions, [{ id: '9007199254740993', amount: '-12.35', currency: 'EUR', date: '2026-01-01' }]);
  assert.deepEqual(requested, ['b'.repeat(64), 'b'.repeat(64)]);
});

for (const [accountNumber, currency, code] of [
  ['789', 'CZK', 'ACCOUNT_MISMATCH'], ['123', 'EUR', 'CURRENCY_MISMATCH'],
]) test(`refuses mismatched bank identity: ${code}`, async (t) => {
  const host = await connect({
    async getStatement(_token, dateFrom, dateTo) {
      assert(accountNumber && currency);
      return { accountNumber, currency, iban: '', openingBalance: '1.00', closingBalance: '1.00', dateFrom, dateTo, transactions: [] };
    },
    async importPayments() { assert.fail(); },
  });
  t.after(host.close);
  const response = await host.client.callTool({ name: 'get_balance', arguments: { account: 'personal' } });
  assert.equal(response.isError, true);
  assert.equal(data(response).code, code);
});

for (const modern of [false, true]) test(`uploads only the previewed batch after a client-side confirmation (${modern ? 'modern' : 'classic'} protocol)`, async (t) => {
  const uploads: Array<{ token: string; xml: string }> = [];
  const host = await connect({ getStatement: noReads, async importPayments(token, xml) { uploads.push({ token, xml }); return accepted; } }, () => ({ action: 'accept', content: { confirm: true } }), modern);
  t.after(host.close);
  const preview = await host.client.callTool({ name: 'preview_payment_batch', arguments: { account: 'personal', payments: [payment] } });
  assert.equal(preview.isError, undefined);
  assert.equal(uploads.length, 0);
  const draftId = data(preview).draftId;
  assert.equal(typeof draftId, 'string');
  const response = await host.client.callTool({ name: 'submit_payment_batch', arguments: { draftId } });
  assert.equal(data(response).status, 'submitted_for_approval');
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0]?.token, 'a'.repeat(64));
  assert(host.prompts[0]?.includes(String(data(preview).preview)));
  const replay = await host.client.callTool({ name: 'submit_payment_batch', arguments: { draftId } });
  assert.equal(data(replay).code, 'DRAFT');
});

for (const answer of [
  { action: 'decline' }, { action: 'cancel' }, { action: 'accept', content: { confirm: false } },
] satisfies ElicitResult[]) {
  test(`does not upload when the human answers ${JSON.stringify(answer)}`, async (t) => {
    const host = await connect({ getStatement: noReads, async importPayments() { assert.fail('Cancelled payment must not be uploaded.'); } }, () => answer);
    t.after(host.close);
    const preview = await host.client.callTool({ name: 'preview_payment_batch', arguments: { account: 'personal', payments: [payment] } });
    const response = await host.client.callTool({ name: 'submit_payment_batch', arguments: { draftId: data(preview).draftId } });
    assert.equal(data(response).status, 'cancelled');
  });
}

test('cannot bypass confirmation with a model-controlled flag or an unsupported client', async (t) => {
  const host = await connect({ getStatement: noReads, async importPayments() { assert.fail('Confirmation was not available.'); } });
  t.after(host.close);
  const preview = await host.client.callTool({ name: 'preview_payment_batch', arguments: { account: 'personal', payments: [payment] } });
  const draftId = data(preview).draftId;
  const bypass = await host.client.callTool({ name: 'submit_payment_batch', arguments: { draftId, confirmed: true } });
  assert.equal(bypass.isError, true);
  const unsupported = await host.client.callTool({ name: 'submit_payment_batch', arguments: { draftId } });
  assert.equal(unsupported.isError, true);
});

test('account listing omits tokens and read-only accounts cannot prepare payments', async (t) => {
  const host = await connect({ getStatement: noReads, async importPayments() { assert.fail(); } });
  t.after(host.close);
  const listed = await host.client.callTool({ name: 'list_accounts', arguments: {} });
  assert(!JSON.stringify(listed).includes('a'.repeat(64)));
  assert(!JSON.stringify(listed).includes('b'.repeat(64)));
  const response = await host.client.callTool({ name: 'preview_payment_batch', arguments: { account: 'business', payments: [payment] } });
  assert.equal(data(response).code, 'READ_ONLY');
});

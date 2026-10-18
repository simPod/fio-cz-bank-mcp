import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import type { Account, AccountDetails, BankClient, ImportResult, Statement, StatementDownload } from '../src/contracts.js';
import { todayInPrague } from '../src/dates.js';
import { createServer } from '../src/server.js';

const accounts: Account[] = [
  { name: 'business', accountNumber: '456', currency: 'EUR', token: 'b'.repeat(64), canSubmit: false },
  { name: 'personal', accountNumber: '123', currency: 'CZK', token: 'a'.repeat(64), canSubmit: true },
];
const payment = { recipientAccount: '19-2000145399', bankCode: '0800', amount: '123.45', date: '2099-11-20', variableSymbol: '000789', message: 'Invoice 789' };
const accepted: ImportResult = { status: 'ok', errorCode: '0', batchIds: ['987'], messages: [], details: [] };

function data(response: { structuredContent?: unknown }): Record<string, unknown> {
  return z.record(z.string(), z.unknown()).parse(response.structuredContent);
}

async function connect(bank: BankClient, modern = false) {
  const server = createServer(accounts, bank);
  const client = new Client({ name: 'test-host', version: '1' }, {
    versionNegotiation: { mode: modern ? { pin: '2026-07-28' } : 'legacy' },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(() => server, { transport: serverTransport });
  await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await handle.close(); } };
}

function noReads(): Promise<Statement> {
  assert.fail('Payment preparation must not read the bank.');
}

function noDownloads(): Promise<StatementDownload> {
  assert.fail('This operation must not download a statement.');
}

function noDetails(): Promise<AccountDetails> {
  assert.fail('This operation must not read account details.');
}

test('reads the explicitly selected account and reports booked balance, not available funds', async (t) => {
  const requested: string[] = [];
  const bank: BankClient = {
    getAccountDetails: noDetails,
    async getStatement(token, dateFrom, dateTo) {
      requested.push(token);
      return { accountNumber: '000456', currency: 'EUR', iban: 'CZEXAMPLE', openingBalance: '100.01', closingBalance: '87.66', dateFrom, dateTo, transactions: [{ id: '9007199254740993', amount: '-12.35', currency: 'EUR', date: dateFrom }] };
    },
    downloadStatement: noDownloads,
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

for (const withOptionalFields of [true, false]) test(`reads bank-supplied account details with optional fields ${withOptionalFields ? 'present' : 'absent'} from one current-day statement`, async (t) => {
  let calls = 0;
  const bankDetails: Pick<AccountDetails, 'bankCode' | 'bic'> = withOptionalFields ? { bankCode: '2020', bic: 'TESTCZPPXXX' } : {};
  const host = await connect({
    getStatement: noReads,
    async getAccountDetails(token, date) {
      calls++;
      assert.equal(token, accounts[0]?.token);
      assert.equal(date, todayInPrague());
      return { accountNumber: '000456', currency: 'EUR', iban: 'CZ7920100000002111111111', ...bankDetails };
    },
    downloadStatement: noDownloads,
    async importPayments() { assert.fail(); },
  });
  t.after(host.close);
  const details = await host.client.callTool({ name: 'get_account_details', arguments: { account: 'business' } });
  assert.deepEqual(data(details), { account: 'business', accountNumber: '000456', currency: 'EUR', iban: 'CZ7920100000002111111111', ...bankDetails });
  assert.equal(calls, 1);
});

for (const [format, mimeType, bytes] of [
  ['pdf', 'application/pdf', Buffer.from('%PDF-1.7\r\n\x00\xff\r\n%%EOF', 'latin1')],
  ['xml', 'application/xml', Buffer.from('\uFEFF<AccountStatement><Info><accountId>000456</accountId><currency>EUR</currency></Info></AccountStatement>\r\n')],
  ['gpc', 'application/octet-stream', Buffer.concat([Buffer.from('0740000000000000456'), Buffer.from([0x8a]), Buffer.alloc(108, 0x20), Buffer.from('\r\n')])],
] as const) test(`returns an embedded ${format} statement with token-free save metadata and no extra account read`, async (t) => {
  let calls = 0;
  const host = await connect({
    getStatement: noReads,
    getAccountDetails: noDetails,
    async downloadStatement(token, year, statementNumber, requestedFormat) {
      calls++;
      assert.equal(token, accounts[0]?.token);
      assert.deepEqual([year, statementNumber, requestedFormat], [2026, 37, format]);
      return { bytes, ...(format !== 'pdf' ? { accountNumber: '000456' } : {}), ...(format === 'xml' ? { currency: 'EUR' } : {}) };
    },
    async importPayments() { assert.fail(); },
  }, format === 'xml');
  t.after(host.close);
  const downloaded = await host.client.callTool({ name: 'download_statement', arguments: { account: 'business', year: 2026, statementNumber: 37, format } });
  const uri = `fio-statement:///business/2026/37.${format}`;
  assert.deepEqual(data(downloaded), {
    account: 'business', year: 2026, statementNumber: 37, format, filename: `business-2026-37.${format}`, uri, mimeType, byteLength: bytes.byteLength,
    identityVerifiedFromFile: { accountNumber: format !== 'pdf', currency: format === 'xml' },
  });
  const embedded = downloaded.content.find((item) => item.type === 'resource');
  assert(embedded?.type === 'resource');
  assert('blob' in embedded.resource && typeof embedded.resource.blob === 'string');
  assert.equal(embedded.resource.uri, uri);
  assert.deepEqual(Buffer.from(embedded.resource.blob, 'base64'), bytes);
  assert(!JSON.stringify(downloaded).includes('b'.repeat(64)));
  assert.equal(calls, 1);
});

test('validates numbered-statement inputs before any bank request', async (t) => {
  const host = await connect({ getStatement: noReads, getAccountDetails: noDetails, downloadStatement: noDownloads, async importPayments() { assert.fail(); } });
  t.after(host.close);
  for (const invalid of [
    { year: 999 }, { year: 10_000 }, { year: 2026.5 }, { year: '2026' },
    { statementNumber: 0 }, { statementNumber: Number.MAX_SAFE_INTEGER + 1 }, { statementNumber: 1.5 },
    { format: 'html' },
  ]) {
    const response = await host.client.callTool({ name: 'download_statement', arguments: { account: 'personal', year: 2026, statementNumber: 1, format: 'xml', ...invalid } });
    assert.equal(response.isError, true);
  }
});

for (const [accountNumber, currency, code] of [
  ['789', 'CZK', 'ACCOUNT_MISMATCH'], ['123', 'EUR', 'CURRENCY_MISMATCH'],
] as const) test(`refuses mismatched bank identity: ${code}`, async (t) => {
  const host = await connect({
    async getAccountDetails() { return { accountNumber, currency, iban: '' }; },
    async getStatement(_token, dateFrom, dateTo) {
      assert(accountNumber && currency);
      return { accountNumber, currency, iban: '', openingBalance: '1.00', closingBalance: '1.00', dateFrom, dateTo, transactions: [] };
    },
    async downloadStatement() { return { bytes: Buffer.from('<AccountStatement/>'), accountNumber, currency }; },
    async importPayments() { assert.fail(); },
  });
  t.after(host.close);
  for (const name of ['get_balance', 'get_account_details', 'download_statement']) {
    const response = await host.client.callTool({ name, arguments: { account: 'personal', ...(name === 'download_statement' ? { year: 2026, statementNumber: 1, format: 'xml' } : {}) } });
    assert.equal(response.isError, true);
    assert.equal(data(response).code, code);
  }
});

for (const modern of [false, true]) test(`previews without bank access, then uploads the saved batch for Fio approval (${modern ? 'modern' : 'classic'} protocol)`, async (t) => {
  const uploads: Array<{ token: string; xml: string }> = [];
  const host = await connect({ getStatement: noReads, getAccountDetails: noDetails, downloadStatement: noDownloads, async importPayments(token, xml) { uploads.push({ token, xml }); return accepted; } }, modern);
  t.after(host.close);
  const preview = await host.client.callTool({ name: 'preview_payment_batch', arguments: { account: 'personal', payments: [payment] } });
  assert.equal(preview.isError, undefined);
  assert.equal(uploads.length, 0);
  const draftId = data(preview).draftId;
  assert(typeof draftId === 'string');
  const response = await host.client.callTool({ name: 'submit_payment_batch', arguments: { draftId } });
  assert.equal(data(response).status, 'submitted_for_approval');
  assert.equal(uploads.length, 1);
  const upload = uploads[0];
  assert(upload);
  assert.equal(upload.token, 'a'.repeat(64));
  assert.match(upload.xml, /<accountFrom>123<\/accountFrom>/);
  assert.match(upload.xml, /<amount>123\.45<\/amount>/);
  const replay = await host.client.callTool({ name: 'submit_payment_batch', arguments: { draftId } });
  assert.equal(data(replay).code, 'DRAFT');
});

test('refuses missing or invalid drafts and replacement payment arguments before upload', async (t) => {
  const host = await connect({ getStatement: noReads, getAccountDetails: noDetails, downloadStatement: noDownloads, async importPayments() { assert.fail('Invalid submission must not upload.'); } });
  t.after(host.close);
  const preview = await host.client.callTool({ name: 'preview_payment_batch', arguments: { account: 'personal', payments: [payment] } });
  const draftId = data(preview).draftId;
  for (const args of [{}, { draftId: 'invalid' }, { draftId, confirmed: true }, { draftId, account: 'business', payments: [{ ...payment, amount: '999.99' }] }]) {
    const response = await host.client.callTool({ name: 'submit_payment_batch', arguments: args });
    assert.equal(response.isError, true);
  }
  const missing = await host.client.callTool({ name: 'submit_payment_batch', arguments: { draftId: '00000000-0000-4000-8000-000000000000' } });
  assert.equal(data(missing).code, 'DRAFT');
});

test('revalidates a saved payment date after the Prague day changes', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2028-07-01T21:59:59Z') });
  const host = await connect({ getStatement: noReads, getAccountDetails: noDetails, downloadStatement: noDownloads, async importPayments() { assert.fail('An outdated draft must not upload.'); } });
  t.after(host.close);
  const preview = await host.client.callTool({ name: 'preview_payment_batch', arguments: { account: 'personal', payments: [{ ...payment, date: '2028-07-01' }] } });
  assert.equal(preview.isError, undefined);
  t.mock.timers.setTime(new Date('2028-07-01T22:00:00Z').getTime());
  const response = await host.client.callTool({ name: 'submit_payment_batch', arguments: { draftId: data(preview).draftId } });
  assert.equal(data(response).code, 'VALIDATION');
});

for (const status of ['warning', 'error'] as const) test(`reports a bank ${status} without automatically retrying`, async (t) => {
  const bankResult: ImportResult = { status, errorCode: status === 'warning' ? '2' : '1', batchIds: status === 'warning' ? ['987'] : [], messages: ['Bank response'], details: [] };
  let uploads = 0;
  const host = await connect({ getStatement: noReads, getAccountDetails: noDetails, downloadStatement: noDownloads, async importPayments() { uploads++; return bankResult; } });
  t.after(host.close);
  const preview = await host.client.callTool({ name: 'preview_payment_batch', arguments: { account: 'personal', payments: [payment] } });
  const draftId = data(preview).draftId;
  const response = await host.client.callTool({ name: 'submit_payment_batch', arguments: { draftId } });
  assert.equal(data(response).status, status === 'warning' ? 'submitted_for_approval' : 'rejected');
  assert.deepEqual(data(response).bankResult, bankResult);
  assert.equal(response.isError, status === 'error' ? true : undefined);
  if (status === 'warning') {
    const replay = await host.client.callTool({ name: 'submit_payment_batch', arguments: { draftId } });
    assert.equal(data(replay).code, 'DRAFT');
  }
  assert.equal(uploads, 1);
});

test('account listing omits tokens and read-only accounts cannot prepare payments', async (t) => {
  const host = await connect({ getStatement: noReads, getAccountDetails: noDetails, downloadStatement: noDownloads, async importPayments() { assert.fail(); } });
  t.after(host.close);
  const listed = await host.client.callTool({ name: 'list_accounts', arguments: {} });
  assert(!JSON.stringify(listed).includes('a'.repeat(64)));
  assert(!JSON.stringify(listed).includes('b'.repeat(64)));
  const response = await host.client.callTool({ name: 'preview_payment_batch', arguments: { account: 'business', payments: [payment] } });
  assert.equal(data(response).code, 'READ_ONLY');
});

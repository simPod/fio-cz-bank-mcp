import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { ImportResult, Statement } from '../src/contracts.js';
import { FioError } from '../src/errors.js';
import { FioClient } from '../src/fio.js';

const token = 'a'.repeat(64);
const from = '2026-09-01';
const to = '2026-09-30';
const info = '<Info><accountId>1234567890</accountId><bankId>2010</bankId><currency>CZK</currency><iban>CZ7920100000002111111111</iban><openingBalance>9007199254740993.10</openingBalance><closingBalance>-12.30</closingBalance><dateStart>2026-09-01+02:00</dateStart><dateEnd>2026-09-30+02:00</dateEnd></Info>';
const transaction = `<Transaction><column_22 id="22">9007199254740993</column_22><column_0 id="0">2026-09-15+02:00</column_0><column_1 id="1">-9007199254740993.20</column_1><column_14 id="14">CZK</column_14><column_2 id="2">00123456</column_2><column_10 id="10">Example &amp; Co.</column_10><column_3 id="3">0100</column_3><column_12 id="12">Example Bank</column_12><column_5 id="5">0000123</column_5><column_4 id="4">0308</column_4><column_6 id="6">0009</column_6><column_7 id="7">Shop, Praha ${token}</column_7><column_16 id="16">Invoice</column_16><column_25 id="25">Paid</column_25><column_8 id="8">Transfer</column_8><column_9 id="9">Example Person</column_9><column_18 id="18">Card purchase</column_18><column_26 id="26">KOMBCZPPXXX</column_26><column_27 id="27">000ref</column_27><column_17 id="17">9007199254740995</column_17></Transaction>`;
const statement = (transactions = transaction) => `<AccountStatement>${info}<TransactionList>${transactions}</TransactionList></AccountStatement>`;
const importResponse = (status: string, code: string, extra = '<idInstruction>9007199254740993</idInstruction>', details = '') => `<responseImport><result><errorCode>${code}</errorCode>${extra}<status>${status}</status></result>${details}</responseImport>`;

function checkError(code: string, message?: RegExp): (error: unknown) => boolean {
  return (error) => {
    assert(error instanceof FioError);
    assert.equal(error.code, code);
    assert(!error.message.includes(token));
    if (message) assert.match(error.message, message);
    return true;
  };
}

test('reads exact statement values from XML without numeric conversion', async () => {
  const client = new FioClient({ fetch: async (url, init) => {
    assert.equal(url, `https://fioapi.fio.cz/v1/rest/periods/${token}/${from}/${to}/transactions.xml`);
    assert.equal(init?.method, 'GET');
    assert.equal(init.redirect, 'error');
    assert(init.signal instanceof AbortSignal);
    return new Response(statement());
  } });
  assert.deepEqual(await client.getStatement(token, from, to), {
    accountNumber: '1234567890', currency: 'CZK', iban: 'CZ7920100000002111111111', openingBalance: '9007199254740993.10', closingBalance: '-12.30', dateFrom: from, dateTo: to,
    transactions: [{ id: '9007199254740993', date: '2026-09-15+02:00', amount: '-9007199254740993.20', currency: 'CZK', counterAccount: '00123456', counterAccountName: 'Example & Co.', bankCode: '0100', bankName: 'Example Bank', variableSymbol: '0000123', constantSymbol: '0308', specificSymbol: '0009', userIdentification: 'Shop, Praha [REDACTED]', message: 'Invoice', comment: 'Paid', type: 'Transfer', performedBy: 'Example Person', detail: 'Card purchase', bic: 'KOMBCZPPXXX', payerReference: '000ref', orderId: '9007199254740995' }],
  } satisfies Statement);
});

test('accepts empty or omitted transaction lists and an omitted bank ID', async () => {
  for (const xml of [statement(''), statement('').replace('<TransactionList></TransactionList>', ''), statement('').replace('<bankId>2010</bankId>', '')]) {
    const client = new FioClient({ fetch: async () => new Response(xml) });
    assert.deepEqual((await client.getStatement(token, from, to)).transactions, []);
  }
});

test('rejects malformed or incomplete statements without exposing bank text', async () => {
  const cases = [
    `<AccountStatement>${token}</AccountStatement>`,
    statement().replace('<closingBalance>-12.30</closingBalance>', ''),
    statement().replace('<bankId>2010</bankId>', '<bankId>invalid</bankId>'),
    statement().replace('<column_22 id="22">9007199254740993</column_22>', ''),
    statement().replace('-9007199254740993.20', 'not-an-amount'),
    statement().replace('<TransactionList>', '<TransactionList><Unexpected/>'),
    '<!DOCTYPE AccountStatement [<!ENTITY secret "secret">]>' + statement(),
    statement().replace('Invoice', '&unknown;'),
    '<AccountStatement>',
  ];
  for (const xml of cases) {
    const client = new FioClient({ fetch: async () => new Response(xml) });
    await assert.rejects(client.getStatement(token, from, to), checkError('RESPONSE'));
  }
});

test('reserves each token before requests and refuses reuse for 30 seconds across operations', async () => {
  let now = 1_000;
  let calls = 0;
  let finish: ((response: Response) => void) | undefined;
  const client = new FioClient({ now: () => now, fetch: async () => {
    calls++;
    if (calls === 1) return new Promise<Response>((resolve) => { finish = resolve; });
    return new Response(statement(''));
  } });
  const pending = client.getStatement(token, from, to);
  await assert.rejects(client.importPayments(token, '<Import/>'), checkError('RATE_LIMIT', /30 seconds/));
  await client.getStatement('b'.repeat(64), from, to);
  assert(finish);
  finish(new Response(statement('')));
  await pending;
  now += 29_001;
  await assert.rejects(client.getStatement(token, from, to), checkError('RATE_LIMIT', /1 seconds/));
  now += 999;
  await client.getStatement(token, from, to);
  assert.equal(calls, 3);
});

test('uploads multipart XML and recognizes acceptance including warnings and multiple instruction IDs', async () => {
  const xml = '<?xml version="1.0"?><Import>payment</Import>';
  for (const [status, code] of [['ok', '0'], ['warning', '2']] as const) {
    const batchIds = status === 'ok' ? ['9007199254740993'] : ['9007199254740993', '00042'];
    let calls = 0;
    const client = new FioClient({ fetch: async (url, init) => {
      calls++;
      assert.equal(url, 'https://fioapi.fio.cz/v1/rest/import/');
      assert.equal(init?.method, 'POST');
      assert.equal(init.redirect, 'error');
      assert(init.signal instanceof AbortSignal);
      assert(init.body instanceof FormData);
      assert.equal(init.body.get('token'), token);
      assert.equal(init.body.get('type'), 'xml');
      assert.equal(init.body.get('lng'), 'en');
      const file = init.body.get('file');
      assert(file instanceof Blob);
      assert.equal(await file.text(), xml);
      return new Response(importResponse(status, code,
        `${batchIds.map((id) => `<idInstruction>${id}</idInstruction>`).join('')}<message>Saved ${token}</message><message>Approve in Fio ${'&#97;'.repeat(64)}</message>`,
        `<ordersDetails><detail id="1"><messages><message status="${status}" errorCode="${code}">Order ${token}</message><message status="ok" errorCode="0">Ready</message></messages></detail><detail id="2"><messages><message status="ok" errorCode="0">Ready</message></messages></detail></ordersDetails>`));
    } });
    assert.deepEqual(await client.importPayments(token, xml), {
      status, errorCode: code, batchIds, messages: ['Saved [REDACTED]', 'Approve in Fio [REDACTED]'],
      details: [{ order: '1', status, errorCode: code, message: 'Order [REDACTED]' }, { order: '1', status: 'ok', errorCode: '0', message: 'Ready' }, { order: '2', status: 'ok', errorCode: '0', message: 'Ready' }],
    } satisfies ImportResult);
    assert.equal(calls, 1);
  }
});

test('returns bank rejection and fatal errors with single messages and order details', async () => {
  for (const [status, code] of [['error', '1'], ['fatal', '3']] as const) {
    const client = new FioClient({ fetch: async () => new Response(importResponse(status, code,
      `<message>Rejected ${token}</message>`,
      `<ordersDetails><detail id="01"><messages><message status="${status}" errorCode="15">Invalid account</message></messages></detail></ordersDetails>`)) });
    assert.deepEqual(await client.importPayments(token, '<Import/>'), {
      status, errorCode: code, batchIds: [], messages: ['Rejected [REDACTED]'],
      details: [{ order: '01', status, errorCode: '15', message: 'Invalid account' }],
    } satisfies ImportResult);
  }
});

test('reports ambiguous upload outcomes without retrying or returning raw XML', async () => {
  const cases = [
    `<invalid>${token}</invalid>`,
    '<responseImport>',
    importResponse('new-status', '0'),
    importResponse('ok', '0', ''),
    importResponse('warning', '0'),
    importResponse('ok', '2'),
    importResponse('error', '1'),
    importResponse('ok', '0', '<idInstruction>1</idInstruction>', '<ordersDetails><detail id="1"><messages><message status="error" errorCode="1">Failed</message></messages></detail></ordersDetails>'),
    '<!DOCTYPE responseImport>' + importResponse('ok', '0'),
  ];
  for (const xml of cases) {
    let calls = 0;
    const client = new FioClient({ fetch: async () => { calls++; return new Response(xml); } });
    await assert.rejects(client.importPayments(token, '<Import/>'), checkError('UNKNOWN_OUTCOME', /Check Fio Internetbanking before resubmitting/));
    assert.equal(calls, 1);
  }
});

test('sanitizes network and body failures and keeps uploads uncertain without retrying', async () => {
  const failures: Array<typeof globalThis.fetch> = [
    async () => { throw new Error(`Failed URL https://fioapi.fio.cz/${token}`); },
    async () => { throw new DOMException(`Timed out ${token}`, 'TimeoutError'); },
    async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error(token)); } })),
    async () => new Response(new Uint8Array(10 * 1024 * 1024 + 1)),
  ];
  for (const failure of failures) {
    let calls = 0;
    const client = new FioClient({ fetch: async (...args) => { calls++; return failure(...args); } });
    await assert.rejects(client.importPayments(token, '<Import/>'), checkError('UNKNOWN_OUTCOME', /duplicate payments/));
    assert.equal(calls, 1);
    await assert.rejects(client.importPayments(token, '<Import/>'), checkError('RATE_LIMIT'));
    assert.equal(calls, 1);
  }
  const firstFailure = failures[0];
  assert(firstFailure);
  const client = new FioClient({ fetch: firstFailure });
  await assert.rejects(client.getStatement(token, from, to), checkError('NETWORK'));
});

test('uses static HTTP errors rather than leaking response bodies or URLs', async () => {
  for (const status of [404, 409, 413, 422, 500]) {
    for (const upload of [false, true]) {
      let calls = 0;
      const client = new FioClient({ fetch: async () => { calls++; return new Response(`<secret>${token}</secret>`, { status }); } });
      const request = upload ? client.importPayments(token, '<Import/>') : client.getStatement(token, from, to);
      const recovery = status === 422
        ? upload ? /payment data/ : /older than 90 days.*Nastavení \/ API.*10 minutes/
        : status === 500 ? upload ? /Check Fio Internetbanking before resubmitting/ : /token is inactive, nonexistent, or expired/ : undefined;
      await assert.rejects(request, checkError(upload && status === 500 ? 'UNKNOWN_OUTCOME' : `HTTP_${status}`, recovery));
      assert.equal(calls, 1);
    }
  }
});

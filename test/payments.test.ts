import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { todayInPrague } from '../src/dates.js';
import { FioError } from '../src/errors.js';
import { buildPaymentXml, createPaymentBatch, describePaymentBatch, paymentSchema } from '../src/payments.js';
import type { Payment } from '../src/payments.js';

const input = { recipientAccount: '19-2000145399', bankCode: '0800', amount: '12.3', date: '2028-02-29' };

test('paymentSchema parses exact decimal CZK strings without floating-point arithmetic', () => {
  for (const [amount, expected] of [
    ['0.01', '0.01'], ['1', '1.00'], ['00012.3', '12.30'],
    ['9007199254740993.01', '9007199254740993.01'], ['9999999999999999.99', '9999999999999999.99'],
  ]) {
    assert.equal(paymentSchema.parse({ ...input, amount }).amount, expected);
  }
  for (const amount of [0.01, '0', '0.00', '-1', '+1', '1e2', '1,25', '.5', '1.', '1.001', ' 1', '1 ', '1\n', '10000000000000000']) {
    assert.equal(paymentSchema.safeParse({ ...input, amount }).success, false, String(amount));
  }
});

test('paymentSchema checks Czech account main and prefix checksums, not a speculative bank list', () => {
  for (const recipientAccount of ['19-2000145399', '2000145399', '000000-2000145399', '000019-2000145399', '0000000019']) {
    assert.equal(paymentSchema.parse({ ...input, recipientAccount, bankCode: '9999' }).recipientAccount, recipientAccount);
  }
  for (const recipientAccount of ['18-2000145399', '19-2000145398', '0', '0000000000', '19-0', '1234567-2000145399', '12000145399', '19--2000145399', '2000145399/0800', '2000145399\n']) {
    assert.equal(paymentSchema.safeParse({ ...input, recipientAccount }).success, false, recipientAccount);
  }
  for (const bankCode of ['0000', '800', '08000', '08a0', '0800\n', 800]) {
    assert.equal(paymentSchema.safeParse({ ...input, bankCode }).success, false, String(bankCode));
  }
});

test('paymentSchema validates real calendar dates without a future scheduling limit', () => {
  assert.equal(paymentSchema.parse({ ...input, date: '9999-12-31' }).date, '9999-12-31');
  for (const date of ['2027-02-29', '2028-02-30', '2100-02-29', '2028-04-31', '2028-00-01', '1999-12-31', '10000-01-01', '2028-2-29', '2028-02-29T00:00:00Z']) {
    assert.equal(paymentSchema.safeParse({ ...input, date }).success, false, date);
  }
});

test('paymentSchema preserves symbols and documented Unicode payment text, rejecting hidden text and unsupported fields', () => {
  const text = 'Příliš žluťoučký kůň, č. 12/3 - záloha';
  const payment = paymentSchema.parse({
    ...input, variableSymbol: '0001234567', constantSymbol: '0008', specificSymbol: '0987654321', message: text, comment: 'a'.repeat(140),
  });
  assert.equal(payment.variableSymbol, '0001234567');
  assert.equal(payment.message, text);
  assert.equal(payment.comment?.length, 140);
  for (const fields of [
    { variableSymbol: '12345678901' }, { constantSymbol: '12345' }, { specificSymbol: '12345678901' },
    { variableSymbol: '12a' }, { constantSymbol: '-1' }, { specificSymbol: '' }, { specificSymbol: '12\n' },
    { message: 'a'.repeat(141) }, { comment: 'a'.repeat(141) },
    { message: 'hidden\namount' }, { message: '123\n' }, { comment: '\u0000' }, { message: '\u202E123' }, { message: '\u200B123' }, { message: '1\u034F' },
    { message: 'A & B' }, { message: '<order>' }, { message: '"quoted"' },
    { paymentType: '431022' }, { priority: true }, { currency: 'EUR' },
  ]) {
    assert.equal(paymentSchema.safeParse({ ...input, ...fields }).success, false, JSON.stringify(fields));
  }
});

test('createPaymentBatch totals cents exactly beyond the safe integer range', () => {
  const payments = ['9007199254740993.01', '0.99', '9999999999999999.99'].map((amount) => paymentSchema.parse({ ...input, amount }));
  const batch = createPaymentBatch('business', '2000145399', payments, '2028-02-29');
  assert.equal(batch.total, '19007199254740993.99');
  assert.equal(batch.currency, 'CZK');
});

test('createPaymentBatch accepts today and future dates but rejects any past transfer in the batch', () => {
  const payments = [paymentSchema.parse(input), paymentSchema.parse({ ...input, date: '9999-12-31' })];
  assert.deepEqual(createPaymentBatch('business', '2000145399', payments, input.date).payments, payments);
  assert.throws(() => createPaymentBatch('business', '2000145399', [...payments, paymentSchema.parse({ ...input, date: '2028-02-28' })], input.date), (error: unknown) => {
    assert(error instanceof FioError);
    assert.equal(error.code, 'VALIDATION');
    assert.match(error.message, /Payment 3.*today or later.*Europe\/Prague/);
    return true;
  });
});

test('createPaymentBatch bounds a complete confirmation to 1–100 payments', () => {
  const payment = paymentSchema.parse(input);
  for (const count of [0, 101]) {
    assert.throws(() => createPaymentBatch('business', '2000145399', Array<Payment>(count).fill(payment), '2028-02-29'), /between 1 and 100/);
  }
  assert.equal(createPaymentBatch('business', '2000145399', Array<Payment>(100).fill(payment), '2028-02-29').payments.length, 100);
});

test('Prague calendar cutoffs set the earliest payment date in winter and summer', () => {
  for (const [instant, expected] of [
    ['2028-01-01T22:59:59Z', '2028-01-01'], ['2028-01-01T23:00:00Z', '2028-01-02'],
    ['2028-07-01T21:59:59Z', '2028-07-01'], ['2028-07-01T22:00:00Z', '2028-07-02'],
  ]) {
    assert(instant !== undefined && expected !== undefined);
    const today = todayInPrague(new Date(instant));
    assert.equal(today, expected);
    const payment = paymentSchema.parse({ ...input, date: expected });
    assert.equal(createPaymentBatch('business', '2000145399', [payment], today).payments[0]?.date, expected);
  }
});

test('describePaymentBatch shows every transfer, date, symbol and quoted free-text field', () => {
  const payments = Array.from({ length: 100 }, (_, index) => paymentSchema.parse({
    ...input, amount: '1', variableSymbol: String(index), constantSymbol: '0008', specificSymbol: '001',
    message: `Záloha ${index}`, comment: `Faktura ${index}`, date: index === 99 ? '9999-12-31' : input.date,
  }));
  const preview = describePaymentBatch(createPaymentBatch('business', '2000145399', payments, '2028-02-29'));
  assert.match(preview, /Source account: "business" \(2000145399\/2010\)/);
  assert.match(preview, /Total: 100\.00 CZK; payments: 100/);
  for (const [index, payment] of payments.entries()) {
    assert(preview.includes(`${index + 1}. Recipient: 19-2000145399/0800; amount: 1.00 CZK; date: ${payment.date}`));
    assert(preview.includes(`Variable symbol: "${index}"; constant symbol: "0008"; specific symbol: "001"`));
    assert(preview.includes(`Message: ${JSON.stringify(payment.message)}; comment: ${JSON.stringify(payment.comment)}`));
  }
});

test('buildPaymentXml follows the Fio sequence, preserves values and creates only standard domestic transfers', () => {
  const payment = paymentSchema.parse({ ...input, constantSymbol: '0008', variableSymbol: '00123', specificSymbol: '00456', message: 'Příspěvek', comment: 'Záloha' });
  const batch = createPaymentBatch('business', '2000145399', [payment, paymentSchema.parse({ ...input, recipientAccount: '19', amount: '0.01' })], '2028-02-29');
  const xml = buildPaymentXml(batch);
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  assert.equal(XMLValidator.validate(xml), true);
  const parsed: unknown = new XMLParser({ parseTagValue: false }).parse(xml);
  assert.deepEqual(parsed, {
    '?xml': '',
    Import: { Orders: { DomesticTransaction: [
      { accountFrom: '2000145399', currency: 'CZK', amount: '12.30', accountTo: '19-2000145399', bankCode: '0800', ks: '0008', vs: '00123', ss: '00456', date: '2028-02-29', messageForRecipient: 'Příspěvek', comment: 'Záloha', paymentType: '431001' },
      { accountFrom: '2000145399', currency: 'CZK', amount: '0.01', accountTo: '19', bankCode: '0800', date: '2028-02-29', paymentType: '431001' },
    ] } },
  });
  const tags = [...xml.matchAll(/<([a-z][a-zA-Z]*)>/g)].map((match) => match[1]);
  assert.deepEqual(tags.slice(0, 13), ['accountFrom', 'currency', 'amount', 'accountTo', 'bankCode', 'ks', 'vs', 'ss', 'date', 'messageForRecipient', 'comment', 'paymentType', 'accountFrom']);
});

test('buildPaymentXml escapes all XML special characters even for a direct typed caller', () => {
  // The input schema rejects these characters; serialization still must not permit XML injection.
  const text = `A&B <tag> "quoted" 'single'`;
  const payment: Payment = { ...paymentSchema.parse(input), message: text, comment: text };
  const xml = buildPaymentXml(createPaymentBatch('business', '2000145399', [payment], '2028-02-29'));
  assert(xml.includes('A&amp;B &lt;tag&gt; &quot;quoted&quot; &apos;single&apos;'));
  assert.equal(XMLValidator.validate(xml), true);
  const parsed: unknown = new XMLParser({ parseTagValue: false }).parse(xml);
  assert.deepEqual(parsed, {
    '?xml': '',
    Import: { Orders: { DomesticTransaction: {
      accountFrom: '2000145399', currency: 'CZK', amount: '12.30', accountTo: '19-2000145399', bankCode: '0800', date: '2028-02-29', messageForRecipient: text, comment: text, paymentType: '431001',
    } } },
  });
});

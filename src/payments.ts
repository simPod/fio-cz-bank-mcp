import * as z from 'zod/v4';
import { dateSchema, todayInPrague } from './dates.js';
import { FioError } from './errors.js';

function hasAccountChecksum(value: string): boolean {
  const digits = value.padStart(10, '0');
  const weights = [6, 3, 7, 9, 10, 5, 8, 4, 2, 1];
  let sum = 0;
  for (const [index, weight] of weights.entries()) sum += Number(digits.charAt(index)) * weight;
  return sum % 11 === 0;
}

// An absolute end assertion also rejects a trailing newline, unlike JavaScript's $.
const recipientAccountSchema = z.string().regex(/^(?:[0-9]{1,6}-)?[0-9]{1,10}(?![\s\S])/).refine((value) => {
  const [prefix, main] = value.includes('-') ? value.split('-') : ['0', value];
  return main !== undefined && /[1-9]/.test(main) && hasAccountChecksum(main) && hasAccountChecksum(prefix ?? '');
}, { message: 'Use a nonzero Czech account number with valid modulo-11 checksums.' });

function formatCents(cents: bigint): string {
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;
}

const amountSchema = z.string()
  .regex(/^[0-9]{1,16}(?:\.[0-9]{1,2})?(?![\s\S])/, 'Use a decimal CZK string with at most 16 integer digits and two decimal places.')
  .refine((amount) => /[1-9]/.test(amount), { message: 'The outgoing amount must be greater than zero.' })
  .transform((amount) => {
    const [integer = '0', fraction = ''] = amount.split('.');
    return formatCents(BigInt(integer) * 100n + BigInt(fraction.padEnd(2, '0')));
  });

// Fio manual type i: letters (including diacritics), digits, comma, dot, slash,
// hyphen and space. Combining marks retain decomposed Unicode diacritics.
// The import XSD limits both fields to 140, even though the manual says 255 for comments.
const paymentTextSchema = z.string().max(140).refine(
  (value) => !/[^\p{L}\p{M}\p{N},./ -]|\p{Default_Ignorable_Code_Point}/u.test(value),
  { message: 'Use letters, digits, comma, dot, slash, hyphen and spaces; no controls, invisible characters or line breaks.' },
);

export const paymentSchema = z.strictObject({
  recipientAccount: recipientAccountSchema,
  bankCode: z.string().regex(/^[0-9]{4}(?![\s\S])/).refine((value) => value !== '0000', { message: 'Bank code 0000 is not valid.' }),
  amount: amountSchema,
  date: dateSchema,
  variableSymbol: z.string().regex(/^[0-9]{1,10}(?![\s\S])/).optional(),
  constantSymbol: z.string().regex(/^[0-9]{1,4}(?![\s\S])/).optional(),
  specificSymbol: z.string().regex(/^[0-9]{1,10}(?![\s\S])/).optional(),
  message: paymentTextSchema.optional(),
  comment: paymentTextSchema.optional(),
});

export type Payment = z.infer<typeof paymentSchema>;

export interface PaymentBatch {
  account: string;
  accountNumber: string;
  currency: 'CZK';
  total: string;
  payments: Payment[];
}

export function createPaymentBatch(account: string, accountNumber: string, payments: Payment[], today = todayInPrague()): PaymentBatch {
  if (payments.length < 1 || payments.length > 100) {
    throw new FioError('VALIDATION', 'A payment batch must contain between 1 and 100 payments.');
  }
  let total = 0n;
  for (const [index, payment] of payments.entries()) {
    if (payment.date < today) {
      throw new FioError('VALIDATION', `Payment ${index + 1} must be dated today or later in Europe/Prague.`);
    }
    // Payments have already been parsed: every amount has exactly two decimal places.
    total += BigInt(payment.amount.replace('.', ''));
  }
  return { account, accountNumber, currency: 'CZK', total: formatCents(total), payments };
}

function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function element(name: string, value: string | undefined): string {
  return value === undefined ? '' : `<${name}>${escapeXml(value)}</${name}>`;
}

export function buildPaymentXml(batch: PaymentBatch): string {
  const orders = batch.payments.map((payment) => '<DomesticTransaction>'
    + element('accountFrom', batch.accountNumber)
    + element('currency', batch.currency)
    + element('amount', payment.amount)
    + element('accountTo', payment.recipientAccount)
    + element('bankCode', payment.bankCode)
    + element('ks', payment.constantSymbol)
    + element('vs', payment.variableSymbol)
    + element('ss', payment.specificSymbol)
    + element('date', payment.date)
    + element('messageForRecipient', payment.message)
    + element('comment', payment.comment)
    + element('paymentType', '431001')
    + '</DomesticTransaction>').join('');
  return `<?xml version="1.0" encoding="UTF-8"?><Import><Orders>${orders}</Orders></Import>`;
}

export function describePaymentBatch(batch: PaymentBatch): string {
  const lines = [
    `Source account: ${JSON.stringify(batch.account)} (${batch.accountNumber}/2010)`,
    `Total: ${batch.total} ${batch.currency}; payments: ${batch.payments.length}`,
    'Standard domestic transfers (431001). Upload still requires authorization in Fio banking.',
  ];
  for (const [index, payment] of batch.payments.entries()) {
    lines.push(
      `${index + 1}. Recipient: ${payment.recipientAccount}/${payment.bankCode}; amount: ${payment.amount} CZK; date: ${payment.date}`,
      `   Variable symbol: ${JSON.stringify(payment.variableSymbol ?? '')}; constant symbol: ${JSON.stringify(payment.constantSymbol ?? '')}; specific symbol: ${JSON.stringify(payment.specificSymbol ?? '')}`,
      `   Message: ${JSON.stringify(payment.message ?? '')}; comment: ${JSON.stringify(payment.comment ?? '')}`,
    );
  }
  return lines.join('\n');
}

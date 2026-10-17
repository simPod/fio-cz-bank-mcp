import { XMLParser, XMLValidator } from 'fast-xml-parser';
import * as z from 'zod/v4';
import type { BankClient, ImportResult, Statement, Transaction } from './contracts.js';
import { FioError } from './errors.js';

const baseUrl = 'https://fioapi.fio.cz/v1/rest';
const maxResponseBytes = 10 * 1024 * 1024;
const unsigned = z.string().regex(/^\d+$/);
const decimal = z.string().regex(/^-?\d+(?:\.\d+)?$/);
const currency = z.string().regex(/^[A-Z]{3}$/);
const text = z.union([
  z.string(),
  z.object({ '#text': z.string().optional() }).transform((value) => value['#text'] ?? ''),
]);
const list = <T extends z.ZodType>(item: T) => z.union([z.array(item), item]).transform((value) => Array.isArray(value) ? value : [value]);
const transactionSchema = z.object({
  column_22: text.pipe(unsigned),
  column_0: text.pipe(z.string().regex(/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?|[+-]\d{2}:\d{2})?$/)),
  column_1: text.pipe(decimal),
  column_14: text.pipe(currency),
  column_2: text.optional(),
  column_10: text.optional(),
  column_3: text.optional(),
  column_12: text.optional(),
  column_5: text.optional(),
  column_4: text.optional(),
  column_6: text.optional(),
  column_7: text.optional(),
  column_16: text.optional(),
  column_25: text.optional(),
  column_8: text.optional(),
  column_9: text.optional(),
  column_18: text.optional(),
  column_26: text.optional(),
  column_27: text.optional(),
  column_17: text.pipe(z.union([unsigned, z.literal('')])).optional(),
});
const statementSchema = z.object({
  AccountStatement: z.object({
    Info: z.object({
      accountId: unsigned,
      bankId: z.string().regex(/^\d{4}$/).optional(),
      currency,
      iban: z.string().regex(/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/),
      openingBalance: decimal,
      closingBalance: decimal,
    }),
    TransactionList: z.union([z.literal(''), z.strictObject({ Transaction: list(transactionSchema).optional() })]).optional(),
  }),
});
const status = z.enum(['ok', 'warning', 'error', 'fatal']);
const importMessage = z.object({ '#text': z.string().optional(), '@_status': status.optional(), '@_errorCode': unsigned.optional() });
const importSchema = z.object({
  responseImport: z.object({
    result: z.object({
      errorCode: unsigned,
      status,
      idInstruction: list(unsigned).optional(),
      message: list(z.string()).optional(),
    }),
    ordersDetails: z.union([z.literal(''), z.object({
      detail: list(z.object({
        '@_id': unsigned.optional(),
        messages: z.union([z.literal(''), z.object({
          message: list(z.union([
            z.string().transform((message) => ({ '#text': message })),
            importMessage,
          ]).pipe(importMessage)).optional(),
        })]).optional(),
      })).optional(),
    })]).optional(),
  }),
});

function redact(value: string, token: string): string {
  return token ? value.replaceAll(token, '[REDACTED]') : value;
}

function unknownOutcome(): FioError {
  return new FioError('UNKNOWN_OUTCOME', 'The Fio upload outcome is unknown. Check Fio Internetbanking before resubmitting; a new upload can create duplicate payments.');
}

function parseXml(xml: string): unknown {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);)/.test(xml) || XMLValidator.validate(xml) !== true) {
    throw new Error('Invalid XML');
  }
  return new XMLParser({ parseTagValue: false, parseAttributeValue: false, ignoreAttributes: false, htmlEntities: true }).parse(xml);
}

async function readBody(response: Response): Promise<string> {
  if (!response.body) throw new Error('Missing response body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  let result = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return result + decoder.decode();
      size += value.byteLength;
      if (size > maxResponseBytes) throw new Error('Response too large');
      result += decoder.decode(value, { stream: true });
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export class FioClient implements BankClient {
  private readonly fetch: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly nextUse = new Map<string, number>();

  constructor(options: { fetch?: typeof globalThis.fetch; now?: () => number } = {}) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
  }

  private async request(token: string, path: string, body?: FormData): Promise<string> {
    const now = this.now();
    const remaining = (this.nextUse.get(token) ?? 0) - now;
    if (remaining > 0) {
      throw new FioError('RATE_LIMIT', `Wait ${Math.ceil(remaining / 1000)} seconds before using this Fio token again.`);
    }
    this.nextUse.set(token, now + 30_000);
    const upload = body !== undefined;
    let response: Response;
    try {
      response = await this.fetch(`${baseUrl}${path}`, {
        method: upload ? 'POST' : 'GET',
        ...(body ? { body } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      if (upload) throw unknownOutcome();
      throw new FioError('NETWORK', 'Cannot read Fio account data. The connection failed, timed out, or attempted a redirect.');
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      if (upload && response.status >= 500) throw unknownOutcome();
      const messages: Record<number, string> = {
        404: 'Fio did not find the token or requested resource. Check the token and its validity.',
        409: 'Fio request limit reached. Wait at least 30 seconds before using this token again.',
        413: 'The Fio request is too large. Reduce the date range or payment file size.',
        422: upload
          ? 'Fio cannot process this request. Check its dates, payment data, and token permissions.'
          : 'To read history older than 90 days, temporarily unlock it in Fio Internetbanking under Nastavení / API. The unlock lasts 10 minutes.',
        500: 'Fio returned a server error. Check whether the token is inactive, nonexistent, or expired before trying the account query again.',
      };
      throw new FioError(`HTTP_${response.status}`, messages[response.status] ?? `Fio returned HTTP ${response.status}. No automatic retry was made.`);
    }
    try {
      return await readBody(response);
    } catch {
      if (upload) throw unknownOutcome();
      throw new FioError('RESPONSE', 'Cannot read the Fio response. It was interrupted, invalid, or larger than 10 MiB.');
    }
  }

  async getStatement(token: string, dateFrom: string, dateTo: string): Promise<Statement> {
    const xml = await this.request(token, `/periods/${encodeURIComponent(token)}/${encodeURIComponent(dateFrom)}/${encodeURIComponent(dateTo)}/transactions.xml`);
    try {
      const { AccountStatement: statement } = statementSchema.parse(parseXml(xml));
      const transactions = statement.TransactionList ? statement.TransactionList.Transaction ?? [] : [];
      return {
        accountNumber: statement.Info.accountId,
        currency: statement.Info.currency,
        iban: statement.Info.iban,
        openingBalance: statement.Info.openingBalance,
        closingBalance: statement.Info.closingBalance,
        dateFrom,
        dateTo,
        transactions: transactions.map((row) => {
          const transaction: Transaction = { id: row.column_22, date: row.column_0, amount: row.column_1, currency: row.column_14 };
          const optional = {
            counterAccount: row.column_2,
            counterAccountName: row.column_10,
            bankCode: row.column_3,
            bankName: row.column_12,
            variableSymbol: row.column_5,
            constantSymbol: row.column_4,
            specificSymbol: row.column_6,
            userIdentification: row.column_7,
            message: row.column_16,
            comment: row.column_25,
            type: row.column_8,
            performedBy: row.column_9,
            detail: row.column_18,
            bic: row.column_26,
            payerReference: row.column_27,
            orderId: row.column_17,
          };
          for (const [key, value] of Object.entries(optional)) {
            if (value !== undefined) Object.assign(transaction, { [key]: redact(value, token) });
          }
          return transaction;
        }),
      };
    } catch {
      throw new FioError('RESPONSE', 'Fio returned an invalid account statement. Required account or transaction data is missing or malformed.');
    }
  }

  async importPayments(token: string, xml: string): Promise<ImportResult> {
    const form = new FormData();
    form.set('token', token);
    form.set('type', 'xml');
    form.set('file', new Blob([xml], { type: 'application/xml' }), 'payments.xml');
    form.set('lng', 'en');
    const response = await this.request(token, '/import/', form);
    try {
      const { responseImport } = importSchema.parse(parseXml(response));
      const { result, ordersDetails } = responseImport;
      const batchIds = result.idInstruction ?? [];
      const details: ImportResult['details'] = [];
      if (ordersDetails && typeof ordersDetails !== 'string') {
        for (const detail of ordersDetails.detail ?? []) {
          const messages = detail.messages && typeof detail.messages !== 'string' ? detail.messages.message ?? [] : [];
          for (const message of messages) {
            details.push({ order: detail['@_id'] ?? '', status: message['@_status'] ?? '', errorCode: message['@_errorCode'] ?? '', message: redact(message['#text'] ?? '', token) });
          }
        }
      }
      const accepted = result.status === 'ok' || result.status === 'warning';
      if (accepted) {
        if (!batchIds.length || result.errorCode !== (result.status === 'ok' ? '0' : '2') || details.some((detail) => detail.status === 'error' || detail.status === 'fatal')) throw unknownOutcome();
      } else if (batchIds.length || result.errorCode === '0' || result.errorCode === '2') {
        throw unknownOutcome();
      }
      return { status: result.status, errorCode: result.errorCode, batchIds, messages: (result.message ?? []).map((message) => redact(message, token)), details };
    } catch {
      throw unknownOutcome();
    }
  }
}

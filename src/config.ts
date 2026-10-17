import { readFile } from 'node:fs/promises';
import * as z from 'zod/v4';
import type { Account } from './contracts.js';
import { FioError } from './errors.js';

const configSchema = z.strictObject({
  accounts: z.array(z.strictObject({
    name: z.string().regex(/^[a-z][a-z0-9_-]{0,39}(?![\s\S])/),
    accountNumber: z.string().regex(/^[0-9]{1,10}(?![\s\S])/),
    currency: z.string().regex(/^[A-Z]{3}(?![\s\S])/),
    tokenEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*(?![\s\S])/),
    canSubmit: z.boolean().default(false),
  })).min(1),
});

export async function loadAccounts(env: NodeJS.ProcessEnv = process.env): Promise<Account[]> {
  if (!env.FIO_CONFIG_PATH) throw new FioError('CONFIG', 'Set FIO_CONFIG_PATH to your local accounts JSON file.');
  let input: unknown;
  try {
    input = JSON.parse(await readFile(env.FIO_CONFIG_PATH, 'utf8'));
  } catch {
    throw new FioError('CONFIG', 'Cannot read accounts configuration as JSON.');
  }
  const parsed = configSchema.safeParse(input);
  if (!parsed.success) throw new FioError('CONFIG', 'Invalid accounts configuration. See accounts.example.json; never put token values in this file.');
  const names = new Set<string>();
  return parsed.data.accounts.map((account) => {
    if (names.has(account.name)) throw new FioError('CONFIG', 'Account names must be unique.');
    names.add(account.name);
    if (account.canSubmit && account.currency !== 'CZK') {
      throw new FioError('CONFIG', 'Only CZK source accounts can enable canSubmit. Set other currencies to read-only.');
    }
    const token = env[account.tokenEnv];
    if (!token || !/^[A-Za-z0-9]{64}(?![\s\S])/.test(token)) {
      throw new FioError('CONFIG', `Set a valid 64-character Fio token in ${account.tokenEnv}.`);
    }
    return { name: account.name, accountNumber: account.accountNumber, currency: account.currency, token, canSubmit: account.canSubmit };
  });
}

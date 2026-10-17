export interface Account {
  name: string;
  accountNumber: string;
  currency: string;
  token: string;
  canSubmit: boolean;
}

export interface Transaction {
  id: string;
  date: string;
  amount: string;
  currency: string;
  counterAccount?: string;
  counterAccountName?: string;
  bankCode?: string;
  bankName?: string;
  userIdentification?: string;
  variableSymbol?: string;
  constantSymbol?: string;
  specificSymbol?: string;
  message?: string;
  comment?: string;
  type?: string;
  performedBy?: string;
  detail?: string;
  bic?: string;
  orderId?: string;
  payerReference?: string;
}

export interface Statement {
  accountNumber: string;
  currency: string;
  iban: string;
  openingBalance: string;
  closingBalance: string;
  dateFrom: string;
  dateTo: string;
  transactions: Transaction[];
}

export interface ImportResult {
  status: 'ok' | 'warning' | 'error' | 'fatal';
  errorCode: string;
  batchIds: string[];
  messages: string[];
  details: Array<{ order: string; status: string; errorCode: string; message: string }>;
}

export interface BankClient {
  getStatement(token: string, dateFrom: string, dateTo: string): Promise<Statement>;
  importPayments(token: string, xml: string): Promise<ImportResult>;
}

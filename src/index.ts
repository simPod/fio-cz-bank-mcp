#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { loadAccounts } from './config.js';
import { FioError } from './errors.js';
import { FioClient } from './fio.js';
import { createServer } from './server.js';

try {
  const accounts = await loadAccounts();
  const handle = serveStdio(() => createServer(accounts, new FioClient()), {
    onerror: () => console.error('MCP transport error. Details omitted to protect banking data.'),
  });
  const close = () => { void handle.close(); };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
} catch (error) {
  console.error(error instanceof FioError ? error.message : 'Cannot start fio-cz-bank-mcp. Check local configuration.');
  process.exitCode = 1;
}

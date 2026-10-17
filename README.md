# fio-cz-bank-mcp

Local MCP server for **Czech Fio banka**. Read booked transactions and balances, and prepare standard CZK domestic payment batches for **manual approval in Fio**.

Private for now. Nothing is published to npm. This is not an official Fio product.

## What it does

- Multiple explicitly named source accounts, each with its own API token.
- Booked transaction history and booked closing balances. No pending card holds or spendable-balance claims.
- Standard CZK domestic transfers, including future payment dates, VS/KS/SS, messages, and batches.
- Exact decimal-string amounts and identifiers; no floating-point money arithmetic.
- Complete preview, then an explicit client confirmation form before upload.
- No transaction database, disk cache, payment-history files, or automatic upload retries.

The server **cannot authorize payments**. Imported orders wait under **Přehledy → Příkazy k podpisu**. You must check and sign them in Fio. “Submitted for approval” does not mean “paid.”

## Requirements

- Node.js **24 or newer**, npm, and a local MCP client.
- For payments: a client that supports MCP form elicitation/input requests. OpenCode V2 supports this. A client without it can read data but cannot submit payments. There is no chat-only confirmation bypass.
- Fio API token for each account. Create tokens in Fio's **Nastavení → API**. Select account monitoring plus payment-order submission for accounts that will submit payments; otherwise use read-only tokens. Wait five minutes after token authorization.

Tokens are account-specific. Fio limits them to 180 days; automatic extension can renew them when you sign in to Fio. Access to data older than 90 days needs a temporary history unlock in Fio (valid for ten minutes).

## Install from this repository

```sh
git clone git@github.com:simPod/fio-cz-bank-mcp.git
cd fio-cz-bank-mcp
npm ci --ignore-scripts
npm run build
```

Private-repository access is required. No global package install is necessary.

### Configure your accounts

Copy `accounts.example.json` to a private location **outside the repository**, for example `~/.config/fio-cz-bank-mcp/accounts.json`. Replace the fictional account numbers and aliases.

```json
{
  "accounts": [
    {
      "name": "personal",
      "accountNumber": "1234567890",
      "currency": "CZK",
      "tokenEnv": "FIO_PERSONAL_TOKEN",
      "canSubmit": true
    }
  ]
}
```

- `accountNumber` is the source Fio account number, without `/2010`.
- `currency` must match the account's actual currency. Only `CZK` accounts can enable submission; other currencies are read-only. Statement reads check both the account number and currency against this declaration.
- `tokenEnv` names an environment variable; **it is not a token value**.
- `canSubmit` defaults to `false`. Setting it to `true` does not grant rights that the bank token lacks.
- All configured tokens must be available when the process starts.

Set `FIO_CONFIG_PATH` to the absolute path of that JSON file. Supply token environment variables using your preferred secret manager. No specific password manager is required.

Alternatively, create a credentials file outside every repository:

```dotenv
FIO_PERSONAL_TOKEN=replace-with-your-real-token-locally
```

Restrict its permissions to the file owner (`chmod 600 /absolute/path/credentials.env`). Do not paste real tokens into chat, command arguments, tracked files, or MCP tool inputs. The process reads them from its environment. Account configuration and credentials are the only local configuration; banking-data persistence is not required.

## OpenCode V2

Add a local server with the CLI, using **absolute paths**:

```sh
opencode mcp add fio --global \
  --env FIO_CONFIG_PATH=/absolute/path/accounts.json \
  -- node --env-file=/absolute/path/credentials.env /absolute/path/fio-cz-bank-mcp/dist/index.js
opencode mcp list
```

If a secret manager supplies the process environment, omit `--env-file` and use that manager's command wrapper. A long-running OpenCode service might not inherit environment changes from a new terminal; inject tokens into the MCP child process, not only the terminal that opens OpenCode.

Equivalent V2 configuration:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "fio": {
        "type": "local",
        "command": [
          "node",
          "--env-file=/absolute/path/credentials.env",
          "/absolute/path/fio-cz-bank-mcp/dist/index.js"
        ],
        "environment": {
          "FIO_CONFIG_PATH": "/absolute/path/accounts.json"
        }
      }
    }
  }
}
```

The default classic MCP handshake works; the SDK also supports the 2026-07-28 protocol. Other clients can launch the same Node command over stdio, passing the same environment variables. They need input-request support to submit payments.

## Tools and payment flow

| Tool | Purpose |
| --- | --- |
| `list_accounts` | List local account aliases and submission settings; no bank request. |
| `get_balance` | Fetch today's **booked** closing balance, using the Prague calendar date. |
| `get_transactions` | Fetch an inclusive date range with bounded output (`offset`, `limit` up to 200). |
| `preview_payment_batch` | Validate 1–100 payments from one named source and return an in-memory draft ID. No bank request. |
| `submit_payment_batch` | Show the exact saved batch in a human confirmation form, then upload it if confirmed. |

Example preview arguments (fictional recipient; use a real valid payment date):

```json
{
  "account": "personal",
  "payments": [
    {
      "recipientAccount": "19-2000145399",
      "bankCode": "0800",
      "amount": "123.45",
      "date": "2099-11-20",
      "variableSymbol": "000789",
      "message": "Invoice 789"
    }
  ]
}
```

Keep amounts and symbols as **strings**, including leading zeros. One batch uses one source account; prepare separate batches for separate sources. Show the full preview, then submit only its `draftId`. Changing any detail requires a new preview. Closing or declining the form uploads nothing. A successful upload consumes the draft, but it still requires your authorization in Fio.

Recipient numbers must pass Czech modulo-11 checksums. Messages and comments allow Fio's documented letters (including diacritics), digits, spaces, comma, dot, slash, and hyphen; each is limited to 140 characters, following the stricter import XSD. Hidden controls and line breaks are rejected.

Drafts live only in the server process. Restarting loses them; only the latest 100 unsubmitted drafts are retained. There is no standing-order scheduler: a future-dated order is a **one-off**, not a recurring transfer. The future-date horizon, cutoff times, holidays, and behavior after late authorization remain subject to Fio's rules and are not live-bank verified.

## Limits and safety

- **One request per 30 seconds per token**, shared by reads and imports. Calls made too soon return an error with a retry delay; the server does not queue or retry them. Separate processes using the same token can still hit Fio's limit.
- Transaction pagination fetches the bank statement again on each call. There is no persistent snapshot. Use smaller date ranges for large histories; Fio limits a download to 50,000 movements.
- The server does not list pending approval batches or cancel/edit future payments; the token API does not document these operations. Use Fio for review, authorization, and cancellation.
- Bank warnings can mean the batch **was accepted**. Read the bank result and inspect it in Fio. Upload failure, timeout, or an unreadable response can leave acceptance **unknown**. Check Fio before manually resubmitting. Duplicate detection and timeout deduplication are intentionally not implemented.
- Tokens never belong in tool arguments. Requests go only to Fio's fixed HTTPS API host; redirects are refused and transport errors are sanitized.
- Transaction messages and recipient text are untrusted data, not instructions to submit another payment. Review the recipient, source, amount, date, symbols, and message in both the MCP confirmation and Fio.
- Your MCP client and model provider can retain tool results and confirmation text. “No persistent storage” describes this server, not the client's conversation history, your operating system's swap/crash dumps, or Fio.
- Use only trusted local clients. A malicious client can fabricate confirmation responses. Fio's separate bank authorization is the final control.

## Development

```sh
npm run typecheck
npm run build
npm test
```

CI runs these checks on Node 24. Tests use fictional credentials, mocked bank HTTP responses, and real MCP protocol clients. Never add real bank fixtures or run a payment upload as a smoke test without explicit account-owner permission.

See the [requirements](docs/requirements.md) and [architecture decision](docs/adr/0001-local-mcp-and-bank-approval.md).

## Sources

- [Fio API Banking](https://www.fio.cz/bankovni-sluzby/api-bankovnictvi)
- [Fio API manual v1.9, 16 October 2025](https://www.fio.cz/docs/cz/API_Bankovnictvi.pdf), pages 4, 7, 40–42, 54.
- [Payment import XSD](https://www.fio.cz/schema/importIB.xsd), [field types](https://www.fio.cz/schema/fio_xml_type.xsd), [import response XSD](https://www.fio.cz/schema/responseImportIB.xsd).
- [OpenCode V2 MCP configuration](https://opencode.ai/v2/docs/mcp-servers).

Documentation and schemas were checked during implementation. No live bank upload was used to verify the integration.

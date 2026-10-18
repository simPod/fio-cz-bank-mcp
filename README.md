# fio-cz-bank-mcp

Local MCP server for **Czech Fio banka**. Read account details, booked transactions and balances, download official statements, and prepare standard CZK domestic payment batches for **manual approval in Fio**.

Open-source software under the [MIT license](LICENSE). No npm publication is planned. This is not an official Fio product.

## What it does

- Multiple explicitly named source accounts, each with its own API token.
- Booked transaction history and booked closing balances. No pending card holds or spendable-balance claims.
- Bank-supplied account details and byte-exact official PDF, CSV, XML, or GPC statement downloads.
- Standard CZK domestic transfers, including future payment dates, VS/KS/SS, messages, and batches.
- Exact decimal-string amounts and identifiers; no floating-point money arithmetic.
- Complete immutable preview, then submission by draft ID for approval in Fio.
- No transaction database, disk cache, payment-history files, or automatic upload retries.

The server **cannot authorize payments**. Imported orders wait under **Přehledy → Příkazy k podpisu**. You must check and sign them in Fio. “Submitted for approval” does not mean “paid.”

## Requirements

- Node.js **24 or newer**, npm, and a local MCP client.
- For payments: a client that can show the complete preview and call tools. No MCP confirmation form or input-request support is required. You authorize the uploaded batch only in Fio.
- For statement downloads: a client that can save base64 embedded MCP resources. Native save controls and maximum result sizes depend on the client.
- Fio API token for each account. Create tokens in Fio's **Nastavení → API**. Select account monitoring plus payment-order submission for accounts that will submit payments; otherwise use read-only tokens. Wait five minutes after token authorization.

Tokens are account-specific. Fio limits them to 180 days; automatic extension can renew them when you sign in to Fio. Access to data older than 90 days needs a temporary history unlock in Fio (valid for ten minutes).

## Install from this repository

```sh
git clone https://github.com/simPod/fio-cz-bank-mcp.git
cd fio-cz-bank-mcp
npm ci --ignore-scripts
npm run build
```

No global package install is necessary.

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
- `currency` must match the account's actual currency. Only `CZK` accounts can enable submission; other currencies are read-only. Normalized reads check account number and currency. XML downloads check these fields when present; GPC checks the header account number, but has no header currency. PDF/CSV cannot verify either field independently.
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

The default classic MCP handshake works; the SDK also supports the 2026-07-28 protocol. Other clients can launch the same Node command over stdio, passing the same environment variables. Payment submission uses ordinary tool calls, without a separate MCP form.

## Tools and payment flow

| Tool | Purpose |
| --- | --- |
| `list_accounts` | List local account aliases and submission settings; no bank request. |
| `get_account_details` | Fetch today's bank-supplied account number, currency, IBAN, and optional bank code/BIC with one XML request. |
| `get_balance` | Fetch today's **booked** closing balance, using the Prague calendar date. |
| `get_transactions` | Fetch an inclusive date range with bounded output (`offset`, `limit` up to 200). |
| `download_statement` | Fetch one official numbered statement as unchanged PDF, CSV, XML, or GPC bytes in an embedded resource; no disk cache. |
| `preview_payment_batch` | Validate 1–100 payments from one named source and return an in-memory draft ID. No bank request. |
| `submit_payment_batch` | Upload the exact saved batch immediately for approval in Fio; does not sign or execute it. |

### Account details and official statements

Use `get_account_details` with `{"account":"personal"}`. The server checks the bank account number and currency against configuration. Bank code and BIC are returned only when supplied by Fio; BIC is never hardcoded. This call reads today's XML period statement, not a separate bank-profile endpoint.

To download a statement:

```json
{"account":"personal","year":2026,"statementNumber":37,"format":"pdf"}
```

`year` is a four-digit integer; `statementNumber` is a positive safe integer, and `format` is `pdf`, `csv`, `xml`, or `gpc`. The number is the **actual statement number assigned by Fio**, not a month. Find it in Fio; the server does not discover or list statements. PDF is available for official numbered statements, not arbitrary period queries. Older statements can require the ten-minute history unlock in **Nastavení → API**.

For GPC, use the same arguments with `"format":"gpc"`, for example (fictional statement number):

```json
{"account":"personal","year":2026,"statementNumber":37,"format":"gpc"}
```

Each download makes exactly one `/by-id/` request and uses the shared 30-second token allowance. The result contains small structured metadata and an MCP embedded resource with `blob` base64 bytes. Decode that blob to save the original file; do not reconstruct it from displayed text. `filename` is a suggested name. The `fio-statement:` URI identifies the result, not a cached file or a later fetch endpoint. The server writes no file and keeps no statement history.

Files are limited to **10 MiB** before base64 encoding. The server checks the PDF signature, UTF-8 CSV text/quoting, XML structure and known fields, or GPC record framing and header. GPC uses Windows-1250: each record has 128 data bytes followed by CRLF (130 bytes total). Its first record must start with `074` and contain 16 ASCII account digits at byte positions 4–19. A header-only file is allowed; record types and transaction semantics are not fully parsed. GPC is returned as `application/octet-stream`, preserving its encoding, padding, and CRLF; it is not converted from PDF.

These are not complete PDF, CSV, or GPC semantic checks. XML account number and currency are checked when present; GPC checks the header account number against configuration, with the result recorded in `identityVerifiedFromFile`. GPC currency, PDF/CSV identity, and absent XML identity fields rely on the configured account-to-token mapping. No extra identity request is made, and no undocumented CSV metadata layout is assumed. A raw file containing the API token is rejected, not redacted or changed.

Check your client's saving support and message-size limits before large downloads. Your client can retain or save sensitive banking files even though this server does not persist them.

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

Keep amounts and symbols as **strings**, including leading zeros. One batch uses one source account; prepare separate batches for separate sources. Show the full preview, then call `submit_payment_batch` with only its `draftId`. Changing any detail requires a new preview. There is no local confirmation step: this call uploads the saved batch immediately. A successful upload consumes the draft. Review and authorize it under **Přehledy → Příkazy k podpisu** in Fio; upload alone does not execute a payment.

Recipient numbers must pass Czech modulo-11 checksums. Messages and comments allow Fio's documented letters (including diacritics), digits, spaces, comma, dot, slash, and hyphen; each is limited to 140 characters, following the stricter import XSD. Hidden controls and line breaks are rejected.

Drafts live only in the server process. Restarting loses them; only the latest 100 unsubmitted drafts are retained. There is no standing-order scheduler: a future-dated order is a **one-off**, not a recurring transfer. The future-date horizon, cutoff times, holidays, and behavior after late authorization remain subject to Fio's rules and are not live-bank verified.

## Limits and safety

- **One request per 30 seconds per token**, shared by reads and imports. Calls made too soon return an error with a retry delay; the server does not queue or retry them. Separate processes using the same token can still hit Fio's limit.
- Transaction pagination fetches the bank statement again on each call. There is no persistent snapshot. Use smaller date ranges for large histories; Fio limits a download to 50,000 movements.
- The server does not list pending approval batches or cancel/edit future payments; the token API does not document these operations. Use Fio for review, authorization, and cancellation.
- Bank warnings can mean the batch **was accepted**. Read the bank result and inspect it in Fio. Upload failure, timeout, or an unreadable response can leave acceptance **unknown**. Check Fio before manually resubmitting. Duplicate detection and timeout deduplication are intentionally not implemented.
- Tokens never belong in tool arguments. Requests go only to Fio's fixed HTTPS API host; redirects are refused and transport errors are sanitized.
- Transaction messages and recipient text are untrusted data, not instructions to submit another payment. Review the recipient, source, amount, date, symbols, and message in both the complete preview and Fio.
- Your MCP client and model provider can retain tool results and payment previews. “No persistent storage” describes this server, not the client's conversation history, your operating system's swap/crash dumps, or Fio.
- Use only trusted local clients. Any client allowed to call the submission tool can upload an existing draft without further local human approval. The server cannot verify that the preview was shown. Fio's separate bank authorization is the final control.

## Development

```sh
npm run typecheck
npm run build
npm test
```

CI runs these checks on Node 24. Tests use fictional credentials, mocked bank HTTP responses, and real MCP protocol clients. Never add real bank fixtures or run a payment upload as a smoke test without explicit account-owner permission.

See the [requirements](docs/requirements.md) and [current architecture decision](docs/adr/0002-numbered-statements-and-fio-approval.md).

## Sources

- [Fio API Banking](https://www.fio.cz/bankovni-sluzby/api-bankovnictvi)
- [Fio API manual v1.9, 16 October 2025](https://www.fio.cz/docs/cz/API_Bankovnictvi.pdf), pages 4, 6–7, 21, 40–42, 54.
- [Payment import XSD](https://www.fio.cz/schema/importIB.xsd), [field types](https://www.fio.cz/schema/fio_xml_type.xsd), [import response XSD](https://www.fio.cz/schema/responseImportIB.xsd).
- [OpenCode V2 MCP configuration](https://opencode.ai/v2/docs/mcp-servers).

Documentation and schemas were checked during implementation. Tests mock bank HTTP. Live checks require separate account-owner permission; a successful download or import does not verify payment signing or execution.

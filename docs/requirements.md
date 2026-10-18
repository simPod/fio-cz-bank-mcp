# First-version product requirements

## Goal

Let a user inspect multiple Fio accounts, download official statements, and prepare Czech domestic CZK payments from an MCP conversation, without giving the assistant bank-signing authority.

## Requirements

- Run locally and remain independent of a particular MCP client. Connect OpenCode first.
- Public GitHub repository under the MIT license. No npm publication is planned.
- Explicit source-account aliases and declared currencies, one token per account, read history and booked balances. Only declared CZK accounts can submit; other currencies are read-only. Read responses must match configured account number and currency.
- Read bank-supplied account number, currency, IBAN, and optional bank code/BIC through one current-day XML period request. Reuse account/currency checks; never substitute a hardcoded BIC.
- Download one official numbered statement by account alias, four-digit integer year, positive safe statement number, and PDF/CSV/XML/GPC format. Statement numbers are not months; discovery is not included. Use one bank request, preserve the exact response bytes, and return a bounded embedded MCP resource plus token-free save metadata. Return GPC as `application/octet-stream`, with its Windows-1250 bytes, padding, and CRLF unchanged; do not convert PDF or cache files on disk.
- Reject malformed files, responses larger than 10 MiB, and raw files containing the API token; never alter a raw export. Check XML identity fields when present. For GPC, require 128 data bytes plus CRLF per record, a first-record `074` header, and 16 ASCII account digits at byte positions 4–19; compare that account number with configuration. Allow header-only files without a full semantic parser or restrictions on later record types. GPC has no header currency: currency relies on the configured token mapping, as does PDF/CSV identity. Do not make an extra bank request or assume undocumented CSV metadata. Explain these limits and the temporary history unlock.
- Standard domestic CZK payments with one-off future payment dates, symbols, and text. Batch multiple payments.
- Show the complete exact preview, save an immutable in-memory draft, and submit only by its draft ID. Submission uploads immediately without a local confirmation form or model-controlled confirmation flag. Revalidate payment dates and local account permissions before upload. Only the human reviews and authorizes the imported batch in Fio.
- No persistent banking-data storage. Credentials are supplied through environment variables; no mandatory secret manager.
- Do not implement duplicate-prevention logic for ambiguous upload timeouts: the owner explicitly accepted this risk. Do not automatically retry uploads.
- No real bank payment submissions during development without separate permission.

## Non-goals

Hosted service, shared multi-user endpoint, payment authorization, recurring standing orders, foreign/SEPA payments, pending card data, bank-order cancellation, statement discovery, statement scheduling or disk caching, transaction database, npm publication.

## Acceptance

Tests demonstrate exact money handling, account selection and metadata, source-token mismatch detection on reads, byte-exact statement transport and embedded-resource delivery, file rejection boundaries, domestic-payment validation, and XML imports and bank warnings/errors. Payment tests show preview without bank access, exact saved-draft submission without client form support, rejection of invalid or missing drafts and replacement arguments, current-date revalidation, and consumption of accepted drafts. Setup instructions cover standard local clients and OpenCode V2 without claiming a local confirmation requirement.

Mocked tests do not establish live-bank or native-client behavior. Live bank checks require separate user permission. Verify statement saving and message-size limits in each target client; payment signing and execution remain outside this server.

## Rollout

Make the source repository public under the MIT license. Users configure their own account aliases and tokens outside the repository. No npm release is planned.

Technical decision: [ADR 0002](adr/0002-numbered-statements-and-fio-approval.md), which supersedes the initial design in ADR 0001.

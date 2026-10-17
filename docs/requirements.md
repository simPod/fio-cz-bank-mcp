# First-version product requirements

## Goal

Let a user inspect multiple Fio accounts and prepare Czech domestic CZK payments from an MCP conversation, without giving the assistant bank-signing authority.

## Requirements

- Run locally and remain independent of a particular MCP client. Connect OpenCode first.
- Reusable private GitHub repository, suitable for a later public release. No npm publication or public-release license decision yet.
- Explicit source-account aliases and declared currencies, one token per account, read history and booked balances. Only declared CZK accounts can submit; other currencies are read-only. Read responses must match configured account number and currency.
- Standard domestic CZK payments with one-off future payment dates, symbols, and text. Batch multiple payments.
- Show an exact preview and require explicit human confirmation before upload. The user signs the imported batch separately in Fio.
- No persistent banking-data storage. Credentials are supplied through environment variables; no mandatory secret manager.
- Do not implement duplicate-prevention logic for ambiguous upload timeouts: the owner explicitly accepted this risk. Do not automatically retry uploads.
- No real bank payment submissions during development without separate permission.

## Non-goals

Hosted service, shared multi-user endpoint, payment authorization, recurring standing orders, foreign/SEPA payments, pending card data, bank-order cancellation, transaction database, npm publication.

## Acceptance

Tests demonstrate exact money handling, account selection, source-token mismatch detection on reads, domestic-payment validation, XML imports and bank warnings/errors, and refusal to upload when confirmation is declined, cancelled, unavailable, or supplied as a tool argument. Setup instructions cover standard local clients and OpenCode V2.

Live token validity, bank acceptance of future dates, bank authorization screens, and actual execution require a separately authorized live check. No claim of those checks is made by mocked tests.

## Rollout

Keep the repository private. Users configure their own account aliases and tokens outside the repository. Public release and licensing are separate future decisions.

Technical decision: [ADR 0001](adr/0001-local-mcp-and-bank-approval.md).

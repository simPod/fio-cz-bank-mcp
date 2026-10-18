# 0002: Numbered statements and Fio-only approval

## Status

Accepted. Supersedes [ADR 0001](0001-local-mcp-and-bank-approval.md) and implements the current [product requirements](../requirements.md).

## Context

The initial local server reads account history and prepares domestic CZK payments. Users also need bank-supplied account details and official numbered statements without a banking-data store. The owner removed the extra local confirmation form: payment approval in Fio is sufficient. That form was a local safeguard, not a bank requirement.

## Decision

Retain the local Node.js 24+, TypeScript, official MCP SDK v2 stdio server and its existing boundaries: explicit per-account configuration, environment tokens, fixed Fio HTTPS origin, validated inputs and XML, exact string money and identifiers, integer-minor-unit totals, and standard domestic CZK transfers. Read results must match configured account identity and currency. Local `canSubmit` and CZK checks remain mandatory before preview and upload. The repository uses the MIT license; no npm publication is planned.

Keep the complete immutable in-memory preview and draft-ID submission flow. Submission revalidates payment dates, checks cancellation before upload, and uploads the saved batch immediately for bank approval. Remove MCP confirmation schemas, elicitation, and client input-request requirements; do not replace them with a model-controlled confirmation flag or chat approval. Only the human can review and authorize payments in Fio. An accepted upload, including a bank warning, consumes the draft; bank rejections remain errors.

Read account number, currency, IBAN, and optional bank code/BIC from one current-day XML period response, with the same identity checks as existing reads. Do not hardcode bank-supplied BIC or issue a second identity request.

Download official numbered statements through one by-ID request, selected by account alias, four-digit integer year, positive safe statement number, and PDF/CSV/XML/GPC format. Statement numbers are not months; discovery is outside scope. Bound responses at 10 MiB and return the unchanged bytes as a base64 embedded MCP resource with token-free save metadata. Decode text only for validation and parsing. Reject malformed files and raw token-bearing responses instead of changing the bank's file. Check XML account/currency fields when present; PDF/CSV identity relies on the trusted configured token mapping, not an undocumented metadata layout.

Support Fio's documented GPC export directly, not by converting PDF. Return `application/octet-stream` and preserve Windows-1250 bytes, padding, and CRLF. Validate byte framing only: 128 data bytes plus CRLF per record, first-record `074` header, and 16 ASCII account digits at byte positions 4–19. Compare the header account number with configuration through the existing identity check. Allow a header-only file; do not add a full semantic parser or restrict later record types. GPC has no header currency, so currency relies on the configured token mapping. These boundaries follow the [Fio API manual v1.9](https://www.fio.cz/docs/cz/API_Bankovnictvi.pdf), pages 6–7 and 21.

Persist neither statements nor drafts. Retain memory-only per-token request timing, errors rather than a request queue, no automatic upload retries, and no timeout duplicate-prevention logic. The owner explicitly accepted ambiguous-upload duplicate risk. No new concurrency safeguards are introduced by this decision.

## Consequences

Ordinary MCP tool clients can submit saved drafts without supporting forms. Removing the local confirmation guard lets a client upload an existing draft without further human interaction; the server cannot prove the complete preview was displayed. Fio authorization remains the final payment control, not protection against unwanted draft uploads. Always report accepted imports as “submitted for approval,” never “paid,” and inspect Fio before resubmitting an uncertain upload.

Restarting loses drafts and request timing; separate processes do not coordinate rate limits. No database, scheduler, hosted authentication, or mandatory secret manager is required. Clients and model providers can retain tool results independently of the server.

Statement clients must save embedded resources and allow the base64-expanded message size. Resource URIs identify included results, not persistent retrieval endpoints. PDF signatures and CSV checks do not prove ownership or full document validity; GPC framing checks do not validate transaction semantics or currency. Native saving controls and message-size limits need client-specific verification. Bank-date acceptance and execution require separately authorized bank checks. Standing orders, foreign transfers, and bank-order cancellation remain outside scope.

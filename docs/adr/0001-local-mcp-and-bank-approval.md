# 0001: Local MCP with separate bank approval

## Status

Accepted for the initial private version; superseded by [ADR 0002](0002-numbered-statements-and-fio-approval.md). Implements the [product requirements](../requirements.md).

## Context

Fio's customer token API provides statements and imports payment batches. Imported batches require separate authorization in Fio. The requested integration must work locally with multiple named accounts, keep no banking history on disk, and support clients beyond OpenCode.

## Decision

Use Node.js 24+, TypeScript, and the official MCP SDK v2 over stdio. Expose reads plus immutable in-memory payment previews and a submit operation. Use the SDK's input-request mechanism, including its built-in classic-protocol support, for a human confirmation form. There is no model-controlled confirmation parameter. The final bank signature remains outside the server.

Use Fio XML for reads and imports, parsed with fast-xml-parser and validated at the boundary. Keep money and identifiers as strings; compute payment totals using integer minor units. Restrict imports to standard domestic CZK transfers. Validate structured tool input with Zod. Send requests to a fixed Fio HTTPS origin and redact transport failures.

Read account aliases, account numbers, declared currencies, and token environment-variable references from a local JSON configuration file. Only configured CZK sources can submit, and statement reads must match configured identity and currency. A declaration is trusted local configuration, not a live bank verification at preview time. Read secret tokens from the environment. Do not persist fetched statements or drafts. Use memory-only per-token request timing to respect Fio's 30-second interval, with errors instead of a background queue. Do not retry uncertain uploads or add timeout deduplication, as explicitly accepted by the owner.

## Consequences

No hosted authentication, database, scheduler, or password-manager dependency is required. Restarting loses previews and request timing. Independent server processes do not coordinate rate limits. Clients must support input requests to submit payments and are trusted to display confirmation honestly. They may retain bank data in conversation history.

An accepted upload is not an executed payment; callers must display “submitted for approval.” Ambiguous outcomes require checking Fio before another upload. Standing orders and foreign transfers are outside this version. Bank-date limits and execution behavior still need a separately approved live-bank check.

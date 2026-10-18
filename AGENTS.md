# Project instructions

- Local Node.js 24+ TypeScript MCP server. Use npm and the committed lockfile.
- Keep credentials, personal account configuration, real bank statements, and payment data out of tracked files and logs.
- Never make real bank calls or upload payment orders without explicit user permission for that live operation. Tests must mock bank HTTP.
- Keep money and bank identifiers exact. No floating-point payment arithmetic.
- A payment upload is only submission for approval. Never claim it authorizes or executes a payment.
- Preserve the complete immutable preview/draft-ID flow. Submission uploads for approval in Fio without local confirmation; do not add model-controlled confirmation flags. Only the human can authorize payments in Fio.
- No persistent banking-data storage, automatic upload retries, or timeout duplicate-prevention logic.
- CI runs `npm run typecheck`, `npm run build`, and `npm test`; tests use node:test and native strict assertions.
- Update the requirements and ADR if the agreed architecture changes.

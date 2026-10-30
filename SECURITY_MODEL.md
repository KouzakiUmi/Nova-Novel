# Nova Novel — Threat Model

Repository: `KouzakiUmi/nova-novel`. No infrastructure repository: the product is a local Windows desktop app (Electron + embedded Node server), with no hosted backend. Drafted from the code and the owner's answers; the editable copy also lives on the Devin scan profile "nova-novel threat model".

## System overview and trust boundaries

Nova Novel is a local novel-writing GUI. The Electron main process (`electron/main.cjs`) spawns the Node server (`packages/server/dist/index.js`) with `ELECTRON_RUN_AS_NODE`, a per-launch random pair token (`NOVA_NOVEL_PAIR_TOKEN`, 24 random bytes) and a random loopback port, then opens a sandboxed `BrowserWindow` (`contextIsolation`, `sandbox`, no `nodeIntegration`, `setWindowOpenHandler` deny, `will-navigate` restricted to `127.0.0.1:<port>`). The server keeps all data in `%APPDATA%/Nova Novel` (SQLite DB, `agent/settings.json`, `agent/auth.json`, `agent/volcengine.json`, `appearance.json`). An in-process Pi SDK agent (`@earendil-works/pi-coding-agent`) calls remote LLM providers.

Trust boundaries:
1. **Untrusted content → server**: imported Markdown/TXT manuscripts and JSON backups (`/api/import/*`, `transfer.ts` `parseManuscript`/`parseBackup`, `store.restoreBackup`), possibly received from other people.
2. **LLM provider ↔ server**: model responses (and tool-call arguments) are untrusted; a compromised or malicious provider, or prompt injection embedded in manuscript text, can steer them.
3. **Server → renderer**: content from 1 and 2 is rendered in the React UI inside the Electron window (XSS there runs in a sandboxed renderer but with the pair token and full API access).
4. **Server → ArkCli**: `agent/volcengine/service.ts` runs the official `arkcli` via `execFile` (no shell) for OAuth/quota.

## Components

| Name | Covers |
|---|---|
| **Desktop shell** | `electron/main.cjs`, `electron-builder.yml`, `scripts/package-windows.mjs` |
| **Local API server** | `packages/server/src/app.ts`, `index.ts` (HTTP routing, pair-token/Host/Origin checks, static web serving, SSE `/api/events`) |
| **Domain store & import/export** | `store.ts`, `domain.ts`, `transfer.ts`, `knowledge/` (SQLite, FTS5, backups, ChangeSets) |
| **Agent engine** | `agent/engine.ts`, `agent/tools.ts`, `agent/prompts.ts`, `assist.ts`, `guide.ts`, `workflow-guide.ts`, `workflow/` (Pi sessions, `novel_*` tools, generated candidates, workflow definitions) |
| **Provider & credential management** | `agent/settings.ts`, `agent/usage.ts`, `agent/provider-metadata.ts`, `agent/volcengine/` (API keys, OAuth, ArkCli, quota) |
| **Web client** | `packages/web/src/**`, `packages/shared/src/**` |

## Entry points and who can reach them

- Local HTTP API `/api/*` on `127.0.0.1:<random>`; in the packaged app every request needs `x-nova-novel-token` (timing-safe compare), a loopback `Host`, same-origin `Origin`, and `sec-fetch-site` not `cross-site` (`app.ts` ~L29–41). Only the Electron renderer knows the token.
- File import endpoints: manuscript text and JSON backup (body up to 20 MB, ≤20 000 items per array, 1–500 scenes).
- LLM responses consumed by the agent engine, assist/guide services (cards, ledger extraction `extract_ledger`, workflow definitions, outline proposals).
- Provider OAuth flows (`startOAuth`, `oauthCode`) and ArkCli login.

## Assets (owner: both equally important)

- **Provider credentials**: API keys in `agent/settings.json`, OAuth tokens in `agent/auth.json`, ArkCli identity home, Volcengine IAM AK/SK. Must never appear in HTTP responses, logs, diagnostics or backups.
- **Manuscripts and project data**: SQLite DB (all works, revisions, elements, notes, annotations). Integrity (no silent overwrite/corruption, no writes without author review) and confidentiality (not exfiltrated to unintended parties).

## Attackers that matter (owner's answers)

1. **Malicious imported files** — a crafted Markdown/TXT/JSON backup from someone else: parser abuse, oversized/DoS input, ID collisions overwriting other works, stored XSS in the renderer, injection into SQL/FTS.
2. **Prompt injection via manuscript text or model output** — text that makes the agent leak credentials or other works, escape the frozen task scope of `novel_*` tools, or get content written without author review (ChangeSet/human-review bypass).
3. **Compromised or malicious model provider** — hostile responses/tool calls: oversized output, malformed JSON, scope escape through tool arguments, renderer XSS, writes bypassing review, exfiltration via outbound URLs.

Attackers the owner did **not** select (lower priority): malicious websites in the user's browser (CSRF / DNS rebinding against the local server) and other local processes or users on the same machine.

## Existing controls

- Loopback-only listen (`index.ts` refuses non-loopback `NOVA_NOVEL_HOST`); pair token; Host/Origin/Sec-Fetch-Site checks.
- Static serving path-traversal check (`serveWeb`, `startsWith(webRoot + sep)`), `nosniff`.
- **Defense-in-depth response headers** (`app.ts` `SECURITY_HEADERS`, applied to API JSON and `serveWeb`): strict `Content-Security-Policy` (`default-src 'self'`, `script-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'self'`; `style-src-attr 'unsafe-inline'` only for React inline style), `X-Frame-Options: DENY`, `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`. Front-end template has no inline scripts, so the policy is enforceable.
- **Fail-closed pair token** (`index.ts`): inside the Electron runtime (`process.versions.electron`), if `NOVA_NOVEL_PAIR_TOKEN` is missing the server refuses to start rather than serving unauthenticated requests. Plain Node dev mode (no Electron) is still allowed to run without a token.
- Agent: custom ResourceLoader (no extensions/skills/context files), no built-in coding tools, only 9 read-only `novel_*` tools bound to the frozen task scope.
- Candidate text goes through ChangeSet + human review; decisions bound to task/artifact/text hash, idempotent `decisionId`.
- Secrets files written with mode `0o600`; ArkCli raw output hidden on error; `execFile` without shell, absolute non-`.cmd/.bat` path required for `NOVA_NOVEL_ARKCLI_PATH`.
- **Data directories created with mode `0o700`** (`index.ts`, `settings.ts`, `engine.ts`, `appearance.ts`): `%APPDATA%/Nova Novel` and its `agent/`, `agent/workspace/`, `agent/sessions/<projectId>/`, plus the SQLite parent dir, are not readable by other local users.
- **Deep backup validation** (`transfer.ts` `parseBackup`): nested fields of scenes, elements, facts and events (e.g. `entity.aliases`, `fact.evidenceIds`, `scene.entityIds`) are type-asserted; a malformed backup returns a clear `INVALID_BACKUP` error instead of an uncaught exception / 500 that could leak internals.
- Backups exclude provider settings, API keys, pair token and OAuth credentials; restore creates a new project with remapped IDs.
- Electron renderer sandboxed, navigation and new windows blocked.

## Out of scope / accepted risk

- **Dev mode** (`pnpm dev`, server started without `NOVA_NOVEL_PAIR_TOKEN`): out of scope. Only the packaged Electron app matters.

## Open questions

- Is the app ever distributed to multi-user machines where `%APPDATA%` permissions matter? (Partially addressed: data directories are now created `0o700` and secret files `0o600`, reducing cross-user readability. Other local users remain out of scope as attackers; a shared machine still relies on OS account isolation.)
- Auto-update / code-signing of the Windows installer is not covered by this model.

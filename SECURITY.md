# Security

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: **Security → Report a vulnerability** on this repository. Do not open a public issue.

## What to keep in mind

Loop Engineering starts coding agents that can read and write files, run commands and push to your repositories. It is built to run on one machine you control:

- The server and dashboard bind to loopback by default, and the dashboard has no login in that mode. Do not forward or expose them. See [Local-only operation](docs/reference.md#local-only-operation).
- Sessions and agent jobs run as your OS user with your real `HOME`, so credentials stored under it can be reached. Don't point the loop at a repository that takes outside input (forks, public issues) without a sandboxed job environment.
- With the PR loop on, the loop opens and merges a revert PR whenever a deploy fails, and with auto-merge on it also merges PRs without asking. Both can trigger production deploys.
- A project's env files are copied into every worktree and given to its jobs. Keep only test credentials in env files of repos the loop works on.
- With the email channel on, anyone on `EMAIL_ALLOWLIST` can start work by email, as you can from Telegram. Mail counts only when Gmail authenticated the sender (DMARC or DKIM), but a sender's own mailbox being taken over is not something it can detect: keep the list short.
- Secrets belong in `.env` (gitignored), which the server and the dashboard both read. `.env.example` lists the variables.

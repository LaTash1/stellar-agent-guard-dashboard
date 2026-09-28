# Contributing

`stellar-agent-guard-dashboard` is the operator console: a pure client-side Next.js app
that holds no keys and runs no server code, so most changes are UI, client-side Soroban
RPC, or tests.

## Shared conventions

Commit style, the one-commit-per-logical-unit **per file** rule, the branch lifecycle
(feature branch → PR → delete after merge, `main` only), and the issue label taxonomy are
defined once for this org in the
[`stellar-agent-guard-sdk` CONTRIBUTING.md](https://github.com/aigbagbobila/stellar-agent-guard-sdk/blob/main/CONTRIBUTING.md).
Read that first; this page only adds what is specific to the dashboard.

## Local gates before pushing

```bash
npm ci
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm test            # node --test (unit suite)
npm run build       # Next.js production build
```

Two extra scripts are not part of the CI gate:

- `npm run prove:phase3` — re-runs the live testnet proof against the real deployed
  contract; needs funded testnet keypairs.
- `npm run inspect` — read-only dump of a deployed instance's on-chain state.

### Lockfile ride-along rule

`package-lock.json` is committed and is the reproducibility contract (`npm ci` is the
gate that proves it). Lockfile changes therefore ride along with the PR that caused
them — a dependency-adding or dependency-bumping PR commits its own lockfile diff in
the same commit — and separate lockfile-only PRs are not opened. The same applies to
`npm audit fix` output: run it as part of the change that motivates it, never as a
standalone lock churn. Never run `npm audit fix --force` (it can jump majors); a fix
that requires a breaking upgrade is its own issue, argued on its own.

## Branch protection and CI

`main` is protected by the `main-protection` ruleset, and the required status check is
named exactly **`ci`**. The `ci` workflow runs typecheck, lint, the unit tests, the
production build, and a dedicated step that re-checks the enforcement-scope statement in
`README.md` and `SPEC.md` against the canonical constant in `lib/guard/network.ts`
(`tests/unit/scopeStatement.test.ts`). Rewording the boundary fails CI, which is the
point — see [Enforcement scope](README.md#enforcement-scope--read-this-before-relying-on-the-caps).

## Issues

- Backlog: <https://github.com/aigbagbobila/stellar-agent-guard-dashboard/issues>
- The org-wide `tier:` / `scope:` label taxonomy is described in the shared
  CONTRIBUTING.md linked above; this repo's scope label is `scope:dashboard`.

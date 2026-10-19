# Security Policy & Bug Bounty Program

We welcome reports from external security researchers. This document defines
scope, how to report, and what to expect in return.

## Scope

In scope:

- `api/` — REST + WebSocket gateway, authentication, rate limiting,
  governance/multi-sig routes.
- `services/aggregator/` — price aggregation, oracle-source ingestion,
  outbound request handling (SSRF surface).
- `services/vault_manager/` — Stellar vault/treasury management.
- Deployed Soroban contracts (oracle, governance, multi-sig, proxy) at their
  published mainnet/testnet addresses (see `DEPLOY.md`).
- Infrastructure-as-code in this repository (CI/CD workflows, deploy scripts)
  where a finding demonstrates a concrete exploit path.

Out of scope:

- Denial-of-service via brute-force volume (rate-limit bypass logic itself is
  in scope; simply flooding an endpoint is not).
- Findings that require physical access to a maintainer's device or social
  engineering of maintainers/users.
- Third-party services we depend on but don't operate (e.g. upstream oracle
  data providers, cloud provider infrastructure) — report those upstream.
- Issues already tracked in open GitHub issues or previously reported.

## Safe harbor

We will not pursue legal action against, or refer to law enforcement,
researchers who:

- Make a good-faith effort to avoid privacy violations, data destruction, and
  service disruption during testing.
- Only interact with accounts, data, and contract state they own or are
  explicitly authorized to test (use testnet for any exploratory testing that
  could affect on-chain state).
- Report findings promptly through the channel below and give us reasonable
  time to remediate before any public disclosure.

Testing that stays within this policy is authorized; we consider it
compliant with the Computer Fraud and Abuse Act (and equivalent regional
laws) and exempt from DMCA anti-circumvention claims where applicable.

## Reporting a vulnerability

Email **security@stellar-unified-oracle.example** with:

- Affected component/contract address and a description of the issue.
- Steps to reproduce (proof-of-concept preferred; testnet transaction hash if
  applicable).
- Impact assessment (what an attacker gains).

Do not open a public GitHub issue for a security vulnerability. Reports are
triaged within 3 business days; you'll receive an acknowledgment and a
tracking reference.

> Replace the intake address above with the team's managed triage inbox or
> bounty-platform-provided address before this policy goes live.

## Severity and reward tiers

| Severity | Example | Reward range |
|---|---|---|
| Critical | Admin key compromise, unauthorized fund movement from a vault, arbitrary contract admin takeover | $5,000 – $25,000+ |
| High | Price manipulation bypassing deviation/reputation checks, auth bypass on admin-gated API routes | $1,000 – $5,000 |
| Medium | SSRF/allowlist bypass, rate-limit bypass with material impact, sensitive data exposure | $250 – $1,000 |
| Low | Best-practice gaps, non-exploitable information disclosure | $50 – $250 |

Final severity and reward are determined by the security team based on
actual impact and exploitability; the table above is a starting guide, not a
guarantee.

## Published Response Targets (SLA & SLO)

We commit to the following response targets for valid vulnerability disclosures:

| Severity | Initial Acknowledgment | Triage & Confirmation | Remediation Target |
|---|---|---|---|
| **Critical** | **≤ 24 hours** | **≤ 48 hours** | **≤ 72 hours** (hotfix) / **7 days** (permanent patch) |
| **High** | **≤ 48 hours** | **≤ 5 business days** | **≤ 14 calendar days** |
| **Medium** | **≤ 72 hours** (3 business days) | **≤ 10 business days** | **≤ 30 calendar days** |
| **Low** | **≤ 72 hours** (3 business days) | **≤ 10 business days** | **≤ 60 calendar days** |

- **Coordinated public disclosure:** 90 calendar days after the report is confirmed, or sooner by mutual agreement once a fix is verified and deployed.
- **Full Policy & Procedures:** For comprehensive details on intake, PGP encryption, remediation verification, and publication rules, see [`docs/security/vulnerability-disclosure-policy.md`](docs/security/vulnerability-disclosure-policy.md).
- **RFC 9116 Metadata:** Published at [`/.well-known/security.txt`](.well-known/security.txt) and via API at `/api/v1/security/disclosure-policy`.

## Bounty platform

This program is intake-managed via the email above pending integration with
a managed bounty platform (e.g. Immunefi, HackerOne). Once integrated, this
document will be updated with the platform link and this section will note
the migration.


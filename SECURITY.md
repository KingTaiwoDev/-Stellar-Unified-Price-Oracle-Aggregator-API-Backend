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

## Disclosure SLA

- Acknowledgment: within 3 business days.
- Initial triage/severity assessment: within 10 business days.
- Fix or mitigation for Critical/High findings: targeted within 30 days of
  confirmation.
- Coordinated public disclosure: 90 days after the report is confirmed, or
  sooner by mutual agreement once a fix is deployed. We ask researchers not
  to disclose publicly before this window closes.

## Bounty platform

This program is intake-managed via the email above pending integration with
a managed bounty platform (e.g. Immunefi, HackerOne). Once integrated, this
document will be updated with the platform link and this section will note
the migration.

## Cryptographic key inventory and lifecycle

Owner: Security lead (inventory custodian), with the platform/backend lead
accountable for application keys and the contracts lead accountable for
on-chain keys. The inventory is the authoritative record; no key may be used
in production unless it appears in it.

Every key entry records: key ID, purpose (signing, encryption, verification,
or key-agreement), owning team and named individual, algorithm and parameters
(e.g. Ed25519, secp256k1, AES-256-GCM, HMAC-SHA256), storage location (KMS
alias, HSM slot, sealed secret), environments where it is valid, creation
date, rotation interval, retirement deadline, and the transition plan for any
algorithm change.

Lifecycle rules:

- **Rotation.** Signing and encryption keys rotate at least annually, or
  immediately on suspected compromise, staff departure with access, or a
  change in the owning team. Verification-only public keys are rotated in
  step with their signing counterparts and must overlap for at least one full
  rotation window so verifiers can pick up the new key.
- **Retirement.** Retired keys are marked retired in the inventory, removed
  from active configuration, and retained only for verification of historical
  artifacts until the retention deadline recorded in the inventory. The
  retirement deadline is set at creation time and may only be extended with
  security-lead approval recorded in the inventory.
- **Algorithm transition.** Any move to a new algorithm or parameter set is
  recorded as a transition plan with: the new algorithm, the dual-publish or
  overlap period, the cutover date, the last date the old algorithm is
  accepted, and the rollback path. Transitions follow publish-new, verify-new,
  retire-old ordering; the old algorithm is never removed before the overlap
  period ends.

Review procedure (repeatable, quarterly and on any key change):

1. Export the inventory and diff it against the KMS/HSM key listing and the
   deployed configuration to find unlisted or orphaned keys.
2. Confirm each key has a named owner, purpose, algorithm, rotation interval,
   and retirement deadline; flag any missing field as a finding.
3. Flag keys past their rotation interval or within 30 days of their
   retirement deadline.
4. Confirm each in-flight algorithm transition has a recorded cutover and
   rollback path.
5. Record the review date, reviewer, and findings; open tracking issues for
   every finding and close them before the next review.

Completion evidence: the signed-off review record, the inventory diff output,
and closed tracking issues for all findings.

## Egress deployment-policy verification

Owner: Platform/backend lead. Scope: all outbound destinations used by
`services/aggregator/` (oracle-source ingestion) and any provider or
integration egress from `api/` and `services/vault_manager/`.

Policy: outbound requests are constrained by an environment-specific
allowlist (host, port, scheme) enforced in code and, where available, at the
network layer. Redirects are not followed to destinations outside the
allowlist; each hop is re-validated. DNS resolution is pinned and re-checked
so a DNS change cannot redirect an approved hostname to an unapproved address.

Verification procedure (repeatable, run on every policy change and at least
quarterly):

1. **Normal case.** Confirm each configured provider/integration destination
   resolves and connects successfully under the deployed policy.
2. **Boundary cases.** Confirm destinations at the edge of the allowlist
   (alternate ports, subdomain vs. apex, scheme downgrade) are accepted or
   rejected exactly as the policy specifies.
3. **Failure cases.** Confirm a destination outside the allowlist is
   rejected, a redirect to an off-allowlist host is blocked at the hop, and a
   DNS answer that changes to an unapproved address is rejected.
4. **Drift check.** Diff the deployed allowlist against the policy source of
   truth and flag any destination present in one but not the other.
5. Record the run date, environment, results, and any exceptions; open
   tracking issues for failures and close them before the next run.

Completion evidence: the recorded verification run (normal, boundary, and
failure results) and closed tracking issues for any failures.

## Rollout and rollback guidance

- **Key inventory.** Roll out by populating the inventory from the current
  KMS/HSM listing and deployed configuration before enforcing the "no unlisted
  key in production" rule; announce the enforcement date to owning teams.
  Rollback: if enforcement blocks a legitimate key, add the key to the
  inventory with its owner and lifecycle fields rather than disabling the
  rule; if the inventory itself is unusable, fall back to the last signed-off
  review record and re-run the review procedure.
- **Egress policy.** Roll out in report-only mode first (log would-be
  rejections without blocking), review the drift and rejection reports, then
  switch to enforcing per environment. Rollback: revert to the previous
  allowlist version and report-only mode; the previous version and its
  verification run are retained so the rollback target is known-good.
- **Monitoring and compatibility.** Key rotation and retirement events and
  egress rejections (including blocked redirects and DNS mismatches) emit
  alerts to the security on-call channel. Both procedures are
  backward-compatible with existing deployments: verification-only keys
  overlap their signing counterparts, and egress enforcement only narrows
  destinations already permitted by policy. Operational impact is limited to
  the quarterly review effort and any provider onboarding, which must add the
  destination to the policy source of truth before it is used.

# Rollback and Abort Procedures

## Immediate abort

If chaos affects the wrong namespace or environment:

```bash
export CHAOS_TARGET_ENV=staging
kubectl -n stellar-oracle delete podchaos,networkchaos,stresschaos,dnschaos,workflows --all
kubectl -n stellar-oracle patch schedule weekly-chaos-schedule --type merge \
  -p '{"spec":{"suspend":true}}' 2>/dev/null || true
```

## Suspend weekly schedule

```bash
kubectl -n stellar-oracle patch schedule weekly-chaos-schedule \
  --type merge -p '{"spec":{"suspend":true}}'
```

Re-enable when ready:

```bash
kubectl -n stellar-oracle patch schedule weekly-chaos-schedule \
  --type merge -p '{"spec":{"suspend":false}}'
```

## Uninstall Chaos Mesh

```bash
helm uninstall chaos-mesh -n stellar-oracle
kubectl delete -k k8s/chaos --ignore-not-found
```

## Verify recovery

```bash
kubectl -n stellar-oracle get pods -l 'app in (api,aggregator)'
kubectl -n stellar-oracle get events --sort-by=.lastTimestamp | tail -20
curl -sf http://localhost:3000/api/v1/health
```

## Escalation

1. Suspend all experiments (above)
2. Notify `#stellar-oracle-ops`
3. If staging data is corrupted, redeploy from last known-good overlay
4. Document findings in [incident-review.md](incident-review.md)

## Pre-flight guard

Install and automation scripts refuse to run unless:

```bash
export CHAOS_TARGET_ENV=staging
```

The weekly resilience CronJob additionally verifies `environment=staging` on the namespace label.

---

# Rollout and Rollback: Global Operations and Resilience

This section documents rollout and rollback guidance for the capabilities delivered under the global operations and resilience workstream: deployment cells (#736), feed ownership and regional failover (#737), automated regional failback (#738), and scheduled dependency-failure exercises (#743).

## Compatibility notes

- **Cell topology (#736)** is additive. Existing single-cell deployments map to a single `cell=default` boundary; no feed or consumer migration is required to adopt cells. Cell labels are optional and default to `default` when absent.
- **Feed ownership (#737)** introduces an explicit `primary_region`/`failover_region` per feed. Feeds without an ownership record continue to operate in the legacy single-writer mode until an ownership record is published; the migration is backward compatible.
- **Automated failback (#738)** is gated behind a feature flag (`FAILBACK_AUTOMATION_ENABLED`, default `false`). When disabled, failback remains a manual runbook and no automated authority transfer occurs.
- **Dependency-failure exercises (#743)** are scheduled only in `staging` by default; enabling them in production requires an explicit override and the pre-flight guard above.

## Monitoring signals

| Capability | Signal | Healthy | Alert threshold |
| --- | --- | --- | --- |
| Cells (#736) | `cell_blast_radius_feeds` | ≤ cell feed budget | > budget for 5m |
| Cells (#736) | `cell_consumer_error_rate` | < 1% | > 5% for 10m |
| Ownership (#737) | `feed_authorized_publishers` | exactly 1 per feed | ≠ 1 for 1m |
| Ownership (#737) | `feed_owner_region` | matches ownership record | mismatch for 1m |
| Failback (#738) | `failback_stability_gate` | pass | gate fail blocks transfer |
| Failback (#738) | `failback_authority_transfers_total` | monotonic, no split brain | > 1 concurrent transfer |
| Exercises (#743) | `exercise_recovery_seconds` | within SLO | > SLO budget |
| Exercises (#743) | `exercise_evidence_captured` | 1 per run | 0 for a scheduled run |

## Rollout: deployment cells (#736)

1. Publish cell boundaries (feed → cell mapping) and verify `cell_blast_radius_feeds` stays within budget.
2. Deploy cell-scoped aggregator instances; confirm each cell reports `cell_consumer_error_rate` within SLO.
3. Run a bounded cell-failure exercise (see #743 procedure) to confirm failures stay within the cell.

**Rollback a cell deployment:**

```bash
# Drain a cell and revert to the previous cell assignment
kubectl -n stellar-oracle scale deploy/aggregator-cell-<cell> --replicas=0
kubectl -n stellar-oracle label deploy/aggregator-cell-<cell> cell=default --overwrite
# Restore the previous feed→cell mapping from the last known-good overlay
kubectl apply -k k8s/overlays/<last-known-good>
```

Verify `cell_blast_radius_feeds` returns to baseline and `feed_authorized_publishers` remains exactly 1 per feed.

## Rollout: feed ownership and regional failover (#737)

1. Publish ownership records (`primary_region`, `failover_region`) per feed.
2. Confirm `feed_owner_region` matches the ownership record and `feed_authorized_publishers` is exactly 1.
3. Exercise a regional failover in staging and verify a single authorized publisher during the transition.

**Rollback:**

```bash
# Revert ownership records to the previous revision
kubectl apply -k k8s/overlays/<last-known-good>/ownership
```

If a split-brain is detected (`feed_authorized_publishers` ≠ 1), immediately suspend publishing in the non-authoritative region and follow the escalation steps above.

## Automated failback runbook (#738)

Failback proceeds only when all stages pass; any failure aborts and leaves authority with the current owner.

1. **Stability gating** — wait for the configured stability window; require `failback_stability_gate=pass` and healthy error/latency SLOs in the target region.
2. **Reconciliation** — reconcile feed state between regions; require zero unresolved divergence before proceeding.
3. **Authority transfer** — transfer traffic and publishing authority atomically; verify `feed_authorized_publishers` is exactly 1 throughout and `failback_authority_transfers_total` shows no concurrent transfers.

**Abort conditions:** stability gate fails, reconciliation divergence remains, or more than one authorized publisher is observed. On abort, authority stays with the current owner and an alert fires.

**Rollback:** set `FAILBACK_AUTOMATION_ENABLED=false` to revert to the manual runbook; the current owner retains authority.

## Scheduled dependency-failure exercises (#743)

Run bounded exercises for database, cache, provider, and network dependencies on the weekly schedule. Each run:

1. Applies a bounded fault within the staging cell.
2. Measures `exercise_recovery_seconds` against the SLO budget.
3. Captures evidence (`exercise_evidence_captured=1`) and records findings in [incident-review.md](incident-review.md).

**Rollback / abort:** use the immediate abort and schedule-suspend procedures above; re-enable once the environment is verified healthy.
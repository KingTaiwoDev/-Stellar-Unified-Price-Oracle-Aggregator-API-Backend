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

## Feature rollout and rollback guidance

The sections below cover the resilience and security-assurance changes exercised by
the chaos suite. Each feature is gated by a flag or config value so it can be
rolled out incrementally and reverted without a redeploy of unrelated components.
All flags default to their pre-change behaviour so that a rollback is always a
single config flip.

### Feed-level replication lag thresholds (#739)

**Owner:** Global operations and resilience.

**Rollout**

1. Deploy with `FEED_LAG_THRESHOLDS_ENABLED=false` (default). Lag is still
   measured and exported as metrics, but no threshold alerts fire.
2. Enable in staging: `FEED_LAG_THRESHOLDS_ENABLED=true`. Observe
   `feed_replication_lag_seconds{feed,region}` and
   `feed_missing_sequence_total{feed,region}` for at least one full replication
   cycle. Confirm thresholds are tied to consumer impact (consumer-visible
   staleness budget), not raw feed cadence.
3. Enable per feed in production by adding the feed to
   `FEED_LAG_THRESHOLD_FEEDS` (comma-separated allowlist). Feeds not listed keep
   the pre-change behaviour.
4. Validate missing-sequence detection against a known gap in staging before
   enabling it in production (`FEED_MISSING_SEQUENCE_ALERT=true`).

**Rollback**

- Disable alerting only: set `FEED_LAG_THRESHOLDS_ENABLED=false`. Metrics remain
  available for post-incident analysis.
- Disable for a single feed: remove it from `FEED_LAG_THRESHOLD_FEEDS`.
- Full revert: redeploy the previous overlay; no schema or data migration is
  involved, so rollback is immediate and lossless.

**Monitoring:** watch `feed_replication_lag_seconds` p50/p95/p99 per feed and
region, `feed_missing_sequence_total`, and alert-fire rate. A spike in
missing-sequence alerts immediately after enablement usually indicates a
threshold set below the feed's normal gap tolerance.

### Feed-health routing (#740)

**Owner:** Global operations and resilience.

**Rollout**

1. Deploy with `FEED_HEALTH_ROUTING_ENABLED=false` (default). Routing continues
   to use region health only.
2. Enable in staging: `FEED_HEALTH_ROUTING_ENABLED=true`. Verify deterministic
   failover by injecting feed staleness/integrity faults via the chaos suite and
   confirming consumers move to a healthy feed in a bounded, repeatable order.
3. Enable in production behind a canary consumer group first
   (`FEED_HEALTH_ROUTING_CANARY=true`), then widen to all consumers.

**Rollback**

- Set `FEED_HEALTH_ROUTING_ENABLED=false` to return to region-only routing. This
  is the primary kill switch and takes effect on the next routing decision.
- If a specific feed is misclassified, pin it healthy via
  `FEED_HEALTH_ROUTING_OVERRIDES` while investigating.
- Full revert: redeploy the previous overlay. Routing state is derived, not
  persisted, so no cleanup is required.

**Monitoring:** track routing decisions per feed
(`feed_routing_decisions_total{feed,reason}`), failover latency, and consumer
error rate. A rise in failover events without a corresponding feed-health
degradation indicates a misconfigured freshness or integrity signal.

### Egress destination policy enforcement (#750)

**Owner:** Security and privacy assurance.

**Rollout**

1. Deploy in **audit-only** mode: `EGRESS_POLICY_ENFORCE=false`. All outbound
   destinations (provider and integration egress) are evaluated and logged via
   `egress_policy_decisions_total{destination,decision}` but not blocked.
2. Review audit logs in staging and confirm every legitimate destination is
   allowlisted, including redirect targets and resolved DNS addresses.
3. Enable enforcement in staging: `EGRESS_POLICY_ENFORCE=true`. Re-run the chaos
   DNS and network experiments to prove redirects and DNS changes cannot bypass
   controls (redirects are re-evaluated against policy; resolved addresses are
   checked, not just hostnames).
4. Enable enforcement in production after the audit window shows zero unexpected
   denials.

**Rollback**

- Revert to audit-only: set `EGRESS_POLICY_ENFORCE=false`. Traffic is no longer
  blocked; decisions continue to be logged.
- If a single destination is wrongly denied, add it to
  `EGRESS_POLICY_ALLOWLIST` rather than disabling enforcement globally.
- Full revert: redeploy the previous overlay. No persistent state is created.

**Monitoring:** alert on `egress_policy_decisions_total{decision="deny"}` rising
above baseline and on any policy-evaluation error. Denials for previously
allowed destinations are the primary signal of an over-tight policy.

### Cryptographic key inventory and lifecycle (#751)

**Owner:** Security and privacy assurance.

**Rollout**

1. Deploy the inventory in read-only mode: `KEY_INVENTORY_ENFORCE=false`. The
   inventory records signing, encryption, and verification keys with owner,
   rotation, retirement, and algorithm-transition metadata, but does not gate
   operations.
2. Populate owner mappings and lifecycle dates for every key in staging; confirm
   the inventory reports no unowned or overdue keys.
3. Enable enforcement in staging: `KEY_INVENTORY_ENFORCE=true`. Verify that keys
   past their rotation or retirement deadline raise alerts and that algorithm
   transitions follow the documented procedure.
4. Enable in production once the inventory is complete and owner-mapped.

**Rollback**

- Set `KEY_INVENTORY_ENFORCE=false` to stop gating operations while keeping the
  inventory populated and observable.
- Key material itself is never modified by enabling or disabling the inventory;
  rotation remains a separate, explicitly triggered operation.
- Full revert: redeploy the previous overlay. The inventory is advisory metadata
  and does not require data migration to roll back.

**Monitoring:** track `key_inventory_keys_total{type,state}`,
`key_rotation_overdue_total`, and `key_algorithm_transition_pending_total`.
Unowned keys or overdue rotations are the primary signals requiring owner
follow-up.

### Cross-cutting verification after any rollback

```bash
kubectl -n stellar-oracle get pods -l 'app in (api,aggregator)'
curl -sf http://localhost:3000/api/v1/health
```

Confirm the relevant feature flag has reverted to its default, that no
unexpected `deny` or alert traffic remains, and record the rollback in
[incident-review.md](incident-review.md).
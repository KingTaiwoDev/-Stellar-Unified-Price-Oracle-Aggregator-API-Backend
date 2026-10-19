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

# Regional Release Train: Ordering, Promotion, Halt, and Surge Controls

This section defines how a staged release train is coordinated across regions so
that regional rollouts never outrun verified health. It covers release ordering,
promotion criteria, automatic halt conditions, surge limits during failover and
recovery, and the rollback procedures for regional rollouts.

**Owner:** Global Operations and Resilience team (`#stellar-oracle-ops`).
**Scope:** All production regions in the release train (see ordering below).
**Completion evidence:** Promotion gates recorded per region in the release
train log, halt events captured as alerts, and the repeatable review procedure
in [Verification and review](#verification-and-review).

## Release ordering (staged train)

Regions are promoted in fixed waves. A wave may not begin until the previous
wave has met promotion criteria and its soak window has elapsed.

| Wave | Regions | Soak before next wave |
|------|---------|-----------------------|
| 0 | `staging` | 30 min |
| 1 | `canary` (single low-traffic region) | 60 min |
| 2 | `us-east`, `eu-west` | 120 min |
| 3 | remaining regions | — (final wave) |

Rules:

- Waves advance strictly in order; no region may skip a wave.
- A region in a later wave is blocked while any earlier-wave region is halted.
- The train is driven by the release train controller; manual promotion is only
  permitted with an explicit override recorded in the train log.

## Promotion criteria

A region is promoted to the next wave only when **all** of the following hold
for the full soak window:

- Error rate ≤ baseline + 0.5% (5xx and gRPC `UNAVAILABLE`).
- p99 latency ≤ baseline × 1.2.
- Health checks green (`/api/v1/health` and dependency probes).
- No active automatic halt condition (below).
- Surge budget usage within limits (below).

If any criterion is unmet at the end of the soak window, the train halts at the
current wave and the region is held for investigation.

## Automatic halt conditions

The train halts automatically — and no further wave is promoted — when any of
the following is observed in any active region:

- Error rate exceeds baseline + 2% for 5 consecutive minutes.
- p99 latency exceeds baseline × 1.5 for 5 consecutive minutes.
- Health check failures on ≥ 2 consecutive probes.
- Surge budget or provider quota usage ≥ 90% of the configured ceiling.
- A rollback is triggered in any region.

On halt, the controller:

1. Stops promoting new waves.
2. Emits a `release_train_halted` alert to `#stellar-oracle-ops`.
3. Records the triggering region and condition in the train log.
4. Leaves already-promoted regions running unless their own halt condition fires.

Resuming requires the halt condition to clear and an explicit operator
acknowledgement recorded in the train log.

## Surge limits during failover and recovery

To protect recovery from traffic and cost spikes, explicit surge limits apply
during failover and recovery:

- **Traffic surge cap:** recovery traffic per region is capped at the configured
  surge ceiling (default 1.5× steady-state). Excess requests are shed with
  `429`/`503` and a `Retry-After` header rather than queued unboundedly.
- **Cost/quota ceiling:** provider quota and cost budgets are tracked; at 80%
  usage an early-warning alert fires, and at 90% the train halts (above) and
  degradation begins.
- **Safe degradation order:** shed non-critical traffic first (analytics,
  batch), then reduce fan-out, then fail over to the next region — never exceed
  the surge ceiling to "catch up".
- **Alerts:** `surge_budget_warning` (80%) and `surge_budget_critical` (90%)
  route to `#stellar-oracle-ops`.

## Rollback procedures for regional rollouts

Roll back a single region without disturbing the rest of the train:

```bash
# Pin the region back to the last known-good release
kubectl -n stellar-oracle-<region> rollout undo deployment/api
kubectl -n stellar-oracle-<region> rollout undo deployment/aggregator

# Confirm the region is healthy again
kubectl -n stellar-oracle-<region> rollout status deployment/api
curl -sf https://<region>.stellar-oracle.example/api/v1/health
```

Roll back the entire train (halt and revert all active waves):

```bash
# Halt the train first so no further waves promote
kubectl -n stellar-oracle patch releasetrain release-train \
  --type merge -p '{"spec":{"halted":true}}'

# Revert each active region to its last known-good release
for region in canary us-east eu-west; do
  kubectl -n stellar-oracle-$region rollout undo deployment/api
  kubectl -n stellar-oracle-$region rollout undo deployment/aggregator
done
```

After any rollback:

1. Confirm the automatic halt condition has cleared.
2. Notify `#stellar-oracle-ops` and record the rollback in the train log.
3. Document findings in [incident-review.md](incident-review.md).

## Verification and review

This procedure is repeatable and covers normal, boundary, and failure cases:

- **Normal:** a full train promotion through all waves with criteria met.
- **Boundary:** a region held exactly at the soak-window edge and at the 80%/90%
  surge thresholds.
- **Failure:** an injected halt condition mid-train, verifying no later wave
  promotes and the alert fires.

Run the train in `staging` (Wave 0) before any production promotion, and review
the train log and alerts weekly. Compatibility: the surge caps and halt
thresholds are configuration-driven and default to the values above, so existing
regions are unaffected until a train is started. Monitoring: `release_train_halted`,
`surge_budget_warning`, and `surge_budget_critical` alerts plus the per-region
promotion log provide measurable completion evidence.
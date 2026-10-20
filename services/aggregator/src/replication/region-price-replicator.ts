import { config } from '../infrastructure/config';
import { AggregatedPrice } from '../infrastructure/types';
import { LwwPriceRegister, RegionPriceRecord } from './price-crdt';
import { propagateForHop, TraceHeaders } from './trace-context';
import { metrics } from '../infrastructure/metrics';

/**
 * Fencing epoch carried on every replication record (issue #745). The epoch is
 * monotonically increasing per region and is bumped on leader election, so a
 * stale or isolated region that keeps publishing after failover is rejected by
 * peers because its epoch is older than the last epoch seen for that region.
 */
export interface FencedPriceRecord extends Omit<RegionPriceRecord, 'receivedAt' | 'source'> {
  epoch: number;
}

export interface StaleEpochRejection {
  region: string;
  asset: string;
  recordEpoch: number;
  lastSeenEpoch: number;
}

export interface DriftReport {
  maxDriftPercent: number;
  maxStalenessMs: number;
  asset?: string;
  regions: string[];
  regionCount: number;
  peerCount: number;
  hasPeers: boolean;
  driftKnown: boolean;
}

export class RegionPriceReplicator {
  private readonly register = new LwwPriceRegister();
  private epoch: number;
  private readonly lastSeenEpochByRegion = new Map<string, number>();
  private readonly staleEpochRejections: StaleEpochRejection[] = [];

  constructor(initialEpoch = 0) {
    this.epoch = initialEpoch;
  }

  /** Current fencing epoch for this region. */
  getEpoch(): number {
    return this.epoch;
  }

  /**
   * Advance the fencing epoch on leader election. Must be called before the
   * newly elected leader publishes anything so peers can distinguish its
   * records from those of the previous (possibly partitioned) leader.
   */
  advanceEpochOnLeaderElection(nextEpoch?: number): number {
    const candidate = nextEpoch ?? this.epoch + 1;
    if (candidate > this.epoch) {
      this.epoch = candidate;
    }
    return this.epoch;
  }

  /** Last epoch accepted from `region`, if any. */
  getLastSeenEpoch(region: string): number | undefined {
    return this.lastSeenEpochByRegion.get(region);
  }

  /** Rejections recorded for stale-epoch inbound records. */
  getStaleEpochRejections(): StaleEpochRejection[] {
    return [...this.staleEpochRejections];
  }

  mergeLocalPrices(prices: AggregatedPrice[]): void {
    this.register.mergeLocal(config.region.id, prices, this.epoch);
  }

  /**
   * Merge an inbound remote record. Returns `false` (and records a rejection)
   * when the record's epoch is older than the last epoch seen for its region,
   * which fences out stale or isolated publishers after failover.
   */
  mergeRemotePrice(record: FencedPriceRecord): boolean {
    const lastSeen = this.lastSeenEpochByRegion.get(record.region);
    if (lastSeen !== undefined && record.epoch < lastSeen) {
      this.staleEpochRejections.push({
        region: record.region,
        asset: record.asset,
        recordEpoch: record.epoch,
        lastSeenEpoch: lastSeen,
      });
      metrics.increment('replication_stale_epoch_rejected_total', {
        region: record.region,
      });
      return false;
    }

    if (lastSeen === undefined || record.epoch > lastSeen) {
      this.lastSeenEpochByRegion.set(record.region, record.epoch);
    }
    this.register.merge({ ...record, receivedAt: Date.now(), source: 'remote' });
    return true;
  }

  /**
   * Build the outbound replication records for this region's latest prices,
   * stamped with the current fencing epoch.
   */
  buildOutboundRecords(): FencedPriceRecord[] {
    return this.getLocalPrices().map((record) => ({
      region: record.region,
      asset: record.asset,
      price: record.price,
      timestamp: record.timestamp,
      epoch: this.epoch,
      traceparent: record.traceparent,
      tracestate: record.tracestate,
    }));
  }

  getLatestPrices(): RegionPriceRecord[] {
    return this.register.latestAll();
  }

  getLocalPrices(): RegionPriceRecord[] {
    return this.register
      .byRegion(config.region.id)
      .filter((record) => record.source === 'local');
  }

  /**
   * Trace headers to attach to an outbound replication message for `asset`
   * (issue #419). Continues the trace carried by the last inbound record for
   * that asset, or starts a fresh one, and tags this region into `tracestate`.
   */
  outboundTraceHeaders(asset: string, inbound?: TraceHeaders): TraceHeaders {
    const carried = inbound
      ?? this.register
        .byAsset(asset)
        .filter((r) => r.source === 'remote' && r.traceparent)
        .sort((a, b) => b.receivedAt - a.receivedAt)[0];
    return propagateForHop(
      carried ? { traceparent: carried.traceparent, tracestate: carried.tracestate } : undefined,
      config.region.id,
    );
  }

  getDriftReport(now = Date.now()): DriftReport {
    let maxDriftPercent = 0;
    let maxStalenessMs = 0;
    let asset: string | undefined;
    let comparableAssets = 0;
    const regions = new Set<string>();
    const assets = new Set<string>();

    for (const price of this.register.latestAll()) {
      assets.add(price.asset);
    }

    for (const assetName of assets) {
      const records = this.register.byAsset(assetName);
      for (const record of records) {
        regions.add(record.region);
        maxStalenessMs = Math.max(maxStalenessMs, now - record.receivedAt);
      }
      if (records.length < 2) continue;

      const values = records.map((record) => Number(record.price));
      const median = values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
      if (median === 0) continue;

      comparableAssets += 1;
      for (const value of values) {
        const drift = Math.abs(value - median) / median * 100;
        if (drift > maxDriftPercent) {
          maxDriftPercent = drift;
          asset = assetName;
        }
      }
    }

    const regionCount = regions.size;
    const peerCount = regions.has(config.region.id) ? regionCount - 1 : regionCount;

    return {
      maxDriftPercent,
      maxStalenessMs,
      asset,
      regions: Array.from(regions).sort(),
      regionCount,
      peerCount,
      hasPeers: peerCount > 0,
      driftKnown: comparableAssets > 0,
    };
  }
}

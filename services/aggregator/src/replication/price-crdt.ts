import { AggregatedPrice } from '../infrastructure/types';

export interface RegionPriceRecord {
  region: string;
  asset: string;
  price: bigint;
  decimals: number;
  timestamp: number;
  receivedAt: number;
  source: 'local' | 'remote';
  /**
   * Monotonically increasing publisher epoch for the feed (issue #737/#738).
   * Each ownership transfer (failover or failback) increments the epoch so
   * stale publishers can be rejected during transitions.
   */
  epoch?: number;
  /** Region currently authorized to publish the feed. */
  ownerRegion?: string;
  /** W3C trace context carried across the replication bus (issue #419). */
  traceparent?: string;
  tracestate?: string;
}

/**
 * Ownership metadata for a feed (asset) used to enforce a single authorized
 * publisher during failover/failback transitions (issue #737/#738).
 */
export interface FeedOwnership {
  asset: string;
  /** Region currently authorized to publish. */
  ownerRegion: string;
  /** Ordered list of regions eligible to take over, primary first. */
  failoverRegions: string[];
  /** Current publisher epoch; incremented on every authority transfer. */
  epoch: number;
}

export type MergeOutcome = 'applied' | 'stale' | 'not-owner' | 'stale-epoch';

export class LwwPriceRegister {
  private values = new Map<string, RegionPriceRecord>();
  private ownership = new Map<string, FeedOwnership>();

  /**
   * Declare or update ownership metadata for a feed. Increments the epoch when
   * the owner changes so that records from the previous owner become stale.
   */
  setOwnership(ownership: FeedOwnership): void {
    const current = this.ownership.get(ownership.asset);
    if (current && current.ownerRegion === ownership.ownerRegion && ownership.epoch <= current.epoch) {
      // Same owner: keep the highest epoch seen.
      this.ownership.set(ownership.asset, { ...ownership, epoch: current.epoch });
      return;
    }
    this.ownership.set(ownership.asset, { ...ownership });
  }

  /**
   * Transfer publishing authority for a feed to a new region, incrementing the
   * epoch. Used by failover/failback procedures to prevent split brain.
   */
  transferOwnership(asset: string, newOwnerRegion: string, failoverRegions?: string[]): FeedOwnership {
    const current = this.ownership.get(asset);
    const next: FeedOwnership = {
      asset,
      ownerRegion: newOwnerRegion,
      failoverRegions: failoverRegions ?? current?.failoverRegions ?? [],
      epoch: (current?.epoch ?? 0) + 1,
    };
    this.ownership.set(asset, next);
    return next;
  }

  getOwnership(asset: string): FeedOwnership | null {
    return this.ownership.get(asset) ?? null;
  }

  /**
   * Merge a price record using last-writer-wins semantics.
   * The record with the greatest timestamp wins.
   *
   * When ownership metadata exists for the asset, records from a non-owner
   * region or carrying a stale epoch are rejected to prevent split-brain
   * writes during failover/failback transitions (issue #737/#738).
   */
  merge(record: RegionPriceRecord): MergeOutcome {
    const ownership = this.ownership.get(record.asset);
    if (ownership) {
      if (record.ownerRegion !== undefined && record.ownerRegion !== ownership.ownerRegion) {
        return 'not-owner';
      }
      if (record.region !== ownership.ownerRegion) {
        return 'not-owner';
      }
      if (record.epoch !== undefined && record.epoch < ownership.epoch) {
        return 'stale-epoch';
      }
    }

    const key = `${record.region}:${record.asset}`;
    const current = this.values.get(key);

    // LWW: only update if new record has later timestamp
    if (!current || record.timestamp > current.timestamp) {
      this.values.set(key, record);
      return 'applied';
    }
    return 'stale';
  }

  /**
   * Merge local prices into the register. Records are stamped with the current
   * ownership epoch (if any) so remote peers can validate authority.
   */
  mergeLocal(region: string, prices: AggregatedPrice[], now = Date.now()): void {
    for (const price of prices) {
      const ownership = this.ownership.get(price.asset);
      this.merge({
        region,
        asset: price.asset,
        price: typeof price.price === 'bigint' ? price.price : BigInt(price.price),
        decimals: price.decimals,
        timestamp: price.timestamp,
        receivedAt: now,
        source: 'local',
        epoch: ownership?.epoch,
        ownerRegion: ownership?.ownerRegion,
      });
    }
  }

  /**
   * Get the latest (highest timestamp) record for a specific asset across all regions
   */
  latest(asset: string): RegionPriceRecord | null {
    const candidates = Array.from(this.values.values()).filter((record) => record.asset === asset);
    if (candidates.length === 0) return null;
    return candidates.reduce((winner, record) => (
      record.timestamp > winner.timestamp ? record : winner
    ));
  }

  /**
   * Get the latest record for each unique asset
   */
  latestAll(): RegionPriceRecord[] {
    const assets = new Set(Array.from(this.values.values()).map((record) => record.asset));
    return Array.from(assets)
      .map((asset) => this.latest(asset))
      .filter((record): record is RegionPriceRecord => record !== null);
  }

  /**
   * Get all records for a specific asset from all regions
   */
  byAsset(asset: string): RegionPriceRecord[] {
    return Array.from(this.values.values()).filter((record) => record.asset === asset);
  }

  /**
   * Get all records for a specific region
   */
  byRegion(region: string): RegionPriceRecord[] {
    return Array.from(this.values.values()).filter((record) => record.region === region);
  }

  /**
   * Get the number of stored records
   */
  size(): number {
    return this.values.size;
  }

  /**
   * Clear all stored records
   */
  clear(): void {
    this.values.clear();
  }

  /**
   * Clear ownership metadata (used when reconciling state after a transition).
   */
  clearOwnership(): void {
    this.ownership.clear();
  }
}

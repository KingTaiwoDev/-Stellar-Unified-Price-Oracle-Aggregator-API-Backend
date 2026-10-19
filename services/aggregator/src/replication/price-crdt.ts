import { AggregatedPrice } from '../infrastructure/types';

/**
 * Per-feed health signal consumed by the router (issue #740).
 * `freshnessMs` is the age of the most recent accepted update for the feed;
 * `integrity` is a 0..1 score (1 = fully verified, 0 = failed validation).
 */
export interface FeedHealthSignal {
  region: string;
  asset: string;
  freshnessMs: number;
  integrity: number;
  /** Optional explicit region priority; lower value wins. Defaults to 0. */
  regionPriority?: number;
}

export interface FeedRouterConfig {
  /** A feed is considered stale when freshnessMs exceeds this threshold. */
  maxFreshnessMs: number;
  /** A feed is considered corrupt when integrity falls below this threshold. */
  minIntegrity: number;
}

export interface FeedRouteDecision {
  asset: string;
  selectedRegion: string | null;
  reason: 'selected' | 'failover' | 'no_healthy_feed';
  candidates: FeedHealthSignal[];
  decidedAt: number;
}

export interface FeedRouteMetrics {
  feed_route_decisions_total: number;
  feed_route_failovers_total: number;
}

export type FeedRouteLogger = (decision: FeedRouteDecision) => void;

const DEFAULT_CONFIG: FeedRouterConfig = {
  maxFreshnessMs: 30_000,
  minIntegrity: 0.5,
};

/**
 * Routes consumers to a serving region based on per-feed freshness and
 * integrity rather than region health alone. Ordering is deterministic:
 *   1. healthy feeds first (freshness within threshold, integrity above floor)
 *   2. lower freshnessMs wins
 *   3. higher integrity wins
 *   4. lower regionPriority wins
 *   5. lexicographic region name (final deterministic tie-break)
 */
export class FeedHealthRouter {
  private readonly config: FeedRouterConfig;
  private readonly logger?: FeedRouteLogger;
  private metrics: FeedRouteMetrics = {
    feed_route_decisions_total: 0,
    feed_route_failovers_total: 0,
  };
  private lastSelected = new Map<string, string>();

  constructor(config: Partial<FeedRouterConfig> = {}, logger?: FeedRouteLogger) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.logger = logger;
  }

  isHealthy(signal: FeedHealthSignal): boolean {
    return signal.freshnessMs <= this.config.maxFreshnessMs
      && signal.integrity >= this.config.minIntegrity;
  }

  /**
   * Select the serving region for an asset. Returns a decision with
   * `selectedRegion === null` when no healthy feed exists.
   */
  route(asset: string, signals: FeedHealthSignal[], now = Date.now()): FeedRouteDecision {
    const candidates = signals.filter((signal) => signal.asset === asset);
    const healthy = candidates.filter((signal) => this.isHealthy(signal));

    let selectedRegion: string | null = null;
    let reason: FeedRouteDecision['reason'] = 'no_healthy_feed';

    if (healthy.length > 0) {
      const ordered = [...healthy].sort(compareSignals);
      selectedRegion = ordered[0].region;
      const previous = this.lastSelected.get(asset);
      reason = previous !== undefined && previous !== selectedRegion ? 'failover' : 'selected';
      this.lastSelected.set(asset, selectedRegion);
    }

    this.metrics.feed_route_decisions_total += 1;
    if (reason === 'failover') {
      this.metrics.feed_route_failovers_total += 1;
    }

    const decision: FeedRouteDecision = {
      asset,
      selectedRegion,
      reason,
      candidates,
      decidedAt: now,
    };

    if (this.logger) {
      this.logger(decision);
    }

    return decision;
  }

  getMetrics(): FeedRouteMetrics {
    return { ...this.metrics };
  }

  resetMetrics(): void {
    this.metrics = { feed_route_decisions_total: 0, feed_route_failovers_total: 0 };
  }
}

function compareSignals(a: FeedHealthSignal, b: FeedHealthSignal): number {
  if (a.freshnessMs !== b.freshnessMs) return a.freshnessMs - b.freshnessMs;
  if (a.integrity !== b.integrity) return b.integrity - a.integrity;
  const pa = a.regionPriority ?? 0;
  const pb = b.regionPriority ?? 0;
  if (pa !== pb) return pa - pb;
  return a.region < b.region ? -1 : a.region > b.region ? 1 : 0;
}

export interface RegionPriceRecord {
  region: string;
  asset: string;
  price: bigint;
  decimals: number;
  timestamp: number;
  receivedAt: number;
  source: 'local' | 'remote';
  /** W3C trace context carried across the replication bus (issue #419). */
  traceparent?: string;
  tracestate?: string;
}

export class LwwPriceRegister {
  private values = new Map<string, RegionPriceRecord>();

  /**
   * Merge a price record using last-writer-wins semantics.
   * The record with the greatest timestamp wins.
   */
  merge(record: RegionPriceRecord): void {
    const key = `${record.region}:${record.asset}`;
    const current = this.values.get(key);
    
    // LWW: only update if new record has later timestamp
    if (!current || record.timestamp > current.timestamp) {
      this.values.set(key, record);
    }
  }

  /**
   * Merge local prices into the register
   */
  mergeLocal(region: string, prices: AggregatedPrice[], now = Date.now()): void {
    for (const price of prices) {
      this.merge({
        region,
        asset: price.asset,
        price: typeof price.price === 'bigint' ? price.price : BigInt(price.price),
        decimals: price.decimals,
        timestamp: price.timestamp,
        receivedAt: now,
        source: 'local',
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
}

import { config } from '../infrastructure/config';
import { DriftReport } from './region-price-replicator';
import { regionQuarantineState, regionQuarantineTransitionsTotal } from '../observability/metrics';

export interface RegionQuarantineStatus {
  region: string;
  quarantined: boolean;
  reason?: string;
}

export type RegionQuarantineTransition = 'quarantined' | 'recovered';

export interface RegionQuarantineEvaluation extends RegionQuarantineStatus {
  transition: RegionQuarantineTransition | null;
}

/**
 * Per-feed health signal consumed by the quarantine manager. A feed is
 * considered degraded when it is stale (lag beyond the configured threshold)
 * or has a gap in its sequence (missing sequence numbers detected).
 */
export interface FeedHealthSignal {
  feedId: string;
  stale: boolean;
  gapped: boolean;
  lagMs?: number;
  missingSequences?: number;
}

export interface FeedQuarantineStatus {
  feedId: string;
  quarantined: boolean;
  reason?: string;
}

export interface FeedQuarantineEvaluation extends FeedQuarantineStatus {
  transition: RegionQuarantineTransition | null;
}

export interface RegionQuarantineEvaluationWithFeeds extends RegionQuarantineEvaluation {
  feeds: FeedQuarantineEvaluation[];
}

export class RegionQuarantineManager {
  private status: RegionQuarantineStatus = {
    region: config.region.id,
    quarantined: false,
  };

  private feedStatuses = new Map<string, FeedQuarantineStatus>();

  evaluate(report: DriftReport, feedSignals: FeedHealthSignal[] = []): RegionQuarantineEvaluationWithFeeds {
    const previous = this.status.quarantined;
    const driftQuarantined = this.nextState(report);
    const feedEvaluations = this.evaluateFeeds(feedSignals);

    const degradedFeeds = feedEvaluations.filter((f) => f.quarantined);
    const quarantined = driftQuarantined || degradedFeeds.length > 0;

    let reason: string | undefined;
    if (quarantined) {
      if (previous && this.status.reason) {
        reason = this.status.reason;
      } else if (driftQuarantined) {
        reason = `drift ${report.maxDriftPercent.toFixed(4)}% exceeds ${config.region.driftAlertPercent}%`;
      } else {
        reason = `feed degradation: ${degradedFeeds
          .map((f) => `${f.feedId} (${f.reason})`)
          .join(', ')}`;
      }
    }

    this.status = quarantined
      ? { region: config.region.id, quarantined: true, reason }
      : { region: config.region.id, quarantined: false };

    regionQuarantineState.set({ region: config.region.id }, quarantined ? 1 : 0);
    const transition: RegionQuarantineTransition | null =
      quarantined === previous ? null : quarantined ? 'quarantined' : 'recovered';
    if (transition) {
      regionQuarantineTransitionsTotal.inc({ region: config.region.id, to: transition });
    }

    return { ...this.status, transition, feeds: feedEvaluations };
  }

  getStatus(): RegionQuarantineStatus {
    return this.status;
  }

  getFeedStatus(feedId: string): FeedQuarantineStatus | undefined {
    return this.feedStatuses.get(feedId);
  }

  getFeedStatuses(): FeedQuarantineStatus[] {
    return Array.from(this.feedStatuses.values());
  }

  private evaluateFeeds(feedSignals: FeedHealthSignal[]): FeedQuarantineEvaluation[] {
    const seen = new Set<string>();
    const evaluations: FeedQuarantineEvaluation[] = [];

    for (const signal of feedSignals) {
      seen.add(signal.feedId);
      const previous = this.feedStatuses.get(signal.feedId)?.quarantined ?? false;
      const degraded = config.region.quarantineEnabled && (signal.stale || signal.gapped);

      let reason: string | undefined;
      if (degraded) {
        const parts: string[] = [];
        if (signal.stale) {
          parts.push(
            signal.lagMs !== undefined
              ? `lag ${signal.lagMs}ms exceeds threshold`
              : 'stale',
          );
        }
        if (signal.gapped) {
          parts.push(
            signal.missingSequences !== undefined
              ? `missing ${signal.missingSequences} sequence(s)`
              : 'sequence gap',
          );
        }
        reason = parts.join('; ');
      }

      const status: FeedQuarantineStatus = degraded
        ? { feedId: signal.feedId, quarantined: true, reason }
        : { feedId: signal.feedId, quarantined: false };
      this.feedStatuses.set(signal.feedId, status);

      const transition: RegionQuarantineTransition | null =
        degraded === previous ? null : degraded ? 'quarantined' : 'recovered';
      evaluations.push({ ...status, transition });
    }

    // Feeds that disappear from the signal set are treated as recovered so
    // stale quarantine state cannot linger indefinitely.
    for (const [feedId, status] of this.feedStatuses) {
      if (seen.has(feedId)) continue;
      this.feedStatuses.set(feedId, { feedId, quarantined: false });
      if (status.quarantined) {
        evaluations.push({ feedId, quarantined: false, transition: 'recovered' });
      }
    }

    return evaluations;
  }

  private nextState(report: DriftReport): boolean {
    if (!config.region.quarantineEnabled) return false;

    if (report.maxDriftPercent > config.region.driftAlertPercent) return true;

    const recovered =
      report.driftKnown && report.maxDriftPercent <= config.region.quarantineRecoverPercent;
    return this.status.quarantined && !recovered;
  }
}

import fs from 'fs';
import path from 'path';
import { Logger } from 'winston';
import client from 'prom-client';
import { register } from '../observability/metrics';
import { BackupService, BackupEntry } from '../infrastructure/backup';

export const drRpoSeconds = new client.Gauge({
  name: 'dr_rpo_seconds',
  help: 'Age in seconds of the most recent backup (actual RPO if a disaster happened now)',
});
register.registerMetric(drRpoSeconds);

export const drRpoTargetSeconds = new client.Gauge({
  name: 'dr_rpo_target_seconds',
  help: 'Configured RPO target in seconds',
});
register.registerMetric(drRpoTargetSeconds);

export const drLastDrillRtoSeconds = new client.Gauge({
  name: 'dr_last_drill_rto_seconds',
  help: 'RTO measured (in seconds) during the most recent DR drill',
});
register.registerMetric(drLastDrillRtoSeconds);

export const drFeedReplicationLagSeconds = new client.Gauge({
  name: 'dr_feed_replication_lag_seconds',
  help: 'Replication lag in seconds for a single feed in a region',
  labelNames: ['feed', 'region'] as const,
});
register.registerMetric(drFeedReplicationLagSeconds);

export const drFeedMissingSequences = new client.Gauge({
  name: 'dr_feed_missing_sequences',
  help: 'Number of missing sequence numbers detected for a feed in a region',
  labelNames: ['feed', 'region'] as const,
});
register.registerMetric(drFeedMissingSequences);

export const drFeedHealthy = new client.Gauge({
  name: 'dr_feed_healthy',
  help: '1 if the feed in a region is within lag/integrity thresholds, else 0',
  labelNames: ['feed', 'region'] as const,
});
register.registerMetric(drFeedHealthy);

export interface RpoStatus {
  lastBackupAt: string | null;
  ageSeconds: number | null;
  targetSeconds: number;
  withinTarget: boolean;
  backupCount: number;
}

export interface DrillResult {
  date: string;
  environment: string;
  tier: 'tier1-pitr' | 'tier2-full';
  rtoSeconds: number;
  rpoSeconds: number;
  rtoTargetSeconds: number;
  rpoTargetSeconds: number;
  passed: boolean;
  report?: string;
}

export interface DrReadiness {
  rpo: RpoStatus;
  lastDrill: DrillResult | null;
  ready: boolean;
  feeds: FeedHealthReport;
}

export interface FeedLagSample {
  feed: string;
  region: string;
  /** Age in seconds of the newest replicated sequence for this feed/region. */
  lagSeconds: number;
  /** Highest contiguous sequence number observed for this feed/region. */
  lastSequence: number | null;
  /** Sequence numbers observed but not yet contiguous (gaps). */
  missingSequences: number[];
}

export interface FeedHealthThresholds {
  /** Max acceptable lag in seconds before a feed is considered degraded. */
  lagSeconds: number;
  /** Max acceptable number of missing sequences before a feed is unhealthy. */
  missingSequences: number;
}

export interface FeedHealth {
  feed: string;
  region: string;
  lagSeconds: number;
  lastSequence: number | null;
  missingSequences: number[];
  healthy: boolean;
  reasons: string[];
}

export interface FeedHealthReport {
  generatedAt: string;
  thresholds: FeedHealthThresholds;
  feeds: FeedHealth[];
  /** Feeds that are unhealthy and should be routed away from. */
  unhealthyFeeds: string[];
  /** True when every observed feed is healthy. */
  allHealthy: boolean;
}

export const DEFAULT_FEED_THRESHOLDS: FeedHealthThresholds = {
  lagSeconds: 60,
  missingSequences: 0,
};

/** Pure: detect gaps in a set of observed sequence numbers. No IO. */
export function detectMissingSequences(sequences: number[]): number[] {
  const unique = Array.from(new Set(sequences.filter((s) => Number.isFinite(s)))).sort(
    (a, b) => a - b,
  );
  if (unique.length < 2) return [];
  const missing: number[] = [];
  for (let i = 1; i < unique.length; i++) {
    const prev = unique[i - 1];
    const curr = unique[i];
    for (let s = prev + 1; s < curr; s++) missing.push(s);
  }
  return missing;
}

/** Pure: evaluate a single feed sample against thresholds. No IO. */
export function evaluateFeedHealth(
  sample: FeedLagSample,
  thresholds: FeedHealthThresholds = DEFAULT_FEED_THRESHOLDS,
): FeedHealth {
  const reasons: string[] = [];
  const lagSeconds = Math.max(0, sample.lagSeconds);
  if (lagSeconds > thresholds.lagSeconds) {
    reasons.push(`lag ${lagSeconds}s exceeds ${thresholds.lagSeconds}s`);
  }
  const missingSequences = sample.missingSequences ?? [];
  if (missingSequences.length > thresholds.missingSequences) {
    reasons.push(
      `${missingSequences.length} missing sequences exceeds ${thresholds.missingSequences}`,
    );
  }
  return {
    feed: sample.feed,
    region: sample.region,
    lagSeconds,
    lastSequence: sample.lastSequence,
    missingSequences,
    healthy: reasons.length === 0,
    reasons,
  };
}

/** Pure: build a full feed health report from samples. No IO. */
export function computeFeedHealthReport(
  samples: FeedLagSample[],
  thresholds: FeedHealthThresholds = DEFAULT_FEED_THRESHOLDS,
  now: Date = new Date(),
): FeedHealthReport {
  const feeds = samples.map((s) => evaluateFeedHealth(s, thresholds));
  const unhealthyFeeds = Array.from(
    new Set(feeds.filter((f) => !f.healthy).map((f) => f.feed)),
  ).sort();
  return {
    generatedAt: now.toISOString(),
    thresholds,
    feeds,
    unhealthyFeeds,
    allHealthy: unhealthyFeeds.length === 0,
  };
}

/** Pure: derive RPO status from a list of backup timestamps. No IO. */
export function computeRpoStatus(
  backups: Pick<BackupEntry, 'createdAt'>[],
  targetSeconds: number,
  now: Date = new Date(),
): RpoStatus {
  if (backups.length === 0) {
    return {
      lastBackupAt: null,
      ageSeconds: null,
      targetSeconds,
      withinTarget: false,
      backupCount: 0,
    };
  }
  const latest = backups.reduce((a, b) => (a.createdAt > b.createdAt ? a : b));
  const ageSeconds = Math.max(0, (now.getTime() - latest.createdAt.getTime()) / 1000);
  return {
    lastBackupAt: latest.createdAt.toISOString(),
    ageSeconds,
    targetSeconds,
    withinTarget: ageSeconds <= targetSeconds,
    backupCount: backups.length,
  };
}

/** Pure: validate/narrow a parsed drill report JSON blob. */
export function parseDrillResult(raw: unknown): DrillResult | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.date !== 'string' ||
    typeof r.environment !== 'string' ||
    (r.tier !== 'tier1-pitr' && r.tier !== 'tier2-full') ||
    typeof r.rtoSeconds !== 'number' ||
    typeof r.rpoSeconds !== 'number' ||
    typeof r.rtoTargetSeconds !== 'number' ||
    typeof r.rpoTargetSeconds !== 'number' ||
    typeof r.passed !== 'boolean'
  ) {
    return null;
  }
  return {
    date: r.date,
    environment: r.environment,
    tier: r.tier,
    rtoSeconds: r.rtoSeconds,
    rpoSeconds: r.rpoSeconds,
    rtoTargetSeconds: r.rtoTargetSeconds,
    rpoTargetSeconds: r.rpoTargetSeconds,
    passed: r.passed,
    report: typeof r.report === 'string' ? r.report : undefined,
  };
}

/**
 * Reports live DR readiness: how stale the newest backup is relative to the RPO
 * target, and the outcome of the most recent quarterly drill (see
 * docs/disaster-recovery/drills.md). Read-only — this service does not perform backups.
 */
export class DrStatusService {
  private refreshTimer?: NodeJS.Timeout;

  constructor(
    private readonly databaseUrl: string,
    private readonly logger: Logger,
    private readonly options: {
      backupDir?: string;
      rpoTargetSeconds?: number;
      drillReportPath?: string;
      refreshIntervalMs?: number;
      feedThresholds?: FeedHealthThresholds;
      /** Optional provider of per-feed replication samples (e.g. from replication monitors). */
      feedSampleProvider?: () => FeedLagSample[];
    } = {},
  ) {}

  start(): void {
    const intervalMs = this.options.refreshIntervalMs ?? 60_000;
    const tick = () => {
      try {
        const status = this.getStatus();
        if (status.rpo.ageSeconds !== null) drRpoSeconds.set(status.rpo.ageSeconds);
        drRpoTargetSeconds.set(status.rpo.targetSeconds);
        if (status.lastDrill) drLastDrillRtoSeconds.set(status.lastDrill.rtoSeconds);
        for (const feed of status.feeds.feeds) {
          const labels = { feed: feed.feed, region: feed.region };
          drFeedReplicationLagSeconds.set(labels, feed.lagSeconds);
          drFeedMissingSequences.set(labels, feed.missingSequences.length);
          drFeedHealthy.set(labels, feed.healthy ? 1 : 0);
        }
      } catch (err) {
        this.logger.warn('DR status refresh failed', err);
      }
    };
    tick();
    this.refreshTimer = setInterval(tick, intervalMs);
    this.refreshTimer.unref?.();
  }

  stop(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
  }

  getStatus(): DrReadiness {
    const svc = new BackupService(this.databaseUrl, this.logger, {
      backupDir: this.options.backupDir,
    });
    const rpo = computeRpoStatus(svc.listBackups(), this.options.rpoTargetSeconds ?? 300);
    const lastDrill = this.readLastDrill();
    const feeds = this.getFeedHealth();
    return {
      rpo,
      lastDrill,
      ready:
        rpo.withinTarget &&
        (lastDrill === null || lastDrill.passed) &&
        feeds.allHealthy,
      feeds,
    };
  }

  /** Per-feed replication lag and integrity, used for feed-health based routing. */
  getFeedHealth(): FeedHealthReport {
    const thresholds = this.options.feedThresholds ?? DEFAULT_FEED_THRESHOLDS;
    let samples: FeedLagSample[] = [];
    if (this.options.feedSampleProvider) {
      try {
        samples = this.options.feedSampleProvider();
      } catch (err) {
        this.logger.warn('Feed sample provider failed; reporting no feed health', err);
        samples = [];
      }
    }
    return computeFeedHealthReport(samples, thresholds);
  }

  private readLastDrill(): DrillResult | null {
    const reportPath = this.options.drillReportPath
      ?? path.resolve(process.cwd(), '../docs/disaster-recovery/reports/latest.json');
    try {
      if (!fs.existsSync(reportPath)) return null;
      const raw = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
      return parseDrillResult(raw);
    } catch (err) {
      this.logger.warn(`Failed to read DR drill report at ${reportPath}`, err);
      return null;
    }
  }
}

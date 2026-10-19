import { config } from '../infrastructure/config';
import { DriftReport } from './region-price-replicator';
import { regionQuarantineState, regionQuarantineTransitionsTotal } from '../observability/metrics';

export interface RegionQuarantineStatus {
  region: string;
  quarantined: boolean;
  reason?: string;
  /** Highest publisher epoch observed for this region (local or from peers). */
  epoch: number;
  /** True when a newer epoch from a peer has been observed, so this region must not publish. */
  fenced: boolean;
}

export type RegionQuarantineTransition = 'quarantined' | 'recovered';

export interface RegionQuarantineEvaluation extends RegionQuarantineStatus {
  transition: RegionQuarantineTransition | null;
}

export class RegionQuarantineManager {
  private status: RegionQuarantineStatus = {
    region: config.region.id,
    quarantined: false,
    epoch: 0,
    fenced: false,
  };

  evaluate(report: DriftReport): RegionQuarantineEvaluation {
    const previous = this.status.quarantined;
    const quarantined = this.nextState(report);

    this.status = quarantined
      ? {
          region: config.region.id,
          quarantined: true,
          reason: previous
            ? this.status.reason
            : `drift ${report.maxDriftPercent.toFixed(4)}% exceeds ${config.region.driftAlertPercent}%`,
          epoch: this.status.epoch,
          fenced: this.status.fenced,
        }
      : {
          region: config.region.id,
          quarantined: false,
          epoch: this.status.epoch,
          fenced: this.status.fenced,
        };

    regionQuarantineState.set({ region: config.region.id }, quarantined ? 1 : 0);
    if (quarantined === previous) return { ...this.status, transition: null };

    const transition: RegionQuarantineTransition = quarantined ? 'quarantined' : 'recovered';
    regionQuarantineTransitionsTotal.inc({ region: config.region.id, to: transition });
    return { ...this.status, transition };
  }

  /**
   * Records a publisher epoch observed for this region. If the observed epoch is
   * higher than the highest epoch seen so far, another publisher has taken over
   * and the local region is fenced: it must refuse to publish until it observes
   * its own epoch as the highest again (e.g. after a fresh election).
   */
  observeEpoch(epoch: number): RegionQuarantineStatus {
    if (!Number.isFinite(epoch) || epoch < 0) return this.status;

    if (epoch > this.status.epoch) {
      this.status = {
        ...this.status,
        epoch,
        fenced: true,
        reason: this.status.quarantined
          ? this.status.reason
          : `observed newer publisher epoch ${epoch}`,
      };
    }
    return this.status;
  }

  /** True when the local region is allowed to publish (not quarantined and not fenced). */
  isAuthoritative(): boolean {
    return !this.status.quarantined && !this.status.fenced;
  }

  getStatus(): RegionQuarantineStatus {
    return this.status;
  }

  private nextState(report: DriftReport): boolean {
    if (!config.region.quarantineEnabled) return false;

    if (report.maxDriftPercent > config.region.driftAlertPercent) return true;

    const recovered =
      report.driftKnown && report.maxDriftPercent <= config.region.quarantineRecoverPercent;
    return this.status.quarantined && !recovered;
  }
}

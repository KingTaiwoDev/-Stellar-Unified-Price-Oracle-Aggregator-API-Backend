import fs from 'fs';
import path from 'path';
import { DATA_DIR } from '../persistence/history';

/**
 * Cost model and daily API budget enforcement (issue #583).
 *
 * Budgets and per-call rates are no longer a hardcoded table of shared
 * constants: the effective values are layered as
 *
 *   code defaults  ←  config/cost-model.json (source of truth)  ←  env override
 *
 * `config/cost-model.json` models the actual provider contracts — free public
 * endpoints cost $0/1k calls but have daily fair-use limits, hence a real
 * (non-fictional) budget with a zero rate. Operators can override a budget
 * per source via `ORACLE_BUDGET_DAILY_CALLS_<UPPERCASE_SOURCE>` without a
 * redeploy.
 *
 * Counters are persisted to `data/daily-call-counts.json` (atomic write) so
 * they survive restarts instead of resetting on every deploy. Persistence is
 * throttled (every PERSIST_EVERY_CALLS calls and at rollover); a hard kill can
 * lose at most that many calls per source, which is acceptable drift versus
 * the budget headroom.
 *
 * Degradation policy at thresholds (deliberate, alerted — dropping a source
 * degrades aggregation quality):
 *   - utilization >= 0.80  → `warn`: the source keeps polling, operators get
 *     a throttled warning log and the Prometheus alert fires.
 *   - utilization >= 1.00  → `exhausted`: `BaseSource` stops polling the
 *     source until the UTC rollover, incrementing
 *     `oracle_source_budget_blocked_total` so the gap is visible and paged on.
 */

export const COST_PER_1K_CALLS: Record<string, number> = {
  chainlink: 0.0, // free public feeds
  redstone: 0.0, // free public feeds
  band: 0.0, // free public feeds
  reflector: 0.0, // free public feeds
};

const DEFAULT_DAILY_BUDGET_CALLS: Record<string, number> = {
  chainlink: 10000,
  redstone: 10000,
  band: 10000,
  reflector: 10000,
};

/** Utilization at or above which a source is considered approaching budget. */
export const BUDGET_WARN_RATIO = 0.8;
/** Utilization at or above which the source stops being polled. */
export const BUDGET_EXHAUSTED_RATIO = 1.0;

const PERSIST_EVERY_CALLS = 10;

// ── Effective configuration: defaults ← config/cost-model.json ← env ────────

function loadBudgetsFromConfig(): Record<string, number> {
  const configPath = path.resolve(__dirname, '../../../../config/cost-model.json');
  const effective = { ...DEFAULT_DAILY_BUDGET_CALLS };
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const model = JSON.parse(raw) as {
      runtimeOracleCallModel?: { dailyBudgetCalls?: Record<string, number>; ratesPer1kCalls?: Record<string, number> };
    };
    const budgets = model.runtimeOracleCallModel?.dailyBudgetCalls;
    if (budgets) {
      for (const [source, budget] of Object.entries(budgets)) {
        if (typeof budget === 'number' && budget >= 0) effective[source.toLowerCase()] = budget;
      }
    }
    const rates = model.runtimeOracleCallModel?.ratesPer1kCalls;
    if (rates) {
      for (const [source, rate] of Object.entries(rates)) {
        if (typeof rate === 'number' && rate >= 0) COST_PER_1K_CALLS[source.toLowerCase()] = rate;
      }
    }
  } catch {
    /* config file missing or unreadable — code defaults remain effective */
  }
  return effective;
}

const configuredBudgets = loadBudgetsFromConfig();

function applyEnvBudgetOverrides(target: Record<string, number>): void {
  for (const source of Object.keys(target)) {
    const envName = `ORACLE_BUDGET_DAILY_CALLS_${source.toUpperCase()}`;
    const raw = process.env[envName];
    if (raw !== undefined && raw !== '') {
      const parsed = parseInt(raw, 10);
      if (Number.isFinite(parsed) && parsed >= 0) target[source] = parsed;
    }
  }
}

export const DAILY_BUDGET_CALLS: Record<string, number> = { ...configuredBudgets };
applyEnvBudgetOverrides(DAILY_BUDGET_CALLS);

// ── Persisted daily counters ────────────────────────────────────────────────

const COUNTS_FILE = path.join(DATA_DIR, 'daily-call-counts.json');

// Running daily call counts reset at midnight UTC.
const dailyCounts: Record<string, number> = {};
let lastResetDate = new Date().toISOString().slice(0, 10);
let callsSincePersist = 0;

function utcDateStamp(at: number = Date.now()): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** Temp file + rename so a kill cannot leave a partial counts file. */
function writeAtomic(filePath: string, payload: string): void {
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, payload);
  fs.renameSync(tmpPath, filePath);
}

function persistDailyCounts(): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    writeAtomic(COUNTS_FILE, JSON.stringify({ date: lastResetDate, counts: dailyCounts }));
  } catch {
    /* persistence is best-effort; in-memory counters remain authoritative */
  }
}

function loadPersistedDailyCounts(): void {
  const today = utcDateStamp();
  try {
    if (!fs.existsSync(COUNTS_FILE)) return;
    const parsed = JSON.parse(fs.readFileSync(COUNTS_FILE, 'utf8')) as {
      date?: string;
      counts?: Record<string, number>;
    };
    // Idempotent UTC rollover: counts from a previous day are dropped on load
    // rather than carried into today's budget.
    if (parsed.date !== today || !parsed.counts) return;
    for (const [source, count] of Object.entries(parsed.counts)) {
      if (typeof count === 'number' && Number.isFinite(count) && count >= 0) {
        dailyCounts[source.toLowerCase()] = count;
      }
    }
  } catch {
    /* ignore corrupt persisted state */
  }
}

loadPersistedDailyCounts();

function maybeReset(): void {
  const today = utcDateStamp();
  if (today !== lastResetDate) {
    for (const k of Object.keys(dailyCounts)) delete dailyCounts[k];
    lastResetDate = today;
    persistDailyCounts();
  }
}

export function estimateCostUsd(source: string): number {
  const rate = COST_PER_1K_CALLS[source.toLowerCase()] ?? 0;
  return rate / 1000;
}

export function recordCall(source: string): void {
  maybeReset();
  const key = source.toLowerCase();
  dailyCounts[key] = (dailyCounts[key] ?? 0) + 1;
  callsSincePersist++;
  if (callsSincePersist >= PERSIST_EVERY_CALLS) {
    callsSincePersist = 0;
    persistDailyCounts();
  }
}

export function getBudgetUtilization(source: string): number {
  maybeReset();
  const key = source.toLowerCase();
  const budget = DAILY_BUDGET_CALLS[key];
  if (!budget) return 0;
  return (dailyCounts[key] ?? 0) / budget;
}

export type BudgetState = 'ok' | 'warn' | 'exhausted';

export interface BudgetStatus {
  dailyCalls: number;
  budget: number;
  utilization: number;
  state: BudgetState;
}

/**
 * Full per-source budget state for /health and alerting: `warn` at
 * BUDGET_WARN_RATIO, `exhausted` (polling stops) at BUDGET_EXHAUSTED_RATIO.
 */
export function getBudgetStatus(source: string): BudgetStatus {
  maybeReset();
  const key = source.toLowerCase();
  const budget = DAILY_BUDGET_CALLS[key] ?? 0;
  const dailyCalls = dailyCounts[key] ?? 0;
  const utilization = budget > 0 ? dailyCalls / budget : 0;
  const state: BudgetState =
    budget > 0 && utilization >= BUDGET_EXHAUSTED_RATIO
      ? 'exhausted'
      : budget > 0 && utilization >= BUDGET_WARN_RATIO
        ? 'warn'
        : 'ok';
  return { dailyCalls, budget, utilization, state };
}

export function getDailyCount(source: string): number {
  maybeReset();
  return dailyCounts[source.toLowerCase()] ?? 0;
}

export function getDailyCounts(): Record<string, number> {
  maybeReset();
  return { ...dailyCounts };
}

/** Per-source budget state map for the /health endpoint. */
export function getBudgetStatuses(): Record<string, BudgetStatus> {
  const statuses: Record<string, BudgetStatus> = {};
  for (const source of Object.keys(DAILY_BUDGET_CALLS)) {
    statuses[source] = getBudgetStatus(source);
  }
  return statuses;
}

/**
 * Clear all tracked call counts. Intended for tests and for operators who
 * need to zero the counters without waiting for the UTC rollover. Does not
 * delete the persisted file — `reloadPersistedCounts()` restores from it.
 */
export function resetDailyCounts(): void {
  for (const k of Object.keys(dailyCounts)) delete dailyCounts[k];
  lastResetDate = utcDateStamp();
  callsSincePersist = 0;
}

/** Force-flush the in-memory counters to disk (used by tests and shutdown). */
export function flushDailyCounts(): void {
  persistDailyCounts();
}

/** Re-seed in-memory counters from the persisted file (restart simulation). */
export function reloadPersistedCounts(): void {
  for (const k of Object.keys(dailyCounts)) delete dailyCounts[k];
  loadPersistedDailyCounts();
}

// ── Regional capacity forecasting (#734) ────────────────────────────────────
//
// Forecasts per-region call volume from observed traffic, feed counts and
// provider load, then reports capacity headroom against the daily budget with
// an uncertainty range. The model is deliberately simple and explainable:
//
//   forecastCalls = observedCallsPerHour × horizonHours × trafficGrowthFactor
//                 × (1 + feedCountWeight × feedCountDelta)
//                 × (1 + providerLoadWeight × (providerLoad - 1))
//
// Uncertainty is a symmetric band whose half-width grows with the forecast
// horizon and with provider load (loaded providers are noisier). Headroom is
// the remaining budget after the forecast; a negative headroom means the
// region is projected to exhaust its budget before the horizon ends.
//
// Degraded inputs never throw: missing/negative/non-finite observations are
// clamped to safe defaults and flagged in `degradedInputs` so operators can
// alert on forecast quality rather than on crashes.

export interface RegionalCapacityInput {
  /** Region identifier, e.g. `us-east-1`. */
  region: string;
  /** Observed calls per hour over the measurement window. */
  observedCallsPerHour: number;
  /** Number of feeds served from this region. */
  feedCount: number;
  /** Baseline feed count the observation was calibrated against. */
  baselineFeedCount?: number;
  /** Provider load factor: 1.0 = nominal, >1 = loaded, <1 = idle. */
  providerLoad: number;
  /** Forecast horizon in hours (default 24). */
  horizonHours?: number;
  /** Expected traffic growth over the horizon (1.0 = flat, default 1.0). */
  trafficGrowthFactor?: number;
  /** Daily budget for the region; defaults to the sum of source budgets. */
  dailyBudgetCalls?: number;
}

export interface RegionalCapacityForecast {
  region: string;
  forecastCalls: number;
  lowerBoundCalls: number;
  upperBoundCalls: number;
  /** Fraction of the daily budget consumed by the forecast (0..1+). */
  utilization: number;
  /** Remaining budget after the forecast; negative = projected exhaustion. */
  headroomCalls: number;
  /** Headroom as a fraction of the budget (may be negative). */
  headroomRatio: number;
  /** True when the upper bound exceeds the budget. */
  atRisk: boolean;
  degradedInputs: string[];
}

/** Relative half-width of the uncertainty band at a 1-hour horizon. */
export const FORECAST_BASE_UNCERTAINTY = 0.1;
/** Additional relative uncertainty per extra forecast hour. */
export const FORECAST_UNCERTAINTY_PER_HOUR = 0.01;
/** Weight applied to feed-count deltas in the forecast. */
export const FORECAST_FEED_COUNT_WEIGHT = 0.5;
/** Weight applied to provider-load deltas in the forecast. */
export const FORECAST_PROVIDER_LOAD_WEIGHT = 0.25;

function defaultRegionalBudget(): number {
  return Object.values(DAILY_BUDGET_CALLS).reduce((sum, b) => sum + b, 0);
}

function finiteOr(value: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Forecast regional capacity and headroom with an uncertainty range.
 * Pure function: does not read or mutate counters, so it is safe to call from
 * /health, dashboards and tests.
 */
export function forecastRegionalCapacity(input: RegionalCapacityInput): RegionalCapacityForecast {
  const degradedInputs: string[] = [];

  const region = typeof input.region === 'string' && input.region ? input.region : 'unknown';
  if (region === 'unknown') degradedInputs.push('region');

  let observedCallsPerHour = finiteOr(input.observedCallsPerHour, 0);
  if (observedCallsPerHour < 0) {
    degradedInputs.push('observedCallsPerHour');
    observedCallsPerHour = 0;
  }

  let feedCount = finiteOr(input.feedCount, 0);
  if (feedCount < 0) {
    degradedInputs.push('feedCount');
    feedCount = 0;
  }

  const baselineFeedCount = finiteOr(input.baselineFeedCount ?? feedCount, feedCount);
  let providerLoad = finiteOr(input.providerLoad, 1);
  if (providerLoad < 0) {
    degradedInputs.push('providerLoad');
    providerLoad = 0;
  }

  let horizonHours = finiteOr(input.horizonHours ?? 24, 24);
  if (horizonHours <= 0) {
    degradedInputs.push('horizonHours');
    horizonHours = 24;
  }

  let trafficGrowthFactor = finiteOr(input.trafficGrowthFactor ?? 1, 1);
  if (trafficGrowthFactor < 0) {
    degradedInputs.push('trafficGrowthFactor');
    trafficGrowthFactor = 1;
  }

  const budget = finiteOr(input.dailyBudgetCalls ?? defaultRegionalBudget(), 0);
  if (budget <= 0) degradedInputs.push('dailyBudgetCalls');

  const feedDelta = baselineFeedCount > 0 ? (feedCount - baselineFeedCount) / baselineFeedCount : 0;
  const feedFactor = Math.max(0, 1 + FORECAST_FEED_COUNT_WEIGHT * feedDelta);
  const loadFactor = Math.max(0, 1 + FORECAST_PROVIDER_LOAD_WEIGHT * (providerLoad - 1));

  const forecastCalls = observedCallsPerHour * horizonHours * trafficGrowthFactor * feedFactor * loadFactor;

  const relativeUncertainty =
    FORECAST_BASE_UNCERTAINTY +
    FORECAST_UNCERTAINTY_PER_HOUR * Math.max(0, horizonHours - 1) +
    FORECAST_PROVIDER_LOAD_WEIGHT * Math.max(0, providerLoad - 1);
  const band = forecastCalls * relativeUncertainty;

  const lowerBoundCalls = Math.max(0, forecastCalls - band);
  const upperBoundCalls = forecastCalls + band;
  const utilization = budget > 0 ? forecastCalls / budget : 0;
  const headroomCalls = budget - forecastCalls;
  const headroomRatio = budget > 0 ? headroomCalls / budget : 0;

  return {
    region,
    forecastCalls,
    lowerBoundCalls,
    upperBoundCalls,
    utilization,
    headroomCalls,
    headroomRatio,
    atRisk: budget > 0 && upperBoundCalls > budget,
    degradedInputs,
  };
}

/** Forecast every region in one pass, keyed by region id. */
export function forecastRegions(inputs: RegionalCapacityInput[]): Record<string, RegionalCapacityForecast> {
  const out: Record<string, RegionalCapacityForecast> = {};
  for (const input of inputs) {
    const forecast = forecastRegionalCapacity(input);
    out[forecast.region] = forecast;
  }
  return out;
}

export interface CostModelIntegrityResult {
  valid: boolean;
  driftDetected: boolean;
  maxDriftPct: number;
  tolerancePct: number;
  discrepancies: string[];
}

/**
 * Reconciles runtime oracle call costs and daily budgets against config/cost-model.json (#555).
 * Alerts if runtime assumptions diverge from the approved capacity model beyond tolerance.
 */
export function verifyRuntimeCostModelIntegrity(customModelPath?: string): CostModelIntegrityResult {
  // NOTE (#734): regional capacity forecasts are derived from the same
  // budgets/rates reconciled here; drift in this model invalidates forecasts.
  const defaultPath = path.resolve(__dirname, '../../../../config/cost-model.json');
  const targetPath = customModelPath || defaultPath;

  if (!fs.existsSync(targetPath)) {
    return {
      valid: true,
      driftDetected: false,
      maxDriftPct: 0,
      tolerancePct: 10,
      discrepancies: [`Warning: Cost model configuration not found at ${targetPath}`],
    };
  }

  try {
    const raw = fs.readFileSync(targetPath, 'utf8');
    const model = JSON.parse(raw);
    const tolerancePct = model.varianceThresholds?.runtimeCallCostTolerancePct ?? 10.0;
    const discrepancies: string[] = [];
    let maxDriftPct = 0;

    const modeledRates = model.runtimeOracleCallModel?.ratesPer1kCalls || {};
    const modeledBudgets = model.runtimeOracleCallModel?.dailyBudgetCalls || {};

    for (const [source, rate] of Object.entries(COST_PER_1K_CALLS)) {
      const modeledRate = modeledRates[source];
      if (modeledRate !== undefined && modeledRate !== rate) {
        const drift = modeledRate === 0 ? 100 : Math.abs(((rate - modeledRate) / modeledRate) * 100);
        maxDriftPct = Math.max(maxDriftPct, drift);
        discrepancies.push(
          `Runtime rate for source '${source}' ($${rate}/1k) differs from modeled rate ($${modeledRate}/1k) by ${drift.toFixed(1)}%`,
        );
      }
    }

    for (const [source, budget] of Object.entries(DAILY_BUDGET_CALLS)) {
      const modeledBudget = modeledBudgets[source];
      if (modeledBudget !== undefined && modeledBudget !== budget) {
        const drift = modeledBudget === 0 ? 100 : Math.abs(((budget - modeledBudget) / modeledBudget) * 100);
        maxDriftPct = Math.max(maxDriftPct, drift);
        discrepancies.push(
          `Runtime daily budget for '${source}' (${budget}) differs from modeled budget (${modeledBudget}) by ${drift.toFixed(1)}%`,
        );
      }
    }

    const driftDetected = maxDriftPct > tolerancePct;

    return {
      valid: !driftDetected,
      driftDetected,
      maxDriftPct,
      tolerancePct,
      discrepancies,
    };
  } catch (err) {
    return {
      valid: false,
      driftDetected: true,
      maxDriftPct: 100,
      tolerancePct: 10,
      discrepancies: [`Failed to parse cost model: ${(err as Error).message}`],
    };
  }
}

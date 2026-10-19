/**
 * Shared type definitions for the Stellar Unified Price Oracle & Aggregator.
 *
 * These types are the canonical source of truth used by both the API and
 * aggregator services, ensuring consistency across service boundaries.
 */

// ── Oracle source identifiers ────────────────────────────────────────────────

export type OracleSourceName = 'chainlink' | 'redstone' | 'band' | 'reflector';

// ── Normalized per-source price ───────────────────────────────────────────────

export interface NormalizedPrice {
  asset: string;
  price: bigint;
  decimals: number;
  source: OracleSourceName;
  /**
   * Best-known observation time, in Unix seconds.
   *
   * This equals `observedAt` when the provider reported one, and is otherwise
   * the local fetch time. Anything that reasons about *age* — staleness checks,
   * retention, gap detection — should read `observedAt` rather than this field,
   * because a locally stamped price can never be shown to be stale.
   */
  timestamp: number;
  /**
   * The provider's own observation time, in Unix seconds.
   *
   * `null` (or absent) means the provider does not report one, so `timestamp`
   * is only local fetch time and the freshness of this price is not
   * independently verifiable.
   */
  observedAt?: number | null;
  /** Local time this response was received, in Unix seconds. */
  fetchedAt?: number;
}

// ── Aggregated (median) price ─────────────────────────────────────────────────

export type DegradationLevel = 'healthy' | 'degraded' | 'critical';

export interface AnomalyScore {
  isAnomaly: boolean;
  score: number;
  method: 'zscore' | 'moving_average' | 'volatility';
  details: string;
}

export interface AggregatedPrice {
  asset: string;
  price: string;
  decimals: number;
  sources: OracleSourceName[];
  timestamp: number;
  confidence: number;
  degradationLevel: DegradationLevel;
  stale: boolean;
  /**
   * True only when every contributing source reported its own observation
   * time, so this price's age was independently verifiable. False means
   * freshness rests on local fetch times — a provider quietly serving cached
   * data would not be detected.
   */
  ageVerified?: boolean;
  anomaly?: AnomalyScore;
}

// ── Source health ─────────────────────────────────────────────────────────────

export interface SourceHealthStatus {
  healthy: boolean;
  lastSuccess: number | null;
  lastFailure: number | null;
  consecutiveFailures: number;
  totalRequests: number;
  totalFailures: number;
  uptimePercent: number;
}

// ── Contract / Soroban configuration ──────────────────────────────────────────

export interface ContractConfig {
  rpcUrl: string;
  contractId: string;
  networkPassphrase: string;
  adminSecret: string;
}

// ── API price representation (returned to consumers) ─────────────────────────

export interface ApiPrice {
  asset: string;
  price: string;
  decimals: number;
  source: string;
  timestamp: number;
  sources?: OracleSourceName[];
  confidence?: number;
  degradationLevel?: DegradationLevel;
  stale?: boolean;
  anomaly?: AnomalyScore;
}

export interface HistoricalPriceEntry {
  price: string;
  decimals: number;
  source: string;
  timestamp: number;
}

// ── Contract read snapshot (consumer-facing) ─────────────────────────────────

/**
 * A mutually consistent view of a published price, its timestamps, and the
 * policy version that governed the publication.
 *
 * Mirrors the contract's `PriceSnapshot` struct. All fields are read in a
 * single contract invocation, so consumers never observe a price paired with
 * a timestamp or policy version from a different publication.
 */
export interface PriceSnapshot {
  asset: string;
  /** Price scaled by `10^decimals`, as a decimal string. */
  price: string;
  decimals: number;
  /** Provider observation time, in Unix seconds. */
  observedAt: number;
  /** Ledger time at which the snapshot was published, in Unix seconds. */
  publishedAt: number;
  /** Monotonic publication sequence number; strictly increases per asset. */
  sequence: number;
  /** Policy version in force when this snapshot was published. */
  policyVersion: number;
  /** True when the age of this price was independently verifiable. */
  ageVerified: boolean;
}

// ── Consumer-verifiable price evidence ───────────────────────────────────────

/**
 * Evidence a consumer can independently verify against a published price.
 *
 * Mirrors the contract's `PriceEvidence` struct. Verification requires the
 * consumer to trust only the contract id and the network passphrase; every
 * other input is covered by `digest`.
 */
export interface PriceEvidence {
  asset: string;
  price: string;
  decimals: number;
  observedAt: number;
  publishedAt: number;
  sequence: number;
  policyVersion: number;
  /** Oracle sources that contributed to the published price. */
  sources: OracleSourceName[];
  /** Hex-encoded SHA-256 digest over the canonical evidence encoding. */
  digest: string;
  /** Hex-encoded signature over `digest` by the publishing key. */
  signature: string;
  /** Public key (G...) of the publisher that produced `signature`. */
  publisher: string;
}

// ── Versioned contract events ────────────────────────────────────────────────

/** Event schema versions this library can decode. */
export const SUPPORTED_EVENT_VERSIONS = [1] as const;

export type SupportedEventVersion = (typeof SUPPORTED_EVENT_VERSIONS)[number];

/** Highest event schema version understood by this library. */
export const LATEST_EVENT_VERSION: SupportedEventVersion = 1;

export interface ContractEventBase {
  /** Event schema version; used for compatibility checks. */
  version: number;
  /** Contract that emitted the event. */
  contractId: string;
  /** Ledger sequence in which the event was emitted. */
  ledger: number;
  /** Transaction hash that produced the event, hex-encoded. */
  txHash: string;
}

export interface PriceSubmittedEventV1 extends ContractEventBase {
  version: 1;
  type: 'price_submitted';
  asset: string;
  price: string;
  decimals: number;
  source: OracleSourceName;
  observedAt: number;
}

export interface PriceSnapshotPublishedEventV1 extends ContractEventBase {
  version: 1;
  type: 'price_snapshot_published';
  asset: string;
  price: string;
  decimals: number;
  observedAt: number;
  publishedAt: number;
  sequence: number;
  policyVersion: number;
  ageVerified: boolean;
}

export interface PolicyVersionUpdatedEventV1 extends ContractEventBase {
  version: 1;
  type: 'policy_version_updated';
  previousVersion: number;
  newVersion: number;
}

export type ContractEventV1 =
  | PriceSubmittedEventV1
  | PriceSnapshotPublishedEventV1
  | PolicyVersionUpdatedEventV1;

export type ContractEvent = ContractEventV1;

/** Raw Soroban event as delivered by RPC `getEvents`. */
export interface RawContractEvent {
  contractId: string;
  ledger: number;
  txHash: string;
  /** Decoded topic values; the first topic carries the event name. */
  topics: unknown[];
  /** Decoded event body. */
  value: unknown;
}

export class EventDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventDecodeError';
  }
}

export class EventVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventVersionError';
  }
}

/**
 * Throws `EventVersionError` unless `version` is an event schema version this
 * library can decode. Callers should treat a thrown error as "upgrade the
 * client", never as "ignore the event".
 */
export function checkEventVersionCompatibility(version: number): void {
  if (!Number.isInteger(version) || version < 1) {
    throw new EventVersionError(`Invalid event version: ${version}`);
  }
  if (!(SUPPORTED_EVENT_VERSIONS as readonly number[]).includes(version)) {
    throw new EventVersionError(
      `Unsupported event version ${version}; supported: ${SUPPORTED_EVENT_VERSIONS.join(', ')}`,
    );
  }
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new EventDecodeError(`Expected ${what} to be an object`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, what: string): string {
  if (typeof value !== 'string') {
    throw new EventDecodeError(`Expected ${what} to be a string`);
  }
  return value;
}

function asNumber(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new EventDecodeError(`Expected ${what} to be a finite number`);
  }
  return value;
}

function asBoolean(value: unknown, what: string): boolean {
  if (typeof value !== 'boolean') {
    throw new EventDecodeError(`Expected ${what} to be a boolean`);
  }
  return value;
}

const ORACLE_SOURCES: readonly OracleSourceName[] = [
  'chainlink',
  'redstone',
  'band',
  'reflector',
];

function asSource(value: unknown, what: string): OracleSourceName {
  const source = asString(value, what);
  if (!ORACLE_SOURCES.includes(source as OracleSourceName)) {
    throw new EventDecodeError(`Unknown oracle source: ${source}`);
  }
  return source as OracleSourceName;
}

/**
 * Decodes a raw Soroban event into a typed, version-checked record.
 *
 * Throws `EventVersionError` for unsupported schema versions and
 * `EventDecodeError` for malformed payloads. Unknown event names are rejected
 * rather than silently dropped so consumers notice contract upgrades.
 */
export function decodeContractEvent(raw: RawContractEvent): ContractEvent {
  const event = asRecord(raw, 'raw event');
  const contractId = asString(event.contractId, 'contractId');
  const ledger = asNumber(event.ledger, 'ledger');
  const txHash = asString(event.txHash, 'txHash');

  if (!Array.isArray(event.topics) || event.topics.length === 0) {
    throw new EventDecodeError('Event has no topics');
  }
  const name = asString(event.topics[0], 'event name topic');
  const body = asRecord(event.value, 'event value');

  const version = asNumber(body.version, 'version');
  checkEventVersionCompatibility(version);

  const base = { version: 1 as const, contractId, ledger, txHash };

  switch (name) {
    case 'price_submitted':
      return {
        ...base,
        type: 'price_submitted',
        asset: asString(body.asset, 'asset'),
        price: asString(body.price, 'price'),
        decimals: asNumber(body.decimals, 'decimals'),
        source: asSource(body.source, 'source'),
        observedAt: asNumber(body.observedAt, 'observedAt'),
      };
    case 'price_snapshot_published':
      return {
        ...base,
        type: 'price_snapshot_published',
        asset: asString(body.asset, 'asset'),
        price: asString(body.price, 'price'),
        decimals: asNumber(body.decimals, 'decimals'),
        observedAt: asNumber(body.observedAt, 'observedAt'),
        publishedAt: asNumber(body.publishedAt, 'publishedAt'),
        sequence: asNumber(body.sequence, 'sequence'),
        policyVersion: asNumber(body.policyVersion, 'policyVersion'),
        ageVerified: asBoolean(body.ageVerified, 'ageVerified'),
      };
    case 'policy_version_updated':
      return {
        ...base,
        type: 'policy_version_updated',
        previousVersion: asNumber(body.previousVersion, 'previousVersion'),
        newVersion: asNumber(body.newVersion, 'newVersion'),
      };
    default:
      throw new EventDecodeError(`Unknown event type: ${name}`);
  }
}

export type Id = string;

export type MutationType = "create" | "update" | "delete";

export type QueueStatus = "pending" | "syncing" | "synced" | "failed" | "conflict";

export type ConflictStrategy = "client-wins" | "server-wins" | "manual";

export type OpenSyncErrorCode =
  | "collection_not_registered"
  | "record_not_found"
  | "duplicate_record"
  | "conflict_not_found"
  | "manual_resolution_required"
  | "migration_failed"
  | "adapter_error"
  | "invalid_configuration"
  | "provider_missing";

export interface SyncRecord {
  id: Id;
  version: number;
  updatedAt: string;
  deletedAt?: string;
  [key: string]: unknown;
}

export interface QueuedOperation<TPayload = unknown> {
  id: Id;
  collection: string;
  type: MutationType;
  recordId: Id;
  payload: TPayload;
  status: QueueStatus;
  retryCount: number;
  createdAt: string;
  nextAttemptAt?: string;
  lastError?: string;
  lastAttemptedAt?: string;
  syncedAt?: string;
}

export interface SyncConflict<TClient = SyncRecord, TServer = SyncRecord> {
  id: Id;
  operationId: Id;
  collection: string;
  recordId: Id;
  clientRecord?: TClient;
  serverRecord?: TServer;
  createdAt: string;
  resolvedAt?: string;
}

export interface AdapterConflict<TServer = SyncRecord> {
  conflict: true;
  serverRecord?: TServer;
  message?: string;
}

export type AdapterResult<TServer = SyncRecord> = void | SyncRecord | AdapterConflict<TServer>;

export interface SyncAdapter {
  create(collection: string, record: SyncRecord): Promise<AdapterResult>;
  update(collection: string, recordId: Id, patch: Partial<SyncRecord>, localRecord?: SyncRecord): Promise<AdapterResult>;
  delete(collection: string, recordId: Id, localRecord?: SyncRecord): Promise<AdapterResult>;
  pull?(collection: string, since?: string): Promise<SyncRecord[]>;
}

export interface SyncStatus {
  online: boolean;
  syncing: boolean;
  pending: number;
  failed: number;
  conflicts: number;
  lastSyncedAt?: string;
  lastError?: string;
  lastAttemptAt?: string;
  nextRetryAt?: string;
}

export class OpenSyncError extends Error {
  constructor(message: string, public readonly code: OpenSyncErrorCode, public readonly cause?: unknown) {
    super(message);
    this.name = "OpenSyncError";
  }
}

export function createId(prefix = "sk"): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.randomUUID) {
    return `${prefix}_${cryptoApi.randomUUID()}`;
  }
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function isAdapterConflict(value: unknown): value is AdapterConflict {
  return Boolean(value && typeof value === "object" && "conflict" in value && (value as AdapterConflict).conflict === true);
}
import { DexieCollection, type Collection } from "./collection";
import { OpenSyncDatabase, type OpenSyncMigration, type StoredRecord } from "./database";
import {
  OpenSyncError,
  createId,
  isAdapterConflict,
  nowIso,
  type ConflictStrategy,
  type QueuedOperation,
  type SyncAdapter,
  type SyncConflict,
  type SyncRecord,
  type SyncStatus
} from "@open-sync/shared";

export interface CreateSyncEngineOptions {
  dbName: string;
  collections: string[];
  adapter: SyncAdapter;
  autoSync?: boolean;
  retryLimit?: number;
  retryDelays?: number[];
  schemaVersion?: number;
  migrate?: OpenSyncMigration;
}

export interface SyncEventMap {
  "sync:start": SyncStatus;
  "sync:success": SyncStatus;
  "sync:error": { error: unknown; status: SyncStatus };
  "operation:success": QueuedOperation;
  "operation:error": QueuedOperation;
  "conflict": SyncConflict;
}

export interface SyncEngine {
  collection<TRecord extends SyncRecord = SyncRecord>(name: string): Collection<TRecord>;
  syncNow(): Promise<void>;
  getStatus(): Promise<SyncStatus>;
  subscribe(listener: (status: SyncStatus) => void): () => void;
  on<TEvent extends keyof SyncEventMap>(event: TEvent, listener: (payload: SyncEventMap[TEvent]) => void): () => void;
  close(): void;
  queue: {
    list(status?: QueuedOperation["status"]): Promise<QueuedOperation[]>;
    retry(operationId: string): Promise<void>;
    discard(operationId: string): Promise<void>;
    clearSynced(): Promise<void>;
  };
  conflicts: {
    list(): Promise<SyncConflict[]>;
    resolve(conflictId: string, strategy: ConflictStrategy, manualRecord?: SyncRecord): Promise<void>;
  };
}

const DEFAULT_RETRY_LIMIT = 3;
const DEFAULT_BACKOFF_MS = [1000, 2000, 4000, 8000];

export function createSyncEngine(options: CreateSyncEngineOptions): SyncEngine {
  return new DefaultSyncEngine(options);
}

class DefaultSyncEngine implements SyncEngine {
  private readonly db: OpenSyncDatabase;
  private readonly collections = new Map<string, DexieCollection>();
  private readonly listeners = new Set<(status: SyncStatus) => void>();
  private readonly eventListeners = new Map<keyof SyncEventMap, Set<(payload: unknown) => void>>();
  private readonly retryLimit: number;
  private readonly retryDelays: number[];
  private syncing = false;
  private online = typeof navigator === "undefined" ? true : navigator.onLine !== false;
  private lastSyncedAt: string | undefined;
  private lastError: string | undefined;
  private lastAttemptAt: string | undefined;

  readonly queue: SyncEngine["queue"];
  readonly conflicts: SyncEngine["conflicts"];

  constructor(private readonly options: CreateSyncEngineOptions) {
    this.db = new OpenSyncDatabase(options.dbName, { schemaVersion: options.schemaVersion, migrate: options.migrate });
    this.retryLimit = options.retryLimit ?? DEFAULT_RETRY_LIMIT;
    this.retryDelays = options.retryDelays?.length ? options.retryDelays : DEFAULT_BACKOFF_MS;

    for (const name of options.collections) {
      this.collections.set(name, new DexieCollection({ db: this.db, name, onQueue: () => this.onQueueChanged() }));
    }

    this.queue = {
      list: (status) => this.listQueue(status),
      retry: (operationId) => this.retryOperation(operationId),
      discard: (operationId) => this.discardOperation(operationId),
      clearSynced: () => this.clearSyncedOperations()
    };

    this.conflicts = {
      list: () => this.db.conflicts.filter((conflict) => !conflict.resolvedAt).toArray(),
      resolve: (conflictId, strategy, manualRecord) => this.resolveConflict(conflictId, strategy, manualRecord)
    };

    if (typeof window !== "undefined") {
      window.addEventListener("online", this.handleOnline);
      window.addEventListener("offline", this.handleOffline);
    }
  }

  collection<TRecord extends SyncRecord = SyncRecord>(name: string): Collection<TRecord> {
    const collection = this.collections.get(name);
    if (!collection) {
      throw new OpenSyncError(`Collection "${name}" is not registered.`, "collection_not_registered");
    }
    return collection as unknown as Collection<TRecord>;
  }

  async syncNow(): Promise<void> {
    if (!this.online || this.syncing) {
      await this.emitStatus();
      return;
    }

    this.syncing = true;
    this.lastAttemptAt = nowIso();
    this.lastError = undefined;
    await this.emitStatus();
    this.emit("sync:start", await this.getStatus());

    try {
      await this.pullAll();
      let operation = await this.nextOperation();
      while (operation) {
        await this.processOperation(operation);
        operation = await this.nextOperation();
      }
      this.lastSyncedAt = nowIso();
      this.emit("sync:success", await this.getStatus());
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.emit("sync:error", { error, status: await this.getStatus() });
      throw new OpenSyncError("Sync failed.", "adapter_error", error);
    } finally {
      this.syncing = false;
      await this.emitStatus();
    }
  }

  async getStatus(): Promise<SyncStatus> {
    const pending = await this.db.queue.where("status").anyOf("pending", "syncing").count();
    const failed = await this.db.queue.where("status").equals("failed").count();
    const conflicts = await this.db.conflicts.filter((conflict) => !conflict.resolvedAt).count();
    const pendingOperations = await this.db.queue.where("status").equals("pending").toArray();
    const nextRetryAt = pendingOperations
      .map((operation) => operation.nextAttemptAt)
      .filter((value): value is string => Boolean(value))
      .sort()[0];
    return {
      online: this.online,
      syncing: this.syncing,
      pending,
      failed,
      conflicts,
      lastSyncedAt: this.lastSyncedAt,
      lastError: this.lastError,
      lastAttemptAt: this.lastAttemptAt,
      nextRetryAt
    };
  }

  subscribe(listener: (status: SyncStatus) => void): () => void {
    this.listeners.add(listener);
    void this.getStatus().then(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  on<TEvent extends keyof SyncEventMap>(event: TEvent, listener: (payload: SyncEventMap[TEvent]) => void): () => void {
    const listeners = this.eventListeners.get(event) ?? new Set<(payload: unknown) => void>();
    listeners.add(listener as (payload: unknown) => void);
    this.eventListeners.set(event, listeners);
    return () => {
      listeners.delete(listener as (payload: unknown) => void);
    };
  }

  close(): void {
    if (typeof window !== "undefined") {
      window.removeEventListener("online", this.handleOnline);
      window.removeEventListener("offline", this.handleOffline);
    }
    this.eventListeners.clear();
    this.listeners.clear();
    this.db.close();
  }

  private async processOperation(operation: QueuedOperation): Promise<void> {
    const attemptedAt = nowIso();
    await this.db.queue.update(operation.id, { status: "syncing", lastAttemptedAt: attemptedAt });
    await this.emitStatus();

    try {
      const localRecord = await this.db.records.get(this.storageId(operation.collection, operation.recordId));
      const result =
        operation.type === "create"
          ? await this.options.adapter.create(operation.collection, operation.payload as SyncRecord)
          : operation.type === "update"
            ? await this.options.adapter.update(operation.collection, operation.recordId, operation.payload as Partial<SyncRecord>, localRecord)
            : await this.options.adapter.delete(operation.collection, operation.recordId, localRecord);

      if (isAdapterConflict(result)) {
        await this.storeConflict(operation, localRecord, result.serverRecord);
        return;
      }

      if (result && typeof result === "object") {
        await this.putPulledRecord(operation.collection, result as SyncRecord);
      }

      const syncedOperation = { ...operation, status: "synced" as const, lastAttemptedAt: attemptedAt, syncedAt: nowIso() };
      await this.db.queue.update(operation.id, { status: "synced", lastError: undefined, syncedAt: syncedOperation.syncedAt });
      this.emit("operation:success", syncedOperation);
    } catch (error) {
      const retriedOperation = await this.markRetry(operation, error, attemptedAt);
      this.emit("operation:error", retriedOperation);
    } finally {
      await this.emitStatus();
    }
  }

  private async markRetry(operation: QueuedOperation, error: unknown, attemptedAt = nowIso()): Promise<QueuedOperation> {
    const retryCount = operation.retryCount + 1;
    const failed = retryCount >= this.retryLimit;
    const delay = this.retryDelays[Math.min(retryCount - 1, this.retryDelays.length - 1)];
    const lastError = error instanceof Error ? error.message : String(error);
    const patch: Partial<QueuedOperation> = {
      status: failed ? "failed" : "pending",
      retryCount,
      nextAttemptAt: failed ? undefined : new Date(Date.now() + delay).toISOString(),
      lastAttemptedAt: attemptedAt,
      lastError
    };
    this.lastError = lastError;
    await this.db.queue.update(operation.id, patch);
    return { ...operation, ...patch } as QueuedOperation;
  }

  private async nextOperation(): Promise<QueuedOperation | undefined> {
    const now = nowIso();
    const candidates = await this.db.queue.where("status").equals("pending").toArray();
    return candidates
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .find((operation) => !operation.nextAttemptAt || operation.nextAttemptAt <= now);
  }

  private async pullAll(): Promise<void> {
    if (!this.options.adapter.pull) return;

    for (const collection of this.collections.keys()) {
      const since = (await this.db.meta.get(`pull:${collection}`))?.value as string | undefined;
      const records = await this.options.adapter.pull(collection, since);
      for (const record of records) {
        await this.putPulledRecord(collection, record);
      }
      await this.db.meta.put({ key: `pull:${collection}`, value: nowIso() });
    }
  }

  private async putPulledRecord(collection: string, record: SyncRecord): Promise<void> {
    const stored: StoredRecord = { ...record, collection, storageId: this.storageId(collection, record.id) };
    await this.db.records.put(stored);
  }

  private async storeConflict(operation: QueuedOperation, clientRecord?: SyncRecord, serverRecord?: SyncRecord): Promise<void> {
    const conflict: SyncConflict = {
      id: createId("conflict"),
      operationId: operation.id,
      collection: operation.collection,
      recordId: operation.recordId,
      clientRecord,
      serverRecord,
      createdAt: nowIso()
    };
    await this.db.transaction("rw", this.db.queue, this.db.conflicts, async () => {
      await this.db.queue.update(operation.id, { status: "conflict" });
      await this.db.conflicts.add(conflict);
    });
    this.emit("conflict", conflict);
  }

  private async resolveConflict(conflictId: string, strategy: ConflictStrategy, manualRecord?: SyncRecord): Promise<void> {
    const conflict = await this.db.conflicts.get(conflictId);
    if (!conflict) throw new OpenSyncError(`Conflict ${conflictId} was not found.`, "conflict_not_found");
    if (strategy === "manual" && !manualRecord) {
      throw new OpenSyncError("Manual conflict resolution requires a record.", "manual_resolution_required");
    }

    const record = strategy === "server-wins" ? conflict.serverRecord : strategy === "manual" ? manualRecord : conflict.clientRecord;
    if (record) {
      await this.putPulledRecord(conflict.collection, record);
    }

    await this.db.transaction("rw", this.db.conflicts, this.db.queue, async () => {
      await this.db.conflicts.update(conflictId, { resolvedAt: nowIso() });
      await this.db.queue.update(conflict.operationId, { status: "synced", syncedAt: nowIso() });
    });
    await this.emitStatus();
  }

  private async listQueue(status?: QueuedOperation["status"]): Promise<QueuedOperation[]> {
    const operations = status ? await this.db.queue.where("status").equals(status).toArray() : await this.db.queue.toArray();
    return operations.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  private async retryOperation(operationId: string): Promise<void> {
    await this.db.queue.update(operationId, { status: "pending", nextAttemptAt: undefined, lastError: undefined });
    await this.onQueueChanged();
  }

  private async discardOperation(operationId: string): Promise<void> {
    await this.db.queue.delete(operationId);
    await this.emitStatus();
  }

  private async clearSyncedOperations(): Promise<void> {
    await this.db.queue.where("status").equals("synced").delete();
    await this.emitStatus();
  }

  private async onQueueChanged(): Promise<void> {
    await this.emitStatus();
    if (this.options.autoSync !== false && this.online) {
      void this.syncNow();
    }
  }

  private readonly handleOnline = (): void => {
    this.online = true;
    void this.syncNow();
  };

  private readonly handleOffline = (): void => {
    this.online = false;
    void this.emitStatus();
  };

  private async emitStatus(): Promise<void> {
    const status = await this.getStatus();
    for (const listener of this.listeners) {
      listener(status);
    }
  }

  private emit<TEvent extends keyof SyncEventMap>(event: TEvent, payload: SyncEventMap[TEvent]): void {
    const listeners = this.eventListeners.get(event);
    if (!listeners) return;
    for (const listener of listeners) {
      listener(payload);
    }
  }

  private storageId(collection: string, id: string): string {
    return `${collection}:${id}`;
  }
}
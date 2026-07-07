import { DexieCollection, type Collection } from "./collection";
import { SyncKitDatabase, type StoredRecord } from "./database";
import {
  createId,
  isAdapterConflict,
  nowIso,
  type ConflictStrategy,
  type QueuedOperation,
  type SyncAdapter,
  type SyncConflict,
  type SyncRecord,
  type SyncStatus
} from "@synckit/shared";

export interface CreateSyncEngineOptions {
  dbName: string;
  collections: string[];
  adapter: SyncAdapter;
  autoSync?: boolean;
  retryLimit?: number;
}

export interface SyncEngine {
  collection<TRecord extends SyncRecord = SyncRecord>(name: string): Collection<TRecord>;
  syncNow(): Promise<void>;
  getStatus(): Promise<SyncStatus>;
  subscribe(listener: (status: SyncStatus) => void): () => void;
  close(): void;
  conflicts: {
    list(): Promise<SyncConflict[]>;
    resolve(conflictId: string, strategy: ConflictStrategy, manualRecord?: SyncRecord): Promise<void>;
  };
}

const DEFAULT_RETRY_LIMIT = 3;
const BACKOFF_MS = [1000, 2000, 4000, 8000];

export function createSyncEngine(options: CreateSyncEngineOptions): SyncEngine {
  return new DefaultSyncEngine(options);
}

class DefaultSyncEngine implements SyncEngine {
  private readonly db: SyncKitDatabase;
  private readonly collections = new Map<string, DexieCollection>();
  private readonly listeners = new Set<(status: SyncStatus) => void>();
  private readonly retryLimit: number;
  private syncing = false;
  private online = typeof navigator === "undefined" ? true : navigator.onLine !== false;
  private lastSyncedAt: string | undefined;

  readonly conflicts: SyncEngine["conflicts"];

  constructor(private readonly options: CreateSyncEngineOptions) {
    this.db = new SyncKitDatabase(options.dbName);
    this.retryLimit = options.retryLimit ?? DEFAULT_RETRY_LIMIT;

    for (const name of options.collections) {
      this.collections.set(name, new DexieCollection({ db: this.db, name, onQueue: () => this.onQueueChanged() }));
    }

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
      throw new Error(`Collection "${name}" is not registered.`);
    }
    return collection as unknown as Collection<TRecord>;
  }

  async syncNow(): Promise<void> {
    if (!this.online || this.syncing) {
      await this.emitStatus();
      return;
    }

    this.syncing = true;
    await this.emitStatus();

    try {
      await this.pullAll();
      let operation = await this.nextOperation();
      while (operation) {
        await this.processOperation(operation);
        operation = await this.nextOperation();
      }
      this.lastSyncedAt = nowIso();
    } finally {
      this.syncing = false;
      await this.emitStatus();
    }
  }

  async getStatus(): Promise<SyncStatus> {
    const pending = await this.db.queue.where("status").anyOf("pending", "syncing").count();
    const failed = await this.db.queue.where("status").equals("failed").count();
    const conflicts = await this.db.conflicts.filter((conflict) => !conflict.resolvedAt).count();
    return { online: this.online, syncing: this.syncing, pending, failed, conflicts, lastSyncedAt: this.lastSyncedAt };
  }

  subscribe(listener: (status: SyncStatus) => void): () => void {
    this.listeners.add(listener);
    void this.getStatus().then(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  close(): void {
    if (typeof window !== "undefined") {
      window.removeEventListener("online", this.handleOnline);
      window.removeEventListener("offline", this.handleOffline);
    }
    this.db.close();
  }

  private async processOperation(operation: QueuedOperation): Promise<void> {
    await this.db.queue.update(operation.id, { status: "syncing" });
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

      await this.db.queue.update(operation.id, { status: "synced", lastError: undefined });
    } catch (error) {
      await this.markRetry(operation, error);
    } finally {
      await this.emitStatus();
    }
  }

  private async markRetry(operation: QueuedOperation, error: unknown): Promise<void> {
    const retryCount = operation.retryCount + 1;
    const failed = retryCount >= this.retryLimit;
    const delay = BACKOFF_MS[Math.min(retryCount - 1, BACKOFF_MS.length - 1)];
    await this.db.queue.update(operation.id, {
      status: failed ? "failed" : "pending",
      retryCount,
      nextAttemptAt: failed ? undefined : new Date(Date.now() + delay).toISOString(),
      lastError: error instanceof Error ? error.message : String(error)
    });
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
    await this.db.transaction("rw", this.db.queue, this.db.conflicts, async () => {
      await this.db.queue.update(operation.id, { status: "conflict" });
      await this.db.conflicts.add({
        id: createId("conflict"),
        operationId: operation.id,
        collection: operation.collection,
        recordId: operation.recordId,
        clientRecord,
        serverRecord,
        createdAt: nowIso()
      });
    });
  }

  private async resolveConflict(conflictId: string, strategy: ConflictStrategy, manualRecord?: SyncRecord): Promise<void> {
    const conflict = await this.db.conflicts.get(conflictId);
    if (!conflict) throw new Error(`Conflict ${conflictId} was not found.`);

    const record = strategy === "server-wins" ? conflict.serverRecord : strategy === "manual" ? manualRecord : conflict.clientRecord;
    if (record) {
      await this.putPulledRecord(conflict.collection, record);
    }

    await this.db.transaction("rw", this.db.conflicts, this.db.queue, async () => {
      await this.db.conflicts.update(conflictId, { resolvedAt: nowIso() });
      await this.db.queue.update(conflict.operationId, { status: "synced" });
    });
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

  private storageId(collection: string, id: string): string {
    return `${collection}:${id}`;
  }
}

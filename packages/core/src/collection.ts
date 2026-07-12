import { OpenSyncError, createId, nowIso, type MutationType, type QueuedOperation, type SyncRecord } from "@open-sync/shared";
import type { OpenSyncDatabase, StoredRecord } from "./database";

export interface Collection<TRecord extends SyncRecord = SyncRecord> {
  create(input: Omit<Partial<TRecord>, "id" | "version" | "updatedAt"> & Record<string, unknown>): Promise<TRecord>;
  update(id: string, patch: Partial<Omit<TRecord, "id">>): Promise<TRecord>;
  delete(id: string): Promise<void>;
  findById(id: string): Promise<TRecord | undefined>;
  findAll(): Promise<TRecord[]>;
  clear(): Promise<void>;
}

export type QueueObserver = () => void | Promise<void>;

interface CollectionOptions {
  db: OpenSyncDatabase;
  name: string;
  onQueue: QueueObserver;
}

export class DexieCollection<TRecord extends SyncRecord = SyncRecord> implements Collection<TRecord> {
  constructor(private readonly options: CollectionOptions) {}

  async create(input: Omit<Partial<TRecord>, "id" | "version" | "updatedAt"> & Record<string, unknown>): Promise<TRecord> {
    const timestamp = nowIso();
    const record = {
      ...input,
      id: createId("rec"),
      storageId: "",
      version: 1,
      updatedAt: timestamp,
      collection: this.options.name
    } as StoredRecord;
    record.storageId = this.storageId(record.id);

    await this.options.db.transaction("rw", this.options.db.records, this.options.db.queue, async () => {
      await this.options.db.records.put(record);
      await this.enqueue("create", record.id, this.stripCollection(record));
    });

    await this.options.onQueue();
    return this.stripCollection(record) as TRecord;
  }

  async update(id: string, patch: Partial<Omit<TRecord, "id">>): Promise<TRecord> {
    const existing = await this.getStored(id);
    if (!existing) {
      throw new OpenSyncError(`Record ${id} was not found in ${this.options.name}.`, "record_not_found");
    }

    const record = {
      ...existing,
      ...patch,
      id,
      storageId: this.storageId(id),
      collection: this.options.name,
      version: existing.version + 1,
      updatedAt: nowIso()
    } as StoredRecord;

    await this.options.db.transaction("rw", this.options.db.records, this.options.db.queue, async () => {
      await this.options.db.records.put(record);
      await this.enqueue("update", id, patch);
    });

    await this.options.onQueue();
    return this.stripCollection(record) as TRecord;
  }

  async delete(id: string): Promise<void> {
    const existing = await this.getStored(id);
    const deletedAt = nowIso();

    await this.options.db.transaction("rw", this.options.db.records, this.options.db.queue, async () => {
      if (existing) {
        await this.options.db.records.put({ ...existing, deletedAt, updatedAt: deletedAt, version: existing.version + 1 });
      }
      await this.enqueue("delete", id, { id, deletedAt });
    });

    await this.options.onQueue();
  }

  async findById(id: string): Promise<TRecord | undefined> {
    const record = await this.getStored(id);
    return record && !record.deletedAt ? (this.stripCollection(record) as TRecord) : undefined;
  }

  async findAll(): Promise<TRecord[]> {
    const records = await this.options.db.records.where("collection").equals(this.options.name).toArray();
    return records.filter((record) => !record.deletedAt).map((record) => this.stripCollection(record) as TRecord);
  }

  async clear(): Promise<void> {
    await this.options.db.records.where("collection").equals(this.options.name).delete();
  }

  private async enqueue(type: MutationType, recordId: string, payload: unknown): Promise<void> {
    const operation: QueuedOperation = {
      id: createId("op"),
      collection: this.options.name,
      type,
      recordId,
      payload,
      status: "pending",
      retryCount: 0,
      createdAt: nowIso()
    };
    await this.options.db.queue.add(operation);
  }

  private getStored(id: string): Promise<StoredRecord | undefined> {
    return this.options.db.records.get(this.storageId(id));
  }

  private stripCollection(record: StoredRecord): SyncRecord {
    const { collection: _collection, storageId: _storageId, ...publicRecord } = record;
    return publicRecord;
  }

  private storageId(id: string): string {
    return `${this.options.name}:${id}`;
  }
}
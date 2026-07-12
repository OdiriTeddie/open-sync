import Dexie, { type Table } from "dexie";
import type { QueuedOperation, SyncConflict, SyncRecord } from "@open-sync/shared";

export interface StoredRecord extends SyncRecord {
  storageId: string;
  collection: string;
}

export interface OpenSyncMigrationContext {
  db: OpenSyncDatabase;
  fromVersion: number;
  toVersion: number;
}

export type OpenSyncMigration = (context: OpenSyncMigrationContext) => Promise<void> | void;

export interface OpenSyncDatabaseOptions {
  schemaVersion?: number;
  migrate?: OpenSyncMigration;
}

export class OpenSyncDatabase extends Dexie {
  records!: Table<StoredRecord, string>;
  queue!: Table<QueuedOperation, string>;
  conflicts!: Table<SyncConflict, string>;
  meta!: Table<{ key: string; value: unknown }, string>;

  constructor(dbName: string, options: OpenSyncDatabaseOptions = {}) {
    super(dbName);

    this.version(1).stores({
      records: "storageId, id, collection, [collection+id], updatedAt, deletedAt",
      queue: "id, collection, status, createdAt, nextAttemptAt, [status+createdAt]",
      conflicts: "id, collection, recordId, resolvedAt",
      meta: "key"
    });

    const schemaVersion = options.schemaVersion ?? 1;
    if (schemaVersion > 1) {
      this.version(schemaVersion)
        .stores({
          records: "storageId, id, collection, [collection+id], updatedAt, deletedAt",
          queue: "id, collection, status, createdAt, nextAttemptAt, [status+createdAt]",
          conflicts: "id, collection, recordId, resolvedAt",
          meta: "key"
        })
        .upgrade(async () => {
          await options.migrate?.({ db: this, fromVersion: 1, toVersion: schemaVersion });
        });
    }
  }
}
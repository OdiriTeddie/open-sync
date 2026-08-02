# API Reference

## `createSyncEngine(options)`

Creates an Open Sync engine.

```ts
const sync = createSyncEngine({
  dbName: "app",
  collections: ["tasks"],
  adapter,
  autoSync: true,
  retryLimit: 3,
  retryDelays: [1000, 2000, 4000, 8000],
  schemaVersion: 1,
  migrate: async ({ db }) => {}
});
```

- `dbName`: IndexedDB database name.
- `collections`: collection names to register.
- `adapter`: backend adapter.
- `autoSync`: defaults to `true`.
- `retryLimit`: defaults to `3`.
- `retryDelays`: retry backoff in milliseconds, defaults to `1000, 2000, 4000, 8000`.
- `schemaVersion`: optional app schema version for migrations.
- `migrate`: optional migration hook called when `schemaVersion` increases.

See [Migrations](./migrations.md) for migration details.

## Collection API

- `create(input)` accepts app fields and an optional string `id`; active duplicate IDs throw `duplicate_record`.
- `update(id, patch)` updates a local record, increments `version`, updates `updatedAt`, and queues an update operation.
- `delete(id)` tombstones a local record and queues a delete operation.
- `findById(id)` returns one active record or `undefined`.
- `findAll()` returns active records in the collection.
- `clear()` removes local records for that collection.

## Engine API

- `syncNow()` pulls remote changes and processes pending queue operations sequentially.
- `pause()` temporarily stops automatic and manual sync processing without disabling local writes or queue creation.
- `resume()` re-enables sync processing and starts a background sync when `autoSync` is enabled and the browser is online.
- `getStatus()` returns aggregate sync state.
- `subscribe(listener)` subscribes to aggregate `SyncStatus` changes.
- `on(event, listener)` subscribes to lifecycle events.
- `close()` closes event listeners and the IndexedDB connection.

See [Events](./events.md) for event payloads.

## Queue API

- `queue.list(status?)`: list all operations or operations matching a queue status.
- `queue.retry(operationId)`: reset a failed operation to pending and clear retry metadata.
- `queue.discard(operationId)`: remove an operation without rolling back local record state.
- `queue.clearSynced()`: remove synced operations from local queue history.

See [Queue Management](./queue-management.md) for recovery patterns and retry behavior.

## Conflict API

- `conflicts.list()` returns unresolved conflicts.
- `conflicts.resolve(id, strategy, manualRecord)` resolves a conflict with `client-wins`, `server-wins`, or `manual`.

See [Conflict Resolution](./conflict-resolution.md) for strategies.

## Events

- `sync:start`
- `sync:success`
- `sync:error`
- `operation:success`
- `operation:error`
- `conflict`

See [Events](./events.md) for payloads and usage guidance.

## Errors

Open Sync throws `OpenSyncError` for public API failures. Stable codes include `collection_not_registered`, `record_not_found`, `duplicate_record`, `conflict_not_found`, `manual_resolution_required`, `migration_failed`, `adapter_error`, `invalid_configuration`, and `provider_missing`.

See [Error Handling](./error-handling.md) for recovery examples.

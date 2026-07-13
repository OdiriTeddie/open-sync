# API Reference

## `createSyncEngine(options)`

Creates an Open Sync engine.

- `dbName`: IndexedDB database name.
- `collections`: collection names to register.
- `adapter`: backend adapter.
- `autoSync`: defaults to `true`.
- `retryLimit`: defaults to `3`.
- `retryDelays`: retry backoff in milliseconds, defaults to `1000, 2000, 4000, 8000`.
- `schemaVersion`: optional app schema version for migrations.
- `migrate`: optional migration hook called when `schemaVersion` increases.

## Collection API

- `create(input)` accepts app fields and an optional string `id`; active duplicate IDs throw `duplicate_record`.
- `update(id, patch)`
- `delete(id)`
- `findById(id)`
- `findAll()`
- `clear()`

## Engine API

- `syncNow()`
- `getStatus()`
- `subscribe(listener)`
- `on(event, listener)`
- `close()`

## Queue API

- `queue.list(status?)`
- `queue.retry(operationId)`
- `queue.discard(operationId)`
- `queue.clearSynced()`

## Conflict API

- `conflicts.list()`
- `conflicts.resolve(id, strategy, manualRecord)`

## Events

- `sync:start`
- `sync:success`
- `sync:error`
- `operation:success`
- `operation:error`
- `conflict`

## Errors

Open Sync throws `OpenSyncError` for public API failures. Stable codes include `collection_not_registered`, `record_not_found`, `duplicate_record`, `conflict_not_found`, `manual_resolution_required`, `migration_failed`, `adapter_error`, `invalid_configuration`, and `provider_missing`.
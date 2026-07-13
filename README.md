# Open Sync

Open Sync is a backend-agnostic local-first TypeScript sync engine for offline apps, optimistic updates, retries, and conflict resolution. It persists records in IndexedDB, queues mutations durably, and lets you plug in any backend through a small adapter interface.

```ts
import { createSyncEngine } from "@open-sync/core";

const sync = createSyncEngine({
  dbName: "my-app",
  collections: ["tasks", "notes"],
  adapter
});

const task = await sync.collection("tasks").create({ title: "Buy milk" });
await sync.collection("tasks").update(task.id, { completed: true });
await sync.syncNow();
```

## Packages

- `@open-sync/core`: IndexedDB storage, mutation queue, sync engine, retry logic, conflicts, events, migrations, and adapter contracts.
- `@open-sync/react`: React provider and hooks that wrap the core package.
- `@open-sync/shared`: Shared TypeScript utilities and public types.

## Stable Core APIs

- Queue controls: `sync.queue.list()`, `retry(id)`, `discard(id)`, `clearSynced()`.
- Lifecycle events: `sync:start`, `sync:success`, `sync:error`, `operation:success`, `operation:error`, `conflict`.
- Schema migration hook: `schemaVersion` and `migrate` options on `createSyncEngine`.
- Typed errors via `OpenSyncError` with stable error codes.
- Rich sync status with `lastError`, `lastAttemptAt`, and `nextRetryAt`.

## Testing

- pnpm test: unit tests with fake IndexedDB.
- pnpm test:browser: browser integration tests with real IndexedDB via Playwright Chromium.

## Documentation

See `docs/` for getting started, adapter authoring, sync flow, conflict resolution, offline mode, React integration, and API reference.
# Changelog

All notable changes to Open Sync will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses semantic versioning for published packages.

## [Unreleased]

### Added

- Core local CRUD with dynamic collections backed by IndexedDB/Dexie.
- Optional caller-provided record IDs and duplicate-record protection.
- Optimistic create, update, and delete mutations that update local state immediately.
- Durable mutation queue with `pending`, `syncing`, `synced`, `failed`, and `conflict` statuses.
- Queue management APIs: `queue.list()`, `queue.retry()`, `queue.discard()`, and `queue.clearSynced()`.
- Sequential sync engine exposed through `sync.syncNow()`.
- Configurable retry limit and retry delays with exponential-backoff defaults.
- Backend-agnostic adapter interface for `create`, `update`, `delete`, and optional `pull`.
- Conflict storage and resolution strategies: `client-wins`, `server-wins`, and `manual`.
- Lifecycle events for sync, operation success/failure, and conflicts.
- Rich sync status with pending, failed, conflict counts, last error, last attempt, next retry, and last synced timestamps.
- Schema migration hook through `schemaVersion` and `migrate`.
- React package with `SyncProvider`, `useCollection`, `useCreate`, `useUpdate`, `useDelete`, and `useSyncStatus`.
- Example apps for React todos, offline notes, and Next.js CRUD.
- Browser-level IndexedDB integration tests using Vitest Browser Mode and Playwright Chromium.
- React hook tests with jsdom and fake IndexedDB.
- Documentation for setup, collections, adapters, sync flow, queue management, events, migrations, conflicts, errors, offline mode, React integration, testing, and API reference.

### Changed

- Renamed project and package scope from SyncKit / `@synckit/*` to Open Sync / `@open-sync/*`.
- Hardened local CRUD semantics around tombstones, duplicate IDs, and collection isolation.
- Added package metadata for publishing readiness, including repository, license, keywords, files, and side-effect metadata.

### Fixed

- Prevented missing or tombstoned records from being updated or deleted silently.
- Kept browser integration tests separate from the default Node/fake IndexedDB suite.

## [0.1.0] - 2026-07-13

### Added

- Initial Open Sync v1 candidate implementation.
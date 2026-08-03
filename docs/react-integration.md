# React Integration

Use `@open-sync/react` to provide an engine and consume collection state.

```tsx
<SyncProvider config={{ dbName: "app", collections: ["tasks"], adapter }}>
  <App />
</SyncProvider>
```

Hooks include `useCollection`, `useCreate`, `useUpdate`, `useDelete`, `useSyncStatus`, and `useSyncActions`.

## Collection State

`useCollection(name)` returns records plus reload state:

```tsx
const { records, loading, reloading, error, reloadError, reload, resetError } = useCollection<Task>("tasks");
```

`error` and `reloadError` reference the same reload failure. `resetError()` clears the stored reload error.

## Mutation State

Mutation hooks stay callable and expose state on the returned function:

```tsx
const createTask = useCreate<Task>("tasks");

await createTask({ title: "Buy milk" });

createTask.loading;
createTask.error;
createTask.resetError();
```

`useUpdate()` and `useDelete()` expose the same `loading`, `error`, and `resetError` fields.

## Sync Action State

Use `useSyncActions()` when UI needs button-level state for sync controls:

```tsx
const { syncNow, pause, resume, syncing, pausing, resuming, error, resetError } = useSyncActions();

await syncNow();
await pause();
await resume();
```

Each action has its own loading flag so UI controls can stay precise:

```tsx
<button disabled={syncing} onClick={() => void syncNow()}>
  Sync now
</button>

<button disabled={pausing} onClick={() => void pause()}>
  Pause sync
</button>

<button disabled={resuming} onClick={() => void resume()}>
  Resume sync
</button>
```

If an action fails, `error` stores the thrown error and the action promise rejects so callers can handle it locally:

```tsx
try {
  await syncNow();
} catch {
  report(error);
}

resetError();
```

Use `useSyncStatus()` alongside `useSyncActions()` when the UI also needs aggregate engine state such as `paused`, `pending`, `failed`, or `lastError`.

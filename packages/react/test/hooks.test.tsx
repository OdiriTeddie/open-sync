import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSyncEngine, OpenSyncError, type SyncAdapter, type SyncEngine, type SyncRecord, type SyncStatus } from "@open-sync/core";
import { SyncProvider, useCollection, useCreate, useDelete, useSyncActions, useSyncEngine, useSyncStatus, useUpdate } from "../src";
import { cleanupDatabases, trackDatabase } from "./setup";

interface Task extends SyncRecord {
  title: string;
  completed?: boolean;
}

const roots: Root[] = [];
const engines: SyncEngine[] = [];

function adapter(overrides: Partial<SyncAdapter> = {}): SyncAdapter {
  return {
    create: vi.fn(async (_collection, record) => record),
    update: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    pull: vi.fn(async () => []),
    ...overrides
  };
}

function createEngine(customAdapter = adapter()): SyncEngine {
  const sync = createSyncEngine({
    dbName: trackDatabase(`open-sync-react-${crypto.randomUUID()}`),
    collections: ["tasks"],
    adapter: customAdapter,
    autoSync: false
  });
  engines.push(sync);
  return sync;
}

async function render(ui: React.ReactNode): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(ui);
  });
  return container;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let index = 0; index < 20; index += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }
  throw lastError;
}

afterEach(async () => {
  while (roots.length) {
    const root = roots.pop()!;
    await act(async () => {
      root.unmount();
    });
  }
  while (engines.length) {
    engines.pop()?.close();
  }
  document.body.innerHTML = "";
  await cleanupDatabases();
});

describe("Open Sync React hooks", () => {
  it("throws a typed error when hooks are used outside SyncProvider", async () => {
    const errors: unknown[] = [];
    const originalError = console.error;
    console.error = vi.fn();

    function Probe() {
      try {
        useSyncEngine();
      } catch (error) {
        errors.push(error);
      }
      return null;
    }

    await render(<Probe />);
    console.error = originalError;

    expect(errors[0]).toBeInstanceOf(OpenSyncError);
    expect(errors[0]).toMatchObject({ code: "provider_missing" });
  });

  it("loads collection records from an injected sync engine", async () => {
    const sync = createEngine();
    await sync.collection<Task>("tasks").create({ id: "task-1", title: "Existing" });
    const snapshots: Array<{ loading: boolean; titles: string[] }> = [];

    function Probe() {
      const { records, loading } = useCollection<Task>("tasks");
      snapshots.push({ loading, titles: records.map((record) => record.title) });
      return <span>{loading ? "loading" : records.map((record) => record.title).join(",")}</span>;
    }

    const container = await render(
      <SyncProvider sync={sync}>
        <Probe />
      </SyncProvider>
    );
    await flush();

    expect(container.textContent).toContain("Existing");
    expect(snapshots.some((snapshot) => snapshot.titles.includes("Existing"))).toBe(true);
  });

  it("creates, updates, and deletes through mutation hooks", async () => {
    const sync = createEngine();
    let createTask!: ReturnType<typeof useCreate<Task>>;
    let updateTask!: ReturnType<typeof useUpdate<Task>>;
    let deleteTask!: ReturnType<typeof useDelete>;
    const renderedTitles: string[][] = [];

    function Probe() {
      const { records } = useCollection<Task>("tasks");
      createTask = useCreate<Task>("tasks");
      updateTask = useUpdate<Task>("tasks");
      deleteTask = useDelete("tasks");
      renderedTitles.push(records.map((record) => record.title));
      return <span>{records.map((record) => record.title).join(",")}</span>;
    }

    const container = await render(
      <SyncProvider sync={sync}>
        <Probe />
      </SyncProvider>
    );
    await flush();

    let created!: Task;
    await act(async () => {
      created = await createTask({ id: "hook-task", title: "Draft", completed: false });
    });
    await flush();
    expect(container.textContent).toContain("Draft");

    await act(async () => {
      await updateTask(created.id, { title: "Done", completed: true });
    });
    await flush();
    expect(container.textContent).toContain("Done");

    await act(async () => {
      await deleteTask(created.id);
    });
    await flush();
    expect(container.textContent).not.toContain("Done");
    expect(renderedTitles.some((titles) => titles.includes("Draft"))).toBe(true);
    expect(renderedTitles.some((titles) => titles.includes("Done"))).toBe(true);
  });

  it("exposes mutation loading and error state", async () => {
    const sync = createEngine();
    const pendingCreate = deferred<Task>();
    pendingCreate.promise.catch(() => undefined);
    vi.spyOn(sync.collection<Task>("tasks"), "create").mockReturnValue(pendingCreate.promise);
    let createTask!: ReturnType<typeof useCreate<Task>>;
    const snapshots: Array<{ loading: boolean; error: string | null }> = [];

    function Probe() {
      createTask = useCreate<Task>("tasks");
      snapshots.push({ loading: createTask.loading, error: createTask.error?.message ?? null });
      return <span>{createTask.error?.message ?? (createTask.loading ? "loading" : "idle")}</span>;
    }

    const container = await render(
      <SyncProvider sync={sync}>
        <Probe />
      </SyncProvider>
    );
    await flush();

    let mutation!: Promise<Task>;
    await act(async () => {
      mutation = createTask({ title: "Broken" });
      mutation.catch(() => undefined);
    });
    await waitFor(() => expect(container.textContent).toBe("loading"));

    await act(async () => {
      pendingCreate.reject(new Error("create failed"));
      await expect(mutation).rejects.toThrow("create failed");
    });
    await waitFor(() => expect(container.textContent).toContain("create failed"));

    expect(snapshots.some((snapshot) => snapshot.loading)).toBe(true);
    expect(snapshots.some((snapshot) => snapshot.error === "create failed")).toBe(true);
  });

  it("exposes collection reload errors and reset state", async () => {
    const sync = createEngine();
    let collection!: ReturnType<typeof useCollection<Task>>;

    function Probe() {
      collection = useCollection<Task>("missing");
      return <span>{collection.reloadError?.message ?? (collection.reloading ? "reloading" : "idle")}</span>;
    }

    const container = await render(
      <SyncProvider sync={sync}>
        <Probe />
      </SyncProvider>
    );

    await waitFor(() => expect(container.textContent).toContain('Collection "missing" is not registered.'));
    expect(collection.error).toBeTruthy();

    await act(async () => {
      collection.resetError();
    });
    await waitFor(() => expect(container.textContent).toBe("idle"));
  });

  it("exposes sync action loading and error state", async () => {
    const pendingPull = deferred<SyncRecord[]>();
    pendingPull.promise.catch(() => undefined);
    const failing = adapter({ pull: vi.fn(() => pendingPull.promise) });
    const sync = createEngine(failing);
    let actions!: ReturnType<typeof useSyncActions>;
    const snapshots: Array<{ syncing: boolean; error: string | null }> = [];

    function Probe() {
      actions = useSyncActions();
      snapshots.push({ syncing: actions.syncing, error: actions.error?.message ?? null });
      return <span>{actions.error?.message ?? (actions.syncing ? "syncing" : "idle")}</span>;
    }

    const container = await render(
      <SyncProvider sync={sync}>
        <Probe />
      </SyncProvider>
    );
    await flush();

    let syncAttempt!: Promise<void>;
    await act(async () => {
      syncAttempt = actions.syncNow();
      syncAttempt.catch(() => undefined);
    });
    await waitFor(() => expect(container.textContent).toBe("syncing"));

    await act(async () => {
      pendingPull.reject(new Error("pull failed"));
      await expect(syncAttempt).rejects.toThrow("Sync failed.");
    });
    await waitFor(() => expect(container.textContent).toContain("Sync failed."));

    expect(snapshots.some((snapshot) => snapshot.syncing)).toBe(true);
    expect(snapshots.some((snapshot) => snapshot.error === "Sync failed.")).toBe(true);

    await act(async () => {
      actions.resetError();
      await actions.pause();
      await actions.resume();
    });
    await waitFor(() => expect(actions.error).toBeNull());
  });
  it("updates sync status subscribers when queue state changes", async () => {
    const sync = createEngine();
    const statuses: SyncStatus[] = [];

    function Probe() {
      const status = useSyncStatus();
      if (status) statuses.push(status);
      return <span>{status?.pending ?? "none"}</span>;
    }

    const container = await render(
      <SyncProvider sync={sync}>
        <Probe />
      </SyncProvider>
    );
    await waitFor(() => expect(container.textContent).toBe("0"));

    await act(async () => {
      await sync.collection("tasks").create({ title: "Queued" });
    });
    await waitFor(() => expect(container.textContent).toBe("1"));

    expect(statuses.some((status) => status.pending === 1)).toBe(true);
  });

  it("creates and closes an engine from provider config", async () => {
    const customAdapter = adapter();
    const dbName = trackDatabase(`open-sync-react-config-${crypto.randomUUID()}`);
    let syncFromContext: SyncEngine | undefined;

    function Probe() {
      syncFromContext = useSyncEngine();
      return null;
    }

    await render(
      <SyncProvider config={{ dbName, collections: ["tasks"], adapter: customAdapter, autoSync: false }}>
        <Probe />
      </SyncProvider>
    );
    await flush();

    expect(syncFromContext).toBeTruthy();
  });
});







import { afterEach, describe, expect, it, vi } from "vitest";
import { createSyncEngine, type SyncAdapter, type SyncEngine, type SyncRecord } from "../../src";

const engines: SyncEngine[] = [];
const dbNames: string[] = [];

function createDbName(): string {
  const name = `open-sync-browser-${crypto.randomUUID()}`;
  dbNames.push(name);
  return name;
}

function adapter(overrides: Partial<SyncAdapter> = {}): SyncAdapter {
  return {
    create: vi.fn(async (_collection, record) => record),
    update: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    pull: vi.fn(async () => []),
    ...overrides
  };
}

function engine(dbName: string, customAdapter = adapter()): SyncEngine {
  const sync = createSyncEngine({ dbName, collections: ["tasks", "notes"], adapter: customAdapter, autoSync: false });
  engines.push(sync);
  return sync;
}

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error(`Deleting IndexedDB database ${name} was blocked.`));
  });
}

afterEach(async () => {
  while (engines.length) {
    engines.pop()?.close();
  }
  while (dbNames.length) {
    await deleteDatabase(dbNames.pop()!);
  }
});

describe("Open Sync browser IndexedDB integration", () => {
  it("persists records across engine instances using real IndexedDB", async () => {
    const dbName = createDbName();
    const first = engine(dbName);
    const created = await first.collection("tasks").create({ id: "browser-task", title: "Stored in IndexedDB" });
    first.close();

    const second = engine(dbName);

    await expect(second.collection("tasks").findById(created.id)).resolves.toMatchObject({
      id: "browser-task",
      title: "Stored in IndexedDB",
      version: 1
    });
  });

  it("keeps queued mutations durable until a later browser session syncs them", async () => {
    const dbName = createDbName();
    const first = engine(dbName);
    await first.collection("tasks").create({ id: "queued-task", title: "Queued" });
    first.close();

    const syncAdapter = adapter();
    const second = engine(dbName, syncAdapter);

    await expect(second.queue.list("pending")).resolves.toHaveLength(1);
    await second.syncNow();

    expect(syncAdapter.create).toHaveBeenCalledWith("tasks", expect.objectContaining({ id: "queued-task", title: "Queued" }));
    await expect(second.queue.list("synced")).resolves.toHaveLength(1);
  });

  it("applies pulled records and hides tombstoned records with real IndexedDB indexes", async () => {
    const dbName = createDbName();
    const pulled: SyncRecord = { id: "remote-task", title: "Remote", version: 1, updatedAt: new Date().toISOString() };
    const sync = engine(dbName, adapter({ pull: vi.fn(async () => [pulled]) }));

    await sync.syncNow();
    await expect(sync.collection("tasks").findById("remote-task")).resolves.toMatchObject({ title: "Remote" });

    await sync.collection("tasks").delete("remote-task");

    await expect(sync.collection("tasks").findById("remote-task")).resolves.toBeUndefined();
    await expect(sync.collection("tasks").findAll()).resolves.toHaveLength(0);
  });

  it("isolates same record id across collections in real IndexedDB", async () => {
    const sync = engine(createDbName());

    await sync.collection("tasks").create({ id: "same", title: "Task" });
    await sync.collection("notes").create({ id: "same", title: "Note" });

    await expect(sync.collection("tasks").findById("same")).resolves.toMatchObject({ title: "Task" });
    await expect(sync.collection("notes").findById("same")).resolves.toMatchObject({ title: "Note" });
  });
});
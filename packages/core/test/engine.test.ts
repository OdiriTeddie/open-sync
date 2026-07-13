import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSyncEngine, OpenSyncError, type SyncAdapter, type SyncEngine, type SyncRecord } from "../src";

let sync: SyncEngine;
let adapter: SyncAdapter;

beforeEach(() => {
  adapter = {
    create: vi.fn(async (_collection, record) => record),
    update: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    pull: vi.fn(async () => [])
  };
});

afterEach(() => {
  sync?.close();
});

function engine(name = crypto.randomUUID(), customAdapter = adapter): SyncEngine {
  sync = createSyncEngine({
    dbName: name,
    collections: ["tasks"],
    adapter: customAdapter,
    autoSync: false
  });
  return sync;
}

describe("Open Sync core", () => {
  it("stores and reads records locally", async () => {
    const app = engine();
    const created = await app.collection("tasks").create({ title: "Buy milk" });
    const updated = await app.collection("tasks").update(created.id, { completed: true });

    expect(updated.version).toBe(2);
    await expect(app.collection("tasks").findById(created.id)).resolves.toMatchObject({ title: "Buy milk", completed: true });
    await expect(app.collection("tasks").findAll()).resolves.toHaveLength(1);

    await app.collection("tasks").delete(created.id);
    await expect(app.collection("tasks").findAll()).resolves.toHaveLength(0);
  });

  it("supports caller-provided ids and rejects duplicate active records", async () => {
    const app = engine();
    const created = await app.collection("tasks").create({ id: "task-1", title: "Stable id" });

    expect(created.id).toBe("task-1");
    await expect(app.collection("tasks").create({ id: "task-1", title: "Duplicate" })).rejects.toMatchObject({ code: "duplicate_record" });
  });

  it("keeps records isolated by collection", async () => {
    sync = createSyncEngine({ dbName: crypto.randomUUID(), collections: ["tasks", "notes"], adapter, autoSync: false });
    const task = await sync.collection("tasks").create({ id: "same-id", title: "Task" });
    const note = await sync.collection("notes").create({ id: "same-id", title: "Note" });

    expect(task.id).toBe(note.id);
    await expect(sync.collection("tasks").findById("same-id")).resolves.toMatchObject({ title: "Task" });
    await expect(sync.collection("notes").findById("same-id")).resolves.toMatchObject({ title: "Note" });
  });

  it("hides deleted records and rejects updates or deletes after tombstone", async () => {
    const app = engine();
    const created = await app.collection("tasks").create({ title: "Delete me" });

    await app.collection("tasks").delete(created.id);

    await expect(app.collection("tasks").findById(created.id)).resolves.toBeUndefined();
    await expect(app.collection("tasks").update(created.id, { title: "Nope" })).rejects.toMatchObject({ code: "record_not_found" });
    await expect(app.collection("tasks").delete(created.id)).rejects.toMatchObject({ code: "record_not_found" });
  });

  it("clears only the selected collection locally", async () => {
    sync = createSyncEngine({ dbName: crypto.randomUUID(), collections: ["tasks", "notes"], adapter, autoSync: false });
    await sync.collection("tasks").create({ title: "Task" });
    await sync.collection("notes").create({ title: "Note" });

    await sync.collection("tasks").clear();

    await expect(sync.collection("tasks").findAll()).resolves.toHaveLength(0);
    await expect(sync.collection("notes").findAll()).resolves.toHaveLength(1);
  });
  it("creates queued operations for optimistic mutations", async () => {
    const app = engine();
    await app.collection("tasks").create({ title: "Queued" });

    const status = await app.getStatus();
    expect(status.pending).toBe(1);
    await expect(app.queue.list("pending")).resolves.toHaveLength(1);
  });

  it("processes queued operations sequentially through the adapter", async () => {
    const app = engine();
    const created = await app.collection("tasks").create({ title: "A" });
    await app.collection("tasks").update(created.id, { title: "B" });

    await app.syncNow();

    const createOrder = vi.mocked(adapter.create).mock.invocationCallOrder[0];
    const updateOrder = vi.mocked(adapter.update).mock.invocationCallOrder[0];
    expect(createOrder).toBeLessThan(updateOrder);
    await expect(app.getStatus()).resolves.toMatchObject({ pending: 0, failed: 0 });
  });

  it("emits sync and operation lifecycle events", async () => {
    const app = engine();
    const events: string[] = [];
    app.on("sync:start", () => events.push("start"));
    app.on("operation:success", () => events.push("operation"));
    app.on("sync:success", () => events.push("success"));

    await app.collection("tasks").create({ title: "Events" });
    await app.syncNow();

    expect(events).toEqual(["start", "operation", "success"]);
  });

  it("retries failures with exponential backoff and leaves exhausted operations visible", async () => {
    const failing: SyncAdapter = {
      create: vi.fn(async () => {
        throw new Error("offline upstream");
      }),
      update: vi.fn(),
      delete: vi.fn()
    };
    sync = createSyncEngine({
      dbName: crypto.randomUUID(),
      collections: ["tasks"],
      adapter: failing,
      autoSync: false,
      retryLimit: 1
    });
    const app = sync;
    await app.collection("tasks").create({ title: "Retry" });

    await app.syncNow();
    await expect(app.getStatus()).resolves.toMatchObject({ pending: 0, failed: 1, lastError: "offline upstream" });
    const failed = await app.queue.list("failed");
    expect(failed[0].lastAttemptedAt).toBeTruthy();
  });

  it("can retry, discard, and clear queued operations", async () => {
    const app = engine();
    await app.collection("tasks").create({ title: "Queue controls" });
    const [operation] = await app.queue.list();

    await app.queue.discard(operation.id);
    await expect(app.queue.list()).resolves.toHaveLength(0);

    await app.collection("tasks").create({ title: "Synced" });
    await app.syncNow();
    await expect(app.queue.list("synced")).resolves.toHaveLength(1);
    await app.queue.clearSynced();
    await expect(app.queue.list()).resolves.toHaveLength(0);
  });

  it("manually retries failed operations", async () => {
    let fail = true;
    const flaky: SyncAdapter = {
      create: vi.fn(async (_collection, record) => {
        if (fail) throw new Error("first failure");
        return record;
      }),
      update: vi.fn(),
      delete: vi.fn()
    };
    sync = createSyncEngine({ dbName: crypto.randomUUID(), collections: ["tasks"], adapter: flaky, autoSync: false, retryLimit: 1 });
    const app = sync;
    await app.collection("tasks").create({ title: "Retry manually" });
    await app.syncNow();

    const [failed] = await app.queue.list("failed");
    fail = false;
    await app.queue.retry(failed.id);
    await app.syncNow();

    await expect(app.getStatus()).resolves.toMatchObject({ pending: 0, failed: 0 });
  });

  it("stores adapter conflicts and resolves with server wins", async () => {
    const serverRecord: SyncRecord = { id: "server-id", title: "Server", version: 2, updatedAt: new Date().toISOString() };
    const conflicting: SyncAdapter = {
      create: vi.fn(async () => ({ conflict: true as const, serverRecord })),
      update: vi.fn(),
      delete: vi.fn()
    };
    const app = engine(undefined, conflicting);
    await app.collection("tasks").create({ title: "Client" });

    await app.syncNow();
    const conflicts = await app.conflicts.list();

    expect(conflicts).toHaveLength(1);
    await app.conflicts.resolve(conflicts[0].id, "server-wins");
    await expect(app.conflicts.list()).resolves.toHaveLength(0);
    await expect(app.collection("tasks").findById("server-id")).resolves.toMatchObject({ title: "Server" });
  });

  it("requires a record for manual conflict resolution", async () => {
    const conflicting: SyncAdapter = {
      create: vi.fn(async () => ({ conflict: true as const })),
      update: vi.fn(),
      delete: vi.fn()
    };
    const app = engine(undefined, conflicting);
    await app.collection("tasks").create({ title: "Client" });
    await app.syncNow();
    const [conflict] = await app.conflicts.list();

    await expect(app.conflicts.resolve(conflict.id, "manual")).rejects.toMatchObject({ code: "manual_resolution_required" });
  });

  it("pulls remote records during sync", async () => {
    const pulled: SyncRecord = { id: "remote-1", title: "Remote", version: 1, updatedAt: new Date().toISOString() };
    adapter.pull = vi.fn(async () => [pulled]);
    const app = engine();

    await app.syncNow();

    await expect(app.collection("tasks").findById("remote-1")).resolves.toMatchObject({ title: "Remote" });
  });

  it("throws typed errors for invalid public API calls", async () => {
    const app = engine();

    expect(() => app.collection("missing")).toThrow(OpenSyncError);
    await expect(app.collection("tasks").update("missing", { title: "Nope" })).rejects.toMatchObject({ code: "record_not_found" });
    await expect(app.conflicts.resolve("missing", "server-wins")).rejects.toMatchObject({ code: "conflict_not_found" });
  });

  it("runs migration hooks when schema version increases", async () => {
    const dbName = crypto.randomUUID();
    const first = createSyncEngine({ dbName, collections: ["tasks"], adapter, autoSync: false });
    await first.collection("tasks").create({ title: "Before migration" });
    first.close();

    const migrate = vi.fn(async ({ db }) => {
      await db.meta.put({ key: "migration:test", value: true });
    });
    sync = createSyncEngine({ dbName, collections: ["tasks"], adapter, autoSync: false, schemaVersion: 2, migrate });
    await sync.collection("tasks").findAll();

    expect(migrate).toHaveBeenCalledOnce();
  });
});
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSyncEngine, type SyncAdapter, type SyncEngine, type SyncRecord } from "../src";

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

describe("SyncKit core", () => {
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

  it("creates queued operations for optimistic mutations", async () => {
    const app = engine();
    await app.collection("tasks").create({ title: "Queued" });

    const status = await app.getStatus();
    expect(status.pending).toBe(1);
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
    await expect(app.getStatus()).resolves.toMatchObject({ pending: 0, failed: 1 });
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

  it("pulls remote records during sync", async () => {
    const pulled: SyncRecord = { id: "remote-1", title: "Remote", version: 1, updatedAt: new Date().toISOString() };
    adapter.pull = vi.fn(async () => [pulled]);
    const app = engine();

    await app.syncNow();

    await expect(app.collection("tasks").findById("remote-1")).resolves.toMatchObject({ title: "Remote" });
  });
});

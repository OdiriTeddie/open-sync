# Defining Collections

Collections are registered when the engine is created. They are accessed dynamically:

```ts
const tasks = sync.collection("tasks");
await tasks.create({ title: "Buy milk" });
```

Every stored record receives `id`, `version`, and `updatedAt` metadata. You can provide your own string `id` on create when your app needs stable client-generated IDs:

```ts
await tasks.create({ id: "task-1", title: "Buy milk" });
```

Collection storage is isolated by collection name, so `tasks/task-1` and `notes/task-1` can coexist. Deleted records are retained as local tombstones for sync and are hidden from `findById` and `findAll`.
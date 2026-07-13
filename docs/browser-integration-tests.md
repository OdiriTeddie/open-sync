# Browser Integration Tests

Open Sync includes browser-level integration tests for real IndexedDB behavior. These run separately from the default fake IndexedDB unit tests.

```sh
pnpm test:browser
```

The browser suite uses Vitest Browser Mode with Playwright Chromium and covers persistence across engine instances, durable queued mutations, pulled records, tombstones, and collection isolation with real browser IndexedDB indexes.

If Playwright has not downloaded Chromium on your machine yet, run:

```sh
pnpm exec playwright install chromium
```
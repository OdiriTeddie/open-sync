# Offline Mode

Open Sync listens to browser online and offline events. While offline, mutations continue to write locally and queue operations. When connectivity returns, the queue is processed automatically unless `autoSync` is disabled.

You can also pause sync explicitly with `sync.pause()`. While paused, Open Sync still saves mutations locally and queues operations, but `sync.syncNow()` and automatic online processing do not process the queue until `sync.resume()` is called.

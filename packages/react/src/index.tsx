import { createContext, useCallback, useContext, useEffect, useMemo, useState, type PropsWithChildren } from "react";
import type { CreateSyncEngineOptions, SyncEngine, SyncRecord, SyncStatus } from "@open-sync/core";
import { OpenSyncError, createSyncEngine } from "@open-sync/core";

const SyncContext = createContext<SyncEngine | null>(null);

export interface SyncProviderProps extends PropsWithChildren {
  sync?: SyncEngine;
  config?: CreateSyncEngineOptions;
}

export function SyncProvider({ children, sync, config }: SyncProviderProps) {
  const engine = useMemo(() => {
    if (sync) return sync;
    if (!config) throw new OpenSyncError("SyncProvider requires either a sync instance or config.", "invalid_configuration");
    return createSyncEngine(config);
  }, [sync, config]);

  useEffect(() => {
    return () => {
      if (!sync) engine.close();
    };
  }, [engine, sync]);

  return <SyncContext.Provider value={engine}>{children}</SyncContext.Provider>;
}

export function useSyncEngine(): SyncEngine {
  const sync = useContext(SyncContext);
  if (!sync) throw new OpenSyncError("Open Sync hooks must be used inside <SyncProvider>.", "provider_missing");
  return sync;
}

export function useCollection<TRecord extends SyncRecord = SyncRecord>(name: string) {
  const sync = useSyncEngine();
  const [records, setRecords] = useState<TRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const reload = useCallback(async () => {
    try {
      setLoading(true);
      setRecords(await sync.collection<TRecord>(name).findAll());
      setError(null);
    } catch (unknownError) {
      setError(unknownError instanceof Error ? unknownError : new Error(String(unknownError)));
    } finally {
      setLoading(false);
    }
  }, [name, sync]);

  useEffect(() => {
    void reload();
    return sync.subscribe(() => {
      void reload();
    });
  }, [reload, sync]);

  return { records, loading, error, reload };
}

export function useCreate<TRecord extends SyncRecord = SyncRecord>(name: string) {
  const sync = useSyncEngine();
  return useCallback(
    (input: Omit<Partial<TRecord>, "id" | "version" | "updatedAt"> & Record<string, unknown>) => sync.collection<TRecord>(name).create(input),
    [name, sync]
  );
}

export function useUpdate<TRecord extends SyncRecord = SyncRecord>(name: string) {
  const sync = useSyncEngine();
  return useCallback((id: string, patch: Partial<Omit<TRecord, "id">>) => sync.collection<TRecord>(name).update(id, patch), [name, sync]);
}

export function useDelete(name: string) {
  const sync = useSyncEngine();
  return useCallback((id: string) => sync.collection(name).delete(id), [name, sync]);
}

export function useSyncStatus(): SyncStatus | undefined {
  const sync = useSyncEngine();
  const [status, setStatus] = useState<SyncStatus>();

  useEffect(() => sync.subscribe(setStatus), [sync]);

  return status;
}

export type { CreateSyncEngineOptions, SyncEngine, SyncRecord, SyncStatus } from "@open-sync/core";

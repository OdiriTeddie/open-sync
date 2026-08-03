import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type DependencyList, type PropsWithChildren } from "react";
import type { CreateRecordInput, CreateSyncEngineOptions, SyncEngine, SyncRecord, SyncStatus } from "@open-sync/core";
import { OpenSyncError, createSyncEngine } from "@open-sync/core";

const SyncContext = createContext<SyncEngine | null>(null);

export interface SyncProviderProps extends PropsWithChildren {
  sync?: SyncEngine;
  config?: CreateSyncEngineOptions;
}

export interface CollectionState<TRecord extends SyncRecord = SyncRecord> {
  records: TRecord[];
  loading: boolean;
  reloading: boolean;
  error: Error | null;
  reloadError: Error | null;
  reload: () => Promise<void>;
  resetError: () => void;
}

export type MutationHookResult<TArgs extends unknown[], TResult> = ((...args: TArgs) => Promise<TResult>) & {
  loading: boolean;
  error: Error | null;
  resetError: () => void;
};

export interface SyncActionsState {
  syncNow: () => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  syncing: boolean;
  pausing: boolean;
  resuming: boolean;
  error: Error | null;
  resetError: () => void;
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

export function useCollection<TRecord extends SyncRecord = SyncRecord>(name: string): CollectionState<TRecord> {
  const sync = useSyncEngine();
  const mounted = useRef(true);
  const [records, setRecords] = useState<TRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [reloading, setReloading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const resetError = useCallback(() => setError(null), []);

  const reload = useCallback(async () => {
    try {
      setReloading(true);
      setLoading(true);
      const records = await sync.collection<TRecord>(name).findAll();
      if (!mounted.current) return;
      setRecords(records);
      setError(null);
    } catch (unknownError) {
      if (mounted.current) setError(toError(unknownError));
    } finally {
      if (!mounted.current) return;
      setLoading(false);
      setReloading(false);
    }
  }, [name, sync]);

  useEffect(() => {
    mounted.current = true;
    void reload();
    const unsubscribe = sync.subscribe(() => {
      void reload();
    });
    return () => {
      mounted.current = false;
      unsubscribe();
    };
  }, [reload, sync]);

  return { records, loading, reloading, error, reloadError: error, reload, resetError };
}
export function useCreate<TRecord extends SyncRecord = SyncRecord>(name: string): MutationHookResult<[CreateRecordInput<TRecord>], TRecord> {
  const sync = useSyncEngine();
  return useMutation((input: CreateRecordInput<TRecord>) => sync.collection<TRecord>(name).create(input), [name, sync]);
}

export function useUpdate<TRecord extends SyncRecord = SyncRecord>(
  name: string
): MutationHookResult<[string, Partial<Omit<TRecord, "id">>], TRecord> {
  const sync = useSyncEngine();
  return useMutation((id: string, patch: Partial<Omit<TRecord, "id">>) => sync.collection<TRecord>(name).update(id, patch), [name, sync]);
}

export function useDelete(name: string): MutationHookResult<[string], void> {
  const sync = useSyncEngine();
  return useMutation((id: string) => sync.collection(name).delete(id), [name, sync]);
}

export function useSyncStatus(): SyncStatus | undefined {
  const sync = useSyncEngine();
  const [status, setStatus] = useState<SyncStatus>();

  useEffect(() => sync.subscribe(setStatus), [sync]);

  return status;
}

export function useSyncActions(): SyncActionsState {
  const sync = useSyncEngine();
  const [syncing, setSyncing] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const resetError = useCallback(() => setError(null), []);

  const runAction = useCallback(async (setLoading: (loading: boolean) => void, action: () => Promise<void>) => {
    try {
      setLoading(true);
      setError(null);
      await action();
    } catch (unknownError) {
      const error = toError(unknownError);
      setError(error);
      throw error;
    } finally {
      setLoading(false);
    }
  }, []);

  const syncNow = useCallback(() => runAction(setSyncing, () => sync.syncNow()), [runAction, sync]);
  const pause = useCallback(() => runAction(setPausing, () => sync.pause()), [runAction, sync]);
  const resume = useCallback(() => runAction(setResuming, () => sync.resume()), [runAction, sync]);

  return { syncNow, pause, resume, syncing, pausing, resuming, error, resetError };
}

function useMutation<TArgs extends unknown[], TResult>(
  mutate: (...args: TArgs) => Promise<TResult>,
  deps: DependencyList
): MutationHookResult<TArgs, TResult> {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const resetError = useCallback(() => setError(null), []);

  const callback = useCallback(async (...args: TArgs) => {
    try {
      setLoading(true);
      setError(null);
      return await mutate(...args);
    } catch (unknownError) {
      const error = toError(unknownError);
      setError(error);
      throw error;
    } finally {
      setLoading(false);
    }
  }, deps);

  return Object.assign(callback, { loading, error, resetError });
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export type { CreateRecordInput, CreateSyncEngineOptions, SyncEngine, SyncRecord, SyncStatus } from "@open-sync/core";




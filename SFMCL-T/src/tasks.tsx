import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ReactNode } from "react";
import { api, desktop } from "./api";
import { createTaskStore } from "./taskStore";
import type { Tasks } from "./types";

const TasksContext = createContext<ReturnType<typeof createTaskStore> | null>(
  null,
);
const DownloadActionsContext = createContext<{
  clearingDownloads: ReadonlySet<string>;
  clearDownload: (id: string) => Promise<void>;
} | null>(null);

export function TaskProvider({
  initialized,
  refresh,
  reportError,
  children,
}: {
  initialized: boolean;
  refresh: () => Promise<void>;
  reportError: (error: string) => void;
  children: ReactNode;
}) {
  const [store] = useState(createTaskStore);
  const generation = useRef(0);
  const pendingClears = useRef(new Set<string>());
  const [clearingDownloads, setClearingDownloads] = useState<
    ReadonlySet<string>
  >(new Set());
  const clearDownload = useCallback(
    async (id: string) => {
      if (pendingClears.current.has(id)) return;
      pendingClears.current.add(id);
      setClearingDownloads(new Set(pendingClears.current));
      try {
        await api("downloads.control", { id, action: "clear" });
        generation.current++;
        const current = store.getSnapshot();
        store.update({
          ...current,
          downloads: current.downloads.filter((item) => item.id !== id),
        });
      } catch (error) {
        reportError(String(error));
      } finally {
        pendingClears.current.delete(id);
        setClearingDownloads(new Set(pendingClears.current));
      }
    },
    [store, reportError],
  );

  useEffect(() => {
    if (!desktop || !initialized) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    let lastPollError = "";
    const completed = new Set<string>();
    const poll = async () => {
      try {
        const revision = generation.current;
        const next = await api<Tasks>("tasks");
        lastPollError = "";
        if (active && revision === generation.current) store.update(next);
        const newlyCompleted = next.jobs.filter(
          (job) => job.status === "completed" && !completed.has(job.id),
        );
        newlyCompleted.forEach((job) => completed.add(job.id));
        if (active && newlyCompleted.length > 0) await refresh();
      } catch (error) {
        const message = String(error);
        if (active && message !== lastPollError) reportError(message);
        lastPollError = message;
      } finally {
        if (active) timer = setTimeout(poll, 500);
      }
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [initialized, store, refresh, reportError]);

  const actions = useMemo(
    () => ({ clearingDownloads, clearDownload }),
    [clearingDownloads, clearDownload],
  );
  return (
    <TasksContext.Provider value={store}>
      <DownloadActionsContext.Provider value={actions}>
        {children}
      </DownloadActionsContext.Provider>
    </TasksContext.Provider>
  );
}

export function useTaskSnapshot() {
  const store = useContext(TasksContext);
  if (!store) throw new Error("Task provider missing");
  return store.getSnapshot;
}

export function useTaskSelector<T>(select: (tasks: Tasks) => T): T {
  const store = useContext(TasksContext);
  if (!store) throw new Error("Task provider missing");
  const snapshot = useCallback(
    () => select(store.getSnapshot()),
    [store, select],
  );
  return useSyncExternalStore(store.subscribe, snapshot, snapshot);
}

const allTasks = (tasks: Tasks) => tasks;
export function useTasks() {
  return useTaskSelector(allTasks);
}

export function useDownloadActions() {
  const actions = useContext(DownloadActionsContext);
  if (!actions) throw new Error("Task provider missing");
  return actions;
}

import { useCallback, useEffect, useRef, useState } from "react";
import { AutoSave, registerAutoSave } from "./autoSave";

export function useAutoSavedSettings<T extends object>(
  saved: T | null,
  persist: (previous: T, next: T) => Promise<T>,
  prepare: (value: T, saved: T) => T,
  failed: (error: unknown) => void,
) {
  const [, render] = useState(0);
  const active = useRef(true);
  const callbacks = useRef({ persist, prepare, failed });
  callbacks.current = { persist, prepare, failed };
  const [queue] = useState(
    () =>
      new AutoSave(
        saved,
        (previous, next) => callbacks.current.persist(previous, next),
        (value, previous) => callbacks.current.prepare(value, previous),
        () => {
          if (active.current) render((revision) => revision + 1);
        },
        (error) => callbacks.current.failed(error),
      ),
  );
  const serialized = JSON.stringify(saved);
  useEffect(() => {
    queue.receive(JSON.parse(serialized) as T | null);
  }, [queue, serialized]);
  useEffect(() => {
    active.current = true;
    const unregister = registerAutoSave(queue);
    const flush = () => void queue.flush();
    window.addEventListener("pagehide", flush);
    return () => {
      active.current = false;
      window.removeEventListener("pagehide", flush);
      unregister();
    };
  }, [queue]);
  const setDraft = useCallback(
    (update: (value: T) => T) => queue.update(update),
    [queue],
  );
  const sync = useCallback(
    (update: (value: T) => T) => queue.sync(update),
    [queue],
  );
  return { draft: queue.value, setDraft, sync, saving: queue.pending };
}

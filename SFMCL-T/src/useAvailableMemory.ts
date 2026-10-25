import { useEffect, useState } from "react";
import { api } from "./api";

export function useAvailableMemory() {
  const [availableMb, setAvailableMb] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(true);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let active = true;
    let pending = false;
    const refresh = async () => {
      if (pending || document.hidden) return;
      pending = true;
      setRefreshing(true);
      try {
        const memory = await api<{ availableMb: number }>("system.memory");
        if (!Number.isFinite(memory.availableMb) || memory.availableMb < 0)
          throw new Error("Invalid available memory");
        if (active) {
          setAvailableMb(Math.floor(memory.availableMb));
          setError("");
        }
      } catch {
        if (active) setError("无法读取可用内存，暂时无法调整内存。");
      } finally {
        pending = false;
        if (active) setRefreshing(false);
      }
    };
    void refresh();
    const timer = window.setInterval(refresh, 10000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [revision]);

  const refresh = () => {
    setRefreshing(true);
    setRevision((value) => value + 1);
  };
  return { availableMb, error, refreshing, refresh };
}

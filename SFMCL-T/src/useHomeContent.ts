import { useCallback, useEffect, useRef, useState } from "react";
import { api, desktop } from "./api";
import {
  defaultHomeContent,
  validateHomeContent,
  type HomeContentConfig,
} from "./homeContentConfig";

const preference = "sfmcl-t.home.content";
export function useHomeContent(enabled: boolean) {
  const [config, setConfig] = useState(defaultHomeContent);
  const current = useRef(config);
  const pending = useRef(false);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!enabled || ready) return;
    let active = true;
    const load = async () => {
      try {
        const stored = desktop
          ? await api<HomeContentConfig>("home.content.get")
          : JSON.parse(localStorage.getItem(preference) || "null");
        const value = validateHomeContent(stored ?? defaultHomeContent());
        if (active) {
          current.current = value;
          setConfig(value);
          setReady(true);
          setError("");
        }
      } catch (e) {
        if (active) setError(`读取首页组件失败：${e}`);
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [enabled, ready, revision]);

  const update = useCallback(
    async (change: (before: HomeContentConfig) => HomeContentConfig) => {
      if (!ready || pending.current) return false;
      const before = current.current;
      let next: HomeContentConfig;
      try {
        next = validateHomeContent(change(before));
      } catch (e) {
        setError(String(e));
        return false;
      }
      pending.current = true;
      current.current = next;
      setConfig(next);
      setSaving(true);
      setError("");
      try {
        if (desktop) {
          const saved = await api<HomeContentConfig>("home.content.save", next);
          current.current = validateHomeContent(saved);
        } else localStorage.setItem(preference, JSON.stringify(next));
        if (mounted.current) setConfig(current.current);
        return true;
      } catch (e) {
        current.current = before;
        if (mounted.current) {
          setConfig(before);
          setError(`保存首页组件失败：${e}`);
        }
        return false;
      } finally {
        pending.current = false;
        if (mounted.current) setSaving(false);
      }
    },
    [ready],
  );
  return {
    config,
    ready,
    saving,
    error,
    update,
    retry: () => setRevision((value) => value + 1),
  };
}

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { api } from "./api";
import { loadImage, imageRevision, subscribeImages } from "./images";

export function useImageResource(
  path: string,
  fallback = "",
  proxyRemote = false,
) {
  const subscribe = useCallback(
    (listener: () => void) => subscribeImages(path, listener),
    [path],
  );
  const snapshot = useCallback(() => imageRevision(path), [path]);
  const revision = useSyncExternalStore(subscribe, snapshot);
  const [resolved, setResolved] = useState({
    path: "",
    fallback,
    revision: -1,
    url: fallback,
  });
  const direct =
    !path ||
    /^(data:|\/assets\/)/.test(path) ||
    (!proxyRemote && /^https?:/i.test(path));
  useEffect(() => {
    let active = true;
    if (direct) return;
    const resolve = (url: string) => {
      if (active) setResolved({ path, fallback, revision, url });
    };
    void loadImage(path, () => api<string>("image", { path }))
      .then((value) => {
        if (imageRevision(path) !== revision) return;
        resolve(value);
      })
      .catch(() => {
        if (imageRevision(path) === revision) resolve(fallback);
      });
    return () => {
      active = false;
    };
  }, [path, fallback, revision, direct]);
  return {
    url: direct ? path || fallback : resolved.url,
    ready:
      direct ||
      (resolved.path === path &&
        resolved.fallback === fallback &&
        resolved.revision === revision),
    revision,
  };
}

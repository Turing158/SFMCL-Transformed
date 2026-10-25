import { useEffect, useState, useSyncExternalStore } from "react";
import { api } from "./api";
import { imageCache as images, imageRevision, subscribeImages } from "./images";

export function useImageResource(
  path: string,
  fallback = "",
  proxyRemote = false,
) {
  const revision = useSyncExternalStore(subscribeImages, imageRevision);
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
    const cached = images.get(path);
    if (cached) {
      resolve(cached);
      return;
    }
    void api<string>("image", { path })
      .then((value) => {
        if (imageRevision() !== revision) return;
        if (images.size > 100) images.clear();
        images.set(path, value);
        resolve(value);
      })
      .catch(() => {
        resolve(fallback);
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

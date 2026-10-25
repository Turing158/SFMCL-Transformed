export const imageCache = new Map<string, string>();
let revision = 0;
const listeners = new Set<() => void>();
export const imageRevision = () => revision;
export function subscribeImages(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function invalidateImages() {
  imageCache.clear();
  revision++;
  listeners.forEach((listener) => listener());
}

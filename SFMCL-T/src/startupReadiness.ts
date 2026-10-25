import { startupTimeout } from "./startupTimeout";

// Only startup work is tracked. Polling and navigation after reveal are unaffected.
const pending = new Set<symbol>();
let revision = 0;
let closed = false;

export function beginStartupWork() {
  if (closed) return () => {};
  const token = Symbol();
  pending.add(token);
  revision++;
  return () => {
    if (pending.delete(token)) revision++;
  };
}

export function closeStartupWork() {
  closed = true;
  pending.clear();
}

function aborted(signal: AbortSignal) {
  signal.throwIfAborted();
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal) {
  return new Promise<T>((resolve, reject) => {
    aborted(signal);
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function frame(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    aborted(signal);
    const onAbort = () => {
      cancelAnimationFrame(id);
      reject(signal.reason);
    };
    const id = requestAnimationFrame(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    });
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function settleImage(image: HTMLImageElement, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    aborted(signal);
    const cleanup = () => {
      image.removeEventListener("load", done);
      image.removeEventListener("error", done);
      signal.removeEventListener("abort", onAbort);
    };
    const done = () => {
      cleanup();
      // Load errors are a settled fallback, not an indefinitely pending image.
      if (image.naturalWidth)
        void withAbort(
          image.decode().catch(() => {}),
          signal,
        ).then(resolve, reject);
      else resolve();
    };
    const onAbort = () => {
      cleanup();
      reject(signal.reason);
    };
    if (image.complete) {
      done();
      return;
    }
    image.addEventListener("load", done, { once: true });
    image.addEventListener("error", done, { once: true });
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function settleAssets(
  root: HTMLElement,
  signal: AbortSignal,
  backgrounds: Map<string, Promise<void>>,
) {
  const images = [...root.querySelectorAll("img")];
  // Hidden/lazy images might otherwise wait until reveal to start loading.
  images.forEach((image) => {
    image.loading = "eager";
  });
  const work = images.map((image) => settleImage(image, signal));
  for (const node of [root, ...root.querySelectorAll<HTMLElement>("*")]) {
    const background = getComputedStyle(node).backgroundImage;
    for (const match of background.matchAll(
      /url\((?:"([^"]*)"|'([^']*)'|([^)]*))\)/g,
    )) {
      const url = match[1] ?? match[2] ?? match[3];
      if (!backgrounds.has(url)) {
        const image = new Image();
        image.src = url;
        backgrounds.set(url, settleImage(image, signal));
      }
      work.push(backgrounds.get(url)!);
    }
  }
  await Promise.all(work);
}

// A committed React tree, settled initial requests, decoded images/canvases and
// loaded fonts must stay unchanged across paint frames before the screen opens.
export async function waitForStartupPaint(
  root: HTMLElement,
  parentSignal: AbortSignal,
) {
  const controller = new AbortController();
  const abort = () => controller.abort(parentSignal.reason);
  parentSignal.addEventListener("abort", abort, { once: true });
  if (parentSignal.aborted) abort();
  const signal = controller.signal;
  const cancelTimeout = startupTimeout(
    () => controller.abort(new Error("界面资源加载超时，请检查连接后重试。")),
    30_000,
  );
  let mutations = 0;
  const startLazyImages = () => {
    root
      .querySelectorAll<HTMLImageElement>('img[loading="lazy"]')
      .forEach((image) => {
        image.loading = "eager";
      });
  };
  const observer = new MutationObserver(() => {
    mutations++;
    // Start newly mounted notice images while other IPC/font work is still pending.
    startLazyImages();
  });
  observer.observe(root, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["src", "srcset", "class", "style", "width", "height"],
  });
  startLazyImages();
  const backgrounds = new Map<string, Promise<void>>();
  try {
    while (true) {
      await frame(signal);
      if (pending.size) continue;
      const version = revision;
      const layoutVersion = mutations;
      await withAbort(document.fonts.ready, signal);
      aborted(signal);
      await settleAssets(root, signal, backgrounds);
      await frame(signal);
      await frame(signal);
      aborted(signal);
      if (
        !pending.size &&
        version === revision &&
        layoutVersion === mutations &&
        document.fonts.status === "loaded"
      )
        return;
    }
  } finally {
    cancelTimeout();
    observer.disconnect();
    parentSignal.removeEventListener("abort", abort);
  }
}

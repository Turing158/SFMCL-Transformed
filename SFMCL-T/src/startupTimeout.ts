// Animation frames pause in hidden WebViews/tabs. Count only visible time so
// minimizing or switching away cannot turn a healthy startup into an error.
export function startupTimeout(callback: () => void, duration = 30_000) {
  let remaining = duration;
  let started = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    clearTimeout(timer);
    document.removeEventListener("visibilitychange", update);
  };
  const update = () => {
    if (timer !== undefined) {
      remaining -= performance.now() - started;
      clearTimeout(timer);
      timer = undefined;
    }
    if (!document.hidden) {
      started = performance.now();
      timer = setTimeout(
        () => {
          cancel();
          callback();
        },
        Math.max(0, remaining),
      );
    }
  };
  document.addEventListener("visibilitychange", update);
  update();
  return cancel;
}

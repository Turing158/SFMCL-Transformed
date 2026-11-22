import { useEffect } from "react";
import { useApp } from "../store";
import { useHoliday } from "./HolidayProvider";
import type { HolidayOverlay } from "./overlays.mjs";

export function HolidayDecorations() {
  const holiday = useHoliday();
  const { notify, reportError } = useApp();
  useEffect(() => {
    if (!holiday) return;
    let disposed = false;
    let overlay: HolidayOverlay | undefined;
    // Ordinary days do not load artwork, install event handlers or run animation frames.
    void Promise.all([import("./artwork"), import("./overlays.mjs")])
      .then(([art, runtime]) => {
        if (!disposed)
          overlay = runtime.mountHolidayOverlay(
            art.createHolidayConfig(holiday),
            { notify },
          );
      })
      .catch((error) => {
        if (!disposed) reportError(String(error));
      });
    return () => {
      disposed = true;
      overlay?.dispose();
    };
  }, [holiday, notify, reportError]);
  return null;
}

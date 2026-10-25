import { useCallback, useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";
import { usePageActive } from "./PageActivity";

const easing = "cubic-bezier(0.22, 0.8, 0.25, 1)";

export function useModalMotion(
  ref: RefObject<HTMLDialogElement | null>,
  onClose: () => void,
  closeDisabled: boolean,
) {
  const pageActive = usePageActive();
  const latest = useRef({ onClose, closeDisabled });
  latest.current = { onClose, closeDisabled };
  const animations = useRef<Animation[]>([]);
  const closing = useRef(false);

  const stop = useCallback(() => {
    animations.current.forEach((animation) => animation.cancel());
    animations.current = [];
  }, []);

  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog || !pageActive) return;
    const trigger = document.activeElement;
    closing.current = false;
    delete dialog.dataset.closing;
    dialog.showModal();
    dialog
      .querySelector<HTMLElement>("[data-modal-autofocus]")
      ?.focus({ preventScroll: true });
    animations.current = [
      dialog.animate(
        [
          { opacity: 0, transform: "translateY(8px) scale(0.99)" },
          { opacity: 1, transform: "translateY(0) scale(1)" },
        ],
        { id: "sfmcl-t-modal-enter", duration: 220, easing, fill: "both" },
      ),
      dialog.animate([{ opacity: 0 }, { opacity: 1 }], {
        id: "sfmcl-t-modal-backdrop-enter",
        pseudoElement: "::backdrop",
        duration: 220,
        fill: "both",
      }),
    ];
    const entering = animations.current;
    void Promise.all(entering.map((animation) => animation.finished)).then(
      () => {
        if (animations.current === entering) stop();
      },
      () => {},
    );
    return () => {
      dialog.close();
      stop();
      if (trigger instanceof HTMLElement && trigger.isConnected)
        trigger.focus({ preventScroll: true });
    };
  }, [ref, stop, pageActive]);

  useLayoutEffect(() => {
    if (!closeDisabled || !closing.current) return;
    stop();
    closing.current = false;
    if (ref.current) delete ref.current.dataset.closing;
  }, [closeDisabled, ref, stop]);

  return useCallback(() => {
    const dialog = ref.current;
    if (!dialog || closing.current || latest.current.closeDisabled)
      return false;
    const style = getComputedStyle(dialog);
    const from = { opacity: style.opacity, transform: style.transform };
    const backdropOpacity = getComputedStyle(dialog, "::backdrop").opacity;
    stop();
    closing.current = true;
    dialog.dataset.closing = "true";
    animations.current = [
      dialog.animate(
        [from, { opacity: 0, transform: "translateY(8px) scale(0.98)" }],
        {
          id: "sfmcl-t-modal-exit",
          duration: 180,
          easing,
          fill: "both",
        },
      ),
      dialog.animate([{ opacity: backdropOpacity }, { opacity: 0 }], {
        id: "sfmcl-t-modal-backdrop-exit",
        pseudoElement: "::backdrop",
        duration: 180,
        fill: "both",
      }),
    ];
    const exiting = animations.current;
    void Promise.all(exiting.map((animation) => animation.finished)).then(
      () => {
        if (animations.current !== exiting || latest.current.closeDisabled)
          return;
        // React may defer unmounting after onClose. Close the native dialog
        // first and retain the exit fill until cleanup to prevent a flash.
        dialog.close();
        latest.current.onClose();
      },
      () => {},
    );
    return true;
  }, [ref, stop]);
}

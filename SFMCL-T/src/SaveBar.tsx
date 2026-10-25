import { useLayoutEffect, useRef, useState } from "react";
import { Save } from "lucide-react";
import { Button, PixelFrame } from "./components";

function useSaveMotion(visible: boolean, target: "bar" | "button") {
  const [present, setPresent] = useState(visible);
  const ref = useRef<HTMLDivElement>(null);
  const motion = useRef<Animation | null>(null);

  useLayoutEffect(() => {
    if (visible && !present) {
      setPresent(true);
      return;
    }
    const bar = ref.current;
    if (!bar) {
      motion.current?.cancel();
      motion.current = null;
      return;
    }
    const hidden = {
      opacity: 0,
      transform: `translateY(${target === "bar" ? 10 : 6}px)`,
    };
    const shown = { opacity: 1, transform: "translateY(0)" };
    const style = getComputedStyle(bar);
    // Resume from the current frame when edits interrupt an entrance or exit.
    const from =
      motion.current || !visible
        ? { opacity: style.opacity, transform: style.transform }
        : hidden;
    motion.current?.cancel();
    const animation = bar.animate([from, visible ? shown : hidden], {
      id: `sfmcl-t-save-${target}-${visible ? "enter" : "exit"}`,
      duration: visible ? 220 : 180,
      easing: "cubic-bezier(0.22, 0.8, 0.25, 1)",
      fill: "both",
    });
    motion.current = animation;
    animation.onfinish = () => {
      if (motion.current !== animation) return;
      if (visible) {
        motion.current = null;
        animation.cancel();
      } else {
        setPresent(false);
      }
    };
  }, [visible, present, target]);

  useLayoutEffect(
    () => () => {
      motion.current?.cancel();
      motion.current = null;
    },
    [],
  );

  return { present, ref };
}

export function SaveButton({
  disabled,
  showIndicator = false,
  onSave,
}: {
  disabled: boolean;
  showIndicator?: boolean;
  onSave: () => void;
}) {
  const { present, ref } = useSaveMotion(!disabled, "button");

  if (!present) return null;
  return (
    <div
      ref={ref}
      className="save-button-motion"
      data-closing={disabled || undefined}
      aria-hidden={disabled || undefined}
      inert={disabled}
    >
      <Button primary disabled={disabled} onClick={onSave}>
        <Save size={showIndicator ? 17 : 16} />
        保存设置{showIndicator && <span className="unsaved-dot" />}
      </Button>
    </div>
  );
}

export function SaveBar({
  visible,
  message,
  busy,
  onDiscard,
  onSave,
}: {
  visible: boolean;
  message: string;
  busy: boolean;
  onDiscard: () => void;
  onSave: () => void;
}) {
  const { present, ref } = useSaveMotion(visible, "bar");

  if (!present) return null;
  return (
    <div
      ref={ref}
      className="save-bar has-surface"
      data-closing={!visible || undefined}
      aria-hidden={!visible || undefined}
      inert={!visible}
    >
      <PixelFrame />
      <span>{message}</span>
      <Button disabled={busy || !visible} onClick={onDiscard}>
        撤销修改
      </Button>
      <SaveButton disabled={busy || !visible} onSave={onSave} />
    </div>
  );
}

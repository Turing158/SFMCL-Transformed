import { useLayoutEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button, TabList } from "../components";

export const exportStages = ["基本信息", "选择内容", "导出检查", "保存整合包"];
const stageItems = exportStages.map((label, index) => ({
  value: String(index),
  label,
  icon: (
    <span className="export-stage-number" aria-hidden="true">
      {index + 1}
    </span>
  ),
}));

export function ExportStageTabs({
  id,
  step,
  disabled,
  onChange,
}: {
  id: string;
  step: number;
  disabled: boolean;
  onChange: (step: number) => void;
}) {
  return (
    <TabList
      id={id}
      className="export-stages"
      label="整合包制作步骤"
      value={String(step)}
      items={stageItems}
      disabled={disabled}
      onValueChange={(value) => onChange(Number(value))}
      separator={<ChevronRight size={16} />}
    />
  );
}

/** Keep the exiting button mounted, inert, until its space has collapsed. */
export function ExportBackButton({
  visible,
  onClick,
}: {
  visible: boolean;
  onClick: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [present, setPresent] = useState(visible);
  const pose = useRef<{
    width: number;
    opacity: string | number;
    transform: string;
  } | null>(null);
  useLayoutEffect(() => {
    if (visible && !present) {
      setPresent(true);
      return;
    }
    const element = root.current;
    const button = element?.firstElementChild;
    if (!present || !element || !(button instanceof HTMLElement)) return;
    const from = pose.current ?? {
      width: visible ? 0 : element.getBoundingClientRect().width,
      opacity: visible ? 0 : 1,
      transform: visible
        ? "translateX(-12px) scale(0.96)"
        : "translateX(0) scale(1)",
    };
    const timing = {
      duration: 260,
      easing: "cubic-bezier(0.22, 0.8, 0.25, 1)",
      fill: "both",
    } as const;
    const animations = [
      element.animate(
        [
          { width: `${from.width}px` },
          { width: visible ? `${button.offsetWidth + 12}px` : "0px" },
        ],
        { ...timing, id: "sfmcl-t-export-back-space" },
      ),
      button.animate(
        [
          { opacity: from.opacity, transform: from.transform },
          {
            opacity: visible ? 1 : 0,
            transform: visible
              ? "translateX(0) scale(1)"
              : "translateX(-12px) scale(0.96)",
          },
        ],
        {
          ...timing,
          id: visible ? "sfmcl-t-export-back-in" : "sfmcl-t-export-back-out",
        },
      ),
    ];
    let finished = false;
    void Promise.all(animations.map((animation) => animation.finished)).then(
      () => {
        finished = true;
        pose.current = null;
        animations.forEach((animation) => animation.cancel());
        if (!visible) setPresent(false);
      },
      () => {},
    );
    return () => {
      if (!finished) {
        const style = getComputedStyle(button);
        pose.current = {
          width: element.getBoundingClientRect().width,
          opacity: style.opacity,
          transform: style.transform,
        };
      }
      animations.forEach((animation) => animation.cancel());
    };
  }, [visible, present]);
  return (
    <div
      ref={root}
      className="export-back"
      aria-hidden={!visible}
      inert={!visible}
    >
      {present && (
        <Button disabled={!visible} onClick={onClick}>
          <ChevronLeft size={16} />
          上一步
        </Button>
      )}
    </div>
  );
}

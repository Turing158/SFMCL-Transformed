import { LayoutGrid, List } from "lucide-react";
import { useState } from "react";
import { PixelFrame } from "../components";

export type ResourceView = "list" | "grid";

export function CatalogView({
  value,
  onValueChange,
  className = "",
  "aria-controls": ariaControls,
}: {
  value: ResourceView;
  onValueChange: (value: ResourceView) => void;
  className?: string;
  "aria-controls"?: string;
}) {
  const [changed, setChanged] = useState(false);
  const nextView = value === "list" ? "grid" : "list";
  const label = nextView === "grid" ? "切换为卡片视图" : "切换为列表视图";
  const Icon = nextView === "grid" ? LayoutGrid : List;

  return (
    <button
      type="button"
      className={`icon-button catalog-view has-surface ${className}`}
      data-tooltip={label}
      aria-label={label}
      aria-controls={ariaControls}
      onClick={() => {
        setChanged(true);
        onValueChange(nextView);
      }}
    >
      <PixelFrame />
      <span
        key={value}
        className={`catalog-view-symbol ${changed ? "is-changing" : ""}`}
      >
        <Icon size={18} aria-hidden="true" />
      </span>
    </button>
  );
}

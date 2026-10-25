import { useId, useRef, useState } from "react";
import { Check, ChevronDown, RefreshCw, X } from "lucide-react";
import { Button, PixelFrame } from "../components";
import { SearchField } from "../controls";
import type { InstallChoice } from "./useInstallCatalog";

export function InstallComponentCard({
  name,
  icon,
  description,
  choices,
  value,
  selectedLabel,
  blocked,
  loading,
  error,
  emptyMessage,
  disabled,
  onChange,
  onRetry,
}: {
  name: string;
  icon: string;
  description: string;
  choices: InstallChoice[];
  value: string;
  selectedLabel?: string;
  blocked: string;
  loading: boolean;
  error: string;
  emptyMessage: string;
  disabled: boolean;
  onChange: (value: string) => void;
  onRetry: () => void;
}) {
  const id = useId();
  const header = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(60);
  const shown = !blocked && !disabled;
  const expanded = open && shown;
  const filtered = choices.filter((choice) =>
    `${choice.file?.version ?? choice.value} ${choice.description}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const visible = filtered.slice(0, limit);
  const options = [
    { value: "", label: "不安装", description: "" },
    ...visible.map((choice) => ({
      value: choice.value,
      label: choice.file?.version ?? choice.value,
      description: choice.description,
    })),
  ];
  const select = (next: string) => {
    onChange(next);
    setOpen(false);
    header.current?.focus({ preventScroll: true });
  };
  const status =
    blocked ||
    (loading
      ? "正在获取版本…"
      : error
        ? "获取失败，展开重试"
        : choices.length
          ? `${choices.length} 个可选版本`
          : emptyMessage);
  return (
    <div
      className={`install-component-presence ${shown ? "is-visible" : ""}`}
      aria-hidden={!shown || undefined}
      inert={!shown}
    >
      <div className="install-component-presence-clip">
        <section
          className={`install-component has-surface ${value ? "is-selected" : ""} ${blocked ? "is-blocked" : ""}`}
          aria-label={`${name} 组件`}
        >
          <PixelFrame />
          <div className="install-component-heading">
            <button
              ref={header}
              type="button"
              className="install-component-toggle"
              aria-label={`选择 ${name}`}
              aria-expanded={expanded}
              aria-controls={id}
              disabled={disabled || !!blocked}
              onClick={() => setOpen((current) => !current)}
            >
              <img src={icon} alt="" draggable={false} />
              <span className="install-component-copy">
                <strong>
                  {name}
                  {value && <Check size={15} aria-label="已选择" />}
                </strong>
                <small>{selectedLabel || description}</small>
                <span className="install-component-status">{status}</span>
              </span>
              <ChevronDown className="install-component-chevron" size={18} />
            </button>
            {value && (
              <Button
                className="install-component-clear"
                aria-label={`取消选择 ${name}`}
                disabled={disabled}
                onClick={() => select("")}
              >
                <X size={15} />
              </Button>
            )}
          </div>
          <div
            id={id}
            className={`install-component-expand ${expanded ? "is-open" : ""}`}
            inert={!expanded}
          >
            <div className="install-component-clip">
              <div
                className="install-component-content"
                onKeyDown={(event) => {
                  if (event.key === "Escape" && !event.defaultPrevented) {
                    event.stopPropagation();
                    setOpen(false);
                    header.current?.focus();
                  }
                }}
              >
                {loading ? (
                  <div className="install-component-loading" role="status">
                    正在获取 {name} 版本…
                  </div>
                ) : error ? (
                  <div className="install-component-error">
                    <p className="inline-error" role="alert">
                      {error}
                    </p>
                    <Button onClick={onRetry} disabled={disabled}>
                      <RefreshCw size={15} />
                      重新获取 {name}
                    </Button>
                  </div>
                ) : (
                  <>
                    {choices.length > 8 && (
                      <SearchField
                        label={`搜索 ${name} 版本`}
                        value={query}
                        onValueChange={(next) => {
                          setQuery(next);
                          setLimit(60);
                        }}
                        placeholder="搜索版本或兼容信息"
                        onKeyDown={(event) => {
                          if (event.key === "Enter") event.preventDefault();
                        }}
                      />
                    )}
                    <div
                      className="install-component-versions"
                      role="radiogroup"
                      aria-label={`${name} 版本`}
                      onKeyDown={(event) => {
                        if (
                          ![
                            "ArrowDown",
                            "ArrowUp",
                            "ArrowLeft",
                            "ArrowRight",
                            "Home",
                            "End",
                          ].includes(event.key) ||
                          disabled
                        )
                          return;
                        const buttons = [
                          ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                            '[role="radio"]',
                          ),
                        ];
                        const index = buttons.indexOf(
                          document.activeElement as HTMLButtonElement,
                        );
                        if (index < 0) return;
                        event.preventDefault();
                        const next =
                          event.key === "Home"
                            ? 0
                            : event.key === "End"
                              ? buttons.length - 1
                              : (index +
                                  (["ArrowDown", "ArrowRight"].includes(
                                    event.key,
                                  )
                                    ? 1
                                    : -1) +
                                  buttons.length) %
                                buttons.length;
                        onChange(options[next].value);
                        buttons[next].focus();
                      }}
                    >
                      {options.map((option, index) => (
                        <button
                          key={option.value}
                          type="button"
                          role="radio"
                          aria-label={
                            option.value
                              ? `${name} ${option.label}`
                              : `不安装 ${name}`
                          }
                          aria-checked={value === option.value}
                          tabIndex={
                            value === option.value ||
                            (!options.some((item) => item.value === value) &&
                              index === 0)
                              ? 0
                              : -1
                          }
                          className="install-component-option has-surface"
                          disabled={disabled}
                          onClick={() => select(option.value)}
                        >
                          <PixelFrame />
                          <span>
                            <strong>{option.label}</strong>
                            {option.description && (
                              <small>{option.description}</small>
                            )}
                          </span>
                          <Check size={16} aria-hidden="true" />
                        </button>
                      ))}
                    </div>
                    {!filtered.length && (
                      <p className="helper">
                        {query
                          ? "没有匹配的版本，试试其他关键词。"
                          : emptyMessage}
                      </p>
                    )}
                    {filtered.length > limit && (
                      <Button
                        className="install-component-more"
                        onClick={() => setLimit((current) => current + 60)}
                      >
                        显示更多版本（剩余 {filtered.length - limit}）
                      </Button>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

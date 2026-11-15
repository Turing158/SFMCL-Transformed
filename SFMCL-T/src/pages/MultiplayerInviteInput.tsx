import { Fragment, useLayoutEffect, useRef, useState } from "react";

const normalize = (value: string) => value.replace(/[\s-]/g, "").toUpperCase();

export function MultiplayerInviteInput({
  id,
  value,
  disabled,
  onValueChange,
  onSubmit,
}: {
  id: string;
  value: string;
  disabled: boolean;
  onValueChange: (value: string) => void;
  onSubmit: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const pendingCaret = useRef<number | null>(null);
  const [focused, setFocused] = useState(false);
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  useLayoutEffect(() => {
    const caret = pendingCaret.current;
    pendingCaret.current = null;
    // Restore during the value commit, before another keyboard event can move it.
    if (caret !== null) input.current?.setSelectionRange(caret, caret);
  });
  const select = (start: number, end = start) => {
    input.current?.setSelectionRange(start, end);
    setSelection({ start, end });
  };
  const update = (next: string, caret: number) => {
    const normalized = next.slice(0, 8);
    const position = Math.min(caret, normalized.length);
    pendingCaret.current = position;
    onValueChange(normalized);
    setSelection({ start: position, end: position });
  };
  return (
    <div className="multiplayer-invite-boxes" data-disabled={disabled}>
      <div
        className="multiplayer-invite-row"
        onPointerDown={(event) => {
          if (disabled || event.button !== 0) return;
          const cell = (event.target as HTMLElement).closest<HTMLElement>(
            "[data-slot]",
          );
          if (!cell) return;
          event.preventDefault();
          input.current?.focus({ preventScroll: true });
          const index = Math.min(Number(cell.dataset.slot), value.length);
          select(index, Math.min(index + 1, value.length));
        }}
      >
        {/* One native field retains normal paste, selection and keyboard editing;
            the eight decorative cells display and track its selection. */}
        <input
          ref={input}
          id={id}
          className="multiplayer-invite-native"
          value={value}
          disabled={disabled}
          maxLength={32}
          aria-invalid={!!value && /[^A-Z0-9]/.test(value)}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="characters"
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onSelect={(event) =>
            setSelection({
              start: event.currentTarget.selectionStart ?? value.length,
              end: event.currentTarget.selectionEnd ?? value.length,
            })
          }
          onChange={(event) => {
            const raw = event.currentTarget.value;
            const caret = normalize(
              raw.slice(0, event.currentTarget.selectionStart ?? raw.length),
            ).length;
            update(normalize(raw), caret);
          }}
          onPaste={(event) => {
            event.preventDefault();
            const pasted = normalize(event.clipboardData.getData("text"));
            const start = event.currentTarget.selectionStart ?? value.length;
            const end = event.currentTarget.selectionEnd ?? start;
            update(
              value.slice(0, start) + pasted + value.slice(end),
              start + pasted.length,
            );
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onSubmit();
            }
          }}
        />
        {Array.from({ length: 8 }, (_, index) => (
          <Fragment key={index}>
            {index === 4 && (
              <span className="multiplayer-invite-divider" aria-hidden="true">
                -
              </span>
            )}
            <span
              className="multiplayer-invite-cell pixel-surface"
              data-slot={index}
              data-empty={!value[index]}
              data-active={
                focused &&
                !disabled &&
                (selection.start === selection.end
                  ? index === Math.min(selection.start, 7)
                  : index >= selection.start && index < selection.end)
              }
              aria-hidden="true"
            >
              {value[index]}
            </span>
          </Fragment>
        ))}
      </div>
    </div>
  );
}

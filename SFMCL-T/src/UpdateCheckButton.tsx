import { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  Check,
  Download,
  LoaderCircle,
  PackageSearch,
  RefreshCw,
} from "lucide-react";
import { api, external } from "./api";
import { AnimatedSwap } from "./AnimatedSwap";
import { Button } from "./components";

type UpdateCheck =
  | { status: "unpublished"; currentVersion: string }
  | { status: "latest"; currentVersion: string; latestVersion: string }
  | {
      status: "available";
      currentVersion: string;
      latestVersion: string;
      htmlUrl: string;
    };
type UpdateState =
  | UpdateCheck
  | { status: "idle" | "checking" }
  | { status: "failed"; message: string };

export function useUpdateCheck() {
  const [state, setState] = useState<UpdateState>({ status: "idle" });
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState("");
  const pending = useRef(false);

  const checkForUpdates = async () => {
    if (pending.current) return;
    pending.current = true;
    setOpenError("");
    setState({ status: "checking" });
    try {
      setState(await api<UpdateCheck>("updates"));
    } catch (error) {
      setState({ status: "failed", message: String(error) });
    } finally {
      pending.current = false;
    }
  };

  const openRelease = async () => {
    if (state.status !== "available" || pending.current) return;
    pending.current = true;
    setOpening(true);
    setOpenError("");
    try {
      await external(state.htmlUrl);
    } catch (error) {
      setOpenError(`无法打开发布页，请重试：${String(error)}`);
    } finally {
      pending.current = false;
      setOpening(false);
    }
  };

  return { state, opening, openError, checkForUpdates, openRelease };
}

export function UpdateCheckButton({
  state,
  opening,
  openError,
  checkForUpdates,
  openRelease,
}: ReturnType<typeof useUpdateCheck>) {
  const checking = state.status === "checking";
  const available = state.status === "available";
  const recheck = state.status === "latest" || state.status === "unpublished";
  const [hovered, setHovered] = useState(false);
  const [focusVisible, setFocusVisible] = useState(false);
  const [settledState, setSettledState] = useState(state);

  useEffect(() => {
    if (!recheck || settledState === state) return;
    // Let a fresh result remain readable before exposing the retry action.
    const timer = window.setTimeout(() => setSettledState(state), 1200);
    return () => window.clearTimeout(timer);
  }, [recheck, settledState, state]);

  const showRetry =
    recheck && settledState === state && (hovered || focusVisible);
  const label = opening
    ? "正在打开…"
    : openError
      ? "打开失败，重试"
      : {
          idle: "检测更新",
          checking: "检测中…",
          available: available
            ? `下载更新 v${state.latestVersion}`
            : "下载更新",
          latest: "无需更新",
          unpublished: "暂无发布",
          failed: "检测失败，重试",
        }[state.status];
  const Icon =
    checking || opening
      ? LoaderCircle
      : openError
        ? AlertCircle
        : {
            idle: RefreshCw,
            checking: LoaderCircle,
            available: Download,
            latest: Check,
            unpublished: PackageSearch,
            failed: AlertCircle,
          }[state.status];
  const displayLabel = showRetry ? "重新检测" : label;
  const DisplayIcon = showRetry ? RefreshCw : Icon;

  return (
    <div
      className="update-check"
      data-update-state={state.status}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="row-actions">
        <Button
          className="update-check-button"
          data-recheck={recheck}
          primary={available && !openError}
          danger={state.status === "failed" || !!openError}
          disabled={checking || opening}
          aria-busy={checking || opening}
          aria-label={displayLabel}
          aria-description={
            openError ||
            (state.status === "failed"
              ? state.message
              : recheck
                ? "点击重新检测更新"
                : undefined)
          }
          onFocus={(event) =>
            setFocusVisible(event.currentTarget.matches(":focus-visible"))
          }
          onBlur={() => setFocusVisible(false)}
          onClick={() => void (available ? openRelease() : checkForUpdates())}
        >
          <AnimatedSwap value={displayLabel} className="update-check-content">
            <span className="update-check-label">
              <DisplayIcon
                size={16}
                className={checking || opening ? "spin" : undefined}
                aria-hidden="true"
              />
              {displayLabel}
            </span>
          </AnimatedSwap>
        </Button>
      </div>
    </div>
  );
}

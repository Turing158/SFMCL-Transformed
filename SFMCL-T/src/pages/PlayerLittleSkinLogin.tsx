import { useEffect, useRef, useState } from "react";
import { Clock3, Copy, ExternalLink, Globe, LoaderCircle } from "lucide-react";
import { api, external } from "../api";
import { Button, PixelFrame } from "../components";
import { useApp } from "../store";
import { usePageActive } from "../PageActivity";
import type { YggdrasilLogin } from "../types";

interface DeviceLogin {
  sessionId: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
}

export function PlayerLittleSkinLogin({
  onAuthorized,
  autoStart = false,
}: {
  onAuthorized: (login: YggdrasilLogin) => void;
  autoStart?: boolean;
}) {
  const app = useApp();
  const pageActive = usePageActive();
  const [device, setDevice] = useState<DeviceLogin | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [browserError, setBrowserError] = useState("");
  const [remaining, setRemaining] = useState(0);
  const generation = useRef(0);
  const session = useRef("");
  const running = useRef(false);
  const deadline = useRef(0);
  const visible = useRef(pageActive);
  const autoStarted = useRef(false);
  visible.current = pageActive;
  const discard = (id: string) => {
    if (id)
      void api("players.yggdrasil.cancel", { sessionId: id }).catch(() => {});
  };
  const cancel = () => {
    generation.current++;
    discard(session.current);
    session.current = "";
    running.current = false;
    setDevice(null);
    setBusy(false);
    setBrowserError("");
  };
  useEffect(() => {
    if (!pageActive) cancel();
    return () => {
      generation.current++;
      discard(session.current);
      session.current = "";
    };
  }, [pageActive]);
  useEffect(() => {
    if (!device) return;
    const timer = window.setInterval(() => {
      const seconds = Math.max(
        0,
        Math.ceil((deadline.current - Date.now()) / 1000),
      );
      setRemaining(seconds);
      if (!seconds) {
        cancel();
        setError("LittleSkin 授权码已过期，请重新登录");
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [device]);
  const openBrowser = async (
    value: DeviceLogin,
    attempt = generation.current,
  ) => {
    setBrowserError("");
    try {
      await external(value.verificationUriComplete || value.verificationUri);
    } catch {
      if (generation.current === attempt)
        setBrowserError("无法打开浏览器，请复制授权链接，在浏览器中打开。");
    }
  };
  const start = async () => {
    if (running.current || !visible.current) return;
    const attempt = ++generation.current;
    running.current = true;
    setBusy(true);
    setError("");
    setBrowserError("");
    try {
      const value = await api<DeviceLogin>("players.yggdrasil.oauth.begin");
      if (generation.current !== attempt || !visible.current) {
        discard(value.sessionId);
        return;
      }
      session.current = value.sessionId;
      deadline.current = Date.now() + value.expiresIn * 1000;
      setRemaining(value.expiresIn);
      setDevice(value);
      void openBrowser(value, attempt);
      const login = await api<YggdrasilLogin>("players.yggdrasil.oauth.wait", {
        sessionId: value.sessionId,
      });
      if (generation.current !== attempt || !visible.current) {
        discard(login.sessionId);
        return;
      }
      // The parent now owns the profile-selection session and its cancellation.
      session.current = "";
      onAuthorized(login);
    } catch (e) {
      if (generation.current === attempt) {
        discard(session.current);
        session.current = "";
        setDevice(null);
        setError(String(e));
      }
    } finally {
      if (generation.current === attempt) {
        running.current = false;
        setBusy(false);
      }
    }
  };
  useEffect(() => {
    if (!autoStart || !pageActive || autoStarted.current) return;
    // Defer past StrictMode's setup/cleanup cycle so one drop starts one session.
    const timer = window.setTimeout(() => {
      autoStarted.current = true;
      void start();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [autoStart, pageActive]);
  return (
    <div className="players-littleskin-form" data-auth-busy={busy}>
      <p className="helper">使用 LittleSkin 浏览器授权，完成后选择游戏角色。</p>
      {device ? (
        <>
          <div className="players-login-label">
            <span>授权码</span>
            <span>
              <Clock3 size={13} />
              <time aria-label="授权码剩余时间">
                {Math.floor(remaining / 60)}:
                {String(remaining % 60).padStart(2, "0")}
              </time>
            </span>
          </div>
          <button
            className="device-code has-surface"
            type="button"
            aria-label={`复制授权码 ${device.userCode}`}
            onClick={() =>
              void app.run(
                () => navigator.clipboard.writeText(device.userCode),
                "授权码已复制",
              )
            }
          >
            <PixelFrame />
            <span className="players-device-code-text">{device.userCode}</span>
            <Copy size={18} />
          </button>
          <div
            className="players-auth-split players-split-button has-surface"
            role="group"
            aria-label="LittleSkin 授权页面操作"
          >
            <PixelFrame />
            <button
              type="button"
              className="players-auth-open"
              onClick={() => void openBrowser(device)}
            >
              <ExternalLink size={15} />
              <span>打开授权页面</span>
            </button>
            <button
              type="button"
              className="players-split-secondary"
              aria-label="复制授权链接"
              data-tooltip="复制授权链接"
              onClick={() =>
                void app.run(
                  () =>
                    navigator.clipboard.writeText(
                      device.verificationUriComplete || device.verificationUri,
                    ),
                  "授权链接已复制",
                )
              }
            >
              <Copy size={15} />
            </button>
          </div>
          {browserError && (
            <p className="inline-error players-browser-error" role="alert">
              {browserError}
            </p>
          )}
          <p className="players-login-status" role="status">
            <LoaderCircle size={13} className="spin" />
            等待浏览器授权，完成后自动继续
          </p>
        </>
      ) : busy ? (
        <p className="players-login-status" role="status">
          <LoaderCircle size={15} className="spin" />
          正在获取 LittleSkin 授权码…
        </p>
      ) : (
        <Button primary disabled={app.busy} onClick={() => void start()}>
          <Globe size={15} />
          {error ? "重新授权 LittleSkin" : "使用 LittleSkin 授权登录"}
        </Button>
      )}
      {busy && <Button onClick={cancel}>取消授权</Button>}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

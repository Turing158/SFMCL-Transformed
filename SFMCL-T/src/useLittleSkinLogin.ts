import { useCallback, useEffect, useRef, useState } from "react";
import { api, external } from "./api";
import { useApp } from "./store";
import { usePageActive } from "./PageActivity";
import type { Step, YggdrasilLogin } from "./types";

interface DeviceLogin {
  sessionId: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
}

type Phase =
  | "idle"
  | "preparing"
  | "waiting"
  | "profiles"
  | "saving"
  | "completed"
  | "failed"
  | "expired";

const stepNames = ["获取授权码", "浏览器授权", "选择游戏角色", "保存角色"];
const stepDetails = [
  "连接 LittleSkin",
  "在浏览器中确认登录",
  "选择本次使用的角色",
  "加入我的角色",
];
const discard = async (sessionId: string) => {
  if (sessionId)
    await api("players.yggdrasil.cancel", { sessionId }).catch(() => {});
};

// Serialize begin/cancel requests across route changes, without blocking on OAuth polling.
let loginQueue: Promise<void> = Promise.resolve();

export function useLittleSkinLogin(active: boolean, routeKey: string) {
  const { refresh, notify, navigate } = useApp();
  const pageActive = usePageActive();
  const [phase, setPhase] = useState<Phase>("preparing");
  const [step, setStep] = useState(0);
  const [device, setDevice] = useState<DeviceLogin | null>(null);
  const [authorized, setAuthorized] = useState<YggdrasilLogin | null>(null);
  const [accountSaved, setAccountSaved] = useState(false);
  const [error, setError] = useState("");
  const [browserError, setBrowserError] = useState("");
  const [remaining, setRemaining] = useState(0);
  const attempt = useRef(0);
  const session = useRef("");
  const running = useRef(false);
  const deadline = useRef(0);
  const visible = useRef(active && pageActive);
  visible.current = active && pageActive;

  const invalidate = useCallback(() => {
    attempt.current++;
    const owned = session.current;
    session.current = "";
    running.current = false;
    if (owned) loginQueue = loginQueue.then(() => discard(owned));
  }, []);

  const cancel = useCallback(() => {
    invalidate();
    setDevice(null);
    setAuthorized(null);
    setAccountSaved(false);
    setBrowserError("");
    setError("");
    setStep(0);
    setPhase("idle");
  }, [invalidate]);

  const finish = useCallback(
    async (token = attempt.current) => {
      setPhase("completed");
      try {
        // Keep the same success scene duration as Microsoft login.
        await Promise.all([
          refresh(),
          new Promise<void>((resolve) => window.setTimeout(resolve, 700)),
        ]);
        if (token !== attempt.current || !visible.current) return;
        notify("LittleSkin 角色已添加");
        navigate({ page: "players" });
      } catch (e) {
        if (token === attempt.current && visible.current) {
          setError(`角色已保存，但列表刷新失败，请重试。${String(e)}`);
          setPhase("failed");
        }
      }
    },
    [refresh, notify, navigate],
  );

  const select = useCallback(
    async (
      value: YggdrasilLogin,
      profileId: string,
      token = attempt.current,
    ) => {
      if (running.current || !visible.current || token !== attempt.current)
        return;
      running.current = true;
      setError("");
      setStep(3);
      setPhase("saving");
      try {
        await api("players.yggdrasil.select", {
          sessionId: value.sessionId,
          profileId,
        });
        if (token !== attempt.current || !visible.current) return;
        session.current = "";
        setAccountSaved(true);
        await finish(token);
      } catch (e) {
        if (token === attempt.current && visible.current) {
          setError(String(e));
          setPhase("failed");
        }
      } finally {
        if (token === attempt.current) running.current = false;
      }
    },
    [finish],
  );

  const openBrowser = useCallback(
    async (value: DeviceLogin, token = attempt.current) => {
      setBrowserError("");
      try {
        await external(value.verificationUriComplete || value.verificationUri);
      } catch {
        if (token === attempt.current && visible.current)
          setBrowserError("无法打开浏览器，请复制授权链接。");
      }
    },
    [],
  );

  const start = useCallback(() => {
    if (running.current || !visible.current) return;
    invalidate();
    const token = attempt.current;
    running.current = true;
    setDevice(null);
    setAuthorized(null);
    setError("");
    setAccountSaved(false);
    setBrowserError("");
    setStep(0);
    setPhase("preparing");
    const wait = async (value: DeviceLogin) => {
      try {
        const result = await api<YggdrasilLogin>(
          "players.yggdrasil.oauth.wait",
          {
            sessionId: value.sessionId,
          },
        );
        if (token !== attempt.current || !visible.current) {
          await discard(result.sessionId);
          return;
        }
        if (!result.profiles.length)
          throw new Error(
            "LittleSkin 账号中没有游戏角色，请先在皮肤站创建角色后重新登录。",
          );
        session.current = result.sessionId;
        running.current = false;
        setBrowserError("");
        setAuthorized(result);
        setStep(2);
        setPhase("profiles");
        if (result.profiles.length === 1)
          void select(result, result.profiles[0].id, token);
      } catch (e) {
        if (token !== attempt.current || !visible.current) return;
        const owned = session.current;
        session.current = "";
        loginQueue = loginQueue.then(() => discard(owned));
        running.current = false;
        setDevice(null);
        setError(String(e));
        setPhase("failed");
      }
    };
    loginQueue = loginQueue.then(async () => {
      if (token !== attempt.current || !visible.current) return;
      try {
        const result = await api<DeviceLogin>("players.yggdrasil.oauth.begin");
        if (token !== attempt.current || !visible.current) {
          await discard(result.sessionId);
          return;
        }
        session.current = result.sessionId;
        deadline.current = Date.now() + result.expiresIn * 1000;
        setRemaining(result.expiresIn);
        setDevice(result);
        setStep(1);
        setPhase("waiting");
        void wait(result);
        // Copy before opening the browser, while the launcher still has focus.
        try {
          await navigator.clipboard.writeText(result.userCode);
          if (token === attempt.current && visible.current)
            notify("授权码已自动复制");
        } catch {
          if (token === attempt.current && visible.current)
            notify("无法自动复制授权码，请点击代码手动复制");
        }
        if (
          token === attempt.current &&
          visible.current &&
          session.current === result.sessionId
        )
          void openBrowser(result, token);
      } catch (e) {
        if (token === attempt.current && visible.current) {
          running.current = false;
          setError(String(e));
          setPhase("failed");
        }
      }
    });
  }, [invalidate, select, notify, openBrowser]);

  useEffect(() => {
    if (!active || !pageActive) return;
    // Defer through StrictMode's discarded setup, so one visit starts one session.
    let mounted = true;
    queueMicrotask(() => {
      if (mounted) start();
    });
    return () => {
      mounted = false;
      invalidate();
    };
  }, [active, pageActive, routeKey, start, invalidate]);

  useEffect(() => {
    if (!active || !pageActive || phase !== "waiting" || !device) return;
    const tick = () => {
      const seconds = Math.max(
        0,
        Math.ceil((deadline.current - Date.now()) / 1000),
      );
      setRemaining(seconds);
      if (!seconds) {
        invalidate();
        setDevice(null);
        setBrowserError("");
        setError("LittleSkin 授权码已过期，请重新登录。");
        setPhase("expired");
      }
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [active, pageActive, phase, device, invalidate]);

  const failed = phase === "failed" || phase === "expired";
  const completed = phase === "completed";
  const steps: Step[] = stepNames.map((name, index) => ({
    name,
    detail: stepDetails[index],
    status:
      completed || index < step
        ? "completed"
        : index === step
          ? failed
            ? "failed"
            : phase === "idle"
              ? "queued"
              : "running"
          : "queued",
  }));

  return {
    login: device,
    authorized,
    accountSaved,
    loading: phase === "preparing",
    busy: ["preparing", "waiting", "saving"].includes(phase),
    state: phase,
    failed,
    completed,
    expired: phase === "expired",
    step,
    steps,
    error,
    browserError,
    remaining,
    start,
    cancel,
    openBrowser: () => device && openBrowser(device),
    select: (profileId: string) => authorized && select(authorized, profileId),
    retryRefresh: () => accountSaved && finish(),
  };
}

export type LittleSkinLoginState = ReturnType<typeof useLittleSkinLogin>;

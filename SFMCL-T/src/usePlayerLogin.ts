import { useCallback, useEffect, useRef, useState } from "react";
import { api, external } from "./api";
import { useApp } from "./store";
import { usePageActive } from "./PageActivity";
import type { Step } from "./types";

interface DeviceLogin {
  jobId: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
}

const stepNames = [
  "等待浏览器授权",
  "验证 Xbox Live",
  "验证 Minecraft 账号",
  "保存角色",
];
const terminal = (status?: string) =>
  ["completed", "failed", "cancelled"].includes(status || "");

// Also serialize across Players unmount/remount when navigating via the sidebar.
let loginQueue: Promise<void> = Promise.resolve();

export function usePlayerLogin(active: boolean) {
  const { tasks, run, refresh, notify, navigate } = useApp();
  const pageActive = usePageActive();
  const [login, setLogin] = useState<DeviceLogin | null>(null);
  const [loading, setLoading] = useState(false);
  const [requestError, setRequestError] = useState("");
  const [browserError, setBrowserError] = useState("");
  const [expiresAt, setExpiresAt] = useState(0);
  const [remaining, setRemaining] = useState(0);
  const attempt = useRef(0);
  const session = useRef<{ id: string; finished: boolean } | null>(null);
  // A new attempt waits for any late device-code response to be cancelled first.
  // This also avoids racing the backend's single-login gate on rapid navigation.
  const notified = useRef("");
  const job = tasks.jobs.find((item) => item.id === login?.jobId);
  const completed = job?.status === "completed";
  const step = completed
    ? 3
    : Math.min(
        3,
        Math.max(
          0,
          job?.currentStep ??
            job?.steps.findIndex((s) =>
              ["running", "failed"].includes(s.status),
            ) ??
            0,
        ),
      );
  const expired = !!login && remaining === 0 && step === 0 && !completed;
  const failed =
    expired ||
    !!requestError ||
    job?.status === "failed" ||
    job?.status === "cancelled";
  const error = expired
    ? "设备代码已过期，请重新登录。"
    : requestError ||
      job?.error ||
      (job?.status === "cancelled" ? "登录已取消。" : "");

  const cancelJob = useCallback(
    async (id: string) => {
      await run(() => api("jobs.cancel", { id }));
    },
    [run],
  );
  const cancel = useCallback(() => {
    attempt.current++;
    const owned = session.current;
    session.current = null;
    if (owned && !owned.finished)
      loginQueue = loginQueue.then(() => cancelJob(owned.id));
  }, [cancelJob]);

  const start = useCallback(() => {
    cancel();
    const token = attempt.current;
    setLogin(null);
    setLoading(true);
    setRequestError("");
    setBrowserError("");
    setExpiresAt(0);
    loginQueue = loginQueue.then(async () => {
      if (token !== attempt.current) return;
      try {
        const result = await api<DeviceLogin>("players.login");
        if (token !== attempt.current) {
          await cancelJob(result.jobId);
          return;
        }
        session.current = { id: result.jobId, finished: false };
        setRemaining(result.expiresIn);
        setExpiresAt(Date.now() + result.expiresIn * 1000);
        setLogin(result);
        setLoading(false);
        // Copy while the launcher still has focus, before the browser opens.
        try {
          await navigator.clipboard.writeText(result.userCode);
          if (token === attempt.current) notify("设备代码已自动复制");
        } catch {
          if (token === attempt.current)
            notify("无法自动复制设备代码，请点击代码手动复制");
        }
        if (token !== attempt.current) return;
        try {
          await external(result.verificationUri);
        } catch (e) {
          if (token === attempt.current)
            setBrowserError(
              `无法打开浏览器，请重试或复制授权链接后手动访问。${String(e)}`,
            );
        }
      } catch (e) {
        if (token === attempt.current) {
          setRequestError(String(e));
          setLoading(false);
        }
      }
    });
  }, [cancel, cancelJob, notify]);

  useEffect(() => {
    if (!active) {
      setLogin(null);
      setLoading(false);
      setRequestError("");
      setBrowserError("");
      return;
    }
    // StrictMode's discarded mount must not launch an extra auth request.
    let mounted = true;
    queueMicrotask(() => {
      if (mounted) start();
    });
    return () => {
      mounted = false;
      cancel();
    };
  }, [active, cancel, start]);

  useEffect(() => {
    if (session.current?.id === job?.id && session.current)
      session.current.finished = terminal(job?.status);
    if (
      active &&
      pageActive &&
      completed &&
      job &&
      notified.current !== job.id
    ) {
      notified.current = job.id;
      const token = attempt.current;
      void run(async () => {
        // Let the success scene finish entering before returning to the character list.
        await Promise.all([
          refresh(),
          new Promise<void>((resolve) => window.setTimeout(resolve, 700)),
        ]);
        // A late refresh must not pull the user out of another page or login.
        if (token !== attempt.current || session.current?.id !== job.id) return;
        notify("Microsoft 账号已添加");
        navigate({ page: "players" });
      });
    }
  }, [active, pageActive, job, completed, refresh, run, notify, navigate]);

  useEffect(() => {
    if (!active || !expiresAt || step !== 0 || terminal(job?.status)) return;
    const tick = () =>
      setRemaining(Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [active, expiresAt, step, job?.status]);

  useEffect(() => {
    if (active && expired) cancel();
  }, [active, expired, cancel]);

  const openBrowser = async () => {
    if (!login || failed || completed) return;
    const token = attempt.current;
    try {
      await external(login.verificationUri);
      if (token === attempt.current) setBrowserError("");
    } catch (e) {
      if (token === attempt.current)
        setBrowserError(
          `无法打开浏览器，可复制授权链接后手动访问。${String(e)}`,
        );
    }
  };
  const baseSteps: Step[] = job?.steps.length
    ? job.steps
    : stepNames.map((name, i) => ({
        name,
        status: i === 0 ? "running" : "queued",
        detail: "",
      }));
  const steps = baseSteps.map((value, index) =>
    failed && index === step ? { ...value, status: "failed" as const } : value,
  );

  return {
    login,
    loading,
    failed,
    error,
    browserError,
    remaining,
    expired,
    completed,
    step,
    steps,
    start,
    openBrowser,
  };
}

export type PlayerLoginState = ReturnType<typeof usePlayerLogin>;

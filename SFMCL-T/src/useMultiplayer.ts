import { useSessionState } from "./windowSession";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, desktop } from "./api";
import { usePageActive } from "./PageActivity";
import { useApp } from "./store";

export type MultiplayerService = "official" | "terracotta" | "custom";
export type MultiplayerSnapshot = {
  state:
    | "idle"
    | "preparing"
    | "connecting"
    | "ready"
    | "waiting"
    | "leaving"
    | "failed";
  sessionId: string | null;
  componentReady: boolean;
  componentVersion: string;
  tunnelReady: boolean;
  tunnelVersion: string;
  terracottaReady: boolean;
  terracottaVersion: string;
  terracottaUnavailable?: string | null;
  terracottaPhase?: string | null;
  componentJobId: string | null;
  role: "host" | "guest" | null;
  name: string;
  gameVersion: string;
  address: string | null;
  worldOpen: boolean;
  members: {
    id: string;
    name: string;
    ip: string;
    connection: string;
    latency: number | null;
    local: boolean;
  }[];
  error: string | null;
  service?: MultiplayerService | null;
  inviteCode?: string | null;
};
type InvitationPreview = { name: string; gameVersion: string; server: string };
const initial: MultiplayerSnapshot = {
  state: "idle",
  sessionId: null,
  componentReady: false,
  componentVersion: "2.6.4",
  tunnelReady: false,
  tunnelVersion: "2026.10.7",
  terracottaReady: false,
  terracottaVersion: "0.4.2",
  componentJobId: null,
  role: null,
  name: "",
  gameVersion: "",
  address: null,
  worldOpen: false,
  members: [],
  error: null,
};

export function useMultiplayer() {
  const active = usePageActive();
  const { notify, reportError } = useApp();
  const [mode, setMode] = useSessionState<"create" | "join">(
    "useMultiplayer.mode",
    "create",
  );
  const [service, setService] = useSessionState<MultiplayerService>(
    "useMultiplayer.service",
    "official",
  );
  const [roomName, setRoomName] = useSessionState(
    "useMultiplayer.roomName",
    "",
  );
  const [port, setPort] = useSessionState("useMultiplayer.port", "");
  const [connectionMode, setConnectionMode] = useSessionState<
    "tunnel" | "shared"
  >("useMultiplayer.connectionMode", "shared");
  const [server, setServer] = useSessionState("useMultiplayer.server", "");
  const [hostLaunchId, setHostLaunchId] = useSessionState(
    "useMultiplayer.hostLaunchId",
    "",
  );
  // Credentials stay in memory; never persist or log the draft.
  const [drafts, setDrafts] = useSessionState("useMultiplayer.invitations", {
    official: "",
    terracotta: "",
    custom: "",
  });
  const invitation = drafts[service];
  const [oldRoom, setOldRoom] = useSessionState(
    "useMultiplayer.terracotta.room",
    "",
  );
  const [nodes, setNodes] = useSessionState(
    "useMultiplayer.terracotta.nodes",
    "",
  );
  const [preview, setPreview] = useState<InvitationPreview | null>(null);
  const [snapshot, setSnapshot] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [inspecting, setInspecting] = useState(false);
  const [loading, setLoading] = useState(desktop);
  const [statusUnavailable, setStatusUnavailable] = useState(false);
  const [checkingPort, setCheckingPort] = useState(false);
  const statusErrorReported = useRef(false);
  const reportedSessionError = useRef("");
  const pending = useRef(false);
  const generation = useRef(0);
  const previewGeneration = useRef(0);
  const portGeneration = useRef(0);
  const refresh = useCallback(
    async (manual = false) => {
      if (!desktop) return;
      const request = generation.current;
      try {
        const value = await api<MultiplayerSnapshot>("multiplayer.status");
        if (request === generation.current) {
          setSnapshot(value);
          setLoading(false);
          setStatusUnavailable(false);
          statusErrorReported.current = false;
        }
      } catch {
        if (request === generation.current) {
          setStatusUnavailable(true);
          setLoading(false);
          if (manual || !statusErrorReported.current) {
            reportError("无法读取联机状态，请重试");
            statusErrorReported.current = true;
          }
        }
      }
    },
    [reportError],
  );
  useEffect(() => {
    if (!active || !desktop) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      await refresh();
      if (!cancelled) timer = setTimeout(poll, 2000);
    }
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      generation.current++;
      previewGeneration.current++;
      portGeneration.current++;
      setCheckingPort(false);
      setInspecting(false);
    };
  }, [active, refresh]);
  useEffect(() => {
    if (!snapshot.error) {
      reportedSessionError.current = "";
      return;
    }
    const key = `${snapshot.sessionId ?? ""}:${snapshot.error}`;
    if (active && key !== reportedSessionError.current) {
      reportedSessionError.current = key;
      reportError(snapshot.error);
    }
  }, [active, snapshot.error, snapshot.sessionId, reportError]);
  useEffect(() => {
    if (snapshot.role === "guest" && snapshot.state === "ready") {
      const current = snapshot.service ?? service;
      setDrafts((previous) =>
        previous[current] ? { ...previous, [current]: "" } : previous,
      );
      setPreview(null);
    }
  }, [snapshot.role, snapshot.state, snapshot.service, service, setDrafts]);
  async function action(operation: string, payload: unknown = {}) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    generation.current++;
    try {
      const result = await api<MultiplayerSnapshot>(operation, payload);
      generation.current++;
      setSnapshot(result);
      setStatusUnavailable(false);
      statusErrorReported.current = false;
      if (operation === "multiplayer.leave") {
        const current = snapshot.service ?? service;
        setDrafts((previous) => ({ ...previous, [current]: "" }));
        if (current === "terracotta") setOldRoom("");
        setPreview(null);
      }
      return result;
    } catch (cause) {
      reportError(String(cause));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  function changeInvitation(value: string) {
    previewGeneration.current++;
    setInspecting(false);
    setDrafts((previous) => ({ ...previous, [service]: value }));
    setPreview(null);
  }
  function changeService(value: MultiplayerService) {
    previewGeneration.current++;
    setInspecting(false);
    setService(value);
    portGeneration.current++;
    setCheckingPort(false);
    setPreview(null);
  }
  function changePort(value: string) {
    portGeneration.current++;
    setPort(value);
    setCheckingPort(false);
  }
  async function inspect() {
    if (inspecting) return;
    if (service === "official" && !/^[a-z0-9]{8}$/i.test(invitation.trim())) {
      reportError("请输入 8 位英文字母或数字邀请码");
      return;
    }
    const request = ++previewGeneration.current;
    setInspecting(true);
    try {
      const value = await api<InvitationPreview>(
        service === "official"
          ? "multiplayer.official.preview"
          : "multiplayer.preview",
        {
          invitation,
        },
      );
      if (request === previewGeneration.current) setPreview(value);
    } catch (cause) {
      if (request === previewGeneration.current) reportError(String(cause));
    } finally {
      if (request === previewGeneration.current) setInspecting(false);
    }
  }
  function validatePort() {
    if (!/^\d{1,5}$/.test(port) || +port < 1 || +port > 65535) {
      reportError("请输入 1–65535 之间的整数端口");
      return false;
    }
    return true;
  }
  async function checkPort() {
    if (!validatePort()) return;
    const request = ++portGeneration.current;
    setCheckingPort(true);
    try {
      const result = await api<{ reachable: boolean }>(
        "multiplayer.check-local-port",
        { port: +port },
      );
      if (request === portGeneration.current) {
        if (result.reachable) notify("端口可连接");
        else reportError("端口未开放");
      }
    } catch {
      if (request === portGeneration.current) reportError("检查失败，请重试");
    } finally {
      if (request === portGeneration.current) setCheckingPort(false);
    }
  }
  return {
    mode,
    setMode,
    service,
    changeService,
    inspecting,
    roomName,
    setRoomName,
    port,
    changePort,
    connectionMode,
    setConnectionMode,
    server,
    setServer,
    hostLaunchId,
    setHostLaunchId,
    invitation,
    changeInvitation,
    oldRoom,
    setOldRoom,
    nodes,
    setNodes,
    preview,
    inspect,
    snapshot,
    statusUnavailable,
    loading,
    busy,
    action,
    refresh,
    checkingPort,
    validatePort,
    checkPort,
  };
}

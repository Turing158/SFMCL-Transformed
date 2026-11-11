import { useCallback, useEffect, useRef, useState } from "react";
import { api, desktop } from "./api";
import { usePageActive } from "./PageActivity";

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
};
type InvitationPreview = { name: string; gameVersion: string; server: string };
const initial: MultiplayerSnapshot = {
  state: "idle",
  sessionId: null,
  componentReady: false,
  componentVersion: "2.6.4",
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
  const [mode, setMode] = useState<"create" | "join">("create");
  const [roomName, setRoomName] = useState("");
  const [port, setPort] = useState("");
  const [connectionMode, setConnectionMode] = useState<"tunnel" | "shared">(
    "tunnel",
  );
  const [server, setServer] = useState("");
  const [hostLaunchId, setHostLaunchId] = useState("");
  // Credentials stay in memory; never persist or log the draft.
  const [invitation, setInvitation] = useState("");
  const [preview, setPreview] = useState<InvitationPreview | null>(null);
  const [snapshot, setSnapshot] = useState(initial);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(desktop);
  const [check, setCheck] = useState("");
  const pending = useRef(false);
  const generation = useRef(0);
  const previewGeneration = useRef(0);
  const portGeneration = useRef(0);
  const refresh = useCallback(async () => {
    if (!desktop) return;
    const request = generation.current;
    try {
      const value = await api<MultiplayerSnapshot>("multiplayer.status");
      if (request === generation.current) {
        setSnapshot(value);
        setLoading(false);
      }
    } catch {
      if (request === generation.current) {
        setError("无法读取联机状态，请重试");
        setLoading(false);
      }
    }
  }, []);
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
    };
  }, [active, refresh]);
  useEffect(() => {
    if (snapshot.role === "guest" && snapshot.state === "ready") {
      setInvitation("");
      setPreview(null);
    }
  }, [snapshot.role, snapshot.state]);
  async function action(operation: string, payload: unknown = {}) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    generation.current++;
    try {
      const result = await api<MultiplayerSnapshot>(operation, payload);
      generation.current++;
      setSnapshot(result);
      if (operation === "multiplayer.leave") {
        setInvitation("");
        setPreview(null);
      }
      return result;
    } catch (cause) {
      setError(String(cause));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  function changeInvitation(value: string) {
    previewGeneration.current++;
    setInvitation(value);
    setPreview(null);
    setError("");
  }
  function changePort(value: string) {
    portGeneration.current++;
    setPort(value);
    setCheck("");
  }
  async function inspect() {
    const request = ++previewGeneration.current;
    setError("");
    try {
      const value = await api<InvitationPreview>("multiplayer.preview", {
        invitation,
      });
      if (request === previewGeneration.current) setPreview(value);
    } catch (cause) {
      if (request === previewGeneration.current) setError(String(cause));
    }
  }
  async function checkPort() {
    if (!/^\d{1,5}$/.test(port) || +port < 1 || +port > 65535) {
      setCheck("请输入 1–65535 之间的整数端口");
      return;
    }
    const request = ++portGeneration.current;
    setCheck("检查中…");
    try {
      const result = await api<{ reachable: boolean }>(
        "multiplayer.check-local-port",
        { port: +port },
      );
      if (request === portGeneration.current)
        setCheck(result.reachable ? "端口可连接" : "端口未开放");
    } catch {
      if (request === portGeneration.current) setCheck("检查失败，请重试");
    }
  }
  return {
    mode,
    setMode,
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
    preview,
    inspect,
    snapshot,
    error,
    setError,
    loading,
    busy,
    action,
    refresh,
    check,
    checkPort,
  };
}

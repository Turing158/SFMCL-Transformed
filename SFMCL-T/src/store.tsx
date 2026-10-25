import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { api, desktop } from "./api";
import { PRODUCT_NAME } from "./branding";
import { invalidateImages } from "./images";
import {
  initialNavigation,
  navigateTo,
  navigationPage,
  switchPage,
} from "./navigation";
import { withJavaPaths } from "./gameSettings";
import type { Notification, NotificationKind } from "./notifications";
import type {
  NavigationEntry,
  NavigationState,
  PlayerLoginKind,
  ResourceTab,
  VersionPage,
} from "./navigation";
import type {
  Bootstrap,
  FavoriteVersion,
  Page,
  Settings,
  Tasks,
  Version,
} from "./types";
const fallback: Settings = {
  schemaVersion: 1,
  gameDirs: [],
  activeDir: "",
  activeVersion: "",
  activePlayer: "",
  javaPath: "",
  javaPaths: [],
  autoMemory: true,
  memoryMb: 4096,
  isolation: true,
  fullscreen: false,
  width: 1280,
  height: 720,
  windowTitle: "",
  customInfo: PRODUCT_NAME,
  jvmArgsEnabled: false,
  jvmArgs: "",
  gameArgs: "",
  theme: "light",
  accent: "forest",
  backgroundType: "none",
  background: "",
  hardwareAcceleration: true,
  showNotices: true,
  downloadTaskDisplay: "off",
  downloadConcurrency: 8,
  downloadCacheDir: "",
  microsoftClientId: "",
  closeOnLaunch: false,
};
interface AppState {
  initialized: boolean;
  startupError: string;
  data: Bootstrap;
  versions: Version[];
  versionsRevision: number;
  favorites: FavoriteVersion[];
  tasks: Tasks;
  clearingDownloads: ReadonlySet<string>;
  clearDownload: (id: string) => Promise<void>;
  page: Page;
  setPage: (p: Page, sourcePage?: Page) => void;
  route: NavigationEntry;
  pageRoutes: NavigationState["pages"];
  navigate: (entry: NavigationEntry, sourcePage?: Page) => void;
  openVersionPage: (kind: VersionPage, version: Version) => void;
  openResources: (tab: ResourceTab) => void;
  openPlayerLogin: (kind: PlayerLoginKind) => void;
  setNavigationGuard: (
    page: Page,
    guard: (() => boolean | Promise<boolean>) | null,
  ) => void;
  busy: boolean;
  error: string;
  notifications: Notification[];
  notify: (s: string) => void;
  dismissNotification: (id: number) => void;
  clearError: () => void;
  refresh: () => Promise<void>;
  selectPlayer: (id: string) => Promise<void>;
  selectVersion: (version: Version) => Promise<void>;
  run: <T>(
    action: () => Promise<T>,
    message?: string,
  ) => Promise<T | undefined>;
  mutate: (op: string, p?: unknown, message?: string) => Promise<unknown>;
  update: (op: string, p?: unknown, message?: string) => Promise<unknown>;
  save: (s: Settings) => Promise<void>;
  saveJavaPaths: (paths: string[], removedPath?: string) => Promise<string[]>;
}
const Context = createContext<AppState | null>(null);
export function Provider({ children }: { children: ReactNode }) {
  const [initialized, setInitialized] = useState(false);
  const [startupError, setStartupError] = useState("");
  const [data, setData] = useState<Bootstrap>({
    settings: fallback,
    players: [],
    dataDir: "",
    version: "0.1.0",
  });
  const [versions, setVersions] = useState<Version[]>([]);
  const [versionsRevision, setVersionsRevision] = useState(0);
  const settingsRef = useRef(data.settings);
  settingsRef.current = data.settings;
  const [favorites, setFavorites] = useState<FavoriteVersion[]>([]);
  const [tasks, setTasks] = useState<Tasks>({ downloads: [], jobs: [] });
  const tasksGeneration = useRef(0);
  const pendingDownloadClears = useRef(new Set<string>());
  const [clearingDownloads, setClearingDownloads] = useState<
    ReadonlySet<string>
  >(new Set());
  const [navigation, setNavigation] = useState(initialNavigation);
  const { route } = navigation;
  const page = navigationPage(route);
  const navigationRef = useRef(navigation);
  navigationRef.current = navigation;
  const navigationGuards = useRef(
    new Map<Page, () => boolean | Promise<boolean>>(),
  );
  const navigating = useRef(false);
  const setNavigationGuard = useCallback(
    (page: Page, guard: (() => boolean | Promise<boolean>) | null) => {
      if (guard) navigationGuards.current.set(page, guard);
      else navigationGuards.current.delete(page);
    },
    [],
  );
  const [pending, setPending] = useState(0);
  const refreshGeneration = useRef(0);
  const selectionWrites = useRef<Promise<void>>(Promise.resolve());
  const busy = pending > 0;
  const [error, setErrorMessage] = useState("");
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const notificationId = useRef(0);
  const addNotification = useCallback(
    (kind: NotificationKind, message: string) => {
      if (!message.trim()) return;
      // Allocate outside the updater: StrictMode may replay state updaters.
      const notification = { id: ++notificationId.current, kind, message };
      setNotifications((current) => [notification, ...current]);
    },
    [],
  );
  const notify = useCallback(
    (message: string) => addNotification("success", message),
    [addNotification],
  );
  const setError = useCallback(
    (message: string) => {
      setErrorMessage(message);
      if (message) addNotification("error", message);
    },
    [addNotification],
  );
  const dismissNotification = useCallback((id: number) => {
    setNotifications((current) => current.filter((item) => item.id !== id));
  }, []);
  const refresh = useCallback(async () => {
    if (!desktop) return;
    const generation = ++refreshGeneration.current;
    while (generation === refreshGeneration.current) {
      const selection = selectionWrites.current;
      await selection;
      if (generation !== refreshGeneration.current) return;
      const value = await api<Bootstrap>("bootstrap");
      const [versions, favorites] = await Promise.all([
        value.settings.activeDir
          ? api<Version[]>("versions.list")
          : Promise.resolve([]),
        api<FavoriteVersion[]>("versions.favorites"),
      ]);
      if (generation !== refreshGeneration.current) return;
      // A background refresh must not restore a selection captured before a click.
      if (selection !== selectionWrites.current) continue;
      settingsRef.current = value.settings;
      setData(value);
      setVersions(versions);
      setVersionsRevision((revision) => revision + 1);
      setFavorites(favorites);
      invalidateImages();
      return;
    }
  }, []);
  const selectPlayer = useCallback(
    (id: string) => {
      // Serialize writes without disabling unrelated controls or reloading images.
      const selection = selectionWrites.current.then(async () => {
        setError("");
        try {
          await api("players.select", { id });
          settingsRef.current = { ...settingsRef.current, activePlayer: id };
          setData((current) => ({
            ...current,
            settings: { ...current.settings, activePlayer: id },
          }));
        } catch (e) {
          setError(String(e));
        }
      });
      selectionWrites.current = selection;
      return selection;
    },
    [setError],
  );
  const selectVersion = useCallback(
    (version: Version) => {
      const selection = selectionWrites.current.then(async () => {
        setError("");
        const settings = settingsRef.current;
        const directory = version.directory ?? settings.activeDir;
        if (
          settings.activeDir === directory &&
          settings.activeVersion === version.id
        )
          return;
        try {
          // Only a directory change needs another list; selection never changes
          // the catalog or images already displayed by the management page.
          const nextVersions =
            directory === settings.activeDir
              ? null
              : await api<Version[]>("versions.list", { directory });
          await api("versions.select", { id: version.id, directory });
          settingsRef.current = {
            ...settingsRef.current,
            activeDir: directory,
            activeVersion: version.id,
          };
          setData((current) => ({
            ...current,
            settings: {
              ...current.settings,
              activeDir: directory,
              activeVersion: version.id,
            },
          }));
          if (nextVersions) setVersions(nextVersions);
          notify("已选择游戏版本");
        } catch (e) {
          setError(String(e));
        }
      });
      selectionWrites.current = selection;
      return selection;
    },
    [notify, setError],
  );
  const run = useCallback(
    async <T,>(action: () => Promise<T>, message?: string) => {
      setPending((count) => count + 1);
      setError("");
      try {
        // Subsequent actions (including launch) use the persisted selection.
        await selectionWrites.current;
        const result = await action();
        if (message) notify(message);
        return result;
      } catch (e) {
        setError(String(e));
        return undefined;
      } finally {
        setPending((count) => count - 1);
      }
    },
    [notify, setError],
  );
  const clearDownload = useCallback(
    async (id: string) => {
      if (pendingDownloadClears.current.has(id)) return;
      pendingDownloadClears.current.add(id);
      setClearingDownloads(new Set(pendingDownloadClears.current));
      try {
        await run(async () => {
          await api("downloads.control", { id, action: "clear" });
          // An older poll must not restore a record after its deletion succeeds.
          tasksGeneration.current += 1;
          setTasks((current) => ({
            ...current,
            downloads: current.downloads.filter(
              (download) => download.id !== id,
            ),
          }));
        });
      } finally {
        pendingDownloadClears.current.delete(id);
        setClearingDownloads(new Set(pendingDownloadClears.current));
      }
    },
    [run],
  );
  const navigate = useCallback(
    (next: NavigationEntry, sourcePage?: Page) => {
      if (navigating.current) return;
      const current = navigationRef.current;
      const nextPage = navigationPage(next);
      if (
        sourcePage &&
        navigationPage(current.route) !== sourcePage &&
        nextPage !== sourcePage
      )
        return;
      // An explicit route replaces the target page's child, even if it is hidden.
      const guard =
        next === current.pages[nextPage]
          ? null
          : navigationGuards.current.get(nextPage);
      if (!guard) {
        setNavigation((current) => navigateTo(current, next, sourcePage));
        return;
      }
      navigating.current = true;
      void run(async () => {
        try {
          if (await guard())
            setNavigation((current) => navigateTo(current, next, sourcePage));
        } finally {
          navigating.current = false;
        }
      });
    },
    [run],
  );
  const setPage = useCallback((page: Page, sourcePage?: Page) => {
    if (!navigating.current)
      setNavigation((current) => switchPage(current, page, sourcePage));
  }, []);
  const openResources = useCallback(
    (tab: ResourceTab) => navigate({ page: "resources", tab }),
    [navigate],
  );
  const openVersionPage = useCallback(
    (kind: VersionPage, version: Version) =>
      navigate({ page: "versions", detail: { kind, version } }),
    [navigate],
  );
  const openPlayerLogin = useCallback(
    (login: PlayerLoginKind) => navigate({ page: "players", login }),
    [navigate],
  );
  const update = useCallback(
    async (op: string, p: unknown = {}, message?: string) => {
      const result = await api(op, p);
      await refresh();
      if (message) notify(message);
      return result;
    },
    [refresh, notify],
  );
  const mutate = useCallback(
    (op: string, p: unknown = {}, message?: string) =>
      run(() => update(op, p, message)),
    [run, update],
  );
  const save = useCallback(
    async (settings: Settings) => {
      await api<Settings>("settings.save", settings);
      await refresh();
    },
    [refresh],
  );
  const saveJavaPaths = useCallback(
    async (paths: string[], removedPath?: string) => {
      const saved = await api<string[]>("java.paths.save", {
        paths,
        removedPath,
      });
      setData((current) => ({
        ...current,
        settings: withJavaPaths(current.settings, saved, removedPath),
      }));
      return saved;
    },
    [],
  );
  useEffect(() => {
    let active = true;
    setPending((count) => count + 1);
    void refresh()
      .then(() => {
        if (active) setInitialized(true);
      })
      .catch((error) => {
        if (active) setStartupError(String(error));
      })
      .finally(() => setPending((count) => count - 1));
    return () => {
      active = false;
    };
  }, [refresh]);
  useEffect(() => {
    if (!desktop || !initialized) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    let lastPollError = "";
    const completed = new Set<string>();
    const poll = async () => {
      try {
        const generation = tasksGeneration.current;
        const next = await api<Tasks>("tasks");
        lastPollError = "";
        if (active && generation === tasksGeneration.current) setTasks(next);
        const newlyCompleted = next.jobs.filter(
          (j) => j.status === "completed" && !completed.has(j.id),
        );
        newlyCompleted.forEach((j) => completed.add(j.id));
        if (active && newlyCompleted.length > 0) await refresh();
      } catch (e) {
        // One outage should not create a new card on every 500 ms poll.
        const message = String(e);
        if (active && message !== lastPollError) setError(message);
        lastPollError = message;
      } finally {
        if (active) timer = setTimeout(poll, 500);
      }
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [refresh, setError, initialized]);
  useEffect(() => {
    if (!initialized) return;
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme =
        data.settings.theme === "system"
          ? media.matches
            ? "dark"
            : "light"
          : data.settings.theme;
      document.documentElement.dataset.accent = data.settings.accent;
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [data.settings.theme, data.settings.accent, initialized]);
  return (
    <Context.Provider
      value={{
        initialized,
        startupError,
        data,
        versions,
        versionsRevision,
        favorites,
        tasks,
        clearingDownloads,
        clearDownload,
        page,
        setPage,
        route,
        pageRoutes: navigation.pages,
        navigate,
        openVersionPage,
        openResources,
        openPlayerLogin,
        setNavigationGuard,
        busy,
        error,
        notifications,
        notify,
        dismissNotification,
        clearError: () => setError(""),
        refresh,
        selectPlayer,
        selectVersion,
        run,
        mutate,
        update,
        save,
        saveJavaPaths,
      }}
    >
      {children}
    </Context.Provider>
  );
}
// A retained page must keep its own route while shared data continues updating.
export function PageRouteProvider({
  route,
  children,
}: {
  route: NavigationEntry;
  children: ReactNode;
}) {
  const app = useApp();
  const page = navigationPage(route);
  const navigate = useCallback(
    (entry: NavigationEntry) => app.navigate(entry, page),
    [app.navigate, page],
  );
  const setPage = useCallback(
    (nextPage: Page) => app.setPage(nextPage, page),
    [app.setPage, page],
  );
  return (
    <Context.Provider
      value={{
        ...app,
        route,
        page,
        navigate,
        setPage,
        openResources: (tab) => navigate({ page: "resources", tab }),
        openVersionPage: (kind, version) =>
          navigate({ page: "versions", detail: { kind, version } }),
        openPlayerLogin: (login) => navigate({ page: "players", login }),
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function useApp() {
  const app = useContext(Context);
  if (!app) throw new Error("App provider missing");
  return app;
}

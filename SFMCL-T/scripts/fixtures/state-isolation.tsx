import { createRoot } from "react-dom/client";
import {
  Provider,
  PageRouteProvider,
  useApp,
  useNotifications,
} from "../../src/store";
import { useTasks, useTaskSelector } from "../../src/tasks";
import { useImageResource } from "../../src/useImageResource";

const renders: Record<string, number> = {};
const harness = { renders, app: null as ReturnType<typeof useApp> | null };
Object.assign(window, { __stateIsolation: harness });
const count = (name: string) => {
  renders[name] = (renders[name] ?? 0) + 1;
};
function DataProbe() {
  harness.app = useApp();
  count("data");
  return <span data-ready={harness.app.initialized} />;
}
function RetainedPageProbe() {
  useApp();
  count("retained");
  return null;
}
function TaskProbe() {
  const tasks = useTasks();
  count("tasks");
  return <span data-bytes={tasks.downloads[0]?.downloaded ?? 0} />;
}
function StatusProbe() {
  const active = useTaskSelector((tasks) =>
    tasks.downloads.some((item) => item.status === "running"),
  );
  count("status");
  return <span data-active={active} />;
}
function NotificationProbe() {
  useNotifications();
  count("notifications");
  return null;
}
function ImageProbe({ path }: { path: string }) {
  const image = useImageResource(path);
  return (
    <img
      data-path={path}
      data-ready={image.ready}
      src={image.url || undefined}
    />
  );
}
const route = { page: "settings" } as const;
createRoot(document.getElementById("root")!).render(
  <Provider>
    <DataProbe />
    <TaskProbe />
    <StatusProbe />
    <NotificationProbe />
    <PageRouteProvider route={route}>
      <RetainedPageProbe />
    </PageRouteProvider>
    <ImageProbe path="C:/Pixel-Test/skin.png" />
    <ImageProbe path="C:/Pixel-Test/skin.png" />
    <ImageProbe path="C:/Pixel-Test/background.png" />
  </Provider>,
);

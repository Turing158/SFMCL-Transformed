export type HomeWidgetType =
  | "notice"
  | "notices"
  | "player"
  | "info"
  | "announcement"
  | "links"
  | "version";
export type HomeWidgetTemplate = Exclude<HomeWidgetType, "notice">;

type WidgetBase = { id: string; visible: boolean };
export type HomeWidget = WidgetBase &
  (
    | { type: "notices" | "player" | "links" | "version" }
    | { type: "notice"; noticeKey: string }
    | { type: "info"; title: string; content: string; note: string }
    | { type: "announcement"; title: string; content: string }
  );
export interface HomeContentConfig {
  schemaVersion: 1;
  widgets: HomeWidget[];
}
export const homeWidgetNames: Record<HomeWidgetType, string> = {
  notice: "新闻资讯",
  notices: "新闻资讯",
  player: "角色卡片",
  info: "自定义信息",
  announcement: "折叠公告",
  links: "快捷入口",
  version: "版本卡片",
};
export const homeWidgetTypes: HomeWidgetTemplate[] = [
  "notices",
  "player",
  "info",
  "announcement",
  "links",
  "version",
];
export const repeatableWidget = (type: HomeWidgetType) =>
  type === "info" || type === "announcement";
export function defaultHomeContent(): HomeContentConfig {
  // Existing installations keep their exact notice collection and notice order.
  return {
    schemaVersion: 1,
    widgets: [{ id: "builtin:notices", type: "notices", visible: true }],
  };
}
export function createHomeWidget(
  type: HomeWidgetTemplate,
  title = "",
  content = "",
  note = "",
): HomeWidget {
  const base = { id: crypto.randomUUID(), visible: true };
  if (type === "info") return { ...base, type, title, content, note };
  if (type === "announcement") return { ...base, type, title, content };
  return { ...base, type };
}
export function validateHomeContent(value: unknown): HomeContentConfig {
  if (!value || typeof value !== "object") throw new Error("首页组件配置无效");
  const config = value as HomeContentConfig;
  if (config.schemaVersion !== 1 || !Array.isArray(config.widgets))
    throw new Error("首页组件配置版本不受支持");
  if (
    config.widgets.filter((item) => item?.type !== "notice").length > 30 ||
    config.widgets.length > 1024
  )
    throw new Error("首页最多支持 30 个自定义与固定组件");
  const ids = new Set<string>();
  const singletons = new Set<string>();
  for (const item of config.widgets) {
    if (
      !item ||
      typeof item.id !== "string" ||
      !item.id.trim() ||
      item.id.length > (item.type === "notice" ? 4096 : 128) ||
      ids.has(item.id) ||
      typeof item.visible !== "boolean" ||
      !(
        homeWidgetTypes.includes(item.type as HomeWidgetTemplate) ||
        item.type === "notice"
      )
    )
      throw new Error("首页组件标识或类型无效");
    ids.add(item.id);
    if (!repeatableWidget(item.type)) {
      const identity = item.type === "notice" ? item.noticeKey : item.type;
      if (
        item.type === "notice" &&
        (typeof item.noticeKey !== "string" ||
          !item.noticeKey.startsWith("notice:") ||
          item.noticeKey.length > 4096)
      )
        throw new Error("新闻资讯引用无效");
      if (singletons.has(identity))
        throw new Error(`${homeWidgetNames[item.type]}只能添加一个`);
      singletons.add(identity);
    }
    if (item.type === "info" || item.type === "announcement") {
      if (
        typeof item.title !== "string" ||
        !item.title.trim() ||
        Array.from(item.title).length > 120 ||
        typeof item.content !== "string" ||
        !item.content.trim() ||
        Array.from(item.content).length > 100_000 ||
        (item.type === "info" &&
          (typeof item.note !== "string" || Array.from(item.note).length > 120))
      )
        throw new Error("请填写有效的组件标题和内容");
    }
  }
  return config;
}
export function withHomeWidget(
  config: HomeContentConfig,
  item: HomeWidget,
): HomeContentConfig {
  const existing = !repeatableWidget(item.type)
    ? config.widgets.find(
        (widget) =>
          widget.type === item.type &&
          (item.type !== "notice" ||
            (widget.type === "notice" && widget.noticeKey === item.noticeKey)),
      )
    : undefined;
  return validateHomeContent({
    ...config,
    widgets: existing
      ? config.widgets.map((widget) =>
          widget.id === existing.id ? { ...widget, visible: true } : widget,
        )
      : [...config.widgets, item],
  });
}
export function reorderHomeWidgets(
  config: HomeContentConfig,
  keys: string[],
  availableKeys?: string[],
): HomeContentConfig {
  // Hidden instances retain their rank, and later restoration retains their ID.
  const visible = config.widgets.filter(
    (item) =>
      item.visible && (!availableKeys || availableKeys.includes(item.id)),
  );
  const visibleIds = new Set(visible.map((item) => item.id));
  if (
    keys.length !== visible.length ||
    new Set(keys).size !== keys.length ||
    keys.some((key) => !visible.some((item) => item.id === key))
  )
    return config;
  const items = new Map(visible.map((item) => [item.id, item]));
  let index = 0;
  return {
    ...config,
    widgets: config.widgets.map((item) =>
      visibleIds.has(item.id) ? items.get(keys[index++])! : item,
    ),
  };
}

export function reconcileHomeNotices(
  config: HomeContentConfig,
  noticeKeys: string[],
  previousOrder: string[] = [],
): HomeContentConfig {
  if (!noticeKeys.length) return config;
  const ranks = new Map(previousOrder.map((key, index) => [key, index]));
  const keys = [...new Set(noticeKeys)].sort(
    (a, b) =>
      (ranks.get(a) ?? previousOrder.length) -
      (ranks.get(b) ?? previousOrder.length),
  );
  const known = new Set(
    config.widgets.flatMap((item) =>
      item.type === "notice" ? [item.noticeKey] : [],
    ),
  );
  const added: HomeWidget[] = keys
    .filter((key) => !known.has(key))
    .map((key) => ({ id: key, type: "notice", noticeKey: key, visible: true }));
  const anchor = config.widgets.find((item) => item.type === "notices");
  if (!anchor && !added.length) return config;
  if (anchor)
    return validateHomeContent({
      ...config,
      widgets: config.widgets.flatMap((item) =>
        item === anchor
          ? added.map((notice) => ({ ...notice, visible: anchor.visible }))
          : [item],
      ),
    });
  const widgets = [...config.widgets];
  let lastNotice = -1;
  widgets.forEach((item, index) => {
    if (item.type === "notice") lastNotice = index;
  });
  widgets.splice(lastNotice < 0 ? widgets.length : lastNotice + 1, 0, ...added);
  return validateHomeContent({ ...config, widgets });
}

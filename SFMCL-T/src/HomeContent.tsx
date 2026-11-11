import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import {
  ArrowRight,
  Box,
  Check,
  ChevronDown,
  EyeOff,
  FileText,
  Link,
  NotebookPen,
  Play,
  Plus,
  SlidersHorizontal,
  UsersRound,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import { external } from "./api";
import {
  Button,
  Modal,
  PixelFrame,
  ResourceImage,
  Skin,
  TabList,
  TabPanel,
  useImage,
} from "./components";
import { Input, Textarea } from "./controls";
import {
  NoticePanel,
  NoticeRefreshButton,
  noticeKey,
  type Notice,
  type useNotices,
} from "./Notices";
import { PageHeader } from "./PageHeader";
import { usePageActive } from "./PageActivity";
import { AnimatedNoticeList } from "./AnimatedNoticeList";
import { useTabContentTransition } from "./useTabContentTransition";
import { useApp } from "./store";
import { useHomeContent } from "./useHomeContent";
import { versionIcon } from "./versionIcon";
import { noticeReorderOptions } from "./useNoticeReorder";
import {
  createHomeWidget,
  homeWidgetNames,
  reorderHomeWidgets,
  withHomeWidget,
  reconcileHomeNotices,
  type HomeWidget,
  type HomeWidgetType,
} from "./homeContentConfig";
import "./home-content.css";

const icons: Record<HomeWidgetType, ReactNode> = {
  notice: <FileText size={17} />,
  notices: <FileText size={17} />,
  player: <UsersRound size={17} />,
  info: <NotebookPen size={17} />,
  announcement: <ChevronDown size={17} />,
  links: <Link size={17} />,
  version: <Box size={17} />,
};
const links = [
  ["Minecraft 官网", "https://www.minecraft.net/"],
  ["中文 Wiki", "https://zh.minecraft.wiki/"],
  ["MC 百科", "https://www.mcmod.cn/"],
  ["Modrinth", "https://modrinth.com/"],
  ["CurseForge", "https://www.curseforge.com/minecraft"],
  ["NameMC", "https://namemc.com/"],
  ["LittleSkin", "https://littleskin.cn/"],
  ["红石中继站", "https://forum.mczwlt.net/"],
] as const;

function ContentImage({ path, alt }: { path: string; alt: string }) {
  const { data } = useApp();
  const resolved = /^(https?:|data:|\/assets\/|[A-Za-z]:[\\/])/.test(path)
    ? path
    : `${data.dataDir}/${path}`;
  const src = useImage(resolved);
  return src ? <img src={src} alt={alt} loading="lazy" /> : <span>{alt}</span>;
}
function ContentMarkdown({ children }: { children: string }) {
  const app = useApp();
  return (
    <div className="markdown">
      <ReactMarkdown
        skipHtml
        components={{
          a: ({ href, children }) => (
            <a
              href={href}
              onClick={(event) => {
                event.preventDefault();
                if (href)
                  void external(href).catch((error) =>
                    app.reportError(String(error)),
                  );
              }}
            >
              {children}
            </a>
          ),
          img: ({ src, alt }) => (
            <ContentImage
              path={typeof src === "string" ? src : ""}
              alt={alt || "内容图片"}
            />
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
function WidgetPanel({
  title,
  icon,
  children,
}: {
  title: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <article className="panel has-surface home-widget-panel">
      <PixelFrame />
      <header className="home-widget-heading">
        {icon}
        <h2>{title}</h2>
      </header>
      <div className="home-widget-body">{children}</div>
    </article>
  );
}
function CustomAnnouncement({
  widget,
}: {
  widget: Extract<HomeWidget, { type: "announcement" }>;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <article
      className="panel has-surface home-widget-panel home-announcement"
      data-open={open}
    >
      <PixelFrame />
      <h2>
        <button
          type="button"
          className="home-announcement-toggle"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((value) => !value)}
        >
          <FileText size={17} aria-hidden="true" />
          <span>{widget.title}</span>
          <ChevronDown size={18} aria-hidden="true" />
        </button>
      </h2>
      <div
        className="home-announcement-reveal"
        aria-hidden={!open}
        inert={!open}
      >
        <div>
          <div id={id} className="home-widget-body">
            <ContentMarkdown>{widget.content}</ContentMarkdown>
          </div>
        </div>
      </div>
    </article>
  );
}
function FixedWidget({
  type,
  preview = false,
}: {
  type: "player" | "links" | "version";
  preview?: boolean;
}) {
  const app = useApp();
  const summaryId = useId();
  const player = app.data.players.find(
    (item) => item.uuid === app.data.settings.activePlayer,
  );
  const version = app.versions.find(
    (item) => item.id === app.data.settings.activeVersion,
  );
  if (type === "links")
    return (
      <WidgetPanel title="常用入口" icon={icons.links}>
        <div className="home-quick-links">
          {links.map(([label, url]) =>
            preview ? (
              <span key={url}>{label}</span>
            ) : (
              <Button
                key={url}
                className="compact"
                onClick={() =>
                  void external(url).catch((error) =>
                    app.reportError(String(error)),
                  )
                }
              >
                {label}
              </Button>
            ),
          )}
        </div>
      </WidgetPanel>
    );
  const isPlayer = type === "player";
  const selected = isPlayer ? player : version;
  const name = isPlayer
    ? player?.name || "尚未选择角色"
    : version?.id || "尚未选择游戏版本";
  const detail = isPlayer
    ? player
      ? player.online
        ? "在线角色"
        : "离线角色"
      : "前往角色管理添加角色"
    : version
      ? `${version.loader} · Java ${version.javaMajor}`
      : "前往版本管理选择版本";
  return (
    <article className="panel has-surface home-widget-panel home-summary-card">
      <PixelFrame />
      <header className="home-widget-heading">
        <h2>{isPlayer ? "当前角色" : "当前游戏版本"}</h2>
        {!preview && (
          <button
            type="button"
            className="home-summary-action"
            aria-describedby={summaryId}
            data-tooltip={selected ? name : undefined}
            onClick={() => app.setPage(isPlayer ? "players" : "versions")}
          >
            <span>
              {isPlayer
                ? player
                  ? "切换角色"
                  : "选择角色"
                : version
                  ? "管理版本"
                  : "选择版本"}
            </span>
            <ArrowRight size={15} aria-hidden="true" />
          </button>
        )}
      </header>
      <div className="home-summary-body" id={summaryId}>
        <div
          className={`home-summary-icon ${isPlayer && player ? "home-summary-avatar" : ""}`}
          aria-hidden="true"
        >
          {isPlayer ? (
            player ? (
              <Skin player={player} face />
            ) : (
              <UsersRound size={28} />
            )
          ) : version ? (
            <ResourceImage path={versionIcon(version)} alt="" />
          ) : (
            <Box size={28} />
          )}
        </div>
        <div className="home-summary-info">
          <strong className="home-summary-name">{name}</strong>
          <p className="home-summary-detail">
            {isPlayer && player && (
              <span
                className="home-summary-status"
                data-online={player.online}
                aria-hidden="true"
              />
            )}
            <span>{detail}</span>
          </p>
        </div>
      </div>
    </article>
  );
}

export function HomeContent({
  notices,
}: {
  notices: ReturnType<typeof useNotices>;
}) {
  const app = useApp();
  const active = usePageActive();
  const saved = useHomeContent(active);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const migrated = useRef("");
  const previousOrder = useMemo(() => {
    try {
      const value: unknown = JSON.parse(
        localStorage.getItem("sfmcl-t.home.notice-order") || "[]",
      );
      return Array.isArray(value)
        ? value.filter((key): key is string => typeof key === "string")
        : [];
    } catch {
      return [];
    }
  }, []);
  const catalog = useMemo(
    () =>
      new Map(
        notices.catalogItems.map((item, index) => [
          noticeKey(item, index),
          item,
        ]),
      ),
    [notices.catalogItems],
  );
  const sourceVisible = useMemo(() => new Set(notices.items), [notices.items]);
  const config = useMemo(
    () =>
      notices.catalogReady
        ? reconcileHomeNotices(saved.config, [...catalog.keys()], previousOrder)
        : saved.config,
    [saved.config, notices.catalogReady, catalog, previousOrder],
  );
  const content = {
    ...saved,
    config,
    update: (change: Parameters<typeof saved.update>[0]) =>
      saved.update((before) =>
        change(
          notices.catalogReady
            ? reconcileHomeNotices(before, [...catalog.keys()], previousOrder)
            : before,
        ),
      ),
  };
  useEffect(() => {
    const key = JSON.stringify(config);
    if (
      !saved.ready ||
      saved.saving ||
      config === saved.config ||
      migrated.current === key
    )
      return;
    migrated.current = key;
    void saved.update(() => config);
  }, [config, saved.config, saved.ready, saved.saving, saved.update]);
  useEffect(() => {
    if (!active) {
      setEditing(false);
      setAdding(false);
    }
  }, [active]);
  const visible = useMemo(
    () =>
      config.widgets.filter(
        (item) =>
          item.visible &&
          item.type !== "notices" &&
          (item.type !== "notice" ||
            sourceVisible.has(catalog.get(item.noticeKey)!)),
      ),
    [config, sourceVisible, catalog],
  );
  const listItems = useMemo(
    () =>
      visible.length
        ? visible.map((widget) => ({
            key: widget.id,
            item: {
              widget,
              notice:
                widget.type === "notice"
                  ? catalog.get(widget.noticeKey)
                  : undefined,
            },
          }))
        : !notices.loading && !notices.error
          ? [{ key: "empty", item: null }]
          : [],
    [visible, catalog, notices.loading, notices.error],
  );
  const keys = visible.map((item) => item.id);
  const options = useMemo(
    () => ({
      ...noticeReorderOptions,
      allowedControl:
        ".notice-toggle, .home-announcement-toggle, .home-summary-action",
      holdOnly: !editing,
      overlayClass: editing
        ? "home-widget-drag-overlay"
        : "notice-drag-overlay",
      acceptTarget: (_target: Element, row: HTMLElement) =>
        editing || row.dataset.homeWidgetType === "notice",
    }),
    [editing],
  );
  const title = (widget: HomeWidget) =>
    widget.type === "notice"
      ? catalog.get(widget.noticeKey)?.title || "新闻资讯"
      : "title" in widget
        ? widget.title
        : homeWidgetNames[widget.type];
  const reorder = (nextKeys: string[]) => {
    let noticeOrder: string[] = [];
    void content
      .update((before) => {
        const next = reorderHomeWidgets(before, nextKeys, keys);
        noticeOrder = next.widgets.flatMap((item) =>
          item.type === "notice" ? [item.noticeKey] : [],
        );
        return next;
      })
      .then((done) => {
        if (done)
          try {
            localStorage.setItem(
              "sfmcl-t.home.notice-order",
              JSON.stringify(noticeOrder),
            );
          } catch {
            /* Disk layout remains authoritative. */
          }
      });
  };
  const renderWidget = (widget: HomeWidget, notice?: Notice) => {
    if (widget.type === "notice")
      return (
        <NoticePanel
          item={notice!}
          onDelete={notices.onDelete}
          deleting={notices.deleting}
        />
      );
    if (widget.type === "notices") return null;
    if (widget.type === "announcement")
      return <CustomAnnouncement widget={widget} />;
    if (widget.type === "info")
      return (
        <WidgetPanel title={widget.title} icon={icons.info}>
          <ContentMarkdown>{widget.content}</ContentMarkdown>
          {widget.note && <p className="home-info-note">{widget.note}</p>}
        </WidgetPanel>
      );
    return <FixedWidget type={widget.type} />;
  };
  const player = app.data.players.find(
    (item) => item.uuid === app.data.settings.activePlayer,
  );
  return (
    <>
      <PageHeader
        icon={<Play />}
        eyebrow="LET'S PLAY"
        title={player ? `你好，${player.name}` : "准备好，开启新的冒险"}
        action={
          <div className="notice-actions home-content-actions">
            <Button
              className="compact home-content-action"
              disabled={!content.ready}
              aria-label={editing ? "完成编辑" : "编辑布局"}
              aria-pressed={editing}
              onClick={() => setEditing((value) => !value)}
            >
              {editing ? (
                <Check size={16} aria-hidden="true" />
              ) : (
                <SlidersHorizontal size={16} aria-hidden="true" />
              )}
              <span className="home-content-action-label" aria-hidden="true">
                <span>{editing ? "完成编辑" : "编辑布局"}</span>
              </span>
            </Button>
            <Button
              className="compact notice-add home-content-action"
              disabled={!content.ready || content.saving}
              aria-label="添加组件"
              onClick={() => {
                setEditing(false);
                setAdding(true);
              }}
            >
              <Plus size={16} aria-hidden="true" />
              <span className="home-content-action-label" aria-hidden="true">
                <span>添加组件</span>
              </span>
            </Button>
            <NoticeRefreshButton
              loading={notices.loading}
              onRefresh={notices.refresh}
            />
          </div>
        }
      />
      {content.error && (
        <div className="inline-error" role="alert">
          {content.error}
          {!content.ready && (
            <Button className="compact" onClick={content.retry}>
              重试
            </Button>
          )}
        </div>
      )}
      <section
        className="notices"
        aria-label="启动器公告"
        aria-busy={notices.loading}
      >
        {notices.loading && !visible.length && (
          <p className="helper" role="status">
            正在加载公告…
          </p>
        )}
        {notices.error && (
          <p className="inline-error" role="alert">
            {notices.error}
          </p>
        )}
        <AnimatedNoticeList<{ widget: HomeWidget; notice?: Notice } | null>
          className="notice-home-list home-widget-list"
          layout={app.data.settings.homeNoticeLayout}
          reorderOptions={options}
          listProps={{ "data-home-editing": editing && active }}
          onReorder={content.ready && !content.saving ? reorder : undefined}
          items={listItems}
          rowProps={(entry) => {
            const widget = entry?.widget;
            return widget
              ? {
                  className: "home-widget-row",
                  "data-home-widget-id": widget.id,
                  "data-home-widget-type": widget.type,
                  style: {
                    "--home-wiggle-duration": `${380 + (keys.indexOf(widget.id) % 3) * 40}ms`,
                    "--home-wiggle-delay": `${-keys.indexOf(widget.id) * 73}ms`,
                  } as CSSProperties,
                  tabIndex: editing ? 0 : undefined,
                  "aria-label": editing
                    ? `调整位置：${title(widget)}`
                    : undefined,
                  onKeyDown: (event) => {
                    if (
                      !editing ||
                      !event.altKey ||
                      !["ArrowUp", "ArrowDown"].includes(event.key) ||
                      event.target !== event.currentTarget
                    )
                      return;
                    event.preventDefault();
                    const from = keys.indexOf(widget.id),
                      to = from + (event.key === "ArrowUp" ? -1 : 1);
                    if (to >= 0 && to < keys.length) {
                      const next = [...keys];
                      [next[from], next[to]] = [next[to], next[from]];
                      reorder(next);
                    }
                  },
                }
              : {};
          }}
        >
          {(entry) => {
            const widget = entry?.widget;
            return widget ? (
              <div className="home-widget-motion">
                {renderWidget(widget, entry?.notice)}
                {editing && (
                  <button
                    type="button"
                    className="home-widget-hide"
                    aria-label={`隐藏：${title(widget)}`}
                    data-tooltip="隐藏"
                    disabled={content.saving}
                    onClick={() =>
                      void content.update((before) => ({
                        ...before,
                        widgets: before.widgets.map((item) =>
                          item.id === widget.id
                            ? { ...item, visible: false }
                            : item,
                        ),
                      }))
                    }
                  >
                    <EyeOff size={15} aria-hidden="true" />
                  </button>
                )}
              </div>
            ) : (
              <p className="helper" role="status">
                暂无公告
              </p>
            );
          }}
        </AnimatedNoticeList>
      </section>
      {adding && (
        <ComponentLibrary
          content={content}
          notices={notices}
          onClose={() => setAdding(false)}
        />
      )}
    </>
  );
}
function ComponentLibrary({
  content,
  notices,
  onClose,
}: {
  content: ReturnType<typeof useHomeContent>;
  notices: ReturnType<typeof useNotices>;
  onClose: () => void;
}) {
  const id = useId();
  const [tab, setTab] = useState("components");
  const tabContent = useTabContentTransition(
    ["components", "announcement", "info"].indexOf(tab),
  );
  const [drafts, setDrafts] = useState({
    announcement: { title: "", content: "", note: "" },
    info: { title: "", content: "", note: "" },
  });
  const [error, setError] = useState("");
  const pending = useRef(false);
  const customType = tab === "announcement" ? "announcement" : "info";
  const draft = drafts[customType];
  const setDraft = (change: Partial<typeof draft>) =>
    setDrafts((before) => ({
      ...before,
      [customType]: { ...before[customType], ...change },
    }));
  const catalog = new Map(
    notices.catalogItems.map((item, index) => [noticeKey(item, index), item]),
  );
  const newsVisible = (key: string) =>
    content.config.widgets.some(
      (widget) =>
        widget.type === "notice" && widget.noticeKey === key && widget.visible,
    ) && notices.items.includes(catalog.get(key)!);
  const restoreNews = async (item: Notice, key: string) => {
    if (!notices.items.includes(item) && !(await notices.onShow(item)))
      return false;
    const existing = content.config.widgets.find(
      (widget) => widget.type === "notice" && widget.noticeKey === key,
    );
    if (!existing?.visible)
      return content.update((before) =>
        withHomeWidget(before, {
          id: key,
          type: "notice",
          noticeKey: key,
          visible: true,
        }),
      );
    return true;
  };
  const saveWidget = async (widget: HomeWidget) => {
    if (pending.current) return;
    pending.current = true;
    setError("");
    try {
      if (await content.update((before) => withHomeWidget(before, widget)))
        onClose();
    } finally {
      pending.current = false;
    }
  };
  const addCustom = () => {
    if (pending.current) return;
    if (!draft.title.trim() || !draft.content.trim()) {
      setError("请填写标题和内容。");
      return;
    }
    void saveWidget(
      createHomeWidget(
        customType,
        draft.title.trim(),
        draft.content.trim(),
        draft.note.trim(),
      ),
    );
  };
  const hiddenCustom = content.config.widgets.filter(
    (item) => item.type === customType && !item.visible,
  );
  let officialNewsNumber = 0;
  const presets = [
    ...[...catalog].map(([key, item]) => {
      const added = newsVisible(key);
      let title = item.title || "未命名公告";
      if (item.preset) {
        if (item.id?.startsWith("news:") || item.category === "官方新闻")
          title = `官方新闻 ${++officialNewsNumber}`;
        else if (
          item.id?.startsWith("java:") ||
          item.category?.startsWith("Java ")
        )
          title = "Java 版更新";
        else if (
          item.id?.startsWith("wiki:") ||
          item.category === "中文 Minecraft Wiki"
        )
          title = "中文 Minecraft Wiki";
      }
      return {
        key,
        type: "notice" as const,
        noticeKey: key,
        title,
        label: `${added ? "已添加资讯" : "恢复资讯"}：${title}`,
        status: added ? "已添加" : "恢复到首页",
        disabled: content.saving || notices.hiding || added,
        add: () => void restoreNews(item, key),
      };
    }),
    ...(["player", "links", "version"] as const).map((type) => {
      const present = content.config.widgets.find((item) => item.type === type);
      return {
        key: type,
        type,
        noticeKey: undefined,
        title: homeWidgetNames[type],
        label: `${present?.visible ? "已添加" : present ? "恢复" : "添加"}：${homeWidgetNames[type]}`,
        status: present?.visible
          ? "已添加"
          : present
            ? "恢复到首页"
            : "添加到首页",
        disabled: content.saving || !!present?.visible,
        add: () => void saveWidget(createHomeWidget(type)),
      };
    }),
  ];
  return (
    <Modal
      title="添加组件"
      className="home-component-library"
      onClose={onClose}
      closeDisabled={content.saving}
      showError={false}
    >
      <TabList
        id={id}
        label="首页组件管理"
        value={tab}
        onValueChange={(value) => {
          setTab(value);
          setError("");
        }}
        items={[
          { value: "components", label: "预设组件" },
          { value: "announcement", label: "折叠公告" },
          { value: "info", label: "卡片信息" },
        ]}
      />
      <TabPanel ref={tabContent} id={id} value={tab}>
        {tab === "components" ? (
          <div className="home-library-layout">
            <div className="home-template-grid">
              {presets.map((preset) => (
                <button
                  type="button"
                  key={preset.key}
                  className="home-template has-surface"
                  aria-label={preset.label}
                  data-home-template={preset.type}
                  data-home-notice-key={preset.noticeKey}
                  onClick={() => {
                    setError("");
                    preset.add();
                  }}
                  disabled={preset.disabled}
                >
                  <PixelFrame />
                  <div className="home-template-label">
                    {icons[preset.type]}
                    <strong>{preset.title}</strong>
                  </div>
                  <small>{preset.status}</small>
                </button>
              ))}
            </div>
            {notices.error && (
              <p className="inline-error" role="alert">
                {notices.error}
              </p>
            )}
          </div>
        ) : (
          <div className="home-custom-tab">
            <form
              className="home-custom-form"
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                addCustom();
              }}
            >
              <div className="home-custom-title-row">
                <label className="field">
                  <span>组件标题</span>
                  <Input
                    value={draft.title}
                    maxLength={120}
                    disabled={content.saving}
                    onChange={(event) => setDraft({ title: event.target.value })}
                  />
                </label>
                {customType === "info" && (
                  <label className="field">
                    <span>底部备注</span>
                    <Input
                      value={draft.note}
                      maxLength={120}
                      disabled={content.saving}
                      onChange={(event) => setDraft({ note: event.target.value })}
                    />
                  </label>
                )}
              </div>
              <label className="field">
                <span>内容</span>
                <Textarea
                  value={draft.content}
                  maxLength={100_000}
                  disabled={content.saving}
                  onChange={(event) =>
                    setDraft({ content: event.target.value })
                  }
                />
              </label>
              <div className="dialog-actions">
                <Button type="submit" primary disabled={content.saving}>
                  <Plus size={16} />
                  添加到首页
                </Button>
              </div>
            </form>
            {!!hiddenCustom.length && (
              <section
                className="home-library-restores"
                aria-label={
                  customType === "announcement"
                    ? "恢复折叠公告"
                    : "恢复卡片信息"
                }
              >
                <h3>
                  {customType === "announcement"
                    ? "恢复折叠公告"
                    : "恢复卡片信息"}
                </h3>
                {hiddenCustom.map((widget) => (
                  <div
                    className="home-hidden-row"
                    key={widget.id}
                    data-home-hidden-id={widget.id}
                  >
                    {icons[widget.type]}
                    <span>{"title" in widget ? widget.title : ""}</span>
                    <Button
                      className="compact"
                      disabled={content.saving}
                      aria-label={`恢复：${"title" in widget ? widget.title : ""}`}
                      onClick={() =>
                        void content.update((before) => ({
                          ...before,
                          widgets: before.widgets.map((item) =>
                            item.id === widget.id
                              ? { ...item, visible: true }
                              : item,
                          ),
                        }))
                      }
                    >
                      <Plus size={15} />
                      恢复
                    </Button>
                  </div>
                ))}
              </section>
            )}
          </div>
        )}
        {(error || content.error) && (
          <p className="inline-error" role="alert">
            {error || content.error}
          </p>
        )}
      </TabPanel>
    </Modal>
  );
}

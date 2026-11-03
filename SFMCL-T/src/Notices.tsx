import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import ReactMarkdown from "react-markdown";
import {
  ChevronDown,
  CircleAlert,
  EyeOff,
  LayoutTemplate,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { api, desktop, external } from "./api";
import { useApp } from "./store";
import {
  Button,
  Empty,
  Modal,
  TabList,
  TabPanel,
  useImage,
  PixelFrame,
} from "./components";
import { Input, Textarea } from "./controls";
import { useTabContentTransition } from "./useTabContentTransition";
import { AnimatedNoticeList } from "./AnimatedNoticeList";
import type { HomeNoticeLayout } from "./types";
import "./notices.css";
interface Notice {
  title: string;
  content: string;
  icon: string;
  source?: string;
  error?: string;
  id?: string;
  category?: string;
  date?: string;
  preset?: boolean;
}
interface NoticeRefresh {
  items: Notice[];
  error: string;
}
function noticeKey(item: Notice, index: number) {
  return `notice:${item.id || JSON.stringify([item.source, item.title, index])}`;
}
function neighboringControl(button: HTMLButtonElement, selector: string) {
  const row = button.closest(".notice-list-item");
  const next = (direction: "nextElementSibling" | "previousElementSibling") => {
    let sibling = row?.[direction];
    while (sibling) {
      if (sibling.getAttribute("data-notice-phase") !== "exiting") {
        const control = sibling.querySelector<HTMLButtonElement>(selector);
        if (control) return control;
      }
      sibling = sibling[direction];
    }
    return null;
  };
  return next("nextElementSibling") || next("previousElementSibling");
}
// News is optional network work. Start it after the startup screen has opened.
function afterStartup(callback: () => void) {
  if (!document.documentElement.hasAttribute("data-startup")) {
    callback();
    return () => {};
  }
  const observer = new MutationObserver(() => {
    if (!document.documentElement.hasAttribute("data-startup")) {
      observer.disconnect();
      callback();
    }
  });
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-startup"],
  });
  return () => observer.disconnect();
}
function NoticeImage({ path, alt }: { path: string; alt: string }) {
  const { data } = useApp();
  const resolved = /^(https?:|data:|\/assets\/|[A-Za-z]:[\\/])/.test(path)
    ? path
    : `${data.dataDir}/${path}`;
  const src = useImage(resolved);
  return src ? <img src={src} alt={alt} loading="lazy" /> : <span>{alt}</span>;
}
function NoticePanel({
  item,
  onHide,
  hiding,
  onDelete,
  deleting,
}: {
  item: Notice;
  onHide: (item: Notice) => Promise<boolean>;
  hiding: boolean;
  onDelete: (item: Notice) => Promise<boolean>;
  deleting: boolean;
}) {
  const app = useApp();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [visited, setVisited] = useState(false);
  const [removePreview, setRemovePreview] = useState(false);
  const [removeHovered, setRemoveHovered] = useState(false);
  const [removeFocused, setRemoveFocused] = useState(false);
  const removeMotion = useRef<HTMLDivElement>(null);
  const previewTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const stopPreview = () => {
    clearTimeout(previewTimer.current);
    previewTimer.current = undefined;
    setRemovePreview(false);
  };

  useLayoutEffect(() => {
    if (!removePreview) return;
    let cancelled = false;
    const motion = removeMotion.current;
    motion?.getBoundingClientRect();
    // Hold the preview for half a second after its entrance has finished.
    void Promise.allSettled(
      motion?.getAnimations().map((animation) => animation.finished) ?? [],
    ).then(() => {
      if (cancelled) return;
      previewTimer.current = setTimeout(() => {
        previewTimer.current = undefined;
        setRemovePreview(false);
      }, 500);
    });
    return () => {
      cancelled = true;
      clearTimeout(previewTimer.current);
      previewTimer.current = undefined;
    };
  }, [removePreview]);

  return (
    <article
      className="panel notice-card has-surface"
      data-open={open}
      onPointerEnter={(event) => {
        if (event.pointerType === "touch") return;
        clearTimeout(previewTimer.current);
        setRemovePreview(true);
      }}
      onPointerLeave={() => {
        stopPreview();
        setRemoveHovered(false);
      }}
    >
      <PixelFrame />
      <header
        className="notice-heading"
        data-remove-visible={removePreview || removeHovered || removeFocused}
      >
        <h3>
          <button
            type="button"
            className="notice-toggle"
            id={`${id}-title`}
            aria-expanded={open}
            aria-controls={`${id}-content`}
            onClick={() => {
              setVisited(true);
              setOpen((value) => !value);
            }}
          >
            {item.icon && (
              <span className="notice-icon" aria-hidden="true">
                <NoticeImage path={item.icon} alt="" />
              </span>
            )}
            <span className="notice-title">
              <span>{item.title || "未命名公告"}</span>
              {(item.category || item.date) && (
                <span className="notice-meta">
                  {item.category && <span>{item.category}</span>}
                  {item.date && (
                    <time dateTime={item.date}>{item.date.slice(0, 10)}</time>
                  )}
                </span>
              )}
            </span>
            {item.error && (
              <CircleAlert
                className="notice-warning"
                size={17}
                aria-label="公告内容读取失败"
              />
            )}
            <ChevronDown
              className="notice-chevron"
              size={18}
              aria-hidden="true"
            />
          </button>
        </h3>
        <div
          className="notice-control"
          onPointerEnter={(event) => {
            if (event.pointerType !== "touch") setRemoveHovered(true);
          }}
          onPointerLeave={() => {
            stopPreview();
            setRemoveHovered(false);
          }}
        >
          <div ref={removeMotion} className="notice-remove-motion">
            <button
              type="button"
              className={`icon-button notice-remove ${item.preset ? "notice-hide" : "notice-delete"} has-surface`}
              aria-label={`${item.preset ? "隐藏" : "删除"}公告：${item.title || "未命名公告"}`}
              data-tooltip={item.preset ? "隐藏公告" : "删除公告"}
              disabled={(item.preset ? hiding : deleting) || !item.id}
              onFocus={(event) =>
                setRemoveFocused(event.currentTarget.matches(":focus-visible"))
              }
              onBlur={() => setRemoveFocused(false)}
              onClick={(event) => {
                const next = neighboringControl(
                  event.currentTarget,
                  ".notice-toggle",
                );
                void (item.preset ? onHide(item) : onDelete(item)).then(
                  (removed) => {
                    if (removed)
                      (
                        next ||
                        document.querySelector<HTMLButtonElement>(".notice-add")
                      )?.focus();
                  },
                );
              }}
            >
              <PixelFrame />
              {item.preset ? (
                <EyeOff size={16} aria-hidden="true" />
              ) : (
                <Trash2 size={16} aria-hidden="true" />
              )}
            </button>
          </div>
        </div>
      </header>
      <div
        className="notice-body"
        id={`${id}-content`}
        role="region"
        aria-labelledby={`${id}-title`}
        aria-hidden={!open}
        inert={!open}
      >
        <div className="notice-body-clip">
          <div className="notice-content">
            <div className="markdown">
              {(!item.id || item.id.startsWith("local:") || visited) && (
                <ReactMarkdown
                  skipHtml
                  components={{
                    a: ({ href, children }) => (
                      <a
                        href={href}
                        onClick={(e) => {
                          e.preventDefault();
                          if (href) void app.run(() => external(href));
                        }}
                      >
                        {children}
                      </a>
                    ),
                    img: ({ src, alt }) => (
                      <NoticeImage
                        path={typeof src === "string" ? src : ""}
                        alt={alt || "公告图片"}
                      />
                    ),
                  }}
                >
                  {item.content}
                </ReactMarkdown>
              )}
            </div>
            {item.error && <p className="inline-error">{item.error}</p>}
          </div>
        </div>
      </div>
    </article>
  );
}
export function useNotices(enabled: boolean) {
  const app = useApp();
  const [items, setItems] = useState<Notice[]>([]);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(desktop && enabled);
  const [hiddenIds, setHiddenIds] = useState<string[]>([]);
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [preferenceError, setPreferenceError] = useState("");
  const [actionError, setActionError] = useState("");
  const [changingVisibility, setChangingVisibility] = useState(false);
  const visibilityPending = useRef(false);
  const [deleting, setDeleting] = useState(false);
  const deletionPending = useRef(false);
  const catalogVersion = useRef(0);
  const preferenceVersion = useRef(0);
  const forceRefresh = useRef(false);

  useEffect(() => {
    if (!desktop || !enabled) return;
    let active = true;
    let stopWaiting = () => {};
    let timer: ReturnType<typeof setInterval> | undefined;
    let refreshing = false;
    const force = forceRefresh.current;
    forceRefresh.current = false;
    const update = async (force: boolean) => {
      if (!active || refreshing) return;
      refreshing = true;
      setLoading(true);
      const version = catalogVersion.current;
      try {
        const value = await api<NoticeRefresh>("notices.refresh", { force });
        if (active) {
          if (version === catalogVersion.current) setItems(value.items);
          setError(value.error);
        }
      } catch (error) {
        if (active) setError(String(error));
      } finally {
        refreshing = false;
        if (active) setLoading(false);
      }
    };
    setLoading(true);
    setError("");
    const version = catalogVersion.current;
    const preferences = preferenceVersion.current;
    const readItems = api<Notice[]>("notices.list")
      .then((value) => {
        if (active && version === catalogVersion.current) setItems(value);
      })
      .catch((e) => {
        if (active) setError(String(e));
      });
    const readHidden = api<string[]>("notices.hidden")
      .then((value) => {
        if (active && preferences === preferenceVersion.current) {
          setHiddenIds(value);
          setPreferencesReady(true);
          setPreferenceError("");
        }
      })
      .catch((e) => {
        if (active) setPreferenceError(String(e));
      });
    void Promise.all([readItems, readHidden]).finally(() => {
      if (active) {
        setLoading(false);
        stopWaiting = afterStartup(() => {
          void update(force);
          timer = setInterval(() => void update(false), 60 * 60 * 1000);
        });
      }
    });
    return () => {
      active = false;
      stopWaiting();
      clearInterval(timer);
    };
  }, [enabled, revision]);

  const setVisible = async (item: Notice, hidden: boolean) => {
    if (
      !item.id ||
      !item.preset ||
      visibilityPending.current ||
      !preferencesReady
    )
      return false;
    visibilityPending.current = true;
    setChangingVisibility(true);
    setActionError("");
    preferenceVersion.current += 1;
    try {
      const value = await api<string[]>("notices.visibility", {
        id: item.id,
        hidden,
      });
      setHiddenIds(value);
      return true;
    } catch (e) {
      setActionError(String(e));
      return false;
    } finally {
      visibilityPending.current = false;
      setChangingVisibility(false);
    }
  };
  return {
    items: items.filter(
      (item) => !item.preset || !item.id || !hiddenIds.includes(item.id),
    ),
    presetItems: items.filter(
      (item) => item.preset && item.id && hiddenIds.includes(item.id),
    ),
    error: [error, preferenceError, actionError].filter(Boolean).join(" "),
    loading,
    hiding: changingVisibility || !preferencesReady,
    deleting,
    onHide: (item: Notice) => setVisible(item, true),
    onShow: (item: Notice) => setVisible(item, false),
    onDelete: async (item: Notice) => {
      if (!item.id || item.preset || deletionPending.current) return false;
      deletionPending.current = true;
      setDeleting(true);
      setActionError("");
      try {
        const value = await api<Notice[]>("notices.delete", { id: item.id });
        catalogVersion.current += 1;
        setItems(value);
        return true;
      } catch (e) {
        setActionError(String(e));
        return false;
      } finally {
        deletionPending.current = false;
        setDeleting(false);
      }
    },
    create: async (title: string, content: string) => {
      const value = await api<Notice[]>("notices.create", { title, content });
      catalogVersion.current += 1;
      setItems(value);
      setActionError("");
    },
    refresh: () => {
      void app.run(app.refresh);
      forceRefresh.current = true;
      setRevision((v) => v + 1);
    },
  };
}

export function NoticeRefreshButton({
  loading,
  onRefresh,
}: {
  loading: boolean;
  onRefresh: () => void;
}) {
  const refreshGlyph = useRef<HTMLSpanElement>(null);
  const refreshFeedback = useRef<Animation | null>(null);

  useEffect(() => () => refreshFeedback.current?.cancel(), []);

  return (
    <button
      type="button"
      className="icon-button notice-refresh has-surface"
      disabled={loading}
      aria-label="刷新公告"
      data-tooltip="刷新公告"
      onClick={() => {
        refreshFeedback.current?.cancel();
        refreshFeedback.current =
          refreshGlyph.current?.animate(
            [{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }],
            { duration: 380, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
          ) ?? null;
        onRefresh();
      }}
    >
      <PixelFrame />
      <span
        ref={refreshGlyph}
        className="notice-refresh-glyph"
        aria-hidden="true"
      >
        <RefreshCw size={17} className={loading ? "spin" : ""} />
      </span>
    </button>
  );
}

export function Notices({
  items,
  error,
  loading,
  onHide,
  hiding,
  onDelete,
  deleting,
  layout = "masonry",
}: {
  items: Notice[];
  error: string;
  loading: boolean;
  onHide: (item: Notice) => Promise<boolean>;
  hiding: boolean;
  onDelete: (item: Notice) => Promise<boolean>;
  deleting: boolean;
  layout?: HomeNoticeLayout;
}) {
  const [order, setOrder] = useState<string[]>(() => {
    try {
      const value: unknown = JSON.parse(
        localStorage.getItem("sfmcl-t.home.notice-order") || "[]",
      );
      return Array.isArray(value)
        ? [
            ...new Set(
              value.filter((key): key is string => typeof key === "string"),
            ),
          ]
        : [];
    } catch {
      return [];
    }
  });
  const entries = useMemo(() => {
    const ranks = new Map(order.map((key, index) => [key, index]));
    return items
      .map((item, index) => ({ key: noticeKey(item, index), item }))
      .sort(
        (a, b) =>
          (ranks.get(a.key) ?? order.length) -
          (ranks.get(b.key) ?? order.length),
      );
  }, [items, order]);
  return (
    <section className="notices" aria-label="启动器公告" aria-busy={loading}>
      {loading && items.length === 0 && (
        <p className="helper" role="status">
          正在加载公告…
        </p>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <AnimatedNoticeList<Notice | null>
        className="notice-home-list"
        layout={layout}
        onReorder={(keys) => {
          // Retain hidden notices' ranks so adding a preset back restores its place.
          const visible = new Set(keys);
          let index = 0;
          const saved = order.map((key) =>
            visible.has(key) ? keys[index++] : key,
          );
          const next = [...saved, ...keys.slice(index)];
          setOrder(next);
          try {
            localStorage.setItem(
              "sfmcl-t.home.notice-order",
              JSON.stringify(next),
            );
          } catch {
            // Sorting remains available if webview storage is unavailable.
          }
        }}
        items={
          items.length
            ? entries
            : !loading && !error
              ? [{ key: "empty", item: null }]
              : []
        }
      >
        {(item) =>
          item ? (
            <NoticePanel
              item={item}
              onHide={onHide}
              hiding={hiding}
              onDelete={onDelete}
              deleting={deleting}
            />
          ) : (
            <p className="helper" role="status">
              暂无公告
            </p>
          )
        }
      </AnimatedNoticeList>
    </section>
  );
}

export function NoticeActions({
  notices,
}: {
  notices: ReturnType<typeof useNotices>;
}) {
  const [adding, setAdding] = useState(false);
  return (
    <div className="notice-actions">
      <button
        type="button"
        className="icon-button notice-add has-surface"
        aria-label="新增公告"
        data-tooltip="新增公告 / 添加预设"
        onClick={() => setAdding(true)}
      >
        <PixelFrame />
        <Plus size={18} aria-hidden="true" />
      </button>
      <NoticeRefreshButton
        loading={notices.loading}
        onRefresh={notices.refresh}
      />
      {adding && (
        <NoticeEditor notices={notices} onClose={() => setAdding(false)} />
      )}
    </div>
  );
}

function NoticeEditor({
  notices,
  onClose,
}: {
  notices: ReturnType<typeof useNotices>;
  onClose: () => void;
}) {
  const id = useId();
  const [tab, setTab] = useState("presets");
  const tabContent = useTabContentTransition(tab === "presets" ? 0 : 1);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  return (
    <Modal
      title="新增公告"
      onClose={onClose}
      closeDisabled={saving}
      showError={false}
      className="notice-editor"
    >
      {(requestClose) => (
        <>
          <TabList
            id={id}
            label="公告管理"
            value={tab}
            onValueChange={setTab}
            items={[
              {
                value: "presets",
                label: "预设",
                icon: <LayoutTemplate size={16} />,
                count: notices.presetItems.length,
              },
              { value: "new", label: "新增公告", icon: <Plus size={16} /> },
            ]}
          />
          <TabPanel ref={tabContent} id={id} value={tab}>
            {tab === "new" ? (
              <form
                className="notice-form"
                noValidate
                onSubmit={(event) => {
                  event.preventDefault();
                  if (pending.current) return;
                  if (!title.trim() || !content.trim()) {
                    setError("请填写公告标题和内容。");
                    return;
                  }
                  pending.current = true;
                  setSaving(true);
                  setError("");
                  void notices
                    .create(title, content)
                    .then(() => {
                      pending.current = false;
                      setSaving(false);
                      onClose();
                    })
                    .catch((e) => setError(String(e)))
                    .finally(() => {
                      pending.current = false;
                      setSaving(false);
                    });
                }}
              >
                <label className="field">
                  <span>公告标题</span>
                  <Input
                    data-modal-autofocus
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    maxLength={120}
                    disabled={saving}
                    placeholder="例如：整合包更新说明"
                    required
                  />
                </label>
                <label className="field">
                  <span>公告内容</span>
                  <Textarea
                    value={content}
                    onChange={(event) => setContent(event.target.value)}
                    maxLength={100000}
                    rows={6}
                    disabled={saving}
                    placeholder="支持 Markdown、图片和链接"
                    required
                  />
                </label>
                {error && (
                  <p className="inline-error" role="alert">
                    {error}
                  </p>
                )}
                <div className="dialog-actions">
                  <Button onClick={requestClose} disabled={saving}>
                    取消
                  </Button>
                  <Button type="submit" primary disabled={saving}>
                    {saving ? "正在保存…" : "添加公告"}
                  </Button>
                </div>
              </form>
            ) : (
              <div className="notice-preset-list">
                <AnimatedNoticeList<Notice | null>
                  className="notice-preset-motion"
                  items={
                    notices.presetItems.length
                      ? notices.presetItems.map((item, index) => ({
                          key: noticeKey(item, index),
                          item,
                        }))
                      : [{ key: "empty", item: null }]
                  }
                >
                  {(item) =>
                    item ? (
                      <div className="notice-preset-row">
                        <div className="notice-title">
                          <strong>{item.title || "未命名公告"}</strong>
                          {item.category && (
                            <span className="notice-meta">{item.category}</span>
                          )}
                        </div>
                        <Button
                          disabled={notices.hiding}
                          aria-label={`添加预设公告：${item.title || "未命名公告"}`}
                          onClick={(event) => {
                            const next =
                              neighboringControl(
                                event.currentTarget,
                                ".notice-preset-row .button",
                              ) ||
                              event.currentTarget
                                .closest(".notice-editor")
                                ?.querySelector<HTMLButtonElement>(
                                  '[role="tab"][aria-selected="true"]',
                                );
                            void notices.onShow(item).then((added) => {
                              if (added) next?.focus();
                            });
                          }}
                        >
                          <Plus size={16} />
                          添加
                        </Button>
                      </div>
                    ) : (
                      <div className="notice-preset-empty" role="status">
                        <Empty
                          title="当前预设均已显示"
                          icon={<LayoutTemplate size={30} aria-hidden="true" />}
                        />
                      </div>
                    )
                  }
                </AnimatedNoticeList>
                {notices.error && (
                  <p className="inline-error" role="alert">
                    {notices.error}
                  </p>
                )}
              </div>
            )}
          </TabPanel>
        </>
      )}
    </Modal>
  );
}

import { useEffect, useId, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { ChevronDown, CircleAlert, RefreshCw } from "lucide-react";
import { api, desktop, external } from "./api";
import { useApp } from "./store";
import { useImage, PixelFrame } from "./components";
import "./notices.css";
interface Notice {
  title: string;
  content: string;
  icon: string;
  source?: string;
  error?: string;
}
function NoticeImage({ path, alt }: { path: string; alt: string }) {
  const { data } = useApp();
  const resolved = /^(https?:|data:|\/assets\/|[A-Za-z]:[\\/])/.test(path)
    ? path
    : `${data.dataDir}/${path}`;
  const src = useImage(resolved);
  return src ? <img src={src} alt={alt} loading="lazy" /> : <span>{alt}</span>;
}
function NoticePanel({ item }: { item: Notice }) {
  const app = useApp();
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <article className="panel notice-card has-surface" data-open={open}>
      <PixelFrame />
      <h3 className="notice-heading">
        <button
          type="button"
          className="notice-toggle"
          id={`${id}-title`}
          aria-expanded={open}
          aria-controls={`${id}-content`}
          onClick={() => setOpen((value) => !value)}
        >
          {item.icon && (
            <span className="notice-icon" aria-hidden="true">
              <NoticeImage path={item.icon} alt="" />
            </span>
          )}
          <span className="notice-title">{item.title || "未命名公告"}</span>
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

  useEffect(() => {
    if (!desktop || !enabled) return;
    let active = true;
    setLoading(true);
    setError("");
    void api<Notice[]>("notices.list")
      .then((value) => {
        if (active) setItems(value);
      })
      .catch((e) => {
        if (active) setError(String(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [enabled, revision]);

  return {
    items,
    error,
    loading,
    refresh: () => {
      void app.run(app.refresh);
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
}: {
  items: Notice[];
  error: string;
  loading: boolean;
}) {
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
      {items.map((item, i) => (
        <NoticePanel
          key={JSON.stringify([item.source, item.title, i])}
          item={item}
        />
      ))}
      {!loading && !error && items.length === 0 && (
        <p className="helper" role="status">
          暂无公告
        </p>
      )}
    </section>
  );
}

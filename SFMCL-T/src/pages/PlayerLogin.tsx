import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronRight,
  Clock3,
  Copy,
  ExternalLink,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { api } from "../api";
import { Badge, Button, PixelFrame, Steps } from "../components";
import { Input } from "../controls";
import { useApp } from "../store";
import { PlayerCamp } from "../PlayerCamp";
import type { PlayerLoginState } from "../usePlayerLogin";
import "../player-login.css";

const appIcon = new URL("../../src-tauri/icons/icon.ico", import.meta.url).href;

export function MicrosoftIcon() {
  return (
    <svg
      viewBox="0 0 23 23"
      fill="none"
      aria-hidden="true"
      className="players-microsoft-icon"
    >
      <rect width="10" height="10" x="1" y="1" fill="#f25022" />
      <rect width="10" height="10" x="12" y="1" fill="#7fba00" />
      <rect width="10" height="10" x="1" y="12" fill="#00a4ef" />
      <rect width="10" height="10" x="12" y="12" fill="#ffb900" />
    </svg>
  );
}

const providers = [
  {
    name: "Microsoft",
    id: "microsoft",
    caption: "MICROSOFT",
    detail: "授权你的账号",
  },
  {
    name: "Xbox Live",
    id: "xbox",
    caption: "XBOX LIVE",
    detail: "连接游戏身份",
  },
  {
    name: "Minecraft",
    id: "minecraft",
    caption: "MINECRAFT",
    detail: "获取游戏资料",
  },
  { name: "SFMCL-T", id: "sfmcl-t", caption: "SFMCL-T LAUNCHER", detail: "保存角色" },
];

export function PlayerAuthStage({ auth }: { auth: PlayerLoginState }) {
  const provider = providers[auth.step];
  return (
    <div
      className="players-auth-stage"
      data-provider={provider.id}
      data-failed={auth.failed || undefined}
      data-completed={auth.completed || undefined}
    >
      <div className="players-auth-grid" aria-hidden="true" />
      <div className="players-auth-orbit" aria-hidden="true" />
      <div
        key={provider.id}
        className="players-auth-logo has-surface"
        role="img"
        aria-label={`${provider.name} 登录步骤`}
      >
        <PixelFrame />
        {auth.completed ? (
          <Check />
        ) : auth.step === 0 ? (
          <MicrosoftIcon />
        ) : auth.step === 1 ? (
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            {/* Xbox mark, Simple Icons 11.0.0. */}
            <path d="M4.102 21.033C6.211 22.881 8.977 24 12 24c3.026 0 5.789-1.119 7.902-2.967 1.877-1.912-4.316-8.709-7.902-11.417-3.582 2.708-9.779 9.505-7.898 11.417zm11.16-14.406c2.5 2.961 7.484 10.313 6.076 12.912C23.002 17.48 24 14.861 24 12.004c0-3.34-1.365-6.362-3.57-8.536 0 0-.027-.022-.082-.042-.063-.022-.152-.045-.281-.045-.592 0-1.985.434-4.805 3.246zM3.654 3.426c-.057.02-.082.041-.086.042C1.365 5.642 0 8.664 0 12.004c0 2.854.998 5.473 2.661 7.533-1.401-2.605 3.579-9.951 6.08-12.91-2.82-2.813-4.216-3.245-4.806-3.245-.131 0-.223.021-.281.046v-.002zM12 3.551S9.055 1.828 6.755 1.746c-.903-.033-1.454.295-1.521.339C7.379.646 9.659 0 11.984 0H12c2.334 0 4.605.646 6.766 2.085-.068-.046-.615-.372-1.52-.339C14.946 1.828 12 3.545 12 3.545v.006z" />
          </svg>
        ) : (
          <img
            src={
              auth.step === 2
                ? "/assets/DefaultGameIcon/Minecraft.png"
                : appIcon
            }
            alt=""
          />
        )}
      </div>
      <span className="players-auth-wordmark" aria-hidden="true">
        {auth.completed ? "READY TO PLAY" : provider.caption}
      </span>
      <div className="players-auth-pips" aria-hidden="true">
        {providers.map((item, i) => (
          <i key={item.id} className={i <= auth.step ? "active" : ""} />
        ))}
      </div>
    </div>
  );
}

export function PlayerAuthIdentity({ auth }: { auth: PlayerLoginState }) {
  const provider = providers[auth.step];
  return (
    <div className="players-identity-top">
      <div className="players-identity-name">
        <h2>{provider.name}</h2>
        <span className="players-kind">
          <ShieldCheck size={12} />
          {auth.completed
            ? "登录完成"
            : auth.failed
              ? "需要处理"
              : provider.detail}
        </span>
      </div>
      <span className="players-equipped">
        {auth.completed ? <Check size={13} /> : null}
        {String(auth.step + 1).padStart(2, "0")} / 04
      </span>
    </div>
  );
}

export function PlayerOfflineLogin({
  name,
  onNameChange,
}: {
  name: string;
  onNameChange: (value: string) => void;
}) {
  const app = useApp();
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const active = useRef(false);
  const submitting = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  return (
    <div className="players-login-content">
      <div className="players-login-intro">
        <h3>给这段旅程起个名字。</h3>
        <p>创建一个离线角色，即可开始你的单人冒险。</p>
      </div>
      <form
        className="players-offline-form"
        noValidate
        onSubmit={async (e) => {
          e.preventDefault();
          if (submitting.current) return;
          if (!/^[A-Za-z0-9_]{1,16}$/.test(name)) {
            setError(
              name
                ? "请使用 1–16 个英文字母、数字或下划线。"
                : "请输入角色名称。",
            );
            input.current?.focus();
            return;
          }
          submitting.current = true;
          setSaving(true);
          setError("");
          try {
            await api("players.add", { name });
            await app.refresh();
            if (active.current) {
              app.notify("角色已添加");
              app.navigate({ page: "players" });
            }
          } catch (e) {
            if (active.current) setError(String(e));
          } finally {
            submitting.current = false;
            if (active.current) setSaving(false);
          }
        }}
      >
        <div className="players-offline-fields">
          <div className="players-login-label">
            <label htmlFor="offline-player-name">角色名称</label>
            <span>{name.length} / 16</span>
          </div>
          <Input
            ref={input}
            id="offline-player-name"
            autoFocus
            value={name}
            maxLength={16}
            placeholder="例如 Steve_42"
            disabled={saving}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => {
              onNameChange(e.target.value);
              setError("");
            }}
            required
            pattern="[A-Za-z0-9_]{1,16}"
            aria-invalid={!!error}
            aria-describedby={`offline-name-help${error ? " offline-name-error" : ""}`}
          />
          <p className="helper" id="offline-name-help">
            1–16 个英文字母、数字或下划线。
          </p>
          {error && (
            <p className="inline-error" id="offline-name-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <PlayerCamp />
        <div className="players-login-submit">
          <Button type="submit" primary disabled={saving || app.busy}>
            {saving ? <LoaderCircle size={15} className="spin" /> : null}
            创建角色
            <ChevronRight size={14} />
          </Button>
        </div>
      </form>
    </div>
  );
}

export function PlayerMicrosoftLogin({ auth }: { auth: PlayerLoginState }) {
  const app = useApp();
  const time = `${String(Math.floor(auth.remaining / 60)).padStart(2, "0")}:${String(auth.remaining % 60).padStart(2, "0")}`;
  if (auth.completed)
    return (
      <div className="players-login-content players-login-result" role="status">
        <Badge>
          <Check size={13} />
          登录成功
        </Badge>
        <h3>准备好，出发吧。</h3>
        <p>Microsoft 账号已加入「我的角色」。</p>
      </div>
    );
  return (
    <div
      className="players-login-content players-microsoft-form"
      aria-busy={auth.loading}
    >
      <div className="players-login-primary">
        <div className="players-login-intro">
          <h3>
            {auth.failed
              ? "登录未完成"
              : auth.loading
                ? "正在准备登录"
                : auth.step === 0
                  ? "在浏览器中完成授权"
                  : auth.steps[auth.step]?.name}
          </h3>
          <p>
            {auth.loading
              ? "正在获取 Microsoft 设备代码…"
              : auth.step === 0
                ? "在浏览器中输入代码，完成授权后自动添加角色。"
                : "验证完成后将自动进入下一步，请稍候。"}
          </p>
        </div>
        {auth.failed ? (
          <div className="players-login-error">
            <p className="inline-error" role="alert">
              {auth.error || "登录失败，请重试。"}
            </p>
            <Button
              primary
              disabled={auth.loading || app.busy}
              onClick={auth.start}
            >
              <RefreshCw size={14} />
              重新登录
            </Button>
          </div>
        ) : auth.loading || !auth.login ? (
          <div className="players-login-wait" role="status">
            <LoaderCircle size={20} className="spin" />
            正在获取设备代码
          </div>
        ) : auth.step === 0 ? (
          <>
            <div className="players-login-label">
              <span>设备代码</span>
              <span>
                <Clock3 size={13} />
                <time aria-label="设备代码剩余时间">{time}</time>
              </span>
            </div>
            <button
              className="device-code has-surface"
              type="button"
              aria-label={`复制设备代码 ${auth.login.userCode}`}
              onClick={() =>
                void app.run(
                  () => navigator.clipboard.writeText(auth.login!.userCode),
                  "设备代码已复制",
                )
              }
            >
              <PixelFrame />
              <span className="players-device-code-text">
                {auth.login.userCode}
              </span>
              <Copy size={18} />
            </button>
            <div
              className="players-auth-split players-split-button has-surface"
              role="group"
              aria-label="授权页面操作"
            >
              <PixelFrame />
              <button
                type="button"
                className="players-auth-open"
                onClick={() => void auth.openBrowser()}
              >
                <ExternalLink size={15} />
                <span>打开授权页面</span>
              </button>
              <button
                type="button"
                className="players-split-secondary"
                aria-label="复制授权链接"
                data-tooltip="复制授权链接"
                onClick={() =>
                  void app.run(
                    () =>
                      navigator.clipboard.writeText(
                        auth.login!.verificationUri,
                      ),
                    "授权链接已复制",
                  )
                }
              >
                <Copy size={15} />
              </button>
            </div>
            {auth.browserError && (
              <p className="inline-error players-browser-error" role="alert">
                {auth.browserError}
              </p>
            )}
            <p className="players-login-status" role="status">
              <LoaderCircle size={13} className="spin" />
              等待浏览器授权，完成后自动继续
            </p>
          </>
        ) : (
          <div className="players-login-wait" role="status">
            <LoaderCircle size={20} className="spin" />
            {auth.steps[auth.step]?.detail || "正在验证账号"}
          </div>
        )}
      </div>
      <div className="players-login-steps" aria-label="登录进度">
        <Steps steps={auth.steps} />
      </div>
    </div>
  );
}

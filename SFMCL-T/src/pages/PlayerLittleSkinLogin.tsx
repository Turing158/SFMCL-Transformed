import {
  Check,
  ChevronRight,
  Clock3,
  Copy,
  ExternalLink,
  Globe,
  LoaderCircle,
  RefreshCw,
  Users,
} from "lucide-react";
import { Badge, Button, PixelFrame, Steps } from "../components";
import { useApp } from "../store";
import type { LittleSkinLoginState } from "../useLittleSkinLogin";
import type { AuthProvider } from "./PlayerLogin";

const appIcon = new URL("../../src-tauri/icons/icon.ico", import.meta.url).href;

export const littleSkinProviders: readonly AuthProvider[] = [
  {
    name: "LittleSkin",
    id: "littleskin-device",
    caption: "CONNECTING LITTLESKIN",
    detail: "获取授权码",
    icon: <Globe strokeWidth={1.5} />,
  },
  {
    name: "LittleSkin",
    id: "littleskin-browser",
    caption: "LITTLESKIN",
    detail: "授权你的账号",
    icon: <Globe strokeWidth={1.5} />,
  },
  {
    name: "游戏角色",
    id: "littleskin-profiles",
    caption: "CHOOSE YOUR CHARACTER",
    detail: "选择角色",
    icon: <Users strokeWidth={1.5} />,
  },
  {
    name: "SFMCL-T",
    id: "sfmcl-t",
    caption: "SFMCL-T LAUNCHER",
    detail: "保存角色",
    icon: <img src={appIcon} alt="" />,
  },
];

export function PlayerLittleSkinLogin({
  auth,
  importedServer,
}: {
  auth: LittleSkinLoginState;
  importedServer?: string;
}) {
  const app = useApp();
  const time = `${String(Math.floor(auth.remaining / 60)).padStart(2, "0")}:${String(auth.remaining % 60).padStart(2, "0")}`;
  if (auth.completed)
    return (
      <div
        className="players-login-content players-yggdrasil-content players-login-result"
        role="status"
      >
        <Badge>
          <Check size={13} />
          登录成功
        </Badge>
        <h3>可以开始游戏了。</h3>
        <p>角色已加入「我的角色」。</p>
      </div>
    );
  const title = auth.failed
    ? "登录未完成"
    : auth.state === "idle"
      ? "授权已取消"
      : auth.loading
        ? "准备登录"
        : auth.step === 1
          ? "浏览器授权"
          : auth.step === 2
            ? "选择角色"
            : "正在保存角色";
  return (
    <div
      className={`players-login-content players-yggdrasil-content players-littleskin-form${importedServer ? " players-yggdrasil-import" : ""}`}
      data-auth-busy={auth.busy}
      aria-busy={auth.loading || auth.state === "saving"}
    >
      <div className="players-login-primary">
        {importedServer && (
          <div className="players-imported-server has-surface">
            <PixelFrame />
            <span className="helper">验证站点</span>
            <h3>登录 LittleSkin</h3>
            <p className="helper players-imported-address">{importedServer}</p>
          </div>
        )}
        <div className="players-login-intro">
          <h3>{title}</h3>
          {!auth.failed && auth.step === 1 && <p>确认授权后自动继续。</p>}
        </div>
        {auth.failed ? (
          <div className="players-login-error">
            <p className="inline-error" role="alert">
              {auth.error}
            </p>
            {auth.accountSaved ? (
              <Button
                primary
                disabled={app.busy}
                onClick={() => void auth.retryRefresh()}
              >
                <RefreshCw size={14} />
                刷新角色列表
              </Button>
            ) : auth.authorized && auth.step === 3 ? (
              <div className="players-yggdrasil-profiles">
                {auth.authorized.profiles.map((profile) => (
                  <Button
                    key={profile.id}
                    disabled={app.busy}
                    onClick={() => void auth.select(profile.id)}
                  >
                    <RefreshCw size={14} />
                    重试保存 {profile.name}
                  </Button>
                ))}
              </div>
            ) : null}
            {!auth.accountSaved && (
              <Button primary disabled={app.busy} onClick={auth.start}>
                <RefreshCw size={14} />
                重新授权 LittleSkin
              </Button>
            )}
          </div>
        ) : auth.state === "idle" ? (
          <Button primary disabled={app.busy} onClick={auth.start}>
            <Globe size={15} />
            使用 LittleSkin 授权登录
          </Button>
        ) : auth.loading ? (
          <div className="players-login-wait" role="status">
            <LoaderCircle size={20} className="spin" />
            正在获取 LittleSkin 授权码
          </div>
        ) : auth.step === 1 && auth.login ? (
          <>
            <div className="players-login-label">
              <span>授权码</span>
              <span>
                <Clock3 size={13} />
                <time aria-label="授权码剩余时间">{time}</time>
              </span>
            </div>
            <button
              className="device-code has-surface"
              type="button"
              aria-label={`复制授权码 ${auth.login.userCode}`}
              onClick={() =>
                void app.run(
                  () => navigator.clipboard.writeText(auth.login!.userCode),
                  "授权码已复制",
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
              aria-label="LittleSkin 授权页面操作"
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
                        auth.login!.verificationUriComplete ||
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
          </>
        ) : auth.step === 2 && auth.authorized ? (
          <div
            className="players-yggdrasil-profiles players-littleskin-profiles"
            role="group"
            aria-label="选择 LittleSkin 游戏角色"
          >
            {auth.authorized.profiles.map((profile, index) => (
              <Button
                key={profile.id}
                disabled={app.busy}
                style={{ animationDelay: `${index * 45}ms` }}
                onClick={() => void auth.select(profile.id)}
              >
                <Users size={16} />
                <span>{profile.name}</span>
                <ChevronRight size={14} />
              </Button>
            ))}
          </div>
        ) : (
          <div className="players-login-wait" role="status">
            <LoaderCircle size={20} className="spin" />
            正在保存角色…
          </div>
        )}
        {!auth.failed && auth.state !== "idle" && auth.state !== "saving" && (
          <div className="players-littleskin-cancel">
            <Button disabled={app.busy} onClick={auth.cancel}>
              {auth.step === 2 ? "重新登录" : "取消授权"}
            </Button>
          </div>
        )}
      </div>
      <div className="players-login-steps" aria-label="登录进度" role="status">
        <Steps
          steps={auth.steps.map((step, index) => ({
            ...step,
            name: index === 2 ? "选择角色" : step.name,
            detail: "",
          }))}
          animated
        />
      </div>
    </div>
  );
}

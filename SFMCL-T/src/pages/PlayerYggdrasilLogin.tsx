import { useEffect, useRef, useState } from "react";
import { Globe, LoaderCircle } from "lucide-react";
import { api } from "../api";
import { Button, PixelFrame } from "../components";
import { Input } from "../controls";
import { useApp } from "../store";
import { usePageActive } from "../PageActivity";
import { YggdrasilServerSelect } from "./YggdrasilServerSelect";
import { PlayerLittleSkinLogin } from "./PlayerLittleSkinLogin";
import { PlayerAuthorizationUnavailable } from "./PlayerAuthorizationUnavailable";
import { thirdPartyOAuthEnabled } from "../playerLoginAvailability";
import { isLittleSkinServer, yggdrasilServerLabel } from "../yggdrasilDrop";
import type { YggdrasilLogin as Login } from "../types";

export function PlayerYggdrasilLogin({
  importedServer,
  method: requestedMethod = "password",
}: {
  importedServer?: string;
  method?: "password" | "browser";
}) {
  const app = useApp();
  const pageActive = usePageActive();
  const method =
    importedServer &&
    isLittleSkinServer(importedServer) &&
    thirdPartyOAuthEnabled
      ? "browser"
      : requestedMethod;
  const [server, setServer] = useState(importedServer ?? "");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [login, setLogin] = useState<Login | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const running = useRef(false);
  const session = useRef("");
  const visible = useRef(pageActive);
  visible.current = pageActive;
  const discard = (id: string) => {
    if (id)
      void api("players.yggdrasil.cancel", { sessionId: id }).catch(() => {});
  };

  useEffect(() => {
    setPassword("");
    setLogin(null);
    setSaving(false);
    setError("");
    running.current = false;
    return () => {
      generation.current++;
      discard(session.current);
      session.current = "";
    };
  }, [pageActive, method]);

  const complete = async (value: Login, profileId: string, attempt: number) => {
    await api("players.yggdrasil.select", {
      sessionId: value.sessionId,
      profileId,
    });
    if (generation.current !== attempt) return;
    session.current = "";
    await app.refresh();
    if (generation.current === attempt && visible.current) {
      app.notify("第三方角色已添加");
      app.navigate({ page: "players" });
    }
  };

  return (
    <div
      className={`players-login-content players-yggdrasil-content${importedServer ? " players-yggdrasil-import" : ""}`}
      data-auth-busy={saving}
    >
      <div>
        {importedServer && !login && (
          <div className="players-imported-server has-surface">
            <PixelFrame />
            <span className="helper">验证站点</span>
            <h3>登录 {yggdrasilServerLabel(importedServer)}</h3>
            <p className="helper players-imported-address">{importedServer}</p>
          </div>
        )}
        {login && (
          <div className="players-login-intro">
            <h3>选择你的游戏角色。</h3>
            <p>{login.serverName} · 选择本次登录使用的角色。</p>
          </div>
        )}
        {login ? (
          <div className="players-yggdrasil-profiles">
            <p className="helper">{login.server}</p>
            {login.profiles.map((profile) => (
              <Button
                key={profile.id}
                disabled={saving || app.busy}
                onClick={async () => {
                  if (running.current) return;
                  const attempt = generation.current;
                  running.current = true;
                  setSaving(true);
                  setError("");
                  try {
                    await complete(login, profile.id, attempt);
                  } catch (e) {
                    if (generation.current === attempt) setError(String(e));
                  } finally {
                    if (generation.current === attempt) {
                      running.current = false;
                      setSaving(false);
                    }
                  }
                }}
              >
                <Globe size={15} />
                {profile.name}
              </Button>
            ))}
            <Button
              disabled={saving}
              onClick={() => {
                discard(session.current);
                session.current = "";
                setLogin(null);
                setError("");
              }}
            >
              重新登录
            </Button>
          </div>
        ) : method === "browser" ? (
          thirdPartyOAuthEnabled ? (
            <PlayerLittleSkinLogin
              autoStart={!!importedServer}
              onAuthorized={async (value) => {
                const attempt = generation.current;
                if (!visible.current) {
                  discard(value.sessionId);
                  return;
                }
                session.current = value.sessionId;
                setLogin(value);
                if (value.profiles.length === 1) {
                  running.current = true;
                  setSaving(true);
                  try {
                    await complete(value, value.profiles[0].id, attempt);
                  } catch (e) {
                    if (generation.current === attempt) setError(String(e));
                  } finally {
                    if (generation.current === attempt) {
                      running.current = false;
                      setSaving(false);
                    }
                  }
                }
              }}
            />
          ) : (
            <PlayerAuthorizationUnavailable />
          )
        ) : (
          <form
            className="players-yggdrasil-form"
            onSubmit={async (event) => {
              event.preventDefault();
              if (running.current) return;
              const attempt = generation.current;
              running.current = true;
              setSaving(true);
              setError("");
              try {
                const value = await api<Login>("players.yggdrasil.login", {
                  server: server.trim(),
                  username: username.trim(),
                  password,
                });
                if (generation.current !== attempt || !visible.current) {
                  discard(value.sessionId);
                  return;
                }
                session.current = value.sessionId;
                setPassword("");
                setLogin(value);
                if (value.profiles.length === 1)
                  await complete(value, value.profiles[0].id, attempt);
              } catch (e) {
                if (generation.current === attempt) setError(String(e));
              } finally {
                if (generation.current === attempt) {
                  running.current = false;
                  setPassword("");
                  setSaving(false);
                }
              }
            }}
          >
            {!importedServer && (
              <>
                <label htmlFor="yggdrasil-server">验证服务器地址</label>
                <YggdrasilServerSelect
                  value={server}
                  disabled={saving}
                  onChange={setServer}
                />
              </>
            )}
            <div className="players-yggdrasil-credentials">
              <div className="players-yggdrasil-field">
                <label htmlFor="yggdrasil-username">站点账号</label>
                <Input
                  id="yggdrasil-username"
                  required
                  value={username}
                  disabled={saving}
                  placeholder="邮箱或用户名"
                  autoComplete="username"
                  autoFocus={!!importedServer}
                  spellCheck={false}
                  onChange={(e) => setUsername(e.target.value)}
                />
              </div>
              <div className="players-yggdrasil-field">
                <label htmlFor="yggdrasil-password">密码</label>
                <Input
                  id="yggdrasil-password"
                  type="password"
                  required
                  value={password}
                  disabled={saving}
                  autoComplete="off"
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
            </div>
            {importedServer &&
              isLittleSkinServer(importedServer) &&
              !thirdPartyOAuthEnabled && (
                <p className="helper players-authorization-note">
                  浏览器授权暂未开放，请使用站点账号和密码登录。
                </p>
              )}
            <div className="players-login-submit">
              <Button type="submit" primary disabled={saving || app.busy}>
                {saving ? (
                  <LoaderCircle size={15} className="spin" />
                ) : (
                  <Globe size={15} />
                )}
                {saving ? "正在验证…" : "登录验证站点"}
              </Button>
            </div>
          </form>
        )}
        {saving && login && <p role="status">正在保存角色…</p>}
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

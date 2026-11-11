import { useId } from "react";
import {
  ArrowRight,
  Box,
  Check,
  CircleHelp,
  Copy,
  DoorOpen,
  Download,
  Gamepad2,
  LoaderCircle,
  Network,
  Play,
  Plus,
  RefreshCw,
  Upload,
  UserRound,
  Users,
  X,
} from "lucide-react";
import { Badge, Button, PixelFrame, TabList, TabPanel } from "../components";
import { Input, Select, Textarea } from "../controls";
import { PageHeader } from "../PageHeader";
import { api, confirmAction, desktop, pick } from "../api";
import { useApp } from "../store";
import { useMultiplayer } from "../useMultiplayer";
import { getHostLaunch, getHostLaunches, getLaunchTask } from "../launchState";
import "../multiplayer.css";

const hostSteps = [
  [
    "开放世界",
    "启动 Minecraft Java 版，进入存档并「对局域网开放」，填写聊天栏显示的端口。启动器会自动使用该游戏的角色和版本；多个游戏同时运行时请选择房主游戏。",
  ],
  [
    "创建房间",
    "填写房间名称后创建。默认使用 Cloudflare Tunnel + 本机EasyTier 自动建立联机入口；选择「共享EasyTier节点」后，填写 tcp://主机:端口 或 udp://主机:端口。首次使用会在下载中心准备组件，也可导入官方 EasyTier v2.6.4 ZIP；准备完成后自动继续。",
  ],
  [
    "分享邀请",
    "房间就绪后复制完整邀请码给好友。保持世界、游戏和启动器运行；端口改变后需要重新创建房间。邀请码只分享给参与者。",
  ],
];
const guestSteps = [
  [
    "粘贴邀请码",
    "向房主获取完整邀请码，查看房间名称和游戏版本，再加入房间。连接入口已包含在邀请码中，无需额外配置。暂不支持短房间码。",
  ],
  [
    "准备相同的游戏",
    "选择与房主相同的 Minecraft 版本、加载器和模组，使用能通过服务器认证的角色。网络成员列表不代表已经进入游戏。",
  ],
  [
    "连接世界",
    "世界开放后点击「启动并连接」。已运行的游戏可复制地址，在多人游戏中直接连接。离开房间会断开连接。",
  ],
];
const labels = {
  idle: "准备联机",
  preparing: "准备组件",
  connecting: "连接中",
  ready: "世界已开放",
  waiting: "等待世界开放",
  leaving: "正在离开",
  failed: "连接未完成",
};
const routes: Record<string, string> = {
  local: "本机",
  direct: "直连",
  relay: "中继",
  tunnel: "隧道",
  unknown: "未知",
};

export function Multiplayer() {
  const app = useApp();
  const mp = useMultiplayer();
  const id = useId();
  const s = mp.snapshot;
  const preparing = s.state === "preparing";
  const componentNoticeAtBottom =
    s.componentReady && s.state === "idle" && !s.sessionId;
  const inSession = !!s.sessionId && !!s.role && !preparing;
  const hosting = s.role ? s.role === "host" : mp.mode === "create";
  const settings = app.data.settings;
  const player = app.data.players.find(
    (item) => item.uuid === settings.activePlayer,
  );
  const version = app.versions.find(
    (item) => item.id === settings.activeVersion,
  );
  const launch = getLaunchTask(app.tasks, settings.activeVersion);
  const hostGames = getHostLaunches(app.tasks);
  const hostLaunch = getHostLaunch(hostGames, mp.hostLaunchId);
  const hostContext = hosting ? hostLaunch?.launch : undefined;
  const usingHostGame = hosting && hostGames.length > 0;
  const canCreate = usingHostGame
    ? !!hostContext?.running
    : !!version && !!player;
  const gameVersion = hostContext?.gameVersion || version?.version;
  const mismatch =
    !!gameVersion && !!s.gameVersion && gameVersion !== s.gameVersion;
  const locked = mp.busy || !desktop || preparing;
  const usingSharedNode = mp.connectionMode === "shared";
  async function copy(kind: "invitation" | "address") {
    await app.run(
      async () => {
        const value =
          kind === "invitation"
            ? await api<string>("multiplayer.invitation", {
                sessionId: s.sessionId,
              })
            : s.address;
        if (value) await navigator.clipboard.writeText(value);
      },
      kind === "invitation" ? "邀请码已复制" : "连接地址已复制",
    );
  }
  async function startGame() {
    if (
      mismatch &&
      !(await confirmAction(
        `房间版本为 ${s.gameVersion}，当前为 ${version?.version}。仍要启动？`,
      ))
    )
      return;
    await app.run(() =>
      api("launch", {
        sessionId: s.sessionId,
        id: settings.activeVersion,
        directory: settings.activeDir,
      }),
    );
    await app.refresh();
  }
  const notice = (
    <section
      className="multiplayer-notice panel has-surface"
      aria-label="联机状态"
    >
      <PixelFrame />
      <Network size={22} aria-hidden="true" />
      <div role="status">
        <strong>{mp.loading ? "读取联机状态…" : labels[s.state]}</strong>
        <small>
          {s.state === "preparing"
            ? "任务已加入下载中心"
            : s.componentReady
              ? `EasyTier ${s.componentVersion}`
              : "首次使用需准备组件"}
        </small>
      </div>
      {preparing ? (
        <Button onClick={() => app.setPage("downloads")}>
          <Download size={16} />
          查看下载
        </Button>
      ) : s.sessionId ? (
        <Button
          disabled={locked || s.state === "leaving"}
          onClick={() =>
            void mp.action("multiplayer.leave", { sessionId: s.sessionId })
          }
        >
          <X size={16} />
          {s.role ? (hosting ? "关闭房间" : "离开房间") : "取消"}
        </Button>
      ) : (
        <>
          <Button
            disabled={locked}
            onClick={() => void mp.action("multiplayer.prepare")}
          >
            <Download size={16} />
            {s.componentReady ? "校验组件" : "准备组件"}
          </Button>
          <Button
            disabled={locked}
            onClick={() =>
              void app.run(async () => {
                const archive = await pick(false, ["zip"]);
                if (archive)
                  await mp.action("multiplayer.prepare", { archive });
              })
            }
          >
            <Upload size={16} />
            导入组件
          </Button>
        </>
      )}
    </section>
  );
  return (
    <div className="multiplayer-page">
      <PageHeader
        icon={<Network />}
        title="联机"
        eyebrow="PLAY TOGETHER"
        action={<Badge className="multiplayer-edition">JAVA EDITION</Badge>}
      />
      {!componentNoticeAtBottom && notice}
      {(mp.error || s.error) && (
        <div className="multiplayer-error" role="alert">
          <span>{mp.error || s.error}</span>
          {!inSession && (
            <Button
              onClick={() => {
                mp.setError("");
                void mp.refresh();
              }}
            >
              <RefreshCw size={16} />
              刷新
            </Button>
          )}
        </div>
      )}
      <div className="multiplayer-layout">
        <section
          className="multiplayer-room panel has-surface"
          aria-label={inSession ? "当前房间" : "房间准备"}
        >
          <PixelFrame />
          {inSession ? (
            <>
              <div className="multiplayer-session-heading">
                <div>
                  <small>{hosting ? "房主" : "好友"}</small>
                  <h2>{s.name}</h2>
                </div>
                <Badge>{s.gameVersion || `v${s.componentVersion}`}</Badge>
              </div>
              <div className="multiplayer-world" role="status">
                {s.worldOpen ? (
                  <Check size={20} />
                ) : (
                  <LoaderCircle size={20} className="spin" />
                )}
                <strong>{labels[s.state]}</strong>
              </div>
              <div className="multiplayer-address">
                <small>连接地址</small>
                <code>{s.address || "等待分配"}</code>
                <Button
                  disabled={!s.address || locked}
                  onClick={() => void copy("address")}
                >
                  <Copy size={15} />
                  复制地址
                </Button>
              </div>
              <h3 className="multiplayer-members-heading">
                网络成员 <span>{s.members.length}</span>
              </h3>
              <ul className="multiplayer-members" aria-label="网络成员">
                {s.members.map((member) => (
                  <li key={member.id}>
                    <UserRound size={18} />
                    <div>
                      <strong>{member.name}</strong>
                      <small>{member.ip}</small>
                    </div>
                    <Badge>
                      {routes[member.connection] || "未知"}
                      {member.latency !== null && !member.local
                        ? ` · ${member.latency.toFixed(0)} ms`
                        : ""}
                    </Badge>
                  </li>
                ))}
              </ul>
              {!s.members.length && (
                <p className="multiplayer-empty">等待网络连接</p>
              )}
              <div className="multiplayer-submit">
                {hosting ? (
                  <Button
                    primary
                    disabled={locked || !s.worldOpen}
                    onClick={() => void copy("invitation")}
                  >
                    <Copy size={17} />
                    复制邀请码
                  </Button>
                ) : (
                  <>
                    <Button
                      primary
                      disabled={
                        locked ||
                        !s.worldOpen ||
                        !version ||
                        !player ||
                        launch.active ||
                        app.busy
                      }
                      onClick={() => void startGame()}
                    >
                      <Play size={17} />
                      {launch.active ? "游戏启动中或运行中" : "启动并连接"}
                    </Button>
                    {!version && (
                      <Button
                        onClick={() =>
                          app.navigate({
                            page: "resources",
                            tab: "minecraft",
                          })
                        }
                      >
                        安装游戏
                        <ArrowRight size={16} />
                      </Button>
                    )}
                  </>
                )}
              </div>
              {mismatch && (
                <small className="multiplayer-version-warning">
                  版本不同：房间 {s.gameVersion} · 当前 {gameVersion}
                </small>
              )}
            </>
          ) : (
            <>
              <TabList
                id={id}
                label="联机方式"
                value={hosting ? "create" : "join"}
                onValueChange={(value) =>
                  !s.role && mp.setMode(value as "create" | "join")
                }
                items={[
                  {
                    value: "create",
                    label: "创建房间",
                    icon: <Plus size={17} />,
                  },
                  {
                    value: "join",
                    label: "加入房间",
                    icon: <DoorOpen size={17} />,
                  },
                ]}
              />
              <TabPanel id={id} value={hosting ? "create" : "join"}>
                {hosting ? (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (locked || !canCreate) return;
                      if (usingSharedNode && !mp.server.trim()) {
                        mp.setError("请输入 EasyTier 共享节点地址");
                        return;
                      }
                      void mp.action("multiplayer.create", {
                        name: mp.roomName,
                        port: Number(mp.port),
                        ...(usingSharedNode
                          ? { server: mp.server.trim() }
                          : {}),
                        ...(hostLaunch ? { launchId: hostLaunch.id } : {}),
                      });
                    }}
                  >
                    {hostGames.length > 1 && (
                      <div className="multiplayer-field">
                        <label htmlFor={`${id}-host-game`}>房主游戏</label>
                        <Select
                          id={`${id}-host-game`}
                          value={hostLaunch?.id || ""}
                          onValueChange={mp.setHostLaunchId}
                          disabled={locked}
                          placeholder="选择用于创建房间的游戏"
                          animateValue
                          truncateOptions
                        >
                          {hostGames.map((job) => (
                            <option key={job.id} value={job.id}>
                              {`${job.launch!.versionId} · ${job.launch!.playerName} · ${job.launch!.running ? "运行中" : "启动中"} · ${job.launch!.directory}`}
                            </option>
                          ))}
                        </Select>
                      </div>
                    )}
                    {usingHostGame && (
                      <p className="multiplayer-host-hint" role="status">
                        {!hostContext
                          ? "检测到多个游戏，请选择用于创建房间的游戏。"
                          : hostContext.running
                            ? "已自动使用房主游戏的角色和版本，无需重新选择。"
                            : "游戏还在启动，请进入世界并对局域网开放后创建房间。"}
                      </p>
                    )}
                    <div className="multiplayer-field">
                      <label htmlFor={`${id}-name`}>房间名称</label>
                      <Input
                        id={`${id}-name`}
                        required
                        disabled={preparing}
                        value={mp.roomName}
                        onChange={(event) => mp.setRoomName(event.target.value)}
                        maxLength={48}
                        placeholder="周末的生存世界"
                        autoComplete="off"
                      />
                    </div>
                    <div className="multiplayer-field">
                      <label htmlFor={`${id}-port`}>游戏端口</label>
                      <div className="multiplayer-port-row">
                        <Input
                          id={`${id}-port`}
                          required
                          value={mp.port}
                          onChange={(event) =>
                            mp.changePort(event.target.value)
                          }
                          disabled={preparing || mp.check === "检查中…"}
                          pattern="[0-9]{1,5}"
                          inputMode="numeric"
                          maxLength={5}
                          placeholder="游戏中显示的端口"
                          autoComplete="off"
                        />
                        <Button
                          disabled={locked || mp.check === "检查中…"}
                          onClick={() => void mp.checkPort()}
                        >
                          <Network size={16} />
                          检查端口
                        </Button>
                      </div>
                      <small role="status">{mp.check}</small>
                    </div>
                    <div className="multiplayer-field">
                      <label htmlFor={`${id}-connection-mode`}>联机方式</label>
                      <div
                        className="multiplayer-connection-row"
                        data-mode={mp.connectionMode}
                      >
                        <div className="multiplayer-node-input">
                          {usingSharedNode && (
                            <Input
                              id={`${id}-server`}
                              required
                              disabled={preparing}
                              value={mp.server}
                              onChange={(event) => {
                                mp.setServer(event.target.value);
                                mp.setError("");
                              }}
                              maxLength={300}
                              placeholder="tcp://主机:端口"
                              aria-label="共享节点"
                              aria-describedby={`${id}-server-help`}
                              spellCheck={false}
                              autoComplete="off"
                            />
                          )}
                        </div>
                        <Select
                          id={`${id}-connection-mode`}
                          value={mp.connectionMode}
                          onValueChange={(value) => {
                            mp.setConnectionMode(value as "tunnel" | "shared");
                            mp.setError("");
                          }}
                          disabled={preparing}
                          aria-describedby={`${id}-server-help`}
                          animateValue
                        >
                          <option value="tunnel">
                            Cloudflare Tunnel + 本机EasyTier
                          </option>
                          <option value="shared">共享EasyTier节点</option>
                        </Select>
                      </div>
                      <small id={`${id}-server-help`}>
                        {usingSharedNode
                          ? "填写 tcp://主机:端口 或 udp://主机:端口，使用指定的 EasyTier 共享节点。"
                          : "自动创建 Cloudflare Tunnel，连接本机 EasyTier 节点。"}
                      </small>
                    </div>
                    <div className="multiplayer-submit">
                      <Button
                        type="submit"
                        primary
                        disabled={locked || !canCreate}
                      >
                        <Plus size={17} />
                        创建房间
                      </Button>
                    </div>
                  </form>
                ) : (
                  <div>
                    <div className="multiplayer-field">
                      <label htmlFor={`${id}-invitation`}>联机邀请码</label>
                      <Textarea
                        id={`${id}-invitation`}
                        value={mp.invitation}
                        disabled={preparing}
                        onChange={(event) =>
                          mp.changeInvitation(event.target.value)
                        }
                        rows={5}
                        maxLength={4096}
                        placeholder="粘贴完整邀请码"
                        spellCheck={false}
                        autoComplete="off"
                      />
                    </div>
                    {mp.preview && (
                      <dl className="multiplayer-preview">
                        <div>
                          <dt>房间</dt>
                          <dd>{mp.preview.name}</dd>
                        </div>
                        <div>
                          <dt>版本</dt>
                          <dd>{mp.preview.gameVersion}</dd>
                        </div>
                        <div>
                          <dt>联机入口</dt>
                          <dd>{mp.preview.server}</dd>
                        </div>
                      </dl>
                    )}
                    <div className="multiplayer-submit">
                      {mp.preview ? (
                        <Button
                          primary
                          disabled={locked || !player}
                          onClick={() =>
                            void mp.action("multiplayer.join", {
                              invitation: mp.invitation,
                            })
                          }
                        >
                          <DoorOpen size={17} />
                          加入房间
                        </Button>
                      ) : (
                        <Button
                          primary
                          disabled={locked || !mp.invitation.trim()}
                          onClick={() => void mp.inspect()}
                        >
                          <ArrowRight size={17} />
                          查看房间
                        </Button>
                      )}
                    </div>
                  </div>
                )}
              </TabPanel>
            </>
          )}
        </section>
        <aside
          className="multiplayer-guide panel has-surface"
          aria-labelledby={`${id}-guide`}
        >
          <PixelFrame />
          <div className="multiplayer-guide-heading">
            <Users size={20} />
            <h2 id={`${id}-guide`}>{hosting ? "创建教程" : "加入教程"}</h2>
          </div>
          <ol>
            {(hosting ? hostSteps : guestSteps).map(
              ([title, description], index) => (
                <li key={title}>
                  <span className="multiplayer-step" aria-hidden="true">
                    0{index + 1}
                  </span>
                  <div>
                    <h3>{title}</h3>
                    <p>{description}</p>
                  </div>
                </li>
              ),
            )}
          </ol>
          <div className="multiplayer-guide-note">
            <CircleHelp size={17} />
            <p>
              默认使用 Cloudflare
              临时隧道，服务可用性和延迟受网络影响。指定共享节点需双方可访问并支持中继。切页、最小化和隐藏到托盘均会保持连接；关闭房间后邀请码失效。
            </p>
          </div>
        </aside>
      </div>
      <section
        className="multiplayer-game panel has-surface"
        aria-label="当前游戏"
      >
        <PixelFrame />
        <div className="multiplayer-game-header">
          <div className="multiplayer-game-heading">
            <Gamepad2 size={21} aria-hidden="true" />
            <h2>
              {hostContext
                ? hostContext.running
                  ? "正在运行的游戏"
                  : "正在启动的游戏"
                : usingHostGame
                  ? "房主游戏"
                  : "当前游戏"}
            </h2>
          </div>
          {!usingHostGame && (
            <div className="multiplayer-game-actions">
              <Button
                onClick={() => app.setPage(!player ? "players" : "versions")}
              >
                {!player ? "选择角色" : "选择版本"}
                <ArrowRight size={16} aria-hidden="true" />
              </Button>
              {!s.sessionId && version && player && (
                <Button primary onClick={() => app.setPage("home")}>
                  开始游戏
                  <ArrowRight size={16} aria-hidden="true" />
                </Button>
              )}
            </div>
          )}
        </div>
        <div className="multiplayer-game-details">
          <div className="multiplayer-selection">
            <UserRound size={18} aria-hidden="true" />
            <div>
              <small>{usingHostGame ? "游戏角色" : "当前角色"}</small>
              <strong>
                {hostContext?.playerName ||
                  (usingHostGame
                    ? "请选择房主游戏"
                    : player?.name || "尚未选择角色")}
              </strong>
            </div>
          </div>
          <div className="multiplayer-selection">
            <Box size={18} aria-hidden="true" />
            <div>
              <small>游戏版本</small>
              <strong>
                {hostContext?.versionId ||
                  (usingHostGame
                    ? "请选择房主游戏"
                    : version?.id || "尚未选择版本")}
              </strong>
            </div>
          </div>
        </div>
      </section>
      {componentNoticeAtBottom && notice}
    </div>
  );
}

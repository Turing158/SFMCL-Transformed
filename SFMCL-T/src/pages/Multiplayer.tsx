import { useId } from "react";
import {
  ArrowRight,
  Blocks,
  Check,
  Copy,
  DoorOpen,
  Download,
  LoaderCircle,
  Network,
  Play,
  Plus,
  RefreshCw,
  Upload,
  SlidersHorizontal,
  ShieldCheck,
  UserRound,
  X,
} from "lucide-react";
import {
  Badge,
  Button,
  ErrorBanner,
  PixelFrame,
  TabList,
  TabPanel,
} from "../components";
import { Input, Select, Textarea } from "../controls";
import { PageHeader } from "../PageHeader";
import { api, confirmAction, desktop, pick } from "../api";
import { useApp } from "../store";
import { useTasks } from "../tasks";
import { useMultiplayer, type MultiplayerService } from "../useMultiplayer";
import { useTabContentTransition } from "../useTabContentTransition";
import { getHostLaunch, getHostLaunches, getLaunchTask } from "../launchState";
import { MultiplayerOfflineLan } from "./MultiplayerOfflineLan";
import { MultiplayerInviteInput } from "./MultiplayerInviteInput";
import { TerracottaOptions, hasTerracottaCode } from "./MultiplayerTerracotta";
import "../multiplayer.css";

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
  host: "房主",
  guest: "好友",
  local: "本机",
  direct: "直连",
  relay: "中继",
  tunnel: "隧道",
  unknown: "未知",
};
const formatOfficialCode = (value: string) =>
  `${value.slice(0, 4)}-${value.slice(4)}`;

export function Multiplayer() {
  const app = useApp();
  const tasks = useTasks();
  const mp = useMultiplayer();
  const id = useId();
  const s = mp.snapshot;
  const preparing = s.state === "preparing";
  const inSession = !!s.sessionId && !!s.role && !preparing;
  const hosting = s.role ? s.role === "host" : mp.mode === "create";
  const settings = app.data.settings;
  const player = app.data.players.find(
    (item) => item.uuid === settings.activePlayer,
  );
  const version = app.versions.find(
    (item) => item.id === settings.activeVersion,
  );
  const launch = getLaunchTask(tasks, settings.activeVersion);
  const hostGames = getHostLaunches(tasks);
  const hostLaunch = getHostLaunch(hostGames, mp.hostLaunchId);
  const hostContext = hosting ? hostLaunch?.launch : undefined;
  const usingHostGame = hosting && hostGames.length > 0;
  const gameVersion = hostContext?.gameVersion || version?.version;
  const mismatch =
    !!gameVersion && !!s.gameVersion && gameVersion !== s.gameVersion;
  const locked =
    mp.busy || mp.loading || mp.inspecting || !desktop || preparing;
  const service = s.service || mp.service;
  const official = service === "official";
  const terracotta = service === "terracotta";
  const custom = service === "custom";
  const unsupported = terracotta && !!s.terracottaUnavailable;
  const canCreate =
    !locked &&
    !unsupported &&
    (terracotta || usingHostGame
      ? !!hostContext?.running
      : !!version && !!player);
  const needsTunnel = custom && hosting && mp.connectionMode === "tunnel";
  const componentsReady = terracotta
    ? s.terracottaReady
    : s.componentReady && (!needsTunnel || s.tunnelReady);
  const componentName = terracotta ? "Terracotta" : "EasyTier";
  const componentVersion = terracotta
    ? s.terracottaVersion
    : s.componentVersion;
  const primaryReady = terracotta ? s.terracottaReady : s.componentReady;
  const displayCode =
    official && s.inviteCode ? formatOfficialCode(s.inviteCode) : s.inviteCode;
  const scanning =
    s.terracottaPhase === "host-scanning" && s.state === "waiting";
  const phases: Record<string, string> = {
    "host-scanning": "正在查找已对局域网开放的世界",
    "host-starting": "正在创建陶瓦房间",
    "guest-connecting": "正在查找房主",
    "guest-starting": "正在连接房主世界",
  };
  const roomStatus =
    (s.state !== "leaving" && phases[s.terracottaPhase ?? ""]) ||
    labels[s.state];
  const showComponentNotice =
    !inSession &&
    (unsupported ||
      mp.loading ||
      mp.statusUnavailable ||
      !componentsReady ||
      s.state !== "idle" ||
      !!s.sessionId);
  const serviceContent = useTabContentTransition(
    official ? 0 : terracotta ? 1 : 2,
    !inSession,
  );
  const roomContent = useTabContentTransition(hosting ? 0 : 1, !inSession);
  const usingSharedNode = custom && mp.connectionMode === "shared";
  const hostVersion =
    hostContext &&
    app.versions.find(
      (item) =>
        item.id === hostContext.versionId &&
        (item.directory ?? settings.activeDir) === hostContext.directory,
    );
  const offlineLanTarget = usingHostGame
    ? hostContext && {
        id: hostContext.versionId,
        directory: hostContext.directory,
        loader: hostVersion?.loader,
        version: hostContext.gameVersion,
      }
    : version && {
        id: version.id,
        directory: version.directory ?? settings.activeDir,
        loader: version.loader,
        version: version.version,
      };
  async function copy(kind: "invitation" | "address") {
    await app.run(
      async () => {
        const value =
          kind === "invitation"
            ? await api<string>("multiplayer.invitation", {
                sessionId: s.sessionId,
              })
            : s.address;
        if (value)
          await navigator.clipboard.writeText(
            kind === "invitation" && official
              ? formatOfficialCode(value)
              : value,
          );
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
  const options = (
    <TerracottaOptions
      host={hosting}
      disabled={locked}
      room={mp.oldRoom}
      setRoom={mp.setOldRoom}
      nodes={mp.nodes}
      setNodes={mp.setNodes}
    />
  );
  function submitTerracotta() {
    if (hosting ? !canCreate : locked || unsupported) return;
    const code = hosting ? mp.oldRoom.trim() : mp.invitation.trim();
    if ((!hosting || code) && !hasTerracottaCode(code)) {
      app.reportError("陶瓦邀请码格式或校验位有误，请粘贴完整的 U/ 邀请码");
      return;
    }
    const publicNodes = mp.nodes
      .split(/\r?\n/)
      .map((v) => v.trim())
      .filter(Boolean);
    void mp.action(
      hosting ? "multiplayer.terracotta.create" : "multiplayer.terracotta.join",
      {
        ...(hosting
          ? {
              ...(code ? { room: code } : {}),
              launchId: hostLaunch?.id,
            }
          : { invitation: code }),
        publicNodes,
      },
    );
  }
  const notice = (
    <section
      className="multiplayer-notice panel has-surface"
      aria-label="联机状态"
    >
      <PixelFrame />
      <Network size={22} aria-hidden="true" />
      <div role="status">
        <strong>
          {mp.loading
            ? "读取联机状态…"
            : mp.statusUnavailable
              ? "联机状态暂不可用"
              : unsupported
                ? s.terracottaUnavailable
                : s.state === "idle"
                  ? componentsReady
                    ? "组件已就绪"
                    : "需要准备组件"
                  : labels[s.state]}
        </strong>
        {mp.loading && !mp.statusUnavailable && (
          <small>正在读取组件状态…</small>
        )}
        {!mp.loading && !mp.statusUnavailable && (
          <div className="multiplayer-component-list" aria-label="联机组件">
            <Badge
              className={primaryReady ? "completed" : "failed"}
              role="img"
              aria-label={`${componentName} ${componentVersion} · ${primaryReady ? "已就绪" : "待准备"}`}
            >
              {primaryReady ? (
                <Check size={12} aria-hidden="true" />
              ) : (
                <X size={12} aria-hidden="true" />
              )}
              {componentName} {componentVersion}
            </Badge>
            {needsTunnel && (
              <Badge
                className={s.tunnelReady ? "completed" : "failed"}
                role="img"
                aria-label={`Cloudflare Tunnel ${s.tunnelVersion} · ${s.tunnelReady ? "已就绪" : "待准备"}`}
              >
                {s.tunnelReady ? (
                  <Check size={12} aria-hidden="true" />
                ) : (
                  <X size={12} aria-hidden="true" />
                )}
                Cloudflare Tunnel {s.tunnelVersion}
              </Badge>
            )}
          </div>
        )}
      </div>
      {preparing ? (
        s.componentJobId && (
          <Button onClick={() => app.setPage("downloads")}>
            <Download size={16} />
            查看下载
          </Button>
        )
      ) : s.sessionId && !inSession ? (
        <Button
          disabled={locked || s.state === "leaving"}
          onClick={() =>
            void mp.action("multiplayer.leave", { sessionId: s.sessionId })
          }
        >
          <X size={16} />
          {s.role ? (hosting ? "关闭房间" : "离开房间") : "取消"}
        </Button>
      ) : !mp.loading && !componentsReady && !unsupported ? (
        <>
          <Button
            disabled={locked}
            onClick={() =>
              void mp.action(
                "multiplayer.prepare",
                terracotta ? { service } : { tunnel: needsTunnel },
              )
            }
          >
            <Download size={16} />
            准备组件
          </Button>
          <Button
            disabled={locked}
            onClick={() =>
              void app.run(async () => {
                const archive = await pick(
                  false,
                  terracotta ? ["gz"] : ["zip"],
                );
                if (archive)
                  await mp.action("multiplayer.prepare", {
                    archive,
                    ...(terracotta ? { service } : { tunnel: needsTunnel }),
                  });
              })
            }
          >
            <Upload size={16} />
            {terracotta ? "导入官方 tar.gz" : "导入组件"}
          </Button>
        </>
      ) : null}
      {mp.statusUnavailable && (
        <Button
          className="multiplayer-room-action"
          disabled={locked}
          onClick={() => void mp.refresh(true)}
        >
          <RefreshCw size={16} />
          刷新
        </Button>
      )}
    </section>
  );
  return (
    <div className="multiplayer-page">
      <PageHeader
        icon={<Network />}
        title="联机"
        eyebrow="PLAY TOGETHER"
        action={
          <div
            className="multiplayer-service-switch"
            data-collapsed={inSession}
            aria-hidden={inSession}
            inert={inSession}
          >
            <div className="multiplayer-service-switch-clip">
              <TabList
                id={`${id}-service`}
                label="联机服务"
                value={service}
                disabled={mp.busy || mp.loading || !desktop || !!s.sessionId}
                className="multiplayer-service-tabs"
                onValueChange={(value) =>
                  mp.changeService(value as MultiplayerService)
                }
                items={[
                  {
                    value: "official",
                    label: "SFMCL联机",
                    icon: <ShieldCheck size={17} />,
                  },
                  {
                    value: "terracotta",
                    label: "陶瓦联机",
                    icon: <Blocks size={17} />,
                  },
                  {
                    value: "custom",
                    label: "自定义",
                    icon: <SlidersHorizontal size={17} />,
                  },
                ]}
              />
            </div>
          </div>
        }
      />
      {showComponentNotice && notice}
      <TabPanel
        ref={serviceContent}
        id={`${id}-service`}
        value={service}
        className="multiplayer-layout multiplayer-service-panel"
      >
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
                <div className="multiplayer-session-meta">
                  <div className="multiplayer-world" role="status">
                    {s.worldOpen ? (
                      <Check size={16} aria-hidden="true" />
                    ) : (
                      <LoaderCircle
                        size={16}
                        className="spin"
                        aria-hidden="true"
                      />
                    )}
                    <strong>{roomStatus}</strong>
                  </div>
                  <Badge>
                    {s.gameVersion ||
                      `${terracotta ? "Terracotta " : "v"}${componentVersion}`}
                  </Badge>
                </div>
              </div>
              {scanning && (
                <p>请在目标世界中选择「对局域网开放」，启动器会继续查找。</p>
              )}
              {terracotta && !hosting && s.worldOpen && (
                <p>
                  在游戏的多人游戏列表中双击「陶瓦联机大厅」，或使用下方地址直连。
                </p>
              )}
              {!hosting && (!terracotta || s.address) && (
                <div className="multiplayer-address">
                  <small>连接地址</small>
                  <code>{s.address || "等待分配"}</code>
                  <Button
                    className="multiplayer-room-action"
                    disabled={!s.address || locked}
                    onClick={() => void copy("address")}
                  >
                    <Copy size={15} />
                    复制地址
                  </Button>
                </div>
              )}
              {hosting && (official || terracotta) && displayCode && (
                <div
                  className="multiplayer-official-code"
                  data-terracotta={terracotta || undefined}
                  aria-label={
                    terracotta ? "陶瓦房间邀请码" : "SFMCL联机房间邀请码"
                  }
                >
                  <div>
                    <small>邀请码</small>
                    <button
                      type="button"
                      className="multiplayer-invite-copy"
                      aria-label={`复制邀请码 ${displayCode}`}
                      disabled={locked || s.state === "leaving"}
                      onClick={() => void copy("invitation")}
                    >
                      <code>{displayCode}</code>
                    </button>
                  </div>
                  <Badge>{terracotta ? "陶瓦联机" : "SFMCL联机"}</Badge>
                </div>
              )}
              <div className="multiplayer-members-heading">
                <h3>
                  你的小伙伴 <span>{s.members.length}</span>
                </h3>
                <button
                  type="button"
                  className="multiplayer-members-refresh"
                  disabled={locked || s.state === "leaving"}
                  onClick={() => void mp.refresh(true)}
                  aria-label="刷新小伙伴列表"
                  title="刷新小伙伴列表"
                >
                  <RefreshCw size={16} aria-hidden="true" />
                </button>
              </div>
              <ul className="multiplayer-members" aria-label="你的小伙伴">
                {s.members.map((member) => (
                  <li key={member.id}>
                    <UserRound size={18} />
                    <div>
                      <strong>{member.name}</strong>
                      {member.ip && <small>{member.ip}</small>}
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
              <div className="multiplayer-submit multiplayer-session-actions">
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
                <Button
                  className="multiplayer-leave-action"
                  disabled={locked || s.state === "leaving"}
                  onClick={() =>
                    void mp.action("multiplayer.leave", {
                      sessionId: s.sessionId,
                    })
                  }
                >
                  <X size={16} />
                  {scanning ? "取消扫描" : hosting ? "关闭房间" : "离开房间"}
                </Button>
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
              <TabPanel
                ref={roomContent}
                id={id}
                value={hosting ? "create" : "join"}
              >
                {hosting ? (
                  <form
                    noValidate
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (terracotta) {
                        submitTerracotta();
                        return;
                      }
                      if (!canCreate) return;
                      if (!mp.roomName.trim()) {
                        app.reportError("请输入房间名称");
                        return;
                      }
                      if (!mp.validatePort()) return;
                      if (usingSharedNode && !mp.server.trim()) {
                        app.reportError("请输入 EasyTier 共享节点地址");
                        return;
                      }
                      void mp.action(
                        official
                          ? "multiplayer.official.create"
                          : "multiplayer.create",
                        {
                          name: mp.roomName,
                          port: Number(mp.port),
                          ...(usingSharedNode
                            ? { server: mp.server.trim() }
                            : {}),
                          ...(hostLaunch ? { launchId: hostLaunch.id } : {}),
                        },
                      );
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
                    {!terracotta && usingHostGame && !hostContext?.running && (
                      <p className="multiplayer-host-hint" role="status">
                        {!hostContext
                          ? "检测到多个游戏，请选择用于创建房间的游戏。"
                          : "游戏还在启动，请进入世界并对局域网开放后创建房间。"}
                      </p>
                    )}
                    {terracotta ? (
                      <>
                        <ErrorBanner
                          message="请先启动游戏进入存档并开启局域网后，才能创建房间。若同时运行多个游戏，只对目标世界开放。"
                          tone="info"
                          compact
                        />
                        {options}
                      </>
                    ) : (
                      <>
                        <div className="multiplayer-field">
                          <label htmlFor={`${id}-name`}>房间名称</label>
                          <Input
                            id={`${id}-name`}
                            required
                            disabled={preparing}
                            value={mp.roomName}
                            onChange={(event) =>
                              mp.setRoomName(event.target.value)
                            }
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
                              disabled={preparing || mp.checkingPort}
                              pattern="[0-9]{1,5}"
                              inputMode="numeric"
                              maxLength={5}
                              placeholder="游戏中显示的端口"
                              autoComplete="off"
                            />
                            <Button
                              disabled={locked || mp.checkingPort}
                              onClick={() => void mp.checkPort()}
                            >
                              {mp.checkingPort ? (
                                <LoaderCircle size={16} className="spin" />
                              ) : (
                                <Network size={16} />
                              )}
                              {mp.checkingPort ? "检查中…" : "检查端口"}
                            </Button>
                          </div>
                        </div>
                      </>
                    )}
                    {custom && (
                      <div className="multiplayer-field">
                        <label htmlFor={`${id}-connection-mode`}>
                          联机方式
                        </label>
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
                                onChange={(event) =>
                                  mp.setServer(event.target.value)
                                }
                                maxLength={300}
                                placeholder="tcp://、udp:// 或 wss:// 地址"
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
                            onValueChange={(value) =>
                              mp.setConnectionMode(value as "tunnel" | "shared")
                            }
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
                            ? "支持 tcp://主机:端口、udp://主机:端口 或 wss://主机[:端口]（默认 443），使用指定的 EasyTier 共享节点。"
                            : "自动创建 Cloudflare Tunnel，连接本机 EasyTier 节点。"}
                        </small>
                      </div>
                    )}
                    <div className="multiplayer-submit">
                      <Button
                        type="submit"
                        className="multiplayer-room-action"
                        primary
                        disabled={!canCreate}
                      >
                        {mp.busy ? (
                          <LoaderCircle size={17} className="spin" />
                        ) : (
                          <Plus size={17} />
                        )}
                        {mp.busy ? "创建中…" : "创建房间"}
                      </Button>
                      <MultiplayerOfflineLan
                        key={JSON.stringify(offlineLanTarget)}
                        version={offlineLanTarget}
                        disabled={
                          locked ||
                          unsupported ||
                          (usingHostGame && !hostContext) ||
                          ((official || terracotta) && !offlineLanTarget)
                        }
                      />
                    </div>
                  </form>
                ) : terracotta ? (
                  <form
                    noValidate
                    onSubmit={(event) => {
                      event.preventDefault();
                      submitTerracotta();
                    }}
                  >
                    <div className="multiplayer-field">
                      <label htmlFor={id + "-terracotta-code"}>
                        陶瓦邀请码
                      </label>
                      <Input
                        id={id + "-terracotta-code"}
                        value={mp.invitation}
                        disabled={locked || unsupported}
                        onChange={(e) => mp.changeInvitation(e.target.value)}
                        maxLength={4096}
                        spellCheck={false}
                        autoComplete="off"
                        aria-invalid={
                          !!mp.invitation && !hasTerracottaCode(mp.invitation)
                        }
                        placeholder="U/XXXX-XXXX-XXXX-XXXX"
                      />
                    </div>
                    {options}
                    <div className="multiplayer-submit">
                      <Button
                        primary
                        type="submit"
                        disabled={
                          locked || unsupported || !mp.invitation.trim()
                        }
                      >
                        <DoorOpen size={17} />
                        加入房间
                      </Button>
                    </div>
                  </form>
                ) : (
                  <div>
                    <div className="multiplayer-field">
                      <label htmlFor={`${id}-invitation`}>
                        {official ? "邀请码" : "联机邀请码"}
                      </label>
                      {official ? (
                        <MultiplayerInviteInput
                          id={`${id}-invitation`}
                          value={mp.invitation}
                          disabled={preparing || mp.busy}
                          onValueChange={mp.changeInvitation}
                          onSubmit={() => {
                            if (!locked && mp.invitation.trim()) {
                              if (mp.preview && player)
                                void mp.action("multiplayer.official.join", {
                                  invitation: mp.invitation,
                                });
                              else void mp.inspect();
                            }
                          }}
                        />
                      ) : (
                        <Textarea
                          id={`${id}-invitation`}
                          value={mp.invitation}
                          disabled={preparing}
                          onChange={(event) =>
                            mp.changeInvitation(event.target.value)
                          }
                          rows={3}
                          maxLength={4096}
                          placeholder="粘贴完整邀请码"
                          spellCheck={false}
                          autoComplete="off"
                        />
                      )}
                      {!official && (
                        <small id={`${id}-invite-help`}>
                          粘贴共享节点或 Cloudflare 模式生成的完整长邀请码。
                        </small>
                      )}
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
                          className="multiplayer-room-action"
                          primary
                          disabled={locked || !player}
                          onClick={() =>
                            void mp.action(
                              official
                                ? "multiplayer.official.join"
                                : "multiplayer.join",
                              {
                                invitation: mp.invitation,
                              },
                            )
                          }
                        >
                          {mp.busy ? (
                            <LoaderCircle size={17} className="spin" />
                          ) : (
                            <DoorOpen size={17} />
                          )}
                          {mp.busy ? "加入中…" : "加入房间"}
                        </Button>
                      ) : (
                        <Button
                          className="multiplayer-room-action"
                          primary
                          disabled={locked || !mp.invitation.trim()}
                          onClick={() => void mp.inspect()}
                        >
                          {mp.inspecting ? (
                            <LoaderCircle size={17} className="spin" />
                          ) : (
                            <ArrowRight size={17} />
                          )}
                          {mp.inspecting ? "查询中…" : "查看房间"}
                        </Button>
                      )}
                    </div>
                  </div>
                )}
              </TabPanel>
            </>
          )}
        </section>
      </TabPanel>
    </div>
  );
}

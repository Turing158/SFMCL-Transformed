import { useEffect, useId, useRef, useState } from "react";
import {
  ArrowRight,
  Download,
  FolderOpen,
  RefreshCw,
  RotateCcw,
  X,
} from "lucide-react";
import { api, confirmAction, pick } from "../api";
import {
  Badge,
  Button,
  ErrorBanner,
  PixelFrame,
  TabList,
  TabPanel,
} from "../components";
import { Checkbox, Input, Select } from "../controls";
import { LoadingState } from "../LoadingState";
import { PageHeader } from "../PageHeader";
import { useApp } from "../store";
import { useTaskSelector } from "../tasks";
import type { Version } from "../types";
import type { ModpackInspection } from "../modpacks";
import { modpackName, modpackNameError } from "../modpacks";
import {
  unresolvedConflicts,
  updateActions,
  type UpdateDiscovery,
  type UpdateInfo,
  type UpdatePlan,
} from "../modpackUpdate";
import { useTabContentTransition } from "../useTabContentTransition";
import "../modpack-export.css";
import "../modpack-update.css";

export function ModpackUpdatePage({ version }: { version: Version }) {
  const app = useApp();
  const target = useRef({
    id: version.id,
    directory: version.directory ?? app.data.settings.activeDir,
  }).current;
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [busy, setBusy] = useState("查找在线整合包");
  const [error, setError] = useState("");
  const [mode, setMode] = useState<"detecting" | "online" | "local">(
    "detecting",
  );
  const [discovery, setDiscovery] = useState<UpdateDiscovery | null>(null);
  const [notice, setNotice] = useState("");
  const attempt = useRef(0);
  const [local, setLocal] = useState<{
    path: string;
    inspection: ModpackInspection;
  } | null>(null);
  const [original, setOriginal] = useState<{
    path: string;
    inspection: ModpackInspection;
  } | null>(null);
  const [optional, setOptional] = useState(false);
  const [originalOptional, setOriginalOptional] = useState(false);
  const [step, setStep] = useState("review");
  const [plan, setPlan] = useState<UpdatePlan | null>(null);
  const [decisions, setDecisions] = useState<Record<string, string>>({});
  const [separate, setSeparate] = useState(false);
  const [newName, setNewName] = useState("");
  const [query, setQuery] = useState("");
  const [checkJob, setCheckJob] = useState("");
  const [applyJob, setApplyJob] = useState("");
  const [success, setSuccess] = useState("");
  const tabsId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const alive = useRef(true);
  const checkRef = useRef("");
  checkRef.current = checkJob;
  const planRef = useRef("");
  planRef.current = plan?.token ?? "";
  const job = useTaskSelector((tasks) =>
    tasks.jobs.find((job) => job.id === (applyJob || checkJob)),
  );
  const running =
    !!(checkJob || applyJob) &&
    (!job || !["completed", "cancelled", "failed"].includes(job.status));
  const locked = !!busy || running;
  const animation = useTabContentTransition(
    ["source", "review", "confirm"].indexOf(step),
    true,
    { duration: 320, distance: 24, initialOpacity: 0 },
  );
  const conflicts = plan ? unresolvedConflicts(plan, decisions) : 0;
  async function loadInfo() {
    const value = await api<UpdateInfo>("modpacks.update.info", target);
    if (alive.current) setInfo(value);
    return value;
  }
  function active(ticket: number) {
    return alive.current && attempt.current === ticket;
  }
  async function findOnline(ticket: number) {
    invalidate();
    setBusy("查找在线整合包");
    setMode("detecting");
    setStep("review");
    setNotice("");
    setError("");
    setDiscovery(null);
    try {
      const value = await api<UpdateInfo>("modpacks.update.info", target);
      if (!active(ticket)) return;
      setInfo(value);
      setOptional(value.record?.includeOptional ?? false);
      if (
        value.backups.some((backup) =>
          ["applying", "recovery_failed"].includes(backup.state),
        )
      ) {
        setMode("local");
        setStep("source");
        setNotice("请先恢复未完成的更新，再重新检查在线版本。");
        return;
      }
      let found: UpdateDiscovery;
      try {
        found = await api<UpdateDiscovery>("modpacks.update.discover", target);
      } catch {
        if (active(ticket)) {
          setMode("local");
          setStep("source");
          setNotice("在线查询暂时不可用，已进入本地更新；可重新检查在线版本。");
        }
        return;
      }
      if (!active(ticket)) return;
      setDiscovery(found);
      setNotice(found.message);
      if (found.status === "local") {
        setMode("local");
        setStep("source");
        return;
      }
      setMode("online");
      setStep("review");
      if (!found.targetOrigin) return;
      setBusy("检查在线新版文件变化");
      const id = await api<string>("modpacks.update.prepare", {
        ...target,
        origin: found.targetOrigin,
        ...(!value.record ? { currentOrigin: found.currentOrigin } : {}),
        includeOptional: found.includeOptional,
        currentIncludeOptional: value.record?.includeOptional ?? false,
        inferOptional: found.inferOptional,
      });
      if (active(ticket)) setCheckJob(id);
      else void api("jobs.cancel", { id }).catch(() => {});
    } catch (error) {
      if (active(ticket)) {
        setError(String(error));
        setMode("local");
        setStep("source");
      }
    } finally {
      if (active(ticket)) setBusy("");
    }
  }
  useEffect(() => {
    alive.current = true;
    heading.current?.focus({ preventScroll: true });
    void findOnline(++attempt.current);
    return () => {
      alive.current = false;
      ++attempt.current;
      const check = checkRef.current;
      const token = planRef.current;
      if (check) void api("jobs.cancel", { id: check }).catch(() => {});
      if (token) void api("modpacks.update.discard", { token }).catch(() => {});
    };
  }, []);
  useEffect(() => {
    if (!job || !["completed", "failed", "cancelled"].includes(job.status))
      return;
    let active = true;
    if (applyJob) {
      void loadInfo().catch((error) => setError(String(error)));
      if (job.status === "completed") {
        setSuccess("整合包更新完成");
        void Promise.all([app.refresh(), loadInfo()]).catch((error) =>
          setError(String(error)),
        );
      } else
        setError(
          job.error ??
            (job.status === "cancelled"
              ? "更新已取消，已提交的变更将恢复。"
              : "更新失败，请查看下载中心和恢复记录。"),
        );
      setApplyJob("");
    } else if (checkJob) {
      const token = checkJob;
      if (job.status === "completed") {
        setBusy("读取文件变化");
        void api<UpdatePlan>("modpacks.update.plan", { token })
          .then((value) => {
            if (!active) {
              void api("modpacks.update.discard", { token }).catch(() => {});
              return;
            }
            setPlan(value);
            setDecisions({});
            setSeparate(value.baselineMissing);
            setNewName(modpackName(value.target.name, value.target.version));
            setStep("review");
          })
          .catch((error) => {
            if (active) setError(String(error));
          })
          .finally(() => {
            if (active) {
              setCheckJob("");
              setBusy("");
            }
          });
      } else {
        setError(job.error ?? "更新检查已取消");
        setCheckJob("");
      }
    }
    return () => {
      active = false;
    };
  }, [job?.id, job?.status, checkJob, applyJob]);
  async function run(label: string, action: () => Promise<void>) {
    setBusy(label);
    setError("");
    setSuccess("");
    try {
      await action();
    } catch (error) {
      if (alive.current) setError(String(error));
    } finally {
      if (alive.current) setBusy("");
    }
  }
  function invalidate() {
    if (plan)
      void api("modpacks.update.discard", { token: plan.token }).catch(
        () => {},
      );
    setPlan(null);
    setDecisions({});
    setSuccess("");
  }
  async function choose(old: boolean) {
    const path = await pick(false, ["mrpack", "zip"], {
      title: old ? "选择当前版本原始包" : "选择新版整合包",
      filterName: "整合包",
    });
    if (!path) return;
    const inspection = await api<ModpackInspection>("modpacks.inspect", {
      path,
    });
    await api("modpacks.discard", { token: inspection.token });
    if (!["Modrinth", "CurseForge"].includes(inspection.format))
      throw new Error("请选择 Modrinth 或 CurseForge 整合包");
    if (alive.current) {
      invalidate();
      (old ? setOriginal : setLocal)({ path, inspection });
    }
  }
  async function check() {
    invalidate();
    const inspected: string[] = [];
    try {
      const next =
        mode === "local" && local
          ? await api<ModpackInspection>("modpacks.inspect", {
              path: local.path,
            })
          : null;
      if (next) inspected.push(next.token);
      const old = original
        ? await api<ModpackInspection>("modpacks.inspect", {
            path: original.path,
          })
        : null;
      if (old) inspected.push(old.token);
      const id = await api<string>("modpacks.update.prepare", {
        ...target,
        token: next?.token,
        ...(old ? { currentToken: old.token } : {}),
        includeOptional: optional,
        currentIncludeOptional: originalOptional,
      });
      if (alive.current) setCheckJob(id);
      else void api("jobs.cancel", { id }).catch(() => {});
    } catch (error) {
      await Promise.all(
        inspected.map((token) =>
          api("modpacks.discard", { token }).catch(() => {}),
        ),
      );
      throw error;
    }
  }
  const canCheck = !!info && mode === "local" && !!local;
  const pendingRecovery = info?.backups.some((backup) =>
    ["applying", "recovery_failed"].includes(backup.state),
  );
  return (
    <div className="modpack-update-page">
      <PageHeader
        title="更新整合包"
        eyebrow="MODPACK UPDATE"
        icon={<RefreshCw />}
        headingRef={heading}
      />
      <ErrorBanner message={error} />
      <ErrorBanner message={success} tone="info" compact />
      {info && (
        <section className="export-source has-surface">
          <PixelFrame />
          <div>
            <strong>
              {info.record?.name ?? info.current?.name ?? version.id}
            </strong>
            <Badge>
              {info.record?.version ?? info.current?.version ?? "当前版本"}
            </Badge>
            <span>
              Minecraft {info.record?.minecraft ?? version.version} ·{" "}
              {version.loader}
            </span>
          </div>
          <p className="path-text">{version.path}</p>
        </section>
      )}
      {mode !== "detecting" && (
        <div className="update-route">
          <strong>{mode === "online" ? "在线更新" : "本地更新"}</strong>
          <div className="update-buttons">
            <Button
              disabled={locked || !!pendingRecovery}
              onClick={() => void findOnline(++attempt.current)}
            >
              <RefreshCw size={16} />
              重新检查在线版本
            </Button>
            {mode === "online" && (
              <Button
                disabled={locked}
                onClick={() => {
                  ++attempt.current;
                  invalidate();
                  setMode("local");
                  setStep("source");
                  setNotice("");
                }}
              >
                <FolderOpen size={16} />
                从本地包更新
              </Button>
            )}
          </div>
        </div>
      )}
      <ErrorBanner
        message={mode === "online" && discovery?.status === "upToDate" ? "" : notice}
        tone="info"
        compact
      />
      <LoadingState
        loading={!!busy || (mode === "online" && !!checkJob && running)}
        label={busy || (checkJob ? "检查在线新版文件变化" : "正在准备")}
      >
        {mode !== "detecting" &&
          !(mode === "online" && discovery?.status === "upToDate") && (
            <TabList
              id={tabsId}
              label={
                mode === "online" ? "在线整合包更新步骤" : "本地整合包更新步骤"
              }
              value={step}
              disabled={locked}
              className="export-stages"
              separator={<ArrowRight size={16} />}
              onValueChange={(value) => {
                if (value === "source" || plan) setStep(value);
              }}
              items={
                mode === "online"
                  ? [
                      { value: "review", label: "1 检查变化" },
                      { value: "confirm", label: "2 确认更新" },
                    ]
                  : [
                      { value: "source", label: "1 选择新版" },
                      { value: "review", label: "2 检查变化" },
                      { value: "confirm", label: "3 确认更新" },
                    ]
              }
            />
          )}
        <TabPanel
          ref={animation}
          id={tabsId}
          value={step}
          className="export-stage-content"
        >
          {mode === "online" && discovery?.status === "upToDate" ? (
            <section className="export-panel has-surface update-section">
              <PixelFrame />
              <h2>当前已是最新正式版本</h2>
              <p>{discovery.current?.version}</p>
            </section>
          ) : step === "source" ? (
            <section className="export-panel has-surface update-section">
              <PixelFrame />
              <h2>选择目标整合包版本</h2>
              <div className="update-fields">
                <div className="update-wide">
                  <Button
                    disabled={locked}
                    onClick={() =>
                      void run("识别新版整合包", () => choose(false))
                    }
                  >
                    <FolderOpen size={16} />
                    选择新版整合包
                  </Button>
                  {local && (
                    <p className="path-text">
                      {local.path}
                      <br />
                      {local.inspection.name} {local.inspection.version} ·
                      Minecraft {local.inspection.minecraft}
                    </p>
                  )}
                </div>
                <label className="update-check update-wide">
                  <Checkbox
                    checked={optional}
                    disabled={locked}
                    onChange={(event) => {
                      setOptional(event.target.checked);
                      invalidate();
                    }}
                  />
                  安装新版可选内容
                </label>
                {!info?.record && (
                  <div className="update-wide update-original">
                    <ErrorBanner
                      message="此实例没有旧文件清单。可提供当前版本原始包恢复清单；也可另存新实例并迁移个人数据。"
                      tone="info"
                      compact
                    />
                    <Button
                      disabled={locked}
                      onClick={() =>
                        void run("识别当前版本原始包", () => choose(true))
                      }
                    >
                      <FolderOpen size={16} />
                      选择当前版本原始包
                    </Button>
                    {original && (
                      <>
                        <p className="path-text">{original.path}</p>
                        <Button
                          disabled={locked}
                          onClick={() => {
                            setOriginal(null);
                            invalidate();
                          }}
                        >
                          清除原始包
                        </Button>
                      </>
                    )}
                    <label className="update-check">
                      <Checkbox
                        checked={originalOptional}
                        disabled={locked}
                        onChange={(event) => {
                          setOriginalOptional(event.target.checked);
                          invalidate();
                        }}
                      />
                      当前版本原先安装了可选内容
                    </label>
                  </div>
                )}
              </div>
              <Button
                primary
                disabled={locked || !canCheck || !!pendingRecovery}
                onClick={() => void run("准备更新检查", check)}
              >
                <RefreshCw size={16} />
                检查文件变化
              </Button>
            </section>
          ) : plan ? (
            <section className="export-panel has-surface update-section">
              <PixelFrame />
              <h2>{step === "review" ? "检查更新内容" : "确认更新"}</h2>
              <div className="update-comparison">
                <span>
                  {plan.current.version || "当前版本"}
                  <br />
                  Minecraft {plan.current.minecraft}
                </span>
                <ArrowRight size={20} />
                <strong>
                  {plan.target.version}
                  <br />
                  Minecraft {plan.target.minecraft} ·{" "}
                  {plan.target.loader
                    ? plan.target.loader.kind + " " + plan.target.loader.version
                    : "Vanilla"}
                </strong>
              </div>
              <ErrorBanner
                message={plan.warnings.join("\n")}
                tone="info"
                compact
              />
              {step === "review" ? (
                <>
                  <div className="update-summary" role="status">
                    {["add", "replace", "remove", "keep"].map((action) => (
                      <Badge key={action}>
                        {updateActions[action]}{" "}
                        {
                          plan.items.filter((item) => item.action === action)
                            .length
                        }
                      </Badge>
                    ))}
                    <Badge>
                      未处理冲突 {plan.baselineMissing ? 0 : conflicts}
                    </Badge>
                  </div>
                  <Input
                    aria-label="搜索更新文件"
                    placeholder="搜索文件路径"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                  <div className="update-file-list">
                    {plan.items
                      .filter((item) =>
                        item.path.toLowerCase().includes(query.toLowerCase()),
                      )
                      .map((item) => (
                        <div
                          key={item.path}
                          className="update-file"
                          data-conflict={item.conflict}
                        >
                          <div>
                            <strong>{item.path}</strong>
                            <small>
                              {item.reason}
                              {item.localPath !== item.path
                                ? " · 保持禁用"
                                : ""}
                            </small>
                          </div>
                          {item.conflict && !plan.baselineMissing ? (
                            <label>
                              处理方式
                              <Select
                                aria-label={"处理 " + item.path}
                                value={decisions[item.path] ?? ""}
                                disabled={locked}
                                onValueChange={(value) =>
                                  setDecisions((current) => ({
                                    ...current,
                                    [item.path]: value,
                                  }))
                                }
                              >
                                <option value="">请选择</option>
                                <option value="keep">保留本地</option>
                                <option value="replace">
                                  采用新版（含作者删除）
                                </option>
                              </Select>
                            </label>
                          ) : (
                            <Badge>
                              {plan.baselineMissing
                                ? "使用新版"
                                : updateActions[item.action]}
                            </Badge>
                          )}
                        </div>
                      ))}
                  </div>
                  <Button
                    primary
                    disabled={locked}
                    onClick={() => setStep("confirm")}
                  >
                    下一步
                    <ArrowRight size={16} />
                  </Button>
                </>
              ) : (
                <>
                  <label className="update-check">
                    <Checkbox
                      checked={separate}
                      disabled={locked || plan.baselineMissing}
                      onChange={(event) => setSeparate(event.target.checked)}
                    />
                    另存新实例
                  </label>
                  {separate && (
                    <label className="field">
                      新实例名称
                      <Input
                        value={newName}
                        disabled={locked}
                        onChange={(event) => setNewName(event.target.value)}
                      />
                    </label>
                  )}
                  {separate && modpackNameError(newName) && (
                    <p className="helper">{modpackNameError(newName)}</p>
                  )}
                  {separate && plan.baselineMissing && (
                    <p className="helper">
                      迁移存档、截图、个人选项和启动器设置；缺少清单时，旧模组与配置保留在原实例。
                    </p>
                  )}
                  {!plan.baselineMissing && conflicts > 0 && (
                    <p className="helper" role="status">
                      还有 {conflicts} 个文件冲突需要处理。
                    </p>
                  )}
                  <p className="helper">
                    {separate
                      ? "新实例安装完成后，原实例仍可使用。"
                      : "替换和删除的文件会保留备份。跨 Minecraft 版本时额外备份存档。"}
                  </p>
                  <div className="update-buttons">
                    <Button disabled={locked} onClick={() => setStep("review")}>
                      返回检查
                    </Button>
                    <Button
                      primary
                      disabled={
                        locked ||
                        (!plan.baselineMissing && conflicts > 0) ||
                        (separate &&
                          (!!modpackNameError(newName) ||
                            newName.toLowerCase() === version.id.toLowerCase()))
                      }
                      onClick={() =>
                        void run("提交更新任务", async () => {
                          const id = await api<string>(
                            "modpacks.update.start",
                            {
                              ...target,
                              token: plan.token,
                              decisions,
                              ...(separate ? { newName } : {}),
                            },
                          );
                          setApplyJob(id);
                          setPlan(null);
                        })
                      }
                    >
                      <Download size={16} />
                      开始更新
                    </Button>
                  </div>
                </>
              )}
            </section>
          ) : (
            <p className="helper">
              {mode === "online"
                ? "可重新检查在线版本，或选择从本地包更新。"
                : "请先选择新版并检查文件变化。"}
            </p>
          )}
        </TabPanel>
      </LoadingState>
      {running && (
        <section className="export-panel has-surface update-section">
          <PixelFrame />
          <h2>{applyJob ? "正在更新整合包" : "正在检查更新"}</h2>
          <p role="status">
            {job?.steps[job.currentStep]?.detail ?? "正在准备任务…"}
          </p>
          <div className="update-buttons">
            <Button onClick={() => app.setPage("downloads")}>
              查看下载中心
            </Button>
            <Button
              onClick={() =>
                void run("取消任务", async () => {
                  await api("jobs.cancel", { id: applyJob || checkJob });
                })
              }
            >
              <X size={16} />
              取消任务
            </Button>
          </div>
        </section>
      )}
      {!!info?.backups.length && (
        <section className="export-panel has-surface update-section">
          <PixelFrame />
          <h2>更新备份与恢复</h2>
          {pendingRecovery && (
            <ErrorBanner message="检测到未完成的更新，请先恢复。恢复完成前，此版本无法启动或继续更新。" />
          )}
          {info.backups.map((backup) => (
            <div className="update-backup" key={backup.id}>
              <div>
                <strong>
                  {backup.state === "completed"
                    ? "更新前备份"
                    : ["applying", "recovery_failed"].includes(backup.state)
                      ? "更新中断，待恢复"
                      : "已恢复"}
                </strong>
                <p className="path-text">{backup.path}</p>
                {backup.savesBackup && (
                  <small>包含更新前存档副本；存档副本保留在备份目录。</small>
                )}
              </div>
              <Button
                disabled={
                  locked ||
                  !["completed", "applying", "recovery_failed"].includes(
                    backup.state,
                  )
                }
                onClick={() =>
                  void run("恢复更新前文件", async () => {
                    if (
                      !(await confirmAction(
                        "恢复此次更新前的整合包文件？更新后自行修改的文件会阻止自动恢复；当前存档保持原状，存档副本保留在备份目录。",
                      ))
                    )
                      return;
                    await api("modpacks.update.restore", {
                      ...target,
                      backupId: backup.id,
                    });
                    invalidate();
                    await app.refresh();
                    await loadInfo();
                    setSuccess("已恢复更新前的整合包文件");
                  })
                }
              >
                <RotateCcw size={16} />
                恢复
              </Button>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

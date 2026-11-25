import {
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ChevronDown,
  ChevronRight,
  FileArchive,
  FileJson,
  FolderOpen,
  Package,
  RefreshCw,
  Save,
  X,
} from "lucide-react";
import { api, bytes, saveFile } from "../api";
import { Badge, Button, ErrorBanner, PixelFrame, Steps } from "../components";
import { Checkbox, Input, Textarea } from "../controls";
import { LoadingState } from "../LoadingState";
import { PageHeader } from "../PageHeader";
import { useApp } from "../store";
import { useTaskSelector } from "../tasks";
import type { Version } from "../types";
import { useTabContentTransition } from "../useTabContentTransition";
import { ExportBackButton, ExportStageTabs } from "./ModpackExportNavigation";
import {
  exportFileName,
  exportFormats,
  initialExportDraft,
  selectExportFiles,
  type ExportDraft,
  type ExportFile,
  type ExportInspection,
  type ExportPlan,
} from "../modpackExport";
import "../modpack-export.css";

export function ModpackExportPage({ version }: { version: Version }) {
  const app = useApp();
  const target = useRef({
    id: version.id,
    directory: version.directory ?? app.data.settings.activeDir,
  }).current;
  const [inspection, setInspection] = useState<ExportInspection | null>(null);
  const [draft, setDraft] = useState<ExportDraft | null>(null);
  const [step, setStep] = useState(0);
  const tabsId = useId();
  const tabContent = useTabContentTransition(step, true, {
    duration: 320,
    distance: 24,
    initialOpacity: 0,
  });
  const [busy, setBusy] = useState("scan");
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [plan, setPlan] = useState<ExportPlan | null>(null);
  const [planSignature, setPlanSignature] = useState("");
  const [jobId, setJobId] = useState("");
  const [output, setOutput] = useState("");
  const [query, setQuery] = useState("");
  const [onlySelected, setOnlySelected] = useState(false);
  const [savedSignature, setSavedSignature] = useState("");
  const [scanNeeded, setScanNeeded] = useState(false);
  const generation = useRef(0);
  const previousDraft = useRef<ExportDraft | null>(null);
  previousDraft.current = draft;
  const deferredQuery = useDeferredValue(query);
  const heading = useRef<HTMLHeadingElement>(null);
  const job = useTaskSelector((tasks) =>
    tasks.jobs.find((value) => value.id === jobId),
  );
  const running =
    !!jobId && (!job || job.status === "running" || job.status === "queued");
  const locked = !!busy || running;
  const signature = draft ? JSON.stringify(draft) : "";
  const currentPlan = !!plan && signature === planSignature && !scanNeeded;
  const selected = useMemo(() => new Set(draft?.paths ?? []), [draft?.paths]);
  const groups = useMemo(() => {
    const groups = new Map<string, ExportFile[]>();
    for (const file of inspection?.files ?? []) {
      if (onlySelected && !selected.has(file.path)) continue;
      if (
        deferredQuery &&
        !file.path.toLowerCase().includes(deferredQuery.toLowerCase())
      )
        continue;
      const name = exportGroupName(file.path);
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name)!.push(file);
    }
    return [...groups];
  }, [inspection, deferredQuery, selected, onlySelected]);
  const planGroups = useMemo(() => {
    const groups = new Map<string, ExportPlan["items"]>();
    for (const item of plan?.items ?? []) {
      const name = exportGroupName(item.path);
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name)!.push(item);
    }
    return [...groups];
  }, [plan]);
  const selectionSize = useMemo(
    () =>
      inspection?.files.reduce(
        (sum, file) => sum + (selected.has(file.path) ? file.size : 0),
        0,
      ) ?? 0,
    [inspection, selected],
  );

  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    const run = ++generation.current;
    let token = "";
    let active = true;
    setBusy("scan");
    setError("");
    setPlan(null);
    setPlanSignature("");
    setScanNeeded(false);
    void api<ExportInspection>("modpacks.export.inspect", target)
      .then((value) => {
        token = value.token;
        if (!active) {
          void api("modpacks.export.discard", { token }).catch(() => {});
          return;
        }
        // Preserve unsaved choices when a source change requires a rescan.
        const source = previousDraft.current
          ? { ...value, draft: previousDraft.current }
          : value;
        setInspection(value);
        const next = initialExportDraft(source, version.id);
        setDraft(next);
        if (value.draft && !previousDraft.current)
          setSavedSignature(JSON.stringify(next));
      })
      .catch((reason) => {
        if (active) {
          setError(String(reason));
          setScanNeeded(true);
        }
      })
      .finally(() => {
        if (active && generation.current === run) setBusy("");
      });
    return () => {
      active = false;
      generation.current++;
      if (token) void api("modpacks.export.discard", { token }).catch(() => {});
    };
  }, [target, version.id, revision]);

  async function saveDraft() {
    if (!draft) return;
    setBusy("draft");
    setError("");
    try {
      await api("modpacks.export.saveDraft", { ...target, draft });
      setSavedSignature(signature);
      app.notify("整合包制作配置已保存");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy("");
    }
  }
  async function inspectPlan() {
    if (
      !inspection ||
      !draft ||
      busy ||
      running ||
      scanNeeded ||
      !draft.options.name.trim() ||
      !draft.options.version.trim()
    )
      return;
    const run = generation.current;
    setJobId("");
    setOutput("");
    setStep(2);
    setBusy("plan");
    setPlanSignature("");
    setError("");
    try {
      const value = await api<ExportPlan>("modpacks.export.plan", {
        ...target,
        inspectionToken: inspection.token,
        ...draft,
      });
      if (generation.current !== run) return;
      setPlan(value);
      setPlanSignature(signature);
    } catch (reason) {
      if (generation.current !== run) return;
      setError(String(reason));
      if (/变化|失效|重新扫描/.test(String(reason))) setScanNeeded(true);
    } finally {
      if (generation.current === run) setBusy("");
    }
  }
  async function cancelInspection() {
    generation.current++;
    if (inspection)
      await api("modpacks.export.discard", { token: inspection.token }).catch(
        (reason) => setError(String(reason)),
      );
    setBusy("");
    setScanNeeded(true);
    setPlan(null);
  }
  async function startExport() {
    if (!draft || !plan?.token || !currentPlan) return;
    setBusy("save");
    setError("");
    try {
      const format = exportFormats[draft.format];
      const destination = await saveFile({
        title: "保存整合包",
        defaultPath: exportFileName(draft),
        filterName: `${format.name} 整合包`,
        extensions: [format.extension],
      });
      if (!destination) return;
      await api("modpacks.export.saveDraft", { ...target, draft });
      setSavedSignature(signature);
      // The native save dialog already asks before replacing an existing file.
      const id = await api<string>("modpacks.export.start", {
        ...target,
        token: plan.token,
        destination,
        overwrite: true,
      });
      setJobId(id);
      setOutput(destination);
      setStep(3);
      setPlanSignature("");
      app.notify("整合包导出已开始");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy("");
    }
  }
  const updateFiles = (paths: string[], checked: boolean) =>
    setDraft((value) => value && selectExportFiles(value, paths, checked));
  const ready = !!draft?.options.name.trim() && !!draft?.options.version.trim();
  function navigateStep(next: number) {
    if (locked || next === step) return;
    if (next === 2 && ready && !currentPlan && !scanNeeded) {
      void inspectPlan();
    } else {
      setStep(next);
    }
  }
  return (
    <div className="modpack-export-page">
      <PageHeader
        icon={<Package />}
        eyebrow="MODPACK EXPORT"
        title="制作整合包"
        description={version.id}
        headingRef={heading}
        action={
          <Button
            className="export-draft-action"
            disabled={locked || !draft || !ready}
            onClick={() => void saveDraft()}
          >
            <Save size={16} />
            {signature === savedSignature ? "配置已保存" : "保存制作配置"}
          </Button>
        }
      />
      {inspection && draft && (
        <section
          className="panel export-source has-surface"
          aria-label="整合包来源"
        >
          <PixelFrame />
          <div>
            <strong>Minecraft {inspection.minecraft}</strong>
            <span>
              {inspection.loader
                ? `${inspection.loader.kind} ${inspection.loader.version}`
                : "原版"}
            </span>
            <Badge>{inspection.shared ? "共享游戏目录" : "独立游戏目录"}</Badge>
          </div>
          <p className="path-text">{inspection.gameDirectory}</p>
          {inspection.warnings.map((warning) => (
            <p className="helper" key={warning}>
              {warning}
            </p>
          ))}
        </section>
      )}
      <ExportStageTabs
        id={tabsId}
        step={step}
        disabled={locked || !inspection}
        onChange={navigateStep}
      />
      {error && (
        <div className="inline-error export-error" role="alert">
          {error}
          <Button
            disabled={locked}
            onClick={() => {
              setError("");
              setRevision((value) => value + 1);
            }}
          >
            重新扫描
          </Button>
        </div>
      )}
      <LoadingState loading={busy === "scan"} label="正在扫描游戏目录…">
        {!inspection || !draft ? (
          <p className="helper">读取失败时可以重新扫描游戏目录。</p>
        ) : (
          <div className="export-layout">
            <div
              ref={tabContent}
              className="export-stage-content"
              role="tabpanel"
              id={`${tabsId}-panel`}
              aria-labelledby={`${tabsId}-tab-${step}`}
              tabIndex={0}
            >
              {step === 0 && (
                <section className="panel export-panel has-surface">
                  <PixelFrame />
                  <h2>基本信息</h2>
                  <div className="export-fields">
                    <label className="field">
                      整合包名称
                      <Input
                        value={draft.options.name}
                        maxLength={150}
                        required
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            options: {
                              ...draft.options,
                              name: event.target.value,
                            },
                          })
                        }
                      />
                    </label>
                    <label className="field">
                      整合包版本
                      <Input
                        value={draft.options.version}
                        maxLength={100}
                        required
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            options: {
                              ...draft.options,
                              version: event.target.value,
                            },
                          })
                        }
                      />
                    </label>
                    <label className="field export-wide">
                      作者
                      <Input
                        value={draft.options.author}
                        maxLength={200}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            options: {
                              ...draft.options,
                              author: event.target.value,
                            },
                          })
                        }
                      />
                    </label>
                    <label className="field export-wide">
                      简介
                      <Textarea
                        rows={3}
                        maxLength={4000}
                        value={draft.options.summary}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            options: {
                              ...draft.options,
                              summary: event.target.value,
                            },
                          })
                        }
                      />
                    </label>
                  </div>
                  <fieldset className="export-formats">
                    <legend>导出格式</legend>
                    {Object.entries(exportFormats).map(([value, format]) => (
                      <label
                        key={value}
                        className="export-format has-surface"
                        data-selected={draft.format === value}
                      >
                        <PixelFrame />
                        <input
                          type="radio"
                          className="pixel-checkbox pixel-surface"
                          name="export-format"
                          value={value}
                          checked={draft.format === value}
                          onChange={() =>
                            setDraft({
                              ...draft,
                              format: value as ExportDraft["format"],
                            })
                          }
                        />
                        <FileArchive size={22} />
                        <span>
                          <strong>{format.name}</strong>
                          <small>.{format.extension}</small>
                        </span>
                      </label>
                    ))}
                  </fieldset>
                  <p className="helper">
                    清单记录游戏和加载器版本，安装时自动获取运行依赖。作者和简介也会保存在包内说明文件中。
                  </p>
                </section>
              )}
              {step === 1 && (
                <section className="panel export-panel has-surface">
                  <PixelFrame />
                  <div className="export-section-heading">
                    <h2>选择内容</h2>
                    <span>
                      {selected.size} 个文件 · {bytes(selectionSize)}
                    </span>
                  </div>
                  <p className="helper">
                    默认选择已启用模组、配置和脚本。存档、截图、材质包、光影及个人游戏设置可以按需选择。
                  </p>
                  <div className="export-filter">
                    <Input
                      aria-label="搜索导出文件"
                      placeholder="搜索目录或文件名"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                    />
                    <label>
                      <Checkbox
                        checked={onlySelected}
                        onChange={(event) =>
                          setOnlySelected(event.target.checked)
                        }
                      />
                      只看已选
                    </label>
                    <Button
                      onClick={() =>
                        updateFiles(
                          inspection.files.map((file) => file.path),
                          false,
                        )
                      }
                    >
                      清空选择
                    </Button>
                  </div>
                  {groups.length ? (
                    groups.map(([name, files]) => (
                      <ExportFileGroup
                        key={name}
                        name={name}
                        files={files}
                        selected={selected}
                        onSelect={updateFiles}
                      />
                    ))
                  ) : (
                    <p className="helper">没有符合条件的文件。</p>
                  )}
                </section>
              )}
              {step === 2 && (
                <div className="export-review">
                  <section className="panel export-panel has-surface">
                    <PixelFrame />
                    <div className="export-section-heading">
                      <h2>导出检查</h2>
                      <Button
                        disabled={locked || scanNeeded || !ready}
                        onClick={() => void inspectPlan()}
                      >
                        <RefreshCw size={16} />
                        重新检查
                      </Button>
                    </div>
                    <LoadingState
                      loading={busy === "plan"}
                      label="正在校验文件并识别资源来源…"
                    >
                      {plan ? (
                        <>
                          <div className="export-summary">
                            <span>
                              <strong>{plan.items.length}</strong>所选文件
                            </span>
                            <span>
                              <strong>
                                {
                                  plan.items.filter(
                                    (item) => item.method === "reference",
                                  ).length
                                }
                              </strong>
                              引用文件
                            </span>
                            <span>
                              <strong>{bytes(plan.embeddedSize)}</strong>
                              直接打包原始大小
                            </span>
                          </div>
                          <p className="helper">
                            总内容大小 {bytes(plan.totalSize)}
                            。引用文件记录在清单中，安装时自动下载；最终包体积取决于直接打包内容的压缩结果。
                          </p>
                          {!currentPlan && (
                            <p className="export-warning" role="status">
                              内容或处理方式已修改，请重新检查后导出。
                            </p>
                          )}
                          <ErrorBanner
                            message={plan.warnings.join("\n")}
                            tone="info"
                            compact
                          />
                          {plan.issues.length > 0 && (
                            <p className="inline-error" role="status">
                              有 {plan.issues.length}{" "}
                              项需要处理。仅直接包含自制或允许分发的资源文件。
                            </p>
                          )}
                          {planGroups.map(([name, items]) => (
                            <ExportPlanGroup
                              key={name}
                              name={name}
                              items={items}
                              draft={draft}
                              selected={selected}
                              onDraftChange={setDraft}
                              onSelect={updateFiles}
                            />
                          ))}
                        </>
                      ) : (
                        <p className="helper">
                          {ready
                            ? "检查文件来源和清单后，可以保存整合包。"
                            : "请先在基本信息中填写整合包名称和版本，再检查导出内容。"}
                        </p>
                      )}
                    </LoadingState>
                    {busy === "plan" && (
                      <Button onClick={() => void cancelInspection()}>
                        <X size={16} />
                        取消检查
                      </Button>
                    )}
                  </section>
                  {plan && busy !== "plan" && (
                    <section
                      className="panel export-manifest has-surface"
                      aria-label="清单预览"
                    >
                      <PixelFrame />
                      <ExportFileDisclosure
                        name="查看清单预览"
                        label="查看清单预览"
                        icon={<FileJson size={16} aria-hidden="true" />}
                        summary={
                          draft.format === "modrinth"
                            ? "modrinth.index.json"
                            : "manifest.json"
                        }
                        defaultExpanded={false}
                      >
                        <pre tabIndex={0} aria-label="清单 JSON">
                          {JSON.stringify(plan.manifest, null, 2)}
                        </pre>
                      </ExportFileDisclosure>
                    </section>
                  )}
                </div>
              )}
              {step === 3 && !jobId && (
                <section className="panel export-panel has-surface">
                  <PixelFrame />
                  <h2>保存整合包</h2>
                  <dl className="export-save-summary">
                    <div>
                      <dt>整合包</dt>
                      <dd>
                        {draft.options.name || "尚未填写名称"} ·{" "}
                        {draft.options.version || "尚未填写版本"}
                      </dd>
                    </div>
                    <div>
                      <dt>导出格式</dt>
                      <dd>
                        {exportFormats[draft.format].name}（.
                        {exportFormats[draft.format].extension}）
                      </dd>
                    </div>
                    <div>
                      <dt>导出内容</dt>
                      <dd>
                        {selected.size} 个文件 · {bytes(selectionSize)}
                      </dd>
                    </div>
                    <div>
                      <dt>建议文件名</dt>
                      <dd>{exportFileName(draft)}</dd>
                    </div>
                  </dl>
                  {currentPlan && plan?.token && !plan.issues.length ? (
                    <p className="helper">
                      内容检查已通过。选择游戏目录以外的保存位置后，整合包将在后台导出。
                    </p>
                  ) : (
                    <div className="export-warning">
                      <p>
                        {!ready
                          ? "请先填写整合包名称和版本。"
                          : plan?.issues.length && currentPlan
                            ? "仍有文件需要处理，请返回导出检查。"
                            : "请先检查所选内容，检查通过后即可导出。"}
                      </p>
                      <Button
                        disabled={locked || scanNeeded}
                        onClick={() => navigateStep(ready ? 2 : 0)}
                      >
                        {ready ? "前往导出检查" : "填写基本信息"}
                      </Button>
                    </div>
                  )}
                </section>
              )}
              {step === 3 && !!jobId && (
                <section className="panel export-panel has-surface">
                  <PixelFrame />
                  <h2>
                    {job?.status === "completed"
                      ? "整合包已导出"
                      : job?.status === "failed"
                        ? "导出失败"
                        : job?.status === "cancelled"
                          ? "导出已取消"
                          : "正在导出整合包"}
                  </h2>
                  <p className="path-text">{output}</p>
                  {job ? (
                    <>
                      <Badge status={job.status} />
                      <Steps steps={job.steps} />
                      {job.error && (
                        <p className="inline-error" role="alert">
                          {job.error}
                        </p>
                      )}
                    </>
                  ) : (
                    <p role="status">正在创建导出任务…</p>
                  )}
                  <div className="export-result-actions">
                    {running && (
                      <Button
                        onClick={() =>
                          void api("jobs.cancel", { id: jobId }).catch(
                            (reason) => setError(String(reason)),
                          )
                        }
                      >
                        <X size={16} />
                        取消导出
                      </Button>
                    )}
                    {job?.status === "completed" && (
                      <Button
                        primary
                        onClick={() =>
                          void api("modpacks.export.reveal", { jobId }).catch(
                            (reason) => setError(String(reason)),
                          )
                        }
                      >
                        <FolderOpen size={16} />
                        打开所在文件夹
                      </Button>
                    )}
                    {!running && (
                      <Button
                        onClick={() => {
                          setJobId("");
                          setStep(2);
                          void inspectPlan();
                        }}
                      >
                        再次导出
                      </Button>
                    )}
                  </div>
                </section>
              )}
            </div>
            {scanNeeded && (
              <p className="export-warning">
                请重新扫描后继续。
                <Button onClick={() => setRevision((value) => value + 1)}>
                  重新扫描
                </Button>
              </p>
            )}
            <div className="export-navigation">
              <ExportBackButton
                visible={!locked && step > 0}
                onClick={() => navigateStep(step - 1)}
              />
              <span className="export-navigation-summary">
                {exportFormats[draft.format].name} · {selected.size} 个文件
              </span>
              {step === 0 ? (
                <Button
                  primary
                  disabled={locked || !ready}
                  onClick={() => navigateStep(1)}
                >
                  选择内容
                  <ChevronRight size={16} />
                </Button>
              ) : step === 1 ? (
                <Button
                  primary
                  disabled={locked || scanNeeded || !ready}
                  onClick={() => void inspectPlan()}
                >
                  检查导出内容
                  <ChevronRight size={16} />
                </Button>
              ) : step === 2 ? (
                <Button
                  primary
                  disabled={
                    locked ||
                    !currentPlan ||
                    !plan?.token ||
                    !!plan.issues.length
                  }
                  onClick={() => navigateStep(3)}
                >
                  <FileArchive size={16} />
                  保存整合包
                  <ChevronRight size={16} />
                </Button>
              ) : !jobId ? (
                <Button
                  primary
                  disabled={
                    locked ||
                    !currentPlan ||
                    !plan?.token ||
                    !!plan.issues.length
                  }
                  onClick={() => void startExport()}
                >
                  <FileArchive size={16} />
                  选择位置并导出
                </Button>
              ) : null}
            </div>
          </div>
        )}
      </LoadingState>
    </div>
  );
}

function exportGroupName(path: string) {
  return path.includes("/") ? path.split("/")[0] : "根目录文件";
}

function ExportFileDisclosure({
  name,
  summary,
  children,
  className = "",
  label = `${name} 文件分组`,
  icon = <FolderOpen size={16} />,
  defaultExpanded = true,
}: {
  name: string;
  summary: ReactNode;
  children: ReactNode;
  className?: string;
  label?: string;
  icon?: ReactNode;
  defaultExpanded?: boolean;
}) {
  const contentId = useId();
  const [expanded, setExpanded] = useState(defaultExpanded);
  return (
    <section
      className={`export-file-group ${className}`}
      data-expanded={expanded}
    >
      <button
        type="button"
        className="export-group-toggle"
        aria-label={label}
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={() => setExpanded((value) => !value)}
      >
        {icon}
        <strong>{name}</strong>
        <span>{summary}</span>
        <ChevronDown
          className="export-group-chevron"
          size={16}
          aria-hidden="true"
        />
      </button>
      <div
        id={contentId}
        className="export-group-expand"
        aria-hidden={!expanded}
        inert={!expanded}
      >
        <div className="export-group-clip">
          <div className="export-group-content">{children}</div>
        </div>
      </div>
    </section>
  );
}

function ExportFileGroup({
  name,
  files,
  selected,
  onSelect,
}: {
  name: string;
  files: ExportFile[];
  selected: Set<string>;
  onSelect: (paths: string[], checked: boolean) => void;
}) {
  const [limit, setLimit] = useState(100);
  const count = files.filter((file) => selected.has(file.path)).length;
  return (
    <ExportFileDisclosure
      name={name}
      summary={
        <>
          {count}/{files.length} ·{" "}
          {bytes(files.reduce((sum, file) => sum + file.size, 0))}
        </>
      }
    >
      <label className="export-group-select">
        <Checkbox
          checked={count === files.length}
          indeterminate={count > 0 && count < files.length}
          onChange={(event) =>
            onSelect(
              files.map((file) => file.path),
              event.target.checked,
            )
          }
        />
        选择此目录中显示的文件
      </label>
      {files.slice(0, limit).map((file) => (
        <label className="export-file-row" key={file.path}>
          <Checkbox
            checked={selected.has(file.path)}
            onChange={(event) => onSelect([file.path], event.target.checked)}
          />
          <span>{file.path}</span>
          <small>{bytes(file.size)}</small>
        </label>
      ))}
      {files.length > limit && (
        <Button onClick={() => setLimit((value) => value + 100)}>
          显示更多（剩余 {files.length - limit} 个）
        </Button>
      )}
    </ExportFileDisclosure>
  );
}

function ExportPlanGroup({
  name,
  items,
  draft,
  selected,
  onDraftChange,
  onSelect,
}: {
  name: string;
  items: ExportPlan["items"];
  draft: ExportDraft;
  selected: Set<string>;
  onDraftChange: (draft: ExportDraft) => void;
  onSelect: (paths: string[], checked: boolean) => void;
}) {
  const [limit, setLimit] = useState(100);
  return (
    <ExportFileDisclosure
      name={name}
      className="export-plan-group"
      summary={
        <>
          {items.length} 个文件 ·{" "}
          {bytes(items.reduce((sum, item) => sum + item.size, 0))}
        </>
      }
    >
      {items.slice(0, limit).map((item) => (
        <div className="export-plan-row" key={item.path}>
          <div className="export-file-info">
            <strong>{item.path}</strong>
            <small>
              {bytes(item.size)} · {item.reason}
            </small>
            {item.project && (
              <small>
                项目 {item.project} · 文件版本 {item.version}
              </small>
            )}
          </div>
          <Badge>
            {item.method === "reference"
              ? "下载引用"
              : item.method === "embedded"
                ? "直接打包"
                : "需要处理"}
          </Badge>
          {item.method === "unresolved" && (
            <div className="export-file-actions">
              <label>
                <Checkbox
                  aria-label={`确认直接打包 ${item.path}`}
                  checked={draft.directPaths.includes(item.path)}
                  onChange={(event) =>
                    onDraftChange({
                      ...draft,
                      directPaths: event.target.checked
                        ? [...draft.directPaths, item.path]
                        : draft.directPaths.filter(
                            (path) => path !== item.path,
                          ),
                    })
                  }
                />
                已确认可分发，直接打包
              </label>
              <Button
                disabled={!selected.has(item.path)}
                onClick={() => onSelect([item.path], false)}
              >
                取消选择
              </Button>
              {draft.format === "modrinth" && (
                <label className="export-url">
                  下载地址
                  <Input
                    aria-label={`${item.path} 下载地址`}
                    type="url"
                    placeholder="https://…（下载内容将按本地文件哈希校验）"
                    value={
                      draft.downloads.find((value) => value.path === item.path)
                        ?.url ?? ""
                    }
                    onChange={(event) =>
                      onDraftChange({
                        ...draft,
                        downloads: [
                          ...draft.downloads.filter(
                            (value) => value.path !== item.path,
                          ),
                          ...(event.target.value
                            ? [
                                {
                                  path: item.path,
                                  url: event.target.value,
                                },
                              ]
                            : []),
                        ],
                      })
                    }
                  />
                </label>
              )}
            </div>
          )}
        </div>
      ))}
      {items.length > limit && (
        <Button onClick={() => setLimit((value) => value + 100)}>
          显示更多文件
        </Button>
      )}
    </ExportFileDisclosure>
  );
}

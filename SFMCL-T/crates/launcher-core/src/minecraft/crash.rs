//! Bounded, local diagnostics for one launch. Original game logs are read only.
use crate::{
    downloads::Status,
    jobs::{Job, JobSnapshot, Jobs},
    paths::{atomic_write, safe_join},
};
use anyhow::{Context, Result};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, VecDeque},
    fs,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{Duration, SystemTime},
};

const PART_LIMIT: usize = 256 * 1024;
const RETAIN_REPORTS: usize = 20;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrashReport {
    pub category: String,
    pub title: String,
    pub description: String,
    pub suggestions: Vec<String>,
    pub exit_code: Option<i32>,
    pub log_path: Option<PathBuf>,
    #[serde(default)]
    log_stamp: Option<Stamp>,
    #[serde(default)]
    pub acknowledged: bool,
}

#[derive(Default)]
struct Output {
    head: String,
    tail: VecDeque<String>,
    tail_bytes: usize,
    truncated: bool,
}
impl Output {
    fn push(&mut self, line: &str) {
        let line: String = line.chars().take(4000).collect();
        if self.tail.is_empty() && self.head.len() + line.len() + 1 <= PART_LIMIT {
            self.head.push_str(&line);
            self.head.push('\n');
        } else {
            self.tail_bytes += line.len() + 1;
            self.tail.push_back(line);
            while self.tail_bytes > PART_LIMIT {
                if let Some(line) = self.tail.pop_front() {
                    self.tail_bytes -= line.len() + 1;
                    self.truncated = true;
                }
            }
        }
    }
    fn text(&self) -> String {
        let separator = if self.truncated {
            "\n[中间输出已截断]\n"
        } else {
            ""
        };
        format!(
            "{}{separator}{}",
            self.head,
            self.tail.iter().cloned().collect::<Vec<_>>().join("\n")
        )
    }
}

type Stamp = (u64, SystemTime);
fn stamp(path: &Path) -> Option<Stamp> {
    let meta = fs::metadata(path).ok()?;
    meta.is_file()
        .then_some((meta.len(), meta.modified().ok()?))
}

fn log_files(directory: &Path) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    for name in ["logs/latest.log", "logs/debug.log"] {
        if let Ok(path) = safe_join(directory, name) {
            if path.is_file() {
                paths.push(path);
            }
        }
    }
    for (relative, crash_report) in [("crash-reports", true), ("", false)] {
        let parent = if relative.is_empty() {
            directory.to_path_buf()
        } else if let Ok(path) = safe_join(directory, relative) {
            path
        } else {
            continue;
        };
        let Ok(entries) = fs::read_dir(parent) else {
            continue;
        };
        let mut candidates = Vec::new();
        for entry in entries.take(2048).flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let eligible = if crash_report {
                name.starts_with("crash-") && name.ends_with(".txt")
            } else {
                name.starts_with("hs_err_pid") && name.ends_with(".log")
            };
            if !eligible {
                continue;
            }
            let Ok(path) = safe_join(directory, Path::new(relative).join(name)) else {
                continue;
            };
            if let Some((_, modified)) = stamp(&path) {
                candidates.push((modified, path));
            }
        }
        candidates.sort_by_key(|(modified, _)| std::cmp::Reverse(*modified));
        paths.extend(candidates.into_iter().take(4).map(|(_, path)| path));
    }
    paths
}

fn read_excerpt(path: &Path) -> Result<String> {
    let mut file = fs::File::open(path)?;
    let length = file.metadata()?.len();
    let mut bytes = Vec::new();
    (&mut file)
        .take((PART_LIMIT * 2) as u64)
        .read_to_end(&mut bytes)?;
    if length > (PART_LIMIT * 2) as u64 {
        bytes.truncate(PART_LIMIT);
        bytes.extend_from_slice(b"\n[... truncated ...]\n");
        file.seek(SeekFrom::End(-(PART_LIMIT as i64)))?;
        file.take(PART_LIMIT as u64).read_to_end(&mut bytes)?;
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn redact(text: &str, secrets: &[String]) -> String {
    static CREDENTIAL: OnceLock<Regex> = OnceLock::new();
    let mut text = text.to_owned();
    for secret in secrets.iter().filter(|s| !s.is_empty()) {
        text = text.replace(secret, "[REDACTED]");
    }
    CREDENTIAL.get_or_init(|| Regex::new(r#"(?i)(bearer\s+|(?:access[_-]?token|client[_-]?token|authorization)[\s\"':=]+)([^\s,\"'\]}]+)"#).unwrap())
        .replace_all(&text, "${1}[REDACTED]").into_owned()
}

pub struct Capture {
    directory: PathBuf,
    before: HashMap<PathBuf, Stamp>,
    started: SystemTime,
    secrets: Vec<String>,
    output: Mutex<Output>,
}
impl Capture {
    pub fn new(directory: &Path, secrets: &[String]) -> Self {
        Self {
            directory: directory.into(),
            before: log_files(directory)
                .into_iter()
                .filter_map(|path| stamp(&path).map(|s| (path, s)))
                .collect(),
            started: SystemTime::now(),
            secrets: secrets.into(),
            output: Mutex::new(Output::default()),
        }
    }
    pub fn line(&self, line: &str) {
        self.output
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(&redact(line, &self.secrets));
    }
    pub fn finish(&self, data: &Path, job: &Job, code: i32) {
        if job.cancel.is_cancelled() {
            return;
        }
        let mut sources = vec![(
            None,
            self.output.lock().unwrap_or_else(|e| e.into_inner()).text(),
        )];
        for path in log_files(&self.directory) {
            let Some(current) = stamp(&path) else {
                continue;
            };
            // Compare baseline metadata as well as time; never reuse an old crash.
            if self.before.get(&path) == Some(&current)
                || current.1 + Duration::from_secs(2) < self.started
            {
                continue;
            }
            if let Ok(text) = read_excerpt(&path) {
                sources.push((Some(path), redact(&text, &self.secrets)));
            }
        }
        publish(data, job, sources, Some(code), false, &self.secrets);
    }
}

fn finding(category: &str, title: &str, description: &str, suggestions: &[&str]) -> CrashReport {
    CrashReport {
        category: category.into(),
        title: title.into(),
        description: description.into(),
        suggestions: suggestions.iter().map(|s| (*s).into()).collect(),
        exit_code: None,
        log_path: None,
        log_stamp: None,
        acknowledged: false,
    }
}

fn analyze(text: &str) -> Option<(u8, CrashReport)> {
    let lower = text.to_lowercase();
    if lower.contains("unsupportedclassversionerror")
        || lower.contains("unsupported class file major version")
        || text.contains("游戏需要 Java")
        || text.contains("找不到 Java")
    {
        return Some((
            100,
            finding(
                "java",
                "Java 版本不兼容或未安装",
                "当前 Java 无法运行此游戏或其中的模组。",
                &[
                    "在版本设置中选择游戏与加载器要求的 Java 版本。",
                    "如果本机没有兼容版本，请先安装对应的 64 位 Java，再重新启动。",
                ],
            ),
        ));
    }
    if text.contains("32 位 Java 不支持所选内存")
        || lower.contains("could not reserve enough space")
        || lower.contains("invalid maximum heap size")
        || lower.contains("native memory allocation (malloc) failed")
        || lower.contains("there is insufficient memory for the java runtime")
    {
        return Some((
            95,
            finding(
                "memory-allocation",
                "Java 无法分配所需内存",
                "当前内存设置超出可用内存或 Java 架构的限制。",
                &[
                    "选择 64 位 Java，并关闭占用较高的其他程序。",
                    "适当降低游戏分配内存，为操作系统留出空间后重试。",
                ],
            ),
        ));
    }
    if lower.contains("outofmemoryerror") || lower.contains("gc overhead limit exceeded") {
        return Some((
            90,
            finding(
                "memory",
                "游戏可用内存不足",
                "日志显示 Java 内存耗尽，可能与模组、资源包或内存分配有关。",
                &[
                    "先检查系统剩余内存并关闭不需要的程序；有足够余量时再提高游戏内存。",
                    "若问题持续，尝试减少资源包或近期新增模组，并检查是否存在内存泄漏。",
                ],
            ),
        ));
    }
    if lower.contains("duplicatemodsfoundexception")
        || lower.contains("duplicate mods")
        || lower.contains("duplicate mod id")
        || lower.contains("duplicated mods")
    {
        return Some((
            80,
            finding(
                "duplicate-mods",
                "存在重复模组",
                "加载器检测到重复的模组或模组 ID，无法完成加载。",
                &[
                    "打开当前实例的 mods 文件夹，检查同一模组是否安装了多个版本。",
                    "将重复文件移出 mods 文件夹，保留与当前游戏及加载器兼容的一份后重试。",
                ],
            ),
        ));
    }
    let missing = lower.contains("missing mandatory dependencies")
        || (lower.contains("requires")
            && (lower.contains("which is missing") || lower.contains("is not installed")))
        || (lower.contains("depends on") && lower.contains("missing"))
        || (lower.contains("requires")
            && lower.contains("currently,")
            && lower.contains("not installed"));
    if missing {
        static FABRIC: OnceLock<Regex> = OnceLock::new();
        let captures = FABRIC.get_or_init(|| Regex::new(r"(?i)Mod '([^'\r\n]{1,100})'[^\r\n]*?requires (?:any version of |version [^\r\n]*? of )([a-z0-9_.-]{1,100})[^\r\n]*which is missing").unwrap()).captures(text);
        let mut result = finding(
            "missing-dependency",
            "缺少必需的前置模组",
            "有模组因缺少必需依赖而无法加载。",
            &[
                "根据日志中的依赖名称，下载适用于当前 Minecraft 版本和加载器的前置模组。",
                "将前置模组放入当前实例的 mods 文件夹，然后重新启动游戏。",
            ],
        );
        if let Some(c) = captures {
            let dependency = if c[2].eq_ignore_ascii_case("fabric-api") {
                "Fabric API"
            } else {
                &c[2]
            };
            result.title = format!("缺少前置模组 {dependency}");
            result.description = format!(
                "{} 需要 {dependency} 才能运行，但当前实例未安装该依赖。",
                &c[1]
            );
            result.suggestions[0] =
                format!("安装适用于当前 Minecraft 版本和加载器的 {dependency}。");
        }
        return Some((70, result));
    }
    if lower.contains("missing or unsupported mandatory dependencies") {
        return Some((
            65,
            finding(
                "dependency-version",
                "前置模组缺失或版本不兼容",
                "加载器报告必需依赖未满足，可能是前置模组未安装或版本不在要求范围内。",
                &[
                    "根据日志列出的模组名称和版本范围检查必需依赖。",
                    "安装或更新为兼容版本后重新启动游戏。",
                ],
            ),
        ));
    }
    if lower.contains("exception_access_violation")
        || lower.contains("a fatal error has been detected by the java runtime")
    {
        return Some((40, finding("native", "Java 或本地组件发生崩溃", "检测到虚拟机级别的崩溃，可能涉及 Java、显卡驱动或本地组件，仅凭当前日志无法确定责任组件。",
            &["检查 Java 版本和显卡驱动是否兼容，优先使用稳定版本。", "打开日志所在位置，结合 hs_err_pid 日志中的 Problematic frame 进一步排查。"])));
    }
    if lower.contains("mixin apply failed")
        || lower.contains("mixintransformererror")
        || lower.contains("mixinapplyerror")
        || lower.contains("critical injection failure")
        || lower.contains("invalidmixinexception")
    {
        return Some((
            20,
            finding(
                "mixin",
                "疑似存在模组兼容问题",
                "日志显示 Mixin 注入失败，可能与模组版本或冲突有关，当前证据无法直接确定责任模组。",
                &[
                    "确认最近新增或更新的模组适配当前游戏版本与加载器。",
                    "临时禁用近期新增模组，逐个恢复并测试；结合日志继续排查。",
                ],
            ),
        ));
    }
    None
}

fn report_directory(data: &Path, id: &str) -> Result<PathBuf> {
    let id = uuid::Uuid::parse_str(id)
        .context("无效的启动记录")?
        .to_string();
    safe_join(data, format!("crash-analysis/{id}"))
}

fn publish(
    data: &Path,
    job: &Job,
    sources: Vec<(Option<PathBuf>, String)>,
    code: Option<i32>,
    preparing: bool,
    secrets: &[String],
) {
    if job.cancel.is_cancelled() {
        return;
    }
    let best = sources
        .iter()
        .enumerate()
        .filter_map(|(index, (_, text))| analyze(text).map(|(rank, report)| (rank, index, report)))
        .max_by_key(|(rank, _, _)| *rank);
    let (index, mut report) = best.map(|(_, index, report)| (index, report)).unwrap_or_else(|| (0,
        if preparing {
            finding("preparation", "启动准备未完成", "游戏尚未正常运行，启动准备过程中发生错误。",
                &["打开日志所在位置查看本次启动的具体错误。", "检查游戏文件、Java 配置与文件访问权限后重试。"])
        } else {
            finding("unknown", "暂时无法确定崩溃原因", "游戏异常退出，但当前日志没有命中已知原因，退出代码本身不足以确定问题。",
                &["打开日志所在位置，查看本次启动的错误信息。", "如果最近添加了模组或资源包，可暂时移出后重试，或将日志提供给整合包作者排查。"])
        }));
    report.exit_code = code;
    report.log_path = sources[index].0.clone();
    report.log_stamp = report.log_path.as_deref().and_then(stamp);
    let snapshot = job.snapshot();
    let result = (|| -> Result<()> {
        let directory = report_directory(data, &snapshot.id)?;
        fs::create_dir_all(&directory)?;
        let evidence = sources
            .iter()
            .map(|(path, text)| {
                format!(
                    "=== {} ===\n{text}\n",
                    path.as_ref()
                        .map_or_else(|| "本次启动控制台".into(), |p| p.display().to_string())
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        let log = safe_join(&directory, "evidence.log")?;
        atomic_write(&log, evidence.as_bytes())?;
        if report.log_path.is_none() {
            report.log_stamp = stamp(&log);
            report.log_path = Some(log);
        }
        let mut saved = snapshot.clone();
        saved.log = saved.log.iter().map(|line| redact(line, secrets)).collect();
        saved.status = Status::Failed;
        saved.error = Some(code.map_or_else(
            || "启动准备失败".into(),
            |c| format!("Java 进程退出，错误码 {c}"),
        ));
        if let Some(launch) = &mut saved.launch {
            launch.running = false;
        }
        if let Some(step) = saved.steps.get_mut(saved.current_step) {
            step.status = Status::Failed;
        }
        saved.crash_report = Some(report.clone());
        atomic_write(
            &safe_join(&directory, "report.json")?,
            &serde_json::to_vec_pretty(&saved)?,
        )?;
        Ok(())
    })();
    job.set_crash_report(report);
    if let Err(error) = result {
        job.log(format!("无法保存崩溃分析报告：{error}"));
    } else {
        prune(data);
    }
}

pub fn startup_failure(data: &Path, job: &Job, error: &str, secrets: &[String]) {
    let snapshot = job.snapshot();
    if snapshot.crash_report.is_some()
        || job.cancel.is_cancelled()
        || snapshot.download_id.is_some()
    {
        return;
    }
    let text = redact(&format!("{}\n{error}", snapshot.log.join("\n")), secrets);
    publish(data, job, vec![(None, text)], None, true, secrets);
}

fn saved_reports(data: &Path) -> Vec<(PathBuf, JobSnapshot)> {
    let Ok(root) = safe_join(data, "crash-analysis") else {
        return vec![];
    };
    let Ok(entries) = fs::read_dir(root) else {
        return vec![];
    };
    let mut reports = Vec::new();
    for entry in entries.take(2048).flatten() {
        let id = entry.file_name().to_string_lossy().into_owned();
        let Ok(directory) = report_directory(data, &id) else {
            continue;
        };
        let Ok(path) = safe_join(&directory, "report.json") else {
            continue;
        };
        if !fs::metadata(&path).is_ok_and(|m| m.len() <= 8 * 1024 * 1024) {
            continue;
        }
        let Ok(bytes) = fs::read(path) else { continue };
        let Ok(snapshot) = serde_json::from_slice::<JobSnapshot>(&bytes) else {
            continue;
        };
        if snapshot.id == id
            && snapshot.status == Status::Failed
            && snapshot.crash_report.is_some()
            && snapshot.launch.is_some()
        {
            reports.push((directory, snapshot));
        }
    }
    reports.sort_by_key(|(_, snapshot)| std::cmp::Reverse(snapshot.created_at));
    reports
}

pub fn recover(data: &Path, jobs: &Jobs) {
    let reports: Vec<_> = saved_reports(data)
        .into_iter()
        .take(RETAIN_REPORTS)
        .collect();
    for (directory, mut snapshot) in reports.into_iter().rev() {
        snapshot.crash_report.as_mut().unwrap().acknowledged =
            directory.join("acknowledged").exists();
        jobs.restore_launch(snapshot);
    }
}

pub fn acknowledge(data: &Path, job: &Job) -> Result<()> {
    let snapshot = job.snapshot();
    let directory = report_directory(data, &snapshot.id)?;
    if safe_join(&directory, "report.json")?.is_file() {
        atomic_write(&safe_join(&directory, "acknowledged")?, b"acknowledged\n")?;
    }
    if let Some(mut report) = snapshot.crash_report {
        report.acknowledged = true;
        job.set_crash_report(report);
    }
    Ok(())
}

pub fn archived_log(data: &Path, id: &str) -> Result<PathBuf> {
    safe_join(&report_directory(data, id)?, "evidence.log")
}

/// latest.log can be replaced by another launch; in that case open the saved
/// evidence instead of silently showing an unrelated run's output.
pub fn original_log(report: &CrashReport) -> Option<&Path> {
    let path = report.log_path.as_deref()?;
    (report.log_stamp.is_some() && stamp(path) == report.log_stamp).then_some(path)
}

fn prune(data: &Path) {
    for (directory, _) in saved_reports(data).into_iter().skip(RETAIN_REPORTS) {
        // Only our known files; never recursively remove unknown user content.
        for name in ["evidence.log", "report.json", "acknowledged"] {
            if let Ok(path) = safe_join(&directory, name) {
                let _ = fs::remove_file(path);
            }
        }
        let _ = fs::remove_dir(directory);
    }
}

#[cfg(test)]
#[path = "crash_tests.rs"]
mod tests;

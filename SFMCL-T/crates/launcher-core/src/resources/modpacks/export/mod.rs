mod snapshot;
#[cfg(test)]
mod tests;
mod writer;

use crate::{
    jobs::{JobKind, Jobs},
    paths::{atomic_write, safe_join},
    resources::{
        community::Community,
        install::{Inventory, LocalFile},
    },
};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha1::Digest;
pub use snapshot::ExportTarget;
use snapshot::{check_cancel, digest, resource_file, scan};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    Modrinth,
    Curseforge,
}
impl ExportFormat {
    pub fn extension(self) -> &'static str {
        match self {
            Self::Modrinth => "mrpack",
            Self::Curseforge => "zip",
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExportLoader {
    pub kind: String,
    pub version: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportFile {
    pub path: String,
    pub size: u64,
    pub modified: String,
    pub selected: bool,
}
#[derive(Clone)]
struct HashedFile {
    file: ExportFile,
    sha1: String,
    sha512: String,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOptions {
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub summary: String,
}
impl ExportOptions {
    fn validate(&self) -> Result<()> {
        if self.name.trim().is_empty() || self.version.trim().is_empty() {
            bail!("请填写整合包名称和版本");
        }
        for (label, value, limit) in [
            ("名称", &self.name, 150),
            ("版本", &self.version, 100),
            ("作者", &self.author, 200),
            ("简介", &self.summary, 4000),
        ] {
            if value.chars().count() > limit || value.contains('\0') {
                bail!("整合包{label}过长或包含无效字符");
            }
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportDownload {
    pub path: String,
    pub url: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportDraft {
    pub format: ExportFormat,
    pub options: ExportOptions,
    pub paths: Vec<String>,
    #[serde(default)]
    pub direct_paths: Vec<String>,
    #[serde(default)]
    pub downloads: Vec<ExportDownload>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportInspection {
    pub token: String,
    pub game_directory: String,
    pub minecraft: String,
    pub loader: Option<ExportLoader>,
    pub shared: bool,
    pub files: Vec<ExportFile>,
    pub warnings: Vec<String>,
    pub draft: Option<ExportDraft>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPlanRequest {
    pub inspection_token: String,
    #[serde(flatten)]
    pub draft: ExportDraft,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPlanItem {
    pub path: String,
    pub size: u64,
    pub method: String,
    pub project: Option<String>,
    pub version: Option<String>,
    pub reason: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPlan {
    pub token: Option<String>,
    pub items: Vec<ExportPlanItem>,
    pub issues: Vec<String>,
    pub warnings: Vec<String>,
    pub total_size: u64,
    pub embedded_size: u64,
    pub manifest: Value,
}
struct InspectionState {
    target: ExportTarget,
    files: Vec<ExportFile>,
    warnings: Vec<String>,
    cancel: CancellationToken,
    created: Instant,
    matches: Mutex<HashMap<String, HashMap<String, crate::resources::install::Candidate>>>,
}
#[derive(Clone)]
struct PreparedPlan {
    inspection: String,
    target: ExportTarget,
    files: Vec<HashedFile>,
    direct: HashSet<String>,
    manifest: Value,
    draft: ExportDraft,
    cancel: CancellationToken,
    created: Instant,
}
#[derive(Default)]
pub struct ModpackExporter {
    inspections: Mutex<HashMap<String, Arc<InspectionState>>>,
    plans: Mutex<HashMap<String, PreparedPlan>>,
    completed: Mutex<HashMap<String, PathBuf>>,
}
impl ModpackExporter {
    pub fn inspect(&self, target: ExportTarget) -> Result<ExportInspection> {
        let (files, warnings) = scan(&target)?;
        let draft_path = safe_join(
            &target.root,
            format!(".tmcl/modpack-export/{}.json", target.id),
        )?;
        let draft = std::fs::read(&draft_path)
            .ok()
            .filter(|v| v.len() < 16 * 1024 * 1024)
            .and_then(|bytes| serde_json::from_slice(&bytes).ok());
        let token = uuid::Uuid::new_v4().to_string();
        let result = ExportInspection {
            token: token.clone(),
            game_directory: target.game.to_string_lossy().into_owned(),
            minecraft: target.minecraft.clone(),
            loader: target.loader.clone(),
            shared: target.shared,
            files: files.clone(),
            warnings: warnings.clone(),
            draft,
        };
        let mut states = self.inspections.lock().unwrap_or_else(|e| e.into_inner());
        states.retain(|_, state| {
            let keep = state.created.elapsed() < Duration::from_secs(3600);
            if !keep {
                state.cancel.cancel();
            }
            keep
        });
        if states.len() >= 8 {
            bail!("待制作的整合包过多，请关闭其他制作页面");
        }
        states.insert(
            token,
            Arc::new(InspectionState {
                target,
                files,
                warnings,
                cancel: CancellationToken::new(),
                created: Instant::now(),
                matches: Mutex::new(HashMap::new()),
            }),
        );
        Ok(result)
    }
    pub fn discard(&self, token: &str) {
        if let Some(state) = self
            .inspections
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(token)
        {
            state.cancel.cancel();
        }
        self.plans
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|key, value| key != token && value.inspection != token);
    }
    pub fn save_draft(&self, target: &ExportTarget, draft: &ExportDraft) -> Result<()> {
        draft.options.validate()?;
        if draft.paths.len() > 99_000 {
            bail!("选择的文件过多");
        }
        for path in draft
            .paths
            .iter()
            .chain(&draft.direct_paths)
            .chain(draft.downloads.iter().map(|v| &v.path))
        {
            super::archive::relative(path)?;
            if snapshot::excluded(path) {
                bail!("不能包含个人配置或运行资源：{path}");
            }
        }
        atomic_write(
            &safe_join(
                &target.root,
                format!(".tmcl/modpack-export/{}.json", target.id),
            )?,
            &serde_json::to_vec_pretty(draft)?,
        )
    }
    pub async fn plan(
        &self,
        request: ExportPlanRequest,
        target: ExportTarget,
        community: &Community,
    ) -> Result<ExportPlan> {
        request.draft.options.validate()?;
        let state = self
            .inspections
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&request.inspection_token)
            .cloned()
            .context("扫描已失效，请重新扫描游戏目录")?;
        if state.target != target || state.created.elapsed() >= Duration::from_secs(3600) {
            bail!("版本信息或游戏目录已变化，请重新扫描");
        }
        check_cancel(&state.cancel)?;
        let paths = request.draft.paths.iter().cloned().collect::<HashSet<_>>();
        if paths.len() != request.draft.paths.len() {
            bail!("选择列表存在重复路径");
        }
        let selected = state
            .files
            .iter()
            .filter(|file| paths.contains(&file.path))
            .cloned()
            .collect::<Vec<_>>();
        if selected.len() != paths.len() {
            bail!("选择列表含有扫描范围以外的文件，请重新扫描");
        }
        if selected.len() > 99_000
            || selected
                .iter()
                .any(|file| file.size > 4 * 1024 * 1024 * 1024)
            || selected.iter().map(|file| file.size as u128).sum::<u128>() > 20 * 1024 * 1024 * 1024
        {
            bail!("所选文件数量或大小超过整合包支持范围，请减少选择");
        }
        self.plans
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|_, plan| plan.inspection != request.inspection_token);
        let hash_target = target.clone();
        let cancel = state.cancel.clone();
        let files = tokio::task::spawn_blocking(move || {
            selected
                .iter()
                .map(|file| digest(&hash_target, file, &cancel))
                .collect::<Result<Vec<_>>>()
        })
        .await??;
        let mut warnings = state.warnings.clone();
        let mut inventory = Inventory { files: vec![] };
        let source = match request.draft.format {
            ExportFormat::Modrinth => "modrinth",
            ExportFormat::Curseforge => "curseforge",
        };
        for file in files.iter().filter(|file| {
            resource_file(&file.file.path)
                && !request.draft.direct_paths.contains(&file.file.path)
                && !request
                    .draft
                    .downloads
                    .iter()
                    .any(|download| download.path == file.file.path)
        }) {
            let hash_target = target.clone();
            let path = file.file.path.clone();
            let (sha1, fingerprint) = if source == "modrinth" {
                (file.sha1.clone(), 0)
            } else {
                tokio::task::spawn_blocking(move || {
                    crate::resources::community::install_metadata::identity(&safe_join(
                        &hash_target.game,
                        path,
                    )?)
                })
                .await??
            };
            if sha1 != file.sha1 {
                bail!("文件已变化，请重新检查：{}", file.file.path);
            }
            inventory.files.push(LocalFile {
                path: file.file.path.clone(),
                sha1,
                fingerprint,
                disabled: false,
                mod_ids: vec![],
            });
        }
        // Retain successful exact matches when another batch fails or selection changes.
        let cached = state
            .matches
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(source)
            .cloned()
            .unwrap_or_default();
        let missing = Inventory {
            files: inventory
                .files
                .iter()
                .filter(|file| {
                    !cached
                        .get(&file.path)
                        .is_some_and(|value| value.file.sha1.as_deref() == Some(file.sha1.as_str()))
                })
                .cloned()
                .collect(),
        };
        let mut matches = cached;
        let lookup_started = Instant::now();
        for batch in missing.files.chunks(100) {
            let inventory = Inventory {
                files: batch.to_vec(),
            };
            let remaining = Duration::from_secs(45).saturating_sub(lookup_started.elapsed());
            if remaining.is_zero() {
                warnings.push(format!("{source} 来源识别超时，已保留成功结果，请重试。"));
                break;
            }
            let matched = tokio::select! {
                result = tokio::time::timeout(remaining.min(Duration::from_secs(12)), community.installed_versions(source, &inventory)) => match result {
                    Ok(Ok(value)) => value,
                    Ok(Err(error)) => { warnings.push(format!("{source} 来源识别失败，可重试或直接打包有分发权限的文件：{error:#}")); break; },
                    Err(_) => { warnings.push(format!("{source} 来源识别超时，已保留成功结果，请重试。")); break; },
                },
                _ = state.cancel.cancelled() => bail!("整合包检查已取消"),
            };
            let folders = if source == "curseforge" && !matched.is_empty() {
                let projects = matched
                    .values()
                    .map(|c| c.project.parse::<u64>())
                    .collect::<std::result::Result<HashSet<_>, _>>()?
                    .into_iter()
                    .collect::<Vec<_>>();
                let response = tokio::select! {
                    result = tokio::time::timeout(Duration::from_secs(12), community.export_curseforge_folders(&projects)) => result,
                    _ = state.cancel.cancelled() => bail!("整合包检查已取消"),
                };
                match response {
                    Ok(Ok(folders)) => folders,
                    _ => {
                        warnings.push(
                            "无法确认部分 CurseForge 资源的安装路径，可重试或直接打包。".into(),
                        );
                        HashMap::new()
                    }
                }
            } else {
                HashMap::new()
            };
            for (path, mut candidate) in matched {
                if source == "curseforge" {
                    let Some(folder) = folders.get(&candidate.project) else {
                        continue;
                    };
                    crate::paths::valid_name(&candidate.file.path)?;
                    candidate.file.path = format!("{folder}/{}", candidate.file.path);
                }
                matches.insert(path, candidate);
            }
            state
                .matches
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(source.into(), matches.clone());
        }
        state
            .matches
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(source.into(), matches.clone());
        let (manifest, items, issues, direct) =
            writer::manifest(&target, &files, &request.draft, &matches)?;
        let selected_matches = matches
            .iter()
            .filter(|(path, candidate)| {
                files.iter().any(|file| {
                    file.file.path == **path
                        && candidate.file.sha1.as_deref() == Some(file.sha1.as_str())
                })
            })
            .map(|(_, value)| value)
            .collect::<Vec<_>>();
        for candidate in &selected_matches {
            for incompatible in &candidate.incompatible {
                if selected_matches.iter().any(|other| {
                    incompatible
                        .project
                        .as_ref()
                        .is_some_and(|p| p == &other.project)
                        || incompatible
                            .version
                            .as_ref()
                            .is_some_and(|v| v == &other.id)
                }) {
                    warnings.push(format!(
                        "{} 与所选资源存在平台声明的兼容性冲突。",
                        candidate.name
                    ));
                }
            }
        }
        warnings.sort();
        warnings.dedup();
        let total_size = files.iter().map(|f| f.file.size).sum();
        let embedded_size = files
            .iter()
            .filter(|f| direct.contains(&f.file.path))
            .map(|f| f.file.size)
            .sum();
        let token = if issues.is_empty() {
            let token = uuid::Uuid::new_v4().to_string();
            let mut plans = self.plans.lock().unwrap_or_else(|e| e.into_inner());
            plans.retain(|_, value| {
                value.created.elapsed() < Duration::from_secs(3600)
                    && value.inspection != request.inspection_token
            });
            plans.insert(
                token.clone(),
                PreparedPlan {
                    inspection: request.inspection_token.clone(),
                    target,
                    files,
                    direct,
                    manifest: manifest.clone(),
                    draft: request.draft.clone(),
                    cancel: state.cancel.clone(),
                    created: Instant::now(),
                },
            );
            Some(token)
        } else {
            None
        };
        Ok(ExportPlan {
            token,
            items,
            issues,
            warnings,
            total_size,
            embedded_size,
            manifest,
        })
    }
    pub fn start(
        self: &Arc<Self>,
        token: &str,
        target: ExportTarget,
        destination: PathBuf,
        jobs: Arc<Jobs>,
        overwrite: bool,
    ) -> Result<String> {
        let mut plan = self
            .plans
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(token)
            .cloned()
            .context("导出预览已失效，请重新检查")?;
        if plan.target != target || plan.created.elapsed() >= Duration::from_secs(3600) {
            bail!("版本信息已变化，请重新检查");
        }
        check_cancel(&plan.cancel)?;
        writer::destination(&destination, &plan, overwrite)?;
        // Once started, the background job owns cancellation independently of its page.
        plan.cancel = CancellationToken::new();
        if self
            .plans
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(token)
            .is_none()
        {
            bail!("导出预览已被使用，请重新检查");
        }
        let job = jobs.create(
            JobKind::ModpackExport,
            format!("导出整合包 {}", plan.draft.options.name),
            &["校验源文件", "生成整合包", "校验导出文件", "保存整合包"],
        );
        let id = job.snapshot().id;
        let completed_id = id.clone();
        let exporter = self.clone();
        // Consume only after destination validation; cancelling a save dialog keeps its plan.
        tokio::spawn(async move {
            let export_job = job.clone();
            let output = destination.clone();
            let result = tokio::task::spawn_blocking(move || {
                writer::write(&plan, &output, &export_job, overwrite)
            })
            .await
            .context("整合包导出任务异常")
            .and_then(|v| v);
            if result.is_ok() {
                exporter
                    .completed
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(completed_id, destination);
            }
            job.finish(&result);
        });
        Ok(id)
    }
    pub fn completed_path(&self, id: &str) -> Result<PathBuf> {
        self.completed
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .cloned()
            .context("整合包尚未成功导出")
    }
}

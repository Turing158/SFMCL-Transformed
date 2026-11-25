mod discover;
mod record;
#[cfg(test)]
mod tests;
mod transaction;

use super::{
    archive, blocking, install, parser, ModpackRequest, Modpacks, PackInfo, Prepared, UrlResolver,
};
use crate::{
    downloads::{DownloadSpec, Status},
    jobs::{Job, JobKind},
    minecraft::{installer::Installer, versions},
    paths::{atomic_write, safe_join, valid_name},
    resources::{community::Community, install::Inventory},
};
use anyhow::{bail, Context, Result};
pub use discover::{discover, Discovery};
pub use record::{record_install, InstallRecord};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;
pub use transaction::restore;
pub use transaction::{ensure_ready, operation_guard};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Origin {
    pub source: String,
    pub project_id: String,
    pub version_id: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Release {
    pub id: String,
    pub name: String,
    pub version: String,
    pub date: String,
    pub game_versions: Vec<String>,
    pub loaders: Vec<String>,
    pub stable: bool,
    pub file: DownloadSpec,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareRequest {
    pub root: PathBuf,
    pub id: String,
    pub token: Option<String>,
    pub origin: Option<Origin>,
    pub current_token: Option<String>,
    pub current_origin: Option<Origin>,
    #[serde(default)]
    pub include_optional: bool,
    #[serde(default)]
    pub current_include_optional: bool,
    #[serde(default)]
    pub infer_optional: bool,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub path: String,
    pub local_path: String,
    pub destination_path: String,
    pub action: String,
    pub conflict: bool,
    pub reason: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub token: String,
    pub current: Value,
    pub target: InstallRecord,
    pub items: Vec<Item>,
    pub baseline_missing: bool,
    pub warnings: Vec<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyRequest {
    pub root: PathBuf,
    pub id: String,
    pub token: String,
    #[serde(default)]
    pub decisions: BTreeMap<String, String>,
    pub new_name: Option<String>,
}
struct Ready {
    work: tempfile::TempDir,
    root: PathBuf,
    id: String,
    expected: BTreeMap<String, String>,
    expected_record: Option<String>,
    plan: Plan,
    created: Instant,
}
#[derive(Default)]
pub struct Updates {
    ready: Mutex<HashMap<String, Ready>>,
}

fn instance(root: &Path, id: &str) -> Result<PathBuf> {
    if !root.is_absolute() {
        bail!("请选择有效的游戏目录");
    }
    valid_name(id)?;
    let target = safe_join(root, format!("versions/{id}"))?;
    if !safe_join(&target, format!("{id}.json"))?.is_file() {
        bail!("版本不存在");
    }
    Ok(target)
}

pub fn info(root: &Path, id: &str) -> Result<Value> {
    let target = instance(root, id)?;
    let record = record::read(&target)?;
    let profile = versions::resolve(root, id)?;
    Ok(json!({
        "record":record, "current":profile["tmclModpack"],
        "backups": transaction::history(root,id)?,
    }))
}

fn diff(
    old: &BTreeMap<String, String>,
    new: &BTreeMap<String, String>,
    local: &BTreeMap<String, String>,
    id: &str,
) -> Vec<Item> {
    let paths: BTreeSet<_> = old
        .keys()
        .chain(new.keys())
        .chain(local.keys())
        .filter(|p| !record::runtime(p, id))
        .cloned()
        .collect();
    let mut used = HashSet::new();
    let mut rows = vec![];
    // Treat a disabled file as the same owned file, preserving its disabled
    // destination even when the author's filename/content changes in place.
    for path in paths
        .iter()
        .filter(|p| old.contains_key(*p) || new.contains_key(*p))
    {
        let disabled = format!("{path}.disabled");
        let local_path = if !local.contains_key(path) && local.contains_key(&disabled) {
            disabled
        } else {
            path.clone()
        };
        used.insert(local_path.clone());
        used.insert(path.clone());
        let before = old.get(path);
        let after = new.get(path);
        let current = local.get(&local_path);
        let (action, conflict, reason) = if after == before {
            (
                "keep",
                false,
                if local_path != *path {
                    "保留禁用状态"
                } else {
                    "保留本地状态"
                },
            )
        } else if current == after && local_path == *path {
            ("keep", false, "本地已是目标内容")
        } else if current == before {
            (
                if after.is_some() {
                    if before.is_some() {
                        "replace"
                    } else {
                        "add"
                    }
                } else {
                    "remove"
                },
                false,
                "作者更新，且本地未修改",
            )
        } else {
            (
                "conflict",
                true,
                if before.is_none() {
                    "新版文件与本地添加的文件重名"
                } else if current.is_none() {
                    "此文件已被本地删除，作者也进行了更新"
                } else {
                    "本地与整合包作者均有修改"
                },
            )
        };
        rows.push(Item {
            path: path.clone(),
            destination_path: local_path.clone(),
            local_path,
            action: action.into(),
            conflict,
            reason: reason.into(),
        });
    }
    for path in paths {
        if !used.contains(&path) {
            rows.push(Item {
                destination_path: path.clone(),
                local_path: path.clone(),
                path,
                action: "keep".into(),
                conflict: false,
                reason: "保留用户添加的文件".into(),
            });
        }
    }
    rows.sort_by(|a, b| {
        b.conflict
            .cmp(&a.conflict)
            .then_with(|| a.path.cmp(&b.path))
    });
    rows
}

fn preserve_disabled_renames(
    rows: &mut [Item],
    baseline: &InstallRecord,
    current: &Path,
    next: &Path,
    expected: &BTreeMap<String, String>,
) -> Result<()> {
    let old = Inventory::read(current)?;
    let new = Inventory::read(next)?;
    let next_record = record::read(next)?.context("新版安装记录缺失")?;
    for file in new
        .files
        .iter()
        .filter(|f| !f.disabled && !f.mod_ids.is_empty())
    {
        let new_path = if cfg!(windows) {
            file.path.to_lowercase()
        } else {
            file.path.clone()
        };
        if expected.contains_key(&new_path) || baseline.files.contains_key(&new_path) {
            continue;
        }
        let candidates: Vec<_> = old
            .files
            .iter()
            .filter(|old| {
                let path = if cfg!(windows) {
                    old.path.to_lowercase()
                } else {
                    old.path.clone()
                };
                let base = path.strip_suffix(".disabled");
                old.disabled
                    && old.mod_ids == file.mod_ids
                    && base.is_some_and(|b| {
                        baseline.files.get(b) == expected.get(&path)
                            && !baseline.files.contains_key(&new_path)
                    })
            })
            .collect();
        if candidates.len() != 1 {
            continue;
        }
        let old_path = if cfg!(windows) {
            candidates[0].path.to_lowercase()
        } else {
            candidates[0].path.clone()
        };
        let old_base = old_path.strip_suffix(".disabled").unwrap();
        if baseline.files.contains_key(old_base) && !next_record.files.contains_key(old_base) {
            if let Some(row) = rows.iter_mut().find(|r| r.path == new_path) {
                row.local_path = old_path;
                row.destination_path = format!("{new_path}.disabled");
                row.action = "replace".into();
                row.conflict = false;
                row.reason = "作者更改了模组文件名，按模组 ID 保持禁用状态".into();
            }
        }
    }
    Ok(())
}

impl Modpacks {
    fn take_source(
        &self,
        token: &Option<String>,
        origin: &Option<Origin>,
    ) -> Result<Option<Prepared>> {
        if token.is_some() == origin.is_some() {
            bail!("请选择一个本地整合包或在线版本");
        }
        token
            .as_ref()
            .map(|t| {
                self.prepared
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(t)
                    .context("整合包预览已失效，请重新选择文件")
            })
            .transpose()
    }

    pub async fn prepare_update(
        self: &Arc<Self>,
        request: PrepareRequest,
        installer: Arc<Installer>,
        community: Arc<Community>,
        resolver: UrlResolver,
    ) -> Result<String> {
        let target = instance(&request.root, &request.id)?;
        ensure_ready(&request.root, &request.id)?;
        let game = crate::minecraft::version_settings::game_directory(
            &request.root,
            &request.id,
            &installer.settings.get(),
        )?;
        if game != target {
            bail!("此实例使用共享游戏目录，请先启用版本隔离后再更新");
        }
        {
            let mut ready = self.updates.ready.lock().unwrap_or_else(|e| e.into_inner());
            ready.retain(|_, r| r.created.elapsed() < Duration::from_secs(3600));
            if ready.len() >= 4 {
                bail!("请先关闭其他整合包更新预览");
            }
        }
        let selected = self.take_source(&request.token, &request.origin)?;
        let old_selected = if request.current_token.is_some() || request.current_origin.is_some() {
            Some(self.take_source(&request.current_token, &request.current_origin)?)
        } else {
            None
        };
        let parent = safe_join(&request.root, ".tmcl/modpacks")?;
        std::fs::create_dir_all(&parent)?;
        let work = tempfile::Builder::new()
            .prefix("update-")
            .tempdir_in(parent)?;
        let job = installer.jobs.create(
            JobKind::ModpackUpdate,
            format!("检查整合包更新 {}", request.id),
            &[
                "下载整合包",
                "解析整合包格式",
                "准备版本信息",
                "解析资源与依赖",
                "下载游戏文件",
                "安装加载器",
                "校验启动文件",
                "准备客户端",
                "下载整合包内容",
                "合并覆盖文件",
                "检查本地变化",
            ],
        );
        let id = job.snapshot().id;
        let service = self.clone();
        tokio::spawn(async move {
            let result = service
                .build_update(
                    request,
                    selected,
                    old_selected,
                    work,
                    installer.clone(),
                    community,
                    resolver,
                    job.clone(),
                )
                .await;
            job.detach_download();
            job.finish(&result);
        });
        Ok(id)
    }

    async fn build_update(
        self: &Arc<Self>,
        mut request: PrepareRequest,
        selected: Option<Prepared>,
        old_selected: Option<Option<Prepared>>,
        work: tempfile::TempDir,
        installer: Arc<Installer>,
        community: Arc<Community>,
        resolver: UrlResolver,
        job: Arc<Job>,
    ) -> Result<()> {
        let target = instance(&request.root, &request.id)?;
        let result = async {
            let path=target.clone(); let cancel=job.cancel.clone();
            let expected=blocking(move||record::snapshot(&path,&cancel)).await?;
            let expected_record=record::hash(&safe_join(&target,record::RECORD)?,&job.cancel)?;
            let mut baseline=record::read(&target)?;
            if let Some(prepared)=old_selected {
                let old_request=make_request(&request.root,&request.id,request.current_origin.clone(),request.current_include_optional || request.infer_optional,&community).await?;
                install(old_request,prepared,installer.clone(),community.clone(),resolver.clone(),job.clone(),&work.path().join("old"),false).await?;
                let old=work.path().join("old/game/versions").join(&request.id);
                let recovered=record::read(&old)?.context("无法恢复旧整合包清单")?;
                if request.infer_optional {
                    request.include_optional = recovered.optional_files.iter().any(|path| expected.contains_key(path) || expected.contains_key(&format!("{path}.disabled")));
                }
                let profile=versions::resolve(&request.root,&request.id)?;
                if profile["tmclModpack"]["name"].as_str().is_some_and(|n|n!=recovered.name)
                    || profile["tmclModpack"]["version"].as_str().is_some_and(|v|!v.is_empty()&&v!=recovered.version) {
                    bail!("所选原始包与当前实例记录的名称或版本不一致");
                }
                baseline=Some(recovered);
            }
            let next_request=make_request(&request.root,&request.id,request.origin.clone(),request.include_optional,&community).await?;
            install(next_request,selected,installer.clone(),community.clone(),resolver.clone(),job.clone(),&work.path().join("new"),false).await?;
            job.step(10,"比较整合包原始文件与本地内容");
            let next=work.path().join("new/game/versions").join(&request.id);
            let new_record=record::read(&next)?.context("新版安装记录缺失")?;
            if !matches!(new_record.format.as_str(),"Modrinth"|"CurseForge") { bail!("首版更新支持 Modrinth 和 CurseForge 整合包"); }
            let empty=BTreeMap::new();
            let mut items=diff(baseline.as_ref().map(|r|&r.files).unwrap_or(&empty),&new_record.files,&expected,&request.id);
            if let Some(old)=&baseline { preserve_disabled_renames(&mut items,old,&target,&next,&expected)?; }
            let mut warnings=vec!["存档、个人选项和启动器设置保留；配置与脚本按文件处理冲突。".into()];
            if baseline.is_none() { warnings.push("缺少旧文件清单：请补选当前版本原始包，或另存新实例并迁移个人数据。".into()); }
            let profile=versions::resolve(&request.root,&request.id)?;
            let current_mc=profile["clientVersion"].as_str().or(profile["inheritsFrom"].as_str()).unwrap_or(&request.id);
            if current_mc!=new_record.minecraft { warnings.push("Minecraft 版本发生变化，推荐另存新实例；原地更新将额外备份存档。".into()); }
            if baseline.as_ref().and_then(|r|r.loader.as_ref()).map(|v|&v["kind"]) != new_record.loader.as_ref().map(|v|&v["kind"]) {
                warnings.push("加载器发生变化，请确认自加模组兼容目标版本；推荐另存新实例。".into());
            }
            archive::check_cancel(&job.cancel)?;
            let plan=Plan{token:job.snapshot().id,current:json!({"name":profile["tmclModpack"]["name"],"version":profile["tmclModpack"]["version"],"minecraft":current_mc,"loader":versions::loader(&profile)}),target:new_record,items,baseline_missing:baseline.is_none(),warnings};
            Ok((expected,expected_record,plan))
        }.await;
        drain(&installer, &job, work.path()).await;
        let (expected, expected_record, plan) = result?;
        self.updates
            .ready
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(
                plan.token.clone(),
                Ready {
                    work,
                    root: request.root,
                    id: request.id,
                    expected,
                    expected_record,
                    plan,
                    created: Instant::now(),
                },
            );
        Ok(())
    }
}

async fn make_request(
    root: &Path,
    id: &str,
    origin: Option<Origin>,
    optional: bool,
    community: &Community,
) -> Result<ModpackRequest> {
    let file = match &origin {
        Some(o) => Some(community.modpack_release(o).await?.file),
        None => None,
    };
    Ok(ModpackRequest {
        root: root.into(),
        name: id.into(),
        token: None,
        file,
        include_optional: optional,
        origin,
    })
}

async fn drain(installer: &Installer, job: &Job, root: &Path) {
    for batch in installer.downloads.snapshots().await {
        if batch.root.starts_with(root) {
            if !matches!(batch.status, Status::Completed | Status::Cancelled) {
                let _ = installer.downloads.cancel(&batch.id).await;
            }
            let _ = installer.downloads.clear(&batch.id).await;
        }
    }
    job.detach_download();
}

impl Updates {
    pub fn plan(&self, token: &str) -> Result<Plan> {
        let ready = self.ready.lock().unwrap_or_else(|e| e.into_inner());
        let r = ready.get(token).context("更新预览已失效，请重新检查")?;
        if r.created.elapsed() > Duration::from_secs(3600) {
            bail!("更新预览已过期，请重新检查");
        }
        Ok(r.plan.clone())
    }
    pub fn discard(&self, token: &str) {
        self.ready
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(token);
    }
    pub fn start(self: &Self, request: ApplyRequest, installer: Arc<Installer>) -> Result<String> {
        let guard = operation_guard(&request.root, &request.id)?;
        ensure_ready(&request.root, &request.id)?;
        let mut ready = self.ready.lock().unwrap_or_else(|e| e.into_inner());
        let r = ready
            .get(&request.token)
            .context("更新预览已失效，请重新检查")?;
        if r.root != request.root
            || r.id != request.id
            || r.created.elapsed() > Duration::from_secs(3600)
        {
            bail!("更新预览不属于当前实例或已过期");
        }
        if r.plan.baseline_missing && request.new_name.is_none() {
            bail!("请先恢复旧文件清单，或选择另存新实例");
        }
        if let Some(name) = &request.new_name {
            valid_name(name)?;
            if safe_join(&request.root, format!("versions/{name}"))?.exists() {
                bail!("新实例名称已存在");
            }
        }
        if !r.plan.baseline_missing {
            for item in &r.plan.items {
                if item.conflict
                    && !request
                        .decisions
                        .get(&item.path)
                        .is_some_and(|v| v == "keep" || v == "replace")
                {
                    bail!("请处理文件冲突：{}", item.path);
                }
            }
        }
        let r = ready.remove(&request.token).unwrap();
        drop(ready);
        let job = installer.jobs.create(
            JobKind::ModpackUpdate,
            format!("更新整合包 {}", request.id),
            &["复核本地文件", "准备更新内容", "校验模组", "备份并提交更新"],
        );
        let id = job.snapshot().id;
        tokio::spawn(async move {
            let _guard = guard;
            let result = apply(r, request, installer.clone(), job.clone()).await;
            job.finish(&result);
        });
        Ok(id)
    }
}

async fn apply(
    mut ready: Ready,
    request: ApplyRequest,
    installer: Arc<Installer>,
    job: Arc<Job>,
) -> Result<()> {
    job.step(0, "确认检查后本地文件未变化");
    let target = instance(&request.root, &request.id)?;
    let path = target.clone();
    let cancel = job.cancel.clone();
    if blocking(move || record::snapshot(&path, &cancel)).await? != ready.expected
        || record::hash(&safe_join(&target, record::RECORD)?, &job.cancel)? != ready.expected_record
    {
        bail!("本地文件在检查后发生变化，请重新检查更新");
    }
    job.step(1, "保留个人内容并应用冲突选择");
    let source = ready
        .work
        .path()
        .join("new/game/versions")
        .join(&request.id);
    let merged = ready.work.path().join("merged");
    let src = source.clone();
    let dest = merged.clone();
    let cancel = job.cancel.clone();
    blocking(move || super::copy_tree(&src, &dest, &cancel)).await?;
    if !ready.plan.baseline_missing {
        for row in &ready.plan.items {
            archive::check_cancel(&job.cancel)?;
            let keep = row.action == "keep"
                || request
                    .decisions
                    .get(&row.path)
                    .is_some_and(|v| v == "keep");
            let upstream = safe_join(&merged, &row.path)?;
            let dest = safe_join(
                &merged,
                if keep {
                    &row.local_path
                } else {
                    &row.destination_path
                },
            )?;
            if keep {
                if upstream.is_file() {
                    std::fs::remove_file(&upstream)?;
                }
                let local = safe_join(&target, &row.local_path)?;
                if local.is_file() {
                    archive::copy_file(&local, &dest, &job.cancel)?;
                }
            } else if row.destination_path != row.path && upstream.is_file() {
                std::fs::create_dir_all(dest.parent().unwrap())?;
                std::fs::rename(upstream, dest)?;
            }
        }
    }
    let mut next = ready.plan.target.clone();
    next.instance_id = if request.new_name.is_some() {
        uuid::Uuid::new_v4().to_string()
    } else {
        record::read(&target)?
            .map(|r| r.instance_id)
            .unwrap_or_else(|| request.id.clone())
    };
    atomic_write(
        &safe_join(&merged, record::RECORD)?,
        &serde_json::to_vec_pretty(&next)?,
    )?;
    job.step(2, "检查更新后的模组 ID");
    let path = merged.clone();
    blocking(move || {
        let inventory = Inventory::read(&path)?;
        let mut ids = HashSet::new();
        for file in inventory.files.iter().filter(|f| !f.disabled) {
            for id in &file.mod_ids {
                if !ids.insert(id.clone()) {
                    bail!("更新将产生重复模组 ID：{id}，请先处理本地模组");
                }
            }
        }
        Ok(())
    })
    .await?;
    // Publishing shared dependencies is safe independently of the instance
    // transaction. Reuse the installer's atomic, hash-aware cache publication.
    let stage = ready.work.path().join("new/game");
    let profile = parser::read_json(&safe_join(&source, format!("{}.json", request.id))?)?;
    let expected: HashMap<_, _> = versions::libraries(&profile)?
        .into_iter()
        .map(|l| (l.file.path.clone(), l.file))
        .collect();
    for folder in ["libraries", "assets"] {
        let src = stage.join(folder);
        let root = request.root.clone();
        let expected = expected.clone();
        let cancel = job.cancel.clone();
        blocking(move || super::publish_shared(&src, &root, folder, &expected, &cancel)).await?;
    }
    job.step(3, "备份并提交更新");
    if let Some(name) = request.new_name {
        // Copy only personal data if ownership could not be recovered.
        let from = target.clone();
        let to = merged.clone();
        let cancel = job.cancel.clone();
        blocking(move || {
            for path in record::files(&from, true, &cancel)? {
                if record::personal(&path) && path != record::RECORD {
                    archive::copy_file(
                        &safe_join(&from, &path)?,
                        &safe_join(&to, &path)?,
                        &cancel,
                    )?;
                }
            }
            Ok(())
        })
        .await?;
        let mut profile = parser::read_json(&merged.join(format!("{}.json", request.id)))?;
        profile["id"] = json!(name);
        profile["jar"] = json!(name);
        std::fs::rename(
            merged.join(format!("{}.jar", request.id)),
            merged.join(format!("{name}.jar")),
        )?;
        atomic_write(
            &merged.join(format!("{name}.json")),
            &serde_json::to_vec_pretty(&profile)?,
        )?;
        std::fs::remove_file(merged.join(format!("{}.json", request.id)))?;
        archive::check_cancel(&job.cancel)?;
        let final_target = safe_join(&request.root, format!("versions/{name}"))?;
        if final_target.exists() {
            bail!("新实例名称已存在");
        }
        std::fs::rename(&merged, &final_target)?;
        job.log(format!("已另存新实例：{name}"));
    } else {
        let path = merged.clone();
        let cancel = job.cancel.clone();
        let desired = blocking(move || record::snapshot(&path, &cancel)).await?;
        let old_mc = ready.plan.current["minecraft"].as_str().unwrap_or("");
        let backup_saves = old_mc != next.minecraft;
        let root = request.root;
        let id = request.id;
        let expected = std::mem::take(&mut ready.expected);
        let cancel = job.cancel.clone();
        let backup = blocking(move || {
            transaction::commit(
                &root,
                &id,
                &merged,
                &expected,
                &desired,
                backup_saves,
                &cancel,
            )
        })
        .await?;
        job.log(format!("更新备份：{}", backup.display()));
    }
    let _ = installer;
    Ok(())
}

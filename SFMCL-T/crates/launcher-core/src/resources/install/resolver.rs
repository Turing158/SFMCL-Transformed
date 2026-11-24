use super::*;
use crate::paths::valid_name;
use std::collections::{BTreeMap, HashSet};

struct Solver<'a> {
    catalog: &'a dyn Catalog,
    target: &'a Target,
    inventory: &'a Inventory,
    installed: HashMap<String, Candidate>,
    projects: HashMap<String, ProjectMeta>,
    versions: HashMap<(String, String), Candidate>,
    candidates: HashMap<String, Vec<Candidate>>,
    attempts: usize,
}

pub(super) async fn resolve(
    catalog: &dyn Catalog,
    target: &Target,
    inventory: &Inventory,
    installed: HashMap<String, Candidate>,
    project: &str,
    version: &str,
) -> Result<Vec<Selection>> {
    let mut solver = Solver {
        catalog,
        target,
        inventory,
        installed,
        projects: HashMap::new(),
        versions: HashMap::new(),
        candidates: HashMap::new(),
        attempts: 0,
    };
    let root = catalog.version(Some(project), version).await?;
    if root.project != project || root.id != version {
        bail!("主模组文件与项目不一致");
    }
    solver
        .versions
        .insert((project.into(), version.into()), root);
    let chosen = solver
        .solve(
            BTreeMap::new(),
            vec![Dependency {
                project: Some(project.into()),
                version: Some(version.into()),
                filename: None,
            }],
        )
        .await?;
    let mut selections = vec![];
    for (id, candidate) in &chosen {
        let metadata = solver.projects.get(id).context("缺少前置项目元数据")?;
        let folder = folder(metadata.kind)?;
        valid_name(&candidate.file.path)?;
        let existing = solver.existing(candidate)?;
        let path = existing
            .as_ref()
            .map(|file| file.path.clone())
            .unwrap_or_else(|| format!("{folder}/{}", candidate.file.path));
        let status = match &existing {
            Some(file) if file.disabled => "disabled",
            Some(_) => "installed",
            None => "install",
        };
        selections.push(Selection {
            candidate: candidate.clone(),
            item: PlanItem {
                project_id: id.clone(),
                version_id: candidate.id.clone(),
                name: metadata.name.clone(),
                version: candidate.version.clone(),
                kind: metadata.kind,
                status: status.into(),
                path,
                main: id == project,
            },
            existing,
        });
    }
    let mut paths = HashSet::new();
    for selection in &selections {
        let path = enabled_path(&selection.item.path)?;
        if !paths.insert(path.to_lowercase()) {
            bail!("多个前置使用同一个安装路径：{path}");
        }
        if selection.existing.is_none()
            && inventory
                .files
                .iter()
                .any(|file| file.path.eq_ignore_ascii_case(&path))
        {
            bail!("安装路径已有其他文件：{path}");
        }
    }
    selections.sort_by(|a, b| {
        b.item
            .main
            .cmp(&a.item.main)
            .then_with(|| a.item.name.cmp(&b.item.name))
    });
    Ok(selections)
}

pub(super) fn folder(kind: ResourceKind) -> Result<&'static str> {
    match kind {
        ResourceKind::Mod => Ok("mods"),
        ResourceKind::Resourcepack => Ok("resourcepacks"),
        ResourceKind::Shader => Ok("shaderpacks"),
        _ => bail!("前置资源类型无法安装到游戏目录，请前往对应项目页面处理"),
    }
}

pub(super) fn enabled_path(path: &str) -> Result<String> {
    let path = path.replace("/.disabled/", "/");
    let path = path.trim_end_matches(".disabled").to_owned();
    if !["mods/", "resourcepacks/", "shaderpacks/"]
        .iter()
        .any(|prefix| path.starts_with(prefix))
    {
        bail!("无效的资源安装路径");
    }
    valid_name(path.split('/').next_back().context("无效文件名")?)?;
    Ok(path)
}

pub(super) fn compatible(candidate: &Candidate, kind: ResourceKind, target: &Target) -> bool {
    candidate.client_supported
        && candidate.game_versions.contains(&target.game_version)
        && (kind != ResourceKind::Mod
            || candidate
                .loaders
                .iter()
                .any(|loader| loader.eq_ignore_ascii_case(&target.loader)))
}

impl Solver<'_> {
    fn existing(&self, candidate: &Candidate) -> Result<Option<LocalFile>> {
        let matches = self
            .inventory
            .files
            .iter()
            .filter(|file| {
                self.installed
                    .get(&file.path)
                    .is_some_and(|installed| installed.project == candidate.project)
                    || candidate
                        .file
                        .sha1
                        .as_ref()
                        .is_some_and(|hash| hash.eq_ignore_ascii_case(&file.sha1))
            })
            .collect::<Vec<_>>();
        if matches.len() > 1 {
            bail!("本地存在重复模组或资源：{}", candidate.project);
        }
        if let Some(file) = matches.first() {
            if !self
                .installed
                .get(&file.path)
                .is_some_and(|installed| installed.id == candidate.id)
                && !candidate
                    .file
                    .sha1
                    .as_ref()
                    .is_some_and(|hash| hash.eq_ignore_ascii_case(&file.sha1))
            {
                bail!(
                    "已有前置 {} 的版本不满足要求，请先处理版本冲突",
                    candidate.project
                );
            }
            return Ok(Some((*file).clone()));
        }
        Ok(None)
    }

    fn conflicts(&self, chosen: &BTreeMap<String, Candidate>) -> Result<()> {
        let available = chosen
            .values()
            .chain(
                self.installed
                    .iter()
                    .filter(|(path, _)| {
                        self.inventory
                            .files
                            .iter()
                            .any(|file| &file.path == *path && !file.disabled)
                    })
                    .map(|(_, candidate)| candidate),
            )
            .collect::<Vec<_>>();
        for candidate in &available {
            for dep in &candidate.incompatible {
                if available.iter().any(|other| {
                    dep.project
                        .as_ref()
                        .is_none_or(|project| project == &other.project)
                        && dep
                            .version
                            .as_ref()
                            .is_none_or(|version| version == &other.id)
                        && (dep.project.is_some() || dep.version.is_some())
                }) {
                    bail!(
                        "{} 与已有模组或前置不兼容：{}",
                        candidate.name,
                        dep.project
                            .as_deref()
                            .or(dep.version.as_deref())
                            .unwrap_or("未知资源")
                    );
                }
                if let Some(name) = &dep.filename {
                    if self.inventory.files.iter().any(|file| {
                        !file.disabled
                            && Path::new(&file.path)
                                .file_name()
                                .is_some_and(|file| file == name.as_str())
                    }) {
                        bail!("{} 与本地文件 {name} 不兼容", candidate.name);
                    }
                }
            }
        }
        Ok(())
    }

    fn solve<'a>(
        &'a mut self,
        chosen: BTreeMap<String, Candidate>,
        mut pending: Vec<Dependency>,
    ) -> BoxFuture<'a, Result<BTreeMap<String, Candidate>>> {
        Box::pin(async move {
            self.attempts += 1;
            if self.attempts > 2048 || chosen.len() > 128 {
                bail!("依赖关系过于复杂，请在项目页面选择前置版本");
            }
            let Some(mut dependency) = pending.pop() else {
                self.conflicts(&chosen)?;
                return Ok(chosen);
            };
            if dependency.project.is_none() {
                if let Some(version) = &dependency.version {
                    let candidate = self.catalog.version(None, version).await?;
                    dependency.project = Some(candidate.project.clone());
                    self.versions
                        .insert((candidate.project.clone(), candidate.id.clone()), candidate);
                } else {
                    let filename = dependency
                        .filename
                        .as_deref()
                        .context("前置依赖没有有效身份")?;
                    valid_name(filename)?;
                    let matches = self
                        .inventory
                        .files
                        .iter()
                        .filter(|file| {
                            !file.disabled
                                && Path::new(&file.path)
                                    .file_name()
                                    .is_some_and(|name| name == filename)
                        })
                        .count();
                    if matches != 1 {
                        bail!("前置 {filename} 只有文件名，无法自动定位下载，请手动安装后重新检查");
                    }
                    return self.solve(chosen, pending).await;
                }
            }
            let project = dependency.project.as_ref().unwrap();
            if let Some(existing) = chosen.get(project) {
                if dependency
                    .version
                    .as_ref()
                    .is_some_and(|version| version != &existing.id)
                {
                    bail!("前置 {project} 被要求使用不同版本，无法同时满足");
                }
                // Already expanded nodes also stop cycles without dropping constraints.
                return self.solve(chosen, pending).await;
            }
            if !self.projects.contains_key(project) {
                self.projects
                    .insert(project.clone(), self.catalog.project(project).await?);
            }
            let metadata = self.projects[project].clone();
            folder(metadata.kind)
                .with_context(|| format!("前置 {} 无法自动安装", metadata.name))?;
            let local = self
                .installed
                .iter()
                .filter(|(_, candidate)| &candidate.project == project)
                .map(|(_, candidate)| candidate.clone())
                .collect::<Vec<_>>();
            let options = if let Some(version) = &dependency.version {
                let key = (project.clone(), version.clone());
                if !self.versions.contains_key(&key) {
                    self.versions.insert(
                        key.clone(),
                        self.catalog.version(Some(project), version).await?,
                    );
                }
                vec![self.versions[&key].clone()]
            } else if !local.is_empty() {
                // Existing versions are fixed: installing another version would create a duplicate.
                local
            } else {
                if !self.candidates.contains_key(project) {
                    self.candidates
                        .insert(project.clone(), self.catalog.versions(project).await?);
                }
                self.candidates[project].clone()
            };
            let mut failure = anyhow::anyhow!(
                "前置 {} 没有适配 Minecraft {} / {} 的可用版本",
                metadata.name,
                self.target.game_version,
                self.target.loader
            );
            for candidate in options {
                if candidate.project != *project {
                    bail!("依赖候选文件与项目不一致");
                }
                if !compatible(&candidate, metadata.kind, self.target) {
                    continue;
                }
                if candidate.file.sha1.is_none() && candidate.file.sha512.is_none() {
                    failure = anyhow::anyhow!("前置 {} 缺少可校验的文件哈希", metadata.name);
                    continue;
                }
                if let Err(error) = self.existing(&candidate) {
                    failure = error.context(metadata.name.clone());
                    continue;
                }
                let mut next = chosen.clone();
                next.insert(project.clone(), candidate.clone());
                let mut remaining = pending.clone();
                remaining.extend(candidate.required.clone());
                match self.solve(next, remaining).await {
                    Ok(solution) => return Ok(solution),
                    Err(error) => failure = error,
                }
            }
            Err(failure)
        })
    }
}

use super::{dependencies, local_projects, validate_id, Community};
use crate::resources::install::{Candidate, Catalog, Dependency, Inventory, ProjectMeta, Target};
use anyhow::{bail, Context, Result};
use futures_util::future::BoxFuture;
use serde_json::{json, Value};
use std::collections::HashMap;

pub struct RemoteCatalog<'a> {
    pub community: &'a Community,
    pub source: &'a str,
    pub target: &'a Target,
}

impl Catalog for RemoteCatalog<'_> {
    fn project<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<ProjectMeta>> {
        Box::pin(async move {
            validate_id(id)?;
            let value = if self.source == "modrinth" {
                self.community
                    .get(self.source, &format!("project/{id}"), &[])
                    .await?
            } else {
                self.community
                    .get(self.source, &format!("mods/{id}"), &[])
                    .await?["data"]
                    .clone()
            };
            let returned = identifier(&value["id"]).context("资源项目缺少 ID")?;
            if returned != id {
                bail!("资源平台返回了其他项目");
            }
            let kind = if self.source == "modrinth" {
                dependencies::modrinth_kind(&value)
            } else {
                if value["gameId"].as_u64().is_some_and(|id| id != 432) {
                    bail!("前置项目不属于 Minecraft");
                }
                dependencies::curseforge_kind(&value)
            };
            Ok(ProjectMeta {
                client_supported: value["client_side"] != "unsupported",
                name: value[if self.source == "modrinth" {
                    "title"
                } else {
                    "name"
                }]
                .as_str()
                .unwrap_or(id)
                .into(),
                kind,
            })
        })
    }

    fn version<'a>(
        &'a self,
        project: Option<&'a str>,
        id: &'a str,
    ) -> BoxFuture<'a, Result<Candidate>> {
        Box::pin(async move {
            validate_id(id)?;
            let value = if self.source == "modrinth" {
                self.community
                    .get(self.source, &format!("version/{id}"), &[])
                    .await?
            } else {
                let project = project.context("CurseForge 文件缺少项目 ID")?;
                validate_id(project)?;
                self.community
                    .get(self.source, &format!("mods/{project}/files/{id}"), &[])
                    .await?["data"]
                    .clone()
            };
            let candidate = parse(self.source, &value)?;
            if candidate.id != id || project.is_some_and(|project| project != candidate.project) {
                bail!("资源平台返回的文件与项目不一致");
            }
            Ok(candidate)
        })
    }

    fn versions<'a>(&'a self, project: &'a str, kind: super::ResourceKind) -> BoxFuture<'a, Result<Vec<Candidate>>> {
        Box::pin(async move {
            validate_id(project)?;
            let mut values = vec![];
            if self.source == "modrinth" {
                let params = vec![(
                    "game_versions".into(),
                    json!([self.target.game_version]).to_string(),
                )];
                let response = self
                    .community
                    .get(self.source, &format!("project/{project}/version"), &params)
                    .await?;
                values.extend(
                    response
                        .as_array()
                        .context("资源版本格式错误")?
                        .iter()
                        .cloned(),
                );
            } else {
                // Follow pagination: a compatible stable version need not be in the first page.
                let loader = match self.target.loader.to_lowercase().as_str() {
                    "forge" => "1",
                    "fabric" => "4",
                    "quilt" => "5",
                    "neoforge" => "6",
                    "liteloader" => "3",
                    _ => "0",
                };
                for offset in (0..1000).step_by(50) {
                    let mut params = vec![
                        ("pageSize".into(), "50".into()),
                        ("index".into(), offset.to_string()),
                        ("gameVersion".into(), self.target.game_version.clone()),
                    ];
                    if kind == super::ResourceKind::Mod {
                        params.push(("modLoaderType".into(), loader.into()));
                    }
                    let response = self
                        .community
                        .get(self.source, &format!("mods/{project}/files"), &params)
                        .await?;
                    let page = response["data"].as_array().context("资源文件格式错误")?;
                    values.extend(page.iter().cloned());
                    if page.len() < 50
                        || response["pagination"]["totalCount"]
                            .as_u64()
                            .is_some_and(|total| values.len() as u64 >= total)
                    {
                        break;
                    }
                    if offset == 950 {
                        bail!("前置版本过多，请在项目页面选择具体版本");
                    }
                }
            }
            let mut candidates = vec![];
            for value in values {
                let candidate = parse(self.source, &value)?;
                if candidate.project != project {
                    bail!("前置版本查询返回了其他项目的文件");
                }
                candidates.push(candidate);
            }
            candidates.sort_by(|a, b| {
                b.stable
                    .cmp(&a.stable)
                    .then_with(|| b.date.cmp(&a.date))
                    .then_with(|| a.id.cmp(&b.id))
            });
            Ok(candidates)
        })
    }
}

fn identifier(value: &Value) -> Option<String> {
    let id = value
        .as_str()
        .map(str::to_owned)
        .or_else(|| value.as_u64().filter(|id| *id > 0).map(|v| v.to_string()))?;
    validate_id(&id).ok()?;
    Some(id)
}

fn relation(value: &Value, source: &str) -> Result<Dependency> {
    let (project, version, filename) = if source == "modrinth" {
        (
            identifier(&value["project_id"]),
            identifier(&value["version_id"]),
            value["file_name"].as_str().map(str::to_owned),
        )
    } else {
        (identifier(&value["modId"]), None, None)
    };
    if project.is_none() && version.is_none() && filename.is_none() {
        bail!("前置依赖缺少有效的项目、版本或文件名，无法自动安装");
    }
    Ok(Dependency {
        project,
        version,
        filename,
    })
}

pub(super) fn parse(source: &str, value: &Value) -> Result<Candidate> {
    let (id, project) = if source == "modrinth" {
        (identifier(&value["id"]), identifier(&value["project_id"]))
    } else {
        (identifier(&value["id"]), identifier(&value["modId"]))
    };
    let project = project.context("资源文件缺少项目 ID")?;
    let file = if source == "modrinth" {
        super::modrinth_file(value)?
    } else {
        super::curseforge_file(value, &project)?
    };
    let mut required = vec![];
    let mut incompatible = vec![];
    for dep in value["dependencies"].as_array().into_iter().flatten() {
        let required_relation = if source == "modrinth" {
            dep["dependency_type"] == "required"
        } else {
            dep["relationType"] == 3
        };
        let conflict_relation = if source == "modrinth" {
            dep["dependency_type"] == "incompatible"
        } else {
            dep["relationType"] == 5
        };
        if required_relation {
            required.push(relation(dep, source)?);
        }
        if conflict_relation {
            incompatible.push(relation(dep, source)?);
        }
    }
    Ok(Candidate {
        id: id.context("资源文件缺少版本 ID")?,
        project,
        name: file.name,
        version: file.version,
        date: file.date,
        changelog: value["changelog"].as_str().unwrap_or_default().to_owned(),
        primary: source != "modrinth"
            || value["files"].as_array().is_some_and(|files| {
                files.len() == 1 || files.iter().filter(|f| f["primary"] == true).count() == 1
            }),
        game_versions: file.game_versions,
        loaders: file.loaders,
        file: file.file.context("资源文件缺少下载入口")?,
        required,
        incompatible,
        stable: if source == "modrinth" {
            value["version_type"] == "release"
        } else {
            value["releaseType"] == 1
        },
        client_supported: value["environment"] != "server"
            && value["isServerPack"] != true
            && !value["gameVersions"].as_array().is_some_and(|tags| {
                tags.iter().any(|tag| tag == "Server") && !tags.iter().any(|tag| tag == "Client")
            }),
    })
}

impl Community {
    pub(crate) fn install_catalog<'a>(
        &'a self,
        source: &'a str,
        target: &'a Target,
    ) -> Result<impl Catalog + 'a> {
        if !matches!(source, "modrinth" | "curseforge") {
            bail!("未知资源平台");
        }
        Ok(RemoteCatalog {
            community: self,
            source,
            target,
        })
    }

    /// Resolve CurseForge's canonical installation folders in batches for export.
    pub(crate) async fn export_curseforge_folders(&self, projects: &[u64]) -> Result<HashMap<String, String>> {
        let mut folders = HashMap::new();
        for batch in projects.chunks(50) {
            let response = self.request("curseforge", "mods", &[], Some(json!({"modIds":batch}))).await?;
            for project in response["data"].as_array().context("CurseForge 项目响应无效")? {
                let id = project["id"].as_u64().context("CurseForge 项目缺少 ID")?;
                if !batch.contains(&id) || project["gameId"].as_u64().is_some_and(|v| v != 432) { bail!("CurseForge 返回了其他游戏或项目"); }
                let folder = match project["classId"].as_u64() { Some(6) => "mods", Some(12) => "resourcepacks", Some(6552) => "shaderpacks", _ => continue };
                folders.insert(id.to_string(), folder.into());
            }
        }
        Ok(folders)
    }

    /// Match whole file identities, retaining the exact version (not just the project).
    pub(crate) async fn installed_versions(
        &self,
        source: &str,
        inventory: &Inventory,
    ) -> Result<HashMap<String, Candidate>> {
        let mut matches = HashMap::new();
        if inventory.files.is_empty() {
            return Ok(matches);
        }
        if source == "modrinth" {
            for files in inventory.files.chunks(100) {
                let hashes = files.iter().map(|file| &file.sha1).collect::<Vec<_>>();
                let response = self
                    .request(
                        source,
                        "version_files",
                        &[],
                        Some(json!({"hashes": hashes, "algorithm": "sha1"})),
                    )
                    .await?;
                let response = response.as_object().context("Modrinth 文件匹配响应无效")?;
                for file in files {
                    if let Some(value) = response.get(&file.sha1) {
                        let mut candidate = parse(source, value)?;
                        if let Some(actual) =
                            value["files"].as_array().into_iter().flatten().find(|v| {
                                v["hashes"]["sha1"]
                                    .as_str()
                                    .is_some_and(|h| h.eq_ignore_ascii_case(&file.sha1))
                            })
                        {
                            candidate.primary &= candidate
                                .file
                                .sha1
                                .as_ref()
                                .is_some_and(|hash| hash.eq_ignore_ascii_case(&file.sha1));
                            candidate.file = crate::downloads::DownloadSpec {
                                path: actual["filename"]
                                    .as_str()
                                    .context("本地匹配文件缺少文件名")?
                                    .into(),
                                url: actual["url"].as_str().unwrap_or("").into(),
                                size: actual["size"].as_u64(),
                                sha1: actual["hashes"]["sha1"].as_str().map(str::to_owned),
                                sha512: actual["hashes"]["sha512"].as_str().map(str::to_owned),
                            };
                            matches.insert(file.path.clone(), candidate);
                        }
                    }
                }
            }
        } else if source == "curseforge" {
            let mut ambiguous = std::collections::HashSet::new();
            for files in inventory.files.chunks(100) {
                let fingerprints = files
                    .iter()
                    .map(|file| file.fingerprint)
                    .collect::<Vec<_>>();
                let response = self
                    .request(
                        source,
                        "fingerprints/432",
                        &[],
                        Some(json!({"fingerprints": fingerprints})),
                    )
                    .await?;
                for matched in response["data"]["exactMatches"]
                    .as_array()
                    .context("CurseForge 文件匹配响应无效")?
                {
                    let value = &matched["file"];
                    let candidate = parse(source, value)?;
                    for file in files {
                        if candidate
                            .file
                            .sha1
                            .as_ref()
                            .is_some_and(|hash| hash.eq_ignore_ascii_case(&file.sha1))
                        {
                            if ambiguous.contains(&file.path) {
                                continue;
                            }
                            if matches.get(&file.path).is_some_and(|previous| {
                                previous.project != candidate.project || previous.id != candidate.id
                            }) {
                                matches.remove(&file.path);
                                ambiguous.insert(file.path.clone());
                            } else {
                                matches.insert(file.path.clone(), candidate.clone());
                            }
                        }
                    }
                }
            }
        } else {
            bail!("未知资源平台");
        }
        Ok(matches)
    }
}

pub(crate) fn identity(path: &std::path::Path) -> Result<(String, u32)> {
    let value = local_projects::identify_file(path)?;
    Ok((value.sha1, value.fingerprint))
}

pub(crate) fn mod_identity(
    game: &std::path::Path,
    path: &std::path::Path,
) -> Result<crate::resources::install::LocalFile> {
    let identity = local_projects::identify_mod(game, path)?;
    let path = path
        .strip_prefix(game)?
        .to_str()
        .context("无效的模组路径")?
        .replace('\\', "/");
    Ok(crate::resources::install::LocalFile {
        disabled: path.starts_with("mods/.disabled/") || path.ends_with(".disabled"),
        path,
        sha1: identity.sha1,
        fingerprint: identity.fingerprint,
        mod_ids: vec![],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installation_preserves_conflicting_pins_and_ignores_optional_embedded() {
        let value = json!({"id":"version","project_id":"project","files":[{"filename":"a.jar","url":"https://example.com/a.jar"}],
        "dependencies":[
            {"dependency_type":"required","project_id":"lib","version_id":"v1"},
            {"dependency_type":"required","project_id":"lib","version_id":"v2"},
            {"dependency_type":"optional","project_id":"optional"},
            {"dependency_type":"embedded","project_id":"embedded"},
            {"dependency_type":"incompatible","project_id":"bad"}
        ]});
        let parsed = parse("modrinth", &value).unwrap();
        assert_eq!(parsed.required.len(), 2);
        assert_eq!(parsed.incompatible[0].project.as_deref(), Some("bad"));
    }

    #[test]
    fn malformed_required_dependency_is_not_silently_dropped() {
        let value = json!({"id":12,"modId":34,"fileName":"a.jar","dependencies":[{"relationType":3,"modId":0}]});
        assert!(parse("curseforge", &value).is_err());
    }
}

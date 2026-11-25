use super::*;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Discovery {
    pub status: String,
    pub message: String,
    pub current_origin: Option<Origin>,
    pub target_origin: Option<Origin>,
    pub current: Option<Release>,
    pub target: Option<Release>,
    pub include_optional: bool,
    pub infer_optional: bool,
}
impl Discovery {
    fn local(message: impl Into<String>) -> Self {
        Self {
            status: "local".into(),
            message: message.into(),
            current_origin: None,
            target_origin: None,
            current: None,
            target: None,
            include_optional: false,
            infer_optional: false,
        }
    }
}

pub(super) fn normalized_name(value: &str) -> String {
    value
        .chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}
fn version_matches(release: &Release, name: &str, installed: &str) -> bool {
    let normalize = |v: &str| {
        let v = v.trim();
        let v = if v.starts_with(['v', 'V']) && v.chars().nth(1).is_some_and(|c| c.is_ascii_digit())
        {
            &v[1..]
        } else {
            v
        };
        v.to_lowercase()
            .chars()
            .filter(|c| !c.is_whitespace())
            .collect::<String>()
    };
    let installed = normalize(installed);
    if installed.is_empty() {
        return false;
    }
    if normalize(&release.version) == installed {
        return true;
    }
    let title = normalized_name(name);
    let mut prefix = String::new();
    for (index, ch) in release.version.char_indices() {
        if ch.is_alphanumeric() {
            prefix.extend(ch.to_lowercase());
        }
        if !title.starts_with(&prefix) {
            return false;
        }
        if prefix == title {
            let suffix =
                release.version[index + ch.len_utf8()..].trim_start_matches([' ', '-', '_', ':']);
            return normalize(suffix) == installed;
        }
    }
    false
}

async fn from_project(
    community: &Community,
    source: &str,
    project: &str,
    current_id: Option<&str>,
    name: &str,
    version: &str,
    optional: bool,
    legacy: bool,
) -> Result<Option<Discovery>> {
    let releases = community.modpack_releases(source, project).await?;
    let current = if let Some(id) = current_id {
        match releases.iter().find(|r| r.id == id) {
            Some(item) => item.clone(),
            None => {
                community
                    .modpack_release(&Origin {
                        source: source.into(),
                        project_id: project.into(),
                        version_id: id.into(),
                    })
                    .await?
            }
        }
    } else {
        let matching: Vec<_> = releases
            .iter()
            .filter(|r| version_matches(r, name, version))
            .collect();
        if matching.len() != 1 {
            return Ok(None);
        }
        matching[0].clone()
    };
    let newer = releases
        .iter()
        .find(|r| r.stable && r.id != current.id && r.date > current.date)
        .cloned();
    let origin = |id: &str| Origin {
        source: source.into(),
        project_id: project.into(),
        version_id: id.into(),
    };
    Ok(Some(Discovery {
        status: if newer.is_some() {
            "online"
        } else {
            "upToDate"
        }
        .into(),
        message: if newer.is_some() {
            format!(
                "已找到 {} 在线整合包，自动检查新版文件变化。",
                if source == "modrinth" {
                    "Modrinth"
                } else {
                    "CurseForge"
                }
            )
        } else {
            "当前已是最新正式版本。".into()
        },
        current_origin: Some(origin(&current.id)),
        target_origin: newer.as_ref().map(|r| origin(&r.id)),
        current: Some(current),
        target: newer,
        include_optional: optional,
        infer_optional: legacy,
    }))
}

pub async fn discover(root: &Path, id: &str, community: &Community) -> Result<Discovery> {
    let target = instance(root, id)?;
    let record = record::read(&target)?;
    let profile = versions::resolve(root, id)?;
    if transaction::history(root, id)?
        .iter()
        .any(|r| r["state"] == "applying" || r["state"] == "recovery_failed")
    {
        return Ok(Discovery::local(
            "请先恢复未完成的整合包更新，再重新检查在线版本。",
        ));
    }
    let name = record
        .as_ref()
        .map(|r| r.name.as_str())
        .or(profile["tmclModpack"]["name"].as_str())
        .unwrap_or("");
    let version = record
        .as_ref()
        .map(|r| r.version.as_str())
        .or(profile["tmclModpack"]["version"].as_str())
        .unwrap_or("");
    let optional = record.as_ref().is_some_and(|r| r.include_optional);
    if let Some(origin) = record.as_ref().and_then(|r| r.origin.as_ref()) {
        return match from_project(
            community,
            &origin.source,
            &origin.project_id,
            Some(&origin.version_id),
            name,
            version,
            optional,
            false,
        )
        .await
        {
            Ok(Some(found)) => Ok(found),
            _ => Ok(Discovery::local(
                "暂时无法查询已记录的在线来源，已进入本地更新；可以重新检查在线版本。",
            )),
        };
    }
    if normalized_name(name).is_empty() || version.trim().is_empty() {
        return Ok(Discovery::local(
            "未找到可识别的在线整合包信息，请选择本地新版包。",
        ));
    }
    let format = record
        .as_ref()
        .map(|r| r.format.as_str())
        .or(profile["tmclModpack"]["format"].as_str())
        .unwrap_or("");
    let sources = if format == "CurseForge" {
        ["curseforge", "modrinth"]
    } else {
        ["modrinth", "curseforge"]
    };
    let mut query_failed = false;
    for source in sources {
        let candidates = match community.modpack_candidates(source, name).await {
            Ok(values) => values,
            Err(_) => {
                query_failed = true;
                continue;
            }
        };
        let exact: Vec<_> = candidates
            .into_iter()
            .filter(|p| normalized_name(&p.title) == normalized_name(name))
            .collect();
        if exact.len() > 1 {
            return Ok(Discovery::local(
                "在线找到多个同名整合包，无法确认来源，已进入本地更新。",
            ));
        }
        if let Some(project) = exact.first() {
            match from_project(
                community,
                source,
                &project.id,
                None,
                name,
                version,
                optional,
                record.is_none(),
            )
            .await
            {
                Ok(Some(found)) => return Ok(found),
                Ok(None) => {}
                Err(_) => query_failed = true,
            }
        }
    }
    Ok(Discovery::local(if query_failed {
        "在线来源未能完成匹配或查询，已进入本地更新；可以重新检查在线版本。"
    } else {
        "未找到匹配的在线整合包及当前版本，已进入本地更新。"
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn release(version: &str) -> Release {
        Release {
            id: "id".into(),
            name: "Test Pack".into(),
            version: version.into(),
            date: "2026-11-25".into(),
            game_versions: vec![],
            loaders: vec![],
            stable: true,
            file: DownloadSpec {
                url: "https://example.com/pack".into(),
                path: "pack.mrpack".into(),
                size: None,
                sha1: None,
                sha512: None,
            },
        }
    }
    #[test]
    fn matches_names_and_exact_versions_without_substring_version_guesses() {
        assert_eq!(normalized_name("Test-Pack"), normalized_name("Test Pack"));
        assert!(version_matches(&release("v1.2.3"), "Test Pack", "1.2.3"));
        assert!(version_matches(
            &release("Test Pack - v1.2.3"),
            "Test Pack",
            "1.2.3"
        ));
        assert!(!version_matches(
            &release("Test Pack 1.2.30"),
            "Test Pack",
            "1.2.3"
        ));
        assert!(!version_matches(
            &release("Other Pack 1.2.3"),
            "Test Pack",
            "1.2.3"
        ));
        assert!(!version_matches(
            &release("Test Pack 12.3"),
            "Test Pack",
            "1.2.3"
        ));
    }
}

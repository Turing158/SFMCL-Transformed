use super::*;
use crate::resources::community::install_metadata;
use std::collections::VecDeque;
use tokio::sync::OnceCell;

const CACHE_TTL: Duration = Duration::from_secs(300);

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum ModUpdate {
    Unidentified,
    Latest,
    NoCompatibleRelease,
    Available {
        token: String,
        source: String,
        current: String,
        version: String,
        changelog: String,
    },
}

#[derive(Clone)]
pub(super) struct UpdateChoice {
    pub path: String,
    pub sha1: String,
    pub current_id: String,
    pub release: Candidate,
}

impl UpdateChoice {
    pub(super) fn same_file(&self, current: &DownloadSpec) -> bool {
        // The platform may issue a new CDN URL between discovery and confirmation.
        let checked = &self.release.file;
        for (before, now) in [
            (&checked.sha512, &current.sha512),
            (&checked.sha1, &current.sha1),
        ] {
            if let Some(before) = before {
                if !now
                    .as_ref()
                    .is_some_and(|now| now.eq_ignore_ascii_case(before))
                {
                    return false;
                }
            }
        }
        checked.sha512.is_some() || checked.sha1.is_some()
    }
}

struct Checked {
    result: ModUpdate,
    source: Option<String>,
    choice: Option<UpdateChoice>,
    time: Instant,
}

struct Entry {
    target: Target,
    path: String,
    sha1: String,
    preferred: Option<String>,
    cell: Arc<OnceCell<Checked>>,
}

#[derive(Default)]
pub(super) struct UpdateCache(Mutex<VecDeque<Entry>>);

impl UpdateCache {
    fn entry(
        &self,
        target: &Target,
        file: &LocalFile,
        preferred: Option<String>,
    ) -> Arc<OnceCell<Checked>> {
        let mut entries = self.0.lock().unwrap_or_else(|e| e.into_inner());
        entries.retain(|e| e.cell.get().is_none_or(|c| c.time.elapsed() < CACHE_TTL));
        if let Some(e) = entries.iter().find(|e| {
            e.path == file.path
                && e.sha1 == file.sha1
                && e.target == *target
                && (e.preferred == preferred || e.cell.get().is_none_or(|c| c.source == preferred))
        }) {
            return e.cell.clone();
        }
        if entries.len() >= 64 {
            if let Some(index) = entries.iter().position(|e| Arc::strong_count(&e.cell) == 1) {
                entries.remove(index);
            }
        }
        let cell = Arc::new(OnceCell::new());
        entries.push_back(Entry {
            target: target.clone(),
            path: file.path.clone(),
            sha1: file.sha1.clone(),
            preferred,
            cell: cell.clone(),
        });
        cell
    }

    fn choice(&self, target: &Target, token: &str) -> Result<(String, UpdateChoice)> {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .filter(|entry| entry.target == *target)
            .filter_map(|entry| entry.cell.get())
            .find_map(|checked| match &checked.result {
                ModUpdate::Available {
                    token: id, source, ..
                } if id == token => Some((source.clone(), checked.choice.clone()?)),
                _ => None,
            })
            .context("检查结果已失效，请重新点击更新")
    }
}

fn published(candidate: &Candidate) -> Result<chrono::DateTime<chrono::FixedOffset>> {
    chrono::DateTime::parse_from_rfc3339(&candidate.date).context("无法确定模组文件的发布时间")
}

fn release_number(value: &str) -> Option<semver::Version> {
    let value = value.trim().trim_start_matches('v');
    semver::Version::parse(value).ok().or_else(|| {
        let parts: Vec<_> = value.split('.').collect();
        if parts.len() > 2
            || !parts
                .iter()
                .all(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
        {
            return None;
        }
        semver::Version::parse(&format!("{value}{}", ".0".repeat(3 - parts.len()))).ok()
    })
}

fn newest(
    current: &Candidate,
    versions: Vec<Candidate>,
    target: &Target,
) -> Result<Option<Candidate>> {
    let since = published(current)?;
    let number = release_number(&current.version);
    let mut latest = None;
    for release in versions {
        if !release.stable
            || !release.primary
            || !resolver::compatible(&release, ResourceKind::Mod, target)
            || !release.file.path.to_ascii_lowercase().ends_with(".jar")
            || release.file.sha1.is_none() && release.file.sha512.is_none()
        {
            continue;
        }
        let same_bytes = release
            .file
            .sha1
            .as_ref()
            .zip(current.file.sha1.as_ref())
            .is_some_and(|(a, b)| a.eq_ignore_ascii_case(b));
        if release.id == current.id || same_bytes {
            continue;
        }
        let order = release_number(&release.version)
            .zip(number.as_ref())
            .map(|(new, old)| new.cmp_precedence(old));
        let same_version = order.is_some_and(|v| v.is_eq()) || release.version == current.version;
        if order.is_some_and(|v| v.is_lt()) || (current.stable && same_version) {
            continue;
        }
        let date = published(&release)?;
        if date > since && latest.as_ref().is_none_or(|(best, _)| date > *best) {
            latest = Some((date, release));
        }
    }
    Ok(latest.map(|(_, candidate)| candidate))
}

impl ModInstaller {
    pub async fn check_update(
        &self,
        community: &Community,
        target: Target,
        path: PathBuf,
    ) -> Result<ModUpdate> {
        let game = target.game.clone();
        let file =
            tokio::task::spawn_blocking(move || install_metadata::mod_identity(&game, &path))
                .await??;
        let preferred = community.mod_source(&file.sha1);
        let cell = self.checks.entry(&target, &file, preferred.clone());
        let checked = cell
            .get_or_try_init(|| async {
                let (result, source, choice) = tokio::time::timeout(
                    Duration::from_secs(90),
                    discover(community, &target, file, preferred.as_deref()),
                )
                .await
                .context("检查模组更新超时")??;
                Ok::<_, anyhow::Error>(Checked {
                    result,
                    source,
                    choice,
                    time: Instant::now(),
                })
            })
            .await?;
        Ok(checked.result.clone())
    }

    pub async fn preview_update(
        &self,
        community: &Community,
        target: Target,
        token: &str,
        settings: &crate::config::Settings,
    ) -> Result<InstallPlan> {
        let (source, choice) = self.checks.choice(&target, token)?;
        let mut shared = vec![];
        let mut uncertain = vec![];
        if target.game == target.root {
            for version in crate::minecraft::versions::scan(&target.root)? {
                match crate::minecraft::version_settings::game_directory(
                    &target.root,
                    &version.id,
                    settings,
                ) {
                    Ok(game) if game == target.game => shared.push(version.id),
                    Err(_) => uncertain.push(version.id),
                    _ => {}
                }
            }
        }
        let mut plan = self
            .prepare(
                community,
                &source,
                &choice.release.project,
                &choice.release.id,
                target,
                Some(&choice),
            )
            .await?;
        if shared.len() > 1 {
            plan.warnings.push(format!(
                "以下实例共用 mods 目录，更新将影响：{}",
                shared.join("、")
            ));
        }
        if !uncertain.is_empty() {
            plan.warnings.push(format!(
                "以下实例的隔离设置无法读取，可能也使用此 mods 目录：{}",
                uncertain.join("、")
            ));
        }
        Ok(plan)
    }
}

async fn discover(
    community: &Community,
    target: &Target,
    file: LocalFile,
    preferred: Option<&str>,
) -> Result<(ModUpdate, Option<String>, Option<UpdateChoice>)> {
    let sources = if preferred == Some("curseforge") {
        ["curseforge", "modrinth"]
    } else {
        ["modrinth", "curseforge"]
    };
    let inventory = Inventory {
        files: vec![file.clone()],
    };
    let mut failure = None;
    for source in sources {
        let current = match community.installed_versions(source, &inventory).await {
            Ok(mut found) => match found.remove(&file.path) {
                Some(c) => c,
                None => continue,
            },
            Err(error) => {
                failure = Some(error);
                continue;
            }
        };
        let catalog = community.install_catalog(source, target)?;
        let project = catalog.project(&current.project).await?;
        let known = Some(source.to_owned());
        community.remember_mod_source(&file.sha1, source);
        if !current.primary || project.kind != ResourceKind::Mod || !project.client_supported {
            return Ok((ModUpdate::NoCompatibleRelease, known, None));
        }
        let versions = catalog.versions(&current.project, project.kind).await?;
        if let Some(release) = newest(&current, versions, target)? {
            let result = ModUpdate::Available {
                token: uuid::Uuid::new_v4().to_string(),
                source: source.into(),
                current: if current.version == release.version && !current.stable {
                    format!("{}（预发布版）", current.version)
                } else {
                    current.version
                },
                version: release.version.clone(),
                changelog: community.mod_changelog(source, &release).await?,
            };
            let choice = UpdateChoice {
                path: file.path,
                sha1: file.sha1,
                current_id: current.id,
                release,
            };
            return Ok((result, known, Some(choice)));
        }
        let latest = current.stable && resolver::compatible(&current, ResourceKind::Mod, target);
        return Ok((
            if latest {
                ModUpdate::Latest
            } else {
                ModUpdate::NoCompatibleRelease
            },
            known,
            None,
        ));
    }
    if let Some(error) = failure {
        return Err(error);
    }
    Ok((ModUpdate::Unidentified, None, None))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expired_result_is_replaced_on_the_next_lookup() {
        let cache = UpdateCache::default();
        let target = Target {
            root: "root".into(),
            version_id: "test".into(),
            game: "game".into(),
            game_version: "1.20.1".into(),
            loader: "Fabric".into(),
            environment: "test".into(),
        };
        let file = LocalFile {
            path: "mods/test.jar".into(),
            sha1: "a".repeat(40),
            fingerprint: 1,
            disabled: false,
            mod_ids: vec![],
        };
        let expired = cache.entry(&target, &file, None);
        assert!(expired
            .set(Checked {
                result: ModUpdate::Latest,
                source: Some("modrinth".into()),
                time: Instant::now() - CACHE_TTL,
                choice: None
            })
            .is_ok());
        let fresh = cache.entry(&target, &file, None);
        assert!(!Arc::ptr_eq(&expired, &fresh));
        assert!(fresh.get().is_none());
        assert!(Arc::ptr_eq(&fresh, &cache.entry(&target, &file, None)));
        let changed = LocalFile {
            sha1: "b".repeat(40),
            ..file
        };
        assert!(!Arc::ptr_eq(&fresh, &cache.entry(&target, &changed, None)));
    }
}

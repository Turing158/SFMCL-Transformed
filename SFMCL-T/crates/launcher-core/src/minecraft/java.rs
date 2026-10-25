use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::process::Command;

#[cfg(windows)]
mod registry;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Java {
    pub path: String,
    pub version: String,
    pub major: u32,
    pub architecture: String,
}

pub fn command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    command.kill_on_drop(true);
    command
}
pub fn executable(path: &str) -> PathBuf {
    let p = Path::new(path);
    if p.is_dir() {
        p.join("bin")
            .join(if cfg!(windows) { "java.exe" } else { "java" })
    } else {
        p.into()
    }
}
pub fn parse_version(text: &str) -> Option<(String, u32)> {
    let regex = regex::Regex::new(r#"(?:version\s+\"|openjdk\s+)([0-9][^\"\s]*)"#).ok()?;
    let version = regex.captures(text)?.get(1)?.as_str().to_owned();
    let mut parts = version.split(['.', '-', '_']);
    let first: u32 = parts.next()?.parse().ok()?;
    let major = if first == 1 {
        parts.next()?.parse().ok()?
    } else {
        first
    };
    Some((version, major))
}
pub async fn probe(path: &str) -> Result<Java> {
    let path = executable(path);
    let output = tokio::time::timeout(
        Duration::from_secs(8),
        command(&path)
            .args(["-XshowSettings:properties", "-version"])
            .stdin(Stdio::null())
            .output(),
    )
    .await
    .context("Java 探测超时")??;
    if !output.status.success() {
        bail!("无法运行所选 Java");
    }
    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let (version, major) = parse_version(&text).context("无法识别 Java 版本")?;
    let architecture = if text.contains("aarch64") {
        "arm64"
    } else if text.contains("amd64") || text.contains("64-Bit") {
        "x64"
    } else {
        "x86"
    };
    Ok(Java {
        path: path.to_string_lossy().into_owned(),
        version,
        major,
        architecture: architecture.into(),
    })
}
pub async fn discover(configured: &[String]) -> Vec<Java> {
    let mut candidates = configured.to_vec();
    #[cfg(windows)]
    candidates.extend(
        tokio::task::spawn_blocking(registry::java_homes)
            .await
            .unwrap_or_default(),
    );
    if let Ok(home) = std::env::var("JAVA_HOME") {
        candidates.push(home);
    }
    if let Some(paths) = std::env::var_os("PATH") {
        for path in std::env::split_paths(&paths) {
            let java = path.join(if cfg!(windows) { "java.exe" } else { "java" });
            if java.is_file() {
                candidates.push(java.to_string_lossy().into_owned());
            }
        }
    }
    let mut roots = Vec::new();
    for name in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
        if let Some(path) = std::env::var_os(name) {
            for vendor in [
                "Java",
                "Eclipse Adoptium",
                "Microsoft",
                "Zulu",
                "BellSoft",
                "Programs/Eclipse Adoptium",
            ] {
                roots.push(PathBuf::from(&path).join(vendor));
            }
        }
    }
    if let Some(user) = std::env::var_os("USERPROFILE") {
        roots.push(PathBuf::from(user).join(".jdks"));
    }
    for root in roots {
        if let Ok(entries) = std::fs::read_dir(root) {
            for entry in entries.flatten() {
                let path = executable(&entry.path().to_string_lossy());
                if path.is_file() {
                    candidates.push(path.to_string_lossy().into_owned());
                }
            }
        }
    }
    inspect(&candidates).await
}

/// Refresh saved entries without discovering installations the user removed.
pub async fn inspect(paths: &[String]) -> Vec<Java> {
    let mut result = Vec::new();
    use futures_util::{stream, StreamExt};
    let mut probes = stream::iter(unique_executables(paths.to_vec()))
        .map(|path| async move { probe(&path.to_string_lossy()).await })
        .buffer_unordered(4);
    while let Some(probe) = probes.next().await {
        if let Ok(java) = probe {
            result.push(java);
        }
    }
    result.sort_by_key(|j| std::cmp::Reverse(j.major));
    result
}

fn saved_path_key(path: &str) -> String {
    #[cfg(windows)]
    return path.replace('\\', "/").to_lowercase();
    #[cfg(not(windows))]
    path.into()
}

/// Persist just the runtime list, without saving unrelated game-setting drafts.
pub fn save_paths(
    store: &crate::config::ConfigStore,
    version: Option<(&Path, &str)>,
    paths: Vec<String>,
    removed: Option<&str>,
) -> Result<Vec<String>> {
    let mut seen = HashSet::new();
    let removed = removed.filter(|path| !path.is_empty()).map(saved_path_key);
    let paths: Vec<_> = paths
        .into_iter()
        .filter(|path| !path.trim().is_empty())
        .filter(|path| {
            let key = saved_path_key(path);
            removed.as_ref() != Some(&key) && seen.insert(key)
        })
        .collect();
    let should_clear = |selected: &str| removed.as_ref() == Some(&saved_path_key(selected));
    if let Some((root, id)) = version {
        let mut config = super::version_settings::load(root, id, &store.get())?;
        config.settings.java_paths = paths.clone();
        if should_clear(&config.settings.java_path) {
            config.settings.java_path.clear();
        }
        super::version_settings::save(root, id, &config)?;
    } else {
        store.update(|settings| {
            settings.java_paths = paths.clone();
            if should_clear(&settings.java_path) {
                settings.java_path.clear();
            }
        })?;
    }
    Ok(paths)
}

fn unique_executables(candidates: Vec<String>) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    candidates
        .into_iter()
        .map(|candidate| executable(&candidate))
        .filter(|path| path.is_file())
        .filter(|path| {
            // Registry version aliases, JAVA_HOME and PATH can name the same JVM.
            let resolved = path.canonicalize().unwrap_or_else(|_| path.clone());
            #[cfg(windows)]
            let resolved = resolved.to_string_lossy().to_lowercase();
            seen.insert(resolved)
        })
        .collect()
}

pub async fn select(configured: &str, paths: &[String], required: u32) -> Result<Java> {
    if !configured.is_empty() {
        let java = probe(configured).await?;
        if java.major < required {
            bail!("游戏需要 Java {required}，所选 Java 是 {}", java.major);
        }
        return Ok(java);
    }
    let discovered = discover(paths).await;
    discovered
        .iter()
        .find(|j| j.major == required)
        .or_else(|| {
            discovered
                .iter()
                .filter(|j| j.major >= required)
                .min_by_key(|j| j.major)
        })
        .cloned()
        .with_context(|| format!("找不到 Java {required}，请在设置中添加兼容 Java"))
}
pub fn available_memory_mb() -> u64 {
    // Heap sizing only needs memory; avoid collecting processes and CPU details.
    let mut system = sysinfo::System::new();
    system.refresh_memory();
    system.available_memory() / (1024 * 1024)
}

pub fn memory_mb(auto: bool, requested: u64) -> u64 {
    if !auto {
        return requested;
    }
    (available_memory_mb() * 2 / 3).clamp(1024, 8192)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{config::ConfigStore, minecraft::version_settings};

    #[test]
    fn saved_list_survives_reopen_and_removing_selection_keeps_the_installation() {
        let temp = tempfile::tempdir().unwrap();
        let store = ConfigStore::open(temp.path()).unwrap();
        let java = temp.path().join("java.exe");
        std::fs::write(&java, b"runtime fixture").unwrap();
        let path = java.to_string_lossy().into_owned();
        store
            .update(|s| {
                s.java_path = path.clone();
                s.memory_mb = 6144;
                s.window_title = "Keep my settings".into();
            })
            .unwrap();
        let original = store.get();
        let mut paths = vec![path.clone(), path.clone(), "  ".into()];
        #[cfg(windows)]
        paths.push(path.replace('\\', "/").to_uppercase());
        assert_eq!(
            save_paths(&store, None, paths, None).unwrap(),
            vec![path.clone()]
        );
        let reopened = ConfigStore::open(temp.path()).unwrap();
        assert_eq!(reopened.get().java_paths, vec![path.clone()]);
        assert_eq!(reopened.get().java_path, path);
        // Removing another entry must not reset a manually selected runtime.
        save_paths(&reopened, None, vec![path.clone()], Some("other-java.exe")).unwrap();
        assert_eq!(reopened.get().java_path, path);
        #[cfg(windows)]
        let removed = path.replace('\\', "/").to_uppercase();
        #[cfg(not(windows))]
        let removed = path.clone();
        assert!(save_paths(&reopened, None, vec![path], Some(&removed))
            .unwrap()
            .is_empty());
        let mut expected = original;
        expected.java_path.clear();
        assert_eq!(
            serde_json::to_value(ConfigStore::open(temp.path()).unwrap().get()).unwrap(),
            serde_json::to_value(expected).unwrap()
        );
        assert_eq!(std::fs::read(java).unwrap(), b"runtime fixture");
    }

    #[test]
    fn version_list_is_persisted_without_changing_scope_or_other_settings() {
        let temp = tempfile::tempdir().unwrap();
        let store = ConfigStore::open(temp.path()).unwrap();
        let global = store
            .update(|s| {
                s.java_path = "global-java.exe".into();
                s.java_paths = vec![s.java_path.clone()];
            })
            .unwrap();
        for id in ["version-a", "version-b"] {
            let version = temp.path().join("versions").join(id);
            std::fs::create_dir_all(&version).unwrap();
            std::fs::write(version.join(format!("{id}.json")), b"{}").unwrap();
        }
        let mut config = version_settings::load(temp.path(), "version-a", &global).unwrap();
        config.use_global = false;
        config.independent_groups = Some(version_settings::GameSettingGroups {
            java: true,
            memory: true,
            ..Default::default()
        });
        config.settings.java_path = "version-java.exe".into();
        config.settings.memory_mb = 8192;
        version_settings::save(temp.path(), "version-a", &config).unwrap();
        version_settings::save(temp.path(), "version-b", &config).unwrap();
        let before = serde_json::to_value(&config).unwrap();
        save_paths(
            &store,
            Some((temp.path(), "version-a")),
            vec!["version-java.exe".into(), "jdk-new.exe".into()],
            None,
        )
        .unwrap();
        let saved = version_settings::load(temp.path(), "version-a", &global).unwrap();
        assert_eq!(
            saved.settings.java_paths,
            vec!["version-java.exe", "jdk-new.exe"]
        );
        save_paths(
            &store,
            Some((temp.path(), "version-a")),
            vec!["jdk-new.exe".into()],
            Some("version-java.exe"),
        )
        .unwrap();
        config.settings.java_path.clear();
        config.settings.java_paths = vec!["jdk-new.exe".into()];
        assert_eq!(
            serde_json::to_value(
                version_settings::load(temp.path(), "version-a", &global).unwrap()
            )
            .unwrap(),
            serde_json::to_value(config).unwrap()
        );
        assert_eq!(
            serde_json::to_value(
                version_settings::load(temp.path(), "version-b", &global).unwrap()
            )
            .unwrap(),
            before
        );
        assert_eq!(
            serde_json::to_value(store.get()).unwrap(),
            serde_json::to_value(global).unwrap()
        );
    }

    #[test]
    fn failed_list_save_does_not_change_the_in_memory_configuration() {
        let temp = tempfile::tempdir().unwrap();
        let blocker = temp.path().join("not-a-directory");
        std::fs::write(&blocker, b"keep").unwrap();
        let store = ConfigStore::open(&blocker).unwrap();
        let before = serde_json::to_value(store.get()).unwrap();
        assert!(save_paths(&store, None, vec!["java.exe".into()], None).is_err());
        assert_eq!(serde_json::to_value(store.get()).unwrap(), before);
        assert_eq!(std::fs::read(blocker).unwrap(), b"keep");
    }

    #[tokio::test]
    async fn reading_an_empty_saved_list_does_not_discover_installed_java() {
        assert!(inspect(&[]).await.is_empty());
    }

    #[test]
    fn discovery_deduplicates_homes_and_executables_and_skips_stale_paths() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("Java 安装 with spaces");
        std::fs::create_dir_all(home.join("bin")).unwrap();
        let java = executable(&home.to_string_lossy());
        std::fs::write(&java, b"fixture").unwrap();
        let candidates = vec![
            home.to_string_lossy().into_owned(),
            java.to_string_lossy().into_owned(),
            home.join(".").to_string_lossy().into_owned(),
            temp.path()
                .join("uninstalled-jdk")
                .to_string_lossy()
                .into_owned(),
        ];
        #[cfg(windows)]
        let candidates = {
            let mut candidates = candidates;
            candidates.push(java.to_string_lossy().to_uppercase());
            candidates.push(java.to_string_lossy().replace('\\', "/"));
            candidates
        };
        assert_eq!(unique_executables(candidates), vec![java]);
    }
}

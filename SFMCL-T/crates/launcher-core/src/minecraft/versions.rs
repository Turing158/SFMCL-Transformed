use crate::{
    config::Settings,
    downloads::DownloadSpec,
    paths::{atomic_write, safe_join, valid_name},
};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    io::Read,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionInfo {
    pub id: String,
    pub version: String,
    pub kind: String,
    pub loader: String,
    pub path: String,
    pub java_major: u32,
    pub icon: String,
    #[serde(default)]
    pub favorite: bool,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FavoriteVersionInfo {
    #[serde(flatten)]
    pub version: VersionInfo,
    pub directory: String,
    pub directory_name: String,
}

pub fn favorites(settings: &Settings) -> Vec<FavoriteVersionInfo> {
    let mut result = vec![];
    let mut roots = HashSet::new();
    for directory in &settings.game_dirs {
        let Ok(root) = settings.registered_game_root(Path::new(&directory.path)) else {
            continue;
        };
        // Legacy .minecraft entries may refer to an already registered parent.
        if !roots.insert(root.clone()) {
            continue;
        }
        let entries = match scan(&root) {
            Ok(entries) => entries,
            Err(error) => {
                eprintln!("Cannot read favorites in {}: {error:#}", directory.path);
                continue;
            }
        };
        result.extend(
            entries
                .into_iter()
                .filter(|version| version.favorite)
                .map(|version| FavoriteVersionInfo {
                    version,
                    directory: directory.path.clone(),
                    directory_name: directory.name.clone(),
                }),
        );
    }
    result
}

pub fn resolve(root: &Path, id: &str) -> Result<Value> {
    fn visit(root: &Path, id: &str, seen: &mut HashSet<String>) -> Result<Value> {
        valid_name(id)?;
        if seen.len() >= 32 || !seen.insert(id.to_owned()) {
            bail!("版本继承循环或层数过多：{id}");
        }
        let path = safe_join(root, format!("versions/{id}/{id}.json"))?;
        let mut child: Value = serde_json::from_slice(
            &std::fs::read(path).with_context(|| format!("找不到版本 {id} 的 JSON"))?,
        )?;
        if let Some(parent) = child["inheritsFrom"].as_str() {
            let parent = visit(root, parent, seen)?;
            child = merge(&parent, &child);
        } else if child["jar"].is_null() {
            child["jar"] = json!(id);
        }
        seen.remove(id);
        Ok(child)
    }
    visit(root, id, &mut HashSet::new())
}

pub fn merge(parent: &Value, child: &Value) -> Value {
    let mut merged = parent.clone();
    if let Some(properties) = child.as_object() {
        for (key, value) in properties {
            match key.as_str() {
                "libraries" => {
                    let mut libraries = merged[key].as_array().cloned().unwrap_or_default();
                    libraries.extend(value.as_array().cloned().unwrap_or_default());
                    merged[key] = json!(libraries);
                }
                "arguments" => {
                    if !merged[key].is_object() {
                        merged[key] = json!({});
                    }
                    for category in ["game", "jvm"] {
                        let mut args = merged[key][category]
                            .as_array()
                            .cloned()
                            .unwrap_or_default();
                        args.extend(value[category].as_array().cloned().unwrap_or_default());
                        merged[key][category] = json!(args);
                    }
                }
                _ => merged[key] = value.clone(),
            }
        }
    }
    merged
}

pub fn os_name() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "osx"
    } else {
        "linux"
    }
}
pub fn rules_allow(rules: &Value, features: &HashMap<String, bool>) -> bool {
    let Some(rules) = rules.as_array() else {
        return true;
    };
    let mut allowed = false;
    for rule in rules {
        let os = &rule["os"];
        if os["name"].as_str().is_some_and(|name| name != os_name()) {
            continue;
        }
        if let Some(arch) = os["arch"].as_str() {
            let actual = std::env::consts::ARCH;
            let matches = match arch {
                "x86" => actual == "x86",
                "x86_64" | "amd64" | "x64" => actual == "x86_64",
                "aarch64" | "arm64" => actual == "aarch64",
                _ => false,
            };
            if !matches {
                continue;
            }
        }
        if let Some(version) = os["version"].as_str() {
            let host = sysinfo::System::os_version().unwrap_or_default();
            if !regex::Regex::new(version).is_ok_and(|re| re.is_match(&host)) {
                continue;
            }
        }
        if let Some(required) = rule["features"].as_object() {
            if !required.iter().all(|(name, expected)| {
                features.get(name).copied().unwrap_or(false) == expected.as_bool().unwrap_or(false)
            }) {
                continue;
            }
        }
        allowed = rule["action"].as_str() == Some("allow");
    }
    allowed
}

pub fn maven_path(coordinate: &str) -> Result<String> {
    let (coordinate, extension) = coordinate.split_once('@').unwrap_or((coordinate, "jar"));
    let parts: Vec<_> = coordinate.split(':').collect();
    if parts.len() < 3 || parts.len() > 4 {
        bail!("无效的 Maven 坐标：{coordinate}");
    }
    for part in &parts {
        valid_name(part)?;
    }
    valid_name(extension)?;
    let classifier = parts.get(3).map(|p| format!("-{p}")).unwrap_or_default();
    Ok(format!(
        "{}/{}/{}/{}-{}{classifier}.{extension}",
        parts[0].replace('.', "/"),
        parts[1],
        parts[2],
        parts[1],
        parts[2]
    ))
}

#[derive(Clone, Debug)]
pub struct Library {
    pub file: DownloadSpec,
    pub native: bool,
    pub excludes: Vec<String>,
}
pub fn libraries(version: &Value) -> Result<Vec<Library>> {
    let mut by_key = HashMap::new();
    let mut ordered = Vec::new();
    for library in version["libraries"].as_array().into_iter().flatten() {
        if !rules_allow(&library["rules"], &HashMap::new()) {
            continue;
        }
        let name = library["name"].as_str().context("库缺少 Maven 坐标")?;
        let parts: Vec<_> = name.split(':').collect();
        let key = format!(
            "{}:{}:{}",
            parts.first().unwrap_or(&""),
            parts.get(1).unwrap_or(&""),
            parts.get(3).unwrap_or(&"")
        );
        if !by_key.contains_key(&key) {
            ordered.push(key.clone());
        }
        by_key.insert(key, library);
    }
    let mut result = Vec::new();
    let mut paths = HashSet::new();
    for key in ordered {
        let lib = by_key[&key];
        let name = lib["name"].as_str().unwrap();
        let artifact = &lib["downloads"]["artifact"];
        if !artifact.is_null() || lib["downloads"].is_null() {
            let path = artifact["path"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or(maven_path(name)?);
            let url = artifact["url"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| {
                    format!(
                        "{}{path}",
                        lib["url"]
                            .as_str()
                            .unwrap_or("https://libraries.minecraft.net/")
                            .trim_end_matches('/')
                            .to_owned()
                            + "/"
                    )
                });
            if paths.insert(path.clone()) {
                result.push(Library {
                    file: spec(artifact, format!("libraries/{path}"), url),
                    native: false,
                    excludes: vec![],
                });
            }
        }
        if let Some(native) = lib["natives"][os_name()].as_str() {
            let classifier = native.replace(
                "${arch}",
                if cfg!(target_pointer_width = "64") {
                    "64"
                } else {
                    "32"
                },
            );
            let artifact = &lib["downloads"]["classifiers"][&classifier];
            if artifact.is_null() {
                bail!("库 {name} 缺少 {classifier} native");
            }
            let path = artifact["path"].as_str().context("native 缺少路径")?;
            let url = artifact["url"].as_str().context("native 缺少 URL")?;
            let excludes = lib["extract"]["exclude"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect();
            result.push(Library {
                file: spec(artifact, format!("libraries/{path}"), url.into()),
                native: true,
                excludes,
            });
        }
    }
    Ok(result)
}
pub fn spec(value: &Value, path: String, url: String) -> DownloadSpec {
    DownloadSpec {
        url,
        path,
        size: value["size"].as_u64(),
        sha1: value["sha1"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_owned),
        sha512: value["sha512"].as_str().map(str::to_owned),
    }
}
pub fn scan(root: &Path) -> Result<Vec<VersionInfo>> {
    let versions = root.join("versions");
    if !versions.exists() {
        return Ok(vec![]);
    }
    let mut result = vec![];
    for entry in std::fs::read_dir(versions)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let id = entry.file_name().to_string_lossy().into_owned();
        if !entry.path().join(format!("{id}.json")).exists() {
            continue;
        }
        let mut info = VersionInfo {
            id: id.clone(),
            version: id.clone(),
            kind: "release".into(),
            loader: "Vanilla".into(),
            path: entry.path().to_string_lossy().into_owned(),
            java_major: 8,
            icon: String::new(),
            favorite: entry.path().join(".tmcl/favorite").is_file(),
            error: None,
        };
        match resolve(root, &id) {
            Ok(value) => {
                info.version = value["inheritsFrom"]
                    .as_str()
                    .or(value["clientVersion"].as_str())
                    .or(value["id"].as_str())
                    .unwrap_or(&id)
                    .into();
                info.kind = value["type"].as_str().unwrap_or("release").into();
                info.java_major = required_java(&value);
                let names = value["libraries"].to_string().to_lowercase();
                info.loader = if names.contains("neoforged") {
                    "NeoForge"
                } else if names.contains("minecraftforge") {
                    "Forge"
                } else if names.contains("quiltmc") {
                    "Quilt"
                } else if names.contains("fabricmc") {
                    "Fabric"
                } else if names.contains("optifine") {
                    "OptiFine"
                } else if names.contains("liteloader") {
                    "LiteLoader"
                } else {
                    "Vanilla"
                }
                .into();
                let icon = entry.path().join("icon.png");
                if icon.exists() {
                    info.icon = icon.to_string_lossy().into_owned();
                }
            }
            Err(error) => info.error = Some(format!("{error:#}")),
        }
        result.push(info);
    }
    result.sort_by_key(|a| a.id.to_lowercase());
    Ok(result)
}
pub fn set_favorite(root: &Path, id: &str, favorite: bool) -> Result<()> {
    valid_name(id)?;
    if !safe_join(root, format!("versions/{id}/{id}.json"))?.is_file() {
        bail!("版本不存在：{id}");
    }
    // Store the flag alongside the version so renames and directory changes
    // preserve it without a second list of paths in the global settings.
    let path = safe_join(root, format!("versions/{id}/.tmcl/favorite"))?;
    if favorite {
        atomic_write(&path, b"true\n")?;
    } else if let Err(error) = std::fs::remove_file(&path) {
        if error.kind() != std::io::ErrorKind::NotFound {
            return Err(error.into());
        }
    }
    Ok(())
}
pub fn required_java(version: &Value) -> u32 {
    version["javaVersion"]["majorVersion"].as_u64().unwrap_or(8) as u32
}
pub fn game_directory(root: &Path, id: &str, isolation: bool) -> Result<PathBuf> {
    if isolation {
        safe_join(root, format!("versions/{id}"))
    } else {
        Ok(root.into())
    }
}

pub fn extract_natives(root: &Path, id: &str, libraries: &[Library]) -> Result<PathBuf> {
    let natives = safe_join(root, format!("versions/{id}/natives"))?;
    std::fs::create_dir_all(&natives)?;
    for lib in libraries.iter().filter(|l| l.native) {
        let path = safe_join(root, &lib.file.path)?;
        let mut zip = zip::ZipArchive::new(std::fs::File::open(path)?)?;
        for i in 0..zip.len() {
            let mut entry = zip.by_index(i)?;
            if entry.is_dir()
                || entry.name().starts_with("META-INF/")
                || lib
                    .excludes
                    .iter()
                    .any(|prefix| entry.name().starts_with(prefix))
            {
                continue;
            }
            if entry.size() > 128 * 1024 * 1024 {
                bail!("native 文件过大");
            }
            let destination = safe_join(&natives, entry.name())?;
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes)?;
            atomic_write(&destination, &bytes)?;
        }
    }
    Ok(natives)
}

pub fn rename(root: &Path, id: &str, new_id: &str) -> Result<()> {
    valid_name(id)?;
    valid_name(new_id)?;
    if id == new_id {
        return Ok(());
    }
    let from = safe_join(root, format!("versions/{id}"))?;
    let to = safe_join(root, format!("versions/{new_id}"))?;
    if to.exists() {
        bail!("新版本名称已存在");
    }
    // Keep references valid: a parent version cannot be renamed underneath a child.
    for entry in scan(root)? {
        if entry.id == id {
            continue;
        }
        let v: Value = serde_json::from_slice(&std::fs::read(safe_join(
            root,
            format!("versions/{0}/{0}.json", entry.id),
        )?)?)?;
        if v["inheritsFrom"].as_str() == Some(id) || v["jar"].as_str() == Some(id) {
            bail!("版本 {} 依赖此版本，请先处理依赖后再重命名", entry.id);
        }
    }
    let original = std::fs::read(from.join(format!("{id}.json")))?;
    let mut value: Value = serde_json::from_slice(&original)?;
    value["id"] = json!(new_id);
    if value["jar"].as_str() == Some(id) {
        value["jar"] = json!(new_id);
    }
    std::fs::rename(&from, &to)?;
    let result = (|| -> Result<()> {
        let old_jar = to.join(format!("{id}.jar"));
        if old_jar.exists() {
            std::fs::rename(old_jar, to.join(format!("{new_id}.jar")))?;
        }
        atomic_write(
            &to.join(format!("{new_id}.json")),
            &serde_json::to_vec_pretty(&value)?,
        )?;
        std::fs::remove_file(to.join(format!("{id}.json")))?;
        Ok(())
    })();
    if result.is_err() {
        let new_jar = to.join(format!("{new_id}.jar"));
        if new_jar.exists() {
            let _ = std::fs::rename(new_jar, to.join(format!("{id}.jar")));
        }
        let _ = atomic_write(&to.join(format!("{id}.json")), &original);
        let _ = std::fs::remove_file(to.join(format!("{new_id}.json")));
        let _ = std::fs::rename(&to, &from);
    }
    result
}

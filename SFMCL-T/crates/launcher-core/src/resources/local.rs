use crate::paths::safe_join;
use anyhow::{bail, Context, Result};
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    io::Read,
    path::{Path, PathBuf},
};

const METADATA_LIMIT: u64 = 4 * 1024 * 1024;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LocalResourceEntryType {
    #[default]
    File,
    ResourceDirectory,
    Directory,
}

#[derive(Debug)]
struct InvalidWorldData;

impl std::fmt::Display for InvalidWorldData {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("存档信息读取失败")
    }
}

impl std::error::Error for InvalidWorldData {}

/// Resolve an explicitly viewed/selected version without changing the launch selection.
pub fn version_root(root: &Path, id: &str, isolation: bool) -> Result<PathBuf> {
    crate::paths::valid_name(id)?;
    let metadata = safe_join(root, format!("versions/{id}/{id}.json"))?;
    if !metadata.is_file() {
        bail!("游戏版本不存在，请刷新版本列表");
    }
    crate::minecraft::versions::game_directory(root, id, isolation)
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalResource {
    pub name: String,
    pub path: String,
    pub kind: String,
    #[serde(default)]
    pub entry_type: LocalResourceEntryType,
    pub description: String,
    pub version: String,
    pub authors: String,
    pub icon: String,
    pub disabled: bool,
    pub size: Option<u64>,
    pub error: Option<String>,
    pub details: Value,
}
fn image(bytes: &[u8]) -> String {
    format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}
fn read_entry(zip: &mut zip::ZipArchive<std::fs::File>, name: &str) -> Result<Vec<u8>> {
    let mut entry = zip.by_name(name)?;
    if entry.size() > METADATA_LIMIT {
        bail!("资源元数据超过 4 MB");
    }
    let mut bytes = vec![];
    entry.read_to_end(&mut bytes)?;
    Ok(bytes)
}
fn plain_text(value: &Value) -> String {
    if let Some(text) = value.as_str() {
        text.into()
    } else if let Some(array) = value.as_array() {
        array.iter().map(plain_text).collect::<Vec<_>>().join("")
    } else {
        format!(
            "{}{}",
            value["text"].as_str().unwrap_or(""),
            value["extra"]
                .as_array()
                .map(|a| a.iter().map(plain_text).collect::<Vec<_>>().join(""))
                .unwrap_or_default()
        )
    }
}
fn resource_size(path: &Path) -> Result<u64> {
    let mut paths = vec![path.to_owned()];
    let mut size = 0;
    while let Some(path) = paths.pop() {
        let metadata = std::fs::symlink_metadata(&path)?;
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                continue;
            }
        }
        if metadata.is_file() {
            size += metadata.len();
        } else if metadata.is_dir() {
            for entry in std::fs::read_dir(path)? {
                paths.push(entry?.path());
            }
        }
    }
    Ok(size)
}

pub fn directory_size(root: &Path, relative: &str, kind: &str) -> Result<u64> {
    let folder = match kind {
        "resourcepack" => "resourcepacks",
        "shader" => "shaderpacks",
        "world" => "saves",
        _ => bail!("此资源不需要统计文件夹大小"),
    };
    let path = safe_join(root, relative)?;
    if path.parent() != Some(root.join(folder).as_path()) || !path.is_dir() {
        bail!("不是所选游戏中的资源文件夹");
    }
    let recognized = match kind {
        "resourcepack" => path.join("pack.mcmeta").is_file(),
        "shader" => path.join("shaders").is_dir(),
        _ => path.join("level.dat").is_file(),
    };
    if !recognized {
        bail!("普通文件夹不统计大小");
    }
    resource_size(&path)
}
pub fn scan(root: &Path, kind: &str) -> Result<Vec<LocalResource>> {
    let directory = match kind {
        "mod" => "mods",
        "resourcepack" => "resourcepacks",
        "world" => "saves",
        "shader" => "shaderpacks",
        _ => bail!("未知本地资源类型"),
    };
    let folder = safe_join(root, directory)?;
    if !folder.exists() {
        return Ok(vec![]);
    }
    let mut candidates = vec![];
    for entry in std::fs::read_dir(&folder)? {
        let entry = entry?;
        let path = entry.path();
        if path.file_name().is_some_and(|n| n == ".disabled") {
            continue;
        }
        if kind == "mod" && !entry.file_type()?.is_file() {
            continue;
        }
        candidates.push((path, false));
    }
    if kind == "mod" {
        let disabled = safe_join(root, "mods/.disabled")?;
        if disabled.is_dir() {
            for entry in std::fs::read_dir(disabled)? {
                let entry = entry?;
                if entry.file_type()?.is_file() {
                    candidates.push((entry.path(), true));
                }
            }
        }
    }
    let mut result = vec![];
    for (path, disabled) in candidates {
        safe_join(root, path.strip_prefix(root)?)?;
        let is_directory = path.is_dir();
        if kind == "world" && (!is_directory || !path.join("level.dat").is_file()) {
            continue;
        }
        if kind != "world"
            && !is_directory
            && !path.extension().is_some_and(|e| {
                ["jar", "zip", "disabled"].contains(&e.to_string_lossy().to_lowercase().as_str())
            })
        {
            continue;
        }
        let entry_type = if !is_directory {
            LocalResourceEntryType::File
        } else if kind == "world"
            || (kind == "resourcepack" && path.join("pack.mcmeta").is_file())
            || (kind == "shader" && path.join("shaders").is_dir())
        {
            LocalResourceEntryType::ResourceDirectory
        } else {
            LocalResourceEntryType::Directory
        };
        let ordinary_directory = entry_type == LocalResourceEntryType::Directory;
        let name = (if is_directory {
            path.file_name()
        } else {
            path.file_stem()
        })
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
        let mut resource = LocalResource {
            name,
            path: path.to_string_lossy().into_owned(),
            kind: kind.into(),
            entry_type,
            description: String::new(),
            version: String::new(),
            authors: String::new(),
            icon: String::new(),
            disabled: kind == "mod"
                && (disabled || path.extension().is_some_and(|e| e == "disabled")),
            size: if is_directory {
                // Directory sizes are requested separately after the list is visible.
                None
            } else {
                Some(std::fs::metadata(&path)?.len())
            },
            error: None,
            details: json!({}),
        };
        let parsed = match kind {
            _ if ordinary_directory => Ok(()),
            "world" => read_world(&path, &mut resource),
            "mod" => read_mod(&path, &mut resource),
            "shader" => Ok(()),
            _ => read_pack(&path, &mut resource),
        };
        if let Err(error) = parsed {
            if kind != "world" {
                resource.error = Some(format!("{error:#}"));
            } else if error.downcast_ref::<InvalidWorldData>().is_some() {
                resource.error = Some(InvalidWorldData.to_string());
            }
        }
        result.push(resource);
    }
    result.sort_by_key(|r| r.name.to_lowercase());
    Ok(result)
}
fn read_mod(path: &Path, resource: &mut LocalResource) -> Result<()> {
    let mut zip = zip::ZipArchive::new(std::fs::File::open(path)?)?;
    let mut icon = None;
    if let Ok(bytes) = read_entry(&mut zip, "fabric.mod.json") {
        let value: Value = serde_json::from_slice(&bytes)?;
        resource.name = value["name"]
            .as_str()
            .or(value["id"].as_str())
            .unwrap_or(&resource.name)
            .into();
        resource.version = value["version"].as_str().unwrap_or("").into();
        resource.description = value["description"].as_str().unwrap_or("").into();
        resource.authors = value["authors"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|a| a.as_str().or(a["name"].as_str()))
            .collect::<Vec<_>>()
            .join(", ");
        icon = value["icon"].as_str().map(str::to_owned).or_else(|| {
            value["icon"]
                .as_object()
                .and_then(|o| o.values().next_back())
                .and_then(Value::as_str)
                .map(str::to_owned)
        });
        resource.details = json!({"loader":"Fabric","id":value["id"]});
    } else if let Ok(bytes) = read_entry(&mut zip, "quilt.mod.json") {
        let value: Value = serde_json::from_slice(&bytes)?;
        let metadata = &value["quilt_loader"]["metadata"];
        resource.name = metadata["name"].as_str().unwrap_or(&resource.name).into();
        resource.version = value["quilt_loader"]["version"]
            .as_str()
            .unwrap_or("")
            .into();
        resource.description = metadata["description"].as_str().unwrap_or("").into();
        resource.authors = metadata["contributors"]
            .as_object()
            .map(|o| o.keys().cloned().collect::<Vec<_>>().join(", "))
            .unwrap_or_default();
        icon = metadata["icon"].as_str().map(str::to_owned);
        resource.details = json!({"loader":"Quilt"});
    } else if let Ok(bytes) = read_entry(&mut zip, "META-INF/neoforge.mods.toml")
        .or_else(|_| read_entry(&mut zip, "META-INF/mods.toml"))
    {
        let value: toml::Value = toml::from_str(std::str::from_utf8(&bytes)?)?;
        let metadata = value
            .get("mods")
            .and_then(toml::Value::as_array)
            .and_then(|a| a.first())
            .context("缺少 mods 元数据")?;
        resource.name = metadata
            .get("displayName")
            .and_then(toml::Value::as_str)
            .unwrap_or(&resource.name)
            .into();
        resource.version = metadata
            .get("version")
            .and_then(toml::Value::as_str)
            .unwrap_or("")
            .into();
        resource.description = metadata
            .get("description")
            .and_then(toml::Value::as_str)
            .unwrap_or("")
            .into();
        resource.authors = metadata
            .get("authors")
            .and_then(toml::Value::as_str)
            .unwrap_or("")
            .into();
        icon = metadata
            .get("logoFile")
            .and_then(toml::Value::as_str)
            .map(str::to_owned);
        resource.details = json!({"loader":"Forge / NeoForge"});
    } else if let Ok(bytes) = read_entry(&mut zip, "mcmod.info") {
        let value: Value = serde_json::from_slice(&bytes)?;
        let metadata = value
            .as_array()
            .and_then(|a| a.first())
            .or_else(|| value["modList"].as_array().and_then(|a| a.first()))
            .context("无效 mcmod.info")?;
        resource.name = metadata["name"].as_str().unwrap_or(&resource.name).into();
        resource.version = metadata["version"].as_str().unwrap_or("").into();
        resource.description = metadata["description"].as_str().unwrap_or("").into();
        resource.authors = metadata["authorList"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join(", ");
        icon = metadata["logoFile"].as_str().map(str::to_owned);
    }
    if resource.version.is_empty() || resource.version == "${file.jarVersion}" {
        if let Ok(bytes) = read_entry(&mut zip, "META-INF/MANIFEST.MF") {
            resource.version = String::from_utf8_lossy(&bytes)
                .lines()
                .find_map(|l| l.strip_prefix("Implementation-Version:").map(str::trim))
                .unwrap_or("")
                .into();
        }
    }
    if let Some(icon) = icon {
        if let Ok(bytes) = read_entry(&mut zip, &icon) {
            resource.icon = image(&bytes);
        }
    }
    Ok(())
}
fn read_pack(path: &Path, resource: &mut LocalResource) -> Result<()> {
    let (metadata, icon) = if path.is_dir() {
        let metadata = safe_join(path, "pack.mcmeta")?;
        if std::fs::metadata(&metadata)?.len() > METADATA_LIMIT {
            bail!("资源元数据过大");
        }
        (
            std::fs::read(metadata)?,
            read_directory_icon(path, "pack.png"),
        )
    } else {
        let mut zip = zip::ZipArchive::new(std::fs::File::open(path)?)?;
        (
            read_entry(&mut zip, "pack.mcmeta")?,
            read_entry(&mut zip, "pack.png").ok(),
        )
    };
    let value: Value = serde_json::from_slice(&metadata).context("pack.mcmeta 无法解析")?;
    if !value["pack"].is_object() {
        bail!("pack.mcmeta 缺少有效的 pack 元数据");
    }
    resource.description = plain_text(&value["pack"]["description"]);
    resource.details = value["pack"].clone();
    if let Some(icon) = icon {
        if icon.len() <= METADATA_LIMIT as usize {
            resource.icon = image(&icon);
        }
    }
    Ok(())
}
fn read_directory_icon(path: &Path, name: &str) -> Option<Vec<u8>> {
    let icon = safe_join(path, name).ok()?;
    if std::fs::metadata(&icon).ok()?.len() > METADATA_LIMIT {
        return None;
    }
    std::fs::read(icon).ok()
}

fn parse_world_data(bytes: &[u8]) -> Result<Value> {
    let mut decompressed = vec![];
    if bytes.starts_with(&[0x1f, 0x8b]) {
        flate2::read::GzDecoder::new(bytes)
            .take(16 * 1024 * 1024 + 1)
            .read_to_end(&mut decompressed)?;
    } else {
        decompressed = bytes.to_vec();
    }
    if decompressed.len() > 16 * 1024 * 1024 {
        bail!("世界元数据过大");
    }
    let nbt: fastnbt::Value = fastnbt::from_bytes(&decompressed)?;
    let value = serde_json::to_value(nbt)?;
    if !value["Data"].is_object() {
        bail!("level.dat 缺少有效的 Data 元数据");
    }
    Ok(value)
}

fn read_world(path: &Path, resource: &mut LocalResource) -> Result<()> {
    let bytes = std::fs::read(safe_join(path, "level.dat")?)?;
    let value = parse_world_data(&bytes).context(InvalidWorldData)?;
    let data = &value["Data"];
    resource.name = data["LevelName"].as_str().unwrap_or(&resource.name).into();
    resource.version = data["Version"]["Name"].as_str().unwrap_or("").into();
    let rules: BTreeMap<String, Value> = data["GameRules"]
        .as_object()
        .map(|o| o.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
        .unwrap_or_default();
    let seed = data["WorldGenSettings"]["seed"]
        .as_i64()
        .or(data["RandomSeed"].as_i64())
        .unwrap_or(0)
        .to_string();
    resource.details = json!({"seed":seed,"difficulty":data["Difficulty"],"gameMode":data["GameType"],"raining":data["raining"].as_i64()==Some(1),"thundering":data["thundering"].as_i64()==Some(1),"allowCommands":data["allowCommands"].as_i64()==Some(1),"hardcore":data["hardcore"].as_i64()==Some(1),"bonusChest":data["WorldGenSettings"]["bonus_chest"].as_i64()==Some(1),"lastPlayed":data["LastPlayed"],"gameRules":rules});
    if let Some(bytes) = read_directory_icon(path, "icon.png") {
        resource.icon = image(&bytes);
    }
    Ok(())
}
pub fn toggle_mod(root: &Path, relative: &str, disabled: bool) -> Result<PathBuf> {
    let path = safe_join(root, relative)?;
    let mods = root.join("mods");
    if !path.starts_with(&mods) || !path.is_file() {
        bail!("不是所选游戏中的模组文件");
    }
    let file = path
        .file_name()
        .context("模组文件名为空")?
        .to_string_lossy();
    let target = if disabled {
        safe_join(root, format!("mods/.disabled/{file}"))?
    } else {
        safe_join(root, format!("mods/{}", file.trim_end_matches(".disabled")))?
    };
    if path == target {
        return Ok(target);
    }
    if target.exists() {
        bail!("目标位置已有同名模组");
    }
    std::fs::create_dir_all(target.parent().unwrap())?;
    std::fs::rename(path, &target)?;
    Ok(target)
}
pub fn delete_pack(root: &Path, relative: &str) -> Result<()> {
    let path = safe_join(root, relative)?;
    if path.parent() != Some(root.join("resourcepacks").as_path()) {
        bail!("只能删除当前游戏的材质包");
    }
    if path.is_dir() {
        if !path.join("pack.mcmeta").is_file() {
            bail!("此文件夹不是材质包");
        }
        std::fs::remove_dir_all(path)?;
    } else {
        std::fs::remove_file(path)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn shaders_only_use_file_names_and_sizes_even_without_pack_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("shaderpacks");
        std::fs::create_dir(&folder).unwrap();
        let archive = folder.join("Complementary.zip");
        let mut zip = zip::ZipWriter::new(std::fs::File::create(&archive).unwrap());
        zip.start_file(
            "shaders/shaders.properties",
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
        zip.write_all(b"shader settings").unwrap();
        zip.finish().unwrap();
        std::fs::write(folder.join("NotAnArchive.zip"), b"plain file bytes").unwrap();

        let items = scan(dir.path(), "shader").unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].name, "Complementary");
        assert_eq!(
            items[0].size,
            Some(std::fs::metadata(archive).unwrap().len())
        );
        assert_eq!(items[1].name, "NotAnArchive");
        assert_eq!(items[1].size, Some(b"plain file bytes".len() as u64));
        for item in items {
            assert!(item.error.is_none());
            assert!(item.description.is_empty());
            assert!(item.version.is_empty());
            assert!(item.authors.is_empty());
            assert!(item.icon.is_empty());
            assert_eq!(item.details, json!({}));
        }
    }

    #[test]
    fn shader_metadata_is_ignored_even_when_present() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("shaderpacks");
        std::fs::create_dir(&folder).unwrap();
        let mut zip =
            zip::ZipWriter::new(std::fs::File::create(folder.join("Shader.zip")).unwrap());
        zip.start_file("pack.mcmeta", zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(br#"{"pack":{"description":"Do not read this"}}"#)
            .unwrap();
        zip.start_file("pack.png", zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"Do not read the icon").unwrap();
        zip.finish().unwrap();
        let items = scan(dir.path(), "shader").unwrap();
        assert_eq!(items[0].name, "Shader");
        assert!(items[0].description.is_empty());
        assert!(items[0].icon.is_empty());
        assert_eq!(items[0].details, json!({}));
        assert!(items[0].error.is_none());
    }

    #[test]
    fn unpacked_shaders_keep_directory_names_and_total_file_size() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("shaderpacks/Complementary.v5/shaders");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("program.glsl"), b"shader program").unwrap();
        std::fs::create_dir(folder.join("nested")).unwrap();
        std::fs::write(folder.join("nested/settings.properties"), b"settings").unwrap();
        let items = scan(dir.path(), "shader").unwrap();
        assert_eq!(items[0].name, "Complementary.v5");
        assert_eq!(
            items[0].entry_type,
            LocalResourceEntryType::ResourceDirectory
        );
        assert_eq!(items[0].size, None);
        assert_eq!(
            directory_size(dir.path(), "shaderpacks/Complementary.v5", "shader").unwrap(),
            (b"shader program".len() + b"settings".len()) as u64
        );
        assert!(items[0].error.is_none());
    }

    #[test]
    fn mods_skip_directories_including_archive_names_and_disabled_subfolders() {
        let dir = tempfile::tempdir().unwrap();
        for folder in ["mods/group", "mods/folder.jar", "mods/.disabled/group"] {
            std::fs::create_dir_all(dir.path().join(folder)).unwrap();
            std::fs::write(dir.path().join(folder).join("nested.jar"), b"ignored").unwrap();
        }
        for file in ["mods/active.jar", "mods/.disabled/inactive.jar"] {
            let zip = zip::ZipWriter::new(std::fs::File::create(dir.path().join(file)).unwrap());
            zip.finish().unwrap();
        }
        let items = scan(dir.path(), "mod").unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].name, "active");
        assert!(!items[0].disabled);
        assert_eq!(items[1].name, "inactive");
        assert!(items[1].disabled);
        assert!(items
            .iter()
            .all(|item| item.entry_type == LocalResourceEntryType::File && item.error.is_none()));
    }

    #[test]
    fn pack_directories_are_classified_without_losing_names_or_hiding_bad_metadata() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["Plain.v1", "Valid.v2", "Broken.v3", "MissingPack.v4"] {
            std::fs::create_dir_all(dir.path().join("resourcepacks").join(name)).unwrap();
        }
        std::fs::write(
            dir.path().join("resourcepacks/Valid.v2/pack.mcmeta"),
            br#"{"pack":{"description":"A pack","pack_format":15}}"#,
        )
        .unwrap();
        std::fs::write(dir.path().join("resourcepacks/Broken.v3/pack.mcmeta"), b"{").unwrap();
        std::fs::write(
            dir.path().join("resourcepacks/MissingPack.v4/pack.mcmeta"),
            b"{}",
        )
        .unwrap();
        let items = scan(dir.path(), "resourcepack").unwrap();
        assert_eq!(items.len(), 4);
        let plain = items.iter().find(|item| item.name == "Plain.v1").unwrap();
        assert_eq!(plain.entry_type, LocalResourceEntryType::Directory);
        assert!(plain.error.is_none());
        assert_eq!(plain.size, None);
        let valid = items.iter().find(|item| item.name == "Valid.v2").unwrap();
        assert_eq!(valid.entry_type, LocalResourceEntryType::ResourceDirectory);
        assert_eq!(valid.description, "A pack");
        assert!(valid.error.is_none());
        for name in ["Broken.v3", "MissingPack.v4"] {
            let item = items.iter().find(|item| item.name == name).unwrap();
            assert_eq!(item.entry_type, LocalResourceEntryType::ResourceDirectory);
            assert!(item.error.as_deref().unwrap().contains("pack.mcmeta"));
        }
    }

    #[test]
    fn ordinary_shader_directories_are_not_packs_and_cannot_be_sized() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("shaderpacks/Notes.v5");
        std::fs::create_dir_all(folder.join("nested")).unwrap();
        std::fs::write(folder.join("shaders"), b"not a directory").unwrap();
        std::fs::write(folder.join("nested/ignored.zip"), b"ignored").unwrap();
        let items = scan(dir.path(), "shader").unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].name, "Notes.v5");
        assert_eq!(items[0].entry_type, LocalResourceEntryType::Directory);
        assert_eq!(items[0].size, None);
        assert!(items[0].error.is_none());
        assert!(directory_size(dir.path(), "shaderpacks/Notes.v5", "shader").is_err());
    }

    #[test]
    fn ordinary_pack_directories_cannot_be_deleted_or_sized() {
        let dir = tempfile::tempdir().unwrap();
        let plain = dir.path().join("resourcepacks/Notes");
        std::fs::create_dir_all(&plain).unwrap();
        std::fs::write(plain.join("keep.txt"), b"keep").unwrap();
        assert!(delete_pack(dir.path(), "resourcepacks/Notes").is_err());
        assert_eq!(std::fs::read(plain.join("keep.txt")).unwrap(), b"keep");
        assert!(directory_size(dir.path(), "resourcepacks/Notes", "resourcepack").is_err());
        std::fs::write(plain.join("pack.mcmeta"), b"{}").unwrap();
        assert_eq!(
            directory_size(dir.path(), "resourcepacks/Notes", "resourcepack").unwrap(),
            6
        );
        assert!(directory_size(dir.path(), "resourcepacks/Notes", "shader").is_err());
        assert!(directory_size(dir.path(), "resourcepacks", "resourcepack").is_err());
        assert!(directory_size(dir.path(), "../outside", "resourcepack").is_err());
        delete_pack(dir.path(), "resourcepacks/Notes").unwrap();
        assert!(!plain.exists());
    }

    #[test]
    fn worlds_only_report_corrupt_level_data_and_ignore_unreadable_icons() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["Missing", "Valid.v1", "BadNbt", "BadGzip", "MissingData"] {
            std::fs::create_dir_all(dir.path().join("saves").join(name)).unwrap();
        }
        std::fs::create_dir(dir.path().join("saves/Missing/level.dat")).unwrap();
        let nbt = fastnbt::to_bytes(&json!({"Data": {"LevelName": "Valid world"}})).unwrap();
        let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        gzip.write_all(&nbt).unwrap();
        std::fs::write(
            dir.path().join("saves/Valid.v1/level.dat"),
            gzip.finish().unwrap(),
        )
        .unwrap();
        std::fs::create_dir(dir.path().join("saves/Valid.v1/icon.png")).unwrap();
        std::fs::write(dir.path().join("saves/BadNbt/level.dat"), b"broken nbt").unwrap();
        std::fs::write(
            dir.path().join("saves/BadGzip/level.dat"),
            [0x1f, 0x8b, 0x08],
        )
        .unwrap();
        std::fs::write(
            dir.path().join("saves/MissingData/level.dat"),
            fastnbt::to_bytes(&json!({"Unrelated": "value"})).unwrap(),
        )
        .unwrap();
        let items = scan(dir.path(), "world").unwrap();
        assert_eq!(items.len(), 4);
        for item in items {
            assert_eq!(item.entry_type, LocalResourceEntryType::ResourceDirectory);
            if item.name == "Valid world" {
                assert!(item.error.is_none());
                assert!(item.icon.is_empty());
            } else {
                assert_eq!(item.error.as_deref(), Some("存档信息读取失败"));
                assert_eq!(item.details, json!({}));
            }
        }
    }

    #[test]
    fn resource_operations_use_the_requested_version_and_isolation() {
        let dir = tempfile::tempdir().unwrap();
        for id in ["first", "second"] {
            let version = dir.path().join("versions").join(id);
            std::fs::create_dir_all(version.join("mods")).unwrap();
            std::fs::write(version.join(format!("{id}.json")), b"{}").unwrap();
            std::fs::write(version.join("mods/test.jar"), id.as_bytes()).unwrap();
        }
        let second = version_root(dir.path(), "second", true).unwrap();
        assert_eq!(second, dir.path().join("versions/second"));
        toggle_mod(&second, "mods/test.jar", true).unwrap();
        assert!(dir.path().join("versions/first/mods/test.jar").is_file());
        assert!(second.join("mods/.disabled/test.jar").is_file());
        assert_eq!(
            version_root(dir.path(), "second", false).unwrap(),
            dir.path()
        );
    }
    #[test]
    fn explicit_resource_version_must_exist_and_stay_within_root() {
        let dir = tempfile::tempdir().unwrap();
        for id in ["", "missing", "..", "../outside", "first/../../outside"] {
            assert!(version_root(dir.path(), id, true).is_err());
            assert!(version_root(dir.path(), id, false).is_err());
        }
    }
    #[test]
    fn disabled_mods_keep_contents_and_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("mods")).unwrap();
        std::fs::write(dir.path().join("mods/test.jar"), b"jar").unwrap();
        toggle_mod(dir.path(), "mods/test.jar", true).unwrap();
        assert!(dir.path().join("mods/.disabled/test.jar").exists());
        toggle_mod(dir.path(), "mods/.disabled/test.jar", false).unwrap();
        assert_eq!(
            std::fs::read(dir.path().join("mods/test.jar")).unwrap(),
            b"jar"
        );
    }
    #[test]
    fn world_seed_preserves_i64_precision() {
        let dir = tempfile::tempdir().unwrap();
        let world = dir.path().join("saves/Test");
        std::fs::create_dir_all(&world).unwrap();
        let value = fastnbt::Value::Compound(std::collections::HashMap::from([(
            "Data".into(),
            fastnbt::Value::Compound(std::collections::HashMap::from([
                (
                    "LevelName".into(),
                    fastnbt::Value::String("Test world".into()),
                ),
                (
                    "RandomSeed".into(),
                    fastnbt::Value::Long(9223372036854775807),
                ),
            ])),
        )]));
        std::fs::write(world.join("level.dat"), fastnbt::to_bytes(&value).unwrap()).unwrap();
        let items = scan(dir.path(), "world").unwrap();
        assert_eq!(items[0].details["seed"], "9223372036854775807");
        assert_eq!(items[0].name, "Test world");
    }
}

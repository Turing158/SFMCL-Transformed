use super::archive::{self, MAX_METADATA};
use crate::{
    downloads::DownloadSpec,
    minecraft::{loaders::LoaderChoice, versions},
    paths::safe_join,
};
use anyhow::{bail, Context, Result};
use serde::Serialize;
use serde_json::{json, Value};
use sha1::{Digest, Sha1};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackInfo {
    pub format: String,
    pub name: String,
    pub version: String,
    pub minecraft: String,
    pub loader: Option<LoaderChoice>,
    pub optional_files: Vec<String>,
    pub file_count: usize,
}
pub struct Pack {
    pub info: PackInfo,
    pub files: Vec<PackFile>,
    pub contents: Vec<PathBuf>,
    pub libraries: Vec<Value>,
    pub imported: Option<Value>,
    pub imported_jar: Option<PathBuf>,
    pub shared_root: Option<PathBuf>,
    pub profile_files: HashSet<PathBuf>,
    pub verified: Vec<(String, String)>,
}
pub struct PackFile {
    pub path: String,
    pub optional: bool,
    pub source: FileSource,
}
pub enum FileSource {
    Download {
        spec: DownloadSpec,
        mirrors: Vec<String>,
    },
    CurseForge {
        project: u64,
        file: u64,
    },
}

pub fn read_json(path: &Path) -> Result<Value> {
    if std::fs::metadata(path)?.len() > MAX_METADATA {
        bail!("整合包清单超过 16 MB");
    }
    let bytes = std::fs::read(path)?;
    Ok(serde_json::from_slice(
        bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes),
    )?)
}
fn required<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key]
        .as_str()
        .filter(|v| !v.trim().is_empty())
        .with_context(|| format!("整合包清单缺少 {key}"))
}
fn array<'a>(value: &'a Value, key: &str) -> Result<&'a Vec<Value>> {
    value[key]
        .as_array()
        .with_context(|| format!("整合包清单缺少 {key} 数组"))
}
fn hash(value: &str, length: usize) -> Result<String> {
    if value.len() != length || !value.bytes().all(|c| c.is_ascii_hexdigit()) {
        bail!("整合包文件哈希不合法");
    }
    Ok(value.to_lowercase())
}
fn url(value: &str) -> Result<String> {
    let url = reqwest::Url::parse(value)?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        bail!("整合包下载地址无效");
    }
    Ok(value.into())
}
fn new_pack(format: &str, name: &str, version: &str) -> Pack {
    Pack {
        info: PackInfo {
            format: format.into(),
            name: name.into(),
            version: version.into(),
            minecraft: String::new(),
            loader: None,
            optional_files: vec![],
            file_count: 0,
        },
        files: vec![],
        contents: vec![],
        libraries: vec![],
        imported: None,
        imported_jar: None,
        shared_root: None,
        profile_files: HashSet::new(),
        verified: vec![],
    }
}
fn dependencies(pack: &mut Pack, items: &Value) -> Result<()> {
    let items = items.as_object().context("整合包缺少 dependencies")?;
    pack.info.minecraft = required(&json!(items), "minecraft")?.into();
    for (key, version) in items {
        if key == "minecraft" {
            continue;
        }
        let kind = match key.as_str() {
            "fabric-loader" => "Fabric",
            "quilt-loader" => "Quilt",
            "forge" => "Forge",
            "neoforge" => "NeoForge",
            _ => bail!("不支持的整合包组件：{key}"),
        };
        if pack.info.loader.is_some() {
            bail!("整合包包含多个不兼容的加载器");
        }
        let version = version
            .as_str()
            .filter(|v| !v.is_empty())
            .context("加载器版本为空")?;
        crate::paths::valid_name(version)?;
        pack.info.loader = Some(LoaderChoice {
            kind: kind.into(),
            version: version.into(),
            metadata: Value::Null,
        });
    }
    crate::paths::valid_name(&pack.info.minecraft)?;
    Ok(())
}
fn content(pack: &mut Pack, root: &Path, relative: &str, required: bool) -> Result<()> {
    let path = safe_join(root, archive::relative(relative)?)?;
    if path.is_dir() {
        pack.contents.push(path);
    } else if required {
        bail!("整合包缺少覆盖目录：{relative}");
    }
    Ok(())
}

fn modrinth(value: &Value, root: &Path) -> Result<Pack> {
    if value["game"] != "minecraft" || value["formatVersion"] != 1 {
        bail!("不支持该 Modrinth 游戏类型或格式版本");
    }
    let mut pack = new_pack(
        "Modrinth",
        required(value, "name")?,
        required(value, "versionId")?,
    );
    dependencies(&mut pack, &value["dependencies"])?;
    let mut paths = HashSet::new();
    for entry in array(value, "files")? {
        let path = archive::relative(required(entry, "path")?)?;
        if !paths.insert(path.to_lowercase()) {
            bail!("Modrinth 清单存在重复文件路径");
        }
        let client = entry["env"]["client"].as_str().unwrap_or("required");
        if client == "unsupported" {
            continue;
        }
        if !matches!(client, "required" | "optional") {
            bail!("无效的 Modrinth 客户端环境字段");
        }
        let mirrors = array(entry, "downloads")?
            .iter()
            .map(|v| url(v.as_str().context("无效下载地址")?))
            .collect::<Result<Vec<_>>>()?;
        let first = mirrors
            .first()
            .context("Modrinth 文件缺少下载地址")?
            .clone();
        let sha1 = entry["hashes"]["sha1"]
            .as_str()
            .map(|v| hash(v, 40))
            .transpose()?;
        let sha512 = entry["hashes"]["sha512"]
            .as_str()
            .map(|v| hash(v, 128))
            .transpose()?;
        if sha1.is_none() && sha512.is_none() {
            bail!("Modrinth 文件缺少可验证的哈希");
        }
        let size = entry["fileSize"]
            .as_u64()
            .context("Modrinth 文件缺少有效大小")?;
        pack.files.push(PackFile {
            path: path.clone(),
            optional: client == "optional",
            source: FileSource::Download {
                spec: DownloadSpec {
                    url: first,
                    path,
                    size: Some(size),
                    sha1,
                    sha512,
                },
                mirrors,
            },
        });
    }
    content(&mut pack, root, "overrides", false)?;
    content(&mut pack, root, "client-overrides", false)?;
    Ok(pack)
}
fn curse_files(pack: &mut Pack, entries: &[Value]) -> Result<()> {
    let mut files = HashSet::new();
    for entry in entries {
        let project = entry["projectID"]
            .as_u64()
            .filter(|id| *id > 0)
            .context("无效的 CurseForge 项目 ID")?;
        let file = entry["fileID"]
            .as_u64()
            .filter(|id| *id > 0)
            .context("无效的 CurseForge 文件 ID")?;
        if !files.insert(file) {
            bail!("CurseForge 清单存在重复文件 ID");
        }
        pack.files.push(PackFile {
            path: format!("CurseForge {project}/{file}"),
            optional: entry["required"] == false,
            source: FileSource::CurseForge { project, file },
        });
    }
    Ok(())
}
fn curseforge(value: &Value, root: &Path) -> Result<Pack> {
    if value["manifestType"] != "minecraftModpack" || value["manifestVersion"] != 1 {
        bail!("不支持该 CurseForge 清单类型或版本");
    }
    let mut pack = new_pack(
        "CurseForge",
        required(value, "name")?,
        required(value, "version")?,
    );
    let mut deps = json!({"minecraft": required(&value["minecraft"], "version")?});
    let loaders = value["minecraft"]["modLoaders"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let primary: Vec<_> = loaders.iter().filter(|v| v["primary"] == true).collect();
    if primary.len() > 1 || primary.is_empty() && loaders.len() > 1 {
        bail!("CurseForge 清单无法确定主加载器");
    }
    if let Some(loader) = primary.first().copied().or(loaders.first()) {
        let id = required(loader, "id")?;
        let (kind, version) = [
            "fabric-loader-",
            "quilt-loader-",
            "fabric-",
            "quilt-",
            "neoforge-",
            "forge-",
        ]
        .iter()
        .find_map(|prefix| id.strip_prefix(prefix).map(|version| (*prefix, version)))
        .context("不支持的 CurseForge 加载器")?;
        let key = match kind {
            "fabric-loader-" | "fabric-" => "fabric-loader",
            "quilt-loader-" | "quilt-" => "quilt-loader",
            "neoforge-" => "neoforge",
            _ => "forge",
        };
        deps[key] = json!(version);
    }
    dependencies(&mut pack, &deps)?;
    curse_files(&mut pack, array(value, "files")?)?;
    content(
        &mut pack,
        root,
        value["overrides"].as_str().unwrap_or("overrides"),
        false,
    )?;
    Ok(pack)
}
fn mcbbs(value: &Value, root: &Path, cancel: &CancellationToken) -> Result<Pack> {
    if value["manifestType"] != "minecraftModpack"
        || !matches!(value["manifestVersion"].as_u64(), Some(1 | 2))
    {
        bail!("不支持该 MCBBS 格式版本");
    }
    let mut pack = new_pack(
        "MCBBS",
        required(value, "name")?,
        value["version"].as_str().unwrap_or(""),
    );
    let mut deps = json!({});
    for addon in array(value, "addons")? {
        let key = match required(addon, "id")? {
            "game" | "minecraft" => "minecraft",
            "fabric" => "fabric-loader",
            "quilt" | "quiltmc" => "quilt-loader",
            "forge" => "forge",
            "neoforge" | "neoforged" => "neoforge",
            id => bail!("不支持 MCBBS 组件：{id}"),
        };
        if !deps[key].is_null() {
            bail!("MCBBS 清单存在重复组件");
        }
        deps[key] = json!(required(addon, "version")?);
    }
    dependencies(&mut pack, &deps)?;
    content(&mut pack, root, "overrides", false)?;
    pack.libraries = value["libraries"].as_array().cloned().unwrap_or_default();
    let mut paths = HashSet::new();
    let mut curse = vec![];
    for entry in array(value, "files")? {
        archive::check_cancel(cancel)?;
        match required(entry, "type")? {
            "curse" => {
                curse.push(entry.clone());
            }
            "addon" => {
                let path = archive::relative(required(entry, "path")?)?;
                if !paths.insert(path.to_lowercase()) {
                    bail!("MCBBS 清单存在重复路径");
                }
                let sha1 = hash(required(entry, "hash")?, 40)?;
                let local = safe_join(root, format!("overrides/{path}"))?;
                if local.is_file() {
                    verify_sha1(&local, &sha1)?;
                    pack.verified.push((path, sha1));
                } else {
                    let base = reqwest::Url::parse(&format!(
                        "{}/",
                        url(required(value, "fileApi")?)?.trim_end_matches('/')
                    ))?;
                    let mut download = base;
                    download
                        .path_segments_mut()
                        .map_err(|_| anyhow::anyhow!("MCBBS fileApi 无效"))?
                        .pop_if_empty()
                        .push("overrides")
                        .extend(path.split('/'));
                    let spec = DownloadSpec {
                        url: download.into(),
                        path: path.clone(),
                        size: None,
                        sha1: Some(sha1),
                        sha512: None,
                    };
                    pack.files.push(PackFile {
                        path,
                        optional: false,
                        source: FileSource::Download {
                            mirrors: vec![spec.url.clone()],
                            spec,
                        },
                    });
                }
            }
            kind => bail!("不支持 MCBBS 文件类型：{kind}"),
        }
    }
    curse_files(&mut pack, &curse)?;
    Ok(pack)
}
pub fn verify_sha1(path: &Path, hash: &str) -> Result<()> {
    let mut file = std::fs::File::open(path)?;
    let mut digest = Sha1::new();
    std::io::copy(&mut file, &mut digest)?;
    if hex::encode(digest.finalize()) != hash {
        bail!("MCBBS 包内文件校验失败：{}", path.display());
    }
    Ok(())
}
fn multimc(value: &Value, root: &Path) -> Result<Pack> {
    if value["formatVersion"] != 1 {
        bail!("不支持该 MultiMC / Prism 实例格式版本");
    }
    let config = root.join("instance.cfg");
    let name = if config.is_file() {
        if std::fs::metadata(&config)?.len() > MAX_METADATA {
            bail!("实例配置过大");
        }
        std::fs::read_to_string(config)?
            .lines()
            .find_map(|line| line.strip_prefix("name="))
            .unwrap_or("整合包")
            .to_owned()
    } else {
        "整合包".into()
    };
    let mut pack = new_pack("MultiMC / Prism", &name, "");
    let mut deps = json!({});
    for component in array(value, "components")? {
        let key = match required(component, "uid")? {
            "org.lwjgl" | "org.lwjgl3" => continue,
            "net.minecraft" => "minecraft",
            "net.fabricmc.fabric-loader" => "fabric-loader",
            "org.quiltmc.quilt-loader" => "quilt-loader",
            "net.minecraftforge" => "forge",
            "net.neoforged" => "neoforge",
            uid => bail!("不支持实例组件：{uid}"),
        };
        if !deps[key].is_null() {
            bail!("实例包含重复组件");
        }
        deps[key] = json!(required(component, "version")?);
    }
    dependencies(&mut pack, &deps)?;
    if root.join("patches").is_dir() && std::fs::read_dir(root.join("patches"))?.next().is_some() {
        bail!("实例包含自定义组件补丁，请导出为 Modrinth 或 CurseForge 格式");
    }
    content(
        &mut pack,
        root,
        if root.join(".minecraft").is_dir() {
            ".minecraft"
        } else {
            "minecraft"
        },
        true,
    )?;
    Ok(pack)
}
fn directory(root: &Path, files: &[PathBuf]) -> Result<Pack> {
    let profiles: Vec<_> = files
        .iter()
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "json")
                && path.file_stem() == path.parent().and_then(Path::file_name)
                && path
                    .parent()
                    .and_then(Path::parent)
                    .and_then(Path::file_name)
                    .is_some_and(|name| name.eq_ignore_ascii_case("versions"))
        })
        .collect();
    if profiles.is_empty() {
        if files.iter().any(|p| {
            p.file_name().is_some_and(|v| {
                v == "server.properties"
                    || v.to_string_lossy().contains("server")
                        && v.to_string_lossy().ends_with(".jar")
            })
        }) {
            bail!("这是服务端整合包，请使用客户端导出包");
        }
        bail!("未找到支持的整合包清单或完整客户端版本");
    }
    let mut values = HashMap::new();
    let mut roots = HashSet::new();
    for path in &profiles {
        roots.insert(path.parent().unwrap().parent().unwrap().parent().unwrap());
        let id = path.file_stem().unwrap().to_string_lossy().into_owned();
        if values.insert(id, read_json(path)?).is_some() {
            bail!("目录包含重复的客户端版本");
        }
    }
    if roots.len() != 1 {
        bail!("目录包含多个游戏目录，请分别导出");
    }
    let parents: HashSet<_> = values
        .values()
        .filter_map(|v| v["inheritsFrom"].as_str())
        .collect();
    let selected: Vec<_> = values
        .keys()
        .filter(|id| !parents.contains(id.as_str()))
        .collect();
    if selected.len() != 1 {
        bail!("目录包含多个可启动实例或继承循环，请分别导出");
    }
    let id = selected[0];
    let game = *roots.iter().next().unwrap();
    let mut profile = versions::resolve(game, id)?;
    let main = required(&profile, "mainClass")?;
    if main.to_lowercase().contains("server") {
        bail!("这是服务端整合包，请使用客户端导出包");
    }
    let mut pack = new_pack("客户端目录", id, "");
    let mut base = id.as_str();
    let mut seen = HashSet::new();
    while let Some(parent) = values[base]["inheritsFrom"].as_str() {
        if !seen.insert(base) {
            bail!("版本继承循环");
        }
        base = parent;
        if !values.contains_key(base) {
            bail!("整合包缺少继承的客户端版本");
        }
    }
    pack.info.minecraft = profile["clientVersion"]
        .as_str()
        .or(profile["patches"]
            .as_array()
            .and_then(|items| {
                items
                    .iter()
                    .find(|v| v["id"] == "game" || v["id"] == "net.minecraft")
            })
            .and_then(|v| v["version"].as_str()))
        .unwrap_or(base)
        .into();
    crate::paths::valid_name(&pack.info.minecraft)?;
    let mut jar_id = values[id]["jar"].as_str().unwrap_or(id).to_owned();
    let mut seen = HashSet::new();
    while seen.insert(jar_id.clone()) {
        let jar = safe_join(game, format!("versions/{jar_id}/{jar_id}.jar"))?;
        if jar.is_file() {
            pack.imported_jar = Some(jar);
            break;
        }
        match values.get(&jar_id).and_then(|v| v["inheritsFrom"].as_str()) {
            Some(parent) => jar_id = parent.into(),
            None => break,
        }
    }
    profile
        .as_object_mut()
        .context("客户端版本不是对象")?
        .remove("inheritsFrom");
    pack.imported = Some(profile);
    pack.shared_root = Some(game.into());
    pack.contents.push(game.into());
    pack.contents
        .push(safe_join(game, format!("versions/{id}"))?);
    for path in profiles {
        pack.profile_files.insert(path.clone());
        pack.profile_files.insert(path.with_extension("jar"));
    }
    let _ = root;
    Ok(pack)
}

pub fn parse(root: &Path, cancel: &CancellationToken) -> Result<Pack> {
    let files = archive::files(root, cancel)?;
    let names = [
        "modrinth.index.json",
        "manifest.json",
        "mcbbs.packmeta",
        "mmc-pack.json",
    ];
    let mut manifests: Vec<_> = files
        .iter()
        .filter(|p| {
            p.file_name()
                .is_some_and(|n| names.contains(&n.to_string_lossy().as_ref()))
        })
        .collect();
    let top: Vec<_> = manifests
        .iter()
        .filter(|p| {
            !manifests
                .iter()
                .any(|other| p.parent() != other.parent() && p.starts_with(other.parent().unwrap()))
        })
        .copied()
        .collect();
    let mut excluded = vec![];
    for path in top {
        let parent = path.parent().unwrap();
        for folder in [
            "overrides",
            "client-overrides",
            "server-overrides",
            ".minecraft",
            "minecraft",
        ] {
            excluded.push(parent.join(folder));
        }
        if path.file_name().unwrap() == "manifest.json" {
            let value = read_json(path)?;
            if let Some(folder) = value["overrides"].as_str() {
                excluded.push(safe_join(parent, archive::relative(folder)?)?);
            }
        }
    }
    manifests.retain(|path| !excluded.iter().any(|folder| path.starts_with(folder)));
    let roots: HashSet<_> = manifests.iter().map(|p| p.parent().unwrap()).collect();
    if roots.len() > 1 {
        bail!("压缩包包含多个整合包清单，无法确定安装目标");
    }
    let mut pack = if let Some(parent) = roots.iter().next() {
        let present = |name: &str| {
            manifests
                .iter()
                .any(|path| path.file_name().unwrap() == name)
        };
        if present("modrinth.index.json") && manifests.len() > 1
            || present("mmc-pack.json") && manifests.len() > 1
        {
            bail!("整合包格式存在冲突");
        }
        if parent.join("server.properties").is_file() {
            bail!("这是服务端整合包，请使用客户端导出包");
        }
        if present("modrinth.index.json") {
            modrinth(&read_json(&parent.join("modrinth.index.json"))?, parent)?
        } else if present("mcbbs.packmeta") {
            mcbbs(&read_json(&parent.join("mcbbs.packmeta"))?, parent, cancel)?
        } else if present("manifest.json") {
            curseforge(&read_json(&parent.join("manifest.json"))?, parent)?
        } else {
            multimc(&read_json(&parent.join("mmc-pack.json"))?, parent)?
        }
    } else {
        directory(root, &files)?
    };
    pack.info.optional_files = pack
        .files
        .iter()
        .filter(|f| f.optional)
        .map(|f| f.path.clone())
        .collect();
    pack.info.file_count = pack.files.len() + pack.verified.len();
    Ok(pack)
}

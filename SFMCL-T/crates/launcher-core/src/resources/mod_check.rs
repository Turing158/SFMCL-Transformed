use super::local::{is_mod_archive, read_entry};
use crate::{minecraft::versions, paths::safe_join};
use anyhow::{Context, Result};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet, HashSet},
    fs::{self, File},
    io::{Cursor, Read, Seek},
    path::{Path, PathBuf},
};
use zip::ZipArchive;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Loader {
    Fabric,
    Quilt,
    Forge,
    NeoForge,
    LegacyToml,
    LiteLoader,
}

impl Loader {
    fn label(self) -> &'static str {
        match self {
            Self::Fabric => "Fabric",
            Self::Quilt => "Quilt",
            Self::Forge => "Forge",
            Self::NeoForge => "NeoForge",
            Self::LegacyToml => "Forge / 旧版 NeoForge",
            Self::LiteLoader => "LiteLoader",
        }
    }
}

enum Requirement {
    Mod(String),
    Any(Vec<Self>),
    Unless(Box<Self>, Box<Self>),
}

impl Requirement {
    fn satisfied(&self, present: &HashSet<String>) -> bool {
        match self {
            Self::Mod(id) => present.contains(id),
            Self::Any(options) => options.iter().any(|option| option.satisfied(present)),
            Self::Unless(need, exception) => {
                need.satisfied(present) || exception.satisfied(present)
            }
        }
    }

    fn label(&self) -> String {
        match self {
            Self::Mod(id) => id.clone(),
            Self::Any(options) => options
                .iter()
                .map(Self::label)
                .collect::<Vec<_>>()
                .join(" 或 "),
            Self::Unless(need, _) => need.label(),
        }
    }
}

struct Metadata {
    loader: Loader,
    ids: Vec<String>,
    provides: Vec<String>,
    requires: Vec<Requirement>,
    nested: Vec<String>,
    server_only: bool,
}

impl Metadata {
    fn new(loader: Loader) -> Self {
        Self {
            loader,
            ids: vec![],
            provides: vec![],
            requires: vec![],
            nested: vec![],
            server_only: false,
        }
    }
}

fn json_entry(zip: &mut ZipArchive<impl Read + Seek>, name: &str) -> Option<Value> {
    serde_json::from_slice(&read_entry(zip, name).ok()?).ok()
}

fn json_items(value: &Value) -> impl Iterator<Item = &Value> {
    value.as_array().into_iter().flatten()
}

fn id(value: &Value) -> Option<String> {
    let name = value.as_str()?.rsplit(':').next()?;
    (!name.is_empty()).then(|| name.to_owned())
}

fn quilt_requirement(value: &Value) -> Option<Requirement> {
    if let Some(options) = value.as_array() {
        let options: Vec<_> = options
            .iter()
            .map(quilt_requirement)
            .collect::<Option<_>>()?;
        return (!options.is_empty()).then_some(Requirement::Any(options));
    }
    if value["optional"].as_bool() == Some(true) {
        return None;
    }
    let need = Requirement::Mod(id(if value.is_string() {
        value
    } else {
        &value["id"]
    })?);
    if value["unless"].is_null() {
        Some(need)
    } else {
        let exception = quilt_requirement(&value["unless"])?;
        Some(Requirement::Unless(Box::new(need), Box::new(exception)))
    }
}

fn read_metadata(zip: &mut ZipArchive<impl Read + Seek>) -> Vec<Metadata> {
    let mut layouts = vec![];
    if let Some(fabric) = json_entry(zip, "fabric.mod.json") {
        let mut data = Metadata::new(Loader::Fabric);
        data.ids.extend(id(&fabric["id"]));
        data.provides
            .extend(json_items(&fabric["provides"]).filter_map(id));
        if let Some(dependencies) = fabric["depends"].as_object() {
            data.requires
                .extend(dependencies.keys().cloned().map(Requirement::Mod));
        }
        data.nested.extend(
            json_items(&fabric["jars"]).filter_map(|jar| jar["file"].as_str().map(str::to_owned)),
        );
        data.server_only = fabric["environment"].as_str() == Some("server");
        layouts.push(data);
    }
    if let Some(quilt) = json_entry(zip, "quilt.mod.json") {
        let metadata = &quilt["quilt_loader"];
        let mut data = Metadata::new(Loader::Quilt);
        data.ids.extend(id(&metadata["id"]));
        data.provides.extend(
            json_items(&metadata["provides"])
                .filter_map(|item| id(if item.is_string() { item } else { &item["id"] })),
        );
        data.requires
            .extend(json_items(&metadata["depends"]).filter_map(quilt_requirement));
        data.nested.extend(
            json_items(&metadata["jars"]).filter_map(|jar| jar.as_str().map(str::to_owned)),
        );
        data.server_only = quilt["minecraft"]["environment"].as_str() == Some("dedicated_server");
        layouts.push(data);
    }
    for (loader, name) in [
        (Loader::LegacyToml, "META-INF/mods.toml"),
        (Loader::NeoForge, "META-INF/neoforge.mods.toml"),
    ] {
        if let Some(data) = read_toml(zip, loader, name) {
            layouts.push(data);
        }
    }
    if let Some(lite) = json_entry(zip, "litemod.json") {
        let mut data = Metadata::new(Loader::LiteLoader);
        data.ids.extend(id(&lite["name"]));
        layouts.push(data);
    }
    if !layouts.iter().any(|data| {
        matches!(
            data.loader,
            Loader::Forge | Loader::NeoForge | Loader::LegacyToml
        )
    }) {
        if let Some(legacy) = json_entry(zip, "mcmod.info") {
            let mut data = Metadata::new(Loader::Forge);
            let mods = if legacy.is_array() {
                &legacy
            } else {
                &legacy["modList"]
            };
            data.ids
                .extend(json_items(mods).filter_map(|item| id(&item["modid"])));
            layouts.push(data);
        }
    }
    layouts.retain(|data| !data.ids.is_empty());
    layouts
}

fn read_toml(
    zip: &mut ZipArchive<impl Read + Seek>,
    loader: Loader,
    name: &str,
) -> Option<Metadata> {
    let bytes = read_entry(zip, name).ok()?;
    let metadata: toml::Value = toml::from_str(std::str::from_utf8(&bytes).ok()?).ok()?;
    let mut data = Metadata::new(loader);
    for entry in metadata.get("mods")?.as_array()? {
        let Some(id) = entry.get("modId").and_then(toml::Value::as_str) else {
            continue;
        };
        data.ids.push(id.to_owned());
        let dependencies = metadata
            .get("dependencies")
            .and_then(|table| table.get(id))
            .and_then(toml::Value::as_array);
        for dependency in dependencies.into_iter().flatten() {
            let field = |name| dependency.get(name).and_then(toml::Value::as_str);
            if !(field("type") == Some("required")
                || (field("type").is_none()
                    && dependency.get("mandatory").and_then(toml::Value::as_bool) == Some(true)))
                || field("side").is_some_and(|side| side.eq_ignore_ascii_case("server"))
            {
                continue;
            }
            if let Some(id) = field("modId") {
                if loader == Loader::LegacyToml {
                    match id {
                        "neoforge" => data.loader = Loader::NeoForge,
                        "forge" if data.loader == Loader::LegacyToml => data.loader = Loader::Forge,
                        _ => {}
                    }
                }
                data.requires.push(Requirement::Mod(id.to_owned()));
            }
        }
    }
    if let Some(jarjar) = json_entry(zip, "META-INF/jarjar/metadata.json") {
        data.nested.extend(
            json_items(&jarjar["jars"]).filter_map(|item| item["path"].as_str().map(str::to_owned)),
        );
    }
    Some(data)
}

struct Environment {
    label: &'static str,
    loaders: Vec<Loader>,
}

impl Environment {
    fn from_profile(profile: &Value) -> Self {
        let label = versions::loader(profile);
        let mut loaders = match label {
            "Fabric" => vec![Loader::Fabric],
            "Quilt" => vec![Loader::Quilt, Loader::Fabric],
            "Forge" => vec![Loader::Forge, Loader::LegacyToml],
            "NeoForge" => vec![Loader::NeoForge],
            "LiteLoader" => vec![Loader::LiteLoader],
            _ => vec![],
        };
        for library in json_items(&profile["libraries"]).filter_map(|item| item["name"].as_str()) {
            if library.starts_with("net.neoforged:forge:") {
                loaders.extend([Loader::Forge, Loader::LegacyToml]);
            } else if library.starts_with("net.neoforged:neoforge:20.") {
                loaders.push(Loader::LegacyToml);
            } else if library.starts_with("com.mumfrey:liteloader:") {
                loaders.push(Loader::LiteLoader);
            }
        }
        Self { label, loaders }
    }

    fn metadata(&self, layouts: &[Metadata]) -> Option<usize> {
        self.loaders
            .iter()
            .find_map(|loader| layouts.iter().position(|data| data.loader == *loader))
    }

    fn builtins(&self) -> HashSet<String> {
        let mut ids = HashSet::from(["minecraft".into(), "java".into()]);
        for loader in &self.loaders {
            ids.extend(
                match loader {
                    Loader::Fabric => Some("fabricloader"),
                    Loader::Quilt => Some("quilt_loader"),
                    Loader::Forge => Some("forge"),
                    Loader::NeoForge => Some("neoforge"),
                    Loader::LiteLoader => Some("liteloader"),
                    Loader::LegacyToml => None,
                }
                .map(str::to_owned),
            );
        }
        ids
    }
}

// Bundled libraries can be present in multiple archives. Loaders select a
// version of those libraries, so only top-level mod IDs are used for duplicates.
fn nested_providers(
    zip: &mut ZipArchive<impl Read + Seek>,
    data: &Metadata,
    environment: &Environment,
    present: &mut HashSet<String>,
    budget: &mut u64,
    depth: usize,
) {
    for path in &data.nested {
        let Ok(entry) = zip.by_name(path) else {
            continue;
        };
        if depth == 0 || entry.size() > *budget {
            continue;
        }
        let mut bytes = vec![];
        let mut limited = entry.take(*budget + 1);
        let result = limited.read_to_end(&mut bytes);
        if bytes.len() as u64 > *budget {
            *budget = 0;
            return;
        }
        *budget -= bytes.len() as u64;
        if result.is_err() {
            continue;
        }
        let Ok(mut archive) = ZipArchive::new(Cursor::new(bytes)) else {
            continue;
        };
        let layouts = read_metadata(&mut archive);
        let Some(data) = environment.metadata(&layouts).map(|index| &layouts[index]) else {
            continue;
        };
        if !data.server_only {
            present.extend(data.ids.iter().chain(&data.provides).cloned());
            nested_providers(&mut archive, data, environment, present, budget, depth - 1);
        }
    }
}

#[derive(Debug)]
pub(crate) struct Issues(Vec<String>);

impl std::fmt::Display for Issues {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        writeln!(
            formatter,
            "启动前模组检查发现 {} 项问题，请在「版本管理 → 本地资源 → 模组」处理后重试。",
            self.0.len()
        )?;
        formatter.write_str(&self.0.join("\n"))
    }
}

impl std::error::Error for Issues {}

pub(crate) async fn check(game: PathBuf, profile: Value, isolated: bool) -> Result<()> {
    tokio::task::spawn_blocking(move || check_directory(&game, &profile, isolated)).await?
}

fn open_archive(path: &Path) -> Option<ZipArchive<File>> {
    ZipArchive::new(File::open(path).ok()?).ok()
}

fn check_directory(game: &Path, profile: &Value, isolated: bool) -> Result<()> {
    let mut environment = Environment::from_profile(profile);
    // Profiles without a mod loader can share a directory with modded profiles.
    if environment.loaders.is_empty() && !isolated {
        return Ok(());
    }
    let folder = safe_join(game, "mods")?;
    let entries = match fs::read_dir(&folder) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error).context("无法读取启动目录的模组列表"),
    };
    let mut paths = vec![];
    for entry in entries {
        let entry = entry?;
        let path = entry.path();
        if entry.file_type()?.is_file()
            && !super::local::has_disabled_suffix(&path)
            && is_mod_archive(&path)
        {
            paths.push(safe_join(game, Path::new("mods").join(entry.file_name()))?);
        }
    }
    paths.sort();
    let mut manifests = vec![];
    for path in paths {
        let Some(mut archive) = open_archive(&path) else {
            continue;
        };
        let layouts = read_metadata(&mut archive);
        if !layouts.is_empty() {
            manifests.push((path, layouts));
        }
    }
    // Sinytra Connector adds Fabric support to a Forge-family instance.
    if environment
        .loaders
        .iter()
        .any(|loader| matches!(loader, Loader::Forge | Loader::NeoForge))
        && manifests.iter().any(|(_, layouts)| {
            environment
                .metadata(layouts)
                .is_some_and(|index| layouts[index].ids.iter().any(|id| id == "connector"))
        })
    {
        environment.loaders.push(Loader::Fabric);
    }
    let mut issues = vec![];
    let mut present = environment.builtins();
    let mut owners = BTreeMap::<&str, BTreeSet<String>>::new();
    let mut requirements = vec![];
    for (path, layouts) in &manifests {
        let file = path.file_name().unwrap_or_default().to_string_lossy();
        let Some(data) = environment.metadata(layouts).map(|index| &layouts[index]) else {
            let declared = layouts
                .iter()
                .filter(|data| !data.server_only)
                .map(|data| data.loader.label())
                .collect::<BTreeSet<_>>();
            if !declared.is_empty() {
                issues.push(format!(
                    "加载器不匹配：{file} 支持 {}，当前是 {}。",
                    declared.into_iter().collect::<Vec<_>>().join(" / "),
                    environment.label,
                ));
            }
            continue;
        };
        if data.server_only {
            continue;
        }
        for id in &data.ids {
            owners.entry(id).or_default().insert(file.to_string());
        }
        present.extend(data.ids.iter().chain(&data.provides).cloned());
        if !data.nested.is_empty() {
            if let Some(mut archive) = open_archive(path) {
                let mut budget = 64 * 1024 * 1024;
                nested_providers(
                    &mut archive,
                    data,
                    &environment,
                    &mut present,
                    &mut budget,
                    4,
                );
            }
        }
        requirements.push((file, &data.requires));
    }
    for (id, files) in owners {
        if files.len() > 1 {
            issues.push(format!(
                "重复模组：{id} 出现在 {}。",
                files.into_iter().collect::<Vec<_>>().join("、"),
            ));
        }
    }
    for (file, needs) in requirements {
        let missing: BTreeSet<_> = needs
            .iter()
            .filter(|need| !need.satisfied(&present))
            .map(Requirement::label)
            .collect();
        if !missing.is_empty() {
            issues.push(format!(
                "缺少依赖：{file} 需要 {}。",
                missing.into_iter().collect::<Vec<_>>().join("、")
            ));
        }
    }
    if issues.is_empty() {
        Ok(())
    } else {
        Err(Issues(issues).into())
    }
}

#[cfg(test)]
mod tests;

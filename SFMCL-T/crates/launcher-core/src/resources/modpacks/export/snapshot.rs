use super::*;
use crate::minecraft::{version_settings, versions};
use std::io::Read;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExportTarget {
    pub root: PathBuf,
    pub id: String,
    pub game: PathBuf,
    pub minecraft: String,
    pub loader: Option<ExportLoader>,
    pub shared: bool,
    pub environment: String,
}

impl ExportTarget {
    pub(super) fn validate_environment(&self) -> Result<()> {
        let profile = versions::resolve(&self.root, &self.id)?;
        if serde_json::to_string(&json!([profile, !self.shared]))? != self.environment {
            bail!("版本信息已变化，请重新扫描");
        }
        Ok(())
    }

    pub fn resolve(root: PathBuf, id: &str, settings: &crate::config::Settings) -> Result<Self> {
        let profile = versions::resolve(&root, id)?;
        let resolved = version_settings::resolve(&root, id, settings)?;
        let game = version_settings::game_directory(&root, id, settings)?;
        let minecraft = versions::minecraft_version(&root, id, &profile)?;
        let mut found = BTreeMap::new();
        let forge_prefix = format!("{minecraft}-");
        let mut forge_fml_version = None;
        for library in profile["libraries"].as_array().into_iter().flatten() {
            let Some(name) = library["name"].as_str() else {
                continue;
            };
            if let Some(version) = name
                .strip_prefix("net.minecraftforge:fmlloader:")
                .and_then(|version| version.strip_prefix(&forge_prefix))
            {
                forge_fml_version = version.split(':').next();
                continue;
            }
            for (prefix, kind) in [
                ("net.fabricmc:fabric-loader:", "Fabric"),
                ("org.quiltmc:quilt-loader:", "Quilt"),
                ("net.minecraftforge:forge:", "Forge"),
                ("net.minecraftforge:minecraftforge:", "Forge"),
                ("net.neoforged:neoforge:", "NeoForge"),
            ] {
                if let Some(version) = name.strip_prefix(prefix) {
                    let version = version.split(':').next().unwrap_or("");
                    let version = if kind == "Forge" {
                        version.strip_prefix(&forge_prefix).unwrap_or(version)
                    } else {
                        version
                    };
                    crate::paths::valid_name(version)?;
                    // Child libraries override inherited versions of the same loader.
                    found.insert(kind.to_owned(), version.to_owned());
                }
            }
        }
        // Some complete Forge profiles declare only fmlloader as a library.
        if let Some(version) = forge_fml_version.filter(|_| !found.contains_key("Forge")) {
            crate::paths::valid_name(version)?;
            found.insert("Forge".to_owned(), version.to_owned());
        }
        if let Some(version) =
            versions::neoforge_profile_version(&profile).filter(|_| !found.contains_key("NeoForge"))
        {
            crate::paths::valid_name(version)?;
            found.insert("NeoForge".to_owned(), version.to_owned());
        }
        if found.len() > 1 {
            bail!("版本包含多个加载器，无法导出标准整合包");
        }
        let loader = found
            .into_iter()
            .next()
            .map(|(kind, version)| ExportLoader { kind, version });
        if profile["libraries"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|library| {
                library["name"].as_str().is_some_and(|name| {
                    name.starts_with("optifine:") || name.starts_with("com.mumfrey:liteloader:")
                })
            })
        {
            bail!("该版本包含标准整合包无法声明的附加加载组件，请先移除后再导出");
        }
        if let Some(main) = profile["mainClass"].as_str() {
            let supported = match loader.as_ref().map(|v| v.kind.as_str()) {
                None => main == "net.minecraft.client.main.Main",
                Some("Fabric") => {
                    main.starts_with("net.fabricmc.loader.") && main.ends_with("KnotClient")
                }
                Some("Quilt") => {
                    main.starts_with("org.quiltmc.loader.") && main.ends_with("KnotClient")
                }
                Some("Forge" | "NeoForge") => matches!(
                    main,
                    "cpw.mods.modlauncher.Launcher"
                        | "net.minecraft.launchwrapper.Launch"
                        | "cpw.mods.bootstraplauncher.BootstrapLauncher"
                        | "net.neoforged.fml.startup.Client"
                ),
                _ => false,
            };
            if !supported {
                bail!("该版本使用自定义启动组件，无法保证标准整合包还原，请使用标准游戏版本制作");
            }
        }
        if loader.is_none() && versions::loader(&profile) != "Vanilla" {
            bail!("该版本的加载器无法用 Modrinth 或 CurseForge 清单描述");
        }
        let environment = serde_json::to_string(&json!([profile, resolved.isolation]))?;
        Ok(Self {
            root,
            id: id.into(),
            game,
            minecraft,
            loader,
            shared: !resolved.isolation,
            environment,
        })
    }
}

pub(super) fn check_cancel(cancel: &CancellationToken) -> Result<()> {
    if cancel.is_cancelled() {
        bail!("整合包导出已取消");
    }
    Ok(())
}

pub(super) fn excluded(path: &str) -> bool {
    let path = path.to_lowercase();
    let top = path.split('/').next().unwrap_or("");
    if matches!(
        top,
        "versions"
            | "libraries"
            | "assets"
            | "natives"
            | "runtime"
            | "java"
            | "logs"
            | "crash-reports"
            | "cache"
            | "caches"
            | ".cache"
            | "webcache"
            | "downloads"
            | "tmp"
            | "temp"
            | ".tmcl"
            | ".sfmcl-t"
            | "sfmcl"
            | ".git"
            | "backups"
    ) || top.starts_with("launcher_")
        || top.starts_with(".starfall-")
    {
        return true;
    }
    path.split('/').any(|part| {
        matches!(
            part,
            "accounts.json"
                | "launcher_accounts.json"
                | "launcher_profiles.json"
                | "usercache.json"
                | "usernamecache.json"
                | "session.lock"
                | "authlib-injector.jar"
                | ".env"
                | ".ds_store"
        ) || part.ends_with(".tmp")
            || part.ends_with(".temp")
            || part.ends_with(".log")
            || part.contains("credentials")
            || part.contains("access_token")
            || part.contains("refresh_token")
    })
}

fn default_selected(path: &str) -> bool {
    let lower = path.to_lowercase();
    let top = lower.split('/').next().unwrap_or("");
    matches!(
        top,
        "mods"
            | "config"
            | "defaultconfigs"
            | "kubejs"
            | "scripts"
            | "crafttweaker"
            | "patchouli_books"
            | "customnpcs"
    ) && !lower.ends_with(".disabled")
        && !lower.ends_with(".disable")
}

pub(super) fn resource_file(path: &str) -> bool {
    let lower = path.to_lowercase();
    let lower = lower
        .strip_suffix(".disabled")
        .or_else(|| lower.strip_suffix(".disable"))
        .unwrap_or(&lower);
    let top = lower.split('/').next().unwrap_or("");
    matches!(top, "mods" | "resourcepacks" | "shaderpacks")
        && matches!(
            Path::new(&lower).extension().and_then(|v| v.to_str()),
            Some("jar" | "zip")
        )
}

pub(super) fn scan(target: &ExportTarget) -> Result<(Vec<ExportFile>, Vec<String>)> {
    fn visit(
        target: &ExportTarget,
        relative: &str,
        depth: usize,
        files: &mut Vec<ExportFile>,
        skipped: &mut usize,
        total: &mut u64,
    ) -> Result<()> {
        if depth > 64 {
            bail!("游戏目录嵌套过深");
        }
        let directory = if relative.is_empty() {
            target.game.clone()
        } else {
            safe_join(&target.game, relative)?
        };
        if !directory.exists() {
            return Ok(());
        }
        for entry in std::fs::read_dir(directory)? {
            let entry = entry?;
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| anyhow::anyhow!("文件名不是有效 Unicode"))?;
            let path = if relative.is_empty() {
                name
            } else {
                format!("{relative}/{name}")
            };
            if excluded(&path)
                || relative.is_empty()
                    && (path.eq_ignore_ascii_case(&format!("{}.json", target.id))
                        || path.eq_ignore_ascii_case(&format!("{}.jar", target.id)))
            {
                *skipped += 1;
                continue;
            }
            let safe = match safe_join(&target.game, &path) {
                Ok(path) => path,
                Err(_) => {
                    *skipped += 1;
                    continue;
                }
            };
            let meta = std::fs::symlink_metadata(safe)?;
            if meta.is_dir() {
                visit(target, &path, depth + 1, files, skipped, total)?;
            } else if meta.is_file() {
                *total = total.checked_add(meta.len()).context("文件大小溢出")?;
                if files.len() >= 250_000 {
                    bail!("扫描文件数量过多，请先整理游戏目录");
                }
                files.push(ExportFile {
                    selected: default_selected(&path),
                    size: meta.len(),
                    modified: meta
                        .modified()?
                        .duration_since(std::time::UNIX_EPOCH)?
                        .as_nanos()
                        .to_string(),
                    path,
                });
            }
        }
        Ok(())
    }
    let mut files = vec![];
    let mut skipped = 0;
    visit(target, "", 0, &mut files, &mut skipped, &mut 0)?;
    files.sort_by(|a, b| a.path.cmp(&b.path));
    let mut names = HashSet::new();
    for file in &files {
        if !names.insert(file.path.to_lowercase()) {
            bail!("文件路径存在大小写冲突：{}", file.path);
        }
    }
    let mut warnings = vec![];
    if target.shared {
        warnings.push("该版本使用共享游戏目录，请检查是否包含其他版本的模组或配置。".into());
    }
    if skipped > 0 {
        warnings.push(format!(
            "已排除 {skipped} 个运行资源、个人配置、临时文件或链接入口。"
        ));
    }
    Ok((files, warnings))
}

pub(super) fn digest(
    target: &ExportTarget,
    file: &ExportFile,
    cancel: &CancellationToken,
) -> Result<HashedFile> {
    let path = safe_join(&target.game, &file.path)?;
    let mut input =
        std::fs::File::open(&path).with_context(|| format!("无法读取 {}", file.path))?;
    let before = input.metadata()?;
    let modified = before
        .modified()?
        .duration_since(std::time::UNIX_EPOCH)?
        .as_nanos()
        .to_string();
    if before.len() != file.size || modified != file.modified {
        bail!("文件已变化，请重新扫描：{}", file.path);
    }
    let mut sha1 = sha1::Sha1::new();
    let mut sha512 = sha2::Sha512::new();
    let mut buffer = vec![0; 128 * 1024];
    let mut size = 0;
    loop {
        check_cancel(cancel)?;
        let count = input.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        size += count as u64;
        sha1.update(&buffer[..count]);
        sha512.update(&buffer[..count]);
    }
    if size != file.size || input.metadata()?.modified()? != before.modified()? {
        bail!("文件读取期间发生变化：{}", file.path);
    }
    Ok(HashedFile {
        file: file.clone(),
        sha1: hex::encode(sha1.finalize()),
        sha512: hex::encode(sha512.finalize()),
    })
}

pub(super) fn validate_files(
    target: &ExportTarget,
    files: &[HashedFile],
    cancel: &CancellationToken,
) -> Result<()> {
    for file in files {
        let actual = digest(target, &file.file, cancel)?;
        if actual.sha1 != file.sha1 || actual.sha512 != file.sha512 {
            bail!("文件内容已变化，请重新检查：{}", file.file.path);
        }
    }
    Ok(())
}

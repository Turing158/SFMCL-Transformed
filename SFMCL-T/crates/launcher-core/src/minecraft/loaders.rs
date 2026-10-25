use super::{
    installer::{get_json, InstallRequest, Installer, BMCL},
    java,
    process::run_java,
    versions::{self, maven_path},
};
use crate::{
    downloads::DownloadSpec,
    jobs::{self, Job},
    paths::{atomic_write, safe_join, valid_name},
};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    io::Read,
    path::{Path, PathBuf},
    sync::Arc,
};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoaderChoice {
    pub kind: String,
    pub version: String,
    #[serde(default)]
    pub metadata: Value,
}

fn optifine_forge_version(choice: &LoaderChoice) -> Option<&str> {
    let mut version = choice.metadata["forge"].as_str()?.trim();
    if version
        .get(..5)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("forge"))
    {
        version = version[5..].trim();
    }
    (version.contains('.')
        && version
            .split('.')
            .all(|part| !part.is_empty() && part.bytes().all(|c| c.is_ascii_digit())))
    .then_some(version)
}

fn validate_minecraft_version(choice: &LoaderChoice, minecraft: &str) -> Result<()> {
    let declared = choice.metadata["mcversion"]
        .as_str()
        .or_else(|| choice.metadata["minecraft"].as_str());
    if let Some(declared) = declared {
        if declared != minecraft {
            bail!(
                "{} {} 适用于 Minecraft {declared}，不能安装到 {minecraft}",
                choice.kind,
                choice.version
            );
        }
    }
    Ok(())
}

fn validate_loader_profile(choice: &LoaderChoice, minecraft: &str, profile: &Value) -> Result<()> {
    let declared = profile["inheritsFrom"]
        .as_str()
        .context("加载器安装配置缺少 Minecraft 版本")?;
    if declared != minecraft {
        bail!(
            "{} {} 的安装配置适用于 Minecraft {declared}，不能安装到 {minecraft}",
            choice.kind,
            choice.version
        );
    }
    Ok(())
}

pub fn validate_selection(request: &InstallRequest) -> Result<()> {
    if let Some(loader) = &request.loader {
        if ![
            "Forge",
            "NeoForge",
            "Fabric",
            "Quilt",
            "OptiFine",
            "LiteLoader",
        ]
        .contains(&loader.kind.as_str())
        {
            bail!("未知加载器类型");
        }
        valid_name(&loader.version)?;
        validate_minecraft_version(loader, &request.minecraft)?;
    }
    if let Some(optifine) = &request.optifine {
        let forge = request
            .loader
            .as_ref()
            .filter(|l| l.kind == "Forge")
            .context("附加 OptiFine 需要 Forge")?;
        if optifine.kind != "OptiFine" {
            bail!("附加加载器必须为 OptiFine");
        }
        valid_name(&optifine.version)?;
        validate_minecraft_version(optifine, &request.minecraft)?;
        let required = optifine_forge_version(optifine)
            .context("此 OptiFine 未标注兼容的 Forge 版本，请独立安装或选择其他版本")?;
        if required != forge.version {
            bail!(
                "此 OptiFine 需要 Forge {required}，所选版本是 {}",
                forge.version
            );
        }
    }
    if request.fabric_api.is_some() && request.loader.as_ref().is_none_or(|l| l.kind != "Fabric") {
        bail!("Fabric API 需要 Fabric Loader");
    }
    Ok(())
}

pub async fn catalog(
    client: &reqwest::Client,
    minecraft: &str,
    kind: &str,
) -> Result<Vec<LoaderChoice>> {
    valid_name(minecraft)?;
    let url = match kind {
        "Fabric" => format!("https://meta.fabricmc.net/v2/versions/loader/{minecraft}"),
        "Quilt" => format!("https://meta.quiltmc.org/v3/versions/loader/{minecraft}"),
        "Forge" => format!("{BMCL}/forge/minecraft/{minecraft}"),
        "NeoForge" => format!("{BMCL}/neoforge/list/{minecraft}"),
        "OptiFine" => format!("{BMCL}/optifine/{minecraft}"),
        "LiteLoader" => format!("{BMCL}/liteloader/list?mcversion={minecraft}"),
        _ => bail!("未知加载器"),
    };
    let value = get_json(client, &url, None).await?;
    let items = if kind == "LiteLoader" {
        if value["version"].is_string() {
            vec![value]
        } else {
            vec![]
        }
    } else {
        value.as_array().context("加载器清单格式错误")?.clone()
    };
    let mut choices: Vec<_> = items
        .into_iter()
        .filter_map(|item| catalog_choice(minecraft, kind, item))
        .collect();
    if ["NeoForge", "OptiFine"].contains(&kind) {
        choices.reverse();
    }
    if kind == "Forge" {
        choices.sort_by(|a, b| {
            b.metadata["modified"]
                .as_str()
                .cmp(&a.metadata["modified"].as_str())
        });
    }
    Ok(choices)
}

fn catalog_choice(minecraft: &str, kind: &str, mut item: Value) -> Option<LoaderChoice> {
    let version = if ["Fabric", "Quilt"].contains(&kind) {
        let version = item["loader"]["version"].as_str()?.to_owned();
        // Intermediary is a mapping artifact version, which can be 0.0.0 for
        // unobfuscated Minecraft releases. Bind choices to the catalog target.
        item.as_object_mut()?
            .entry("minecraft")
            .or_insert_with(|| json!(minecraft));
        version
    } else if kind == "OptiFine" {
        format!("{}_{}", item["type"].as_str()?, item["patch"].as_str()?)
    } else {
        item["version"].as_str()?.to_owned()
    };
    Some(LoaderChoice {
        kind: kind.into(),
        version,
        metadata: item,
    })
}

fn archive_json(path: &Path, name: &str) -> Result<Value> {
    let mut archive = zip::ZipArchive::new(std::fs::File::open(path)?)?;
    let mut entry = archive.by_name(name)?;
    if entry.size() > 16 * 1024 * 1024 {
        bail!("安装器元数据过大");
    }
    let mut text = String::new();
    entry.read_to_string(&mut text)?;
    Ok(serde_json::from_str(&text)?)
}
fn unpack_maven(archive_path: &Path, root: &Path, work: &Path) -> Result<()> {
    let mut archive = zip::ZipArchive::new(std::fs::File::open(archive_path)?)?;
    let mut expanded = 0u64;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index)?;
        if entry.is_dir() {
            continue;
        }
        let target = if let Some(name) = entry.name().strip_prefix("maven/") {
            safe_join(root, format!("libraries/{name}"))?
        } else if entry.name().starts_with("data/") {
            safe_join(work, entry.name())?
        } else {
            continue;
        };
        expanded += entry.size();
        if expanded > 1024 * 1024 * 1024 {
            bail!("安装器解压大小超过限制");
        }
        let mut bytes = Vec::new();
        entry.read_to_end(&mut bytes)?;
        atomic_write(&target, &bytes)?;
    }
    Ok(())
}
fn installer_url(minecraft: &str, choice: &LoaderChoice) -> Result<String> {
    valid_name(&choice.version)?;
    Ok(match choice.kind.as_str() {
        "Forge" => {
            let build = choice.metadata["build"]
                .as_u64()
                .map(|n| n.to_string())
                .or_else(|| choice.metadata["build"].as_str().map(str::to_owned));
            if let Some(build) = build {
                valid_name(&build)?;
                format!("{BMCL}/forge/download/{build}")
            } else {
                format!("{BMCL}/forge/download?mcversion={minecraft}&version={}&category=installer&format=jar", choice.version)
            }
        }
        "NeoForge" => format!(
            "{BMCL}/neoforge/version/{}/download/installer.jar",
            choice.version
        ),
        "OptiFine" => {
            let kind = choice.metadata["type"]
                .as_str()
                .context("OptiFine 缺少类型")?;
            let patch = choice.metadata["patch"]
                .as_str()
                .context("OptiFine 缺少补丁版本")?;
            valid_name(kind)?;
            valid_name(patch)?;
            format!("{BMCL}/optifine/{minecraft}/{kind}/{patch}")
        }
        "LiteLoader" => {
            let mc = if ["1.8", "1.9"].contains(&minecraft) {
                format!("{minecraft}.0")
            } else {
                minecraft.into()
            };
            if choice.metadata["type"].as_str() == Some("RELEASE") {
                let version = if choice.version.contains('_') {
                    choice.version.clone()
                } else {
                    format!("{mc}_00")
                };
                format!(
                    "https://dl.liteloader.com/redist/{mc}/liteloader-installer-{}.jar",
                    version.replace('_', "-")
                )
            } else {
                format!("https://jenkins.liteloader.com/job/LiteLoaderInstaller%20{minecraft}/lastSuccessfulBuild/artifact/build/libs/liteloader-installer-{}-00-SNAPSHOT.jar", choice.version.replace("-SNAPSHOT", "").replace("1.9", "1.9.0"))
            }
        }
        _ => bail!("该加载器不使用 JAR 安装器"),
    })
}
async fn download_installer(
    installer: &Installer,
    request: &InstallRequest,
    choice: &LoaderChoice,
    work: &Path,
    job: &Job,
) -> Result<PathBuf> {
    let path = work.join(format!("{}-installer.jar", choice.kind));
    let file = DownloadSpec {
        path: path
            .strip_prefix(&request.root)?
            .to_string_lossy()
            .into_owned(),
        url: installer_url(&request.minecraft, choice)?,
        size: None,
        sha1: None,
        sha512: None,
    };
    jobs::download(
        &installer.downloads,
        job,
        format!("{} 安装器", choice.kind),
        request.root.clone(),
        vec![file],
    )
    .await?;
    Ok(path)
}
async fn library_downloads(
    installer: &Installer,
    root: &Path,
    profile: &Value,
    job: &Job,
) -> Result<()> {
    download_libraries(installer, root, versions::libraries(profile)?, job).await
}

// Processor classpaths refer to exact coordinates. Unlike the game classpath,
// different versions of one artifact must all be available on disk.
fn processor_libraries(profile: &Value) -> Result<Vec<versions::Library>> {
    let mut result = Vec::new();
    let mut seen = HashSet::new();
    for library in profile["libraries"].as_array().into_iter().flatten() {
        for lib in versions::libraries(&json!({"libraries": [library]}))? {
            if seen.insert(lib.file.path.clone()) {
                result.push(lib);
            }
        }
    }
    Ok(result)
}

async fn download_libraries(
    installer: &Installer,
    root: &Path,
    libraries: Vec<versions::Library>,
    job: &Job,
) -> Result<()> {
    let mut files = vec![];
    for lib in libraries {
        let target = safe_join(root, &lib.file.path)?;
        if lib.file.url.is_empty() {
            continue;
        }
        if target.exists() && lib.file.sha1.is_none() && lib.file.sha512.is_none() {
            continue;
        }
        files.push(lib.file);
    }
    jobs::download(
        &installer.downloads,
        job,
        "加载器依赖".into(),
        root.into(),
        files,
    )
    .await
}

pub async fn install(
    installer: &Installer,
    request: &InstallRequest,
    base: &Value,
    choice: &LoaderChoice,
    work: &Path,
    job: Arc<Job>,
) -> Result<Value> {
    valid_name(&choice.version)?;
    match choice.kind.as_str() {
        "Fabric" | "Quilt" => {
            let url = if choice.kind == "Fabric" {
                format!(
                    "https://meta.fabricmc.net/v2/versions/loader/{}/{}/profile/json",
                    request.minecraft, choice.version
                )
            } else {
                format!(
                    "https://meta.quiltmc.org/v3/versions/loader/{}/{}/profile/json",
                    request.minecraft, choice.version
                )
            };
            let patch = get_json(&installer.client, &url, Some(&job)).await?;
            validate_loader_profile(choice, &request.minecraft, &patch)?;
            let profile = versions::merge(base, &patch);
            library_downloads(installer, &request.root, &profile, &job).await?;
            Ok(profile)
        }
        "LiteLoader" => {
            let patch = liteloader_profile(base, choice)?;
            let profile = versions::merge(base, &patch);
            library_downloads(installer, &request.root, &profile, &job).await?;
            if let Some(expected) = choice.metadata["hash"]
                .as_str()
                .or(choice.metadata["build"]["md5"].as_str())
            {
                use md5::Digest;
                let path = safe_join(
                    &request.root,
                    format!(
                        "libraries/{}",
                        maven_path(&format!("com.mumfrey:liteloader:{}", choice.version))?
                    ),
                )?;
                let actual = hex::encode(md5::Md5::digest(std::fs::read(&path)?));
                if !actual.eq_ignore_ascii_case(expected) {
                    std::fs::remove_file(path)?;
                    bail!("LiteLoader 文件校验失败，请重试安装");
                }
            }
            Ok(profile)
        }
        "Forge" | "NeoForge" => {
            let archive = download_installer(installer, request, choice, work, &job).await?;
            let install = archive_json(&archive, "install_profile.json")?;
            unpack_maven(&archive, &request.root, work)?;
            let patch = archive_json(&archive, "version.json").or_else(|_| {
                install
                    .get("versionInfo")
                    .cloned()
                    .context("安装器缺少版本配置")
            })?;
            let profile = versions::merge(base, &patch);
            if install["processors"].is_array() {
                download_libraries(
                    installer,
                    &request.root,
                    processor_libraries(&install)?,
                    &job,
                )
                .await?;
                // Client mappings are fetched through the managed downloader too.
                if let Some(url) = base["downloads"]["client_mappings"]["url"].as_str() {
                    let data = &base["downloads"]["client_mappings"];
                    let path = format!(
                        "libraries/{}",
                        maven_path(&format!(
                            "net.minecraft:client:{}:mappings@txt",
                            request.minecraft
                        ))?
                    );
                    jobs::download(
                        &installer.downloads,
                        &job,
                        "Minecraft 映射文件".into(),
                        request.root.clone(),
                        vec![versions::spec(data, path, url.into())],
                    )
                    .await?;
                }
                run_processors(
                    installer,
                    request,
                    &install,
                    &archive,
                    work,
                    versions::required_java(base),
                    job.clone(),
                )
                .await?;
            } else {
                unpack_legacy(&archive, &install, &request.root)?;
            }
            library_downloads(installer, &request.root, &profile, &job).await?;
            Ok(profile)
        }
        "OptiFine" => {
            let archive = download_installer(installer, request, choice, work, &job).await?;
            let version = format!("{}_{}", request.minecraft, choice.version);
            let relative = maven_path(&format!("optifine:OptiFine:{version}"))?;
            let target = safe_join(&request.root, format!("libraries/{relative}"))?;
            patch_optifine(installer, request, &archive, &target, job.clone()).await?;
            let mut patch = json!({"mainClass":"net.minecraft.launchwrapper.Launch", "libraries":[{"name":format!("optifine:OptiFine:{version}"),"downloads":{"artifact":{"path":relative,"url":""}}}]});
            // Newer OptiFine installers carry a patched LaunchWrapper.
            let mut zip = zip::ZipArchive::new(std::fs::File::open(&archive)?)?;
            let name = (0..zip.len()).find_map(|i| {
                let file = zip.by_index(i).ok()?;
                (file.name().contains("launchwrapper") && file.name().ends_with(".jar"))
                    .then(|| file.name().to_owned())
            });
            if let Some(name) = name {
                let mut entry = zip.by_name(&name)?;
                let mut bytes = vec![];
                entry.read_to_end(&mut bytes)?;
                let file_name = Path::new(&name).file_name().unwrap().to_string_lossy();
                let v = file_name
                    .trim_start_matches("launchwrapper-of-")
                    .trim_end_matches(".jar");
                valid_name(v)?;
                let path = maven_path(&format!("optifine:launchwrapper-of:{v}"))?;
                atomic_write(
                    &safe_join(&request.root, format!("libraries/{path}"))?,
                    &bytes,
                )?;
                patch["libraries"].as_array_mut().unwrap().push(json!({"name":format!("optifine:launchwrapper-of:{v}"),"downloads":{"artifact":{"path":path,"url":""}}}));
            } else {
                patch["libraries"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!({"name":"net.minecraft:launchwrapper:1.12"}));
            }
            if let Some(legacy) = base["minecraftArguments"].as_str() {
                patch["minecraftArguments"] =
                    json!(format!("{legacy} --tweakClass optifine.OptiFineTweaker"));
            } else {
                patch["arguments"] = json!({"game":["--tweakClass", "optifine.OptiFineTweaker"]});
            }
            let profile = versions::merge(base, &patch);
            drop(zip);
            library_downloads(installer, &request.root, &profile, &job).await?;
            Ok(profile)
        }
        _ => bail!("未知加载器类型"),
    }
}

fn liteloader_profile(base: &Value, choice: &LoaderChoice) -> Result<Value> {
    let coordinate = format!("com.mumfrey:liteloader:{}", choice.version);
    let path = maven_path(&coordinate)?;
    let build = &choice.metadata["build"];
    let mut libraries = build["libraries"].as_array().cloned().unwrap_or_default();
    for library in &mut libraries {
        if library["url"].is_null() && library["downloads"].is_null() {
            library["url"] = json!(format!("{BMCL}/maven/"));
        }
    }
    libraries.push(json!({"name": coordinate, "downloads": {"artifact": {
        "path": path, "url": format!("{BMCL}/maven/{path}")
    }}}));
    let tweak = build["tweakClass"]
        .as_str()
        .unwrap_or("com.mumfrey.liteloader.launch.LiteLoaderTweaker");
    let mut patch =
        json!({"mainClass": "net.minecraft.launchwrapper.Launch", "libraries": libraries});
    if let Some(args) = base["minecraftArguments"].as_str() {
        patch["minecraftArguments"] = json!(format!("{args} --tweakClass {tweak}"));
    } else {
        patch["arguments"] = json!({"game": ["--tweakClass", tweak]});
    }
    Ok(patch)
}

fn unpack_legacy(archive: &Path, install: &Value, root: &Path) -> Result<()> {
    let mut zip = zip::ZipArchive::new(std::fs::File::open(archive)?)?;
    if let (Some(file), Some(coordinate)) = (
        install["install"]["filePath"].as_str(),
        install["install"]["path"].as_str(),
    ) {
        let mut entry = zip.by_name(file)?;
        let mut bytes = vec![];
        entry.read_to_end(&mut bytes)?;
        return atomic_write(
            &safe_join(root, format!("libraries/{}", maven_path(coordinate)?))?,
            &bytes,
        );
    }
    let version = install["install"]["minecraft"]
        .as_str()
        .context("旧版安装器缺少 Minecraft 版本")?;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i)?;
        if entry.name().contains(&format!("liteloader-{version}")) && entry.name().ends_with(".jar")
        {
            let name = Path::new(entry.name())
                .file_name()
                .context("LiteLoader 文件名无效")?
                .to_string_lossy()
                .into_owned();
            let target = safe_join(
                root,
                format!("libraries/com/mumfrey/liteloader/{version}/{name}"),
            )?;
            let mut bytes = vec![];
            entry.read_to_end(&mut bytes)?;
            return atomic_write(&target, &bytes);
        }
    }
    bail!("安装器缺少可提取的加载器 JAR")
}
async fn patch_optifine(
    installer: &Installer,
    request: &InstallRequest,
    archive: &Path,
    output: &Path,
    job: Arc<Job>,
) -> Result<()> {
    let settings = installer.settings.get();
    let java = java::select(&settings.java_path, &settings.java_paths, 8).await?;
    let input = safe_join(&request.root, format!("versions/{0}/{0}.jar", request.name))?;
    std::fs::create_dir_all(output.parent().unwrap())?;
    let args = vec![
        "-cp".into(),
        archive.to_string_lossy().into_owned(),
        "optifine.Patcher".into(),
        input.to_string_lossy().into_owned(),
        archive.to_string_lossy().into_owned(),
        output.to_string_lossy().into_owned(),
    ];
    run_java(&java.path, &args, &request.root, job, &[]).await?;
    if !output.is_file() {
        bail!("OptiFine 未生成目标 JAR");
    }
    Ok(())
}
pub async fn install_optifine_mod(
    installer: &Installer,
    request: &InstallRequest,
    choice: &LoaderChoice,
    work: &Path,
    job: Arc<Job>,
) -> Result<()> {
    let archive = download_installer(installer, request, choice, work, &job).await?;
    if job.cancel.is_cancelled() {
        bail!(job.cancellation_message());
    }
    write_optifine_mod(
        request,
        choice,
        installer.settings.get().isolation,
        &archive,
    )
}

fn write_optifine_mod(
    request: &InstallRequest,
    choice: &LoaderChoice,
    isolation: bool,
    archive: &Path,
) -> Result<()> {
    let output = optifine_mod_path(request, choice, isolation)?;
    // Forge applies the original JAR's patches at runtime. Expanding them with
    // Patcher would expose Minecraft classes in OptiFine's srg module as well,
    // causing split-package errors against Forge's minecraft module.
    atomic_write(&output, &std::fs::read(archive)?)
}

fn optifine_mod_path(
    request: &InstallRequest,
    choice: &LoaderChoice,
    isolation: bool,
) -> Result<PathBuf> {
    let game = versions::game_directory(&request.root, &request.name, isolation)?;
    safe_join(
        &game,
        format!("mods/OptiFine_{}_{}.jar", request.minecraft, choice.version),
    )
}

fn expand(value: &str, data: &HashMap<String, String>, root: &Path, work: &Path) -> Result<String> {
    let mut expanded = value.to_owned();
    for _ in 0..12 {
        let before = expanded.clone();
        for (key, value) in data {
            expanded = expanded.replace(&format!("{{{key}}}"), value);
        }
        if before == expanded {
            break;
        }
    }
    if expanded.starts_with('[') && expanded.ends_with(']') {
        return Ok(safe_join(
            root,
            format!(
                "libraries/{}",
                maven_path(&expanded[1..expanded.len() - 1])?
            ),
        )?
        .to_string_lossy()
        .into_owned());
    }
    if expanded.starts_with("/data/") {
        return Ok(safe_join(work, expanded.trim_start_matches('/'))?
            .to_string_lossy()
            .into_owned());
    }
    if expanded.starts_with('\'') && expanded.ends_with('\'') {
        expanded = expanded[1..expanded.len() - 1].into();
    }
    if expanded.contains('{') {
        bail!("安装处理器存在未解析占位符：{expanded}");
    }
    Ok(expanded)
}
async fn run_processors(
    installer: &Installer,
    request: &InstallRequest,
    profile: &Value,
    archive: &Path,
    work: &Path,
    required_java: u32,
    job: Arc<Job>,
) -> Result<()> {
    let settings = installer.settings.get();
    let java = java::select(&settings.java_path, &settings.java_paths, required_java).await?;
    let mut data = HashMap::from([
        ("SIDE".into(), "client".into()),
        ("ROOT".into(), request.root.to_string_lossy().into_owned()),
        (
            "LIBRARY_DIR".into(),
            request
                .root
                .join("libraries")
                .to_string_lossy()
                .into_owned(),
        ),
        (
            "MINECRAFT_JAR".into(),
            safe_join(&request.root, format!("versions/{0}/{0}.jar", request.name))?
                .to_string_lossy()
                .into_owned(),
        ),
        ("INSTALLER".into(), archive.to_string_lossy().into_owned()),
    ]);
    if let Some(entries) = profile["data"].as_object() {
        for (key, entry) in entries {
            if let Some(value) = entry["client"].as_str() {
                if !data.contains_key(key) {
                    data.insert(key.clone(), value.into());
                }
            }
        }
    }
    for _ in 0..12 {
        let old = data.clone();
        for (key, value) in &old {
            if let Ok(value) = expand(value, &old, &request.root, work) {
                data.insert(key.clone(), value);
            }
        }
        if data == old {
            break;
        }
    }
    for (index, processor) in profile["processors"]
        .as_array()
        .context("缺少处理器列表")?
        .iter()
        .enumerate()
    {
        if processor["sides"]
            .as_array()
            .is_some_and(|s| !s.iter().any(|s| s.as_str() == Some("client")))
        {
            continue;
        }
        if job.cancel.is_cancelled() {
            bail!(job.cancellation_message());
        }
        let coordinate = processor["jar"].as_str().context("安装处理器缺少 jar")?;
        let jar = safe_join(
            &request.root,
            format!("libraries/{}", maven_path(coordinate)?),
        )?;
        let mut paths = vec![jar.to_string_lossy().into_owned()];
        let mut seen = HashSet::new();
        for library in processor["classpath"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            let path = safe_join(&request.root, format!("libraries/{}", maven_path(library)?))?
                .to_string_lossy()
                .into_owned();
            if !Path::new(&path).is_file() {
                bail!("安装处理器缺少依赖：{library}");
            }
            if seen.insert(path.clone()) {
                paths.push(path);
            }
        }
        let main = {
            let mut zip = zip::ZipArchive::new(std::fs::File::open(&jar)?)?;
            let mut manifest = String::new();
            zip.by_name("META-INF/MANIFEST.MF")?
                .read_to_string(&mut manifest)?;
            let unfolded = manifest.replace("\r\n ", "").replace("\n ", "");
            unfolded
                .lines()
                .find_map(|line| {
                    line.strip_prefix("Main-Class:")
                        .map(|s| s.trim().to_owned())
                })
                .context("安装处理器没有 Main-Class")?
        };
        let mut args = vec![
            "-cp".into(),
            paths.join(if cfg!(windows) { ";" } else { ":" }),
            main,
        ];
        for arg in processor["args"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            args.push(expand(arg, &data, &request.root, work)?);
        }
        job.log(format!("运行安装处理器 {}：{coordinate}", index + 1));
        run_java(&java.path, &args, &request.root, job.clone(), &[]).await?;
        if let Some(outputs) = processor["outputs"].as_object() {
            for (path, expected) in outputs {
                let path = expand(path, &data, &request.root, work)?;
                let path = Path::new(&path);
                if !path.starts_with(&request.root) {
                    bail!("处理器输出路径越界");
                }
                if !path.exists() {
                    bail!("处理器未生成 {}", path.display());
                }
                if let Some(hash) = expected.as_str() {
                    let hash = expand(hash, &data, &request.root, work)?;
                    if hash.len() == 40 {
                        crate::downloads::verify_file(
                            path,
                            &DownloadSpec {
                                path: String::new(),
                                url: String::new(),
                                size: None,
                                sha1: Some(hash),
                                sha512: None,
                            },
                            &job.cancel,
                        )
                        .await?;
                    }
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn combo_request() -> InstallRequest {
        InstallRequest {
            minecraft: "1.20.1".into(),
            name: "forge-optifine".into(),
            root: PathBuf::from("test-root"),
            loader: Some(LoaderChoice {
                kind: "Forge".into(),
                version: "47.2.18".into(),
                metadata: json!({"mcversion":"1.20.1"}),
            }),
            optifine: Some(LoaderChoice {
                kind: "OptiFine".into(),
                version: "HD_U_I6".into(),
                metadata: json!({"forge":"Forge 47.2.18", "mcversion":"1.20.1"}),
            }),
            fabric_api: None,
        }
    }

    #[test]
    fn mapping_versions_do_not_override_the_catalog_minecraft_target() {
        for kind in ["Fabric", "Quilt"] {
            for mapping in ["0.0.0", "1.20.1"] {
                let choice = catalog_choice(
                    "26.3",
                    kind,
                    json!({
                        "loader": {"version": "0.19.5"},
                        "intermediary": {"version": mapping}
                    }),
                )
                .unwrap();
                assert_eq!(choice.metadata["minecraft"], "26.3");
                assert_eq!(choice.metadata["intermediary"]["version"], mapping);
                // Previously fetched choices lack a game field; their mapping
                // version is not a constraint either. The profile is checked later.
                let mut previous_choice = choice.clone();
                previous_choice
                    .metadata
                    .as_object_mut()
                    .unwrap()
                    .remove("minecraft");
                assert!(validate_minecraft_version(&previous_choice, "26.3").is_ok());
                let mut request = combo_request();
                request.minecraft = "26.3".into();
                request.loader = Some(choice);
                request.optifine = None;
                assert!(validate_selection(&request).is_ok());

                // A choice retained from another game's catalog must still fail.
                request.minecraft = "1.20.1".into();
                let error = validate_selection(&request).unwrap_err().to_string();
                assert!(error.contains("适用于 Minecraft 26.3，不能安装到 1.20.1"));
            }
        }
    }

    #[test]
    fn fabric_catalog_preserves_explicit_minecraft_version_constraints() {
        for field in ["minecraft", "mcversion"] {
            let mut metadata = json!({"loader": {"version": "0.19.5"}});
            metadata[field] = json!("1.20.1");
            let choice = catalog_choice("26.3", "Fabric", metadata).unwrap();
            assert!(validate_minecraft_version(&choice, "26.3").is_err());
        }
    }

    #[test]
    fn fabric_and_quilt_profiles_must_declare_the_requested_game() {
        for kind in ["Fabric", "Quilt"] {
            let choice = LoaderChoice {
                kind: kind.into(),
                version: "0.19.5".into(),
                metadata: json!({"minecraft": "26.3"}),
            };
            assert!(
                validate_loader_profile(&choice, "26.3", &json!({"inheritsFrom": "26.3"})).is_ok()
            );
            let error =
                validate_loader_profile(&choice, "26.3", &json!({"inheritsFrom": "1.20.1"}))
                    .unwrap_err()
                    .to_string();
            assert!(error.contains("适用于 Minecraft 1.20.1，不能安装到 26.3"));
            assert!(validate_loader_profile(&choice, "26.3", &json!({})).is_err());
        }
    }

    #[tokio::test]
    #[ignore = "queries Fabric's official metadata service"]
    async fn live_fabric_catalog_and_profile_accept_modern_and_legacy_minecraft() {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .unwrap();
        for (minecraft, loader) in [("26.3", "0.19.5"), ("1.20.1", "0.16.14")] {
            let choice = catalog(&client, minecraft, "Fabric")
                .await
                .unwrap()
                .into_iter()
                .find(|choice| choice.version == loader)
                .unwrap();
            let mut request = combo_request();
            request.minecraft = minecraft.into();
            request.loader = Some(choice.clone());
            request.optifine = None;
            validate_selection(&request).unwrap();
            let profile = get_json(
                &client,
                &format!(
                    "https://meta.fabricmc.net/v2/versions/loader/{minecraft}/{loader}/profile/json"
                ),
                None,
            )
            .await
            .unwrap();
            validate_loader_profile(&choice, minecraft, &profile).unwrap();
            if minecraft == "26.3" {
                assert_eq!(choice.metadata["intermediary"]["version"], "0.0.0");
            }
            println!("Fabric {loader}: Minecraft {minecraft} catalog and profile accepted");
        }
    }

    #[test]
    fn combo_requires_documented_matching_forge_and_minecraft() {
        let mut request = combo_request();
        assert!(validate_selection(&request).is_ok());
        for incompatible in ["Forge N/A", "", "Forge 47.4.0"] {
            request.optifine.as_mut().unwrap().metadata["forge"] = json!(incompatible);
            assert!(validate_selection(&request).is_err());
        }
        request.optifine.as_mut().unwrap().metadata["forge"] = json!(" forge 47.2.18 ");
        assert!(validate_selection(&request).is_ok());
        request.optifine.as_mut().unwrap().metadata["mcversion"] = json!("1.20.2");
        assert!(validate_selection(&request).is_err());
        let mut request = combo_request();
        request.loader.as_mut().unwrap().kind = "Fabric".into();
        assert!(validate_selection(&request).is_err());
        request.loader = None;
        assert!(validate_selection(&request).is_err());
    }

    #[test]
    fn standalone_optifine_does_not_require_forge() {
        let mut request = combo_request();
        request.loader = request.optifine.take();
        request.loader.as_mut().unwrap().metadata["forge"] = json!("Forge N/A");
        assert!(validate_selection(&request).is_ok());
        request.loader.as_mut().unwrap().metadata["mcversion"] = json!("1.12.2");
        assert!(validate_selection(&request).is_err());
    }

    #[test]
    fn optifine_addon_targets_mods_in_the_selected_game_directory() {
        let directory = tempfile::tempdir().unwrap();
        let mut request = combo_request();
        request.root = directory.path().into();
        let choice = request.optifine.as_ref().unwrap();
        assert_eq!(
            optifine_mod_path(&request, choice, true).unwrap(),
            directory
                .path()
                .join("versions/forge-optifine/mods/OptiFine_1.20.1_HD_U_I6.jar")
        );
        assert_eq!(
            optifine_mod_path(&request, choice, false).unwrap(),
            directory.path().join("mods/OptiFine_1.20.1_HD_U_I6.jar")
        );
        request.optifine.as_mut().unwrap().version = "../escape".into();
        assert!(validate_selection(&request).is_err());
    }

    #[test]
    fn forge_optifine_preserves_runtime_patches_without_expanding_minecraft_classes() {
        use std::io::{Cursor, Write};
        use zip::write::SimpleFileOptions;

        let directory = tempfile::tempdir().unwrap();
        let archive = directory.path().join("OptiFine-installer.jar");
        let patch = "patch/srg/net/minecraft/world/level/chunk/LevelChunkSection.class.xdelta";
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, bytes) in [
            (
                "META-INF/services/cpw.mods.modlauncher.api.ITransformationService",
                &b"optifine.OptiFineTransformationService"[..],
            ),
            (patch, &b"runtime patch fixture"[..]),
        ] {
            zip.start_file(name, SimpleFileOptions::default()).unwrap();
            zip.write_all(bytes).unwrap();
        }
        let original = zip.finish().unwrap().into_inner();
        std::fs::write(&archive, &original).unwrap();
        let mut request = combo_request();
        request.root = directory.path().join("game");
        let choice = request.optifine.as_ref().unwrap();
        // This must work without a Java executable or a vanilla client to patch.
        for isolation in [true, false] {
            let output = optifine_mod_path(&request, choice, isolation).unwrap();
            std::fs::create_dir_all(output.parent().unwrap()).unwrap();
            std::fs::write(&output, b"previous patched mod").unwrap();
            let other = output.with_file_name("other-mod.jar");
            std::fs::write(&other, b"keep other mods").unwrap();

            write_optifine_mod(&request, choice, isolation, &archive).unwrap();
            assert_eq!(std::fs::read(&output).unwrap(), original);
            let mut installed =
                zip::ZipArchive::new(std::fs::File::open(&output).unwrap()).unwrap();
            assert!(installed.by_name(patch).is_ok());
            assert!(installed
                .by_name("srg/net/minecraft/world/level/chunk/LevelChunkSection.class")
                .is_err());
            assert_eq!(std::fs::read(other).unwrap(), b"keep other mods");

            assert!(write_optifine_mod(
                &request,
                choice,
                isolation,
                &directory.path().join("missing.jar")
            )
            .is_err());
            assert_eq!(std::fs::read(output).unwrap(), original);
        }
        assert_eq!(std::fs::read(archive).unwrap(), original);
    }

    #[test]
    fn fabric_api_cannot_be_installed_without_fabric() {
        let mut request = combo_request();
        request.optifine = None;
        request.fabric_api = Some(DownloadSpec {
            path: "fabric-api.jar".into(),
            url: "https://example.com/fabric-api.jar".into(),
            size: None,
            sha1: None,
            sha512: None,
        });
        assert!(validate_selection(&request).is_err());
        request.loader.as_mut().unwrap().kind = "Fabric".into();
        assert!(validate_selection(&request).is_ok());
    }
    #[test]
    fn processor_dependencies_preserve_each_required_version() {
        let profile = json!({"libraries": [
            {"name": "net.minecraftforge:srgutils:0.4.3"},
            {"name": "net.minecraftforge:srgutils:0.4.9"},
            {"name": "net.minecraftforge:srgutils:0.5.6"},
            {"name": "net.minecraftforge:srgutils:0.4.3"}
        ]});
        let files = processor_libraries(&profile).unwrap();
        assert_eq!(files.len(), 3);
        for version in ["0.4.3", "0.4.9", "0.5.6"] {
            assert!(files
                .iter()
                .any(|lib| lib.file.path.ends_with(&format!("srgutils-{version}.jar"))));
        }
        assert_eq!(versions::libraries(&profile).unwrap().len(), 1);
    }
    #[test]
    fn liteloader_uses_mirrored_artifact_and_retains_legacy_arguments() {
        let base = json!({"minecraftArguments": "--username ${auth_player_name}"});
        let choice = LoaderChoice {
            kind: "LiteLoader".into(),
            version: "1.12.2-SNAPSHOT".into(),
            metadata: json!({"build": {"libraries": [{"name": "net.minecraft:launchwrapper:1.12"}, {"name": "org.ow2.asm:asm-all:5.2"}]}}),
        };
        let profile = liteloader_profile(&base, &choice).unwrap();
        assert!(profile["minecraftArguments"]
            .as_str()
            .unwrap()
            .starts_with("--username ${auth_player_name} --tweakClass "));
        let libs = versions::libraries(&profile).unwrap();
        assert_eq!(libs.len(), 3);
        assert_eq!(libs[2].file.url, format!("{BMCL}/maven/com/mumfrey/liteloader/1.12.2-SNAPSHOT/liteloader-1.12.2-SNAPSHOT.jar"));
    }
    #[test]
    fn processor_placeholders_expand_maven_and_embedded_data() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let work = root.join("work");
        let data = HashMap::from([
            (
                "INPUT".into(),
                "[net.minecraft:client:1.20.1:mappings@txt]".into(),
            ),
            ("PATCH".into(), "/data/client.lzma".into()),
        ]);
        assert!(expand("{INPUT}", &data, root, &work)
            .unwrap()
            .ends_with("client-1.20.1-mappings.txt"));
        assert_eq!(
            PathBuf::from(expand("{PATCH}", &data, root, &work).unwrap()),
            work.join("data/client.lzma")
        );
        assert!(expand("{MISSING}", &data, root, &work).is_err());
        assert!(expand("/data/../../escape", &data, root, &work).is_err());
    }
    #[test]
    fn loader_download_urls_reject_invalid_version_and_follow_original_endpoints() {
        let forge = LoaderChoice {
            kind: "Forge".into(),
            version: "47.4.0".into(),
            metadata: json!({"build":123}),
        };
        assert_eq!(
            installer_url("1.20.1", &forge).unwrap(),
            format!("{BMCL}/forge/download/123")
        );
        let invalid = LoaderChoice {
            version: "../invalid".into(),
            ..forge
        };
        assert!(installer_url("1.20.1", &invalid).is_err());
        let opt = LoaderChoice {
            kind: "OptiFine".into(),
            version: "HD_U_I6".into(),
            metadata: json!({"type":"HD_U","patch":"I6"}),
        };
        assert_eq!(
            installer_url("1.20.1", &opt).unwrap(),
            format!("{BMCL}/optifine/1.20.1/HD_U/I6")
        );
    }
}

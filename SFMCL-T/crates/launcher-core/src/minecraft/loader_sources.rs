use super::loaders::LoaderChoice;
use crate::{
    download_sources::{SourceSelector, MC_MIRROR, NEOFORGE_CDN},
    paths::valid_name,
};
use anyhow::{bail, Context, Result};
use regex::Regex;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

pub fn catalog_urls(minecraft: &str, kind: &str, current: String) -> Vec<String> {
    let mut urls = match kind {
        "Forge" => vec![
            "https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml".into(),
        ],
        "NeoForge" => {
            let artifact = if minecraft == "1.20.1" {
                "forge"
            } else {
                "neoforge"
            };
            vec![format!("https://maven.neoforged.net/releases/net/neoforged/{artifact}/maven-metadata.xml"),
                format!("{NEOFORGE_CDN}/releases/net/neoforged/{artifact}/maven-metadata.xml")]
        }
        "Fabric" => crate::download_sources::candidates(&current),
        "OptiFine" => vec!["https://optifine.net/downloads".into()],
        _ => vec![],
    };
    if !urls.contains(&current) {
        urls.push(current);
    }
    if matches!(kind, "Fabric" | "Quilt") {
        urls.push(mirror_profile_url(minecraft, kind));
    }
    urls
}

fn mirror_profile_url(minecraft: &str, kind: &str) -> String {
    let mut url = reqwest::Url::parse(MC_MIRROR).unwrap();
    url.path_segments_mut().unwrap().extend([
        kind.to_ascii_lowercase().as_str(),
        "profiles",
        &format!("{minecraft}.json"),
    ]);
    url.into()
}

pub fn profile_urls(minecraft: &str, kind: &str, current: &str) -> Vec<String> {
    let mut urls = crate::download_sources::candidates(current);
    urls.push(mirror_profile_url(minecraft, kind));
    urls
}

/// MC Mirror bundles all loaders for one Minecraft version in a keyed object.
/// Keep the official profile shape downstream and reject absent/wrong loaders.
pub fn profile_data(bytes: &[u8], minecraft: &str, choice: &LoaderChoice) -> Result<Value> {
    let mut value: Value = serde_json::from_slice(bytes)?;
    if value["mainClass"].is_null() {
        value = value
            .as_object_mut()
            .context("加载器镜像配置格式错误")?
            .remove(&choice.version)
            .context("镜像未收录此加载器版本")?;
        validate_mirror_profile(&value, minecraft, &choice.kind, &choice.version)?;
    }
    if !value["mainClass"].is_string() || !value["libraries"].is_array() {
        bail!("加载器安装配置格式错误");
    }
    Ok(value)
}

fn validate_mirror_profile(
    profile: &Value,
    minecraft: &str,
    kind: &str,
    loader: &str,
) -> Result<()> {
    let id = format!("{}-loader-{loader}-{minecraft}", kind.to_ascii_lowercase());
    if profile["inheritsFrom"].as_str() != Some(minecraft)
        || profile["id"].as_str() != Some(&id)
        || !profile["mainClass"].is_string()
        || !profile["libraries"].is_array()
    {
        bail!("加载器镜像配置与所选版本不匹配");
    }
    Ok(())
}

fn mirror_catalog(value: Value, minecraft: &str, kind: &str) -> Result<Value> {
    let profiles = value.as_object().context("加载器镜像清单格式错误")?;
    let mut versions = Vec::new();
    for (loader, profile) in profiles {
        valid_name(loader)?;
        validate_mirror_profile(profile, minecraft, kind, loader)?;
        versions.push(loader);
    }
    if versions.is_empty() {
        bail!("镜像未收录此 Minecraft 的加载器");
    }
    // JSON object key order is lexical; compare numeric versions so 0.16.10
    // precedes 0.16.9 and stable releases precede their prereleases.
    let key = |version: &str| {
        let numbers = |text: &str| {
            text.split(|c: char| !c.is_ascii_digit())
                .filter_map(|part| part.parse::<u64>().ok())
                .collect::<Vec<_>>()
        };
        let (core, suffix) = version.split_once('-').unwrap_or((version, ""));
        (
            numbers(core),
            suffix.is_empty(),
            numbers(suffix),
            version.to_owned(),
        )
    };
    versions.sort_by_cached_key(|version| std::cmp::Reverse(key(version)));
    Ok(json!(versions
        .into_iter()
        .map(|version| json!({
            "loader": {"version": version, "stable": !version.contains('-')},
            "minecraft": minecraft,
        }))
        .collect::<Vec<_>>()))
}

pub fn catalog_data(bytes: &[u8], minecraft: &str, kind: &str) -> Result<Value> {
    // BMCLAPI returns an empty successful response when LiteLoader has no
    // release for this Minecraft version, rather than a JSON null or list.
    if kind == "LiteLoader" && bytes.iter().all(u8::is_ascii_whitespace) {
        return Ok(Value::Null);
    }
    let text = String::from_utf8_lossy(bytes);
    if !text.trim_start().starts_with('<') {
        let value: Value = serde_json::from_slice(bytes)?;
        if matches!(kind, "Fabric" | "Quilt") && value.is_object() {
            return mirror_catalog(value, minecraft, kind);
        }
        if kind != "LiteLoader" && !value.is_array() {
            bail!("加载器清单格式错误");
        }
        return Ok(value);
    }
    if kind == "OptiFine" {
        return optifine_catalog(&text, minecraft);
    }
    if !["Forge", "NeoForge"].contains(&kind) || !text.contains("<metadata") {
        bail!("加载器清单格式错误");
    }
    let versions = Regex::new(r"<version>([^<]+)</version>")?;
    let mut items = vec![];
    let neo_prefix = if let Some(version) = minecraft.strip_prefix("1.") {
        let (major, minor) = version.split_once('.').unwrap_or((version, "0"));
        format!("{major}.{minor}.")
    } else {
        format!("{minecraft}.")
    };
    for version in versions
        .captures_iter(&text)
        .map(|value| value[1].to_owned())
    {
        if valid_name(&version).is_err() {
            continue;
        }
        let (display, artifact) = if kind == "Forge" || minecraft == "1.20.1" {
            let Some(display) = version.strip_prefix(&format!("{minecraft}-")) else {
                continue;
            };
            (
                display
                    .trim_end_matches(&format!("-{minecraft}"))
                    .to_string(),
                "forge",
            )
        } else {
            if !version.starts_with(&neo_prefix) {
                continue;
            }
            (version.clone(), "neoforge")
        };
        items.push(json!({"version":display,"minecraft":minecraft,"mcversion":minecraft,"mavenVersion":version,"mavenArtifact":artifact}));
    }
    Ok(json!(items))
}

fn optifine_catalog(text: &str, minecraft: &str) -> Result<Value> {
    let rows = Regex::new(r"(?is)<tr\b[^>]*>(.*?)</tr>")?;
    let names = Regex::new(&format!(
        r"f=((?:preview_)?OptiFine_{}_([A-Za-z0-9_]+)\.jar)",
        regex::escape(minecraft)
    ))?;
    let forge_column = Regex::new(r#"(?is)<td[^>]*class=['"]colForge['"][^>]*>(.*?)</td>"#)?;
    let tags = Regex::new(r"<[^>]+>")?;
    let forge_version = Regex::new(r"\b\d+(?:\.\d+){2,}\b")?;
    let mut seen = std::collections::HashSet::new();
    let mut items = vec![];
    for row in rows.captures_iter(text) {
        let Some(name) = names.captures(&row[1]) else {
            continue;
        };
        if !seen.insert(name[1].to_owned()) {
            continue;
        }
        let tail = &name[2];
        let (kind, patch) = if let Some(patch) = tail.strip_prefix("HD_U_") {
            ("HD_U", patch)
        } else if let Some(patch) = tail.strip_prefix("HD_") {
            ("HD", patch)
        } else {
            tail.split_once('_').context("OptiFine 文件名格式错误")?
        };
        let forge = forge_column.captures(&row[1]).and_then(|column| {
            let plain = tags.replace_all(&column[1], " ");
            forge_version
                .find(&plain)
                .map(|value| value.as_str().to_owned())
        });
        items.push(json!({"type":kind,"patch":patch,"mcversion":minecraft,"forge":forge,"fileName":&name[1]}));
    }
    if items.is_empty() && !text.contains("OptiFine") {
        bail!("OptiFine 官方页面格式错误");
    }
    items.reverse();
    Ok(json!(items))
}

pub fn official_installer(minecraft: &str, choice: &LoaderChoice) -> Result<String> {
    valid_name(minecraft)?;
    valid_name(&choice.version)?;
    match choice.kind.as_str() {
        "Forge" => {
            let coordinate = if let Some(version) = choice.metadata["mavenVersion"].as_str() {
                version.to_owned()
            } else {
                let branch = choice.metadata["branch"]
                    .as_str()
                    .filter(|value| !value.is_empty());
                format!(
                    "{minecraft}-{}{}",
                    choice.version,
                    branch.map(|value| format!("-{value}")).unwrap_or_default()
                )
            };
            valid_name(&coordinate)?;
            Ok(format!("https://maven.minecraftforge.net/net/minecraftforge/forge/{coordinate}/forge-{coordinate}-installer.jar"))
        }
        "NeoForge" => {
            if let Some(path) = choice.metadata["installerPath"]
                .as_str()
                .and_then(|path| path.strip_prefix("/maven/"))
            {
                if !path.starts_with("net/neoforged/")
                    || path.contains("..")
                    || !path.ends_with("-installer.jar")
                    || !path
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || b"/._-".contains(&byte))
                {
                    bail!("NeoForge 安装器路径无效");
                }
                return Ok(format!("https://maven.neoforged.net/releases/{path}"));
            }
            let artifact =
                choice.metadata["mavenArtifact"]
                    .as_str()
                    .unwrap_or(if minecraft == "1.20.1" {
                        "forge"
                    } else {
                        "neoforge"
                    });
            if !["forge", "neoforge"].contains(&artifact) {
                bail!("NeoForge 构件无效");
            }
            let coordinate = choice.metadata["mavenVersion"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| {
                    if artifact == "forge" {
                        format!("{minecraft}-{}", choice.version)
                    } else {
                        choice.version.clone()
                    }
                });
            valid_name(&coordinate)?;
            Ok(format!("https://maven.neoforged.net/releases/net/neoforged/{artifact}/{coordinate}/{artifact}-{coordinate}-installer.jar"))
        }
        _ => bail!("此加载器没有 Maven 安装器"),
    }
}

pub async fn optifine_installer(
    client: &reqwest::Client,
    choice: &LoaderChoice,
    minecraft: &str,
    cancel: &CancellationToken,
) -> Result<String> {
    let kind = choice.metadata["type"]
        .as_str()
        .context("OptiFine 类型缺失")?;
    let patch = choice.metadata["patch"]
        .as_str()
        .context("OptiFine 补丁缺失")?;
    valid_name(kind)?;
    valid_name(patch)?;
    valid_name(minecraft)?;
    let expected = format!("OptiFine_{minecraft}_{kind}_{patch}.jar");
    let filename = choice.metadata["fileName"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| {
            if patch.contains("pre") {
                format!("preview_{expected}")
            } else {
                expected.clone()
            }
        });
    if filename != expected && filename != format!("preview_{expected}") {
        bail!("OptiFine 文件名与所选版本不一致");
    }
    let page = format!("https://optifine.net/adloadx?f={filename}");
    let sources = SourceSelector::default();
    sources
        .fetch(client, &[page], cancel, |bytes| {
            let text = String::from_utf8_lossy(bytes);
            let links = Regex::new(r#"href\s*=\s*['"]([^'"]*downloadx\?[^'"]+)['"]"#)?;
            for link in links.captures_iter(&text) {
                let url = reqwest::Url::parse("https://optifine.net/")?
                    .join(&link[1].replace("&amp;", "&"))?;
                if url.scheme() == "https"
                    && url.host_str() == Some("optifine.net")
                    && url.path() == "/downloadx"
                    && url
                        .query_pairs()
                        .any(|(key, value)| key == "f" && value == filename)
                {
                    return Ok(url.to_string());
                }
            }
            bail!("OptiFine 官方页面没有有效下载地址")
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn liteloader_catalog_accepts_no_release_without_masking_invalid_data() {
        for bytes in [b"".as_slice(), b" \r\n\t", b"null"] {
            assert!(catalog_data(bytes, "26.3", "LiteLoader").unwrap().is_null());
        }
        let release = br#"{"mcversion":"1.12.2","version":"1.12.2-SNAPSHOT"}"#;
        assert_eq!(
            catalog_data(release, "1.12.2", "LiteLoader").unwrap()["version"],
            "1.12.2-SNAPSHOT"
        );
        for bytes in [b"{".as_slice(), b"upstream unavailable"] {
            assert!(catalog_data(bytes, "1.12.2", "LiteLoader").is_err());
        }
        for kind in ["Forge", "NeoForge", "Fabric", "Quilt", "OptiFine"] {
            assert!(catalog_data(b"", "26.3", kind).is_err());
        }
    }

    fn mirror_bundle(kind: &str) -> Value {
        let mut bundle = serde_json::Map::new();
        for loader in ["0.16.9", "0.16.10-beta.2", "0.16.10"] {
            bundle.insert(
                loader.into(),
                json!({
                    "id": format!("{}-loader-{loader}-1.20.1", kind.to_ascii_lowercase()),
                    "inheritsFrom": "1.20.1", "mainClass": "example.KnotClient",
                    "libraries": [{"name": format!("example:loader:{loader}")}],
                }),
            );
        }
        Value::Object(bundle)
    }

    #[test]
    fn mirror_catalogs_and_profiles_select_exact_versions_and_sort_numerically() {
        for kind in ["Fabric", "Quilt"] {
            let bundle = mirror_bundle(kind);
            let bytes = serde_json::to_vec(&bundle).unwrap();
            let catalog = catalog_data(&bytes, "1.20.1", kind).unwrap();
            let versions: Vec<_> = catalog
                .as_array()
                .unwrap()
                .iter()
                .map(|item| item["loader"]["version"].as_str().unwrap())
                .collect();
            assert_eq!(versions, ["0.16.10", "0.16.10-beta.2", "0.16.9"]);
            assert_eq!(catalog[0]["loader"]["stable"], true);
            assert_eq!(catalog[1]["loader"]["stable"], false);
            let choice = LoaderChoice {
                kind: kind.into(),
                version: "0.16.9".into(),
                metadata: Value::Null,
            };
            assert_eq!(
                profile_data(&bytes, "1.20.1", &choice).unwrap(),
                bundle["0.16.9"]
            );
            assert!(profile_data(&bytes, "1.21.4", &choice).is_err());
            let absent = LoaderChoice {
                version: "0.99.0".into(),
                ..choice
            };
            assert!(profile_data(&bytes, "1.20.1", &absent).is_err());
            assert!(catalog_data(&bytes, "1.21.4", kind).is_err());
            assert!(catalog_data(b"{}", "1.20.1", kind).is_err());
        }
    }

    #[tokio::test]
    async fn invalid_mirror_profile_falls_back_before_installing_libraries() {
        let choice = LoaderChoice {
            kind: "Fabric".into(),
            version: "0.16.9".into(),
            metadata: Value::Null,
        };
        let correct = mirror_bundle("Fabric");
        let mut wrong = correct.clone();
        wrong["0.16.9"]["inheritsFrom"] = json!("1.21.4");
        let app = axum::Router::new()
            .route(
                "/wrong",
                axum::routing::get(move || {
                    let value = wrong.clone();
                    async move { axum::Json(value) }
                }),
            )
            .route(
                "/correct",
                axum::routing::get(move || {
                    let value = correct.clone();
                    async move { axum::Json(value) }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let root = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let sources = SourceSelector::default();
        sources.set_mode(super::super::download_source::MinecraftDownloadSource::Official);
        let profile = sources
            .fetch(
                &reqwest::Client::new(),
                &[format!("{root}/wrong"), format!("{root}/correct")],
                &CancellationToken::new(),
                |bytes| profile_data(bytes, "1.20.1", &choice),
            )
            .await
            .unwrap();
        assert_eq!(profile["inheritsFrom"], "1.20.1");
        assert_eq!(profile["libraries"][0]["name"], "example:loader:0.16.9");
        server.abort();
    }

    #[test]
    fn loader_library_hashes_in_mirror_profiles_are_preserved() {
        let libraries = super::super::versions::libraries(&json!({"libraries": [{
            "name": "example:loader:1", "url": "https://maven.fabricmc.net/",
            "sha1": "0123456789012345678901234567890123456789", "sha512": "expected-sha512", "size": 123,
        }]})).unwrap();
        assert_eq!(
            libraries[0].file.sha1.as_deref(),
            Some("0123456789012345678901234567890123456789")
        );
        assert_eq!(libraries[0].file.sha512.as_deref(), Some("expected-sha512"));
        assert_eq!(libraries[0].file.size, Some(123));
    }

    #[tokio::test]
    #[ignore = "downloads public MC Mirror profiles and hashed loader dependencies"]
    async fn live_mc_mirror_loader_profiles_and_dependencies() {
        use crate::downloads::{DownloadManager, Status};
        let temp = tempfile::tempdir().unwrap();
        let manager = DownloadManager::open(&temp.path().join("downloads"), 3).unwrap();
        let sources = manager.sources();
        sources.set_mode(super::super::download_source::MinecraftDownloadSource::Official);
        let client = crate::http_client().unwrap();
        let cancel = CancellationToken::new();
        let mut files = Vec::new();
        for (kind, loader) in [("Fabric", "0.16.14"), ("Quilt", "0.26.4")] {
            let choice = LoaderChoice {
                kind: kind.into(),
                version: loader.into(),
                metadata: Value::Null,
            };
            let (catalog, profile) = sources
                .fetch(
                    &client,
                    &[mirror_profile_url("1.20.1", kind)],
                    &cancel,
                    |bytes| {
                        Ok((
                            catalog_data(bytes, "1.20.1", kind)?,
                            profile_data(bytes, "1.20.1", &choice)?,
                        ))
                    },
                )
                .await
                .unwrap();
            assert!(catalog
                .as_array()
                .unwrap()
                .iter()
                .any(|item| item["loader"]["version"] == loader));
            println!(
                "{kind}: {} mirrored profiles, selected {loader}",
                catalog.as_array().unwrap().len()
            );
            let libraries = super::super::versions::libraries(&profile).unwrap();
            for mut file in libraries
                .into_iter()
                .map(|library| library.file)
                .filter(|file| {
                    file.path.contains("/fabric-loader/")
                        || file.path.contains("/quilt-loader/")
                        || file.path.contains("/asm/asm/")
                        || file.path.contains("/sponge-mixin/")
                })
            {
                if file.sha1.is_none() {
                    file.sha1 = Some(
                        sources
                            .fetch(
                                &client,
                                &sources.candidates(&format!("{}.sha1", file.url)),
                                &cancel,
                                |bytes| {
                                    let hash = std::str::from_utf8(bytes)?
                                        .split_whitespace()
                                        .next()
                                        .context("missing hash")?;
                                    anyhow::ensure!(
                                        hash.len() == 40
                                            && hash.bytes().all(|c| c.is_ascii_hexdigit()),
                                        "invalid hash"
                                    );
                                    Ok(hash.to_owned())
                                },
                            )
                            .await
                            .unwrap(),
                    );
                }
                let repository = if kind == "Fabric" {
                    "/fabric/maven/"
                } else {
                    "/quilt/maven/"
                };
                let mirror = crate::download_sources::candidates(&file.url)
                    .into_iter()
                    .find(|url| url.starts_with(&format!("{MC_MIRROR}{repository}")))
                    .unwrap();
                sources.register(&mirror, vec![mirror.clone()]);
                file.url = mirror;
                file.path = format!("{kind}/{}", file.path);
                files.push(file);
            }
        }
        assert_eq!(files.len(), 6);
        let id = manager
            .enqueue(
                "MC Mirror loader smoke".into(),
                temp.path().join("game"),
                files,
            )
            .await
            .unwrap();
        let snapshot = manager.wait(&id, &cancel).await.unwrap();
        assert_eq!(snapshot.status, Status::Completed, "{:?}", snapshot.files);
        println!(
            "Fabric and Quilt loader JARs and shared dependencies passed official SHA-1 checks"
        );
    }

    #[test]
    fn forge_xml_filters_game_versions_and_preserves_legacy_branches() {
        let xml = b"<metadata><version>1.7.10-10.13.4.1614-1.7.10</version><version>1.20.1-47.0.1</version></metadata>";
        let value = catalog_data(xml, "1.7.10", "Forge").unwrap();
        assert_eq!(value.as_array().unwrap().len(), 1);
        assert_eq!(value[0]["version"], "10.13.4.1614");
        let choice = LoaderChoice {
            kind: "Forge".into(),
            version: "10.13.4.1614".into(),
            metadata: value[0].clone(),
        };
        assert_eq!(official_installer("1.7.10", &choice).unwrap(), "https://maven.minecraftforge.net/net/minecraftforge/forge/1.7.10-10.13.4.1614-1.7.10/forge-1.7.10-10.13.4.1614-1.7.10-installer.jar");
    }

    #[test]
    fn neo_metadata_selects_exact_game_and_supports_legacy_package() {
        let xml = b"<metadata><version>21.0.1</version><version>21.1.1</version><version>21.1.2-beta</version><version>21.2.1</version></metadata>";
        let value = catalog_data(xml, "1.21.1", "NeoForge").unwrap();
        assert_eq!(value.as_array().unwrap().len(), 2);
        assert_eq!(
            catalog_data(xml, "1.21", "NeoForge")
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            1
        );
        let legacy = catalog_data(
            b"<metadata><version>1.20.1-47.1.106</version></metadata>",
            "1.20.1",
            "NeoForge",
        )
        .unwrap();
        let choice = LoaderChoice {
            kind: "NeoForge".into(),
            version: "47.1.106".into(),
            metadata: legacy[0].clone(),
        };
        assert_eq!(official_installer("1.20.1", &choice).unwrap(), "https://maven.neoforged.net/releases/net/neoforged/forge/1.20.1-47.1.106/forge-1.20.1-47.1.106-installer.jar");
    }

    #[test]
    fn optifine_page_preserves_preview_patch_and_forge_compatibility() {
        let page = br#"<html>OptiFine<table><tr><td><a href='adloadx?f=preview_OptiFine_1.20.1_HD_U_I6_pre5.jar'>Mirror</a></td><td class='colForge'>Forge 47.0.35</td></tr><tr><td><a href='adloadx?f=OptiFine_1.20.1_HD_U_I6.jar'>Mirror</a></td><td class='colForge'>Forge 47.0.0</td></tr><tr><td><a href='adloadx?f=OptiFine_1.21.4_HD_U_J6.jar'>Mirror</a></td></tr></table></html>"#;
        let value = catalog_data(page, "1.20.1", "OptiFine").unwrap();
        assert_eq!(value.as_array().unwrap().len(), 2);
        assert_eq!(value[1]["type"], "HD_U");
        assert_eq!(value[1]["patch"], "I6_pre5");
        assert_eq!(value[1]["forge"], "47.0.35");
        assert!(catalog_data(b"<html>error</html>", "1.20.1", "OptiFine").is_err());
        assert!(catalog_data(br#"{"error":"upstream unavailable"}"#, "1.20.1", "Forge").is_err());
    }

    #[test]
    fn neo_installer_path_is_confined_to_its_maven_repository() {
        for path in [
            "/maven/../installer.jar",
            "/maven/net/neoforged/a-installer.jar?url=x",
            "/maven/net/neoforged/a-installer.jar#x",
        ] {
            let choice = LoaderChoice {
                kind: "NeoForge".into(),
                version: "21.1.1".into(),
                metadata: json!({"installerPath":path}),
            };
            assert!(official_installer("1.21.1", &choice).is_err());
        }
    }
}

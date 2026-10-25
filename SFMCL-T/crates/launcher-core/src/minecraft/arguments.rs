use super::versions::{self, rules_allow};
use crate::{config::Settings, paths::safe_join};
use anyhow::{bail, Context, Result};
use serde_json::Value;
use std::{collections::HashMap, path::Path};

pub struct Identity<'a> {
    pub name: &'a str,
    pub uuid: &'a str,
    pub access_token: &'a str,
    pub online: bool,
}

/// Tokenize arguments without invoking a shell. Backslashes in Windows paths
/// remain literal; single/double quotes only group whitespace.
pub fn split_args(text: &str) -> Result<Vec<String>> {
    let mut result = Vec::new();
    let mut current = String::new();
    let mut quote = None;
    let mut started = false;
    for ch in text.chars() {
        if (ch == '"' || ch == '\'') && (quote.is_none() || quote == Some(ch)) {
            quote = if quote.is_some() { None } else { Some(ch) };
            started = true;
        } else if ch.is_whitespace() && quote.is_none() {
            if started {
                result.push(std::mem::take(&mut current));
                started = false;
            }
        } else {
            current.push(ch);
            started = true;
        }
    }
    if quote.is_some() {
        bail!("启动参数包含未闭合的引号");
    }
    if started {
        result.push(current);
    }
    Ok(result)
}
fn collect(values: &Value, features: &HashMap<String, bool>) -> Vec<String> {
    let mut result = vec![];
    for arg in values.as_array().into_iter().flatten() {
        if let Some(s) = arg.as_str() {
            result.push(s.to_owned());
        } else if rules_allow(&arg["rules"], features) {
            if let Some(s) = arg["value"].as_str() {
                result.push(s.to_owned());
            } else {
                result.extend(
                    arg["value"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                        .map(str::to_owned),
                );
            }
        }
    }
    result
}
pub fn build(
    root: &Path,
    id: &str,
    version: &Value,
    settings: &Settings,
    player: &Identity<'_>,
    memory_mb: u64,
) -> Result<Vec<String>> {
    let libs = versions::libraries(version)?;
    let mut classpath = Vec::new();
    for lib in libs.iter().filter(|l| !l.native) {
        let path = safe_join(root, &lib.file.path)?;
        if !path.exists() {
            bail!("缺少依赖库：{}", lib.file.path);
        }
        classpath.push(path.to_string_lossy().into_owned());
    }
    let jar_id = version["jar"].as_str().unwrap_or(id);
    let jar = safe_join(root, format!("versions/{jar_id}/{jar_id}.jar"))?;
    if !jar.exists() {
        bail!("缺少 Minecraft 客户端，请先补全资源");
    }
    classpath.push(jar.to_string_lossy().into_owned());
    let game_dir = versions::game_directory(root, id, settings.isolation)?;
    let asset_id = version["assetIndex"]["id"]
        .as_str()
        .or(version["assets"].as_str())
        .unwrap_or("legacy");
    let assets = root.join("assets");
    let natives = safe_join(root, format!("versions/{id}/natives"))?;
    let mut substitutions = HashMap::from([
        ("auth_player_name", player.name.to_owned()),
        ("auth_uuid", player.uuid.to_owned()),
        (
            "auth_access_token",
            if player.online {
                player.access_token.into()
            } else {
                "0".into()
            },
        ),
        (
            "auth_session",
            if player.online {
                format!("token:{}:{}", player.access_token, player.uuid)
            } else {
                "0".into()
            },
        ),
        (
            "user_type",
            if player.online {
                "msa".into()
            } else {
                "legacy".into()
            },
        ),
        ("user_properties", "{}".into()),
        ("clientid", settings.microsoft_client_id.clone()),
        ("auth_xuid", String::new()),
        ("version_name", id.to_owned()),
        ("version_type", settings.custom_info.clone()),
        ("game_directory", game_dir.to_string_lossy().into_owned()),
        ("assets_root", assets.to_string_lossy().into_owned()),
        ("assets_index_name", asset_id.to_owned()),
        (
            "game_assets",
            assets
                .join("virtual")
                .join(asset_id)
                .to_string_lossy()
                .into_owned(),
        ),
        ("natives_directory", natives.to_string_lossy().into_owned()),
        (
            "library_directory",
            root.join("libraries").to_string_lossy().into_owned(),
        ),
        ("launcher_name", "SFMCL-T".into()),
        ("launcher_version", env!("CARGO_PKG_VERSION").into()),
        (
            "classpath_separator",
            if cfg!(windows) {
                ";".into()
            } else {
                ":".into()
            },
        ),
        ("primary_jar_name", format!("{jar_id}.jar")),
        ("resolution_width", settings.width.to_string()),
        ("resolution_height", settings.height.to_string()),
    ]);
    substitutions.insert(
        "classpath",
        classpath.join(if cfg!(windows) { ";" } else { ":" }),
    );
    let features = HashMap::from([
        ("has_custom_resolution".into(), true),
        ("is_demo_user".into(), false),
        ("has_quick_plays_support".into(), false),
    ]);
    let mut args = if version["arguments"]["jvm"].is_array() {
        collect(&version["arguments"]["jvm"], &features)
    } else {
        vec![
            "-Djava.library.path=${natives_directory}".into(),
            "-Dminecraft.launcher.brand=${launcher_name}".into(),
            "-Dminecraft.launcher.version=${launcher_version}".into(),
            "-cp".into(),
            "${classpath}".into(),
        ]
    };
    args.extend([
        format!("-Xms{}m", memory_mb.min(512)),
        format!("-Xmx{memory_mb}m"),
        "-Dlog4j2.formatMsgNoLookups=true".into(),
        "-Djava.rmi.server.useCodebaseOnly=true".into(),
        "-Dcom.sun.jndi.rmi.object.trustURLCodebase=false".into(),
    ]);
    if let Some(argument) = version["logging"]["client"]["argument"].as_str() {
        if let Some(file_id) = version["logging"]["client"]["file"]["id"].as_str() {
            let logging = safe_join(root, format!("assets/log_configs/{file_id}"))?;
            if logging.exists() {
                args.push(argument.replace("${path}", &logging.to_string_lossy()));
            }
        }
    }
    if settings.jvm_args_enabled {
        args.extend(split_args(&settings.jvm_args)?);
    }
    args.push(
        version["mainClass"]
            .as_str()
            .context("版本缺少 mainClass")?
            .into(),
    );
    let game = if let Some(legacy) = version["minecraftArguments"].as_str() {
        split_args(legacy)?
    } else {
        collect(&version["arguments"]["game"], &features)
    };
    args.extend(game);
    if !args.iter().any(|a| a == "--width") {
        args.extend([
            "--width".into(),
            settings.width.to_string(),
            "--height".into(),
            settings.height.to_string(),
        ]);
    }
    if settings.fullscreen {
        args.push("--fullscreen".into());
    }
    args.extend(split_args(&settings.game_args)?);
    for arg in &mut args {
        for (key, value) in &substitutions {
            *arg = arg.replace(&format!("${{{key}}}"), value);
        }
    }
    if let Some(arg) = args.iter().find(|a| a.contains("${")) {
        bail!("无法解析启动参数占位符：{arg}");
    }
    Ok(args)
}

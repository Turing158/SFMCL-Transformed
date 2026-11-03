use crate::{
    config::Settings,
    paths::{safe_join, valid_name},
};
use anyhow::{bail, Result};
use serde::Serialize;
use serde_json::Value;
use std::{io::Read, path::Path};

pub fn validate_host(host: &str) -> Result<()> {
    let host = host.trim();
    let valid = if host.starts_with('[') && host.ends_with(']') {
        host[1..host.len() - 1]
            .parse::<std::net::Ipv6Addr>()
            .is_ok()
    } else {
        !host.is_empty()
            && host.len() <= 253
            && host
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')
    };
    if !valid {
        bail!("服务器地址格式无效，请填写域名或 IP；端口单独填写，IPv6 请用方括号包围");
    }
    Ok(())
}

pub fn supports(version: &Value) -> bool {
    version["arguments"]["game"].as_array().is_some_and(|args| {
        args.iter()
            .any(|arg| arg.to_string().contains("quickPlaySingleplayer"))
    })
}

pub fn arguments(version: &Value, settings: &Settings, directory: &Path) -> Result<Vec<String>> {
    if settings.server_enabled && settings.quick_play_enabled {
        bail!("服务器直连和快速进入存档不能同时开启");
    }
    let mut args = Vec::new();
    if settings.server_enabled {
        validate_host(&settings.server_host)?;
        if settings.server_port == 0 {
            bail!("服务器端口无效");
        }
        let host = settings.server_host.trim();
        if supports(version) {
            args.extend([
                "--quickPlayMultiplayer".into(),
                format!("{host}:{}", settings.server_port),
            ]);
        } else {
            args.extend([
                "--server".into(),
                host.trim_matches(['[', ']']).into(),
                "--port".into(),
                settings.server_port.to_string(),
            ]);
        }
    }
    if settings.quick_play_enabled {
        if !supports(version) {
            bail!("此版本不支持快速进入存档，需要支持 Quick Play 的 Minecraft 版本（通常为 1.20 及以上）");
        }
        valid_name(&settings.quick_play_world)?;
        let world = safe_join(
            directory,
            format!("saves/{}/level.dat", settings.quick_play_world),
        )?;
        if !world.is_file() {
            bail!("所选存档不存在于当前游戏目录，请重新选择存档");
        }
        args.extend([
            "--quickPlaySingleplayer".into(),
            settings.quick_play_world.clone(),
        ]);
    }
    if !args.is_empty() && supports(version) {
        let log = safe_join(
            directory,
            format!("quickPlay/{}.json", uuid::Uuid::new_v4()),
        )?;
        std::fs::create_dir_all(log.parent().unwrap())?;
        args.extend(["--quickPlayPath".into(), log.to_string_lossy().into_owned()]);
    }
    Ok(args)
}

#[derive(Serialize)]
pub struct World {
    pub id: String,
    pub name: String,
}

pub fn worlds(directory: &Path) -> Result<Vec<World>> {
    let saves = safe_join(directory, "saves")?;
    let entries = match std::fs::read_dir(&saves) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.into()),
    };
    let mut worlds = Vec::new();
    for entry in entries {
        let entry = entry?;
        let Some(id) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let Ok(level) = safe_join(&saves, format!("{id}/level.dat")) else {
            continue;
        };
        if !level.is_file() {
            continue;
        }
        let name = (|| -> Result<String> {
            let mut bytes = Vec::new();
            std::fs::File::open(&level)?
                .take(4 * 1024 * 1024 + 1)
                .read_to_end(&mut bytes)?;
            if bytes.len() > 4 * 1024 * 1024 {
                bail!("存档元数据过大");
            }
            let value = crate::resources::local::parse_world_data(&bytes)?;
            Ok(value["Data"]["LevelName"].as_str().unwrap_or(&id).into())
        })()
        .unwrap_or_else(|_| id.clone());
        worlds.push(World { id, name });
    }
    worlds.sort_by(|a, b| a.name.cmp(&b.name).then(a.id.cmp(&b.id)));
    Ok(worlds)
}

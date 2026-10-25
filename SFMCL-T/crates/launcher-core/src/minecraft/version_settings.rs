use super::versions;
use crate::{
    config::Settings,
    paths::{atomic_write, safe_join, valid_name},
};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Only game options can be overridden; accounts, directories and launcher
/// preferences always come from the global configuration.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GameSettings {
    pub java_path: String,
    pub java_paths: Vec<String>,
    pub auto_memory: bool,
    pub memory_mb: u64,
    pub isolation: bool,
    pub fullscreen: bool,
    pub width: u32,
    pub height: u32,
    pub window_title: String,
    pub custom_info: String,
    pub jvm_args_enabled: bool,
    pub jvm_args: String,
    pub game_args: String,
}

impl Default for GameSettings {
    fn default() -> Self {
        Self::from(&Settings::default())
    }
}

impl From<&Settings> for GameSettings {
    fn from(s: &Settings) -> Self {
        Self {
            java_path: s.java_path.clone(),
            java_paths: s.java_paths.clone(),
            auto_memory: s.auto_memory,
            memory_mb: s.memory_mb,
            isolation: s.isolation,
            fullscreen: s.fullscreen,
            width: s.width,
            height: s.height,
            window_title: s.window_title.clone(),
            custom_info: s.custom_info.clone(),
            jvm_args_enabled: s.jvm_args_enabled,
            jvm_args: s.jvm_args.clone(),
            game_args: s.game_args.clone(),
        }
    }
}

impl GameSettings {
    pub fn validate(&self) -> Result<()> {
        if !(512..=131072).contains(&self.memory_mb) {
            bail!("内存必须在 512–131072 MB 之间");
        }
        if !(320..=16384).contains(&self.width) || !(240..=16384).contains(&self.height) {
            bail!("游戏窗口尺寸无效");
        }
        Ok(())
    }

    pub fn apply_to(&self, global: &Settings) -> Settings {
        Settings {
            java_path: self.java_path.clone(),
            java_paths: self.java_paths.clone(),
            auto_memory: self.auto_memory,
            memory_mb: self.memory_mb,
            isolation: self.isolation,
            fullscreen: self.fullscreen,
            width: self.width,
            height: self.height,
            window_title: self.window_title.clone(),
            custom_info: self.custom_info.clone(),
            jvm_args_enabled: self.jvm_args_enabled,
            jvm_args: self.jvm_args.clone(),
            game_args: self.game_args.clone(),
            ..global.clone()
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionSettings {
    pub use_global: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub independent_groups: Option<GameSettingGroups>,
    pub settings: GameSettings,
}

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GameSettingGroups {
    pub java: bool,
    pub memory: bool,
    pub window: bool,
    pub advanced: bool,
}

impl VersionSettings {
    pub fn groups(&self) -> GameSettingGroups {
        if self.use_global {
            GameSettingGroups::default()
        } else {
            // Existing independent profiles override every group.
            self.independent_groups.unwrap_or(GameSettingGroups {
                java: true,
                memory: true,
                window: true,
                advanced: true,
            })
        }
    }

    pub fn has_independent_settings(&self) -> bool {
        let groups = self.groups();
        groups.java || groups.memory || groups.window || groups.advanced
    }

    pub fn resolve(&self, global: &Settings) -> Settings {
        let groups = self.groups();
        let mut effective = GameSettings::from(global);
        let saved = &self.settings;
        if groups.java {
            effective.java_path = saved.java_path.clone();
            effective.java_paths = saved.java_paths.clone();
        }
        if groups.memory {
            effective.auto_memory = saved.auto_memory;
            effective.memory_mb = saved.memory_mb;
            effective.isolation = saved.isolation;
        }
        if groups.window {
            effective.fullscreen = saved.fullscreen;
            effective.width = saved.width;
            effective.height = saved.height;
            effective.window_title = saved.window_title.clone();
            effective.custom_info = saved.custom_info.clone();
        }
        if groups.advanced {
            effective.jvm_args_enabled = saved.jvm_args_enabled;
            effective.jvm_args = saved.jvm_args.clone();
            effective.game_args = saved.game_args.clone();
        }
        effective.apply_to(global)
    }
}

fn config_path(root: &Path, id: &str) -> Result<PathBuf> {
    valid_name(id)?;
    if !safe_join(root, format!("versions/{id}/{id}.json"))?.is_file() {
        bail!("版本不存在：{id}");
    }
    safe_join(root, format!("versions/{id}/.tmcl/settings.json"))
}

pub fn load(root: &Path, id: &str, global: &Settings) -> Result<VersionSettings> {
    let path = config_path(root, id)?;
    let mut value: VersionSettings = match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes).with_context(|| {
            format!("版本设置损坏，请修复 {}，启动器不会覆盖它", path.display())
        })?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => VersionSettings {
            use_global: true,
            independent_groups: None,
            settings: GameSettings::from(global),
        },
        Err(error) => return Err(error).with_context(|| format!("无法读取 {}", path.display())),
    };
    if value.settings.custom_info == "TMCL" {
        value.settings.custom_info = crate::brand::PRODUCT_NAME.into();
    }
    value.settings.validate()?;
    Ok(value)
}

pub fn save(root: &Path, id: &str, value: &VersionSettings) -> Result<()> {
    let path = config_path(root, id)?;
    value.settings.validate()?;
    atomic_write(&path, &serde_json::to_vec_pretty(value)?)
}

pub fn resolve(root: &Path, id: &str, global: &Settings) -> Result<Settings> {
    let value = load(root, id, global)?;
    let settings = value.resolve(global);
    settings.validate()?;
    Ok(settings)
}

pub fn game_directory(root: &Path, id: &str, global: &Settings) -> Result<PathBuf> {
    versions::game_directory(root, id, resolve(root, id, global)?.isolation)
}

use super::versions;
use crate::{
    config::Settings,
    paths::{atomic_write, safe_join, valid_name},
};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Game options and launch-time window behavior can be overridden per version.
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
    pub window_mode: String,
    pub window_monitor: String,
    pub window_x: i32,
    pub window_y: i32,
    pub launcher_action: String,
    pub restore_launcher: bool,
    pub server_enabled: bool,
    pub server_host: String,
    pub server_port: u16,
    pub quick_play_enabled: bool,
    pub quick_play_world: String,
    pub process_priority: String,
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
            window_mode: s.window_mode.clone(),
            window_monitor: s.window_monitor.clone(),
            window_x: s.window_x,
            window_y: s.window_y,
            launcher_action: s.launcher_action.clone(),
            restore_launcher: s.restore_launcher,
            server_enabled: s.server_enabled,
            server_host: s.server_host.clone(),
            server_port: s.server_port,
            quick_play_enabled: s.quick_play_enabled,
            quick_play_world: s.quick_play_world.clone(),
            process_priority: s.process_priority.clone(),
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
        if !["default", "center", "remember", "maximized", "custom"]
            .contains(&self.window_mode.as_str())
        {
            bail!("未知窗口位置模式");
        }
        if !(-131072..=131072).contains(&self.window_x)
            || !(-131072..=131072).contains(&self.window_y)
        {
            bail!("窗口坐标必须在 -131072–131072 之间");
        }
        if !["keep", "minimize", "tray"].contains(&self.launcher_action.as_str()) {
            bail!("未知启动器启动后行为");
        }
        if !["idle", "belowNormal", "normal", "aboveNormal", "high"]
            .contains(&self.process_priority.as_str())
        {
            bail!("未知游戏进程优先级");
        }
        if self.server_port == 0 {
            bail!("服务器端口必须在 1–65535 之间");
        }
        if !self.server_host.is_empty() {
            super::quick_play::validate_host(&self.server_host)?;
        }
        if self.server_enabled && self.server_host.trim().is_empty() {
            bail!("请填写服务器地址");
        }
        if self.server_enabled && self.quick_play_enabled {
            bail!("服务器直连和快速进入存档不能同时开启");
        }
        if !self.quick_play_world.is_empty() {
            valid_name(&self.quick_play_world)?;
        }
        if self.quick_play_enabled && self.quick_play_world.is_empty() {
            bail!("请选择要快速进入的存档");
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
            window_mode: self.window_mode.clone(),
            window_monitor: self.window_monitor.clone(),
            window_x: self.window_x,
            window_y: self.window_y,
            launcher_action: self.launcher_action.clone(),
            restore_launcher: self.restore_launcher,
            server_enabled: self.server_enabled,
            server_host: self.server_host.clone(),
            server_port: self.server_port,
            quick_play_enabled: self.quick_play_enabled,
            quick_play_world: self.quick_play_world.clone(),
            process_priority: self.process_priority.clone(),
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
    pub position: bool,
    pub launcher: bool,
    pub server: bool,
    pub world: bool,
    pub process: bool,
    pub advanced: bool,
}

impl VersionSettings {
    pub fn groups(&self) -> GameSettingGroups {
        let mut groups = if self.use_global {
            GameSettingGroups::default()
        } else {
            self.independent_groups.unwrap_or(GameSettingGroups {
                java: true,
                memory: true,
                window: true,
                advanced: true,
                ..Default::default()
            })
        };
        // Older profiles may store separate flags for sections now sharing one card.
        groups.window |= groups.position;
        groups.position = groups.window;
        groups.launcher |= groups.process;
        groups.process = groups.launcher;
        groups
    }

    pub fn has_independent_settings(&self) -> bool {
        let groups = self.groups();
        groups.java
            || groups.memory
            || groups.window
            || groups.advanced
            || groups.position
            || groups.launcher
            || groups.server
            || groups.world
            || groups.process
    }

    pub fn resolve(&self, global: &Settings) -> Settings {
        let groups = self.groups();
        let mut effective = GameSettings::from(global);
        effective.server_enabled = false;
        effective.server_host.clear();
        effective.server_port = self.settings.server_port;
        effective.quick_play_enabled = false;
        effective.quick_play_world.clear();
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
        if groups.position {
            effective.window_mode = saved.window_mode.clone();
            effective.window_monitor = saved.window_monitor.clone();
            effective.window_x = saved.window_x;
            effective.window_y = saved.window_y;
        }
        if groups.launcher {
            effective.launcher_action = saved.launcher_action.clone();
            effective.restore_launcher = saved.restore_launcher;
        }
        if groups.server {
            effective.server_host = saved.server_host.trim().into();
            effective.server_enabled = !effective.server_host.is_empty();
            effective.server_port = saved.server_port;
        }
        if groups.world {
            effective.quick_play_world = saved.quick_play_world.clone();
            effective.quick_play_enabled = !effective.quick_play_world.is_empty();
        }
        if groups.process {
            effective.process_priority = saved.process_priority.clone();
        }
        if effective.quick_play_enabled {
            effective.server_enabled = false;
            effective.server_host.clear();
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
            settings: GameSettings {
                server_enabled: false,
                server_host: String::new(),
                server_port: 25565,
                quick_play_enabled: false,
                quick_play_world: String::new(),
                ..GameSettings::from(global)
            },
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

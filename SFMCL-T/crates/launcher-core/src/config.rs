use crate::paths::{atomic_write, minecraft_root};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub schema_version: u32,
    pub game_dirs: Vec<GameDirectory>,
    pub active_dir: String,
    pub active_version: String,
    pub active_player: String,
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
    pub theme: String,
    pub accent: String,
    pub background_type: String,
    pub background: String,
    pub hardware_acceleration: bool,
    pub show_notices: bool,
    pub download_task_display: String,
    pub download_concurrency: usize,
    pub download_cache_dir: String,
    pub microsoft_client_id: String,
    pub close_on_launch: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameDirectory {
    pub name: String,
    pub path: String,
}

impl Default for Settings {
    fn default() -> Self {
        let default_dir = directories::BaseDirs::new()
            .map(|d| d.data_dir().to_path_buf())
            .unwrap_or_else(|| PathBuf::from("."));
        let path = default_dir.to_string_lossy().into_owned();
        Self {
            schema_version: 1,
            game_dirs: vec![GameDirectory {
                name: "默认游戏目录".into(),
                path: path.clone(),
            }],
            active_dir: path,
            active_version: String::new(),
            active_player: String::new(),
            java_path: String::new(),
            java_paths: vec![],
            auto_memory: true,
            memory_mb: 4096,
            isolation: true,
            fullscreen: false,
            width: 1280,
            height: 720,
            window_title: String::new(),
            custom_info: crate::brand::PRODUCT_NAME.into(),
            jvm_args_enabled: false,
            jvm_args: String::new(),
            game_args: String::new(),
            theme: "light".into(),
            accent: "forest".into(),
            background_type: "none".into(),
            background: String::new(),
            hardware_acceleration: true,
            show_notices: true,
            download_task_display: "off".into(),
            download_concurrency: 8,
            download_cache_dir: String::new(),
            microsoft_client_id: crate::brand::environment("MICROSOFT_CLIENT_ID")
                .and_then(|value| value.into_string().ok())
                .unwrap_or_else(|| "95daccaa-315e-436a-828e-dcad1e99d0e6".into()),
            close_on_launch: false,
        }
    }
}

impl Settings {
    pub fn download_cache_directory(&self, data_directory: &Path) -> PathBuf {
        if self.download_cache_dir.is_empty() {
            data_directory.join("downloads").join("cache")
        } else {
            PathBuf::from(&self.download_cache_dir)
        }
    }

    pub fn active_game_root(&self) -> Result<PathBuf> {
        if self.active_dir.is_empty() {
            bail!("请先添加游戏目录");
        }
        self.registered_game_root(Path::new(&self.active_dir))
    }

    pub fn registered_game_root(&self, directory: &Path) -> Result<PathBuf> {
        let root = minecraft_root(directory);
        if !directory.is_absolute()
            || !self
                .game_dirs
                .iter()
                .any(|entry| minecraft_root(Path::new(&entry.path)) == root)
        {
            bail!("请先添加目标游戏目录");
        }
        Ok(root)
    }

    pub fn validate(&self) -> Result<()> {
        crate::minecraft::version_settings::GameSettings::from(self).validate()?;
        if !(1..=32).contains(&self.download_concurrency) {
            bail!("下载并发必须在 1–32 之间");
        }
        if !self.download_cache_dir.is_empty() && !Path::new(&self.download_cache_dir).is_absolute()
        {
            bail!("下载缓存文件夹必须是绝对路径");
        }
        if !["light", "dark", "system"].contains(&self.theme.as_str()) {
            bail!("未知主题");
        }
        if !["none", "default", "local", "remote"].contains(&self.background_type.as_str()) {
            bail!("未知背景类型");
        }
        if !["active", "always", "off"].contains(&self.download_task_display.as_str()) {
            bail!("未知下载任务显示方式");
        }
        if !self.active_dir.is_empty() && !self.game_dirs.iter().any(|d| d.path == self.active_dir)
        {
            bail!("当前目录不在已添加的游戏目录中");
        }
        for dir in &self.game_dirs {
            if !Path::new(&dir.path).is_absolute() {
                bail!("游戏目录必须是绝对路径");
            }
        }
        Ok(())
    }
}

pub struct ConfigStore {
    path: PathBuf,
    settings: Mutex<Settings>,
}
impl ConfigStore {
    pub fn open(dir: &Path) -> Result<Self> {
        let path = dir.join("settings.json");
        let mut settings: Settings = if path.exists() {
            serde_json::from_slice(&std::fs::read(&path)?)
                .context("配置损坏，请保留 settings.json 并修复，启动器不会覆盖它")?
        } else {
            Settings::default()
        };
        if settings.custom_info == "TMCL" {
            settings.custom_info = crate::brand::PRODUCT_NAME.into();
        }
        Ok(Self {
            path,
            settings: Mutex::new(settings),
        })
    }
    pub fn get(&self) -> Settings {
        self.settings
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
    pub fn save(&self, settings: Settings) -> Result<()> {
        settings.validate()?;
        let mut current = self.settings.lock().unwrap_or_else(|e| e.into_inner());
        atomic_write(&self.path, &serde_json::to_vec_pretty(&settings)?)?;
        *current = settings;
        Ok(())
    }
    pub fn update(&self, change: impl FnOnce(&mut Settings)) -> Result<Settings> {
        let mut current = self.settings.lock().unwrap_or_else(|e| e.into_inner());
        let mut next = current.clone();
        change(&mut next);
        next.validate()?;
        atomic_write(&self.path, &serde_json::to_vec_pretty(&next)?)?;
        *current = next.clone();
        Ok(next)
    }
}

/// Parse old settings without opening any referenced game files or altering them.
pub fn import_legacy(value: &Value, base: &Path) -> Settings {
    let mut s = Settings::default();
    let game = &value["gameArgs"];
    s.auto_memory = game["memory"]["auto"].as_bool().unwrap_or(true);
    s.memory_mb = game["memory"]["value"]
        .as_u64()
        .unwrap_or(4096)
        .clamp(512, 131072);
    s.isolation = game["isIsolate"].as_bool().unwrap_or(true);
    s.fullscreen = game["window"]["fullscreen"].as_bool().unwrap_or(false);
    s.width = game["window"]["width"]
        .as_u64()
        .unwrap_or(854)
        .clamp(320, 16384) as u32;
    s.height = game["window"]["height"]
        .as_u64()
        .unwrap_or(480)
        .clamp(240, 16384) as u32;
    for (target, source) in [
        (&mut s.window_title, &game["other"]["windowTitle"]),
        (&mut s.custom_info, &game["other"]["customInfo"]),
        (&mut s.jvm_args, &game["other"]["jvmExtra"]["args"]),
        (&mut s.game_args, &game["other"]["gameTailArgs"]),
    ] {
        if let Some(text) = source.as_str() {
            *target = text.into();
        }
    }
    s.jvm_args_enabled = game["other"]["jvmExtra"]["enable"]
        .as_bool()
        .unwrap_or(false);
    if let Some(list) = game["java"]["list"].as_array() {
        s.java_paths = list
            .iter()
            .filter_map(|j| {
                j["JavaPath"]
                    .as_str()
                    .or(j["Path"].as_str())
                    .or(j["JavaHome"].as_str())
            })
            .map(str::to_owned)
            .collect();
        let index = game["java"]["index"].as_u64().unwrap_or(0) as usize;
        if index > 0 {
            s.java_path = s.java_paths.get(index - 1).cloned().unwrap_or_default();
        }
    }
    if let Some(dirs) = value["game"]["dirs"].as_array() {
        let mapped: Vec<_> = dirs
            .iter()
            .filter_map(|d| {
                let path = PathBuf::from(d["Path"].as_str()?);
                let path = if path.is_absolute() {
                    path
                } else {
                    base.join(path)
                };
                Some(GameDirectory {
                    name: d["Name"].as_str().unwrap_or("导入目录").into(),
                    path: path.to_string_lossy().into_owned(),
                })
            })
            .collect();
        if !mapped.is_empty() {
            let chosen = value["game"]["dir"]["Path"].as_str().unwrap_or("");
            s.active_dir = mapped
                .iter()
                .find(|d| d.path == chosen)
                .unwrap_or(&mapped[0])
                .path
                .clone();
            s.game_dirs = mapped;
        }
    }
    s.active_version = value["game"]["minecraft"]["Name"]
        .as_str()
        .unwrap_or("")
        .into();
    s.active_player = value["player"]["player"]["UUID"]
        .as_str()
        .unwrap_or("")
        .into();
    let launcher = &value["launcher"];
    s.hardware_acceleration = launcher["hardwareAcceleration"].as_bool().unwrap_or(true);
    s.show_notices = launcher["enableNotice"].as_bool().unwrap_or(true);
    s.accent = match launcher["theme"].as_str() {
        Some("Ebony") => "ebony",
        Some("Puce") => "puce",
        _ => "forest",
    }
    .into();
    s.background_type = match launcher["bg"]["type"].as_str() {
        Some("default") => "default",
        Some("local") => "local",
        Some("network") => "remote",
        _ => "none",
    }
    .into();
    s.background = launcher["bg"]["path"].as_str().unwrap_or("").into();
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn persists_and_rejects_invalid_settings_without_overwrite() {
        let dir = tempfile::tempdir().unwrap();
        let store = ConfigStore::open(dir.path()).unwrap();
        let mut s = store.get();
        s.memory_mb = 8192;
        store.save(s.clone()).unwrap();
        s.memory_mb = 0;
        assert!(store.save(s).is_err());
        assert_eq!(ConfigStore::open(dir.path()).unwrap().get().memory_mb, 8192);
    }
    #[test]
    fn damaged_config_is_not_silently_reset() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("settings.json"), "broken").unwrap();
        assert!(ConfigStore::open(dir.path()).is_err());
    }
    #[test]
    fn download_task_display_defaults_to_off_for_new_and_old_configs() {
        assert_eq!(Settings::default().download_task_display, "off");
        for old_mode in ["always", "active", "auto"] {
            let settings: Settings =
                serde_json::from_value(serde_json::json!({ "showDownloads": old_mode })).unwrap();
            assert_eq!(settings.download_task_display, "off");
        }
        let legacy = import_legacy(
            &serde_json::json!({ "launcher": { "showDownloadBtn": true } }),
            Path::new("C:/Games"),
        );
        assert_eq!(legacy.download_task_display, "off");
    }
    #[test]
    fn download_task_display_persists_all_modes_and_rejects_invalid_values() {
        let dir = tempfile::tempdir().unwrap();
        let store = ConfigStore::open(dir.path()).unwrap();
        for mode in ["active", "always", "off"] {
            let mut settings = store.get();
            settings.download_task_display = mode.into();
            store.save(settings).unwrap();
            assert_eq!(
                ConfigStore::open(dir.path())
                    .unwrap()
                    .get()
                    .download_task_display,
                mode
            );
            let saved: Value =
                serde_json::from_slice(&std::fs::read(dir.path().join("settings.json")).unwrap())
                    .unwrap();
            assert_eq!(saved["downloadTaskDisplay"], mode);
            assert!(saved.get("showDownloads").is_none());
        }
        let mut settings = store.get();
        settings.download_task_display = "unknown".into();
        assert!(store.save(settings).is_err());
        assert_eq!(
            ConfigStore::open(dir.path())
                .unwrap()
                .get()
                .download_task_display,
            "off"
        );
    }
    #[test]
    fn maps_legacy_options() {
        let value = serde_json::json!({"gameArgs":{"memory":{"auto":false,"value":2048},"isIsolate":false,"window":{"width":854,"height":480},"other":{"jvmExtra":{"enable":true,"args":"-Dtest=1"}}},"player":{"player":{"UUID":"abc"}}});
        let s = import_legacy(&value, Path::new("C:/Games"));
        assert!(!s.auto_memory);
        assert!(!s.isolation);
        assert!(s.jvm_args_enabled);
        assert_eq!(s.jvm_args, "-Dtest=1");
        assert_eq!(s.active_player, "abc");
    }
    #[test]
    fn cache_directory_defaults_persists_and_rejects_relative_paths() {
        let dir = tempfile::tempdir().unwrap();
        let old: Settings = serde_json::from_str("{}").unwrap();
        assert!(old.download_cache_dir.is_empty());
        assert_eq!(
            old.download_cache_directory(dir.path()),
            dir.path().join("downloads/cache")
        );
        let store = ConfigStore::open(dir.path()).unwrap();
        let mut settings = store.get();
        let cache = dir.path().join("自定义缓存");
        settings.download_cache_dir = cache.to_string_lossy().into_owned();
        store.save(settings).unwrap();
        let mut saved = ConfigStore::open(dir.path()).unwrap().get();
        assert_eq!(saved.download_cache_directory(dir.path()), cache);
        saved.download_cache_dir = "relative/cache".into();
        assert!(store.save(saved).is_err());
        assert_eq!(store.get().download_cache_directory(dir.path()), cache);
    }
}

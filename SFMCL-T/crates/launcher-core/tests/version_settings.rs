use serde_json::json;
use sfmcl_t_core::{
    config::{ConfigStore, Settings},
    minecraft::{
        arguments::{self, Identity},
        version_settings::{self, GameSettingGroups, GameSettings, VersionSettings},
        versions,
    },
};
use std::{fs, path::Path};

fn version(root: &Path, id: &str) {
    let dir = root.join("versions").join(id);
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join(format!("{id}.json")), json!({
        "id": id, "mainClass": "game.Main", "libraries": [],
        "arguments": {"game": ["--gameDir", "${game_directory}", "--versionType", "${version_type}"]}
    }).to_string()).unwrap();
    fs::write(dir.join(format!("{id}.jar")), b"test jar").unwrap();
}

fn independent(global: &Settings, memory: u64) -> VersionSettings {
    let mut settings = GameSettings::from(global);
    settings.auto_memory = false;
    settings.memory_mb = memory;
    VersionSettings {
        use_global: false,
        independent_groups: None,
        settings,
    }
}

#[test]
fn groups_follow_current_globals_and_preserve_dormant_overrides() {
    let root = tempfile::tempdir().unwrap();
    version(root.path(), "grouped");
    let mut global = Settings::default();
    let mut config = independent(&global, 8192);
    config.settings.java_path = "custom-java".into();
    config.settings.window_title = "custom-title".into();
    config.settings.jvm_args = "-Dprofile=custom".into();
    config.settings.isolation = false;
    config.independent_groups = Some(GameSettingGroups {
        memory: true,
        ..Default::default()
    });
    version_settings::save(root.path(), "grouped", &config).unwrap();
    global.java_path = "global-java".into();
    global.window_title = "global-title".into();
    global.jvm_args = "-Dprofile=global".into();
    global.memory_mb = 6144;
    global.isolation = true;
    let effective = version_settings::resolve(root.path(), "grouped", &global).unwrap();
    assert_eq!(effective.memory_mb, 8192);
    assert!(!effective.isolation);
    assert_eq!(effective.java_path, "global-java");
    assert_eq!(effective.window_title, "global-title");
    assert_eq!(effective.jvm_args, "-Dprofile=global");

    config.independent_groups = Some(GameSettingGroups {
        java: true,
        window: true,
        advanced: true,
        memory: false,
    });
    version_settings::save(root.path(), "grouped", &config).unwrap();
    let effective = version_settings::resolve(root.path(), "grouped", &global).unwrap();
    assert_eq!(effective.memory_mb, 6144);
    assert!(effective.isolation);
    assert_eq!(effective.java_path, "custom-java");
    assert_eq!(effective.window_title, "custom-title");
    assert_eq!(effective.jvm_args, "-Dprofile=custom");
    assert_eq!(
        version_settings::load(root.path(), "grouped", &global)
            .unwrap()
            .settings
            .memory_mb,
        8192
    );

    config.independent_groups = Some(GameSettingGroups::default());
    assert!(!config.has_independent_settings());
    assert_eq!(
        GameSettings::from(&config.resolve(&global)),
        GameSettings::from(&global)
    );
}

#[test]
fn legacy_independent_profiles_still_override_all_groups() {
    let config: VersionSettings = serde_json::from_value(json!({
        "useGlobal": false,
        "settings": { "memoryMb": 8192, "windowTitle": "legacy", "isolation": false }
    }))
    .unwrap();
    assert!(config.independent_groups.is_none());
    let effective = config.resolve(&Settings::default());
    assert_eq!(effective.memory_mb, 8192);
    assert_eq!(effective.window_title, "legacy");
    assert!(!effective.isolation);
}

#[test]
fn legacy_global_config_remains_compatible_and_versions_follow_latest_defaults() {
    let config = tempfile::tempdir().unwrap();
    fs::write(
        config.path().join("settings.json"),
        r#"{"memoryMb":6144,"windowTitle":"Global"}"#,
    )
    .unwrap();
    let store = ConfigStore::open(config.path()).unwrap();
    let root = tempfile::tempdir().unwrap();
    version(root.path(), "old-version");
    assert!(
        version_settings::load(root.path(), "old-version", &store.get())
            .unwrap()
            .use_global
    );
    assert_eq!(
        version_settings::resolve(root.path(), "old-version", &store.get())
            .unwrap()
            .memory_mb,
        6144
    );
    store.update(|s| s.memory_mb = 8192).unwrap();
    assert_eq!(
        version_settings::resolve(root.path(), "old-version", &store.get())
            .unwrap()
            .memory_mb,
        8192
    );
    assert!(!root
        .path()
        .join("versions/old-version/.tmcl/settings.json")
        .exists());
}

#[test]
fn persists_per_version_and_per_directory_without_changing_launcher_options() {
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    for (root, id) in [
        (first.path(), "a"),
        (first.path(), "b"),
        (second.path(), "a"),
    ] {
        version(root, id);
    }
    let mut global = Settings::default();
    let a = independent(&global, 8192);
    let b = independent(&global, 2048);
    version_settings::save(first.path(), "a", &a).unwrap();
    version_settings::save(first.path(), "b", &b).unwrap();
    global.memory_mb = 6144;
    global.theme = "dark".into();
    global.active_player = "new-player".into();
    let loaded = version_settings::resolve(first.path(), "a", &global).unwrap();
    assert_eq!(loaded.memory_mb, 8192);
    assert_eq!(loaded.theme, "dark");
    assert_eq!(loaded.active_player, "new-player");
    assert_eq!(
        version_settings::load(first.path(), "a", &global)
            .unwrap()
            .settings,
        a.settings
    );
    assert_eq!(
        version_settings::resolve(first.path(), "b", &global)
            .unwrap()
            .memory_mb,
        2048
    );
    assert_eq!(
        version_settings::resolve(second.path(), "a", &global)
            .unwrap()
            .memory_mb,
        6144
    );
    let mut inherited = a.clone();
    inherited.use_global = true;
    version_settings::save(first.path(), "a", &inherited).unwrap();
    assert_eq!(
        version_settings::resolve(first.path(), "a", &global)
            .unwrap()
            .memory_mb,
        6144
    );
    let mut restored = version_settings::load(first.path(), "a", &global).unwrap();
    restored.use_global = false;
    version_settings::save(first.path(), "a", &restored).unwrap();
    assert_eq!(
        version_settings::resolve(first.path(), "a", &global)
            .unwrap()
            .memory_mb,
        8192
    );
}

#[test]
fn rename_keeps_configuration_and_inherited_game_versions_do_not_share_it() {
    let root = tempfile::tempdir().unwrap();
    version(root.path(), "base");
    version(root.path(), "child");
    fs::write(
        root.path().join("versions/child/child.json"),
        r#"{"id":"child","inheritsFrom":"base"}"#,
    )
    .unwrap();
    let global = Settings::default();
    version_settings::save(root.path(), "base", &independent(&global, 8192)).unwrap();
    assert_eq!(
        version_settings::resolve(root.path(), "child", &global)
            .unwrap()
            .memory_mb,
        global.memory_mb
    );
    version_settings::save(root.path(), "child", &independent(&global, 2048)).unwrap();
    versions::rename(root.path(), "child", "renamed").unwrap();
    assert_eq!(
        version_settings::resolve(root.path(), "renamed", &global)
            .unwrap()
            .memory_mb,
        2048
    );
    assert!(version_settings::load(root.path(), "child", &global).is_err());
}

#[test]
fn launch_arguments_and_resource_directory_use_the_same_version_options() {
    let root = tempfile::tempdir().unwrap();
    version(root.path(), "game");
    let global = Settings::default();
    let mut config = independent(&global, 3072);
    config.settings.java_path = "C:/Custom Java/bin/javaw.exe".into();
    config.settings.java_paths = vec![config.settings.java_path.clone()];
    config.settings.isolation = false;
    config.settings.width = 1600;
    config.settings.height = 900;
    config.settings.fullscreen = true;
    config.settings.window_title = "Only this game".into();
    config.settings.custom_info = "Custom profile".into();
    config.settings.jvm_args_enabled = true;
    config.settings.jvm_args = r#"-Dprofile="custom game""#.into();
    config.settings.game_args = "--server example.org".into();
    version_settings::save(root.path(), "game", &config).unwrap();
    let effective = version_settings::resolve(root.path(), "game", &global).unwrap();
    assert_eq!(GameSettings::from(&effective), config.settings);
    let metadata = versions::resolve(root.path(), "game").unwrap();
    let args = arguments::build(
        root.path(),
        "game",
        &metadata,
        &effective,
        &Identity {
            name: "Player",
            uuid: "id",
            access_token: "",
            online: false,
        },
        effective.memory_mb,
    )
    .unwrap();
    for value in [
        "-Xmx3072m",
        "-Dprofile=custom game",
        "--fullscreen",
        "1600",
        "900",
        "Custom profile",
        "--server",
        "example.org",
    ] {
        assert!(
            args.iter().any(|arg| arg == value),
            "missing {value}: {args:?}"
        );
    }
    let directory = version_settings::game_directory(root.path(), "game", &global).unwrap();
    assert_eq!(directory, root.path());
    assert_eq!(
        args[args.iter().position(|arg| arg == "--gameDir").unwrap() + 1],
        directory.to_string_lossy()
    );
    config.settings.isolation = true;
    version_settings::save(root.path(), "game", &config).unwrap();
    assert_eq!(
        version_settings::game_directory(root.path(), "game", &global).unwrap(),
        root.path().join("versions/game")
    );
}

#[test]
fn invalid_or_damaged_settings_are_not_overwritten_and_paths_cannot_escape() {
    let root = tempfile::tempdir().unwrap();
    version(root.path(), "game");
    // This name must never collide with the launcher's own settings file.
    version(root.path(), "sfmcl-t-settings");
    let global = Settings::default();
    let mut config = independent(&global, 8192);
    version_settings::save(root.path(), "sfmcl-t-settings", &config).unwrap();
    assert!(versions::resolve(root.path(), "sfmcl-t-settings").is_ok());
    version_settings::save(root.path(), "game", &config).unwrap();
    for (memory, width) in [(0, 1280), (8192, 0)] {
        config.settings.memory_mb = memory;
        config.settings.width = width;
        assert!(version_settings::save(root.path(), "game", &config).is_err());
        assert_eq!(
            version_settings::load(root.path(), "game", &global)
                .unwrap()
                .settings
                .memory_mb,
            8192
        );
    }
    for id in ["../escape", "missing", "game/other"] {
        assert!(version_settings::load(root.path(), id, &global).is_err());
        assert!(version_settings::save(root.path(), id, &config).is_err());
    }
    let path = root.path().join("versions/game/.tmcl/settings.json");
    fs::write(&path, b"broken config").unwrap();
    assert!(version_settings::resolve(root.path(), "game", &global).is_err());
    assert_eq!(fs::read(&path).unwrap(), b"broken config");
}

use serde_json::json;
use sfmcl_t_core::{
    config::{ConfigStore, Settings},
    minecraft::{
        arguments::{self, Identity},
        quick_play,
        version_settings::{GameSettingGroups, GameSettings, VersionSettings},
    },
};
use std::{fs, path::Path};

fn modern() -> serde_json::Value {
    json!({"id":"1.21.4","mainClass":"game.Main","libraries":[],"arguments":{"game":[
        {"rules":[{"action":"allow","features":{"has_quick_plays_support":true}}],"value":["--quickPlayPath","${quickPlayPath}"]},
        {"rules":[{"action":"allow","features":{"is_quick_play_singleplayer":true}}],"value":["--quickPlaySingleplayer","${quickPlaySingleplayer}"]},
        {"rules":[{"action":"allow","features":{"is_quick_play_multiplayer":true}}],"value":["--quickPlayMultiplayer","${quickPlayMultiplayer}"]}
    ]}})
}
fn make_world(directory: &Path, id: &str) {
    let world = directory.join("saves").join(id);
    fs::create_dir_all(&world).unwrap();
    fs::write(
        world.join("level.dat"),
        fastnbt::to_bytes(&json!({"Data":{"LevelName":"中文存档"}})).unwrap(),
    )
    .unwrap();
}

#[test]
fn all_launch_options_persist_and_old_configs_receive_safe_defaults() {
    let old: Settings = serde_json::from_str("{}").unwrap();
    assert_eq!(old.launcher_action, "keep");
    assert_eq!(old.window_mode, "default");
    assert!(old.restore_launcher);
    assert!(!old.server_enabled && !old.quick_play_enabled);
    assert_eq!(old.process_priority, "normal");
    let dir = tempfile::tempdir().unwrap();
    let store = ConfigStore::open(dir.path()).unwrap();
    let mut settings = store.get();
    settings.window_mode = "custom".into();
    settings.window_x = 120;
    settings.window_y = 80;
    settings.window_monitor = "display-2".into();
    settings.launcher_action = "tray".into();
    settings.restore_launcher = false;
    settings.server_enabled = true;
    settings.server_host = "play.example.com".into();
    settings.server_port = 25566;
    settings.quick_play_world = "My World".into();
    settings.process_priority = "aboveNormal".into();
    store.save(settings.clone()).unwrap();
    assert_eq!(
        GameSettings::from(&ConfigStore::open(dir.path()).unwrap().get()),
        GameSettings::from(&settings)
    );
    let mut invalid = settings.clone();
    invalid.server_port = 0;
    assert!(store.save(invalid).is_err());
    assert_eq!(store.get().server_port, 25566);
    let mut invalid = settings;
    invalid.quick_play_enabled = true;
    assert!(store.save(invalid).is_err());
}

#[test]
fn quick_play_only_uses_independent_version_settings() {
    let global = Settings {
        quick_play_enabled: true,
        quick_play_world: "Global World".into(),
        ..Default::default()
    };
    let root = tempfile::tempdir().unwrap();
    let version_dir = root.path().join("versions/test");
    fs::create_dir_all(&version_dir).unwrap();
    fs::write(version_dir.join("test.json"), b"{}").unwrap();
    let mut config =
        sfmcl_t_core::minecraft::version_settings::load(root.path(), "test", &global).unwrap();
    assert!(!config.settings.quick_play_enabled);
    assert!(config.settings.quick_play_world.is_empty());
    config.settings.quick_play_enabled = true;
    config.settings.quick_play_world = "Version World".into();
    let inherited = config.resolve(&global);
    assert!(!inherited.quick_play_enabled);
    assert!(inherited.quick_play_world.is_empty());
    config.use_global = false;
    config.independent_groups = Some(GameSettingGroups {
        world: true,
        ..Default::default()
    });
    let effective = config.resolve(&global);
    assert!(effective.quick_play_enabled);
    assert_eq!(effective.quick_play_world, "Version World");
    config.independent_groups.as_mut().unwrap().world = false;
    let disabled = config.resolve(&global);
    assert!(!disabled.quick_play_enabled);
    assert!(disabled.quick_play_world.is_empty());
    assert_eq!(config.settings.quick_play_world, "Version World");
}

#[test]
fn independent_launch_groups_inherit_and_preserve_other_versions() {
    let global = Settings {
        launcher_action: "minimize".into(),
        server_enabled: true,
        server_host: "global.example.com".into(),
        ..Default::default()
    };
    let mut saved = GameSettings::from(&global);
    saved.launcher_action = "tray".into();
    saved.window_mode = "remember".into();
    saved.quick_play_enabled = true;
    saved.quick_play_world = "My World".into();
    saved.server_enabled = false;
    saved.process_priority = "high".into();
    let config = VersionSettings {
        use_global: false,
        independent_groups: Some(GameSettingGroups {
            launcher: true,
            world: true,
            position: true,
            process: true,
            ..Default::default()
        }),
        settings: saved.clone(),
    };
    let effective = config.resolve(&global);
    effective.validate().unwrap();
    assert_eq!(effective.launcher_action, "tray");
    assert_eq!(effective.window_mode, "remember");
    assert!(effective.quick_play_enabled);
    assert!(!effective.server_enabled);
    assert!(effective.server_host.is_empty());
    assert_eq!(effective.process_priority, "high");
    assert!(config.has_independent_settings());
    assert_eq!(config.settings, saved);
    let legacy: VersionSettings =
        serde_json::from_value(json!({"useGlobal":false,"settings":{"memoryMb":8192}})).unwrap();
    assert_eq!(legacy.resolve(&global).launcher_action, "minimize");
    assert!(!legacy.resolve(&global).server_enabled);
}

#[test]
fn direct_entry_uses_local_fields_without_enable_switches() {
    let global = Settings {
        server_enabled: true,
        server_host: "global.example.com".into(),
        server_port: 25566,
        ..Default::default()
    };
    let root = tempfile::tempdir().unwrap();
    let version_dir = root.path().join("versions/test");
    fs::create_dir_all(&version_dir).unwrap();
    fs::write(version_dir.join("test.json"), b"{}").unwrap();
    let mut config =
        sfmcl_t_core::minecraft::version_settings::load(root.path(), "test", &global).unwrap();
    assert!(config.settings.server_host.is_empty());
    assert!(!config.resolve(&global).server_enabled);
    config.settings.server_port = 25567;
    assert_eq!(config.resolve(&global).server_port, 25567);
    config.use_global = false;
    config.independent_groups = Some(GameSettingGroups {
        server: true,
        world: true,
        ..Default::default()
    });
    config.settings.server_host = "local.example.com".into();
    config.settings.server_enabled = false;
    let server = config.resolve(&global);
    assert!(server.server_enabled);
    assert_eq!(server.server_host, "local.example.com");
    config.settings.quick_play_world = "Local World".into();
    config.settings.quick_play_enabled = false;
    let world = config.resolve(&global);
    assert!(world.quick_play_enabled);
    assert!(!world.server_enabled);
    assert!(world.server_host.is_empty());
    config.settings.server_host.clear();
    config.settings.quick_play_world.clear();
    config.settings.server_enabled = true;
    config.settings.quick_play_enabled = true;
    let empty = config.resolve(&global);
    assert!(!empty.server_enabled && !empty.quick_play_enabled);
    empty.validate().unwrap();
}

#[test]
fn direct_connection_selects_modern_or_legacy_arguments_and_ipv6() {
    let dir = tempfile::tempdir().unwrap();
    let settings = Settings {
        server_enabled: true,
        server_host: "play.example.com".into(),
        server_port: 25566,
        ..Default::default()
    };
    let args = quick_play::arguments(&modern(), &settings, dir.path()).unwrap();
    assert_eq!(
        &args[..2],
        ["--quickPlayMultiplayer", "play.example.com:25566"]
    );
    assert_eq!(args[2], "--quickPlayPath");
    assert_eq!(
        quick_play::arguments(&json!({}), &settings, dir.path()).unwrap(),
        ["--server", "play.example.com", "--port", "25566"]
    );
    let settings = Settings {
        server_host: "[2001:db8::1]".into(),
        ..settings
    };
    assert_eq!(
        quick_play::arguments(&modern(), &settings, dir.path()).unwrap()[1],
        "[2001:db8::1]:25566"
    );
    for invalid in [
        "https://example.com",
        "example.com:25565",
        "[1]",
        "../world",
        "",
    ] {
        assert!(quick_play::validate_host(invalid).is_err());
    }
}

#[test]
fn quick_play_uses_folder_names_and_rejects_missing_or_unsupported_worlds() {
    let dir = tempfile::tempdir().unwrap();
    make_world(dir.path(), "My World");
    let settings = Settings {
        quick_play_enabled: true,
        quick_play_world: "My World".into(),
        ..Default::default()
    };
    assert_eq!(
        &quick_play::arguments(&modern(), &settings, dir.path()).unwrap()[..2],
        ["--quickPlaySingleplayer", "My World"]
    );
    let worlds = quick_play::worlds(dir.path()).unwrap();
    assert_eq!(worlds.len(), 1);
    assert_eq!(worlds[0].name, "中文存档");
    assert_eq!(worlds[0].id, "My World");
    assert!(quick_play::arguments(&json!({}), &settings, dir.path()).is_err());
    assert!(quick_play::arguments(
        &modern(),
        &Settings {
            quick_play_world: "Missing".into(),
            ..settings.clone()
        },
        dir.path()
    )
    .is_err());
    assert!(quick_play::arguments(
        &modern(),
        &Settings {
            quick_play_world: "../outside".into(),
            ..settings
        },
        dir.path()
    )
    .is_err());
}

#[test]
fn generated_launch_arguments_contain_one_quick_play_target_and_no_unresolved_tokens() {
    let root = tempfile::tempdir().unwrap();
    let instance = root.path().join("versions/test");
    fs::create_dir_all(&instance).unwrap();
    fs::write(instance.join("test.jar"), b"jar").unwrap();
    make_world(&instance, "My World");
    let identity = Identity {
        name: "Player",
        uuid: "uuid",
        access_token: "0",
        online: false,
    };
    let settings = Settings {
        quick_play_enabled: true,
        quick_play_world: "My World".into(),
        ..Default::default()
    };
    let args =
        arguments::build(root.path(), "test", &modern(), &settings, &identity, 4096).unwrap();
    assert_eq!(
        args.iter()
            .filter(|a| a.as_str() == "--quickPlaySingleplayer")
            .count(),
        1
    );
    assert_eq!(
        args.iter()
            .filter(|a| a.as_str() == "--quickPlayPath")
            .count(),
        1
    );
    assert!(!args
        .iter()
        .any(|a| a.contains("${") || a == "--server" || a == "--quickPlayMultiplayer"));
    assert!(args
        .windows(2)
        .any(|pair| pair == ["--quickPlaySingleplayer", "My World"]));
}

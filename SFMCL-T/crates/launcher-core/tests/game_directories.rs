use serde_json::json;
use sfmcl_t_core::{
    config::{ConfigStore, GameDirectory, Settings},
    minecraft::{
        arguments::{self, Identity},
        version_settings, versions,
    },
    resources::local,
};
use std::{fs, path::Path};

fn settings(directory: &Path) -> Settings {
    Settings {
        active_dir: directory.to_string_lossy().into_owned(),
        game_dirs: vec![GameDirectory {
            name: "测试目录".into(),
            path: directory.to_string_lossy().into_owned(),
        }],
        active_version: "test".into(),
        ..Settings::default()
    }
}

#[test]
fn favorites_aggregate_registered_directories_and_follow_removed_records() {
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    let unregistered = tempfile::tempdir().unwrap();
    for directory in [first.path(), second.path(), unregistered.path()] {
        let root = directory.join(".minecraft");
        let version = root.join("versions/shared");
        fs::create_dir_all(&version).unwrap();
        fs::write(
            version.join("shared.json"),
            json!({"id":"shared"}).to_string(),
        )
        .unwrap();
        versions::set_favorite(&root, "shared", true).unwrap();
    }
    let mut global = settings(first.path());
    global.game_dirs.push(GameDirectory {
        name: "另一个目录".into(),
        path: second.path().to_string_lossy().into_owned(),
    });
    global.game_dirs.push(GameDirectory {
        name: "旧目录格式".into(),
        path: first
            .path()
            .join(".minecraft")
            .to_string_lossy()
            .into_owned(),
    });
    let favorites = versions::favorites(&global);
    assert_eq!(
        favorites.len(),
        2,
        "Aliases do not duplicate favorites and unregistered roots are excluded"
    );
    assert_eq!(favorites[0].version.id, favorites[1].version.id);
    assert_ne!(favorites[0].version.path, favorites[1].version.path);
    assert_eq!(favorites[0].directory, first.path().to_string_lossy());
    assert_eq!(favorites[1].directory, second.path().to_string_lossy());
    let serialized = serde_json::to_value(&favorites[1]).unwrap();
    assert_eq!(serialized["id"], "shared");
    assert_eq!(serialized["directoryName"], "另一个目录");
    global.active_dir = second.path().to_string_lossy().into_owned();
    assert_eq!(versions::favorites(&global).len(), 2);
    global
        .game_dirs
        .retain(|directory| directory.path == global.active_dir);
    assert_eq!(versions::favorites(&global).len(), 1);
    assert!(first
        .path()
        .join(".minecraft/versions/shared/.tmcl/favorite")
        .is_file());
    global.game_dirs.clear();
    global.active_dir.clear();
    assert!(versions::favorites(&global).is_empty());
}

#[test]
fn selected_parent_and_legacy_minecraft_record_resolve_to_the_same_root() {
    let parent = tempfile::tempdir().unwrap();
    let root = parent.path().join(".minecraft");
    let config = tempfile::tempdir().unwrap();
    let store = ConfigStore::open(config.path()).unwrap();
    for directory in [parent.path(), root.as_path()] {
        store.save(settings(directory)).unwrap();
        let loaded = ConfigStore::open(config.path()).unwrap().get();
        assert_eq!(loaded.active_game_root().unwrap(), root);
        assert_eq!(loaded.registered_game_root(parent.path()).unwrap(), root);
        assert_eq!(loaded.registered_game_root(&root).unwrap(), root);
        assert!(loaded.registered_game_root(config.path()).is_err());
        assert!(loaded.registered_game_root(Path::new("relative")).is_err());
    }
    assert!(
        !root.exists(),
        "Resolving a directory must not create files"
    );
    let mut empty = settings(parent.path());
    empty.active_dir.clear();
    assert!(empty.active_game_root().is_err());
}

#[test]
fn scan_launch_and_local_resources_use_the_nested_minecraft_directory() {
    let parent = tempfile::tempdir().unwrap();
    let root = parent.path().join(".minecraft");
    let version = root.join("versions/test");
    fs::create_dir_all(&version).unwrap();
    fs::write(version.join("test.json"), json!({
        "id": "test", "mainClass": "game.Main", "libraries": [],
        "arguments": {"game": ["--gameDir", "${game_directory}", "--assetsDir", "${assets_root}"]}
    }).to_string()).unwrap();
    fs::write(version.join("test.jar"), b"test client").unwrap();
    for directory in [&root, &version] {
        let pack = directory.join("resourcepacks/test-pack");
        fs::create_dir_all(&pack).unwrap();
        fs::write(
            pack.join("pack.mcmeta"),
            r#"{"pack":{"pack_format":15,"description":"Test pack"}}"#,
        )
        .unwrap();
    }
    let mut global = settings(parent.path());
    let resolved = global.active_game_root().unwrap();
    let scanned = versions::scan(&resolved).unwrap();
    assert_eq!(scanned.len(), 1);
    assert_eq!(Path::new(&scanned[0].path), version);
    for isolation in [false, true] {
        global.isolation = isolation;
        let effective = version_settings::resolve(&resolved, "test", &global).unwrap();
        let game = local::version_root(&resolved, "test", effective.isolation).unwrap();
        assert_eq!(
            game,
            if isolation {
                version.clone()
            } else {
                root.clone()
            }
        );
        let packs = local::scan(&game, "resourcepack").unwrap();
        assert_eq!(packs.len(), 1);
        assert!(packs[0].error.is_none());
        assert_eq!(
            Path::new(&packs[0].path),
            game.join("resourcepacks/test-pack")
        );
        let args = arguments::build(
            &resolved,
            "test",
            &versions::resolve(&resolved, "test").unwrap(),
            &effective,
            &Identity {
                name: "Test",
                uuid: "test",
                access_token: "",
                online: false,
            },
            2048,
        )
        .unwrap();
        let game_arg = args.iter().position(|arg| arg == "--gameDir").unwrap();
        assert_eq!(Path::new(&args[game_arg + 1]), game);
        let assets_arg = args.iter().position(|arg| arg == "--assetsDir").unwrap();
        assert_eq!(Path::new(&args[assets_arg + 1]), root.join("assets"));
    }
    assert!(!parent.path().join("versions").exists());
    assert!(!root.join(".minecraft").exists());
}

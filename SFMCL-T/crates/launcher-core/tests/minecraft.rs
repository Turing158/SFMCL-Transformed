use serde_json::json;
use sfmcl_t_core::{
    config::Settings,
    minecraft::{
        arguments::{self, Identity},
        java, versions,
    },
};
use std::{collections::HashMap, fs};

#[test]
fn inherited_versions_preserve_parent_jar_and_merge_arguments() {
    let temp = tempfile::tempdir().unwrap();
    for (id, value) in [
        (
            "base",
            json!({"id":"base","mainClass":"game.Main","libraries":[{"name":"test:lib:1"}],"arguments":{"game":["--username","${auth_player_name}"]}}),
        ),
        (
            "fabric",
            json!({"id":"fabric","inheritsFrom":"base","mainClass":"loader.Main","libraries":[{"name":"test:lib:2"}],"arguments":{"game":["--loader"]}}),
        ),
    ] {
        let directory = temp.path().join("versions").join(id);
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join(format!("{id}.json")), value.to_string()).unwrap();
    }
    let version = versions::resolve(temp.path(), "fabric").unwrap();
    assert_eq!(version["jar"], "base");
    assert_eq!(version["mainClass"], "loader.Main");
    assert_eq!(version["arguments"]["game"].as_array().unwrap().len(), 3);
    let libraries = versions::libraries(&version).unwrap();
    assert_eq!(libraries.len(), 1);
    assert!(libraries[0].file.path.ends_with("lib-2.jar"));
    assert!(
        versions::rename(temp.path(), "base", "renamed").is_err(),
        "renaming a parent would break its child"
    );
}
#[test]
fn detects_cycles_and_rejects_inheritance_path_escape() {
    let temp = tempfile::tempdir().unwrap();
    for (id, parent) in [("a", "b"), ("b", "a"), ("escape", "../../bad")] {
        let directory = temp.path().join("versions").join(id);
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            directory.join(format!("{id}.json")),
            json!({"inheritsFrom":parent}).to_string(),
        )
        .unwrap();
    }
    assert!(versions::resolve(temp.path(), "a").is_err());
    assert!(versions::resolve(temp.path(), "escape").is_err());
}
#[test]
fn platform_rules_apply_last_matching_rule_and_features() {
    let features = HashMap::from([("has_custom_resolution".into(), true)]);
    assert!(versions::rules_allow(
        &json!([{"action":"allow"}]),
        &features
    ));
    assert!(!versions::rules_allow(
        &json!([{"action":"allow"},{"action":"disallow","os":{"name":versions::os_name()}}]),
        &features
    ));
    assert!(!versions::rules_allow(
        &json!([{"action":"allow","features":{"is_demo_user":true}}]),
        &features
    ));
    assert!(versions::rules_allow(
        &json!([{"action":"allow","features":{"has_custom_resolution":true}}]),
        &features
    ));
}
#[test]
fn maven_classifiers_extensions_and_native_selection() {
    assert_eq!(
        versions::maven_path("net.test:lib:1.2:natives-windows@zip").unwrap(),
        "net/test/lib/1.2/lib-1.2-natives-windows.zip"
    );
    assert!(versions::maven_path("bad/../group:lib:1").is_err());
    let value = json!({"libraries":[{"name":"test:native:1","downloads":{"artifact":{"url":"https://example.org/lib.jar","path":"test/lib.jar"},"classifiers":{"natives-windows":{"url":"https://example.org/native.jar","path":"test/native.jar"}}},"natives":{"windows":"natives-windows"}}]});
    let libraries = versions::libraries(&value).unwrap();
    #[cfg(windows)]
    {
        assert_eq!(libraries.len(), 2);
        assert!(libraries[1].native);
    }
}
#[test]
fn launch_arguments_keep_spaces_and_legacy_backslashes_without_shell() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("game with spaces");
    fs::create_dir_all(root.join("versions/test")).unwrap();
    fs::write(root.join("versions/test/test.jar"), b"fixture").unwrap();
    let settings = Settings {
        jvm_args_enabled: true,
        jvm_args: r#"-Dpath="C:\My Games\data" -Dflag=1"#.into(),
        ..Settings::default()
    };
    let version = json!({"id":"test","mainClass":"net.minecraft.Main","arguments":{"game":["--username","${auth_player_name}","--gameDir","${game_directory}",{"rules":[{"action":"allow","features":{"is_demo_user":true}}],"value":"--demo"}]}});
    let args = arguments::build(
        &root,
        "test",
        &version,
        &settings,
        &Identity {
            name: "Player",
            uuid: "uuid",
            access_token: "secret",
            online: true,
        },
        4096,
    )
    .unwrap();
    assert!(args.contains(&r"-Dpath=C:\My Games\data".into()));
    assert!(args.contains(&"-Xmx4096m".into()));
    assert!(args
        .iter()
        .any(|s| s.contains("game with spaces") && !s.contains('"')));
    assert!(!args.contains(&"--demo".into()));
    assert!(arguments::split_args("--bad \"unclosed").is_err());
}
#[test]
fn detects_legacy_and_modern_java_versions() {
    assert_eq!(
        java::parse_version("java version \"1.8.0_421\"").unwrap().1,
        8
    );
    assert_eq!(
        java::parse_version("openjdk version \"21.0.4\" 2024-07-16")
            .unwrap()
            .1,
        21
    );
    assert_eq!(java::parse_version("openjdk 25 2025-09-16").unwrap().1, 25);
}
#[test]
fn rename_preserves_worlds_and_renames_client() {
    let temp = tempfile::tempdir().unwrap();
    let old = temp.path().join("versions/old");
    fs::create_dir_all(old.join("saves/MyWorld")).unwrap();
    fs::write(
        old.join("old.json"),
        json!({"id":"old","jar":"old"}).to_string(),
    )
    .unwrap();
    fs::write(old.join("old.jar"), b"client").unwrap();
    fs::write(old.join("saves/MyWorld/level.dat"), b"world").unwrap();
    versions::set_favorite(temp.path(), "old", true).unwrap();
    versions::rename(temp.path(), "old", "new").unwrap();
    assert!(temp.path().join("versions/new/new.jar").exists());
    assert!(temp
        .path()
        .join("versions/new/saves/MyWorld/level.dat")
        .exists());
    assert_eq!(versions::resolve(temp.path(), "new").unwrap()["jar"], "new");
    assert!(versions::scan(temp.path()).unwrap()[0].favorite);
}

#[test]
fn favorites_persist_per_game_directory_and_can_be_removed() {
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    for root in [first.path(), second.path()] {
        let directory = root.join("versions/game");
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            directory.join("game.json"),
            json!({"id":"game"}).to_string(),
        )
        .unwrap();
    }
    assert!(!versions::scan(first.path()).unwrap()[0].favorite);
    versions::set_favorite(first.path(), "game", true).unwrap();
    assert!(versions::scan(first.path()).unwrap()[0].favorite);
    assert!(!versions::scan(second.path()).unwrap()[0].favorite);
    versions::set_favorite(first.path(), "game", false).unwrap();
    versions::set_favorite(first.path(), "game", false).unwrap();
    assert!(!versions::scan(first.path()).unwrap()[0].favorite);
    assert!(versions::set_favorite(first.path(), "missing", true).is_err());
    assert!(versions::set_favorite(first.path(), "../escape", true).is_err());
}

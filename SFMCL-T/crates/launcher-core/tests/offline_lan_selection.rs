use serde_json::json;
use sfmcl_t_core::{
    config::{ConfigStore, GameDirectory},
    minecraft::{
        version_settings::{self, GameSettingGroups, GameSettings, VersionSettings},
        versions,
    },
};
use std::{fs, path::Path};

fn write_version(root: &Path, id: &str, libraries: &[&str]) {
    let directory = root.join("versions").join(id);
    fs::create_dir_all(&directory).unwrap();
    fs::write(
        directory.join(format!("{id}.json")),
        serde_json::to_vec(&json!({
            "id": id,
            "clientVersion": "1.21.4",
            "mainClass": "net.minecraft.client.main.Main",
            "libraries": libraries.iter().map(|name| json!({"name": name})).collect::<Vec<_>>()
        }))
        .unwrap(),
    )
    .unwrap();
}

fn fixture() -> (tempfile::TempDir, ConfigStore) {
    let directory = tempfile::tempdir().unwrap();
    let store = ConfigStore::open(directory.path()).unwrap();
    store
        .update(|settings| {
            settings.active_dir = directory.path().to_string_lossy().into_owned();
            settings.game_dirs = vec![GameDirectory {
                name: "Test".into(),
                path: settings.active_dir.clone(),
            }];
            settings.active_version = "vanilla".into();
            settings.offline_lan = true;
        })
        .unwrap();
    let root = store.get().active_game_root().unwrap();
    for (id, libraries) in [
        ("vanilla", vec![]),
        ("vanilla-other", vec![]),
        ("optifine", vec!["optifine:OptiFine:1.21.4"]),
        ("fabric", vec!["net.fabricmc:fabric-loader:0.16.9"]),
        ("forge", vec!["net.minecraftforge:forge:1.21.4"]),
        ("neoforge", vec!["net.neoforged:neoforge:21.4"]),
        ("quilt", vec!["org.quiltmc:quilt-loader:0.26.0"]),
    ] {
        write_version(&root, id, &libraries);
    }
    (directory, store)
}

fn independent() -> VersionSettings {
    VersionSettings {
        use_global: false,
        independent_groups: Some(GameSettingGroups {
            advanced: true,
            ..Default::default()
        }),
        settings: GameSettings {
            offline_lan: true,
            jvm_args: "-Dpreserve=true".into(),
            ..Default::default()
        },
    }
}

#[test]
fn selecting_mod_loaders_without_a_room_disables_and_persists_global_offline_lan() {
    for id in ["fabric", "forge", "neoforge", "quilt"] {
        let (directory, store) = fixture();
        let selected = versions::select(&store, directory.path(), id, false).unwrap();
        assert_eq!(selected.active_version, id);
        assert!(!selected.offline_lan);
        assert!(
            !ConfigStore::open(directory.path())
                .unwrap()
                .get()
                .offline_lan
        );
    }
}

#[test]
fn changing_loaders_only_resets_the_new_versions_advanced_scope() {
    let (directory, store) = fixture();
    let root = store.get().active_game_root().unwrap();
    let original = independent();
    version_settings::save(&root, "vanilla", &original).unwrap();
    version_settings::save(&root, "fabric", &original).unwrap();
    versions::select(&store, directory.path(), "fabric", false).unwrap();
    let changed = version_settings::load(&root, "fabric", &store.get()).unwrap();
    assert!(!changed.settings.offline_lan);
    assert_eq!(changed.settings.jvm_args, original.settings.jvm_args);
    assert_eq!(
        json!(changed.independent_groups),
        json!(original.independent_groups)
    );
    assert!(store.get().offline_lan);
    assert_eq!(
        json!(version_settings::load(&root, "vanilla", &store.get()).unwrap()),
        json!(original)
    );
    versions::select(&store, directory.path(), "vanilla", false).unwrap();
    assert!(
        !version_settings::resolve(&root, "vanilla", &store.get())
            .unwrap()
            .offline_lan
    );
}

#[test]
fn existing_rooms_preserve_global_and_independent_offline_lan_settings() {
    let (directory, store) = fixture();
    let root = store.get().active_game_root().unwrap();
    version_settings::save(&root, "fabric", &independent()).unwrap();
    versions::select(&store, directory.path(), "forge", true).unwrap();
    assert!(store.get().offline_lan);
    versions::select(&store, directory.path(), "fabric", true).unwrap();
    assert_eq!(
        json!(version_settings::load(&root, "fabric", &store.get()).unwrap()),
        json!(independent())
    );
}

#[test]
fn unchanged_loaders_and_optifine_alone_preserve_the_enabled_switch() {
    let (directory, store) = fixture();
    for id in ["vanilla-other", "optifine", "vanilla"] {
        versions::select(&store, directory.path(), id, false).unwrap();
        assert!(store.get().offline_lan);
    }
    let root = store.get().active_game_root().unwrap();
    write_version(
        &root,
        "forge-optifine",
        &[
            "optifine:OptiFine:1.21.4",
            "net.minecraftforge:forge:1.21.4",
        ],
    );
    versions::select(&store, directory.path(), "forge-optifine", false).unwrap();
    assert!(!store.get().offline_lan);
    write_version(&root, "forge-other", &["net.minecraftforge:forge:1.21.4"]);
    store
        .update(|settings| settings.offline_lan = true)
        .unwrap();
    versions::select(&store, directory.path(), "forge-other", false).unwrap();
    assert!(store.get().offline_lan);
}

#[test]
fn loader_changes_are_detected_across_directories_with_the_same_version_id() {
    let (directory, store) = fixture();
    let other = directory.path().join("other-games");
    store
        .update(|settings| {
            settings.game_dirs.push(GameDirectory {
                name: "Other".into(),
                path: other.to_string_lossy().into_owned(),
            })
        })
        .unwrap();
    let root = store.get().registered_game_root(&other).unwrap();
    write_version(&root, "vanilla", &["net.fabricmc:fabric-loader:0.16.9"]);
    versions::select(&store, &other, "vanilla", false).unwrap();
    assert!(!store.get().offline_lan);
    store
        .update(|settings| settings.offline_lan = true)
        .unwrap();
    versions::select(&store, directory.path(), "vanilla", false).unwrap();
    assert!(!store.get().offline_lan);
}

#[test]
fn damaged_version_settings_are_preserved_and_abort_the_selection() {
    let (directory, store) = fixture();
    let root = store.get().active_game_root().unwrap();
    version_settings::save(&root, "fabric", &independent()).unwrap();
    let path = root.join("versions/fabric/.tmcl/settings.json");
    fs::write(&path, b"broken settings").unwrap();
    assert!(versions::select(&store, directory.path(), "fabric", false).is_err());
    assert_eq!(store.get().active_version, "vanilla");
    assert!(store.get().offline_lan);
    assert_eq!(fs::read(path).unwrap(), b"broken settings");
}

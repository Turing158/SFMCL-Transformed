use super::*;
use sfmcl_t_core::config::GameDirectory;

#[test]
fn lists_registered_directories_without_changing_the_active_selection() {
    let workspace = tempfile::tempdir().unwrap();
    let first = workspace.path().join("first");
    let second = workspace.path().join("second");
    let empty = workspace.path().join("empty");
    for directory in [&first, &second] {
        let folder = directory.join(".minecraft/versions/shared");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("shared.json"), r#"{"id":"shared"}"#).unwrap();
    }
    versions::set_favorite(&minecraft_root(&second), "shared", true).unwrap();
    let settings = Settings {
        active_dir: first.to_string_lossy().into_owned(),
        active_version: "shared".into(),
        isolation: true,
        game_dirs: [&first, &second, &empty]
            .into_iter()
            .map(|path| GameDirectory {
                name: path.file_name().unwrap().to_string_lossy().into_owned(),
                path: path.to_string_lossy().into_owned(),
            })
            .collect(),
        ..Settings::default()
    };
    let active = version_entries(&settings, &json!({})).unwrap();
    let other = version_entries(&settings, &json!({"directory": second})).unwrap();
    assert_eq!(active.len(), 1);
    assert_eq!(other.len(), 1);
    assert_eq!(active[0]["id"], other[0]["id"]);
    assert_ne!(active[0]["path"], other[0]["path"]);
    assert_eq!(active[0]["directory"], first.to_string_lossy().as_ref());
    assert_eq!(other[0]["directory"], second.to_string_lossy().as_ref());
    assert_eq!(active[0]["favorite"], false);
    assert_eq!(other[0]["favorite"], true);
    assert_eq!(other[0]["independentSettings"], false);
    assert_eq!(other[0]["isolation"], true);
    assert!(version_entries(&settings, &json!({"directory": empty}))
        .unwrap()
        .is_empty());
    assert!(version_entries(
        &settings,
        &json!({"directory": workspace.path().join("unregistered")})
    )
    .is_err());
    assert!(version_entries(&settings, &json!({"directory": 42})).is_err());
    assert_eq!(settings.active_dir, first.to_string_lossy());
    assert_eq!(settings.active_version, "shared");
}

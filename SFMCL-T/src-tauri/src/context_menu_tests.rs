use super::*;
use sfmcl_t_core::config::GameDirectory;

#[tokio::test]
async fn target_directory_keeps_same_name_favorites_and_resources_separate() {
    let workspace = tempfile::tempdir().unwrap();
    let first = workspace.path().join("first");
    let second = workspace.path().join("second");
    for directory in [&first, &second] {
        let folder = directory.join(".minecraft/versions/shared");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(
            folder.join("shared.json"),
            json!({"id":"shared"}).to_string(),
        )
        .unwrap();
        versions::set_favorite(&minecraft_root(directory), "shared", true).unwrap();
    }
    let runtime = Runtime::new(workspace.path().join("config")).unwrap();
    runtime
        .settings
        .save(Settings {
            active_dir: first.to_string_lossy().into_owned(),
            active_version: "shared".into(),
            isolation: true,
            game_dirs: vec![
                GameDirectory {
                    name: "first".into(),
                    path: first.to_string_lossy().into_owned(),
                },
                GameDirectory {
                    name: "second".into(),
                    path: second.to_string_lossy().into_owned(),
                },
            ],
            ..Settings::default()
        })
        .unwrap();
    let payload = json!({"directory":second,"id":"shared","versionId":"shared"});
    let root = runtime.target_root(&payload).unwrap();
    assert_eq!(root, minecraft_root(&second));
    assert!(favorite_entries(&runtime.settings.get())
        .unwrap()
        .iter()
        .all(|entry| entry["isolation"] == true));
    assert_eq!(
        runtime.resource_root(&payload).unwrap(),
        second.join(".minecraft/versions/shared")
    );
    versions::set_favorite(&root, "shared", false).unwrap();
    let favorites = versions::favorites(&runtime.settings.get());
    assert_eq!(favorites.len(), 1);
    assert_eq!(favorites[0].directory, first.to_string_lossy());
    assert_eq!(runtime.settings.get().active_dir, first.to_string_lossy());
    assert_eq!(runtime.settings.get().active_version, "shared");
    assert_eq!(
        runtime.target_root(&json!({})).unwrap(),
        minecraft_root(&first)
    );
    assert!(runtime
        .target_root(&json!({"directory":workspace.path().join("unregistered")}))
        .is_err());
    assert!(runtime.target_root(&json!({"directory":42})).is_err());
}

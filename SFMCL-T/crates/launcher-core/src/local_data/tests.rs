use super::*;
use crate::{
    config::Settings,
    vault::{Tokens, Vault},
};
use serde_json::json;
use std::io::Write;

fn profile(root: &Path) -> PathBuf {
    let root = root.join("原始数据");
    fs::create_dir_all(root.join("skins")).unwrap();
    fs::create_dir_all(root.join("downloads/cache")).unwrap();
    fs::create_dir_all(root.join("webview/empty")).unwrap();
    fs::write(
        root.join("settings.json"),
        serde_json::to_vec(&Settings::default()).unwrap(),
    )
    .unwrap();
    fs::write(root.join("skins/角色.png"), [0, 1, 2, 255]).unwrap();
    fs::write(root.join("downloads/cache/content.bin"), [3, 4, 5]).unwrap();
    fs::write(root.join("players.json"), serde_json::to_vec(&json!([{
        "uuid":"test", "name":"Alex", "online":false, "skin":root.join("skins/角色.png"), "slim":false
    }])).unwrap()).unwrap();
    Vault::open(&root)
        .unwrap()
        .put(
            "test",
            Tokens {
                access: "private-test-token".into(),
                refresh: "private-test-refresh".into(),
                expires_at: 0,
                client_token: String::new(),
                littleskin: None,
            },
        )
        .unwrap();
    root
}

#[test]
fn backup_round_trip_verifies_credentials_binary_data_and_empty_directories() {
    let temp = tempfile::tempdir().unwrap();
    let source = profile(temp.path());
    let zip = temp.path().join("backup.zip");
    let info = backup(&source, &zip).unwrap();
    assert_eq!(info.file_count, 5);
    assert_eq!(inspect_backup(&zip).unwrap().file_count, info.file_count);
    fs::write(source.join("skins/角色.png"), [9]).unwrap();
    fs::write(source.join("new-after-backup.txt"), "new").unwrap();
    let previous = restore(&source, &zip, &temp.path().join("control")).unwrap();
    assert_eq!(
        fs::read(source.join("skins/角色.png")).unwrap(),
        [0, 1, 2, 255]
    );
    assert!(source.join("webview/empty").is_dir());
    assert!(!source.join("new-after-backup.txt").exists());
    assert!(previous.join("new-after-backup.txt").is_file());
    assert_eq!(
        Vault::open(&source).unwrap().get("test").unwrap().access,
        "private-test-token"
    );
}

#[test]
fn migration_is_verified_persistent_and_remaps_only_internal_paths() {
    let temp = tempfile::tempdir().unwrap();
    let source = profile(temp.path());
    fs::write(
        source.join("downloads/task.json"),
        serde_json::to_vec(&json!({
            "files":[{"path":source.join("downloads/cache/content.bin")}],
            "external":temp.path().join("outside/file"), "url":"https://example.test/file"
        }))
        .unwrap(),
    )
    .unwrap();
    let target = absolute_path(&temp.path().join("新的数据")).unwrap();
    let default = temp.path().join("default/app-id");
    fs::create_dir_all(default.parent().unwrap()).unwrap();
    let control = control_directory(&default).unwrap();
    let key = location_key(Some(source.as_os_str()));
    let original = migrate(&source, &target, &control, &key).unwrap().unwrap();
    assert_eq!(original, absolute_path(&source).unwrap());
    let players: serde_json::Value =
        serde_json::from_slice(&fs::read(target.join("players.json")).unwrap()).unwrap();
    assert_eq!(players[0]["skin"], json!(target.join("skins/角色.png")));
    let task: serde_json::Value =
        serde_json::from_slice(&fs::read(target.join("downloads/task.json")).unwrap()).unwrap();
    assert_eq!(
        task["files"][0]["path"],
        json!(target.join("downloads/cache/content.bin"))
    );
    assert_eq!(task["external"], json!(temp.path().join("outside/file")));
    assert_eq!(task["url"], "https://example.test/file");
    assert_eq!(
        resolve_directory(&default, Some(source.as_os_str().to_owned())).unwrap(),
        target
    );
    remove_original(&original).unwrap();
    assert!(!source.exists());
    assert_eq!(
        resolve_directory(&default, Some(source.into_os_string())).unwrap(),
        target
    );
}

#[test]
fn migration_does_not_overwrite_existing_destinations_or_follow_nested_paths() {
    let temp = tempfile::tempdir().unwrap();
    let source = profile(temp.path());
    let target = temp.path().join("occupied");
    fs::create_dir(&target).unwrap();
    fs::write(target.join("keep"), "keep").unwrap();
    assert!(migrate(
        &source,
        &target,
        &temp.path().join("control"),
        &location_key(None)
    )
    .is_err());
    assert!(validate_destination(&source, &source.join("child"), OperationKind::Migrate).is_err());
    assert!(validate_destination(&source, temp.path(), OperationKind::Migrate).is_err());
    assert_eq!(fs::read_to_string(target.join("keep")).unwrap(), "keep");
    assert!(source.join("credentials.dat").is_file());
}

#[test]
fn restore_remaps_paths_from_a_different_original_profile() {
    let temp = tempfile::tempdir().unwrap();
    let source = profile(temp.path());
    let zip = temp.path().join("backup.zip");
    backup(&source, &zip).unwrap();
    let target = absolute_path(&temp.path().join("new-profile")).unwrap();
    fs::create_dir(&target).unwrap();
    fs::write(
        target.join("settings.json"),
        serde_json::to_vec(&Settings::default()).unwrap(),
    )
    .unwrap();
    restore(&target, &zip, &temp.path().join("control")).unwrap();
    let players: serde_json::Value =
        serde_json::from_slice(&fs::read(target.join("players.json")).unwrap()).unwrap();
    assert_eq!(players[0]["skin"], json!(target.join("skins/角色.png")));
}

fn handcrafted_zip(path: &Path, name: &str, checksum: &str) {
    let mut zip = zip::ZipWriter::new(File::create(path).unwrap());
    let options = zip::write::SimpleFileOptions::default();
    zip.start_file(format!("data/{name}"), options).unwrap();
    zip.write_all(b"abc").unwrap();
    zip.start_file("sfmcl-t-backup.json", options).unwrap();
    zip.write_all(
        &serde_json::to_vec(&json!({
            "format":"SFMCL-T-local-data", "version":1, "sourceDir":path.parent().unwrap(),
            "createdAt":0, "directories":[], "files":[{"path":name,"size":3,"sha256":checksum}]
        }))
        .unwrap(),
    )
    .unwrap();
    zip.finish().unwrap();
}

#[test]
fn corrupt_or_traversing_backups_never_replace_current_data() {
    let temp = tempfile::tempdir().unwrap();
    let source = profile(temp.path());
    let backup = temp.path().join("invalid.zip");
    for name in [
        "settings.json",
        "../escape",
        "C:/escape",
        "a//b",
        "a/./b",
        "CON.txt",
        "bad./file",
        ".sfmcl-t-profile.lock",
    ] {
        handcrafted_zip(&backup, name, "wrong-checksum");
        assert!(restore(&source, &backup, &temp.path().join("control")).is_err());
        assert_eq!(
            fs::read(source.join("skins/角色.png")).unwrap(),
            [0, 1, 2, 255]
        );
        assert!(!temp.path().join("escape").exists());
    }
}

#[test]
fn empty_or_unrecognized_archives_are_rejected_before_commit() {
    let temp = tempfile::tempdir().unwrap();
    let source = profile(temp.path());
    let backup = temp.path().join("invalid.zip");
    fs::write(&backup, b"not a zip").unwrap();
    assert!(restore(&source, &backup, &temp.path().join("control")).is_err());
    fs::write(source.join("settings.json"), b"invalid json").unwrap();
    assert!(super::backup(&source, &temp.path().join("new.zip")).is_err());
    assert!(!temp.path().join("new.zip").exists());
}

#[test]
fn interrupted_restore_recovers_the_original_before_startup() {
    let temp = tempfile::tempdir().unwrap();
    let source = profile(temp.path());
    let previous = temp.path().join("SFMCL-T-before-restore-test");
    let stage = temp.path().join(".sfmcl-t-restore-test");
    let control = temp.path().join("control");
    fs::create_dir(&control).unwrap();
    fs::create_dir(&stage).unwrap();
    fs::rename(&source, &previous).unwrap();
    fs::write(
        control.join("restore-journal.json"),
        serde_json::to_vec(&json!({"source":source,"previous":previous,"stage":stage})).unwrap(),
    )
    .unwrap();
    recover_restore(&control).unwrap();
    assert!(source.join("credentials.dat").is_file());
    assert!(!stage.exists());
    assert!(!control.join("restore-journal.json").exists());
}

#[test]
fn exclusive_profile_lock_prevents_two_instances_and_is_not_backed_up() {
    let temp = tempfile::tempdir().unwrap();
    let source = profile(temp.path());
    let lock = lock_profile(&source).unwrap();
    assert!(lock_profile(&source).is_err());
    let info = backup(&source, &temp.path().join("backup.zip")).unwrap();
    assert_eq!(info.file_count, 5);
    drop(lock);
    assert!(lock_profile(&source).is_ok());
}

#[cfg(windows)]
#[test]
fn linked_entries_and_linked_destination_ancestors_are_rejected() {
    let temp = tempfile::tempdir().unwrap();
    let source = profile(temp.path());
    let outside = temp.path().join("outside");
    fs::create_dir(&outside).unwrap();
    let link = source.join("linked");
    let status = std::process::Command::new("cmd")
        .args(["/c", "mklink", "/J"])
        .arg(&link)
        .arg(&outside)
        .stdout(std::process::Stdio::null())
        .status()
        .unwrap();
    assert!(status.success());
    assert!(backup(&source, &temp.path().join("backup.zip")).is_err());
    assert!(absolute_path(&link.join("new")).is_err());
    fs::remove_dir(link).unwrap();
}

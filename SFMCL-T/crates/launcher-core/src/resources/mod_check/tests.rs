use super::*;
use crate::resources::local::{batch_mods, scan, ModBatchAction};
use serde_json::json;
use std::io::Write;

fn jar_bytes(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut jar = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes) in entries {
        jar.start_file(*name, zip::write::SimpleFileOptions::default())
            .unwrap();
        jar.write_all(bytes).unwrap();
    }
    jar.finish().unwrap().into_inner()
}

fn write_jar(game: &Path, relative: &str, entries: &[(&str, &[u8])]) -> PathBuf {
    let path = game.join(relative);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, jar_bytes(entries)).unwrap();
    path
}

fn fabric(game: &Path, path: &str, metadata: &Value) -> PathBuf {
    write_jar(
        game,
        path,
        &[("fabric.mod.json", metadata.to_string().as_bytes())],
    )
}

fn profile(library: &str) -> Value {
    json!({"libraries": [{"name": library}]})
}

#[test]
fn finds_renamed_duplicates_mismatches_and_required_dependencies_then_passes_after_batch() {
    let scratch = tempfile::tempdir().unwrap();
    let game = scratch.path();
    fabric(
        game,
        "mods/ui.jar",
        &json!({
            "id": "ui",
            "depends": {"minecraft": "*", "java": "*", "fabricloader": "*", "library": "*"},
            "recommends": {"optional": "*"}
        }),
    );
    let duplicate = fabric(game, "mods/renamed.jar", &json!({"id": "ui"}));
    fabric(
        game,
        "mods/dedicated.jar",
        &json!({
            "id": "ui", "environment": "server", "depends": {"server_lib": "*"}
        }),
    );
    let library = fabric(
        game,
        "mods/base.jar.DISABLED",
        &json!({
            "id": "base", "provides": ["library"]
        }),
    );
    fabric(game, "mods/.disabled/old.jar", &json!({"id": "ui"}));
    let wrong_loader = write_jar(
        game,
        "mods/forge.jar",
        &[("META-INF/mods.toml", b"[[mods]]\nmodId = 'forge_mod'\n")],
    );
    let fabric_profile = profile("net.fabricmc:fabric-loader:0.16.9");
    let error = check_directory(game, &fabric_profile, true)
        .unwrap_err()
        .to_string();
    assert!(error.contains("发现 3 项问题"), "{error}");
    for message in [
        "重复模组：ui",
        "renamed.jar、ui.jar",
        "加载器不匹配：forge.jar",
        "缺少依赖：ui.jar 需要 library",
    ] {
        assert!(error.contains(message), "{error}");
    }
    assert_eq!(
        batch_mods(game, vec![duplicate, wrong_loader], ModBatchAction::Disable).len(),
        2
    );
    batch_mods(game, vec![library], ModBatchAction::Enable);
    check_directory(game, &fabric_profile, true).unwrap();
    assert!(game.join("mods/base.jar").is_file());
    assert!(game.join("mods/.disabled/renamed.jar").is_file());
}

#[test]
fn checks_neoforge_and_forge_toml_multiple_ids_and_client_dependencies() {
    let scratch = tempfile::tempdir().unwrap();
    let game = scratch.path();
    let neo = profile("net.neoforged:neoforge:21.1.1");
    let forge = profile("net.minecraftforge:forge:1.20.1-47.3.0");
    let metadata = b"
[[mods]]
modId = 'first'
[[mods]]
modId = 'second'
[[dependencies.first]]
modId = 'minecraft'
type = 'required'
[[dependencies.first]]
modId = 'server_lib'
type = 'required'
side = 'SERVER'
[[dependencies.first]]
modId = 'optional'
type = 'optional'
[[dependencies.second]]
modId = 'client_lib'
type = 'required'
side = 'CLIENT'
";
    write_jar(
        game,
        "mods/neo.jar",
        &[("META-INF/neoforge.mods.toml", metadata)],
    );
    let forge_metadata = b"[[mods]]\nmodId = 'forge_mod'\n[[dependencies.forge_mod]]\nmodId = 'forge'\nmandatory = true\n";
    write_jar(
        game,
        "mods/forge.jar",
        &[("META-INF/mods.toml", forge_metadata)],
    );
    let error = check_directory(game, &neo, true).unwrap_err().to_string();
    assert!(error.contains("发现 2 项问题"), "{error}");
    assert!(error.contains("加载器不匹配：forge.jar"));
    assert!(error.contains("缺少依赖：neo.jar 需要 client_lib"));
    let error = check_directory(game, &forge, true).unwrap_err().to_string();
    assert!(error.contains("发现 1 项问题"), "{error}");
    assert!(error.contains("加载器不匹配：neo.jar"));
}

#[test]
fn supports_quilt_alternatives_and_bundled_fabric_providers() {
    let scratch = tempfile::tempdir().unwrap();
    let game = scratch.path();
    let nested = jar_bytes(&[(
        "fabric.mod.json",
        br#"{"id":"nested","provides":["virtual"]}"#,
    )]);
    write_jar(game, "mods/bundle.jar", &[
        ("fabric.mod.json", br#"{"id":"bundle","depends":{"virtual":"*","fabricloader":"*"},"jars":[{"file":"META-INF/jars/nested.jar"}]}"#),
        ("META-INF/jars/nested.jar", &nested),
    ]);
    write_jar(game, "mods/quilt.jar", &[(
        "quilt.mod.json",
        br#"{"quilt_loader":{"id":"quiltmod","depends":[["nope","virtual"],{"id":"extra","unless":{"id":"bundle"}},{"id":"optional","optional":true},"quilt_loader"]}}"#,
    )]);
    let quilt = profile("org.quiltmc:quilt-loader:0.28.0");
    check_directory(game, &quilt, true).unwrap();
    let vanilla = json!({});
    let error = check_directory(game, &vanilla, true)
        .unwrap_err()
        .to_string();
    assert!(error.contains("当前是 Vanilla"), "{error}");
    check_directory(game, &vanilla, false).unwrap();
}

#[test]
fn batch_reports_partial_failures_without_overwriting_and_deletes_only_mods() {
    let scratch = tempfile::tempdir().unwrap();
    let game = scratch.path();
    let metadata = json!({"id":"mod"});
    let existing = fabric(game, "mods/conflict.jar", &metadata);
    let blocked = fabric(game, "mods/.disabled/conflict.jar", &json!({"id":"other"}));
    let available = fabric(game, "mods/.disabled/available.jar", &metadata);
    let outside = fabric(game, "resourcepacks/not-a-mod.jar", &metadata);
    let data = fs::read(&existing).unwrap();
    let enabled = batch_mods(
        game,
        vec![blocked.clone(), available.clone(), available],
        ModBatchAction::Enable,
    );
    let enabled = serde_json::to_value(enabled).unwrap();
    assert_eq!(enabled.as_array().unwrap().len(), 2);
    assert_eq!(enabled[0]["error"], "目标位置已有同名模组");
    assert_eq!(
        Path::new(enabled[1]["renamedTo"].as_str().unwrap()),
        game.join("mods/available.jar")
    );
    assert_eq!(fs::read(&existing).unwrap(), data);
    assert!(blocked.is_file());
    let results = batch_mods(
        game,
        vec![outside.clone(), existing, blocked],
        ModBatchAction::Delete,
    );
    let results = serde_json::to_value(results).unwrap();
    assert!(results[0]["error"].is_string());
    assert!(results[1]["error"].is_null());
    assert!(results[2]["error"].is_null());
    assert!(outside.is_file());
    assert_eq!(scan(game, "mod").unwrap().len(), 1);
}

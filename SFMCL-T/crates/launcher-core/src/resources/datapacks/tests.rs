use super::*;
use crate::{config::GameDirectory, downloads::Status, minecraft::quick_play};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

struct Fixture {
    _temp: tempfile::TempDir,
    directory: PathBuf,
    root: PathBuf,
    state: Arc<ConfigStore>,
    jobs: Arc<Jobs>,
}

impl Fixture {
    fn new() -> Self {
        let parent = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/tmp/datapack-tests");
        fs::create_dir_all(&parent).unwrap();
        let temp = tempfile::tempdir_in(parent).unwrap();
        let directory = temp.path().join("game");
        let root = directory.join(".minecraft");
        for version in ["one", "two"] {
            atomic_write(
                &root.join(format!("versions/{version}/{version}.json")),
                br#"{"id":"1.21.4","libraries":[]}"#,
            )
            .unwrap();
        }
        let state = Arc::new(ConfigStore::open(&temp.path().join("state")).unwrap());
        state
            .update(|settings| {
                settings.active_dir = directory.to_string_lossy().into_owned();
                settings.game_dirs = vec![GameDirectory {
                    name: "test".into(),
                    path: settings.active_dir.clone(),
                }];
                settings.isolation = true;
            })
            .unwrap();
        Self {
            _temp: temp,
            directory,
            root,
            state,
            jobs: Arc::new(Jobs::default()),
        }
    }

    fn target(&self, version: &str, world: &str) -> Result<Target> {
        Target::resolve(
            &self.state.get(),
            WorldSelection {
                directory: self.directory.clone(),
                version_id: version.into(),
                world_id: world.into(),
            },
        )
    }

    fn add_world(&self, version: Option<&str>, id: &str) -> PathBuf {
        let game = version
            .map(|id| self.root.join("versions").join(id))
            .unwrap_or_else(|| self.root.clone());
        let world = game.join("saves").join(id);
        let value = serde_json::json!({
            "Data": {
                "LevelName": "同名世界",
                "Version": { "Name": "1.21.4" },
                "DataPacks": { "Enabled": ["vanilla","file/another.zip"], "Disabled": ["file/old.zip"] }
            }
        });
        let encoded = fastnbt::to_bytes(&value).unwrap();
        let mut typed: Compound = fastnbt::from_bytes(&encoded).unwrap();
        typed.insert(
            "untouched".into(),
            Value::LongArray(fastnbt::LongArray::new(vec![i64::MAX, -30])),
        );
        let options = fastnbt::SerOpts::new().root_name("验收");
        let nbt = fastnbt::to_bytes_with_opts(&typed, options).unwrap();
        let mut gzip = GzEncoder::new(Vec::new(), Compression::default());
        gzip.write_all(&nbt).unwrap();
        atomic_write(&world.join("level.dat"), &gzip.finish().unwrap()).unwrap();
        world
    }

    fn import(&self, target: &Target, path: &Path) -> Result<bool> {
        install_file(
            target,
            &self.state,
            &self.jobs,
            path,
            &CancellationToken::new(),
        )
    }
}

fn make_zip(entry: &str, description: &str) -> Vec<u8> {
    let mut writer = zip::ZipWriter::new(io::Cursor::new(Vec::new()));
    writer
        .start_file(entry, zip::write::SimpleFileOptions::default())
        .unwrap();
    write!(
        writer,
        r#"{{"pack":{{"pack_format":61,"description":"{description}"}}}}"#
    )
    .unwrap();
    writer.finish().unwrap().into_inner()
}

#[test]
fn targets_isolated_and_shared_worlds_and_refuses_wrong_or_replaced_targets() {
    let fixture = Fixture::new();
    let original = fixture.add_world(Some("one"), "A");
    fixture.add_world(Some("two"), "A");
    fixture.add_world(Some("one"), "B");
    let one = fixture.target("one", "A").unwrap();
    let two = fixture.target("two", "A").unwrap();
    assert_ne!(one.world, two.world);
    let worlds = quick_play::worlds(&one.game).unwrap();
    assert_eq!(
        worlds
            .iter()
            .map(|world| world.id.as_str())
            .collect::<Vec<_>>(),
        ["A", "B"]
    );
    assert!(worlds
        .iter()
        .all(|world| world.name == "同名世界" && world.version == "1.21.4"));
    assert!(fixture.target("two", "B").is_err());
    assert!(fixture.target("one", "../A").is_err());
    fs::rename(&original, original.with_file_name("renamed")).unwrap();
    let replacement = fixture.add_world(Some("one"), "A");
    let source = fixture.directory.join("test.zip");
    fs::write(&source, make_zip("pack.mcmeta", "test")).unwrap();
    assert!(fixture.import(&one, &source).is_err());
    assert!(!replacement.join("datapacks").exists());
    assert!(fixture.import(&two, &source).unwrap());
    assert!(two.world.join("datapacks/test.zip").is_file());
    let shared = fixture.add_world(None, "A");
    fixture
        .state
        .update(|settings| settings.isolation = false)
        .unwrap();
    assert!(two.check(&fixture.state.get()).is_err());
    assert_eq!(fixture.target("one", "A").unwrap().world, shared);
    assert_eq!(fixture.target("two", "A").unwrap().world, shared);
}

#[test]
fn manages_zip_and_directory_packs_and_preserves_level_dat_types_and_order() {
    let fixture = Fixture::new();
    let world = fixture.add_world(Some("one"), "A");
    let target = fixture.target("one", "A").unwrap();
    let folder = target.folder().unwrap();
    let source = fixture.directory.join("test.zip");
    let first = make_zip("pack.mcmeta", "Testing");
    fs::write(&source, &first).unwrap();
    let original = LevelData::read(&world).unwrap();

    assert!(list(&target).unwrap().packs.is_empty());
    assert!(fixture.import(&target, &source).unwrap());
    assert!(!fixture.import(&target, &source).unwrap());
    fs::write(&source, make_zip("pack.mcmeta", "Changed")).unwrap();
    assert!(fixture
        .import(&target, &source)
        .unwrap_err()
        .to_string()
        .contains("同名"));
    assert_eq!(fs::read(folder.join("test.zip")).unwrap(), first);
    let invalid = fixture.directory.join("nested.zip");
    fs::write(&invalid, make_zip("nested/pack.mcmeta", "Bad")).unwrap();
    assert!(fixture.import(&target, &invalid).is_err());
    assert!(!folder.join("nested.zip").exists());
    atomic_write(
        &folder.join("directory/pack.mcmeta"),
        br#"{"pack":{"min_format":[94,1],"max_format":95,"description":"Directory"}}"#,
    )
    .unwrap();
    fs::create_dir(folder.join("empty")).unwrap();
    let packs = list(&target).unwrap().packs;
    assert_eq!(
        packs
            .iter()
            .map(|pack| (&pack.name[..], pack.directory))
            .collect::<Vec<_>>(),
        [("directory", true), ("test.zip", false)]
    );
    assert!(packs
        .iter()
        .all(|pack| pack.state == PackState::Pending && pack.error.is_none()));

    let session = lock_world(&world).unwrap();
    assert!(edit(
        &target,
        &fixture.state.get(),
        &fixture.jobs,
        "test.zip",
        Edit::Enable
    )
    .unwrap_err()
    .to_string()
    .contains("正在使用"));
    assert_eq!(
        fs::read(world.join("level.dat")).unwrap(),
        original.original
    );
    drop(session);

    edit(
        &target,
        &fixture.state.get(),
        &fixture.jobs,
        "test.zip",
        Edit::Enable,
    )
    .unwrap();
    let edited = LevelData::read(&world).unwrap();
    let (enabled, disabled) = edited.statuses().unwrap();
    assert_eq!(
        enabled,
        [
            Value::String("vanilla".into()),
            pack_id("another.zip"),
            pack_id("test.zip")
        ]
    );
    assert_eq!(disabled, [pack_id("old.zip")]);
    assert_eq!(edited.root["untouched"], original.root["untouched"]);
    assert_eq!(edited.root_name, original.root_name);
    assert!(edited.gzip);
    assert_eq!(
        fs::read(world.join(".tmcl/level.dat.datapacks.bak")).unwrap(),
        original.original
    );
    edit(
        &target,
        &fixture.state.get(),
        &fixture.jobs,
        "test.zip",
        Edit::Disable,
    )
    .unwrap();
    edit(
        &target,
        &fixture.state.get(),
        &fixture.jobs,
        "directory",
        Edit::Enable,
    )
    .unwrap();
    let packs = list(&target).unwrap().packs;
    assert!(packs[0].state == PackState::Enabled && packs[1].state == PackState::Disabled);
    edit(
        &target,
        &fixture.state.get(),
        &fixture.jobs,
        "directory",
        Edit::Delete,
    )
    .unwrap();
    edit(
        &target,
        &fixture.state.get(),
        &fixture.jobs,
        "test.zip",
        Edit::Delete,
    )
    .unwrap();
    assert!(list(&target).unwrap().packs.is_empty());
    assert!(folder.join("empty").is_dir());
    let final_level = LevelData::read(&world).unwrap();
    assert_eq!(final_level.root, original.root);
}

#[test]
fn reports_invalid_world_metadata_without_replacing_it() {
    let fixture = Fixture::new();
    let world = fixture.add_world(Some("one"), "A");
    let target = fixture.target("one", "A").unwrap();
    let source = fixture.directory.join("test.zip");
    fs::write(&source, make_zip("pack.mcmeta", "valid")).unwrap();
    assert!(fixture.import(&target, &source).unwrap());
    fs::write(world.join("level.dat"), b"invalid NBT").unwrap();
    let inventory = list(&target).unwrap();
    assert!(inventory.state_error.is_some());
    assert!(inventory.packs[0].state == PackState::Unknown);
    assert!(edit(
        &target,
        &fixture.state.get(),
        &fixture.jobs,
        "test.zip",
        Edit::Delete
    )
    .is_err());
    assert!(target.folder().unwrap().join("test.zip").is_file());
    assert_eq!(fs::read(world.join("level.dat")).unwrap(), b"invalid NBT");
}

async fn finished(jobs: &Jobs, id: &str) -> crate::jobs::JobSnapshot {
    let job = jobs.get(id).unwrap();
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let snapshot = job.snapshot();
            if snapshot.status.terminal() {
                return snapshot;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn queued_download_validates_hash_and_never_commits_to_a_recreated_world() {
    use axum::{routing::get, Router};
    use tokio::sync::Notify;

    let fixture = Fixture::new();
    let world = fixture.add_world(Some("one"), "A");
    let bytes = make_zip("pack.mcmeta", "Online");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let response = bytes.clone();
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new().route("/pack.zip", get(move || async { response })),
        )
        .await
        .unwrap();
    });
    let data = fixture.directory.join("task-data");
    fs::create_dir(&data).unwrap();
    let downloads = DownloadManager::open(&data, 1).unwrap();
    let work_root = fixture.directory.join("staging");
    fs::create_dir(&work_root).unwrap();
    let file = DownloadSpec {
        url: format!("http://{address}/pack.zip"),
        path: "pack.zip".into(),
        sha1: None,
        sha512: Some(hex::encode(sha2::Sha512::digest(&bytes))),
        size: Some(bytes.len() as u64),
    };
    let start = |resolver| {
        enqueue(
            fixture.target("one", "A").unwrap(),
            file.clone(),
            "test".into(),
            &work_root,
            resolver,
            downloads.clone(),
            fixture.jobs.clone(),
            fixture.state.clone(),
        )
        .unwrap()
    };
    let valid = start(Arc::new(|url| Box::pin(async { Ok(url) })));
    let result = finished(&fixture.jobs, &valid).await;
    assert_eq!(result.status, Status::Completed, "{:?}", result.error);
    assert_eq!(result.datapack_world.as_deref(), Some(world.as_path()));
    assert_eq!(fs::read(world.join("datapacks/pack.zip")).unwrap(), bytes);

    let resume = Arc::new(Notify::new());
    let resolve = resume.clone();
    let changed = start(Arc::new(move |url| {
        let resolve = resolve.clone();
        Box::pin(async move {
            resolve.notified().await;
            Ok(url)
        })
    }));
    fs::rename(&world, world.with_file_name("renamed")).unwrap();
    let replacement = fixture.add_world(Some("one"), "A");
    resume.notify_one();
    let result = finished(&fixture.jobs, &changed).await;
    assert_eq!(result.status, Status::Failed);
    assert!(result.error.unwrap().contains("已变化"));
    assert!(!replacement.join("datapacks").exists());
    assert!(downloads.snapshots().await.is_empty());
    server.abort();
}

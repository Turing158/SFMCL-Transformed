use super::*;
use sha1::{Digest, Sha1};
use std::io::Read;

pub const RECORD: &str = ".tmcl/modpack-install.json";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallRecord {
    pub schema: u32,
    pub instance_id: String,
    pub format: String,
    pub name: String,
    pub version: String,
    pub minecraft: String,
    pub loader: Option<Value>,
    pub origin: Option<Origin>,
    pub include_optional: bool,
    pub files: BTreeMap<String, String>,
    #[serde(default)]
    pub optional_files: BTreeSet<String>,
}

pub fn personal(path: &str) -> bool {
    let lower = path.to_lowercase();
    let first = lower.split('/').next().unwrap_or("");
    ["saves", "screenshots", "logs", "crash-reports", ".tmcl"].contains(&first)
        || [
            "options.txt",
            "optionsof.txt",
            "servers.dat",
            "servers.dat_old",
            "icon.png",
            "usercache.json",
            "session.lock",
        ]
        .contains(&lower.as_str())
        || lower.starts_with("options") && lower.ends_with(".txt")
}

pub fn runtime(path: &str, id: &str) -> bool {
    path.eq_ignore_ascii_case(&format!("{id}.json"))
        || path.eq_ignore_ascii_case(&format!("{id}.jar"))
        || path.starts_with("natives/")
        || path.starts_with("assets/")
        || path.starts_with("libraries/")
}

pub fn hash(path: &Path, cancel: &CancellationToken) -> Result<Option<String>> {
    if !path.exists() {
        return Ok(None);
    }
    if !path.is_file() {
        bail!("文件目标被目录占用：{}", path.display());
    }
    let mut input = std::fs::File::open(path)?;
    let mut digest = Sha1::new();
    let mut buffer = [0u8; 128 * 1024];
    loop {
        archive::check_cancel(cancel)?;
        let count = input.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(Some(hex::encode(digest.finalize())))
}

/// Enumerate without following reparse points. Personal directories are skipped
/// before descending, so checking a pack never hashes an entire saved world.
pub fn files(
    root: &Path,
    include_personal: bool,
    cancel: &CancellationToken,
) -> Result<Vec<String>> {
    let mut pending = vec![root.to_path_buf()];
    let mut files = vec![];
    while let Some(directory) = pending.pop() {
        for entry in std::fs::read_dir(&directory)? {
            archive::check_cancel(cancel)?;
            let entry = entry?;
            let relative = entry
                .path()
                .strip_prefix(root)?
                .to_string_lossy()
                .replace('\\', "/");
            let relative = if cfg!(windows) {
                relative.to_lowercase()
            } else {
                relative
            };
            if !include_personal && personal(&relative) {
                continue;
            }
            let path = safe_join(root, &relative)?;
            let kind = entry.file_type()?;
            if kind.is_dir() {
                pending.push(path);
            } else if kind.is_file() {
                files.push(relative);
            } else {
                bail!("实例包含链接或特殊文件：{relative}");
            }
            if files.len() + pending.len() > 100_000 {
                bail!("实例文件过多");
            }
        }
    }
    files.sort();
    Ok(files)
}

pub fn snapshot(root: &Path, cancel: &CancellationToken) -> Result<BTreeMap<String, String>> {
    files(root, false, cancel)?
        .into_iter()
        .map(|path| {
            let hash = hash(&safe_join(root, &path)?, cancel)?.context("文件在检查期间被删除")?;
            Ok((path, hash))
        })
        .collect()
}

pub fn read(instance: &Path) -> Result<Option<InstallRecord>> {
    let path = safe_join(instance, RECORD)?;
    if !path.exists() {
        return Ok(None);
    }
    let record: InstallRecord = serde_json::from_value(parser::read_json(&path)?)?;
    if record.schema != 1 {
        bail!("不支持此整合包安装记录版本");
    }
    valid_name(&record.instance_id)?;
    let mut paths = HashSet::new();
    for (path, hash) in &record.files {
        super::super::reserved(path, "__record__")?;
        if personal(path)
            || hash.len() != 40
            || !hash.bytes().all(|b| b.is_ascii_hexdigit())
            || !paths.insert(path.to_lowercase())
        {
            bail!("整合包安装记录包含无效文件");
        }
    }
    if !record
        .optional_files
        .iter()
        .all(|path| record.files.contains_key(path))
    {
        bail!("整合包可选文件记录无效");
    }
    Ok(Some(record))
}

pub fn record_install(
    instance: &Path,
    request: &ModpackRequest,
    info: &PackInfo,
    cancel: &CancellationToken,
    optional_paths: BTreeSet<String>,
) -> Result<()> {
    let files: BTreeMap<_, _> = snapshot(instance, cancel)?
        .into_iter()
        .filter(|(path, _)| !runtime(path, &request.name))
        .collect();
    let optional_files = optional_paths
        .into_iter()
        .filter(|path| files.contains_key(path))
        .collect();
    let record = InstallRecord {
        schema: 1,
        instance_id: uuid::Uuid::new_v4().to_string(),
        format: info.format.clone(),
        name: info.name.clone(),
        version: info.version.clone(),
        minecraft: info.minecraft.clone(),
        loader: info
            .loader
            .as_ref()
            .map(|l| json!({"kind":l.kind,"version":l.version})),
        origin: request.origin.clone(),
        include_optional: request.include_optional,
        files,
        optional_files,
    };
    atomic_write(
        &safe_join(instance, RECORD)?,
        &serde_json::to_vec_pretty(&record)?,
    )
}

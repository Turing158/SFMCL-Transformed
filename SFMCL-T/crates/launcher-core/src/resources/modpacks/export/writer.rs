use super::*;
use crate::jobs::Job;
use std::io::{Read, Write};
use zip::{write::SimpleFileOptions, ZipArchive, ZipWriter};

fn download_url(value: &str) -> Result<String> {
    let url = reqwest::Url::parse(value).context("下载地址无效")?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        bail!("请使用不含账号信息的 HTTPS 下载地址");
    }
    if url.query_pairs().any(|(key, _)| {
        matches!(
            key.to_lowercase().as_str(),
            "token" | "access_token" | "key" | "api_key" | "signature"
        )
    }) {
        bail!("不能把带有访问凭据的下载地址写入整合包");
    }
    Ok(url.into())
}

pub(super) fn manifest(
    target: &ExportTarget,
    files: &[HashedFile],
    draft: &ExportDraft,
    matches: &HashMap<String, crate::resources::install::Candidate>,
) -> Result<(Value, Vec<ExportPlanItem>, Vec<String>, HashSet<String>)> {
    let mut issues = vec![];
    let mut items = vec![];
    let mut entries = vec![];
    let mut direct = HashSet::new();
    let consent = draft.direct_paths.iter().cloned().collect::<HashSet<_>>();
    let downloads = draft
        .downloads
        .iter()
        .map(|v| (&v.path, &v.url))
        .collect::<HashMap<_, _>>();
    if downloads.len() != draft.downloads.len() {
        bail!("自定义下载地址存在重复文件");
    }
    let paths = files.iter().map(|f| &f.file.path).collect::<HashSet<_>>();
    if consent.iter().any(|p| !paths.contains(p)) || downloads.keys().any(|p| !paths.contains(*p)) {
        bail!("文件处理方式超出所选文件范围");
    }
    let mut ids = HashSet::new();
    for file in files {
        let path = &file.file.path;
        let candidate = matches.get(path).filter(|c| {
            c.file
                .sha1
                .as_deref()
                .is_some_and(|v| v.eq_ignore_ascii_case(&file.sha1))
        });
        let is_resource = resource_file(path);
        let mut item = ExportPlanItem {
            path: path.clone(),
            size: file.file.size,
            method: "embedded".into(),
            project: candidate.map(|v| v.project.clone()),
            version: candidate.map(|v| v.id.clone()),
            reason: "配置或自定义内容".into(),
        };
        if consent.contains(path) || !is_resource && !downloads.contains_key(path) {
            direct.insert(path.clone());
            if is_resource {
                item.reason = "直接包含已确认可分发的文件".into();
            }
        } else if draft.format == ExportFormat::Modrinth {
            let url = downloads
                .get(path)
                .map(|v| v.as_str())
                .or_else(|| candidate.map(|v| v.file.url.as_str()))
                .filter(|v| !v.is_empty());
            if let Some(url) = url {
                let url = download_url(url)?;
                entries.push(json!({"path":path,"hashes":{"sha1":file.sha1,"sha512":file.sha512},"env":{"client":"required","server":"unsupported"},"downloads":[url],"fileSize":file.file.size}));
                item.method = "reference".into();
                item.reason = if downloads.contains_key(path) {
                    "自定义下载地址，以本地文件哈希校验"
                } else {
                    "匹配到准确的平台文件"
                }
                .into();
            } else {
                item.method = "unresolved".into();
                item.reason =
                    "未找到可引用的准确版本，请确认直接打包、填写下载地址或取消选择".into();
                issues.push(format!("需要处理：{path}"));
            }
        } else if let Some(candidate) = candidate {
            let project: u64 = candidate
                .project
                .parse()
                .context("CurseForge 项目 ID 无效")?;
            let id: u64 = candidate.id.parse().context("CurseForge 文件 ID 无效")?;
            if project == 0 || id == 0 {
                bail!("CurseForge 文件 ID 无效");
            }
            // CurseForge cannot represent renamed files, duplicate copies, or custom destinations.
            if candidate.file.path == *path && ids.insert(id) {
                entries.push(json!({"projectID":project,"fileID":id,"required":true}));
                item.method = "reference".into();
                item.reason = "匹配到准确的 CurseForge 文件".into();
            } else {
                item.method = "unresolved".into();
                item.reason = "此路径无法通过 CurseForge 清单还原，请确认直接打包或取消选择".into();
                issues.push(format!("需要处理：{path}"));
            }
        } else {
            item.method = "unresolved".into();
            item.reason = "未匹配到 CurseForge 文件，请确认直接打包或取消选择".into();
            issues.push(format!("需要处理：{path}"));
        }
        items.push(item);
    }
    let options = &draft.options;
    let manifest = match draft.format {
        ExportFormat::Modrinth => {
            let mut dependencies = json!({"minecraft":target.minecraft});
            if let Some(loader) = &target.loader {
                let key = match loader.kind.as_str() {
                    "Fabric" => "fabric-loader",
                    "Quilt" => "quilt-loader",
                    "Forge" => "forge",
                    "NeoForge" => "neoforge",
                    _ => bail!("Modrinth 不支持该加载器"),
                };
                dependencies[key] = json!(loader.version);
            }
            json!({"formatVersion":1,"game":"minecraft","versionId":options.version,"name":options.name,"summary":options.summary,"files":entries,"dependencies":dependencies})
        }
        ExportFormat::Curseforge => {
            let mut loaders = vec![];
            if let Some(loader) = &target.loader {
                let prefix = match loader.kind.as_str() {
                    "Forge" => "forge",
                    "Fabric" => "fabric",
                    "NeoForge" => "neoforge",
                    "Quilt" => {
                        issues
                            .push("CurseForge 标准导出不支持 Quilt，请选择 Modrinth 格式。".into());
                        "quilt"
                    }
                    _ => bail!("CurseForge 不支持该加载器"),
                };
                loaders.push(json!({"id":format!("{prefix}-{}",loader.version),"primary":true}));
            }
            json!({"minecraft":{"version":target.minecraft,"modLoaders":loaders},"manifestType":"minecraftModpack","manifestVersion":1,"name":options.name,"version":options.version,"author":options.author,"files":entries,"overrides":"overrides"})
        }
    };
    if serde_json::to_vec(&manifest)?.len() as u64 > super::super::archive::MAX_METADATA {
        bail!("整合包清单超过支持的大小");
    }
    Ok((manifest, items, issues, direct))
}

pub(super) fn destination(path: &Path, plan: &PreparedPlan, overwrite: bool) -> Result<()> {
    if !path.is_absolute()
        || path.extension().and_then(|v| v.to_str()) != Some(plan.draft.format.extension())
    {
        bail!("请选择正确扩展名的整合包保存路径");
    }
    for ancestor in path.ancestors() {
        if let Ok(meta) = std::fs::symlink_metadata(ancestor) {
            if meta.file_type().is_symlink() {
                bail!("保存路径包含符号链接");
            }
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if meta.file_attributes() & 0x400 != 0 {
                    bail!("保存路径包含目录联接或重解析点");
                }
            }
        }
    }
    let parent = path.parent().context("保存位置无效")?;
    let parent = parent.canonicalize().context("保存文件夹不存在")?;
    if parent.starts_with(plan.target.root.canonicalize()?)
        || parent.starts_with(plan.target.game.canonicalize()?)
    {
        bail!("请将整合包保存到游戏目录以外的文件夹");
    }
    if path.exists() && (!overwrite || !path.is_file()) {
        bail!("目标已存在，请选择其他文件名或确认覆盖");
    }
    Ok(())
}

pub(super) fn write(plan: &PreparedPlan, output: &Path, job: &Job, overwrite: bool) -> Result<()> {
    let check = || -> Result<()> {
        check_cancel(&job.cancel)?;
        check_cancel(&plan.cancel)
    };
    destination(output, plan, overwrite)?;
    // Use the same per-version lock as installation, without stopping user processes.
    let lock_path = safe_join(
        &plan.target.root,
        format!(".tmcl/locks/{}.lock", plan.target.id),
    )?;
    std::fs::create_dir_all(lock_path.parent().unwrap())?;
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(lock_path)?;
    lock.try_lock()
        .context("该版本正在安装或导出，请稍后重试")?;
    let previous = std::fs::metadata(output)
        .ok()
        .map(|m| (m.len(), m.modified().ok()));
    check()?;
    job.step(0, "重新校验所选文件和版本信息");
    plan.target.validate_environment()?;
    snapshot::validate_files(&plan.target, &plan.files, &job.cancel)?;
    let temporary = tempfile::Builder::new()
        .prefix(".sfmcl-export-")
        .suffix(".tmp")
        .tempfile_in(output.parent().unwrap())?;
    let mut zip = ZipWriter::new(temporary.reopen()?);
    let options = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .large_file(true);
    job.step(1, "写入整合包清单");
    let manifest_name = match plan.draft.format {
        ExportFormat::Modrinth => "modrinth.index.json",
        ExportFormat::Curseforge => "manifest.json",
    };
    zip.start_file(manifest_name, options)?;
    zip.write_all(&serde_json::to_vec_pretty(&plan.manifest)?)?;
    zip.start_file("README.md", options)?;
    zip.write_all(format!("# {}\n\n版本：{}\n\n作者：{}\n\n{}\n\nMinecraft {}{}\n\n使用启动器的整合包导入功能安装。\n", plan.draft.options.name, plan.draft.options.version, plan.draft.options.author, plan.draft.options.summary, plan.target.minecraft, plan.target.loader.as_ref().map(|v| format!(" / {} {}", v.kind, v.version)).unwrap_or_default()).as_bytes())?;
    let count = plan.direct.len();
    let mut index = 0;
    for file in &plan.files {
        check()?;
        if !plan.direct.contains(&file.file.path) {
            continue;
        }
        index += 1;
        job.step(1, format!("压缩 {index}/{count}：{}", file.file.path));
        zip.start_file(format!("overrides/{}", file.file.path), options)?;
        let mut input = std::fs::File::open(safe_join(&plan.target.game, &file.file.path)?)?;
        let mut sha512 = sha2::Sha512::new();
        let mut buffer = vec![0; 128 * 1024];
        let mut size = 0;
        loop {
            check()?;
            let count = input.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            size += count as u64;
            if size > file.file.size {
                bail!("文件在压缩时发生变化：{}", file.file.path);
            }
            sha512.update(&buffer[..count]);
            zip.write_all(&buffer[..count])?;
        }
        if size != file.file.size || hex::encode(sha512.finalize()) != file.sha512 {
            bail!("文件在压缩时发生变化：{}", file.file.path);
        }
    }
    let completed = zip.finish()?;
    completed.sync_all()?;
    drop(completed);
    check()?;
    job.step(2, "检查归档结构和覆盖文件哈希");
    let mut archive = ZipArchive::new(temporary.reopen()?)?;
    let mut manifest_bytes = vec![];
    archive
        .by_name(manifest_name)?
        .read_to_end(&mut manifest_bytes)?;
    let actual: Value = serde_json::from_slice(&manifest_bytes)?;
    if actual != plan.manifest || archive.len() != plan.direct.len() + 2 {
        bail!("导出归档校验失败");
    }
    for file in plan
        .files
        .iter()
        .filter(|f| plan.direct.contains(&f.file.path))
    {
        check()?;
        let mut entry = archive.by_name(&format!("overrides/{}", file.file.path))?;
        let mut hash = sha2::Sha512::new();
        let mut buffer = vec![0; 128 * 1024];
        loop {
            check()?;
            let count = entry.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            hash.update(&buffer[..count]);
        }
        if hex::encode(hash.finalize()) != file.sha512 {
            bail!("导出文件校验失败：{}", file.file.path);
        }
    }
    drop(archive);
    snapshot::validate_files(&plan.target, &plan.files, &job.cancel)?;
    check()?;
    plan.target.validate_environment()?;
    job.step(3, "保存已校验的整合包");
    destination(output, plan, overwrite)?;
    let current = std::fs::metadata(output)
        .ok()
        .map(|m| (m.len(), m.modified().ok()));
    if current != previous {
        bail!("保存位置的文件已变化，请重新选择保存位置");
    }
    if overwrite {
        temporary.persist(output).map_err(|e| e.error)?;
    } else {
        temporary.persist_noclobber(output).map_err(|e| e.error)?;
    }
    job.log(format!("整合包已保存：{}", output.display()));
    Ok(())
}

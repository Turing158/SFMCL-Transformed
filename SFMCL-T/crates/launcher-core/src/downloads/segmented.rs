use super::*;

const MIB: u64 = 1024 * 1024;
const MAX_SEGMENTS: usize = 10;

fn count(size: u64) -> usize {
    match size {
        0..=1_048_575 => 1,
        MIB..=8_388_608 => 4,
        8_388_609..=67_108_864 => 8,
        _ => 10,
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct Segment {
    start: u64,
    end: u64,
    downloaded: u64,
}
impl Segment {
    fn len(&self) -> u64 {
        self.end - self.start + 1
    }
}
fn ranges(size: u64) -> Vec<Segment> {
    let count = count(size) as u64;
    if size == 0 {
        return Vec::new();
    }
    let width = size / count;
    (0..count)
        .map(|index| Segment {
            start: index * width,
            end: if index + 1 == count {
                size - 1
            } else {
                (index + 1) * width - 1
            },
            downloaded: 0,
        })
        .collect()
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
enum Validator {
    Etag(String),
    Modified(String),
}
impl Validator {
    fn value(&self) -> &str {
        match self {
            Self::Etag(value) | Self::Modified(value) => value,
        }
    }
    fn matches(&self, response: &reqwest::Response) -> bool {
        let name = match self {
            Self::Etag(_) => header::ETAG,
            Self::Modified(_) => header::LAST_MODIFIED,
        };
        response
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
            == Some(self.value())
    }
}
fn validator(response: &reqwest::Response) -> Option<Validator> {
    if let Some(etag) = response
        .headers()
        .get(header::ETAG)
        .and_then(|value| value.to_str().ok())
    {
        if etag.starts_with('"')
            && etag.ends_with('"')
            && etag.len() >= 2
            && etag.as_bytes()[1..etag.len() - 1]
                .iter()
                .all(|byte| *byte == 0x21 || (0x23..=0x7e).contains(byte) || *byte >= 0x80)
        {
            return Some(Validator::Etag(etag.into()));
        }
    }
    response
        .headers()
        .get(header::LAST_MODIFIED)
        .and_then(|value| value.to_str().ok())
        .filter(|value| chrono::DateTime::parse_from_rfc2822(value).is_ok())
        .map(|value| Validator::Modified(value.into()))
}
pub(super) fn identity(response: &reqwest::Response) -> Result<()> {
    if response
        .headers()
        .get(header::CONTENT_ENCODING)
        .is_some_and(|value| value.as_bytes() != b"identity")
    {
        bail!("服务器返回了压缩下载响应");
    }
    Ok(())
}

#[derive(Clone, Serialize, Deserialize)]
struct Metadata {
    version: u32,
    source: String,
    final_url: String,
    size: u64,
    validator: Option<Validator>,
    segments: Vec<Segment>,
}
impl Metadata {
    fn compatible(&self, other: &Self) -> bool {
        self.version == 1
            && self.source == other.source
            && self.final_url == other.final_url
            && self.size == other.size
            && self.validator == other.validator
            && self.segments.len() == other.segments.len()
            && self
                .segments
                .iter()
                .zip(&other.segments)
                .all(|(a, b)| a.start == b.start && a.end == b.end && a.downloaded <= a.len())
    }
}
// Every name is derived, even for corrupt/untrusted metadata. Never enumerate
// a prefix or use a path supplied by the server/record to delete files.
pub(super) fn relative_paths(part: &Path) -> Vec<PathBuf> {
    let mut paths = vec![part.with_extension("part.segments.json")];
    paths.extend(
        (0..MAX_SEGMENTS).map(|index| part.with_extension(format!("part.segment-{index}"))),
    );
    paths
}
fn paths(transfer: &Transfer<'_>) -> Result<Vec<PathBuf>> {
    let relative = temporary_relative_path(transfer.cache.is_some(), transfer.id, transfer.spec);
    relative_paths(&relative)
        .iter()
        .map(|path| safe_join(transfer.cache.unwrap_or(transfer.root), path))
        .collect()
}
pub(super) fn clear(
    root: &Path,
    cache: Option<&Path>,
    id: &str,
    spec: &DownloadSpec,
) -> Result<()> {
    let part = temporary_relative_path(cache.is_some(), id, spec);
    for relative in relative_paths(&part) {
        let path = safe_join(cache.unwrap_or(root), relative)?;
        match std::fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}
fn persist(transfer: &Transfer<'_>, metadata: &Metadata) -> Result<()> {
    atomic_write(&paths(transfer)?[0], &serde_json::to_vec(metadata)?)
}

async fn discard(transfer: &Transfer<'_>) -> Result<()> {
    let (part, _) = temporary_paths(transfer.root, transfer.cache, transfer.id, transfer.spec)?;
    // Keep the segment marker until the assembled file has been removed. A
    // failed removal must not turn an incomplete merge into an ordinary part.
    match tokio::fs::remove_file(part).await {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    clear(transfer.root, transfer.cache, transfer.id, transfer.spec)
}

enum Probe {
    Segmented(Metadata),
    Plain(Option<(reqwest::Response, connections::Permit)>),
}
async fn probe(transfer: &Transfer<'_>) -> Result<Probe> {
    let permit = transfer.permit().await?;
    let request = transfer
        .client
        .get(&transfer.spec.url)
        .header(header::RANGE, "bytes=0-0")
        .header(header::ACCEPT_ENCODING, "identity");
    let mut response = tokio::select! { biased; _ = transfer.cancel.cancelled() => bail!("已暂停"), response = request.send() => response? };
    if response.status() == StatusCode::OK {
        // Reuse the full response instead of opening another full-file GET.
        return Ok(Probe::Plain(Some((response, permit))));
    }
    if response.status() == StatusCode::RANGE_NOT_SATISFIABLE {
        return Ok(Probe::Plain(None));
    }
    response.error_for_status_ref()?;
    let range = response
        .headers()
        .get(header::CONTENT_RANGE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| parse_content_range(value).ok());
    let Some((0, 0, size)) = range.filter(|(_, _, size)| *size > 0) else {
        return Ok(Probe::Plain(None));
    };
    if transfer.spec.size.is_some_and(|expected| expected != size) {
        bail!("服务器文件长度与清单不一致");
    }
    if response.status() != StatusCode::PARTIAL_CONTENT
        || identity(&response).is_err()
        || response.content_length().is_some_and(|length| length != 1)
        || count(size) == 1
    {
        return Ok(Probe::Plain(None));
    }
    let validator = validator(&response);
    if validator.is_none() && transfer.spec.sha1.is_none() && transfer.spec.sha512.is_none() {
        return Ok(Probe::Plain(None));
    }
    let metadata = Metadata {
        version: 1,
        source: transfer.spec.url.clone(),
        final_url: response.url().to_string(),
        size,
        validator,
        segments: ranges(size),
    };
    let mut bytes = 0;
    loop {
        let chunk = tokio::select! { biased; _ = transfer.cancel.cancelled() => bail!("已暂停"), chunk = response.chunk() => chunk? };
        let Some(chunk) = chunk else {
            break;
        };
        bytes += chunk.len();
        if bytes > 1 {
            return Ok(Probe::Plain(None));
        }
    }
    if bytes != 1 {
        return Ok(Probe::Plain(None));
    }
    drop(response);
    drop(permit);
    Ok(Probe::Segmented(metadata))
}

#[derive(Debug)]
struct Fallback(String);
impl std::fmt::Display for Fallback {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "分片响应无效：{}", self.0)
    }
}
impl std::error::Error for Fallback {}
fn incompatible(reason: &str) -> anyhow::Error {
    Fallback(reason.into()).into()
}

/// All child futures are joined before a fallback, source change, or pause.
pub(super) async fn transfer(
    transfer: &Transfer<'_>,
    progress: &(impl Fn(u64, Option<u64>) + Sync),
) -> Result<()> {
    let (part, meta) = temporary_paths(transfer.root, transfer.cache, transfer.id, transfer.spec)?;
    let owned = paths(transfer)?;
    let segmented = tokio::fs::try_exists(&owned[0]).await?;
    let expected_hash = transfer.spec.sha1.is_some() || transfer.spec.sha512.is_some();
    // Reuse a complete verified cache before any network traffic. A partial
    // merge has segment metadata and must never become an ordinary prefix.
    if let Some(size) = transfer.spec.size {
        if expected_hash
            && tokio::fs::metadata(&part)
                .await
                .is_ok_and(|file| file.len() == size)
            && verify_file(&part, transfer.spec, transfer.cancel)
                .await
                .is_ok()
        {
            let target = safe_join(transfer.root, &transfer.spec.path)?;
            tokio::fs::create_dir_all(target.parent().context("无效下载目录")?).await?;
            commit_file(
                transfer.root,
                transfer.id,
                transfer.spec,
                &part,
                transfer.cache.is_some(),
                transfer.cancel,
            )
            .await?;
            let _ = tokio::fs::remove_file(&meta).await;
            let _ = clear(transfer.root, transfer.cache, transfer.id, transfer.spec);
            progress(size, Some(size));
            return Ok(());
        }
    }
    cancel_check(transfer.cancel)?;
    if !segmented
        && (transfer.spec.size.is_some_and(|size| count(size) == 1)
            || tokio::fs::try_exists(&part).await?)
    {
        return transfer_plain(transfer, None, progress).await;
    }
    let previous = tokio::fs::read(&owned[0])
        .await
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Metadata>(&bytes).ok());
    if previous
        .as_ref()
        .is_some_and(|metadata| metadata.source != transfer.spec.url)
    {
        discard(transfer).await?;
    }
    let mut metadata = match probe(transfer).await? {
        Probe::Plain(response) => {
            if segmented {
                discard(transfer).await?;
            } else {
                clear(transfer.root, transfer.cache, transfer.id, transfer.spec)?;
            }
            return transfer_plain(transfer, response, progress).await;
        }
        Probe::Segmented(metadata) => metadata,
    };
    let target = safe_join(transfer.root, &transfer.spec.path)?;
    tokio::fs::create_dir_all(target.parent().context("无效下载目录")?).await?;
    tokio::fs::create_dir_all(part.parent().context("无效缓存目录")?).await?;
    if let Some(previous) = previous.filter(|previous| previous.compatible(&metadata)) {
        metadata = previous;
        for (index, segment) in metadata.segments.iter_mut().enumerate() {
            let path = &paths(transfer)?[index + 1];
            let actual = tokio::fs::metadata(path)
                .await
                .map(|file| file.len())
                .unwrap_or(0);
            segment.downloaded = if actual > segment.len() {
                0
            } else {
                actual.min(segment.downloaded)
            };
            if tokio::fs::try_exists(path).await? {
                tokio::fs::OpenOptions::new()
                    .write(true)
                    .open(path)
                    .await?
                    .set_len(segment.downloaded)
                    .await?;
            }
        }
    } else {
        discard(transfer).await?;
    }
    persist(transfer, &metadata)?;
    let bytes = Mutex::new(
        metadata
            .segments
            .iter()
            .map(|segment| segment.downloaded)
            .collect::<Vec<_>>(),
    );
    progress(bytes.lock().unwrap().iter().sum(), Some(metadata.size));
    let metadata = AsyncMutex::new(metadata);
    let child_cancel = transfer.cancel.child_token();
    let failure = AsyncMutex::new(None);
    let segment_count = metadata.lock().await.segments.len();
    stream::iter(0..segment_count)
        .for_each_concurrent(MAX_SEGMENTS, |index| {
            let metadata = &metadata;
            let bytes = &bytes;
            let child_cancel = &child_cancel;
            let failure = &failure;
            async move {
                let result = retry_segment(
                    transfer,
                    metadata,
                    index,
                    child_cancel,
                    &|downloaded, total| {
                        let mut bytes = bytes.lock().unwrap_or_else(|error| error.into_inner());
                        bytes[index] = downloaded;
                        progress(bytes.iter().sum(), Some(total));
                    },
                )
                .await;
                if let Err(error) = result {
                    let mut failure = failure.lock().await;
                    if failure.is_none() {
                        *failure = Some(error);
                        child_cancel.cancel();
                    }
                }
            }
        })
        .await;
    cancel_check(transfer.cancel)?;
    if let Some(error) = failure.into_inner() {
        if error.downcast_ref::<Fallback>().is_some() {
            discard(transfer).await?;
            progress(0, transfer.spec.size);
            return transfer_plain(transfer, None, progress).await;
        }
        return Err(error);
    }
    let metadata = metadata.into_inner();
    merge(transfer, &metadata).await?;
    let mut complete_spec = transfer.spec.clone();
    complete_spec.size = Some(metadata.size);
    if let Err(error) = verify_file(&part, &complete_spec, transfer.cancel).await {
        if !transfer.cancel.is_cancelled() {
            tokio::fs::remove_file(&part).await?;
            clear(transfer.root, transfer.cache, transfer.id, transfer.spec)?;
            progress(0, Some(metadata.size));
        }
        return Err(error);
    }
    commit_file(
        transfer.root,
        transfer.id,
        transfer.spec,
        &part,
        transfer.cache.is_some(),
        transfer.cancel,
    )
    .await?;
    // A cleanup failure must not undo a successful commit. The task record and
    // exact owned names allow clear/session-start cleanup to retry it later.
    let _ = clear(transfer.root, transfer.cache, transfer.id, transfer.spec);
    let _ = tokio::fs::remove_file(meta).await;
    progress(metadata.size, Some(metadata.size));
    Ok(())
}

async fn retry_segment(
    transfer: &Transfer<'_>,
    metadata: &AsyncMutex<Metadata>,
    index: usize,
    cancel: &CancellationToken,
    progress: &(impl Fn(u64, u64) + Sync),
) -> Result<()> {
    for attempt in 0..3 {
        cancel_check(cancel)?;
        match segment(transfer, metadata, index, cancel, progress).await {
            Ok(()) => return Ok(()),
            Err(error)
                if error.downcast_ref::<Fallback>().is_some()
                    || attempt == 2
                    || cancel.is_cancelled() =>
            {
                return Err(error)
            }
            Err(_) => {
                tokio::select! { biased; _ = cancel.cancelled() => bail!("已暂停"), _ = tokio::time::sleep(Duration::from_millis(150 * (attempt + 1))) => {} }
            }
        }
    }
    unreachable!()
}
async fn segment(
    transfer: &Transfer<'_>,
    metadata: &AsyncMutex<Metadata>,
    index: usize,
    cancel: &CancellationToken,
    progress: &(impl Fn(u64, u64) + Sync),
) -> Result<()> {
    let plan = metadata.lock().await.clone();
    let segment = &plan.segments[index];
    if segment.downloaded == segment.len() {
        return Ok(());
    }
    let permit = tokio::select! { biased; _ = cancel.cancelled() => bail!("已暂停"), permit = transfer.connections.acquire(transfer.group) => permit };
    let start = segment.start + segment.downloaded;
    let mut request = transfer
        .client
        .get(&plan.source)
        .header(header::ACCEPT_ENCODING, "identity")
        .header(header::RANGE, format!("bytes={start}-{}", segment.end));
    if let Some(validator) = &plan.validator {
        request = request.header(header::IF_RANGE, validator.value());
    }
    let response = tokio::select! { biased; _ = cancel.cancelled() => bail!("已暂停"), response = request.send() => response? };
    if matches!(
        response.status(),
        StatusCode::OK | StatusCode::RANGE_NOT_SATISFIABLE
    ) {
        return Err(incompatible("Range 被忽略或拒绝"));
    }
    response.error_for_status_ref()?;
    let range = response
        .headers()
        .get(header::CONTENT_RANGE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| parse_content_range(value).ok());
    if response.status() != StatusCode::PARTIAL_CONTENT
        || range != Some((start, segment.end, plan.size))
        || response
            .content_length()
            .is_some_and(|length| length != segment.end - start + 1)
        || identity(&response).is_err()
        || response.url().as_str() != plan.final_url
        || plan
            .validator
            .as_ref()
            .is_some_and(|validator| !validator.matches(&response))
    {
        return Err(incompatible("范围、长度、来源或文件版本变化"));
    }
    // Allocate/open only after admission and validating response headers.
    let path = &paths(transfer)?[index + 1];
    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(segment.downloaded == 0)
        .open(path)
        .await?;
    file.set_len(segment.downloaded).await?;
    file.seek(std::io::SeekFrom::Start(segment.downloaded))
        .await?;
    let mut received = segment.downloaded;
    let mut body = response.bytes_stream();
    let result = async {
        loop {
            let chunk = tokio::select! { biased; _ = cancel.cancelled() => bail!("已暂停"), chunk = body.next() => chunk };
            let Some(chunk) = chunk else { break; };
            let chunk = chunk?;
            if chunk.len() as u64 > segment.len() - received { return Err(incompatible("响应数据超过分片长度")); }
            // Finish this bounded write even if pause arrives during it.
            file.write_all(&chunk).await?;
            received += chunk.len() as u64;
            progress(received, plan.size);
        }
        if received != segment.len() { bail!("分片下载流提前结束"); }
        Ok(())
    }.await;
    drop(body);
    drop(permit);
    file.flush().await?;
    file.sync_all().await?;
    drop(file);
    // Publish recovery offsets only after the corresponding bytes are durable.
    let mut metadata = metadata.lock().await;
    metadata.segments[index].downloaded = received;
    persist(transfer, &metadata)?;
    result
}
async fn merge(transfer: &Transfer<'_>, metadata: &Metadata) -> Result<()> {
    let (part, _) = temporary_paths(transfer.root, transfer.cache, transfer.id, transfer.spec)?;
    let mut output = tokio::fs::File::create(part).await?;
    let mut buffer = vec![0; 64 * 1024];
    for (index, segment) in metadata.segments.iter().enumerate() {
        let path = &paths(transfer)?[index + 1];
        let mut input = tokio::fs::File::open(path).await?;
        if input.metadata().await?.len() != segment.len() || segment.downloaded != segment.len() {
            bail!("分片长度校验失败");
        }
        loop {
            cancel_check(transfer.cancel)?;
            let count = input.read(&mut buffer).await?;
            if count == 0 {
                break;
            }
            output.write_all(&buffer[..count]).await?;
        }
    }
    output.flush().await?;
    output.sync_all().await?;
    cancel_check(transfer.cancel)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn cancelling_merge_keeps_segments_and_never_changes_target() {
        let directory = tempfile::tempdir().unwrap();
        let spec = DownloadSpec {
            url: "https://example.test/file".into(),
            path: "file.bin".into(),
            size: Some(8 * MIB),
            sha1: None,
            sha512: None,
        };
        let cancel = CancellationToken::new();
        let transfer = Transfer {
            client: &crate::http_client().unwrap(),
            connections: &connections::Connections::new(1),
            group: "merge",
            root: directory.path(),
            cache: None,
            id: "merge",
            spec: &spec,
            cancel: &cancel,
        };
        let mut metadata = Metadata {
            version: 1,
            source: spec.url.clone(),
            final_url: spec.url.clone(),
            size: 8 * MIB,
            validator: None,
            segments: ranges(8 * MIB),
        };
        let owned = paths(&transfer).unwrap();
        for (index, segment) in metadata.segments.iter_mut().enumerate() {
            std::fs::File::create(&owned[index + 1])
                .unwrap()
                .set_len(segment.len())
                .unwrap();
            segment.downloaded = segment.len();
        }
        persist(&transfer, &metadata).unwrap();
        let target = directory.path().join("file.bin");
        std::fs::write(&target, b"original target").unwrap();
        let (part, _) =
            temporary_paths(transfer.root, transfer.cache, transfer.id, transfer.spec).unwrap();
        let interrupt = async {
            tokio::time::timeout(Duration::from_secs(3), async {
                while !part.exists() {
                    tokio::task::yield_now().await;
                }
                cancel.cancel();
            })
            .await
            .unwrap();
        };
        let (result, ()) = tokio::join!(merge(&transfer, &metadata), interrupt);
        assert!(result.is_err());
        assert_eq!(std::fs::read(&target).unwrap(), b"original target");
        assert!(owned
            .iter()
            .take(metadata.segments.len() + 1)
            .all(|path| path.exists()));
        let resumed = Transfer {
            cancel: &CancellationToken::new(),
            ..transfer
        };
        merge(&resumed, &metadata).await.unwrap();
        assert_eq!(std::fs::metadata(part).unwrap().len(), metadata.size);
        assert_eq!(std::fs::read(target).unwrap(), b"original target");
    }
    #[test]
    fn boundaries_and_ranges() {
        for (size, expected) in [
            (0, 1),
            (MIB - 1, 1),
            (MIB, 4),
            (MIB + 1, 4),
            (2 * MIB, 4),
            (4 * MIB, 4),
            (8 * MIB - 1, 4),
            (8 * MIB, 4),
            (8 * MIB + 1, 8),
            (64 * MIB - 1, 8),
            (64 * MIB, 8),
            (64 * MIB + 1, 10),
            (u64::MAX, 10),
        ] {
            assert_eq!(count(size), expected);
            let ranges = ranges(size);
            if size == 0 {
                assert!(ranges.is_empty());
                continue;
            }
            assert_eq!(ranges.len(), expected);
            assert_eq!(ranges[0].start, 0);
            assert_eq!(ranges.last().unwrap().end, size - 1);
            assert_eq!(ranges.iter().map(Segment::len).sum::<u64>(), size);
            assert!(ranges
                .windows(2)
                .all(|pair| pair[0].end + 1 == pair[1].start));
        }
    }
}

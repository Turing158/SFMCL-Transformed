use super::{
    archive,
    parser::{FileSource, PackFile},
    reserved, UrlResolver,
};
use crate::{downloads::DownloadSpec, jobs::Job};
use anyhow::{bail, Result};
use futures_util::{stream, StreamExt, TryStreamExt};
use std::{
    collections::{HashMap, HashSet},
    future::Future,
};

const LOOKUP_CONCURRENCY: usize = 4;

pub(super) async fn resolve<F, Fut>(
    files: &[PackFile],
    include_optional: bool,
    name: &str,
    job: &Job,
    lookup: F,
    resolver: &UrlResolver,
) -> Result<(Vec<DownloadSpec>, HashMap<String, Vec<String>>)>
where
    F: Fn(u64, u64) -> Fut + Sync,
    Fut: Future<Output = Result<DownloadSpec>> + Send,
{
    let selected: Vec<_> = files
        .iter()
        .filter(|file| !file.optional || include_optional)
        .cloned()
        .collect();
    let mut pending = stream::iter(selected)
        .map(|file| {
            let lookup = &lookup;
            async move {
                archive::check_cancel(&job.cancel)?;
                let (mut spec, mirrors) = match &file.source {
                    FileSource::Download { spec, mirrors } => (
                        spec.clone(),
                        Some((format!("versions/{name}/{}", file.path), mirrors.clone())),
                    ),
                    FileSource::CurseForge { project, file } => {
                        (lookup(*project, *file).await?, None)
                    }
                };
                reserved(&spec.path, name)?;
                match resolver(spec.url.clone()).await {
                    Ok(url) => spec.url = url,
                    Err(error) if crate::resources::curseforge::is_download_entry(&spec.url) => {
                        job.log(format!(
                            "无法自动获取 {}：{error:#}。可在下载文件详情中补选原始文件。",
                            spec.path
                        ));
                    }
                    Err(error) => return Err(error),
                }
                spec.path = format!("versions/{name}/{}", spec.path);
                Ok((spec, mirrors))
            }
        })
        // Preserve manifest order while resolving a bounded number of files.
        .buffered(LOOKUP_CONCURRENCY);
    let mut downloads = Vec::new();
    let mut mirrors = HashMap::new();
    let mut paths = HashSet::new();
    loop {
        let next = tokio::select! {
            biased;
            _ = job.cancel.cancelled() => bail!("整合包安装已取消"),
            next = pending.try_next() => next?,
        };
        let Some((spec, alternatives)) = next else {
            break;
        };
        if !paths.insert(spec.path.to_lowercase()) {
            bail!("整合包依赖存在重复安装路径");
        }
        if let Some((path, urls)) = alternatives {
            mirrors.insert(path, urls);
        }
        downloads.push(spec);
    }
    Ok((downloads, mirrors))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jobs::{JobKind, Jobs};
    use futures_util::poll;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    struct Active(Arc<AtomicUsize>);
    impl Drop for Active {
        fn drop(&mut self) {
            self.0.fetch_sub(1, Ordering::SeqCst);
        }
    }

    fn files() -> Vec<PackFile> {
        (0..10)
            .map(|id| PackFile {
                path: String::new(),
                optional: id == 9,
                source: FileSource::CurseForge {
                    project: 1,
                    file: id,
                },
            })
            .collect()
    }
    fn spec(id: u64) -> DownloadSpec {
        DownloadSpec {
            url: format!("https://example.com/{id}.jar"),
            path: format!("mods/{id}.jar"),
            size: Some(id + 1),
            sha1: Some("a".repeat(40)),
            sha512: None,
        }
    }

    #[tokio::test]
    async fn resolves_concurrently_with_a_bound_and_preserves_order_and_integrity() {
        let files = files();
        let job = Jobs::default().create(JobKind::Modpack, "pack".into(), &["files"]);
        let active = Arc::new(AtomicUsize::new(0));
        let peak = AtomicUsize::new(0);
        let gate = tokio::sync::Semaphore::new(0);
        let resolver: UrlResolver = Arc::new(|url| Box::pin(async { Ok(url) }));
        let result = resolve(
            &files,
            false,
            "pack",
            &job,
            |_, id| {
                let active = active.clone();
                let gate = &gate;
                let peak = &peak;
                async move {
                    let count = active.fetch_add(1, Ordering::SeqCst) + 1;
                    let _active = Active(active);
                    peak.fetch_max(count, Ordering::SeqCst);
                    let permit = gate.acquire().await.unwrap();
                    permit.forget();
                    Ok(spec(id))
                }
            },
            &resolver,
        );
        tokio::pin!(result);
        assert!(poll!(result.as_mut()).is_pending());
        assert_eq!(active.load(Ordering::SeqCst), LOOKUP_CONCURRENCY);
        gate.add_permits(9);
        let (downloads, _) = result.await.unwrap();
        assert_eq!(peak.load(Ordering::SeqCst), LOOKUP_CONCURRENCY);
        assert_eq!(downloads.len(), 9);
        for (id, file) in downloads.iter().enumerate() {
            assert_eq!(file.path, format!("versions/pack/mods/{id}.jar"));
            assert_eq!(file.sha1, spec(id as u64).sha1);
            assert_eq!(file.size, Some(id as u64 + 1));
        }
        assert_eq!(active.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn cancellation_drops_inflight_lookups_and_does_not_start_more() {
        let files = files();
        let job = Jobs::default().create(JobKind::Modpack, "pack".into(), &["files"]);
        let active = Arc::new(AtomicUsize::new(0));
        let calls = AtomicUsize::new(0);
        let resolver: UrlResolver = Arc::new(|url| Box::pin(async { Ok(url) }));
        let result = resolve(
            &files,
            false,
            "pack",
            &job,
            |_, _| {
                let active = active.clone();
                let calls = &calls;
                async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    active.fetch_add(1, Ordering::SeqCst);
                    let _active = Active(active);
                    std::future::pending::<Result<DownloadSpec>>().await
                }
            },
            &resolver,
        );
        tokio::pin!(result);
        assert!(poll!(result.as_mut()).is_pending());
        job.cancel.cancel();
        assert!(result.await.is_err());
        assert_eq!(calls.load(Ordering::SeqCst), LOOKUP_CONCURRENCY);
        assert_eq!(active.load(Ordering::SeqCst), 0);
    }
}

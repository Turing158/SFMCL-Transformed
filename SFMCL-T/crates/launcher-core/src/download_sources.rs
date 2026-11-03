use crate::minecraft::download_source::{MinecraftDownloadSource, BMCL};
use anyhow::{bail, Context, Result};
use futures_util::{stream, StreamExt};
use reqwest::{Client, RequestBuilder, Url};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::Mutex as AsyncMutex;
use tokio_util::sync::CancellationToken;

pub const MCIM: &str = "https://mod.mcimirror.top";
pub const TENCENT_MAVEN: &str = "https://mirrors.cloud.tencent.com/nexus/repository/maven-public";
pub const NEOFORGE_CDN: &str = "https://neoforged.forgecdn.net";
pub const MC_MIRROR: &str = "https://us-west-01.mc-mirror.com";

fn mapped(url: &Url, root: &str, path: &str) -> String {
    let mut result = format!("{root}{path}");
    if let Some(query) = url.query() {
        result.push('?');
        result.push_str(query);
    }
    result
}

/// Ordered as official first, then mirrors. Only documented equivalent routes
/// are rewritten; arbitrary URLs and CurseForge's mediafilez CDN stay intact.
pub fn candidates(original: &str) -> Vec<String> {
    let Ok(url) = Url::parse(original) else {
        return vec![original.into()];
    };
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || !matches!(url.port_or_known_default(), Some(80 | 443))
    {
        return vec![original.into()];
    }
    let path = url.path();
    let mut urls = match url.host_str() {
        Some(
            "piston-meta.mojang.com"
            | "piston-data.mojang.com"
            | "launchermeta.mojang.com"
            | "launcher.mojang.com",
        ) => vec![original.into(), mapped(&url, BMCL, path)],
        Some("libraries.minecraft.net") => vec![
            original.into(),
            mapped(&url, BMCL, &format!("/maven{path}")),
            mapped(&url, TENCENT_MAVEN, path),
            mapped(&url, MC_MIRROR, &format!("/libraries{path}")),
        ],
        Some("resources.download.minecraft.net") => vec![
            original.into(),
            mapped(&url, BMCL, &format!("/assets{path}")),
            mapped(&url, MC_MIRROR, &format!("/assets/objects{path}")),
        ],
        Some("maven.minecraftforge.net") => vec![
            original.into(),
            mapped(&url, BMCL, &format!("/maven{path}")),
        ],
        Some("files.minecraftforge.net") if path.starts_with("/maven/") => candidates(&mapped(
            &url,
            "https://maven.minecraftforge.net",
            &path[6..],
        )),
        Some("maven.neoforged.net" | "neoforged.forgecdn.net")
            if path.starts_with("/releases/") =>
        {
            vec![
                mapped(&url, "https://maven.neoforged.net", path),
                mapped(&url, NEOFORGE_CDN, path),
                mapped(&url, BMCL, &format!("/maven/{}", &path[10..])),
            ]
        }
        Some("meta.fabricmc.net") => vec![
            original.into(),
            mapped(&url, BMCL, &format!("/fabric-meta{path}")),
        ],
        Some("maven.fabricmc.net") => vec![
            original.into(),
            mapped(&url, BMCL, &format!("/maven{path}")),
            mapped(&url, MC_MIRROR, &format!("/fabric/maven{path}")),
            mapped(&url, MC_MIRROR, &format!("/quilt/maven{path}")),
        ],
        Some("maven.quiltmc.org") if path.starts_with("/repository/release/") => vec![
            original.into(),
            mapped(&url, MC_MIRROR, &format!("/quilt/maven/{}", &path[20..])),
        ],
        Some("repo.maven.apache.org" | "repo1.maven.org") if path.starts_with("/maven2/") => vec![
            original.into(),
            mapped(&url, TENCENT_MAVEN, &path[7..]),
            mapped(&url, BMCL, &format!("/maven/{}", &path[8..])),
            mapped(&url, MC_MIRROR, &format!("/libraries/{}", &path[8..])),
        ],
        Some("mirrors.cloud.tencent.com")
            if path.starts_with("/nexus/repository/maven-public/") =>
        {
            candidates(&mapped(
                &url,
                "https://repo.maven.apache.org/maven2",
                &path[30..],
            ))
        }
        Some("api.modrinth.com") => vec![
            original.into(),
            mapped(&url, MCIM, &format!("/modrinth{path}")),
        ],
        Some("api.curseforge.com") => vec![
            original.into(),
            mapped(&url, MCIM, &format!("/curseforge{path}")),
        ],
        Some("cdn.modrinth.com" | "edge.forgecdn.net") => {
            vec![original.into(), mapped(&url, MCIM, path)]
        }
        Some("mod.mcimirror.top") if path.starts_with("/modrinth/") => {
            candidates(&mapped(&url, "https://api.modrinth.com", &path[9..]))
        }
        Some("mod.mcimirror.top") if path.starts_with("/curseforge/") => {
            candidates(&mapped(&url, "https://api.curseforge.com", &path[11..]))
        }
        Some("mod.mcimirror.top") if path.starts_with("/data/") => {
            candidates(&mapped(&url, "https://cdn.modrinth.com", path))
        }
        Some("mod.mcimirror.top") if path.starts_with("/files/") => {
            candidates(&mapped(&url, "https://edge.forgecdn.net", path))
        }
        Some("bmclapi2.bangbang93.com") if path.starts_with("/fabric-meta/") => {
            candidates(&mapped(&url, "https://meta.fabricmc.net", &path[12..]))
        }
        Some("bmclapi2.bangbang93.com") if path.starts_with("/assets/") => candidates(&mapped(
            &url,
            "https://resources.download.minecraft.net",
            &path[7..],
        )),
        Some("bmclapi2.bangbang93.com")
            if path.starts_with("/mc/") || path.starts_with("/v1/packages/") =>
        {
            candidates(&mapped(&url, "https://piston-meta.mojang.com", path))
        }
        Some("bmclapi2.bangbang93.com") if path.starts_with("/v1/objects/") => {
            candidates(&mapped(&url, "https://piston-data.mojang.com", path))
        }
        Some("bmclapi2.bangbang93.com") if path.starts_with("/maven/") => {
            let artifact = &path[6..];
            let root = if artifact.starts_with("/net/neoforged/") {
                "https://maven.neoforged.net/releases"
            } else if artifact.starts_with("/net/minecraftforge/")
                || artifact.starts_with("/cpw/mods/")
            {
                "https://maven.minecraftforge.net"
            } else if artifact.starts_with("/net/fabricmc/") {
                "https://maven.fabricmc.net"
            } else if artifact.starts_with("/com/mumfrey/") {
                "https://dl.liteloader.com/versions"
            } else {
                "https://libraries.minecraft.net"
            };
            let mut urls = candidates(&mapped(&url, root, artifact));
            urls.push(original.into());
            urls
        }
        Some("us-west-01.mc-mirror.com") if path.starts_with("/libraries/") => candidates(&mapped(
            &url,
            "https://libraries.minecraft.net",
            &path[10..],
        )),
        Some("us-west-01.mc-mirror.com") if path.starts_with("/assets/objects/") => {
            candidates(&mapped(
                &url,
                "https://resources.download.minecraft.net",
                &path[15..],
            ))
        }
        Some("us-west-01.mc-mirror.com") if path.starts_with("/fabric/maven/") => {
            candidates(&mapped(&url, "https://maven.fabricmc.net", &path[13..]))
        }
        Some("us-west-01.mc-mirror.com") if path.starts_with("/quilt/maven/") => {
            let artifact = &path[12..];
            let root = if artifact.starts_with("/org/quiltmc/") {
                "https://maven.quiltmc.org/repository/release"
            } else {
                "https://maven.fabricmc.net"
            };
            let mut urls = candidates(&mapped(&url, root, artifact));
            urls.push(original.into());
            urls
        }
        _ => vec![original.into()],
    };
    let mut seen = std::collections::HashSet::new();
    urls.retain(|url| seen.insert(url.clone()));
    urls
}

fn provider(url: &str) -> String {
    let Ok(url) = Url::parse(url) else {
        return url.into();
    };
    // Separate Maven vendors and metadata from assets. A missing Fabric artifact
    // must not penalize BMCLAPI's Minecraft resource network.
    let segments = if url.path().starts_with("/maven/") {
        4
    } else {
        2
    };
    let path = url
        .path()
        .split('/')
        .take(segments)
        .collect::<Vec<_>>()
        .join("/");
    let path = if matches!(url.host_str(), Some("bmclapi2.bangbang93.com")) {
        path
    } else if url.host_str() == Some("mod.mcimirror.top") {
        url.path().split('/').take(2).collect::<Vec<_>>().join("/")
    } else if url.host_str() == Some("us-west-01.mc-mirror.com") {
        // Profile bundles, asset indexes and file repositories have distinct
        // coverage and response sizes; a miss must only penalize that group.
        url.path().split('/').take(3).collect::<Vec<_>>().join("/")
    } else {
        String::new()
    };
    format!("{}{path}", url.origin().ascii_serialization())
}

fn is_mirror(url: &str) -> bool {
    Url::parse(url).is_ok_and(|url| {
        matches!(
            url.host_str(),
            Some(
                "bmclapi2.bangbang93.com"
                    | "mod.mcimirror.top"
                    | "mirrors.cloud.tencent.com"
                    | "neoforged.forgecdn.net"
                    | "us-west-01.mc-mirror.com"
            )
        )
    })
}

#[derive(Clone)]
struct Measurement {
    time: Instant,
    score: Option<u64>,
}
type Measurements = HashMap<String, Measurement>;

pub struct SourceSelector {
    mode: Mutex<MinecraftDownloadSource>,
    cache: AsyncMutex<HashMap<String, Arc<AsyncMutex<Measurements>>>>,
    alternatives: Mutex<HashMap<String, Vec<String>>>,
}
impl Default for SourceSelector {
    fn default() -> Self {
        Self {
            mode: Mutex::new(MinecraftDownloadSource::Auto),
            cache: AsyncMutex::new(HashMap::new()),
            alternatives: Mutex::new(HashMap::new()),
        }
    }
}
impl SourceSelector {
    pub fn set_mode(&self, mode: MinecraftDownloadSource) {
        *self.mode.lock().unwrap_or_else(|e| e.into_inner()) = mode;
    }
    pub fn mode(&self) -> MinecraftDownloadSource {
        *self.mode.lock().unwrap_or_else(|e| e.into_inner())
    }
    pub fn register(&self, url: &str, alternatives: Vec<String>) {
        if alternatives.is_empty() {
            return;
        }
        self.alternatives
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(url.into(), alternatives);
    }
    pub fn candidates(&self, url: &str) -> Vec<String> {
        self.alternatives
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(url)
            .cloned()
            .unwrap_or_else(|| candidates(url))
    }
    /// Mojang's content-addressed URLs need version/index names from verified
    /// metadata. Register request-time alternatives without editing that JSON.
    pub fn register_minecraft(&self, version: &serde_json::Value) {
        let id = version["clientVersion"].as_str().or(version["id"].as_str());
        if let Some(id) = id.filter(|id| crate::paths::valid_name(id).is_ok()) {
            for kind in ["client", "server"] {
                if let Some(url) = version["downloads"][kind]["url"].as_str() {
                    self.register_minecraft_file(url, &format!("/versions/{id}/{kind}.jar"));
                }
            }
        }
        let index = &version["assetIndex"];
        if let (Some(id), Some(url)) = (index["id"].as_str(), index["url"].as_str()) {
            if crate::paths::valid_name(id).is_ok() {
                self.register_minecraft_file(url, &format!("/assets/indexes/{id}.json"));
            }
        }
        let logging = &version["logging"]["client"]["file"];
        if let (Some(id), Some(url)) = (logging["id"].as_str(), logging["url"].as_str()) {
            if crate::paths::valid_name(id).is_ok() {
                self.register_minecraft_file(url, &format!("/logging/{id}"));
            }
        }
    }
    fn register_minecraft_file(&self, original: &str, path: &str) {
        let Ok(url) = Url::parse(original) else {
            return;
        };
        if !matches!(
            url.host_str(),
            Some(
                "piston-meta.mojang.com"
                    | "piston-data.mojang.com"
                    | "launchermeta.mojang.com"
                    | "launcher.mojang.com"
                    | "bmclapi2.bangbang93.com"
            )
        ) || !matches!(url.scheme(), "http" | "https")
            || !url.username().is_empty()
            || url.password().is_some()
            || !matches!(url.port_or_known_default(), Some(80 | 443))
        {
            return;
        }
        let mut urls = candidates(original);
        // Escape names as path segments, rather than allowing query/fragment
        // syntax in locally renamed profiles to change the mirror route.
        let mut mirror = Url::parse(MC_MIRROR).unwrap();
        mirror
            .path_segments_mut()
            .unwrap()
            .extend(path.trim_start_matches('/').split('/'));
        urls.push(mirror.into());
        for alias in &urls {
            self.register(alias, urls.clone());
        }
    }
    pub async fn order(
        &self,
        client: &Client,
        urls: &[String],
        cancel: &CancellationToken,
    ) -> Result<Vec<String>> {
        self.order_with(urls, cancel, |url| Ok(client.get(url)))
            .await
    }
    /// Probe with the same method, payload and host-specific credentials as the
    /// real API request, so authentication failures do not skew source ranking.
    pub async fn order_with(
        &self,
        urls: &[String],
        cancel: &CancellationToken,
        request: impl Fn(&str) -> Result<RequestBuilder> + Sync,
    ) -> Result<Vec<String>> {
        let mut urls = urls.to_vec();
        let mut seen = std::collections::HashSet::new();
        urls.retain(|url| seen.insert(url.clone()));
        match self.mode() {
            MinecraftDownloadSource::Official => return Ok(urls),
            MinecraftDownloadSource::Bmclapi => {
                urls.sort_by_key(|url| !is_mirror(url));
                return Ok(urls);
            }
            MinecraftDownloadSource::Auto => {}
        }
        if urls.len() < 2 {
            return Ok(urls);
        }
        let key = urls
            .iter()
            .map(|url| provider(url))
            .collect::<Vec<_>>()
            .join("|");
        let entry = self.cache.lock().await.entry(key).or_default().clone();
        let mut measurements = tokio::select! { biased; _ = cancel.cancelled() => bail!("操作已取消"), entry = entry.lock() => entry };
        let pending = urls
            .iter()
            .filter(|url| {
                measurements.get(&provider(url)).is_none_or(|value| {
                    value.time.elapsed()
                        > if value.score.is_some() {
                            Duration::from_secs(300)
                        } else {
                            Duration::from_secs(30)
                        }
                })
            })
            .cloned()
            .collect::<Vec<_>>();
        let probes = stream::iter(pending)
            .map(|url| {
                let request = &request;
                async move {
                    let score = tokio::time::timeout(Duration::from_secs(4), async {
                        probe(request(&url)?).await
                    })
                    .await
                    .ok()
                    .and_then(Result::ok);
                    (
                        provider(&url),
                        Measurement {
                            time: Instant::now(),
                            score,
                        },
                    )
                }
            })
            .buffer_unordered(4)
            .collect::<Vec<_>>();
        let results = tokio::select! { biased; _ = cancel.cancelled() => bail!("操作已取消"), results = probes => results };
        measurements.extend(results);
        urls.sort_by_key(|url| {
            measurements
                .get(&provider(url))
                .and_then(|value| value.score)
                .unwrap_or(u64::MAX)
        });
        Ok(urls)
    }
    pub async fn failed(&self, url: &str) {
        let name = provider(url);
        let entries = self
            .cache
            .lock()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for entry in entries {
            let mut values = entry.lock().await;
            if let Some(value) = values.get_mut(&name) {
                *value = Measurement {
                    time: Instant::now(),
                    score: None,
                };
            }
        }
    }
    pub async fn fetch<T>(
        &self,
        client: &Client,
        urls: &[String],
        cancel: &CancellationToken,
        decode: impl Fn(&[u8]) -> Result<T>,
    ) -> Result<T> {
        let ordered = self.order(client, urls, cancel).await?;
        let mut error = None;
        for url in ordered {
            let request = async {
                let response = client
                    .get(&url)
                    .timeout(Duration::from_secs(12))
                    .send()
                    .await?
                    .error_for_status()?;
                let bytes = response.bytes().await?;
                decode(&bytes)
            };
            let result = tokio::select! { biased; _ = cancel.cancelled() => bail!("操作已取消"), result = request => result };
            match result {
                Ok(value) => return Ok(value),
                Err(failure) => {
                    self.failed(&url).await;
                    error = Some(failure);
                }
            }
        }
        Err(error.unwrap_or_else(|| anyhow::anyhow!("没有可用的下载源")))
    }
    pub async fn json(
        &self,
        client: &Client,
        url: &str,
        cancel: &CancellationToken,
    ) -> Result<serde_json::Value> {
        self.fetch(client, &self.candidates(url), cancel, |bytes| {
            Ok(serde_json::from_slice(bytes)?)
        })
        .await
    }
}

async fn probe(request: RequestBuilder) -> Result<u64> {
    let start = Instant::now();
    let mut response = request
        .header(reqwest::header::RANGE, "bytes=0-65535")
        .header(reqwest::header::ACCEPT_ENCODING, "identity")
        .send()
        .await?
        .error_for_status()?;
    if response.status().is_redirection() {
        bail!("测速接口返回跳转");
    }
    let latency = start.elapsed();
    let mut received = 0usize;
    while received < 65536 {
        let Some(bytes) = response.chunk().await? else {
            break;
        };
        received += bytes.len();
    }
    if received == 0 {
        bail!("测速响应为空");
    }
    let transfer = start.elapsed().saturating_sub(latency);
    (latency.as_micros() + transfer.as_micros() * 65536 / received as u128)
        .try_into()
        .context("测速结果溢出")
}

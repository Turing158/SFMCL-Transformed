use super::{load, read_text, Notice};
use anyhow::{bail, Context, Result};
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    path::PathBuf,
    sync::RwLock,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

mod wiki;

const CONTENT_BASE: &str = "https://launchercontent.mojang.com/v2/";
const NEWS_URL: &str = "https://launchercontent.mojang.com/v2/news.json";
const JAVA_URL: &str = "https://launchercontent.mojang.com/v2/javaPatchNotes.json";
const MANIFEST_URL: &str = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
const WIKI_API: &str = "https://zh.minecraft.wiki/api.php";
const CACHE_PATH: &str = "cache/official-notices.json";
const CACHE_TTL: u64 = 60 * 60;
const MAX_BYTES: usize = 4 * 1024 * 1024;
const NEWS_LIMIT: usize = 3;
const JAVA_LIMIT: usize = 1;
const WIKI_LIMIT: usize = 1;

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
struct CachedFeed {
    fetched_at: u64,
    items: Vec<Notice>,
}

impl CachedFeed {
    fn fresh(&self, now: u64) -> bool {
        self.fetched_at > 0
            && now >= self.fetched_at
            && now - self.fetched_at < CACHE_TTL
            && !self.items.is_empty()
    }
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default)]
struct Cache {
    news: CachedFeed,
    java: CachedFeed,
    wiki: CachedFeed,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoticeRefresh {
    pub items: Vec<Notice>,
    pub error: String,
}

/// Network refreshes are serialized; cached reads never wait for the network.
pub struct OfficialNotices {
    directory: PathBuf,
    client: Client,
    cache: RwLock<Cache>,
    refresh_lock: tokio::sync::Mutex<()>,
    local_lock: std::sync::Mutex<()>,
}

impl OfficialNotices {
    pub fn new(directory: PathBuf, client: Client) -> Self {
        let mut cache: Cache = crate::paths::safe_join(&directory, CACHE_PATH)
            .and_then(|path| read_text(&path))
            .and_then(|text| Ok(serde_json::from_str(&text)?))
            .unwrap_or_default();
        cache.java.items.sort_by(|a, b| b.date.cmp(&a.date));
        cache.java.items.truncate(JAVA_LIMIT);
        Self {
            directory,
            client,
            cache: RwLock::new(cache),
            refresh_lock: tokio::sync::Mutex::new(()),
            local_lock: std::sync::Mutex::new(()),
        }
    }

    pub fn list(&self) -> Result<Vec<Notice>> {
        let local = load(&self.directory)?;
        Ok(self.combine(local, &self.cache.read().unwrap()))
    }

    pub fn hidden(&self) -> Result<Vec<String>> {
        let _local = self.local_lock.lock().unwrap();
        super::management::hidden(&self.directory)
    }

    pub fn set_hidden(&self, id: &str, hidden: bool) -> Result<Vec<String>> {
        let _local = self.local_lock.lock().unwrap();
        if hidden
            && !self
                .list()?
                .iter()
                .any(|notice| notice.id == id && notice.preset)
        {
            bail!("自定义公告只能删除");
        }
        super::management::set_hidden(&self.directory, id, hidden)
    }

    pub fn create(&self, title: &str, content: &str) -> Result<Vec<Notice>> {
        let _local = self.local_lock.lock().unwrap();
        super::management::create(&self.directory, title, content)?;
        self.list()
    }

    pub fn delete(&self, id: &str) -> Result<Vec<Notice>> {
        let _local = self.local_lock.lock().unwrap();
        super::management::delete(&self.directory, id)?;
        self.list()
    }

    fn combine(&self, mut local: Vec<Notice>, cache: &Cache) -> Vec<Notice> {
        let mut remote: Vec<Notice> = cache
            .news
            .items
            .iter()
            .take(NEWS_LIMIT)
            .chain(cache.java.items.iter().take(JAVA_LIMIT))
            .chain(cache.wiki.items.iter().take(WIKI_LIMIT))
            .cloned()
            .map(|mut notice| {
                // Old cache files predate the preset marker.
                notice.preset = true;
                notice
            })
            .collect();
        remote.sort_by(|a, b| b.date.cmp(&a.date));
        let mut ids = HashSet::new();
        remote.retain(|item| {
            let key = if item.url.is_empty() {
                &item.id
            } else {
                item.url.rsplit("/article/").next().unwrap_or(&item.id)
            };
            ids.insert(key.to_owned())
        });
        // The welcome notice remains the cold/offline fallback. User notices stay first.
        if !remote.is_empty() && !self.directory.join("Notices.json").exists() {
            local.clear();
        }
        local.extend(remote);
        local
    }

    pub async fn refresh(&self, force: bool) -> NoticeRefresh {
        self.refresh_from(
            force,
            NEWS_URL,
            JAVA_URL,
            CONTENT_BASE,
            MANIFEST_URL,
            WIKI_API,
        )
        .await
    }

    async fn refresh_from(
        &self,
        force: bool,
        news_url: &str,
        java_url: &str,
        content_base: &str,
        manifest_url: &str,
        wiki_api: &str,
    ) -> NoticeRefresh {
        let _refresh = self.refresh_lock.lock().await;
        let mut cache = self.cache.read().unwrap().clone();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let update_news = force || !cache.news.fresh(now);
        let update_java = force || !cache.java.fresh(now);
        let update_wiki = force || !cache.wiki.fresh(now);
        let (news, java, wiki) = tokio::join!(
            async {
                if update_news {
                    Some(fetch_news(&self.client, news_url).await)
                } else {
                    None
                }
            },
            async {
                if update_java {
                    Some(fetch_java(&self.client, java_url, content_base).await)
                } else {
                    None
                }
            },
            async {
                if update_wiki {
                    Some(wiki::fetch(&self.client, manifest_url, wiki_api).await)
                } else {
                    None
                }
            }
        );
        let mut errors = vec![];
        let mut changed = false;
        for (name, result, feed) in [
            ("官方新闻", news, &mut cache.news),
            ("Java 版更新", java, &mut cache.java),
            ("中文 Minecraft Wiki", wiki, &mut cache.wiki),
        ] {
            if let Some(result) = result {
                match result {
                    Ok(items) => {
                        *feed = CachedFeed {
                            fetched_at: now,
                            items,
                        };
                        changed = true;
                    }
                    Err(_) => errors.push(if feed.items.is_empty() {
                        format!("{name}暂时无法获取，请稍后刷新。")
                    } else {
                        format!("{name}暂时无法更新，正在显示缓存内容。")
                    }),
                }
            }
        }
        if changed {
            // A read-only/full disk must not hide successfully fetched news.
            *self.cache.write().unwrap() = cache.clone();
            let save = (|| -> Result<()> {
                let path = crate::paths::safe_join(&self.directory, CACHE_PATH)?;
                crate::paths::atomic_write(&path, &serde_json::to_vec(&cache)?)
            })();
            if save.is_err() {
                errors.push("公告缓存保存失败，重启后需要重新获取。".into());
            }
        }
        let local = match load(&self.directory) {
            Ok(items) => items,
            Err(error) => {
                errors.push(format!("自定义公告读取失败：{error:#}"));
                vec![]
            }
        };
        NoticeRefresh {
            items: self.combine(local, &cache),
            error: errors.join(" "),
        }
    }
}

#[derive(Deserialize)]
struct Feed<T> {
    entries: Vec<T>,
}

#[derive(Default, Deserialize)]
struct Image {
    url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NewsEntry {
    id: String,
    title: String,
    date: String,
    #[serde(default)]
    text: String,
    read_more_link: String,
    #[serde(default)]
    news_page_image: Image,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JavaEntry {
    id: String,
    title: String,
    version: String,
    date: String,
    #[serde(rename = "type")]
    kind: String,
    content_path: String,
    #[serde(default)]
    image: Image,
}

#[derive(Deserialize)]
struct JavaDetail {
    body: String,
}

async fn fetch_json<T: serde::de::DeserializeOwned>(client: &Client, url: &str) -> Result<T> {
    let mut response = client
        .get(url)
        .timeout(Duration::from_secs(8))
        .send()
        .await?
        .error_for_status()?;
    if response
        .content_length()
        .is_some_and(|size| size > MAX_BYTES as u64)
    {
        bail!("公告接口返回内容超过 4 MB");
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if bytes.len() + chunk.len() > MAX_BYTES {
            bail!("公告接口返回内容超过 4 MB");
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).context("公告接口返回内容无效")
}

fn official_link(value: &str) -> Option<String> {
    let mut url = Url::parse(value).ok()?;
    if url.scheme() != "https" || url.host_str() != Some("www.minecraft.net") {
        return None;
    }
    url.set_query(None);
    url.set_fragment(None);
    Some(url.into())
}

fn official_image(value: &str) -> String {
    Url::parse(CONTENT_BASE)
        .unwrap()
        .join(value)
        .ok()
        .filter(|url| {
            url.scheme() == "https"
                && url.host_str() == Some("launchercontent.mojang.com")
                && !value.is_empty()
        })
        .map(String::from)
        .unwrap_or_default()
}

fn markdown_text(text: &str) -> String {
    let mut result = String::new();
    for character in text.chars() {
        if "\\`*_{}[]<>()#!|".contains(character) {
            result.push('\\');
        }
        result.push(character);
    }
    result
}

fn content(summary: &str, image: &str, link: &str) -> String {
    let mut blocks = vec![markdown_text(summary)];
    if !image.is_empty() {
        blocks.push(format!("![公告配图](<{image}>)"));
    }
    blocks.push(format!("[阅读完整内容](<{link}>)"));
    blocks.join("\n\n")
}

async fn fetch_news(client: &Client, url: &str) -> Result<Vec<Notice>> {
    let mut entries: Vec<NewsEntry> = fetch_json::<Feed<NewsEntry>>(client, url).await?.entries;
    entries.sort_by(|a, b| b.date.cmp(&a.date));
    let mut links = HashSet::new();
    let items: Vec<Notice> = entries
        .into_iter()
        .filter_map(|entry| {
            let link = official_link(&entry.read_more_link)?;
            if entry.title.trim().is_empty() || !links.insert(link.clone()) {
                return None;
            }
            Some(Notice {
                id: format!("news:{}", entry.id),
                title: entry.title,
                content: content(
                    &entry.text,
                    &official_image(&entry.news_page_image.url),
                    &link,
                ),
                url: link,
                icon: "/assets/DefaultGameIcon/Minecraft.png".into(),
                category: "官方新闻".into(),
                date: entry.date,
                ..Notice::default()
            })
        })
        .take(NEWS_LIMIT)
        .collect();
    if items.is_empty() {
        bail!("官方新闻中没有有效条目");
    }
    Ok(items)
}

fn java_article(title: &str) -> String {
    // Article slugs follow the displayed title, not the sometimes hashed entry ID.
    let slug = title
        .to_ascii_lowercase()
        .split(|character: char| !character.is_ascii_alphanumeric())
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    format!("https://www.minecraft.net/article/{slug}")
}

fn java_category(entry: &JavaEntry) -> &str {
    if entry.kind == "release" {
        "Java 正式版"
    } else if entry.version.contains("-pre-") {
        "Java 预发布版"
    } else if entry.version.contains("-rc") {
        "Java 发布候选"
    } else {
        "Java 快照"
    }
}

fn introduction(html: &str) -> String {
    use std::sync::LazyLock;
    static HEADING: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"(?i)<h[1-6]\b").unwrap());
    static TAGS: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"<[^>]*>").unwrap());
    let prefix = HEADING
        .find(html)
        .map_or(html, |heading| &html[..heading.start()]);
    let text = TAGS.replace_all(prefix, " ");
    let text = text
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">");
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.chars().count() > 600 {
        format!("{}…", text.chars().take(600).collect::<String>())
    } else {
        text
    }
}

async fn fetch_java(client: &Client, url: &str, base: &str) -> Result<Vec<Notice>> {
    let mut entries: Vec<JavaEntry> = fetch_json::<Feed<JavaEntry>>(client, url).await?.entries;
    entries.sort_by(|a, b| b.date.cmp(&a.date));
    let mut versions = HashSet::new();
    let entries: Vec<_> = entries
        .into_iter()
        .filter(|entry| {
            !entry.title.trim().is_empty()
                && !entry.version.trim().is_empty()
                && versions.insert(entry.version.clone())
        })
        .take(JAVA_LIMIT)
        .collect();
    if entries.is_empty() {
        bail!("Java 版更新中没有有效条目");
    }
    // Only the selected updates need detail requests; fetch those concurrently.
    let items = futures_util::future::join_all(entries.into_iter().map(|entry| async move {
        let detail_url = Url::parse(base).ok().and_then(|base| {
            let url = base.join(&entry.content_path).ok()?;
            (url.origin() == base.origin() && url.path().starts_with(base.path())).then_some(url)
        });
        let summary = match detail_url {
            Some(url) => fetch_json::<JavaDetail>(client, url.as_str())
                .await
                .map(|detail| introduction(&detail.body))
                .unwrap_or_default(),
            None => String::new(),
        };
        let summary = if summary.is_empty() {
            format!(
                "Java 版 {} 已发布，查看本次更新的新增内容、调整与修复。",
                entry.version
            )
        } else {
            summary
        };
        Notice {
            id: format!("java:{}", entry.id),
            category: java_category(&entry).into(),
            content: content(
                &summary,
                &official_image(&entry.image.url),
                &java_article(&entry.title),
            ),
            url: java_article(&entry.title),
            title: entry.title,
            icon: "/assets/DefaultGameIcon/Minecraft.png".into(),
            date: entry.date,
            ..Notice::default()
        }
    }))
    .await;
    Ok(items)
}

#[cfg(test)]
mod tests;

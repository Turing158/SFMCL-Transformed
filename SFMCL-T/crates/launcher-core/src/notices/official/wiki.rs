use super::{content, fetch_json, Client, Notice, Result, Url};
use anyhow::Context;
use serde::Deserialize;
use std::collections::BTreeMap;

#[derive(Deserialize)]
struct Manifest {
    latest: Latest,
    versions: Vec<Version>,
}

#[derive(Deserialize)]
struct Latest {
    snapshot: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Version {
    id: String,
    release_time: String,
}

#[derive(Deserialize)]
struct WikiResponse {
    query: WikiQuery,
}

#[derive(Deserialize)]
struct WikiQuery {
    pages: BTreeMap<String, WikiPage>,
}

#[derive(Deserialize)]
struct WikiPage {
    title: String,
    #[serde(default)]
    extract: String,
}

pub(super) async fn fetch(client: &Client, manifest_url: &str, api: &str) -> Result<Vec<Notice>> {
    // The version manifest keeps this source available independently of Java patch notes.
    let manifest: Manifest = fetch_json(client, manifest_url).await?;
    let version = manifest
        .versions
        .iter()
        .find(|entry| entry.id == manifest.latest.snapshot)
        .context("版本清单中缺少最新版本")?;
    let title = format!("Java版{}", version.id);
    let mut request = Url::parse(api)?;
    request.query_pairs_mut().extend_pairs([
        ("action", "query"),
        ("prop", "extracts"),
        ("exintro", "1"),
        ("explaintext", "1"),
        ("exchars", "600"),
        ("redirects", "1"),
        ("format", "json"),
        ("titles", title.as_str()),
    ]);
    let response: WikiResponse = fetch_json(client, request.as_str()).await?;
    let page = response
        .query
        .pages
        .into_values()
        .find(|page| !page.title.trim().is_empty() && !page.extract.trim().is_empty())
        .context("中文 Wiki 暂无该版本的介绍")?;
    let mut link = Url::parse("https://zh.minecraft.wiki/")?;
    link.path_segments_mut()
        .unwrap()
        .extend(["w", page.title.as_str()]);
    let link: String = link.into();
    Ok(vec![Notice {
        id: format!("wiki:{}", page.title),
        title: page.title,
        category: "中文 Minecraft Wiki".into(),
        date: version.release_time.clone(),
        content: content(&page.extract, "", &link),
        url: link,
        icon: "/assets/DefaultGameIcon/Minecraft.png".into(),
        ..Notice::default()
    }])
}

use super::*;
use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use serde_json::json;
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc,
};

#[derive(Default)]
struct Fixture {
    calls: AtomicUsize,
    unavailable: AtomicBool,
    empty: AtomicBool,
    large: AtomicBool,
    wiki_calls: AtomicUsize,
    wiki_unavailable: AtomicBool,
    wiki_missing: AtomicBool,
    next_version: AtomicBool,
    java_unavailable: AtomicBool,
}

async fn news(State(state): State<Arc<Fixture>>) -> axum::response::Response {
    state.calls.fetch_add(1, Ordering::SeqCst);
    if state.unavailable.load(Ordering::SeqCst) {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    if state.large.load(Ordering::SeqCst) {
        return "x".repeat(MAX_BYTES + 1).into_response();
    }
    if state.empty.load(Ordering::SeqCst) {
        return Json(json!({ "entries": [] })).into_response();
    }
    let mut entries: Vec<_> = (1..=4).map(|index| json!({
        "id": format!("news-{index}"), "title": format!("News {index}"),
        "date": format!("2026-10-{index:02}"), "text": "**Plain** <script>alert(1)</script>",
        "readMoreLink": format!("https://www.minecraft.net/article/news-{index}?ref=launcher"),
        "newsPageImage": { "url": "/v2/images/news.jpg" }
    })).collect();
    entries.push(entries[3].clone());
    entries.push(json!({
        "id": "invalid", "title": "Invalid", "date": "2026-11-01",
        "readMoreLink": "javascript:alert(1)", "newsPageImage": { "url": "https://invalid.test/image.png" }
    }));
    Json(json!({ "entries": entries })).into_response()
}

async fn java(State(state): State<Arc<Fixture>>) -> axum::response::Response {
    if state.java_unavailable.load(Ordering::SeqCst) {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    Json(json!({ "entries": [
        { "id": "hash-old", "title": "Minecraft: Java Edition 26.3", "version": "26.3",
          "type": "release", "date": "2026-09-15", "contentPath": "details/old.json" },
        { "id": "hash-new", "title": "Minecraft 26.4 Snapshot 6", "version": "26.4-snapshot-6",
          "type": "snapshot", "date": "2026-10-27T13:40:29Z", "contentPath": "details/new.json",
          "image": { "url": "/v2/images/snapshot.jpg" } },
        { "id": "duplicate", "title": "Duplicate snapshot", "version": "26.4-snapshot-6",
          "type": "snapshot", "date": "2026-10-26", "contentPath": "details/new.json" }
    ] }))
    .into_response()
}

async fn manifest(State(state): State<Arc<Fixture>>) -> Json<serde_json::Value> {
    let version = if state.next_version.load(Ordering::SeqCst) {
        "26.4-snapshot-7"
    } else {
        "26.4-snapshot-6"
    };
    Json(json!({
        "latest": { "snapshot": version, "release": "26.3" },
        "versions": [{ "id": version, "releaseTime": "2026-10-27T13:40:29Z" }]
    }))
}

async fn wiki(
    State(state): State<Arc<Fixture>>,
    Query(query): Query<std::collections::HashMap<String, String>>,
) -> axum::response::Response {
    state.wiki_calls.fetch_add(1, Ordering::SeqCst);
    if state.wiki_unavailable.load(Ordering::SeqCst) {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    assert_eq!(query["explaintext"], "1");
    assert_eq!(query["exintro"], "1");
    assert_eq!(query["redirects"], "1");
    let extract = if state.wiki_missing.load(Ordering::SeqCst) {
        ""
    } else {
        "这是最新 Java 版快照，加入了雪砖系列方块和新的硫方怪原型。"
    };
    Json(json!({ "query": { "pages": { "123": { "title": query["titles"], "extract": extract } } } })).into_response()
}

async fn detail() -> Json<serde_json::Value> {
    Json(
        json!({ "body": "<p>Snow bricks &amp; cold cubes.</p><p>Happy building!</p><h1>Features</h1><ul><li>Full changelog</li></ul>" }),
    )
}

async fn server() -> (String, Arc<Fixture>, tokio::task::JoinHandle<()>) {
    let fixture = Arc::new(Fixture::default());
    let app = Router::new()
        .route("/news", get(news))
        .route("/java", get(java))
        .route("/manifest", get(manifest))
        .route("/wiki", get(wiki))
        .route("/details/{name}", get(detail))
        .with_state(fixture.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (base, fixture, task)
}

async fn refresh(service: &OfficialNotices, base: &str, force: bool) -> NoticeRefresh {
    service
        .refresh_from(
            force,
            &format!("{base}news"),
            &format!("{base}java"),
            base,
            &format!("{base}manifest"),
            &format!("{base}wiki"),
        )
        .await
}

#[tokio::test]
async fn merges_recent_news_and_java_details_and_persists_cache() {
    let (base, _, server) = server().await;
    let directory = tempfile::tempdir().unwrap();
    let service = OfficialNotices::new(directory.path().into(), crate::http_client().unwrap());
    let result = refresh(&service, &base, false).await;
    assert!(result.error.is_empty(), "{}", result.error);
    assert_eq!(result.items.len(), 5);
    assert!(result.items.iter().all(|notice| notice.preset));
    assert_eq!(result.items[0].title, "Minecraft 26.4 Snapshot 6");
    assert_eq!(result.items[0].category, "Java 快照");
    assert!(result.items[0]
        .content
        .contains(r"Snow bricks & cold cubes. Happy building\!"));
    assert!(!result.items[0].content.contains("Full changelog"));
    assert_eq!(
        result.items[0].url,
        "https://www.minecraft.net/article/minecraft-26-4-snapshot-6"
    );
    assert!(result.items[0]
        .content
        .contains("https://launchercontent.mojang.com/v2/images/snapshot.jpg"));
    assert_eq!(result.items[1].category, "中文 Minecraft Wiki");
    assert_eq!(result.items[1].title, "Java版26.4-snapshot-6");
    assert!(result.items[1].content.contains("加入了雪砖系列方块"));
    assert!(result.items[1]
        .url
        .starts_with("https://zh.minecraft.wiki/w/"));
    assert_eq!(result.items[2].title, "News 4");
    assert!(result.items[2].content.contains(r"\*\*Plain\*\*"));
    assert!(!result.items[2].content.contains("?ref=launcher"));
    assert_eq!(
        result
            .items
            .iter()
            .filter(|notice| notice.id.starts_with("java:"))
            .count(),
        1
    );
    assert!(!result
        .items
        .iter()
        .any(|notice| notice.title == "Minecraft: Java Edition 26.3"));
    server.abort();
    let reloaded = OfficialNotices::new(directory.path().into(), crate::http_client().unwrap());
    assert_eq!(reloaded.list().unwrap().len(), 5);
}

#[tokio::test]
async fn automatic_refresh_uses_cache_but_manual_refresh_bypasses_it() {
    let (base, fixture, server) = server().await;
    let directory = tempfile::tempdir().unwrap();
    let service = OfficialNotices::new(directory.path().into(), crate::http_client().unwrap());
    refresh(&service, &base, false).await;
    let count = fixture.calls.load(Ordering::SeqCst);
    let wiki_count = fixture.wiki_calls.load(Ordering::SeqCst);
    refresh(&service, &base, false).await;
    assert_eq!(fixture.calls.load(Ordering::SeqCst), count);
    assert_eq!(fixture.wiki_calls.load(Ordering::SeqCst), wiki_count);
    refresh(&service, &base, true).await;
    assert_eq!(fixture.calls.load(Ordering::SeqCst), count + 1);
    assert_eq!(fixture.wiki_calls.load(Ordering::SeqCst), wiki_count + 1);
    server.abort();
}

#[tokio::test]
async fn failures_and_empty_feeds_keep_cached_news_and_retry_only_failed_sources() {
    let (base, fixture, server) = server().await;
    let directory = tempfile::tempdir().unwrap();
    let service = OfficialNotices::new(directory.path().into(), crate::http_client().unwrap());
    refresh(&service, &base, false).await;
    // Expire just the news. The Java source remains usable/fresh independently.
    service.cache.write().unwrap().news.fetched_at = 1;
    fixture.unavailable.store(true, Ordering::SeqCst);
    let result = refresh(&service, &base, false).await;
    assert_eq!(result.items.len(), 5);
    assert!(result.error.contains("正在显示缓存内容"));
    assert_eq!(service.cache.read().unwrap().news.fetched_at, 1);
    fixture.unavailable.store(false, Ordering::SeqCst);
    fixture.empty.store(true, Ordering::SeqCst);
    assert_eq!(refresh(&service, &base, false).await.items.len(), 5);
    fixture.empty.store(false, Ordering::SeqCst);
    assert!(refresh(&service, &base, false).await.error.is_empty());
    server.abort();
}

#[tokio::test]
async fn offline_cold_start_keeps_welcome_or_custom_notices() {
    let (base, _, server) = server().await;
    server.abort();
    let directory = tempfile::tempdir().unwrap();
    let service = OfficialNotices::new(directory.path().into(), crate::http_client().unwrap());
    let result = refresh(&service, &base, true).await;
    assert_eq!(result.items[0].title, "一个轻巧的新起点");
    assert!(!result.error.is_empty());
    std::fs::write(
        directory.path().join("Notices.json"),
        r#"[{"title":"本地公告","content":"本地内容"}]"#,
    )
    .unwrap();
    assert_eq!(
        refresh(&service, &base, true).await.items[0].title,
        "本地公告"
    );
}

#[tokio::test]
async fn corrupt_cache_and_bad_custom_config_do_not_hide_official_news() {
    let (base, _, server) = server().await;
    let directory = tempfile::tempdir().unwrap();
    crate::paths::atomic_write(&directory.path().join(CACHE_PATH), b"not json").unwrap();
    std::fs::write(directory.path().join("Notices.json"), "not json").unwrap();
    let service = OfficialNotices::new(directory.path().into(), crate::http_client().unwrap());
    let result = refresh(&service, &base, false).await;
    assert_eq!(result.items.len(), 5);
    assert!(result.error.contains("自定义公告读取失败"));
    std::fs::write(
        directory.path().join("Notices.json"),
        r#"[{"title":"本地公告"}]"#,
    )
    .unwrap();
    let result = refresh(&service, &base, false).await;
    assert_eq!(result.items.len(), 6);
    assert_eq!(result.items[0].title, "本地公告");
    server.abort();
}

#[tokio::test]
async fn rejects_oversized_responses_and_preserves_other_sources() {
    let (base, fixture, server) = server().await;
    fixture.large.store(true, Ordering::SeqCst);
    let directory = tempfile::tempdir().unwrap();
    let service = OfficialNotices::new(directory.path().into(), crate::http_client().unwrap());
    let result = refresh(&service, &base, true).await;
    assert_eq!(result.items.len(), 2);
    assert!(result.error.contains("官方新闻暂时无法获取"));
    server.abort();
}

#[tokio::test]
async fn wiki_failures_and_missing_articles_keep_cache_until_a_successful_retry() {
    let (base, fixture, server) = server().await;
    let directory = tempfile::tempdir().unwrap();
    let service = OfficialNotices::new(directory.path().into(), crate::http_client().unwrap());
    refresh(&service, &base, false).await;
    service.cache.write().unwrap().wiki.fetched_at = 1;
    let news_calls = fixture.calls.load(Ordering::SeqCst);
    fixture.wiki_unavailable.store(true, Ordering::SeqCst);
    let result = refresh(&service, &base, false).await;
    assert_eq!(result.items.len(), 5);
    assert!(result.error.contains("中文 Minecraft Wiki暂时无法更新"));
    assert_eq!(service.cache.read().unwrap().wiki.fetched_at, 1);
    fixture.wiki_unavailable.store(false, Ordering::SeqCst);
    fixture.wiki_missing.store(true, Ordering::SeqCst);
    assert_eq!(refresh(&service, &base, false).await.items.len(), 5);
    assert_eq!(service.cache.read().unwrap().wiki.fetched_at, 1);
    fixture.wiki_missing.store(false, Ordering::SeqCst);
    fixture.next_version.store(true, Ordering::SeqCst);
    let result = refresh(&service, &base, false).await;
    assert!(result.error.is_empty());
    assert!(result
        .items
        .iter()
        .any(|notice| notice.title == "Java版26.4-snapshot-7"));
    assert!(!result
        .items
        .iter()
        .any(|notice| notice.title == "Java版26.4-snapshot-6"));
    assert_eq!(fixture.calls.load(Ordering::SeqCst), news_calls);
    server.abort();
}

#[tokio::test]
async fn wiki_is_available_even_when_the_java_patch_endpoint_fails() {
    let (base, fixture, server) = server().await;
    fixture.java_unavailable.store(true, Ordering::SeqCst);
    let directory = tempfile::tempdir().unwrap();
    let service = OfficialNotices::new(directory.path().into(), crate::http_client().unwrap());
    let result = refresh(&service, &base, true).await;
    assert_eq!(result.items.len(), 4);
    assert!(result
        .items
        .iter()
        .any(|notice| notice.category == "中文 Minecraft Wiki"));
    assert!(result.error.contains("Java 版更新暂时无法获取"));
    server.abort();
}

#[test]
fn existing_cache_without_wiki_keeps_only_the_newest_java_notice() {
    let directory = tempfile::tempdir().unwrap();
    let old_cache = json!({ "java": { "fetchedAt": 10, "items": [
        { "id": "java:old", "title": "旧版本", "date": "2026-10-20" },
        { "id": "java:new", "title": "最新版本", "date": "2026-10-27" }
    ] } });
    crate::paths::atomic_write(
        &directory.path().join(CACHE_PATH),
        &serde_json::to_vec(&old_cache).unwrap(),
    )
    .unwrap();
    let service = OfficialNotices::new(directory.path().into(), crate::http_client().unwrap());
    let items = service.list().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].title, "最新版本");
    assert!(items[0].preset);
    service.set_hidden(&items[0].id, true).unwrap();
    assert_eq!(service.hidden().unwrap(), vec![items[0].id.clone()]);
}

#[test]
fn untrusted_links_images_and_future_cache_times_are_rejected() {
    assert!(official_link("javascript:alert(1)").is_none());
    assert!(official_link("https://www.minecraft.net.invalid.test/article/x").is_none());
    assert!(official_image("//invalid.test/image.png").is_empty());
    assert!(official_image("javascript:alert(1)").is_empty());
    let feed = CachedFeed {
        fetched_at: 101,
        items: vec![Notice::default()],
    };
    assert!(!feed.fresh(100));
    assert!(feed.fresh(101));
    assert!(!feed.fresh(101 + CACHE_TTL));
    assert_eq!(
        java_article("Minecraft 26.3 Pre-Release 3"),
        "https://www.minecraft.net/article/minecraft-26-3-pre-release-3"
    );
}

#[tokio::test]
#[ignore = "requires the public Mojang endpoints"]
async fn live_official_feeds() {
    let directory = tempfile::tempdir().unwrap();
    let service = OfficialNotices::new(directory.path().into(), crate::http_client().unwrap());
    let result = service.refresh(true).await;
    assert!(result.error.is_empty(), "{}", result.error);
    assert_eq!(result.items.len(), 5);
    assert_eq!(
        result
            .items
            .iter()
            .filter(|notice| notice.id.starts_with("java:"))
            .count(),
        1
    );
    assert!(result
        .items
        .iter()
        .any(|notice| notice.id.starts_with("wiki:") && notice.content.contains("Java版")));
    for notice in result.items {
        println!("{} | {} | {}", notice.category, notice.date, notice.title);
        assert!(notice.content.contains("阅读完整内容"));
    }
}

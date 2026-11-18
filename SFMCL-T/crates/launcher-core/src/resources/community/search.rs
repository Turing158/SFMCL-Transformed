use super::{curseforge_project, modrinth_project, Community, Project, Query, SearchResults};
use anyhow::{Context, Result};
use futures_util::{stream, FutureExt, StreamExt, TryStreamExt};
use serde_json::json;
use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::{Mutex as AsyncMutex, Semaphore};

type Params = Vec<(String, String)>;
const CONCURRENCY: usize = 4;
const CACHE_LIFETIME: Duration = Duration::from_secs(300);

struct Hit {
    project: Project,
    created: String,
    updated: String,
    follows: u64,
}
struct Cached {
    time: Instant,
    hits: Arc<Vec<Hit>>,
}
type CacheEntry = Arc<AsyncMutex<Option<Cached>>>;
pub(super) struct SearchCache {
    entries: Mutex<VecDeque<(String, CacheEntry)>>,
    slots: Semaphore,
}
impl Default for SearchCache {
    fn default() -> Self {
        Self {
            entries: Default::default(),
            slots: Semaphore::new(CONCURRENCY),
        }
    }
}
impl SearchCache {
    fn entry(&self, query: &Query) -> CacheEntry {
        // Pagination and sorting reuse the same complete, filtered match set.
        let key = json!([
            query.source,
            query.kind,
            query
                .query
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .to_lowercase(),
            query.game_version,
            query.loader.to_lowercase(),
            query.category
        ])
        .to_string();
        let mut entries = self
            .entries
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if let Some(position) = entries.iter().position(|(existing, _)| *existing == key) {
            let entry = entries.remove(position).unwrap();
            let result = entry.1.clone();
            entries.push_back(entry);
            return result;
        }
        let entry = Arc::new(AsyncMutex::new(None));
        if entries.len() >= 16 {
            entries.pop_front();
        }
        entries.push_back((key, entry.clone()));
        entry
    }
}

pub(super) fn modrinth_params(q: &Query, limit: u32, slugs: &[String]) -> Result<Params> {
    let mut facets = vec![vec![format!("project_type:{}", q.kind)]];
    if !q.game_version.is_empty() {
        facets.push(vec![format!("versions:{}", q.game_version)]);
    }
    if !q.loader.is_empty() {
        facets.push(vec![format!("categories:{}", q.loader.to_lowercase())]);
    }
    if !q.category.is_empty() {
        facets.push(vec![format!("categories:{}", q.category)]);
    }
    if !slugs.is_empty() {
        facets.push(slugs.iter().map(|slug| format!("slug:{slug}")).collect());
    }
    let sort =
        if ["relevance", "downloads", "follows", "newest", "updated"].contains(&q.sort.as_str()) {
            &q.sort
        } else {
            "relevance"
        };
    Ok(vec![
        ("query".into(), q.query.clone()),
        ("facets".into(), serde_json::to_string(&facets)?),
        ("offset".into(), q.offset.to_string()),
        ("limit".into(), limit.to_string()),
        ("index".into(), sort.into()),
    ])
}

pub(super) fn curseforge_params(q: &Query, limit: u32, slug: Option<&str>) -> Params {
    let class = match q.kind.as_str() {
        "resourcepack" => 12,
        "shader" => 6552,
        "modpack" => 4471,
        "datapack" => 6945,
        _ => 6,
    };
    let loader = match q.loader.to_lowercase().as_str() {
        "forge" => 1,
        "liteloader" => 3,
        "fabric" => 4,
        "quilt" => 5,
        "neoforge" => 6,
        _ => 0,
    };
    let mut params = vec![
        ("gameId".into(), "432".into()),
        ("classId".into(), class.to_string()),
        ("searchFilter".into(), q.query.clone()),
        ("index".into(), q.offset.to_string()),
        ("pageSize".into(), limit.to_string()),
        (
            "sortField".into(),
            match q.sort.as_str() {
                "downloads" => "6",
                "updated" => "3",
                _ => "2",
            }
            .into(),
        ),
        ("sortOrder".into(), "desc".into()),
    ];
    if !q.game_version.is_empty() {
        params.push(("gameVersion".into(), q.game_version.clone()));
    }
    if loader > 0 {
        params.push(("modLoaderType".into(), loader.to_string()));
    }
    if !q.category.is_empty() {
        params.push(("categoryId".into(), q.category.clone()));
    }
    if let Some(slug) = slug {
        params.push(("slug".into(), slug.into()));
    }
    params
}

impl Community {
    pub(super) async fn search_localized(
        &self,
        q: &Query,
        slugs: &[String],
    ) -> Result<SearchResults> {
        let entry = self.search_cache.entry(q);
        let mut cached = entry.lock().await;
        let hits = if let Some(existing) = cached
            .as_ref()
            .filter(|existing| existing.time.elapsed() < CACHE_LIFETIME)
        {
            existing.hits.clone()
        } else {
            // Modrinth also indexes native Chinese titles. CurseForge ignores
            // a Chinese searchFilter and returns its unfiltered catalog instead.
            let chunk = if q.source == "modrinth" { 50 } else { 1 };
            let groups = (q.source == "modrinth")
                .then_some(&[][..])
                .into_iter()
                .chain(slugs.chunks(chunk))
                .map(<[String]>::to_vec);
            let mut requests = Vec::new();
            for group in groups {
                let query = q.clone();
                requests.push(
                    async move {
                        let _slot = self.search_cache.slots.acquire().await?;
                        self.search_matches(&query, &group).await
                    }
                    .boxed(),
                );
            }
            let batches = stream::iter(requests)
                .buffer_unordered(CONCURRENCY)
                .try_collect::<Vec<_>>()
                .await?;
            let mut seen = HashSet::new();
            let hits = Arc::new(
                batches
                    .into_iter()
                    .flatten()
                    .filter(|hit| seen.insert(hit.project.id.clone()))
                    .collect::<Vec<_>>(),
            );
            *cached = Some(Cached {
                time: Instant::now(),
                hits: hits.clone(),
            });
            hits
        };
        drop(cached);
        let ranks = slugs
            .iter()
            .enumerate()
            .map(|(rank, slug)| (slug.as_str(), rank))
            .collect::<HashMap<_, _>>();
        let mut sorted = hits.iter().collect::<Vec<_>>();
        sorted.sort_by(|left, right| {
            let order = match q.sort.as_str() {
                "downloads" => right.project.downloads.cmp(&left.project.downloads),
                "updated" => right.updated.cmp(&left.updated),
                "newest" => right.created.cmp(&left.created),
                "follows" => right.follows.cmp(&left.follows),
                _ => ranks
                    .get(left.project.slug.as_str())
                    .unwrap_or(&usize::MAX)
                    .cmp(
                        ranks
                            .get(right.project.slug.as_str())
                            .unwrap_or(&usize::MAX),
                    ),
            };
            order
                .then_with(|| right.project.downloads.cmp(&left.project.downloads))
                .then_with(|| left.project.id.cmp(&right.project.id))
        });
        Ok(SearchResults {
            total: sorted.len() as u64,
            offset: q.offset,
            items: sorted
                .into_iter()
                .skip(q.offset as usize)
                .take(q.limit.clamp(1, 40) as usize)
                .map(|hit| hit.project.clone())
                .collect(),
        })
    }

    async fn search_matches(&self, query: &Query, slugs: &[String]) -> Result<Vec<Hit>> {
        let mut q = query.clone();
        q.offset = 0;
        if !slugs.is_empty() {
            q.query.clear();
        }
        let mut hits = Vec::new();
        loop {
            let (path, params) = if q.source == "modrinth" {
                ("search", modrinth_params(&q, 100, slugs)?)
            } else {
                (
                    "mods/search",
                    curseforge_params(&q, 50, slugs.first().map(String::as_str)),
                )
            };
            let value = self.get(&q.source, path, &params).await?;
            let (items, total) = if q.source == "modrinth" {
                (
                    value["hits"].as_array().context("Modrinth 返回格式错误")?,
                    value["total_hits"].as_u64(),
                )
            } else {
                (
                    value["data"]
                        .as_array()
                        .context("CurseForge 返回格式错误")?,
                    value["pagination"]["totalCount"].as_u64(),
                )
            };
            if items.is_empty() {
                break;
            }
            let previous = hits.len();
            for item in items {
                let project = if q.source == "modrinth" {
                    modrinth_project(item)
                } else {
                    curseforge_project(item)
                };
                hits.push(Hit {
                    project,
                    created: item[if q.source == "modrinth" {
                        "date_created"
                    } else {
                        "dateCreated"
                    }]
                    .as_str()
                    .unwrap_or_default()
                    .into(),
                    updated: item[if q.source == "modrinth" {
                        "date_modified"
                    } else {
                        "dateModified"
                    }]
                    .as_str()
                    .unwrap_or_default()
                    .into(),
                    follows: item["follows"].as_u64().unwrap_or(0),
                });
            }
            q.offset += (hits.len() - previous) as u32;
            if q.offset as u64 >= total.unwrap_or(q.offset as u64) {
                break;
            }
        }
        Ok(hits)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{download_sources::SourceSelector, vault::Vault};

    #[test]
    fn community_search_future_can_run_on_the_desktop_executor() {
        fn require_send<T: Send>(_: T) {}
        let directory = tempfile::tempdir().unwrap();
        let community = Community::new(Arc::new(Vault::open(directory.path()).unwrap())).unwrap();
        let query = Query {
            query: "机械".into(),
            ..Query::default()
        };
        require_send(community.search(&query));
    }
    use axum::{extract::Query as RequestParams, routing::get, Json, Router};

    #[tokio::test]
    async fn ambiguous_searches_merge_filter_sort_paginate_and_cache_both_sources() {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let captured = requests.clone();
        let app = Router::new().route("/search", get(move |RequestParams(params): RequestParams<HashMap<String, String>>| {
            let captured = captured.clone();
            async move {
                captured.lock().unwrap().push(params.clone());
                let modrinth = params.contains_key("query");
                let mut values = if modrinth {
                    vec![
                        json!({"project_id":"create", "slug":"create", "title":"Create", "project_type":"mod", "downloads":200, "date_modified":"2026-01-01"}),
                        json!({"project_id":"advanced", "slug":"advanced-machines-uuum", "title":"Advanced Machines", "project_type":"mod", "downloads":100, "date_modified":"2026-03-01"}),
                        json!({"project_id":"native", "slug":"native", "title":"机械原生", "project_type":"mod", "downloads":50, "date_modified":"2026-02-01"}),
                    ]
                } else {
                    vec![
                        json!({"id":328085, "slug":"create", "name":"Create", "classId":6, "downloadCount":200, "dateModified":"2026-01-01"}),
                        json!({"id":2, "slug":"advanced-machines", "name":"Advanced Machines", "classId":6, "downloadCount":100, "dateModified":"2026-03-01"}),
                        json!({"id":3, "slug":"native", "name":"机械原生", "classId":6, "downloadCount":50, "dateModified":"2026-02-01"}),
                    ]
                };
                let version = if modrinth {
                    let facets: Vec<Vec<String>> = serde_json::from_str(&params["facets"]).unwrap();
                    let slugs = facets.iter().flatten().filter_map(|facet| facet.strip_prefix("slug:")).collect::<Vec<_>>();
                    if slugs.is_empty() { values.remove(1); } else { values.retain(|value| slugs.contains(&value["slug"].as_str().unwrap())); }
                    facets.iter().flatten().any(|facet| facet == "versions:1.20.1")
                } else {
                    if let Some(slug) = params.get("slug") { values.retain(|value| value["slug"] == *slug); } else { values.remove(1); }
                    params.get("gameVersion").is_some_and(|version| version == "1.20.1")
                };
                if !version { values.clear(); }
                if modrinth {
                    Json(json!({"total_hits":values.len(), "hits":values}))
                } else {
                    Json(json!({"pagination":{"totalCount":values.len()}, "data":values}))
                }
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let directory = tempfile::tempdir().unwrap();
        let sources = Arc::new(SourceSelector::default());
        let community = Community::new(Arc::new(Vault::open(directory.path()).unwrap()))
            .unwrap()
            .with_sources(sources.clone());

        for source in ["modrinth", "curseforge"] {
            let slugs = vec![
                "create".to_string(),
                if source == "modrinth" {
                    "advanced-machines-uuum"
                } else {
                    "advanced-machines"
                }
                .to_string(),
            ];
            let mut q = Query {
                source: source.into(),
                query: "机械".into(),
                game_version: "1.20.1".into(),
                loader: "Fabric".into(),
                category: "technology".into(),
                sort: "downloads".into(),
                offset: 1,
                limit: 1,
                ..Query::default()
            };
            // Register all expected routes, preserving request parameters so
            // assertions can detect incorrect filters and accidental empty searches.
            for version in ["1.20.1", "1.19.4"] {
                let mut request = q.clone();
                request.offset = 0;
                request.game_version = version.into();
                let chunk = if source == "modrinth" { 50 } else { 1 };
                for group in (source == "modrinth")
                    .then_some(&[][..])
                    .into_iter()
                    .chain(slugs.chunks(chunk))
                {
                    request.query = if group.is_empty() { "机械" } else { "" }.into();
                    let (root, params) = if source == "modrinth" {
                        (
                            "https://api.modrinth.com/v2/search",
                            modrinth_params(&request, 100, group).unwrap(),
                        )
                    } else {
                        (
                            "https://api.curseforge.com/v1/mods/search",
                            curseforge_params(&request, 50, group.first().map(String::as_str)),
                        )
                    };
                    let mut original = reqwest::Url::parse(root).unwrap();
                    original.query_pairs_mut().extend_pairs(&params);
                    let mut mock =
                        reqwest::Url::parse(&format!("http://{address}/search")).unwrap();
                    mock.set_query(original.query());
                    sources.register(original.as_str(), vec![mock.into()]);
                }
            }
            let count = requests.lock().unwrap().len();
            let result = community.search_localized(&q, &slugs).await.unwrap();
            assert_eq!(result.total, if source == "modrinth" { 3 } else { 2 });
            assert_eq!(result.offset, 1);
            assert_eq!(result.items[0].title, "Advanced Machines");
            let fetched = requests.lock().unwrap().len();
            assert_eq!(fetched - count, 2);
            q.offset = 0;
            q.sort = "updated".into();
            assert_eq!(
                community.search_localized(&q, &slugs).await.unwrap().items[0].title,
                "Advanced Machines"
            );
            q.offset = 2;
            q.sort = "downloads".into();
            let last_page = community.search_localized(&q, &slugs).await.unwrap();
            if source == "modrinth" {
                assert_eq!(last_page.items[0].title, "机械原生");
            } else {
                assert!(last_page.items.is_empty());
            }
            assert_eq!(requests.lock().unwrap().len(), fetched);
            q.game_version = "1.19.4".into();
            let filtered = community.search_localized(&q, &slugs).await.unwrap();
            assert_eq!(filtered.total, 0);
            assert!(filtered.items.is_empty());
            if source == "curseforge" {
                let unknown = Query {
                    source: "curseforge".into(),
                    query: "未收录的模组名称".into(),
                    game_version: "1.20.1".into(),
                    ..Query::default()
                };
                let mut original =
                    reqwest::Url::parse("https://api.curseforge.com/v1/mods/search").unwrap();
                original
                    .query_pairs_mut()
                    .extend_pairs(curseforge_params(&unknown, 20, None));
                let mut mock = reqwest::Url::parse(&format!("http://{address}/search")).unwrap();
                mock.set_query(original.query());
                sources.register(original.as_str(), vec![mock.into()]);
                let count = requests.lock().unwrap().len();
                let result = community.search(&unknown).await.unwrap();
                assert_eq!(result.total, 0);
                assert!(result.items.is_empty());
                assert_eq!(
                    requests.lock().unwrap().len(),
                    count,
                    "Untranslated Chinese must not request CurseForge's unfiltered catalog"
                );
            }
        }
        for params in requests.lock().unwrap().iter() {
            if params.contains_key("query") {
                let facets: Vec<Vec<String>> = serde_json::from_str(&params["facets"]).unwrap();
                assert!(facets.contains(&vec!["project_type:mod".into()]));
                assert!(facets.contains(&vec!["categories:fabric".into()]));
                assert!(facets.contains(&vec!["categories:technology".into()]));
                if params["query"].is_empty() {
                    assert!(facets
                        .iter()
                        .flatten()
                        .any(|facet| facet.starts_with("slug:")));
                }
            } else {
                assert_eq!(params["classId"], "6");
                assert_eq!(params["modLoaderType"], "4");
                assert_eq!(params["categoryId"], "technology");
                assert!(params["searchFilter"].is_empty());
                assert!(params.contains_key("slug"));
            }
        }
        server.abort();
        let _ = server.await;
    }
}

use super::names::{self, LocalizedName, NameKind};
use crate::{downloads::DownloadSpec, vault::Vault};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

mod dependencies;
mod local_projects;
mod modpack_updates;
pub(super) mod install_metadata;
mod search;
pub use dependencies::{ResourceDependency, ResourceKind};
pub use local_projects::LocalProjectMatch;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Query {
    pub source: String,
    pub kind: String,
    pub query: String,
    pub game_version: String,
    pub loader: String,
    pub category: String,
    pub offset: u32,
    pub limit: u32,
    pub sort: String,
}
impl Default for Query {
    fn default() -> Self {
        Self {
            source: "modrinth".into(),
            kind: "mod".into(),
            query: String::new(),
            game_version: String::new(),
            loader: String::new(),
            category: String::new(),
            offset: 0,
            limit: 20,
            sort: "relevance".into(),
        }
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub source: String,
    pub title: String,
    #[serde(default)]
    pub slug: String,
    #[serde(default)]
    pub localized_name: Option<LocalizedName>,
    pub description: String,
    pub author: String,
    pub icon: String,
    pub downloads: u64,
    pub categories: Vec<String>,
    pub versions: Vec<String>,
    pub website: String,
    pub body: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceFile {
    pub id: String,
    pub name: String,
    pub version: String,
    pub date: String,
    pub game_versions: Vec<String>,
    pub loaders: Vec<String>,
    pub file: Option<DownloadSpec>,
    pub dependencies: Vec<ResourceDependency>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResults {
    pub items: Vec<Project>,
    pub total: u64,
    pub offset: u32,
}
pub struct Community {
    client: reqwest::Client,
    vault: Arc<Vault>,
    dependency_cache: Mutex<dependencies::DependencyCache>,
    sources: Arc<crate::download_sources::SourceSelector>,
    search_cache: search::SearchCache,
}
impl Community {
    pub fn new(vault: Arc<Vault>) -> Result<Self> {
        Ok(Self {
            // A custom x-api-key header must never follow a redirect to another host.
            client: crate::http_client_builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
            vault,
            dependency_cache: Mutex::new(Default::default()),
            sources: Arc::new(crate::download_sources::SourceSelector::default()),
            search_cache: Default::default(),
        })
    }
    pub fn with_sources(mut self, sources: Arc<crate::download_sources::SourceSelector>) -> Self {
        self.sources = sources;
        self
    }
    async fn get(&self, source: &str, path: &str, params: &[(String, String)]) -> Result<Value> {
        self.request(source, path, params, None).await
    }
    fn request_builder(&self, url: &str, body: Option<&Value>) -> Result<reqwest::RequestBuilder> {
        let mut request = match body {
            Some(body) => self.client.post(url).json(body),
            None => self.client.get(url),
        }
        .timeout(std::time::Duration::from_secs(12));
        // Never disclose an official API credential to MCIM or a redirect.
        if official_curseforge_api(url) {
            let key = self
                .vault
                .curseforge_key()
                .map_err(|_| anyhow::anyhow!("CurseForge 暂时不可用，请稍后重试"))?;
            request = request.header("x-api-key", curseforge_header(&key)?);
        }
        Ok(request)
    }
    async fn request(
        &self,
        source: &str,
        path: &str,
        params: &[(String, String)],
        body: Option<Value>,
    ) -> Result<Value> {
        let root = if source == "modrinth" {
            "https://api.modrinth.com/v2"
        } else if source == "curseforge" {
            "https://api.curseforge.com/v1"
        } else {
            bail!("未知资源平台")
        };
        let mut original = reqwest::Url::parse(&format!("{root}/{path}"))?;
        original
            .query_pairs_mut()
            .extend_pairs(params.iter().map(|(key, value)| (key, value)));
        let urls = self.sources.candidates(original.as_str());
        let ordered = self
            .sources
            .order_with(&urls, &tokio_util::sync::CancellationToken::new(), |url| {
                self.request_builder(url, body.as_ref())
            })
            .await?;
        let mut error = None;
        for url in ordered {
            let result = async {
                let response = self.request_builder(&url, body.as_ref())?.send().await?;
                if response.status().is_redirection() {
                    bail!("资源平台返回了不支持的跳转，请稍后重试");
                }
                if matches!(
                    response.status(),
                    reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN
                ) {
                    bail!("资源渠道暂时不可用，请稍后重试");
                }
                if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
                    bail!("资源平台请求过于频繁，请稍后重试");
                }
                Ok::<Value, anyhow::Error>(response.error_for_status()?.json().await?)
            }
            .await;
            match result {
                Ok(value) => return Ok(value),
                Err(failure) => {
                    self.sources.failed(&url).await;
                    error = Some(failure);
                }
            }
        }
        Err(error.unwrap_or_else(|| anyhow::anyhow!("资源渠道暂时不可用，请稍后重试")))
    }
    pub async fn resolve_download_entry(&self, url: &str) -> Result<Option<String>> {
        if !super::curseforge::is_download_entry(url) {
            return Ok(None);
        }
        let parsed = reqwest::Url::parse(url)?;
        let parts = parsed.path().split('/').collect::<Vec<_>>();
        let value = self
            .get(
                "curseforge",
                &format!("mods/{}/files/{}/download-url", parts[4], parts[6]),
                &[],
            )
            .await?;
        let Some(download) = value["data"].as_str() else {
            return Ok(None);
        };
        let mirror_file = reqwest::Url::parse(download).is_ok_and(|url| {
            url.scheme() == "https"
                && url.host_str() == Some("mod.mcimirror.top")
                && url.username().is_empty()
                && url.password().is_none()
                && url.port_or_known_default() == Some(443)
                && url.path().starts_with("/files/")
        });
        Ok(
            (super::curseforge::is_download_cdn(download) || mirror_file)
                .then(|| download.to_string()),
        )
    }
    pub async fn search(&self, q: &Query) -> Result<SearchResults> {
        let slugs = names::search_slugs(&q.kind, &q.source, &q.query);
        if !slugs.is_empty() {
            return self.search_localized(q, &slugs).await;
        }
        let mut query = q.clone();
        query.query = names::search_query(&q.kind, &q.source, &q.query);
        if q.source == "curseforge" && names::contains_han(&query.query) {
            return Ok(SearchResults {
                items: Vec::new(),
                total: 0,
                offset: q.offset,
            });
        }
        self.search_native(&query).await
    }
    async fn search_native(&self, q: &Query) -> Result<SearchResults> {
        let limit = q.limit.clamp(1, 40);
        if q.source == "modrinth" {
            let value = self
                .get(
                    &q.source,
                    "search",
                    &search::modrinth_params(q, limit, &[])?,
                )
                .await?;
            let items = value["hits"]
                .as_array()
                .context("Modrinth 返回格式错误")?
                .iter()
                .map(modrinth_project)
                .collect();
            Ok(SearchResults {
                items,
                total: value["total_hits"].as_u64().unwrap_or(0),
                offset: q.offset,
            })
        } else {
            let value = self
                .get(
                    &q.source,
                    "mods/search",
                    &search::curseforge_params(q, limit, None),
                )
                .await?;
            let items = value["data"]
                .as_array()
                .context("CurseForge 返回格式错误")?
                .iter()
                .map(curseforge_project)
                .collect();
            Ok(SearchResults {
                items,
                total: value["pagination"]["totalCount"].as_u64().unwrap_or(0),
                offset: q.offset,
            })
        }
    }
    pub async fn detail(&self, source: &str, id: &str) -> Result<Project> {
        validate_id(id)?;
        if source == "modrinth" {
            let value = self.get(source, &format!("project/{id}"), &[]).await?;
            Ok(modrinth_project(&value))
        } else {
            let value = self.get(source, &format!("mods/{id}"), &[]).await?;
            let mut project = curseforge_project(&value["data"]);
            let body = self
                .get(source, &format!("mods/{id}/description"), &[])
                .await?;
            project.body = body["data"].as_str().unwrap_or("").into();
            Ok(project)
        }
    }
    pub async fn files(
        &self,
        source: &str,
        id: &str,
        game_version: &str,
        loader: &str,
    ) -> Result<Vec<ResourceFile>> {
        validate_id(id)?;
        let mut files = if source == "modrinth" {
            let mut params = vec![];
            if !game_version.is_empty() {
                params.push(("game_versions".into(), json!([game_version]).to_string()));
            }
            if !loader.is_empty() {
                params.push(("loaders".into(), json!([loader.to_lowercase()]).to_string()));
            }
            let value = self
                .get(source, &format!("project/{id}/version"), &params)
                .await?;
            value
                .as_array()
                .context("资源版本格式错误")?
                .iter()
                .map(modrinth_file)
                .collect::<Result<Vec<_>>>()?
        } else {
            let mut params = vec![("pageSize".into(), "50".into())];
            if !game_version.is_empty() {
                params.push(("gameVersion".into(), game_version.into()));
            }
            let loader_type = match loader.to_lowercase().as_str() {
                "forge" => Some(1),
                "liteloader" => Some(3),
                "fabric" => Some(4),
                "quilt" => Some(5),
                "neoforge" => Some(6),
                _ => None,
            };
            if let Some(loader_type) = loader_type {
                params.push(("modLoaderType".into(), loader_type.to_string()));
            }
            let value = self
                .get(source, &format!("mods/{id}/files"), &params)
                .await?;
            value["data"]
                .as_array()
                .context("资源文件格式错误")?
                .iter()
                .filter(|v| {
                    loader.is_empty()
                        || loader.eq_ignore_ascii_case("datapack")
                        || strings(&v["gameVersions"])
                            .iter()
                            .any(|s| s.eq_ignore_ascii_case(loader))
                })
                .map(|file| curseforge_file(file, id))
                .collect::<Result<Vec<_>>>()?
        };
        self.resolve_dependencies(source, &mut files).await;
        Ok(files)
    }
    pub async fn categories(&self, source: &str, kind: &str) -> Result<Value> {
        if source == "modrinth" {
            // Modrinth exposes datapack categories under the shared mod type.
            let category_kind = if kind == "datapack" { "mod" } else { kind };
            let v = self.get(source, "tag/category", &[]).await?;
            Ok(json!(v
                .as_array()
                .into_iter()
                .flatten()
                .filter(|v| v["project_type"].as_str() == Some(category_kind))
                .map(|v| json!({"id":v["name"],"name":v["name"]}))
                .collect::<Vec<_>>()))
        } else {
            let mut params = vec![("gameId".into(), "432".into())];
            if kind == "datapack" || kind == "modpack" {
                params.push((
                    "classId".into(),
                    if kind == "modpack" { "4471" } else { "6945" }.into(),
                ));
            }
            let v = self.get(source, "categories", &params).await?;
            Ok(json!(v["data"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|v| json!({"id":v["id"].to_string(),"name":v["name"]}))
                .collect::<Vec<_>>()))
        }
    }

    /// Resolve exactly the project/file pair declared by a pack, preserving its
    /// size and hash even when its CDN URL needs the desktop website resolver.
    pub async fn pack_file(&self, project: u64, file: u64) -> Result<DownloadSpec> {
        let value = self
            .get("curseforge", &format!("mods/{project}/files/{file}"), &[])
            .await?;
        let project_value = self
            .get("curseforge", &format!("mods/{project}"), &[])
            .await?;
        pack_file_spec(project, file, &value["data"], &project_value["data"])
    }
}

fn pack_file_spec(
    project: u64,
    file: u64,
    value: &Value,
    project_value: &Value,
) -> Result<DownloadSpec> {
    if value["id"].as_u64() != Some(file)
        || value["modId"].as_u64() != Some(project)
        || project_value["id"].as_u64() != Some(project)
    {
        bail!("CurseForge 返回的项目或文件与整合包清单不一致");
    }
    if project_value["gameId"]
        .as_u64()
        .is_some_and(|game| game != 432)
    {
        bail!("CurseForge 项目不属于 Minecraft");
    }
    let folder = match project_value["classId"].as_u64() {
        Some(6) => "mods",
        Some(12) => "resourcepacks",
        Some(6552) => "shaderpacks",
        Some(6945) => bail!("整合包包含需要指定存档的数据包，请使用包内覆盖文件"),
        _ => bail!("CurseForge 整合包包含不支持的资源类型"),
    };
    let mut spec = curseforge_file(value, &project.to_string())?
        .file
        .context("CurseForge 文件暂时无法下载")?;
    crate::paths::valid_name(&spec.path)?;
    if spec
        .sha1
        .as_ref()
        .is_none_or(|hash| hash.len() != 40 || !hash.bytes().all(|c| c.is_ascii_hexdigit()))
        || spec.size.is_none()
    {
        bail!("CurseForge 文件缺少有效的哈希或大小");
    }
    spec.path = format!("{folder}/{}", spec.path);
    Ok(spec)
}

#[cfg(test)]
mod pack_tests {
    use super::*;
    #[test]
    fn pack_dependencies_use_resource_class_and_validate_pair() {
        let file = json!({"id":99,"modId":42,"fileName":"pack.zip","fileLength":12,"hashes":[{"algo":1,"value":"0123456789012345678901234567890123456789"}]});
        for (class, folder) in [(6, "mods"), (12, "resourcepacks"), (6552, "shaderpacks")] {
            let spec = pack_file_spec(42, 99, &file, &json!({"id":42,"classId":class})).unwrap();
            assert_eq!(spec.path, format!("{folder}/pack.zip"));
            assert!(crate::resources::curseforge::is_download_entry(&spec.url));
            assert_eq!(spec.size, Some(12));
        }
        assert!(pack_file_spec(42, 99, &file, &json!({"id":43,"classId":6})).is_err());
        assert!(pack_file_spec(42, 100, &file, &json!({"id":42,"classId":6})).is_err());
        assert!(pack_file_spec(42, 99, &file, &json!({"id":42,"classId":4471})).is_err());
    }
}

fn official_curseforge_api(value: &str) -> bool {
    reqwest::Url::parse(value).is_ok_and(|url| {
        url.scheme() == "https"
            && url.host_str() == Some("api.curseforge.com")
            && url.username().is_empty()
            && url.password().is_none()
            && url.port_or_known_default() == Some(443)
    })
}

fn curseforge_header(key: &str) -> Result<reqwest::header::HeaderValue> {
    if key.trim().is_empty() {
        bail!("CurseForge 暂时不可用，请稍后重试");
    }
    let mut header = reqwest::header::HeaderValue::from_str(key)
        .map_err(|_| anyhow::anyhow!("CurseForge 暂时不可用，请稍后重试"))?;
    header.set_sensitive(true);
    Ok(header)
}

#[cfg(test)]
mod credential_tests {
    use super::*;
    #[test]
    fn mirror_post_requests_preserve_payload_without_official_credentials() {
        let directory = tempfile::tempdir().unwrap();
        let community = Community::new(Arc::new(Vault::open(directory.path()).unwrap())).unwrap();
        let body = json!({"fingerprints":[123]});
        let request = community
            .request_builder(
                "https://mod.mcimirror.top/curseforge/v1/fingerprints",
                Some(&body),
            )
            .unwrap()
            .build()
            .unwrap();
        assert_eq!(request.method(), reqwest::Method::POST);
        assert!(!request.headers().contains_key("x-api-key"));
        assert_eq!(
            serde_json::from_slice::<Value>(request.body().unwrap().as_bytes().unwrap()).unwrap(),
            body
        );
    }

    #[test]
    fn official_credentials_are_only_attached_to_the_exact_official_api() {
        assert!(official_curseforge_api(
            "https://api.curseforge.com/v1/mods"
        ));
        for url in [
            "https://mod.mcimirror.top/curseforge/v1/mods",
            "https://api.curseforge.com.example.org/v1/mods",
            "https://user@api.curseforge.com/v1/mods",
            "http://api.curseforge.com/v1/mods",
            "https://api.curseforge.com:444/v1/mods",
        ] {
            assert!(!official_curseforge_api(url));
        }
    }

    #[test]
    fn credential_is_redacted_from_request_debug_output() {
        let sample = "test-only-credential";
        let request = reqwest::Client::new()
            .get("https://api.curseforge.com/v1/categories")
            .header("x-api-key", curseforge_header(sample).unwrap())
            .build()
            .unwrap();
        assert!(request.headers()["x-api-key"].is_sensitive());
        assert!(!format!("{request:?}").contains(sample));
    }

    #[test]
    fn missing_and_invalid_credentials_have_only_a_channel_error() {
        for value in ["", "  ", "test-secret\ninvalid"] {
            let error = curseforge_header(value).unwrap_err();
            assert_eq!(error.to_string(), "CurseForge 暂时不可用，请稍后重试");
        }
    }

    #[tokio::test]
    async fn redirects_cannot_forward_the_credential() {
        use axum::{response::Redirect, routing::get, Router};
        use std::sync::atomic::{AtomicUsize, Ordering};

        let forwarded = Arc::new(AtomicUsize::new(0));
        let count = forwarded.clone();
        let app = Router::new()
            .route(
                "/redirect",
                get(|| async { Redirect::temporary("/capture") }),
            )
            .route(
                "/capture",
                get(move || async move {
                    count.fetch_add(1, Ordering::SeqCst);
                    "unexpected redirect"
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let directory = tempfile::tempdir().unwrap();
        let community = Community::new(Arc::new(Vault::open(directory.path()).unwrap())).unwrap();
        let response = community
            .client
            .get(format!("http://{address}/redirect"))
            .header(
                "x-api-key",
                curseforge_header("test-only-credential").unwrap(),
            )
            .send()
            .await
            .unwrap();
        server.abort();
        assert!(response.status().is_redirection());
        assert_eq!(forwarded.load(Ordering::SeqCst), 0);
    }
}

fn validate_id(id: &str) -> Result<()> {
    if id.is_empty()
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        bail!("资源 ID 无效");
    }
    Ok(())
}
fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}
fn modrinth_project(v: &Value) -> Project {
    let id = v["project_id"]
        .as_str()
        .or(v["id"].as_str())
        .unwrap_or("")
        .to_owned();
    let slug = v["slug"].as_str().unwrap_or(&id);
    let kind = v["project_type"].as_str().unwrap_or("mod");
    Project {
        id: id.clone(),
        source: "modrinth".into(),
        title: v["title"].as_str().unwrap_or(&id).into(),
        slug: slug.into(),
        localized_name: project_name(v, "modrinth", &id, slug),
        description: v["description"].as_str().unwrap_or("").into(),
        author: v["author"].as_str().unwrap_or("").into(),
        icon: v["icon_url"].as_str().unwrap_or("").into(),
        downloads: v["downloads"].as_u64().unwrap_or(0),
        categories: strings(&v["categories"]),
        versions: strings(&v["game_versions"])
            .into_iter()
            .chain(strings(&v["versions"]))
            .collect(),
        website: format!("https://modrinth.com/{kind}/{slug}"),
        body: v["body"].as_str().unwrap_or("").into(),
    }
}
fn curseforge_project(v: &Value) -> Project {
    Project {
        id: v["id"].to_string(),
        source: "curseforge".into(),
        title: v["name"].as_str().unwrap_or("").into(),
        slug: v["slug"].as_str().unwrap_or("").into(),
        localized_name: project_name(
            v,
            "curseforge",
            &v["id"].to_string(),
            v["slug"].as_str().unwrap_or(""),
        ),
        description: v["summary"].as_str().unwrap_or("").into(),
        author: v["authors"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| v["name"].as_str())
            .collect::<Vec<_>>()
            .join(", "),
        icon: v["logo"]["url"].as_str().unwrap_or("").into(),
        downloads: v["downloadCount"].as_u64().unwrap_or(0),
        categories: v["categories"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| v["name"].as_str())
            .map(str::to_owned)
            .collect(),
        versions: vec![],
        website: v["links"]["websiteUrl"].as_str().unwrap_or("").into(),
        body: String::new(),
    }
}
fn project_name(v: &Value, source: &str, id: &str, slug: &str) -> Option<LocalizedName> {
    let kind = if source == "modrinth" {
        dependencies::modrinth_kind(v)
    } else {
        dependencies::curseforge_kind(v)
    };
    let kind = match kind {
        ResourceKind::Mod => NameKind::Mod,
        ResourceKind::Modpack => NameKind::Modpack,
        _ => return None,
    };
    names::platform(kind, source, id, slug)
}

#[cfg(test)]
mod project_name_tests {
    use super::*;

    #[tokio::test]
    async fn chinese_searches_reach_both_platforms_with_filters_and_pagination() {
        use axum::{extract::Query as Params, routing::get, Json, Router};
        use std::collections::HashMap;

        let requests = Arc::new(Mutex::new(Vec::new()));
        let captured = requests.clone();
        let app = Router::new().route(
            "/search",
            get(move |Params(params): Params<HashMap<String, String>>| {
                let captured = captured.clone();
                async move {
                    captured.lock().unwrap().push(params.clone());
                    if params.contains_key("query") {
                        Json(json!({
                            "hits": [{"project_id":"AANobbMI", "slug":"sodium", "title":"Sodium", "project_type":"mod"}],
                            "total_hits": 43
                        }))
                    } else {
                        Json(json!({
                            "data": [{"id":328085, "slug":"create", "name":"Create", "classId":6}],
                            "pagination":{"totalCount":43}
                        }))
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let directory = tempfile::tempdir().unwrap();
        let sources = Arc::new(crate::download_sources::SourceSelector::default());
        let community = Community::new(Arc::new(Vault::open(directory.path()).unwrap()))
            .unwrap()
            .with_sources(sources.clone());

        for (source, chinese, english) in [
            ("modrinth", "钠", "Sodium"),
            ("curseforge", "机械动力", "Create"),
        ] {
            // Route both the old and corrected request to the mock, retaining
            // the actual parameters so a regression cannot access a live API.
            for text in [chinese, english] {
                let (root, params) = if source == "modrinth" {
                    (
                        "https://api.modrinth.com/v2/search",
                        vec![
                            ("query", text.to_string()),
                            (
                                "facets",
                                json!([
                                    ["project_type:mod"],
                                    ["versions:1.20.1"],
                                    ["categories:fabric"],
                                    ["categories:technology"]
                                ])
                                .to_string(),
                            ),
                            ("offset", "20".into()),
                            ("limit", "20".into()),
                            ("index", "downloads".into()),
                        ],
                    )
                } else {
                    (
                        "https://api.curseforge.com/v1/mods/search",
                        vec![
                            ("gameId", "432".into()),
                            ("classId", "6".into()),
                            ("searchFilter", text.to_string()),
                            ("index", "20".into()),
                            ("pageSize", "20".into()),
                            ("sortField", "6".into()),
                            ("sortOrder", "desc".into()),
                            ("gameVersion", "1.20.1".into()),
                            ("modLoaderType", "4".into()),
                            ("categoryId", "technology".into()),
                        ],
                    )
                };
                let mut original = reqwest::Url::parse(root).unwrap();
                original.query_pairs_mut().extend_pairs(&params);
                let mut mock = reqwest::Url::parse(&format!("http://{address}/search")).unwrap();
                mock.set_query(original.query());
                sources.register(original.as_str(), vec![mock.into()]);
            }
            let query = Query {
                source: source.into(),
                query: chinese.into(),
                game_version: "1.20.1".into(),
                loader: "Fabric".into(),
                category: "technology".into(),
                sort: "downloads".into(),
                offset: 20,
                limit: 20,
                ..Query::default()
            };
            let result = community.search(&query).await.unwrap();
            assert_eq!(query.query, chinese);
            assert_eq!(result.total, 43);
            assert_eq!(result.offset, 20);
            assert_eq!(result.items.len(), 1);
            assert_eq!(result.items[0].title, english);
            assert_eq!(
                result.items[0].localized_name.as_ref().unwrap().name,
                chinese
            );

            let requests = requests.lock().unwrap();
            let params = requests.last().unwrap();
            if source == "modrinth" {
                assert_eq!(params["query"], english);
                assert_eq!(params["index"], "downloads");
                assert_eq!(params["offset"], "20");
                assert_eq!(params["limit"], "20");
                let facets: Value = serde_json::from_str(&params["facets"]).unwrap();
                assert_eq!(
                    facets,
                    json!([
                        ["project_type:mod"],
                        ["versions:1.20.1"],
                        ["categories:fabric"],
                        ["categories:technology"]
                    ])
                );
            } else {
                assert_eq!(params["searchFilter"], english);
                assert_eq!(params["gameVersion"], "1.20.1");
                assert_eq!(params["modLoaderType"], "4");
                assert_eq!(params["categoryId"], "technology");
                assert_eq!(params["sortField"], "6");
                assert_eq!(params["index"], "20");
                assert_eq!(params["pageSize"], "20");
            }
        }
        server.abort();
        let _ = server.await;
    }

    #[test]
    fn translates_platform_projects_with_resource_type_boundaries() {
        let mod_value = json!({"id":"AANobbMI","slug":"sodium","title":"Sodium","project_type":"mod","description":"Original description"});
        let project = modrinth_project(&mod_value);
        assert_eq!(project.title, "Sodium");
        assert_eq!(project.slug, "sodium");
        assert_eq!(project.description, "Original description");
        assert_eq!(project.localized_name.unwrap().name, "钠");
        let mut shader_value = mod_value.clone();
        shader_value["project_type"] = json!("shader");
        let shader = modrinth_project(&shader_value);
        assert!(shader.localized_name.is_none());
        let datapack = modrinth_project(
            &json!({"id":"AANobbMI","slug":"sodium","title":"Sodium","project_type":"mod","loaders":["datapack"]}),
        );
        assert!(datapack.localized_name.is_none());
        let pack = curseforge_project(
            &json!({"id":297724,"slug":"skyfactory-4","name":"SkyFactory 4","classId":4471}),
        );
        assert_eq!(pack.title, "SkyFactory 4");
        assert_eq!(pack.localized_name.unwrap().name, "天空工厂4");
        let resourcepack = curseforge_project(
            &json!({"id":297724,"slug":"skyfactory-4","name":"SkyFactory 4","classId":12}),
        );
        assert!(resourcepack.localized_name.is_none());
    }
}
fn modrinth_file(v: &Value) -> Result<ResourceFile> {
    let files = v["files"].as_array().context("资源版本缺少文件")?;
    let file = files
        .iter()
        .find(|f| f["primary"].as_bool() == Some(true))
        .or(files.first());
    let download = file.map(|f| DownloadSpec {
        url: f["url"].as_str().unwrap_or("").into(),
        path: f["filename"].as_str().unwrap_or("").into(),
        size: f["size"].as_u64(),
        sha1: f["hashes"]["sha1"].as_str().map(str::to_owned),
        sha512: f["hashes"]["sha512"].as_str().map(str::to_owned),
    });
    Ok(ResourceFile {
        id: v["id"].as_str().unwrap_or("").into(),
        name: v["name"].as_str().unwrap_or("").into(),
        version: v["version_number"].as_str().unwrap_or("").into(),
        date: v["date_published"].as_str().unwrap_or("").into(),
        game_versions: strings(&v["game_versions"]),
        loaders: strings(&v["loaders"]),
        file: download,
        dependencies: v["dependencies"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|d| d["dependency_type"] == "required")
            .filter_map(ResourceDependency::from_modrinth)
            .collect(),
    })
}
fn curseforge_file(v: &Value, project_id: &str) -> Result<ResourceFile> {
    let sha1 = v["hashes"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|h| h["algo"] == 1)
        .and_then(|h| h["value"].as_str())
        .map(str::to_owned);
    let download = v["downloadUrl"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .or_else(|| super::curseforge::download_entry(project_id, v["id"].as_u64()?))
        .map(|url| DownloadSpec {
            url,
            path: v["fileName"].as_str().unwrap_or("").into(),
            size: v["fileLength"].as_u64(),
            sha1,
            sha512: None,
        });
    let versions = strings(&v["gameVersions"]);
    let loaders = versions
        .iter()
        .filter(|s| ["Forge", "Fabric", "Quilt", "NeoForge", "LiteLoader"].contains(&s.as_str()))
        .cloned()
        .collect();
    Ok(ResourceFile {
        id: v["id"].to_string(),
        name: v["displayName"].as_str().unwrap_or("").into(),
        version: v["displayName"].as_str().unwrap_or("").into(),
        date: v["fileDate"].as_str().unwrap_or("").into(),
        game_versions: versions,
        loaders,
        file: download,
        dependencies: v["dependencies"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|d| d["relationType"] == 3)
            .filter_map(ResourceDependency::from_curseforge)
            .collect(),
    })
}

#[cfg(test)]
mod file_tests {
    use super::*;

    #[test]
    fn missing_download_urls_keep_file_metadata_and_use_the_website() {
        let mut value = json!({
            "id": 1234567, "fileName": "example.jar", "fileLength": 2048,
            "hashes": [{"algo": 1, "value": "expected-sha1"}],
            "gameVersions": ["1.20.1", "Forge"]
        });
        for url in [None, Some(Value::Null), Some(json!("")), Some(json!("  "))] {
            if let Some(url) = url {
                value["downloadUrl"] = url;
            } else {
                value.as_object_mut().unwrap().remove("downloadUrl");
            }
            let file = curseforge_file(&value, "306612").unwrap().file.unwrap();
            assert_eq!(
                file.url,
                "https://www.curseforge.com/api/v1/mods/306612/files/1234567/download"
            );
            assert_eq!(file.path, "example.jar");
            assert_eq!(file.size, Some(2048));
            assert_eq!(file.sha1.as_deref(), Some("expected-sha1"));
        }
        value["downloadUrl"] = json!("https://edge.forgecdn.net/files/1234/567/example.jar");
        assert_eq!(
            curseforge_file(&value, "306612").unwrap().file.unwrap().url,
            value["downloadUrl"].as_str().unwrap()
        );
        value.as_object_mut().unwrap().remove("downloadUrl");
        value["id"] = Value::Null;
        assert!(curseforge_file(&value, "306612").unwrap().file.is_none());
    }
}

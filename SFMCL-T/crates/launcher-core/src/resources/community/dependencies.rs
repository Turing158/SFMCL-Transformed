use super::{strings, validate_id, Community, ResourceFile};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeSet, HashMap, HashSet},
    time::{Duration, Instant},
};

const CACHE_TTL: Duration = Duration::from_secs(15 * 60);
const CACHE_LIMIT: usize = 1024;
const LOOKUP_TIMEOUT: Duration = Duration::from_secs(8);
const BATCH_SIZE: usize = 100;

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ResourceKind {
    Mod,
    Resourcepack,
    Shader,
    Modpack,
    Datapack,
    World,
    Plugin,
    #[default]
    Unknown,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceDependency {
    pub project_id: Option<String>,
    pub version_id: Option<String>,
    pub name: Option<String>,
    pub kind: ResourceKind,
}

impl ResourceDependency {
    pub(super) fn from_modrinth(value: &Value) -> Option<Self> {
        let project_id = resource_id(&value["project_id"]);
        let version_id = resource_id(&value["version_id"]);
        // Some required dependencies are standalone files without a project.
        let name = value["file_name"]
            .as_str()
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(str::to_owned);
        if project_id.is_none() && version_id.is_none() && name.is_none() {
            return None;
        }
        Some(Self {
            name: if project_id.is_none() && version_id.is_none() {
                name
            } else {
                None
            },
            project_id,
            version_id,
            kind: ResourceKind::Unknown,
        })
    }

    pub(super) fn from_curseforge(value: &Value) -> Option<Self> {
        Some(Self {
            project_id: Some(value["modId"].as_u64().filter(|id| *id > 0)?.to_string()),
            ..Self::default()
        })
    }
}

#[derive(Default)]
pub(super) struct DependencyCache {
    projects: HashMap<(String, String), (Instant, String, ResourceKind)>,
}

impl DependencyCache {
    fn prune(&mut self) {
        self.projects
            .retain(|_, (created, _, _)| created.elapsed() < CACHE_TTL);
    }

    fn insert_projects(&mut self, source: &str, requested: &[String], value: &Value) {
        let projects = if source == "modrinth" {
            value
        } else {
            &value["data"]
        };
        for project in projects.as_array().into_iter().flatten() {
            let id = if source == "modrinth" {
                resource_id(&project["id"])
            } else {
                project["id"].as_u64().map(|id| id.to_string())
            };
            let Some(id) = id.filter(|id| requested.contains(id)) else {
                continue;
            };
            let name_field = if source == "modrinth" {
                "title"
            } else {
                "name"
            };
            let Some(name) = project[name_field]
                .as_str()
                .map(str::trim)
                .filter(|name| !name.is_empty())
            else {
                // Failures and incomplete metadata are retried on the next files request.
                continue;
            };
            let kind = if source == "modrinth" {
                modrinth_kind(project)
            } else {
                curseforge_kind(project)
            };
            if self.projects.len() >= CACHE_LIMIT {
                if let Some(oldest) = self
                    .projects
                    .iter()
                    .min_by_key(|(_, (created, _, _))| *created)
                    .map(|(key, _)| key.clone())
                {
                    self.projects.remove(&oldest);
                }
            }
            self.projects.insert(
                (source.to_owned(), id),
                (Instant::now(), name.to_owned(), kind),
            );
        }
    }

    fn apply(&self, source: &str, files: &mut [ResourceFile]) {
        for file in files {
            for dependency in &mut file.dependencies {
                if let Some(id) = &dependency.project_id {
                    if let Some((_, name, kind)) =
                        self.projects.get(&(source.to_owned(), id.clone()))
                    {
                        dependency.name = Some(name.clone());
                        dependency.kind = *kind;
                    }
                }
            }
            let mut seen = HashSet::new();
            file.dependencies.retain(|dependency| {
                let key = if let Some(id) = &dependency.project_id {
                    format!("project:{id}")
                } else if let Some(id) = &dependency.version_id {
                    format!("version:{id}")
                } else {
                    format!("file:{}", dependency.name.as_deref().unwrap_or_default())
                };
                seen.insert(key)
            });
        }
    }
}

impl Community {
    pub(super) async fn resolve_dependencies(&self, source: &str, files: &mut [ResourceFile]) {
        self.dependency_cache.lock().unwrap().prune();
        // Metadata is supplementary: a slow or unavailable project must not hide files.
        let _ = tokio::time::timeout(LOOKUP_TIMEOUT, self.fetch_dependencies(source, files)).await;
        self.dependency_cache.lock().unwrap().apply(source, files);
    }

    async fn fetch_dependencies(&self, source: &str, files: &mut [ResourceFile]) {
        if source == "modrinth" {
            let versions = files
                .iter()
                .flat_map(|file| &file.dependencies)
                .filter(|dependency| dependency.project_id.is_none())
                .filter_map(|dependency| dependency.version_id.clone())
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect::<Vec<_>>();
            for ids in versions.chunks(BATCH_SIZE) {
                if let Ok(value) = self
                    .get(
                        source,
                        "versions",
                        &[("ids".into(), json!(ids).to_string())],
                    )
                    .await
                {
                    assign_modrinth_projects(files, &value);
                }
            }
        }
        let missing = {
            let cache = self.dependency_cache.lock().unwrap();
            files
                .iter()
                .flat_map(|file| &file.dependencies)
                .filter_map(|dependency| dependency.project_id.as_ref())
                .filter(|id| {
                    !cache
                        .projects
                        .contains_key(&(source.to_owned(), (*id).clone()))
                })
                .cloned()
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect::<Vec<_>>()
        };
        for ids in missing.chunks(BATCH_SIZE) {
            let result = match source {
                "modrinth" => {
                    self.get(
                        source,
                        "projects",
                        &[("ids".into(), json!(ids).to_string())],
                    )
                    .await
                }
                "curseforge" => {
                    let mod_ids = ids
                        .iter()
                        .filter_map(|id| id.parse::<u64>().ok())
                        .collect::<Vec<_>>();
                    self.request(source, "mods", &[], Some(json!({ "modIds": mod_ids })))
                        .await
                }
                _ => return,
            };
            if let Ok(value) = result {
                self.dependency_cache
                    .lock()
                    .unwrap()
                    .insert_projects(source, ids, &value);
            }
        }
    }
}

fn resource_id(value: &Value) -> Option<String> {
    value
        .as_str()
        .filter(|id| validate_id(id).is_ok())
        .map(str::to_owned)
}

fn assign_modrinth_projects(files: &mut [ResourceFile], value: &Value) {
    let projects = value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|version| {
            Some((
                resource_id(&version["id"])?,
                resource_id(&version["project_id"])?,
            ))
        })
        .collect::<HashMap<_, _>>();
    for dependency in files.iter_mut().flat_map(|file| &mut file.dependencies) {
        if dependency.project_id.is_none() {
            dependency.project_id = dependency
                .version_id
                .as_ref()
                .and_then(|id| projects.get(id).cloned());
        }
    }
}

fn modrinth_kind(project: &Value) -> ResourceKind {
    let loaders = strings(&project["loaders"]);
    match project["project_type"].as_str() {
        Some("mod") => {
            if !loaders.is_empty() && loaders.iter().all(|loader| loader == "datapack") {
                ResourceKind::Datapack
            } else if !loaders.is_empty()
                && loaders.iter().all(|loader| {
                    [
                        "bukkit",
                        "spigot",
                        "paper",
                        "purpur",
                        "sponge",
                        "folia",
                        "bungeecord",
                        "waterfall",
                        "velocity",
                    ]
                    .contains(&loader.as_str())
                })
            {
                ResourceKind::Plugin
            } else {
                ResourceKind::Mod
            }
        }
        Some("resourcepack") => ResourceKind::Resourcepack,
        Some("shader") => ResourceKind::Shader,
        Some("modpack") => ResourceKind::Modpack,
        Some("datapack") => ResourceKind::Datapack,
        Some("plugin") => ResourceKind::Plugin,
        _ => ResourceKind::Unknown,
    }
}

fn curseforge_kind(project: &Value) -> ResourceKind {
    match project["classId"].as_u64() {
        Some(6) => ResourceKind::Mod,
        Some(12) => ResourceKind::Resourcepack,
        Some(6552) => ResourceKind::Shader,
        Some(4471) => ResourceKind::Modpack,
        Some(6945) => ResourceKind::Datapack,
        Some(17) => ResourceKind::World,
        Some(5) => ResourceKind::Plugin,
        _ => ResourceKind::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        resources::community::{curseforge_file, modrinth_file},
        vault::Vault,
    };
    use std::sync::Arc;

    fn modrinth_files(dependencies: Value) -> Vec<ResourceFile> {
        vec![modrinth_file(&json!({
            "id": "file", "files": [{"url": "https://example.com/mod.jar", "filename": "mod.jar"}],
            "dependencies": dependencies
        }))
        .unwrap()]
    }

    #[test]
    fn only_required_dependencies_are_kept_including_version_and_filename_references() {
        let files = modrinth_files(json!([
            {"dependency_type": "required", "project_id": "sodium"},
            {"dependency_type": "required", "version_id": "version-only"},
            {"dependency_type": "required", "file_name": "local-library.jar"},
            {"dependency_type": "optional", "project_id": "optional-mod"},
            {"dependency_type": "incompatible", "project_id": "incompatible-mod"},
            {"dependency_type": "embedded", "project_id": "bundled-mod"},
            {"dependency_type": "required", "project_id": "../invalid"},
            {"dependency_type": "required"}
        ]));
        assert_eq!(files[0].dependencies.len(), 3);
        assert_eq!(
            files[0].dependencies[0].project_id.as_deref(),
            Some("sodium")
        );
        assert_eq!(
            files[0].dependencies[1].version_id.as_deref(),
            Some("version-only")
        );
        assert_eq!(
            files[0].dependencies[2].name.as_deref(),
            Some("local-library.jar")
        );
        let file = curseforge_file(
            &json!({"dependencies": [
                {"relationType": 3, "modId": 306612},
                {"relationType": 2, "modId": 2},
                {"relationType": 5, "modId": 3},
                {"relationType": 3, "modId": null},
                {"relationType": 3, "modId": 0}
            ]}),
            "123",
        )
        .unwrap();
        assert_eq!(file.dependencies.len(), 1);
        assert_eq!(file.dependencies[0].project_id.as_deref(), Some("306612"));
    }

    #[test]
    fn version_only_dependencies_resolve_to_project_names_and_duplicates_collapse() {
        let mut files = modrinth_files(json!([
            {"dependency_type": "required", "version_id": "version-only"},
            {"dependency_type": "required", "project_id": "sodium"},
            {"dependency_type": "required", "version_id": "unavailable"}
        ]));
        assign_modrinth_projects(
            &mut files,
            &json!([
                {"id": "version-only", "project_id": "sodium"},
                {"id": "unrelated-version", "project_id": "unrelated"}
            ]),
        );
        let mut cache = DependencyCache::default();
        cache.insert_projects(
            "modrinth",
            &["sodium".into()],
            &json!([
                {"id": "sodium", "title": "Sodium", "project_type": "mod", "loaders": ["fabric"]}
            ]),
        );
        cache.apply("modrinth", &mut files);
        assert_eq!(files[0].dependencies.len(), 2);
        let dependency = &files[0].dependencies[0];
        assert_eq!(dependency.project_id.as_deref(), Some("sodium"));
        assert_eq!(dependency.version_id.as_deref(), Some("version-only"));
        assert_eq!(dependency.name.as_deref(), Some("Sodium"));
        assert_eq!(dependency.kind, ResourceKind::Mod);
        assert!(files[0].dependencies[1].name.is_none());
        let serialized = serde_json::to_value(dependency).unwrap();
        assert_eq!(serialized["kind"], "mod");
        assert_eq!(serialized["projectId"], "sodium");
    }

    #[test]
    fn resource_types_follow_platform_metadata_instead_of_assuming_mods() {
        for (project_type, expected) in [
            ("mod", ResourceKind::Mod),
            ("resourcepack", ResourceKind::Resourcepack),
            ("shader", ResourceKind::Shader),
            ("modpack", ResourceKind::Modpack),
            ("datapack", ResourceKind::Datapack),
            ("plugin", ResourceKind::Plugin),
            ("future-type", ResourceKind::Unknown),
        ] {
            assert_eq!(
                modrinth_kind(&json!({"project_type": project_type})),
                expected
            );
        }
        assert_eq!(
            modrinth_kind(&json!({"project_type": "mod", "loaders": ["datapack"]})),
            ResourceKind::Datapack
        );
        assert_eq!(
            modrinth_kind(&json!({"project_type": "mod", "loaders": ["paper", "spigot"]})),
            ResourceKind::Plugin
        );
        assert_eq!(
            modrinth_kind(&json!({"project_type": "mod", "loaders": ["fabric", "datapack"]})),
            ResourceKind::Mod
        );
        assert_eq!(
            modrinth_kind(&json!({"project_type": "resourcepack", "loaders": ["optifine"]})),
            ResourceKind::Resourcepack
        );
        assert_eq!(modrinth_kind(&json!({})), ResourceKind::Unknown);
        for (class, expected) in [
            (6, ResourceKind::Mod),
            (12, ResourceKind::Resourcepack),
            (6552, ResourceKind::Shader),
            (4471, ResourceKind::Modpack),
            (6945, ResourceKind::Datapack),
            (17, ResourceKind::World),
            (5, ResourceKind::Plugin),
            (9999, ResourceKind::Unknown),
        ] {
            assert_eq!(curseforge_kind(&json!({"classId": class})), expected);
        }
    }

    #[test]
    fn partial_results_are_cached_per_platform_without_caching_failures() {
        let mut cache = DependencyCache::default();
        let requested = vec!["123".into(), "missing".into(), "blank".into()];
        cache.insert_projects(
            "modrinth",
            &requested,
            &json!([
                {"id": "123", "title": "Modrinth Pack", "project_type": "resourcepack"},
                {"id": "blank", "title": " "},
                {"id": "unrequested", "title": "Unrelated"}
            ]),
        );
        cache.insert_projects(
            "curseforge",
            &requested,
            &json!({"data": [
                {"id": 123, "name": "CurseForge Shader", "classId": 6552}
            ]}),
        );
        assert_eq!(cache.projects.len(), 2);
        let mut files = modrinth_files(json!([
            {"dependency_type": "required", "project_id": "123"},
            {"dependency_type": "required", "project_id": "missing"}
        ]));
        cache.apply("modrinth", &mut files);
        assert_eq!(
            files[0].dependencies[0].name.as_deref(),
            Some("Modrinth Pack")
        );
        assert_eq!(files[0].dependencies[0].kind, ResourceKind::Resourcepack);
        assert!(files[0].dependencies[1].name.is_none());
        cache.apply("curseforge", &mut files);
        assert_eq!(
            files[0].dependencies[0].name.as_deref(),
            Some("CurseForge Shader")
        );
        assert_eq!(files[0].dependencies[0].kind, ResourceKind::Shader);
        cache
            .projects
            .get_mut(&("modrinth".into(), "123".into()))
            .unwrap()
            .0 = Instant::now() - CACHE_TTL;
        cache.prune();
        assert_eq!(cache.projects.len(), 1);
        assert!(cache
            .projects
            .contains_key(&("curseforge".into(), "123".into())));
    }

    #[tokio::test]
    async fn unavailable_metadata_preserves_downloads_and_cached_names() {
        // Reject the local proxy tunnel so this test never contacts a live service.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = axum::Router::new().fallback(|| async { axum::http::StatusCode::BAD_GATEWAY });
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let directory = tempfile::tempdir().unwrap();
        let mut community =
            Community::new(Arc::new(Vault::open(directory.path()).unwrap())).unwrap();
        community.client = reqwest::Client::builder()
            .proxy(reqwest::Proxy::all(format!("http://{address}")).unwrap())
            .build()
            .unwrap();
        community.dependency_cache.lock().unwrap().insert_projects(
            "modrinth",
            &["cached".into()],
            &json!([
                {"id": "cached", "title": "Cached Library", "project_type": "mod"}
            ]),
        );
        let mut files = modrinth_files(json!([
            {"dependency_type": "required", "project_id": "cached"},
            {"dependency_type": "required", "project_id": "unavailable"}
        ]));
        let result = tokio::time::timeout(
            Duration::from_secs(2),
            community.resolve_dependencies("modrinth", &mut files),
        )
        .await;
        server.abort();
        result.unwrap();
        assert_eq!(
            files[0].file.as_ref().unwrap().url,
            "https://example.com/mod.jar"
        );
        assert_eq!(
            files[0].dependencies[0].name.as_deref(),
            Some("Cached Library")
        );
        assert_eq!(files[0].dependencies[1].kind, ResourceKind::Unknown);
        assert!(files[0].dependencies[1].name.is_none());
        assert_eq!(community.dependency_cache.lock().unwrap().projects.len(), 1);
    }
}

use super::{
    loaders,
    versions::{self, spec},
};
use crate::{
    config::Settings,
    downloads::{DownloadManager, DownloadSpec},
    jobs::{self, Job, JobKind, Jobs},
    paths::{atomic_write, safe_join, valid_name},
};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::Arc,
};

pub const MANIFEST: &str = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
pub const BMCL: &str = "https://bmclapi2.bangbang93.com";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallRequest {
    pub minecraft: String,
    pub name: String,
    pub root: PathBuf,
    pub loader: Option<loaders::LoaderChoice>,
    pub optifine: Option<loaders::LoaderChoice>,
    pub fabric_api: Option<DownloadSpec>,
}

pub struct Installer {
    pub downloads: Arc<DownloadManager>,
    pub jobs: Arc<Jobs>,
    pub client: reqwest::Client,
    pub settings: Arc<crate::config::ConfigStore>,
}
impl Installer {
    pub async fn start(self: &Arc<Self>, request: InstallRequest) -> Result<String> {
        loaders::validate_selection(&request)?;
        valid_name(&request.name)?;
        valid_name(&request.minecraft)?;
        if !request.root.is_absolute() {
            bail!("请选择有效的游戏目录");
        }
        let lock_path = safe_join(&request.root, format!(".tmcl/locks/{}.lock", request.name))?;
        std::fs::create_dir_all(lock_path.parent().unwrap())?;
        let lock = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(lock_path)?;
        lock.try_lock().context("该版本正在另一个安装任务中")?;
        let profile = safe_join(
            &request.root,
            format!("versions/{0}/{0}.json", request.name),
        )?;
        if profile.exists() {
            bail!("版本名称已存在，请选择其他名称");
        }
        let job = self.jobs.create(
            JobKind::Install,
            format!("安装 {}", request.name),
            &[
                "准备版本信息",
                "解析资源与依赖",
                "下载游戏文件",
                "安装加载器",
                "校验启动文件",
                "完成安装",
            ],
        );
        let id = job.snapshot().id;
        let installer = self.clone();
        tokio::spawn(async move {
            let _lock = lock;
            let result = installer.install_in_job(&request, job.clone(), 0).await;
            job.finish(&result);
        });
        Ok(id)
    }
    pub async fn manifest(&self) -> Result<Value> {
        get_json(&self.client, MANIFEST, None).await
    }
    pub async fn base_version(&self, id: &str, job: &Job) -> Result<Value> {
        let manifest = get_json(&self.client, MANIFEST, Some(job)).await?;
        let item = manifest["versions"]
            .as_array()
            .context("版本清单格式无效")?
            .iter()
            .find(|v| v["id"].as_str() == Some(id))
            .context("官方清单没有此 Minecraft 版本")?;
        let url = item["url"].as_str().context("版本缺少元数据地址")?;
        let bytes = get_bytes(&self.client, url, Some(job)).await?;
        if let Some(hash) = item["sha1"].as_str() {
            use sha1::Digest;
            if hex::encode(sha1::Sha1::digest(&bytes)) != hash {
                bail!("版本 JSON 哈希校验失败");
            }
        }
        Ok(serde_json::from_slice(&bytes)?)
    }
    pub(crate) async fn install_in_job(
        &self,
        request: &InstallRequest,
        job: Arc<Job>,
        offset: usize,
    ) -> Result<()> {
        job.step(offset, "获取 Minecraft 官方版本信息");
        let mut base = self.base_version(&request.minecraft, &job).await?;
        base["id"] = json!(request.name);
        base["jar"] = json!(request.name);
        base["clientVersion"] = json!(request.minecraft);
        let work = safe_join(
            &request.root,
            format!(".tmcl/install/{}", job.snapshot().id),
        )?;
        std::fs::create_dir_all(&work)?;
        atomic_write(
            &work.join("request.json"),
            &serde_json::to_vec_pretty(request)?,
        )?;
        job.step(offset + 1, "读取资源索引、平台依赖和客户端清单");
        let files = self.resolve_files(&request.root, &base, &job).await?;
        job.step(offset + 2, format!("下载并校验 {} 个文件", files.len()));
        jobs::download(
            &self.downloads,
            &job,
            format!("{} · 游戏文件", request.name),
            request.root.clone(),
            files,
        )
        .await?;
        job.step(offset + 3, "准备加载器");
        let mut profile = base.clone();
        if let Some(choice) = &request.loader {
            profile = loaders::install(self, request, &base, choice, &work, job.clone()).await?;
        }
        if let Some(optifine) = &request.optifine {
            if request.loader.as_ref().is_none_or(|l| l.kind != "Forge") {
                bail!("附加 OptiFine 仅用于兼容的 Forge 安装");
            }
            loaders::install_optifine_mod(self, request, optifine, &work, job.clone()).await?;
        }
        if let Some(api) = &request.fabric_api {
            if request.loader.as_ref().is_none_or(|l| l.kind != "Fabric") {
                bail!("Fabric API 需要 Fabric Loader");
            }
            let mut api = api.clone();
            let file = Path::new(&api.path)
                .file_name()
                .context("Fabric API 文件名为空")?
                .to_string_lossy()
                .into_owned();
            let directory = versions::game_directory(
                &request.root,
                &request.name,
                self.settings.get().isolation,
            )?;
            api.path = directory
                .join("mods")
                .join(&file)
                .strip_prefix(&request.root)?
                .to_string_lossy()
                .into_owned();
            jobs::download(
                &self.downloads,
                &job,
                "Fabric API".into(),
                request.root.clone(),
                vec![api],
            )
            .await?;
        }
        job.step(offset + 4, "检查依赖库、native 与版本配置");
        let libs = versions::libraries(&profile)?;
        for lib in &libs {
            if !safe_join(&request.root, &lib.file.path)?.exists() {
                bail!("加载器安装后仍缺少依赖：{}", lib.file.path);
            }
        }
        versions::extract_natives(&request.root, &request.name, &libs)?;
        self.materialize_assets(&request.root, &profile, &self.settings.get())?;
        if job.cancel.is_cancelled() {
            bail!(job.cancellation_message());
        }
        profile["id"] = json!(request.name);
        profile["jar"] = json!(request.name);
        profile
            .as_object_mut()
            .context("版本配置不是对象")?
            .remove("inheritsFrom");
        atomic_write(
            &safe_join(
                &request.root,
                format!("versions/{0}/{0}.json", request.name),
            )?,
            &serde_json::to_vec_pretty(&profile)?,
        )?;
        job.step(offset + 5, "游戏版本已就绪");
        Ok(())
    }
    pub async fn resolve_files(
        &self,
        root: &Path,
        version: &Value,
        job: &Job,
    ) -> Result<Vec<DownloadSpec>> {
        let mut files: Vec<_> = versions::libraries(version)?
            .into_iter()
            .filter(|l| !l.file.url.is_empty())
            .map(|l| l.file)
            .collect();
        let id = version["jar"]
            .as_str()
            .or(version["id"].as_str())
            .context("版本缺少 ID")?;
        let client = &version["downloads"]["client"];
        if let Some(url) = client["url"].as_str() {
            files.push(spec(client, format!("versions/{id}/{id}.jar"), url.into()));
        }
        let logging = &version["logging"]["client"]["file"];
        if let (Some(id), Some(url)) = (logging["id"].as_str(), logging["url"].as_str()) {
            files.push(spec(
                logging,
                format!("assets/log_configs/{id}"),
                url.into(),
            ));
        }
        let asset = &version["assetIndex"];
        if let (Some(id), Some(url)) = (asset["id"].as_str(), asset["url"].as_str()) {
            let path = format!("assets/indexes/{id}.json");
            jobs::download_session(
                &self.downloads,
                job,
                "资源索引".into(),
                root.into(),
                vec![spec(asset, path.clone(), url.into())],
            )
            .await?;
            let index: Value = serde_json::from_slice(&std::fs::read(safe_join(root, path)?)?)?;
            for object in index["objects"]
                .as_object()
                .context("资源索引缺少 objects")?
                .values()
            {
                let hash = object["hash"].as_str().context("资源哈希缺失")?;
                if hash.len() != 40 || !hash.bytes().all(|c| c.is_ascii_hexdigit()) {
                    bail!("无效资源哈希");
                }
                files.push(DownloadSpec {
                    path: format!("assets/objects/{}/{hash}", &hash[..2]),
                    url: format!(
                        "https://resources.download.minecraft.net/{}/{hash}",
                        &hash[..2]
                    ),
                    size: object["size"].as_u64(),
                    sha1: Some(hash.into()),
                    sha512: None,
                });
            }
        }
        let mut seen = HashSet::new();
        files.retain(|f| seen.insert(f.path.to_lowercase()));
        files.retain(|f| {
            !(f.sha1.is_none()
                && f.sha512.is_none()
                && safe_join(root, &f.path).is_ok_and(|p| p.is_file()))
        });
        Ok(files)
    }
    pub async fn repair(&self, root: &Path, id: &str, job: Arc<Job>) -> Result<()> {
        job.step(0, "解析本地版本");
        let version = versions::resolve(root, id)?;
        job.step(1, "获取资源索引");
        let files = self.resolve_files(root, &version, &job).await?;
        job.step(2, "补全并校验文件");
        jobs::download(
            &self.downloads,
            &job,
            format!("修复 {id}"),
            root.into(),
            files,
        )
        .await?;
        job.step(3, "提取 native");
        versions::extract_natives(root, id, &versions::libraries(&version)?)?;
        let settings = super::version_settings::resolve(root, id, &self.settings.get())?;
        self.materialize_assets(root, &version, &settings)?;
        Ok(())
    }
    pub fn materialize_assets(
        &self,
        root: &Path,
        version: &Value,
        settings: &Settings,
    ) -> Result<()> {
        let Some(id) = version["assetIndex"]["id"].as_str() else {
            return Ok(());
        };
        let index: Value = serde_json::from_slice(&std::fs::read(safe_join(
            root,
            format!("assets/indexes/{id}.json"),
        )?)?)?;
        let virtual_assets = index["virtual"].as_bool().unwrap_or(false);
        let map_to_resources = index["map_to_resources"].as_bool().unwrap_or(false);
        if !virtual_assets && !map_to_resources {
            return Ok(());
        }
        let game = versions::game_directory(
            root,
            version["id"].as_str().context("缺少版本 ID")?,
            settings.isolation,
        )?;
        for (name, asset) in index["objects"].as_object().context("资源索引格式错误")? {
            let hash = asset["hash"].as_str().context("缺少资源哈希")?;
            if hash.len() != 40 {
                bail!("资源哈希无效");
            }
            let source = safe_join(root, format!("assets/objects/{}/{hash}", &hash[..2]))?;
            let mut targets = Vec::new();
            if virtual_assets {
                targets.push(safe_join(root, format!("assets/virtual/{id}/{name}"))?);
            }
            if map_to_resources {
                targets.push(safe_join(&game, format!("resources/{name}"))?);
            }
            for target in targets {
                std::fs::create_dir_all(target.parent().unwrap())?;
                std::fs::copy(&source, target)?;
            }
        }
        Ok(())
    }
}
pub async fn get_bytes(client: &reqwest::Client, url: &str, job: Option<&Job>) -> Result<Vec<u8>> {
    let request = async {
        Ok::<_, anyhow::Error>(
            client
                .get(url)
                .send()
                .await?
                .error_for_status()?
                .bytes()
                .await?
                .to_vec(),
        )
    };
    if let Some(job) = job {
        tokio::select! { _ = job.cancel.cancelled() => bail!(job.cancellation_message()), result = request => result }
    } else {
        request.await
    }
}
pub async fn get_json(client: &reqwest::Client, url: &str, job: Option<&Job>) -> Result<Value> {
    Ok(serde_json::from_slice(&get_bytes(client, url, job).await?)?)
}

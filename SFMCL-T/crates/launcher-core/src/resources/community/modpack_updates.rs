use super::*;
use crate::resources::modpacks::update::{Origin, Release};

fn release(source: &str, project: &str, value: &Value) -> Result<Release> {
    let resource = if source == "modrinth" {
        if value["project_id"].as_str() != Some(project) {
            bail!("整合包版本不属于所选项目");
        }
        modrinth_file(value)?
    } else {
        if value["modId"].as_u64().map(|v| v.to_string()).as_deref() != Some(project)
            || value["isServerPack"] == true
        {
            bail!("请选择此项目的客户端整合包");
        }
        curseforge_file(value, project)?
    };
    let file = resource.file.context("此版本没有可用的下载文件")?;
    crate::paths::valid_name(&file.path)?;
    if source == "modrinth" && !file.path.to_lowercase().ends_with(".mrpack") {
        bail!("此版本没有客户端 MRPACK 文件");
    }
    if file.sha1.is_none() && file.sha512.is_none() {
        bail!("整合包下载缺少可验证的哈希");
    }
    Ok(Release {
        id: resource.id,
        name: resource.name,
        version: resource.version,
        date: resource.date,
        game_versions: resource.game_versions,
        loaders: resource.loaders,
        stable: if source == "modrinth" {
            value["version_type"] == "release"
        } else {
            value["releaseType"] == 1
        },
        file,
    })
}

impl Community {
    pub async fn modpack_candidates(&self, source: &str, name: &str) -> Result<Vec<Project>> {
        let query = Query {
            source: source.into(),
            kind: "modpack".into(),
            query: name.into(),
            limit: 20,
            ..Query::default()
        };
        Ok(self.search_native(&query).await?.items)
    }
    async fn validate_modpack_project(&self, source: &str, project: &str) -> Result<()> {
        validate_id(project)?;
        match source {
            "modrinth" => {
                let p = self.get(source, &format!("project/{project}"), &[]).await?;
                if p["id"].as_str() != Some(project)
                    || p["project_type"] != "modpack"
                    || p["client_side"] == "unsupported"
                {
                    bail!("请选择客户端整合包项目及准确项目 ID");
                }
            }
            "curseforge" => {
                let p = self.get(source, &format!("mods/{project}"), &[]).await?;
                if p["data"]["id"].as_u64().map(|v| v.to_string()).as_deref() != Some(project)
                    || p["data"]["classId"] != 4471
                    || p["data"]["gameId"] != 432
                {
                    bail!("请选择 Minecraft 整合包项目");
                }
            }
            _ => bail!("未知整合包平台"),
        }
        Ok(())
    }

    pub async fn modpack_release(&self, origin: &Origin) -> Result<Release> {
        self.validate_modpack_project(&origin.source, &origin.project_id)
            .await?;
        validate_id(&origin.version_id)?;
        let value = if origin.source == "modrinth" {
            self.get("modrinth", &format!("version/{}", origin.version_id), &[])
                .await?
        } else {
            self.get(
                "curseforge",
                &format!("mods/{}/files/{}", origin.project_id, origin.version_id),
                &[],
            )
            .await?["data"]
                .clone()
        };
        let item = release(&origin.source, &origin.project_id, &value)?;
        if item.id != origin.version_id {
            bail!("平台返回了其他整合包版本");
        }
        Ok(item)
    }

    pub async fn modpack_releases(&self, source: &str, project: &str) -> Result<Vec<Release>> {
        self.validate_modpack_project(source, project).await?;
        let values = if source == "modrinth" {
            self.get(source, &format!("project/{project}/version"), &[])
                .await?
                .as_array()
                .context("整合包版本列表无效")?
                .clone()
        } else {
            let mut values = vec![];
            for offset in (0..10_000).step_by(50) {
                let response = self
                    .get(
                        source,
                        &format!("mods/{project}/files"),
                        &[
                            ("pageSize".into(), "50".into()),
                            ("index".into(), offset.to_string()),
                        ],
                    )
                    .await?;
                let batch = response["data"].as_array().context("整合包版本列表无效")?;
                values.extend(batch.iter().cloned());
                if batch.len() < 50
                    || response["pagination"]["totalCount"]
                        .as_u64()
                        .is_some_and(|n| values.len() as u64 >= n)
                {
                    break;
                }
                if offset == 9950 {
                    bail!("整合包版本过多，请指定准确版本 ID");
                }
            }
            values
        };
        let mut items = vec![];
        for value in values {
            if source == "curseforge" && value["isServerPack"] == true {
                continue;
            }
            items.push(release(source, project, &value)?);
        }
        items.sort_by(|a, b| b.date.cmp(&a.date).then_with(|| a.id.cmp(&b.id)));
        Ok(items)
    }
}

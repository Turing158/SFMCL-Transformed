//! Opt-in, bundled Java agent for the vanilla integrated server only.
use crate::{downloads::DownloadSpec, jobs::Job, paths::safe_join};
use anyhow::{ensure, Context, Result};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{path::Path, process::Stdio, sync::Arc, time::Duration};

const AGENT: &[u8] = include_bytes!("../../../../resources/offline-lan-agent.jar");

pub(super) fn validate_version(version: &Value) -> Result<()> {
    // Loader remapping can rename the inherited authentication method again.
    // Do not present a successful offline mode for a loader we haven't verified.
    ensure!(
        version["mainClass"] == "net.minecraft.client.main.Main",
        "离线局域网目前支持原版 Minecraft，此加载器尚未适配；请关闭该设置后启动"
    );
    Ok(())
}

pub(super) async fn prepare(
    installer: &super::installer::Installer,
    root: &Path,
    version: &Value,
    java: &str,
    job: &Arc<Job>,
) -> Result<String> {
    validate_version(version)?;
    let jar_id = version["jar"]
        .as_str()
        .or(version["id"].as_str())
        .context("版本缺少客户端 ID")?;
    let client_jar = safe_join(root, format!("versions/{jar_id}/{jar_id}.jar"))?;
    let named = {
        let mut jar = zip::ZipArchive::new(std::fs::File::open(&client_jar)?)?;
        let result = jar
            .by_name("net/minecraft/client/server/IntegratedServer.class")
            .is_ok();
        result
    };
    let mapping = if named {
        None
    } else {
        let metadata = &version["downloads"]["client_mappings"];
        let url = metadata["url"]
            .as_str()
            .context("此原版版本缺少官方类名映射，暂不支持离线局域网；请关闭该设置后启动")?;
        let hash = metadata["sha1"]
            .as_str()
            .context("官方类名映射缺少校验值")?;
        ensure!(
            hash.len() == 40 && hash.bytes().all(|byte| byte.is_ascii_hexdigit()),
            "官方类名映射校验值无效"
        );
        let path = format!(".tmcl/offline-lan/mappings/{hash}.txt");
        job.log("准备离线局域网的官方版本映射".into());
        crate::jobs::download_session(
            &installer.downloads,
            job,
            "离线局域网版本映射".into(),
            root.into(),
            vec![DownloadSpec {
                url: installer.settings.get().minecraft_download_source.url(url),
                path: path.clone(),
                sha1: Some(hash.into()),
                sha512: None,
                size: metadata["size"].as_u64(),
            }],
        )
        .await?;
        let mapping = safe_join(root, path)?;
        ensure!(
            std::fs::metadata(&mapping)?.len() <= 32 * 1024 * 1024,
            "版本映射过大"
        );
        Some(mapping)
    };
    let hash = hex::encode(Sha256::digest(AGENT));
    let agent = safe_join(root, format!(".tmcl/offline-lan/agent-{}.jar", &hash[..16]))?;
    if std::fs::read(&agent).ok().as_deref() != Some(AGENT) {
        crate::paths::atomic_write(&agent, AGENT)?;
    }
    let mut command = super::java::command(super::java::executable(java));
    command
        .args(["-cp"])
        .arg(&agent)
        .args(["sfmcl.lan.OfflineLanAgent", "--check"])
        .arg(&client_jar)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(mapping) = mapping {
        command.arg(mapping);
    }
    let output = tokio::select! {
        _ = job.cancel.cancelled() => anyhow::bail!(job.cancellation_message()),
        output = tokio::time::timeout(Duration::from_secs(15), command.output()) => {
            output.context("离线局域网兼容性检查超时")??
        }
    };
    ensure!(
        output.status.success(),
        "此版本的内置服务器未通过离线局域网兼容性检查；请关闭该设置后启动"
    );
    let target = std::str::from_utf8(&output.stdout)?.trim();
    ensure!(
        target.len() <= 512
            && target.split(',').count() == 3
            && target
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"_$/,".contains(&byte)),
        "离线局域网兼容性检查返回无效目标"
    );
    job.log("允许离线角色加入此游戏的局域网世界；外部服务器认证保持原样".into());
    Ok(format!("-javaagent:{}={target}", agent.to_string_lossy()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn unsupported_loaders_cannot_silently_start_with_offline_mode_enabled() {
        assert!(validate_version(
            &serde_json::json!({"mainClass":"net.minecraft.client.main.Main"})
        )
        .is_ok());
        for main in [
            "net.fabricmc.loader.impl.launch.knot.KnotClient",
            "cpw.mods.bootstraplauncher.BootstrapLauncher",
            "net.minecraft.launchwrapper.Launch",
        ] {
            assert!(validate_version(&serde_json::json!({"mainClass":main})).is_err());
        }
    }

    #[test]
    fn bundled_agent_has_the_required_manifest_and_java8_bytecode() {
        let mut jar = zip::ZipArchive::new(std::io::Cursor::new(AGENT)).unwrap();
        let mut manifest = String::new();
        jar.by_name("META-INF/MANIFEST.MF")
            .unwrap()
            .read_to_string(&mut manifest)
            .unwrap();
        assert!(manifest.contains("Premain-Class: sfmcl.lan.OfflineLanAgent"));
        assert!(manifest.contains("Can-Retransform-Classes: false"));
        let mut header = [0; 8];
        jar.by_name("sfmcl/lan/OfflineLanAgent.class")
            .unwrap()
            .read_exact(&mut header)
            .unwrap();
        assert_eq!(&header[..4], &[0xca, 0xfe, 0xba, 0xbe]);
        assert_eq!(u16::from_be_bytes([header[6], header[7]]), 52);
    }
}

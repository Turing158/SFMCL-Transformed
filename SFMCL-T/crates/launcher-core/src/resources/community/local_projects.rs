use super::{validate_id, Community};
use crate::paths::safe_join;
use anyhow::{bail, Context, Result};
use serde::Serialize;
use serde_json::{json, Value};
use sha1::{Digest, Sha1};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::Path,
    time::Duration,
};

#[derive(Debug, Serialize)]
pub struct LocalProjectMatch {
    pub id: String,
}

struct ModIdentity {
    sha1: String,
    fingerprint: u32,
}

impl Community {
    pub async fn local_project(
        &self,
        source: &str,
        root: &Path,
        path: &Path,
    ) -> Result<Option<LocalProjectMatch>> {
        if !matches!(source, "modrinth" | "curseforge") {
            bail!("未知资源平台");
        }
        let root = root.to_owned();
        let path = path.to_owned();
        let identity = tokio::task::spawn_blocking(move || identify_mod(&root, &path)).await??;
        tokio::time::timeout(Duration::from_secs(20), async {
            let id = if source == "modrinth" {
                let result = self
                    .get(
                        source,
                        &format!("version_file/{}", identity.sha1),
                        &[("algorithm".into(), "sha1".into())],
                    )
                    .await;
                match result {
                    Ok(value) => Some(
                        value["project_id"]
                            .as_str()
                            .context("Modrinth 文件匹配返回格式错误")?
                            .to_owned(),
                    ),
                    Err(error)
                        if error.downcast_ref::<reqwest::Error>().is_some_and(|error| {
                            error.status() == Some(reqwest::StatusCode::NOT_FOUND)
                        }) =>
                    {
                        None
                    }
                    Err(error) => return Err(error),
                }
            } else {
                let value = self
                    .request(
                        source,
                        "fingerprints/432",
                        &[],
                        Some(json!({ "fingerprints": [identity.fingerprint] })),
                    )
                    .await?;
                curseforge_match(&value, &identity)?
            };
            if let Some(id) = id {
                validate_id(&id)?;
                Ok(Some(LocalProjectMatch { id }))
            } else {
                Ok(None)
            }
        })
        .await
        .context("匹配模组项目超时，请稍后重试")?
    }
}

fn curseforge_match(value: &Value, identity: &ModIdentity) -> Result<Option<String>> {
    let matches = value["data"]["exactMatches"]
        .as_array()
        .context("CurseForge 文件匹配返回格式错误")?;
    for candidate in matches {
        let file = &candidate["file"];
        // Fingerprints are only 32 bits. Verify the full file hash as well.
        let matches_sha1 = file["hashes"].as_array().into_iter().flatten().any(|hash| {
            hash["algo"] == 1
                && hash["value"]
                    .as_str()
                    .is_some_and(|hash| hash.eq_ignore_ascii_case(&identity.sha1))
        });
        if matches_sha1 {
            let id = file["modId"]
                .as_u64()
                .or_else(|| candidate["id"].as_u64())
                .context("CurseForge 项目 ID 缺失")?;
            return Ok(Some(id.to_string()));
        }
    }
    Ok(None)
}

fn identify_mod(root: &Path, path: &Path) -> Result<ModIdentity> {
    let relative = path
        .strip_prefix(root)
        .context("模组必须位于所选游戏目录内")?;
    let path = safe_join(root, relative)?;
    let mods = root.join("mods");
    if !matches!(path.parent(), Some(parent) if parent == mods || parent == mods.join(".disabled"))
        || !path.is_file()
    {
        bail!("不是所选游戏中的模组文件");
    }
    let mut file = File::open(path)?;
    let mut sha1 = Sha1::new();
    let mut normalized_length = 0u32;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        sha1.update(&buffer[..count]);
        normalized_length = normalized_length
            .checked_add(
                buffer[..count]
                    .iter()
                    .filter(|&&byte| !whitespace(byte))
                    .count() as u32,
            )
            .context("模组文件过大，无法匹配渠道项目")?;
    }
    file.seek(SeekFrom::Start(0))?;
    let fingerprint = fingerprint(&mut file, normalized_length)?;
    Ok(ModIdentity {
        sha1: hex::encode(sha1.finalize()),
        fingerprint,
    })
}

fn whitespace(byte: u8) -> bool {
    matches!(byte, 9 | 10 | 13 | 32)
}

// CurseForge uses MurmurHash2 (seed 1) after removing these four whitespace bytes.
fn fingerprint(reader: &mut impl Read, length: u32) -> Result<u32> {
    const M: u32 = 0x5bd1e995;
    let mut hash = 1 ^ length;
    let mut word = [0u8; 4];
    let mut used = 0;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        for &byte in &buffer[..count] {
            if whitespace(byte) {
                continue;
            }
            word[used] = byte;
            used += 1;
            if used == 4 {
                let mut value = u32::from_le_bytes(word).wrapping_mul(M);
                value ^= value >> 24;
                value = value.wrapping_mul(M);
                hash = hash.wrapping_mul(M) ^ value;
                used = 0;
            }
        }
    }
    if used > 0 {
        let tail = word[..used]
            .iter()
            .enumerate()
            .fold(0u32, |value, (index, byte)| {
                value | ((*byte as u32) << (index * 8))
            });
        hash = (hash ^ tail).wrapping_mul(M);
    }
    hash ^= hash >> 13;
    hash = hash.wrapping_mul(M);
    hash ^= hash >> 15;
    Ok(hash)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprint_matches_murmur2_vectors_and_ignores_curseforge_whitespace() {
        for (mut bytes, expected) in [
            (b"".as_slice(), 0x5bd15e36),
            (b"hello".as_slice(), 0xa631918e),
        ] {
            let length = bytes.len() as u32;
            assert_eq!(fingerprint(&mut bytes, length).unwrap(), expected);
        }
        let plain = fingerprint(&mut b"hello".as_slice(), 5).unwrap();
        assert_eq!(
            fingerprint(&mut b" h\te\nl\rl o ".as_slice(), 5).unwrap(),
            plain
        );
    }

    #[test]
    fn matching_only_accepts_full_hashes_from_exact_curseforge_results() {
        let identity = ModIdentity {
            sha1: "aabbcc".into(),
            fingerprint: 123,
        };
        let file = json!({"modId": 42, "hashes": [{"algo": 1, "value": "AABBCC"}]});
        assert_eq!(
            curseforge_match(
                &json!({"data": {"exactMatches": [{"file": file}]}}),
                &identity
            )
            .unwrap(),
            Some("42".into())
        );
        for value in [
            json!({"data": {"exactMatches": [], "partialMatches": [{"file": file}]}}),
            json!({"data": {"exactMatches": [{"file": {"modId": 99, "hashes": [{"algo": 1, "value": "different"}]}}]}}),
        ] {
            assert!(curseforge_match(&value, &identity).unwrap().is_none());
        }
        assert!(curseforge_match(&json!({}), &identity).is_err());
    }

    #[test]
    fn disabled_mods_have_the_same_identity_and_other_files_are_rejected() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("mods/.disabled")).unwrap();
        let path = root.path().join("mods/example.jar");
        std::fs::write(&path, b"hello").unwrap();
        let original = identify_mod(root.path(), &path).unwrap();
        assert_eq!(original.sha1, "aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d");
        let disabled = root.path().join("mods/.disabled/example.jar");
        std::fs::rename(path, &disabled).unwrap();
        let after = identify_mod(root.path(), &disabled).unwrap();
        assert_eq!(original.sha1, after.sha1);
        assert_eq!(original.fingerprint, after.fingerprint);
        assert!(identify_mod(root.path(), &root.path().join("other.jar")).is_err());
        assert!(identify_mod(root.path(), root.path()).is_err());
    }
}

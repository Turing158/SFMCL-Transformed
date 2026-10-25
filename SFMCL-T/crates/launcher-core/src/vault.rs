use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Mutex,
};

#[derive(Clone, Default, Serialize, Deserialize)]
pub struct Tokens {
    pub access: String,
    pub refresh: String,
    pub expires_at: u64,
}
#[derive(Default, Serialize, Deserialize)]
struct Secrets {
    tokens: HashMap<String, Tokens>,
    curseforge_key: String,
}
pub struct Vault {
    path: PathBuf,
    secrets: Mutex<Secrets>,
}
impl Vault {
    pub fn open(dir: &Path) -> Result<Self> {
        let path = dir.join("credentials.dat");
        let secrets = if path.exists() {
            serde_json::from_slice(&unprotect(&std::fs::read(&path)?)?)
                .context("无法读取当前系统用户的凭据")?
        } else {
            Secrets::default()
        };
        Ok(Self {
            path,
            secrets: Mutex::new(secrets),
        })
    }
    pub fn get(&self, id: &str) -> Option<Tokens> {
        self.secrets
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .tokens
            .get(id)
            .cloned()
    }
    pub fn put(&self, id: &str, tokens: Tokens) -> Result<()> {
        let mut s = self.secrets.lock().unwrap_or_else(|e| e.into_inner());
        s.tokens.insert(id.into(), tokens);
        self.save(&s)
    }
    pub fn remove(&self, id: &str) -> Result<()> {
        let mut s = self.secrets.lock().unwrap_or_else(|e| e.into_inner());
        s.tokens.remove(id);
        self.save(&s)
    }
    pub(crate) fn curseforge_key(&self) -> Result<String> {
        let environment = crate::brand::environment("CURSEFORGE_API_KEY")
            .and_then(|value| value.into_string().ok());
        let legacy = self
            .secrets
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .curseforge_key
            .clone();
        resolve_curseforge_key(environment.as_deref(), &legacy, || {
            // Shared by this user's development and installed profiles, outside
            // the repository, application bundle and webview asset scopes.
            let base = directories::BaseDirs::new().context("无法定位用户凭据目录")?;
            let key = read_service_key(
                &base
                    .data_local_dir()
                    .join("SFMCL-T/service-credentials/curseforge.dat"),
            )?;
            if !key.is_empty() {
                return Ok(key);
            }
            read_service_key(
                &base
                    .data_local_dir()
                    .join("TMCL/service-credentials/curseforge.dat"),
            )
        })
    }
    fn save(&self, secrets: &Secrets) -> Result<()> {
        crate::paths::atomic_write(&self.path, &protect(&serde_json::to_vec(secrets)?)?)
    }
}

fn resolve_curseforge_key(
    environment: Option<&str>,
    legacy: &str,
    service_key: impl FnOnce() -> Result<String>,
) -> Result<String> {
    if let Some(key) = environment.map(str::trim).filter(|key| !key.is_empty()) {
        return Ok(key.to_owned());
    }
    if !legacy.trim().is_empty() {
        return Ok(legacy.trim().to_owned());
    }
    service_key()
}

fn read_service_key(path: &Path) -> Result<String> {
    let encrypted = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        Err(error) => return Err(error.into()),
    };
    // Never attach the decrypted value to an error (FromUtf8Error owns its input).
    let plaintext = unprotect(&encrypted)?;
    let key = std::str::from_utf8(&plaintext).map_err(|_| anyhow::anyhow!("无法读取渠道凭据"))?;
    Ok(key.trim().to_owned())
}

#[cfg(windows)]
fn crypt(bytes: &[u8], encrypt: bool) -> Result<Vec<u8>> {
    use windows_sys::Win32::{Foundation::LocalFree, Security::Cryptography::*};
    let input = CRYPT_INTEGER_BLOB {
        cbData: bytes.len().try_into()?,
        pbData: bytes.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    // DPAPI binds encrypted credentials to the current Windows user. The output
    // allocation belongs to Windows and must be released with LocalFree.
    unsafe {
        let ok = if encrypt {
            CryptProtectData(
                &input,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        if ok == 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        let result = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        LocalFree(output.pbData as *mut _);
        Ok(result)
    }
}
#[cfg(windows)]
fn protect(bytes: &[u8]) -> Result<Vec<u8>> {
    crypt(bytes, true)
}
#[cfg(windows)]
fn unprotect(bytes: &[u8]) -> Result<Vec<u8>> {
    crypt(bytes, false)
}
#[cfg(not(windows))]
fn protect(_: &[u8]) -> Result<Vec<u8>> {
    anyhow::bail!("当前版本的凭据存储需要 Windows DPAPI")
}
#[cfg(not(windows))]
fn unprotect(_: &[u8]) -> Result<Vec<u8>> {
    anyhow::bail!("当前版本的凭据存储需要 Windows DPAPI")
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn service_credentials_are_encrypted_and_reloadable() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("curseforge.dat");
        assert!(read_service_key(&path).unwrap().is_empty());
        let sample = "test-only-service-credential";
        std::fs::write(&path, protect(sample.as_bytes()).unwrap()).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        assert!(!bytes
            .windows(sample.len())
            .any(|window| window == sample.as_bytes()));
        assert_eq!(read_service_key(&path).unwrap(), sample);
        std::fs::write(&path, protect(b"replacement-test-credential").unwrap()).unwrap();
        assert_eq!(
            read_service_key(&path).unwrap(),
            "replacement-test-credential"
        );
        std::fs::write(&path, b"corrupted-credential-file").unwrap();
        assert!(read_service_key(&path).is_err());
    }

    #[test]
    fn empty_environment_falls_back_without_overriding_legacy_credentials() {
        assert_eq!(
            resolve_curseforge_key(Some("  "), "", || Ok("service".into())).unwrap(),
            "service"
        );
        assert_eq!(
            resolve_curseforge_key(Some(" override "), "legacy", || panic!("unused")).unwrap(),
            "override"
        );
        assert_eq!(
            resolve_curseforge_key(None, " legacy ", || panic!("unused")).unwrap(),
            "legacy"
        );
    }

    #[test]
    fn credentials_round_trip_without_plaintext_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::open(dir.path()).unwrap();
        vault
            .put(
                "test",
                Tokens {
                    access: "sensitive-test-token".into(),
                    refresh: "refresh".into(),
                    expires_at: 1,
                },
            )
            .unwrap();
        let bytes = std::fs::read(dir.path().join("credentials.dat")).unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains("sensitive-test-token"));
        assert_eq!(
            Vault::open(dir.path()).unwrap().get("test").unwrap().access,
            "sensitive-test-token"
        );
    }
}

use std::{
    ffi::OsString,
    path::{Path, PathBuf},
};

pub const PRODUCT_NAME: &str = "SFMCL-T";
pub const PRODUCT_FULL_NAME: &str = "StarFall Minecraft Launcher-Transformed";

/// The new environment names take precedence; existing launch scripts still work.
pub fn environment(suffix: &str) -> Option<OsString> {
    std::env::var_os(format!("SFMCL_T_{suffix}"))
        .filter(|value| !value.to_string_lossy().trim().is_empty())
        .or_else(|| {
            std::env::var_os(format!("TMCL_{suffix}"))
                .filter(|value| !value.to_string_lossy().trim().is_empty())
        })
}

/// Reuse an existing profile in place, including DPAPI credentials and WebView
/// preferences. A new installation gets the new application identifier's path.
pub fn data_directory(default: &Path, override_path: Option<OsString>) -> PathBuf {
    if let Some(path) = override_path {
        return path.into();
    }
    if !default.exists() {
        let legacy = default.with_file_name("com.tmcl.minecraft-launcher");
        if legacy.is_dir() {
            return legacy;
        }
    }
    default.into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn existing_profiles_remain_available_and_explicit_paths_win() {
        let root = tempfile::tempdir().unwrap();
        let new = root.path().join("com.sfmcl-t.minecraft-launcher");
        let old = root.path().join("com.tmcl.minecraft-launcher");
        assert_eq!(data_directory(&new, None), new);
        std::fs::create_dir(&old).unwrap();
        assert_eq!(data_directory(&new, None), old);
        let custom = root.path().join("custom");
        assert_eq!(
            data_directory(&new, Some(custom.clone().into_os_string())),
            custom
        );
        std::fs::create_dir(&new).unwrap();
        assert_eq!(data_directory(&new, None), new);
    }
}

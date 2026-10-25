use winreg::{
    enums::{KEY_READ, KEY_WOW64_32KEY, KEY_WOW64_64KEY},
    RegKey, HKCU, HKLM,
};

// Match StarFallMCL's JavaSoft scan, including both Windows registry views.
const JAVA_KEYS: &[&str] = &[
    r"SOFTWARE\JavaSoft\Java Runtime Environment",
    r"SOFTWARE\JavaSoft\Java Development Kit",
    r"SOFTWARE\JavaSoft\JDK",
    r"SOFTWARE\JavaSoft\JRE",
];

pub(super) fn java_homes() -> Vec<String> {
    let mut homes = Vec::new();
    for hive in [&HKLM, &HKCU] {
        for view in [KEY_WOW64_64KEY, KEY_WOW64_32KEY] {
            for path in JAVA_KEYS {
                homes.extend(homes_in(hive, path, view));
            }
        }
    }
    homes
}

fn homes_in(hive: &RegKey, path: &str, view: u32) -> Vec<String> {
    let Ok(key) = hive.open_subkey_with_flags(path, KEY_READ | view) else {
        return Vec::new();
    };
    key.enum_keys()
        .filter_map(Result::ok)
        .filter_map(|version| key.open_subkey_with_flags(version, KEY_READ | view).ok())
        .filter_map(|version| version.get_value::<String, _>("JavaHome").ok())
        .filter(|home| !home.trim().is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    struct RegistryFixture(String);

    impl RegistryFixture {
        fn new() -> Self {
            Self(format!(
                r"SOFTWARE\SFMCL-T-JavaScan-Test-{}",
                uuid::Uuid::new_v4()
            ))
        }
    }

    impl Drop for RegistryFixture {
        fn drop(&mut self) {
            // Only the unique test branch is removed, never installed Java keys.
            let _ = HKCU.delete_subkey_all(&self.0);
        }
    }

    #[test]
    fn registry_reads_all_versions_and_skips_missing_or_invalid_java_home() {
        let fixture = RegistryFixture::new();
        let path = format!(r"{}\JDK", fixture.0);
        let (key, _) = HKCU.create_subkey(&path).unwrap();
        for (version, home) in [
            ("21", r"D:\Java 安装\jdk-21"),
            ("21.0.11", r"D:\Java 安装\jdk-21"),
            ("25", r"E:\Custom Java\jdk-25"),
            ("empty", ""),
            ("blank", "   "),
        ] {
            key.create_subkey(version)
                .unwrap()
                .0
                .set_value("JavaHome", &home)
                .unwrap();
        }
        key.create_subkey("missing").unwrap();
        key.create_subkey("invalid")
            .unwrap()
            .0
            .set_value("JavaHome", &42u32)
            .unwrap();

        // HKCU\Software is shared across views; both must be readable explicitly.
        for view in [KEY_WOW64_64KEY, KEY_WOW64_32KEY] {
            let mut homes = homes_in(HKCU, &path, view);
            homes.sort();
            assert_eq!(
                homes,
                vec![
                    r"D:\Java 安装\jdk-21",
                    r"D:\Java 安装\jdk-21",
                    r"E:\Custom Java\jdk-25"
                ]
            );
            assert!(homes_in(HKCU, &format!(r"{}\absent", fixture.0), view).is_empty());
        }
    }
}

fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        // Windows treats unmanifested x86 executables with "install" in their
        // names as installers. Integration tests must run as the current user.
        println!("cargo:rustc-link-arg-tests=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg-tests=/MANIFESTUAC:level='asInvoker' uiAccess='false'");
    }
}

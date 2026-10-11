fn main() {
    // The Google OAuth client for cloud backup is baked in at compile time
    // (`option_env!` in src/cloud.rs); rebuild when it changes.
    println!("cargo:rerun-if-env-changed=CORETOOLS_GOOGLE_CLIENT_ID");
    println!("cargo:rerun-if-env-changed=CORETOOLS_GOOGLE_CLIENT_SECRET");
    tauri_build::build()
}

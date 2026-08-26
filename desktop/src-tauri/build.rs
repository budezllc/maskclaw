use std::env;
use std::fs;
use std::path::PathBuf;

fn sidecar_name(triple: &str) -> String {
    if cfg!(windows) {
        format!("switchyard-server-{triple}.exe")
    } else {
        format!("switchyard-server-{triple}")
    }
}

fn engine_flavor() -> String {
    if let Ok(from_env) = env::var("SWITCHYARD_ENGINE") {
        let trimmed = from_env.trim().to_ascii_lowercase();
        if !trimmed.is_empty() {
            return normalize_flavor(&trimmed);
        }
    }
    let flavor_file = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("engine-flavor.txt");
    if let Ok(text) = fs::read_to_string(&flavor_file) {
        let trimmed = text.trim().to_ascii_lowercase();
        if !trimmed.is_empty() {
            return normalize_flavor(&trimmed);
        }
    }
    "maskclaw".into()
}

fn normalize_flavor(value: &str) -> String {
    if value == "maskclaw" {
        "maskclaw".into()
    } else {
        "stock".into()
    }
}

fn main() {
    let triple = env::var("TAURI_ENV_TARGET_TRIPLE")
        .or_else(|_| env::var("TARGET"))
        .unwrap_or_else(|_| "x86_64-pc-windows-msvc".into());
    let path = PathBuf::from("binaries").join(sidecar_name(&triple));
    if !path.exists() {
        let _ = fs::create_dir_all("binaries");
        let _ = fs::write(&path, []);
        println!("cargo:warning=staged empty sidecar stub at {}", path.display());
    }
    // Do not watch `binaries/` itself. Copying a real sidecar there retriggers
    // cargo, and `tauri dev` Ctrl+C's the just-launched window (0xc000013a).
    println!("cargo:rerun-if-changed=binaries/.gitkeep");
    println!("cargo:rerun-if-env-changed=SWITCHYARD_ENGINE");
    println!("cargo:rerun-if-changed=engine-flavor.txt");
    let flavor = engine_flavor();
    println!("cargo:rustc-env=SWITCHYARD_ENGINE={flavor}");
    if env::var("PROFILE").ok().as_deref() == Some("debug") {
        let routes = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../appliance/deploy/config/routes.toml.example");
        if let Ok(canon) = fs::canonicalize(&routes) {
            println!(
                "cargo:rustc-env=SWITCHYARD_WORKSPACE_ROUTES={}",
                canon.display()
            );
        }
        println!("cargo:rerun-if-changed=../../../appliance/deploy/config/routes.toml.example");
    }
    tauri_build::build()
}

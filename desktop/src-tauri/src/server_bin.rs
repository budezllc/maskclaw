use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

const MIN_BIN_LEN: u64 = 64;

pub fn server_bin_name() -> &'static str {
    if cfg!(windows) {
        "switchyard-server.exe"
    } else {
        "switchyard-server"
    }
}

pub fn sidecar_bin_name(triple: &str) -> String {
    if cfg!(windows) {
        format!("switchyard-server-{triple}.exe")
    } else {
        format!("switchyard-server-{triple}")
    }
}

/// True when `path` looks like a real executable, not Tauri's empty sidecar stub.
pub fn is_runnable_bin(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() || meta.len() < MIN_BIN_LEN {
        return false;
    }
    let Ok(mut file) = File::open(path) else {
        return false;
    };
    let mut magic = [0u8; 2];
    if file.read_exact(&mut magic).is_err() {
        return false;
    }
    if cfg!(windows) {
        magic == *b"MZ"
    } else {
        true
    }
}

pub fn collect_candidates(
    current_exe: Option<&Path>,
    binaries_dir: Option<&Path>,
    cargo_bin: Option<&Path>,
    path_dirs: impl IntoIterator<Item = impl AsRef<Path>>,
    triple: &str,
    prefer_bundled: bool,
) -> Vec<PathBuf> {
    let mut bundled = Vec::new();
    let mut installed = Vec::new();
    let name = server_bin_name();
    if let Some(exe) = current_exe {
        if let Some(dir) = exe.parent() {
            bundled.push(dir.join(name));
        }
    }
    if let Some(dir) = binaries_dir {
        bundled.push(dir.join(sidecar_bin_name(triple)));
        bundled.push(dir.join(name));
    }
    if let Some(dir) = cargo_bin {
        installed.push(dir.join(name));
    }
    for dir in path_dirs {
        installed.push(dir.as_ref().join(name));
    }
    // Dev must not launch the sidecar next to the desktop exe. Tauri deletes
    // that file on every rebuild; a running engine makes remove_file Access Denied.
    if prefer_bundled {
        bundled.extend(installed);
        bundled
    } else {
        installed.extend(bundled);
        installed
    }
}

pub fn pick_server_bin(candidates: impl IntoIterator<Item = PathBuf>) -> Option<PathBuf> {
    candidates.into_iter().find(|path| is_runnable_bin(path))
}

fn cargo_bin_dir() -> Option<PathBuf> {
    if let Some(home) = std::env::var_os("CARGO_HOME") {
        return Some(PathBuf::from(home).join("bin"));
    }
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))?;
    Some(PathBuf::from(home).join(".cargo").join("bin"))
}

fn path_dirs() -> Vec<PathBuf> {
    std::env::var_os("PATH")
        .map(|value| std::env::split_paths(&value).collect())
        .unwrap_or_default()
}

fn target_triple() -> String {
    std::env::var("TAURI_ENV_TARGET_TRIPLE")
        .or_else(|_| std::env::var("TARGET"))
        .unwrap_or_else(|_| {
            if cfg!(windows) {
                "x86_64-pc-windows-msvc".into()
            } else {
                "unknown".into()
            }
        })
}

pub fn resolve_server_bin() -> Result<String, String> {
    let current = std::env::current_exe().ok();
    let cargo_bin = cargo_bin_dir();
    let candidates = collect_candidates(
        current.as_deref(),
        None,
        cargo_bin.as_deref(),
        path_dirs(),
        &target_triple(),
        !cfg!(debug_assertions),
    );
    pick_server_bin(candidates)
        .map(|path| path.to_string_lossy().into_owned())
        .ok_or_else(|| {
            "Could not find a runnable switchyard-server. The bundled sidecar is an empty stub. \
             Install with `cargo install --locked switchyard-server` or put the real binary on PATH."
                .into()
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn scratch_dir() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("switchyard-server-bin-{nanos}"));
        fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    fn write_bytes(path: &Path, bytes: &[u8]) {
        fs::write(path, bytes).expect("write");
    }

    fn fake_pe(path: &Path) {
        let mut bytes = vec![0u8; 80];
        bytes[0] = b'M';
        bytes[1] = b'Z';
        write_bytes(path, &bytes);
    }

    #[test]
    fn empty_stub_is_not_runnable() {
        let dir = scratch_dir();
        let stub = dir.join("switchyard-server.exe");
        write_bytes(&stub, &[]);
        assert!(!is_runnable_bin(&stub));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn missing_path_is_not_runnable() {
        assert!(!is_runnable_bin(Path::new(
            "C:\\definitely-missing-switchyard-server.exe"
        )));
    }

    #[test]
    fn windows_requires_mz_header() {
        let dir = scratch_dir();
        let path = dir.join("not-pe.exe");
        write_bytes(&path, &[0u8; 80]);
        if cfg!(windows) {
            assert!(!is_runnable_bin(&path));
        }
        fake_pe(&path);
        assert!(is_runnable_bin(&path));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn pick_skips_empty_sidecar_then_uses_cargo_bin() {
        let dir = scratch_dir();
        let app_dir = dir.join("app");
        let cargo_dir = dir.join("cargo-bin");
        fs::create_dir_all(&app_dir).unwrap();
        fs::create_dir_all(&cargo_dir).unwrap();
        let stub = app_dir.join(server_bin_name());
        write_bytes(&stub, &[]);
        let real = cargo_dir.join(server_bin_name());
        fake_pe(&real);

        let candidates = collect_candidates(
            Some(&app_dir.join("switchyard-desktop.exe")),
            None,
            Some(&cargo_dir),
            std::iter::empty::<PathBuf>(),
            "x86_64-pc-windows-msvc",
            true,
        );
        assert_eq!(candidates[0], stub);
        assert_eq!(pick_server_bin(candidates).as_deref(), Some(real.as_path()));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn pick_prefers_valid_sidecar_beside_the_app() {
        let dir = scratch_dir();
        let app_dir = dir.join("app");
        let cargo_dir = dir.join("cargo-bin");
        fs::create_dir_all(&app_dir).unwrap();
        fs::create_dir_all(&cargo_dir).unwrap();
        let sidecar = app_dir.join(server_bin_name());
        fake_pe(&sidecar);
        let cargo = cargo_dir.join(server_bin_name());
        fake_pe(&cargo);

        let picked = pick_server_bin(collect_candidates(
            Some(&app_dir.join("switchyard-desktop.exe")),
            None,
            Some(&cargo_dir),
            std::iter::empty::<PathBuf>(),
            "x86_64-pc-windows-msvc",
            true,
        ));
        assert_eq!(picked.as_deref(), Some(sidecar.as_path()));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn debug_prefers_cargo_bin_over_sidecar_beside_the_app() {
        let dir = scratch_dir();
        let app_dir = dir.join("app");
        let cargo_dir = dir.join("cargo-bin");
        fs::create_dir_all(&app_dir).unwrap();
        fs::create_dir_all(&cargo_dir).unwrap();
        let sidecar = app_dir.join(server_bin_name());
        fake_pe(&sidecar);
        let cargo = cargo_dir.join(server_bin_name());
        fake_pe(&cargo);

        let picked = pick_server_bin(collect_candidates(
            Some(&app_dir.join("switchyard-desktop.exe")),
            None,
            Some(&cargo_dir),
            std::iter::empty::<PathBuf>(),
            "x86_64-pc-windows-msvc",
            false,
        ));
        assert_eq!(picked.as_deref(), Some(cargo.as_path()));
        let _ = fs::remove_dir_all(dir);
    }
}

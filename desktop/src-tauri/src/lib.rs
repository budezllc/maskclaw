mod dry_run;
mod process;
mod secrets;
mod server_bin;

use std::collections::{HashMap, VecDeque};
use std::fs;
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use process::{apply_no_window, EngineState, ManagedChild, ProcessManager, RealChild};
use secrets::SecretBinding;
use tauri::include_image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_autostart::ManagerExt;

const LISTEN_HOST: &str = "127.0.0.1";
const LISTEN_PORT: u16 = 4000;
const SHUTDOWN_TIMEOUT_SECS: u64 = 30;
const HTTP_TIMEOUT_MS: u64 = 1500;
const HTTP_CONNECT_TIMEOUT_MS: u64 = 500;
const MODELS_PROBE_TIMEOUT_MS: u64 = 8000;
const MODEL_TEST_TIMEOUT_MS: u64 = 12000;
const DRY_RUN_TIMEOUT_SECS: u64 = 15;
const PORT_PROBE_TIMEOUT_MS: u64 = 200;
#[cfg(windows)]
const WINDOWS_CREATE_NO_WINDOW: u32 = 0x0800_0000;
const DEFAULT_MASKCLAW_TOML: &str = r#"enabled = true
session_ttl_secs = 900
force_local = "never"

[detectors]
email = true
phone = true
ssn = true
credit_card = true
jwt = true
aws_key = true
api_key = true
"#;

pub struct AppInner {
    manager: ProcessManager<RealChild>,
    logs: Arc<Mutex<VecDeque<String>>>,
    telemetry_opt_in: bool,
    data_dir: PathBuf,
}

pub struct AppState(pub Mutex<AppInner>);

#[derive(serde::Serialize)]
pub struct Snapshot {
    needs_setup: bool,
    listen_url: String,
    engine_state: EngineState,
    last_error: Option<String>,
    telemetry_opt_in: bool,
    autostart: bool,
    engine_flavor: String,
    config_toml: String,
    maskclaw_toml: String,
    logs: Vec<String>,
    routing_tail: Vec<serde_json::Value>,
}

#[derive(serde::Serialize)]
pub struct ProbeResult {
    url: String,
    ok: bool,
    label: String,
    detail: String,
    models: Vec<String>,
}

#[derive(serde::Serialize)]
pub struct HealthResult {
    ok: bool,
    body: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupForm {
    pub telemetry_opt_in: bool,
}

fn listen_url() -> String {
    format!("http://{LISTEN_HOST}:{LISTEN_PORT}")
}

fn engine_flavor() -> &'static str {
    option_env!("SWITCHYARD_ENGINE").unwrap_or("maskclaw")
}

fn is_maskclaw_build() -> bool {
    engine_flavor() == "maskclaw"
}

fn app_display_name_for(flavor: &str) -> &'static str {
    if flavor == "maskclaw" {
        "MASKCLAW DESKTOP"
    } else {
        "Switchyard"
    }
}

fn app_display_name() -> &'static str {
    app_display_name_for(engine_flavor())
}

const X_PROFILE_URL: &str = "https://x.com/KeiSakaiX";

fn is_allowed_external_url(url: &str) -> bool {
    url == X_PROFILE_URL
}

fn open_in_default_browser(url: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = WINDOWS_CREATE_NO_WINDOW;
        Command::new("cmd")
            .args(["/C", "start", "", url])
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|err| err.to_string())?;
        return Ok(());
    }
    #[cfg(not(windows))]
    {
        let opener = if cfg!(target_os = "macos") {
            "open"
        } else {
            "xdg-open"
        };
        Command::new(opener)
            .arg(url)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|err| err.to_string())?;
        Ok(())
    }
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    if !is_allowed_external_url(&url) {
        return Err("url not allowed".into());
    }
    open_in_default_browser(&url)
}

fn routes_path(dir: &Path) -> PathBuf {
    dir.join("routes.toml")
}

/// Prefer the repo `routes.toml` when this desktop build is running from the Switchyard tree.
fn find_workspace_routes_from(start: PathBuf) -> Option<PathBuf> {
    let mut cursor = start;
    for _ in 0..8 {
        let routes = cursor.join("routes.toml");
        if routes.is_file() && cursor.join("apps").join("desktop").is_dir() {
            return Some(routes);
        }
        if !cursor.pop() {
            break;
        }
    }
    None
}

fn find_workspace_routes() -> Option<PathBuf> {
    if let Some(baked) = option_env!("SWITCHYARD_WORKSPACE_ROUTES") {
        let path = PathBuf::from(baked);
        if path.is_file() {
            return Some(path);
        }
    }
    std::env::current_dir()
        .ok()
        .and_then(find_workspace_routes_from)
}

fn active_routes_path(data_dir: &Path) -> PathBuf {
    find_workspace_routes().unwrap_or_else(|| routes_path(data_dir))
}

fn maskclaw_path_for_routes(routes: &Path) -> PathBuf {
    routes.with_file_name("maskclaw.toml")
}

fn active_maskclaw_path(data_dir: &Path) -> PathBuf {
    maskclaw_path_for_routes(&active_routes_path(data_dir))
}

fn routing_log_path(dir: &Path) -> PathBuf {
    dir.join("routing.jsonl")
}

fn settings_path(dir: &Path) -> PathBuf {
    dir.join("settings.json")
}

fn ensure_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    seed_routes_if_present(&dir)?;
    seed_maskclaw_if_needed(&dir, engine_flavor())?;
    Ok(dir)
}

fn seed_routes_if_present(data_dir: &Path) -> Result<(), String> {
    let dest = routes_path(data_dir);
    if dest.exists() {
        return Ok(());
    }
    let mut cursor = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    for _ in 0..6 {
        let candidate = cursor.join("routes.toml");
        if candidate.is_file() {
            fs::copy(&candidate, &dest).map_err(|e| e.to_string())?;
            return Ok(());
        }
        if !cursor.pop() {
            break;
        }
    }
    Ok(())
}

fn seed_maskclaw_if_needed(data_dir: &Path, flavor: &str) -> Result<(), String> {
    seed_maskclaw_file(&active_maskclaw_path(data_dir), flavor)
}

fn seed_maskclaw_file(dest: &Path, flavor: &str) -> Result<(), String> {
    if flavor != "maskclaw" {
        return Ok(());
    }
    if dest.exists() {
        return Ok(());
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(dest, DEFAULT_MASKCLAW_TOML).map_err(|e| e.to_string())
}

fn read_settings(dir: &Path) -> (bool, bool) {
    let raw = fs::read_to_string(settings_path(dir)).unwrap_or_default();
    let json: serde_json::Value = serde_json::from_str(&raw).unwrap_or(serde_json::json!({}));
    let telemetry = json
        .get("telemetry_opt_in")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let setup_complete = json
        .get("setup_complete")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    (telemetry, setup_complete)
}

fn write_settings(dir: &Path, telemetry_opt_in: bool, setup_complete: bool) -> Result<(), String> {
    let json = serde_json::json!({
        "telemetry_opt_in": telemetry_opt_in,
        "setup_complete": setup_complete,
    });
    fs::write(settings_path(dir), serde_json::to_string_pretty(&json).unwrap())
        .map_err(|e| e.to_string())
}

fn resolve_server_bin() -> Result<String, String> {
    server_bin::resolve_server_bin()
}

fn tail_jsonl(path: &Path, limit: usize) -> Vec<serde_json::Value> {
    let Ok(text) = fs::read_to_string(path) else {
        return Vec::new();
    };
    text.lines()
        .rev()
        .take(limit)
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect()
}

fn snapshot_locked(app: &AppHandle, inner: &AppInner) -> Snapshot {
    let toml = fs::read_to_string(active_routes_path(&inner.data_dir)).unwrap_or_default();
    let maskclaw_toml = if is_maskclaw_build() {
        fs::read_to_string(active_maskclaw_path(&inner.data_dir)).unwrap_or_default()
    } else {
        String::new()
    };
    let logs = inner
        .logs
        .lock()
        .map(|ring| ring.iter().cloned().collect())
        .unwrap_or_default();
    let (_, setup_complete) = read_settings(&inner.data_dir);
    let autostart = app.autolaunch().is_enabled().unwrap_or(false);
    Snapshot {
        needs_setup: !setup_complete,
        listen_url: listen_url(),
        engine_state: inner.manager.state,
        last_error: inner.manager.last_error.clone(),
        telemetry_opt_in: inner.telemetry_opt_in,
        autostart,
        engine_flavor: engine_flavor().to_string(),
        config_toml: toml,
        maskclaw_toml,
        logs,
        routing_tail: tail_jsonl(&routing_log_path(&inner.data_dir), 40),
    }
}

fn server_args(data_dir: &Path) -> Vec<String> {
    server_args_for(data_dir, engine_flavor())
}

fn server_args_for(data_dir: &Path, flavor: &str) -> Vec<String> {
    let mut args = vec![
        "--config".into(),
        active_routes_path(data_dir).to_string_lossy().into_owned(),
        "--host".into(),
        LISTEN_HOST.into(),
        "--port".into(),
        LISTEN_PORT.to_string(),
        "--routing-log-file".into(),
        routing_log_path(data_dir).to_string_lossy().into_owned(),
        "--shutdown-timeout".into(),
        format!("{SHUTDOWN_TIMEOUT_SECS}s"),
    ];
    if flavor == "maskclaw" {
        args.push("--maskclaw-config".into());
        args.push(active_maskclaw_path(data_dir).to_string_lossy().into_owned());
    }
    args
}

fn load_sidecar_env(toml: &str, telemetry_opt_in: bool) -> Result<Vec<(String, String)>, String> {
    let names = secrets::api_key_envs_from_toml(toml);
    let stored = secrets::load_named(&names)?;
    let mut env = secrets::sidecar_env(&stored, telemetry_opt_in);
    secrets::ensure_local_api_keys(toml, &mut env);
    Ok(env)
}

fn port_busy(addr: SocketAddr, timeout: Duration) -> bool {
    TcpStream::connect_timeout(&addr, timeout).is_ok()
}

fn listen_port_busy() -> bool {
    port_busy(
        SocketAddr::from(([127, 0, 0, 1], LISTEN_PORT)),
        Duration::from_millis(PORT_PROBE_TIMEOUT_MS),
    )
}

/// Autostart should not compete with an already-bound listen port.
#[allow(dead_code)]
fn should_skip_engine_autostart(port_already_bound: bool) -> bool {
    port_already_bound
}

fn run_dry_run(data_dir: &Path, env: &[(String, String)]) -> Result<(), String> {
    let mut cmd = Command::new(resolve_server_bin()?);
    cmd.arg("--config").arg(active_routes_path(data_dir));
    if is_maskclaw_build() {
        cmd.arg("--maskclaw-config")
            .arg(active_maskclaw_path(data_dir));
    }
    cmd.arg("--dry-run")
        .envs(env.iter().cloned())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    apply_no_window(&mut cmd);
    let child = cmd.spawn().map_err(|e| {
        format!("Could not run the routing engine ({e}). In dev, put switchyard-server on PATH.")
    })?;
    let pid = child.id();
    let (tx, rx) = std::sync::mpsc::channel();
    thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });
    let output = match rx.recv_timeout(Duration::from_secs(DRY_RUN_TIMEOUT_SECS)) {
        Ok(Ok(output)) => output,
        Ok(Err(err)) => {
            return Err(format!("Dry-run failed: {err}"));
        }
        Err(_) => {
            kill_pid(pid);
            return Err(format!(
                "Dry-run timed out after {DRY_RUN_TIMEOUT_SECS}s. Check switchyard-server on PATH."
            ));
        }
    };
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let code = output.status.code().unwrap_or(1);
    if let Some(err) = dry_run::parse_dry_run_stderr(&format!("{stderr}\n{stdout}"), code) {
        return Err(dry_run::format_for_wizard(&err));
    }
    if !output.status.success() {
        return Err(if stderr.is_empty() {
            format!("Dry-run failed with exit {code}")
        } else {
            stderr
        });
    }
    Ok(())
}

fn kill_pid(pid: u32) {
    #[cfg(windows)]
    {
        let mut cmd = Command::new("taskkill");
        cmd.args(["/PID", &pid.to_string(), "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        apply_no_window(&mut cmd);
        let _ = cmd.status();
    }
    #[cfg(unix)]
    {
        let _ = Command::new("kill")
            .args(["-9", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

async fn with_manager<R, F>(app: AppHandle, f: F) -> Result<R, String>
where
    R: Send + 'static,
    F: FnOnce(&AppHandle, &mut AppInner) -> Result<R, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let state = app
            .try_state::<AppState>()
            .ok_or_else(|| "app state missing".to_string())?;
        let mut inner = state.0.lock().map_err(|e| e.to_string())?;
        f(&app, &mut inner)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Debug, PartialEq, Eq)]
enum StartDecision {
    AlreadyManaged,
    ReplaceExistingListener,
    Spawn,
}

fn decide_start(has_live_child: bool, port_already_bound: bool) -> StartDecision {
    if has_live_child {
        StartDecision::AlreadyManaged
    } else if port_already_bound {
        StartDecision::ReplaceExistingListener
    } else {
        StartDecision::Spawn
    }
}

fn parse_listening_pid(netstat: &str, port: u16) -> Option<u32> {
    let suffix = format!(":{port}");
    for line in netstat.lines() {
        let line = line.trim();
        if !line.starts_with("TCP") || !line.contains("LISTENING") {
            continue;
        }
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 5 {
            continue;
        }
        if parts[1].ends_with(&suffix) {
            return parts.last()?.parse().ok();
        }
    }
    None
}

fn pid_listening_on(port: u16) -> Option<u32> {
    let mut cmd = Command::new("netstat");
    cmd.args(["-ano", "-p", "tcp"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    apply_no_window(&mut cmd);
    let output = cmd.output().ok()?;
    parse_listening_pid(&String::from_utf8_lossy(&output.stdout), port)
}

fn wait_listen_port_free(timeout: Duration) -> bool {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        if !listen_port_busy() {
            return true;
        }
        if std::time::Instant::now() >= deadline {
            return false;
        }
        thread::sleep(Duration::from_millis(50));
    }
}

fn free_listen_port() {
    if wait_listen_port_free(Duration::from_millis(1000)) {
        return;
    }
    if let Some(pid) = pid_listening_on(LISTEN_PORT) {
        kill_pid(pid);
        let _ = wait_listen_port_free(Duration::from_millis(1000));
    }
}

fn child_is_live(inner: &mut AppInner) -> bool {
    if let Some(child) = inner.manager.child.as_mut() {
        match child.try_wait() {
            Ok(None) => true,
            _ => {
                inner.manager.child = None;
                false
            }
        }
    } else {
        false
    }
}

enum PreparedStart {
    Finished,
    Spawn { env: Vec<(String, String)> },
}

fn prepare_start(inner: &mut AppInner) -> Result<PreparedStart, String> {
    match decide_start(child_is_live(inner), listen_port_busy()) {
        StartDecision::AlreadyManaged => {
            inner.manager.state = EngineState::Running;
            inner.manager.last_error = None;
            Ok(PreparedStart::Finished)
        }
        StartDecision::ReplaceExistingListener | StartDecision::Spawn => {
            if listen_port_busy() {
                free_listen_port();
            }
            let toml = fs::read_to_string(active_routes_path(&inner.data_dir))
                .map_err(|_| "No routing file yet. Finish Setup first.".to_string())?;
            let env = load_sidecar_env(&toml, inner.telemetry_opt_in)?;
            inner.manager.state = EngineState::Starting;
            inner.manager.last_error = None;
            Ok(PreparedStart::Spawn { env })
        }
    }
}

fn spawn_locked(inner: &mut AppInner, env: &[(String, String)]) -> Result<(), String> {
    if listen_port_busy() {
        free_listen_port();
    }
    let args = server_args(&inner.data_dir);
    match RealChild::spawn(&resolve_server_bin()?, &args, env, inner.logs.clone()) {
        Ok(child) => {
            inner.manager.attach_running(child);
            Ok(())
        }
        Err(err) => {
            inner.manager.mark_failed(err.to_string());
            Err(err.to_string())
        }
    }
}

fn start_locked_with_dry_run(inner: &mut AppInner, dry_run: bool) -> Result<(), String> {
    match prepare_start(inner)? {
        PreparedStart::Finished => Ok(()),
        PreparedStart::Spawn { env } => {
            if dry_run {
                let data_dir = inner.data_dir.clone();
                if let Err(err) = run_dry_run(&data_dir, &env) {
                    inner.manager.mark_failed(err.clone());
                    return Err(err);
                }
            }
            spawn_locked(inner, &env)
        }
    }
}

fn restart_locked(inner: &mut AppInner) -> Result<(), String> {
    restart_locked_with_dry_run(inner, true)
}

fn restart_locked_with_dry_run(inner: &mut AppInner, dry_run: bool) -> Result<(), String> {
    inner.manager.restart_begin();
    stop_locked(inner)?;
    start_locked_with_dry_run(inner, dry_run)
}

/// Detector toggles rewrite maskclaw.toml; skip an extra `--dry-run` sidecar so
/// Windows does not flash a second console. Routes saves still dry-run.
fn maskclaw_save_runs_dry_run() -> bool {
    false
}

fn start_engine_now(mutex: &Mutex<AppInner>) -> Result<(), String> {
    let (data_dir, env) = {
        let mut inner = mutex.lock().map_err(|e| e.to_string())?;
        match prepare_start(&mut inner)? {
            PreparedStart::Finished => return Ok(()),
            PreparedStart::Spawn { env } => (inner.data_dir.clone(), env),
        }
    };
    if let Err(err) = run_dry_run(&data_dir, &env) {
        if let Ok(mut inner) = mutex.lock() {
            inner.manager.mark_failed(err.clone());
        }
        return Err(err);
    }
    let mut inner = mutex.lock().map_err(|e| e.to_string())?;
    spawn_locked(&mut inner, &env)
}

fn stop_locked(inner: &mut AppInner) -> Result<(), String> {
    inner
        .manager
        .stop(Duration::from_secs(SHUTDOWN_TIMEOUT_SECS))
        .map_err(|e| e.to_string())
}

fn write_toml_and_restart(
    inner: &mut AppInner,
    toml: &str,
    secrets: &[SecretBinding],
) -> Result<(), String> {
    if let Some(name) = secrets::toml_contains_secret(toml, secrets) {
        return Err(format!("{name} must not be written into the routing file."));
    }
    secrets::store_secrets(secrets)?;
    fs::write(active_routes_path(&inner.data_dir), toml).map_err(|e| e.to_string())?;
    if is_maskclaw_build() {
        let sidecar_path = active_maskclaw_path(&inner.data_dir);
        if sidecar_path.is_file() {
            let sidecar = fs::read_to_string(&sidecar_path).map_err(|e| e.to_string())?;
            let synced = sync_maskclaw_local_route(&sidecar, toml);
            if synced != sidecar {
                fs::write(&sidecar_path, synced).map_err(|e| e.to_string())?;
            }
        }
    }
    write_settings(&inner.data_dir, inner.telemetry_opt_in, true)?;
    restart_locked(inner)
}

const LOCAL_ROUTE_IDS: [&str; 3] = ["unsloth-local", "lmstudio-local", "gemma-local"];

fn live_local_route_ids(routes_toml: &str) -> Vec<&'static str> {
    LOCAL_ROUTE_IDS
        .into_iter()
        .filter(|id| {
            routes_toml
                .lines()
                .any(|line| line.trim() == format!("id = \"{id}\""))
        })
        .collect()
}

fn current_local_route_id(maskclaw_toml: &str) -> String {
    for line in maskclaw_toml.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            break;
        }
        let Some(rest) = trimmed.strip_prefix("local_route_id") else {
            continue;
        };
        let rest = rest.trim_start();
        let Some(rest) = rest.strip_prefix('=') else {
            continue;
        };
        return rest.trim().trim_matches('"').to_string();
    }
    String::new()
}

fn sync_maskclaw_local_route(maskclaw_toml: &str, routes_toml: &str) -> String {
    let live = live_local_route_ids(routes_toml);
    let current = current_local_route_id(maskclaw_toml);
    let next = if live.iter().any(|id| *id == current.as_str()) {
        current
    } else {
        live.first().copied().unwrap_or("").to_string()
    };
    set_top_level_toml_string(maskclaw_toml, "local_route_id", &next)
}

fn set_top_level_toml_string(toml: &str, key: &str, value: &str) -> String {
    let prefix = format!("{key} =");
    let mut out = Vec::new();
    let mut saw_table = false;
    let mut replaced = false;
    for line in toml.lines() {
        let trimmed = line.trim();
        if !saw_table && trimmed.starts_with('[') {
            if !replaced && !value.is_empty() {
                out.push(format!("{key} = \"{value}\""));
                replaced = true;
            }
            saw_table = true;
        }
        if !saw_table && trimmed.starts_with(&prefix) {
            replaced = true;
            if value.is_empty() {
                continue;
            }
            out.push(format!("{key} = \"{value}\""));
            continue;
        }
        out.push(line.to_string());
    }
    if !replaced && !value.is_empty() {
        if !out.is_empty() && !out.last().is_some_and(|line| line.is_empty()) {
            out.push(String::new());
        }
        out.push(format!("{key} = \"{value}\""));
    }
    let mut joined = out.join("\n");
    if toml.ends_with('\n') && !joined.ends_with('\n') {
        joined.push('\n');
    }
    joined
}

#[tauri::command]
async fn get_snapshot(app: AppHandle) -> Result<Snapshot, String> {
    with_manager(app, |app, inner| Ok(snapshot_locked(app, inner))).await
}

#[tauri::command]
async fn start_engine(app: AppHandle) -> Result<Snapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app
            .try_state::<AppState>()
            .ok_or_else(|| "app state missing".to_string())?;
        start_engine_now(&state.0)?;
        let inner = state.0.lock().map_err(|e| e.to_string())?;
        Ok(snapshot_locked(&app, &inner))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn stop_engine(app: AppHandle) -> Result<Snapshot, String> {
    with_manager(app, |app, inner| {
        stop_locked(inner)?;
        Ok(snapshot_locked(app, inner))
    })
    .await
}

#[tauri::command]
async fn restart_engine(app: AppHandle) -> Result<Snapshot, String> {
    with_manager(app, |app, inner| {
        restart_locked(inner)?;
        Ok(snapshot_locked(app, inner))
    })
    .await
}

const SETUP_SECRET_ENVS: &[&str] = &[
    "MINIMAX_API_KEY",
    "OPENROUTER_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "CUSTOM_API_KEY",
    "UNSLOTH_API_KEY",
    "LM_STUDIO_API_KEY",
    "OLLAMA_API_KEY",
];

#[tauri::command]
fn persist_secrets(secrets: Vec<SecretBinding>) -> Result<(), String> {
    secrets::store_secrets(&secrets)
}

#[tauri::command]
fn load_setup_secrets() -> Result<HashMap<String, String>, String> {
    let names: Vec<String> = SETUP_SECRET_ENVS.iter().map(|s| (*s).to_string()).collect();
    let loaded = secrets::load_named(&names)?;
    Ok(loaded
        .into_iter()
        .map(|secret| (secret.env_name, secret.value))
        .collect())
}

#[tauri::command]
async fn save_setup(
    app: AppHandle,
    form: SetupForm,
    toml: String,
    secrets: Vec<SecretBinding>,
) -> Result<Snapshot, String> {
    with_manager(app, move |app, inner| {
        inner.telemetry_opt_in = form.telemetry_opt_in;
        write_toml_and_restart(inner, &toml, &secrets)?;
        Ok(snapshot_locked(app, inner))
    })
    .await
}

#[tauri::command]
async fn save_raw_toml(app: AppHandle, toml: String) -> Result<Snapshot, String> {
    with_manager(app, move |app, inner| {
        let names = secrets::api_key_envs_from_toml(&toml);
        let secrets = secrets::load_named(&names)?;
        write_toml_and_restart(inner, &toml, &secrets)?;
        Ok(snapshot_locked(app, inner))
    })
    .await
}

fn write_maskclaw_toml(data_dir: &Path, flavor: &str, toml: &str) -> Result<(), String> {
    write_maskclaw_toml_at(&active_maskclaw_path(data_dir), flavor, toml)
}

fn write_maskclaw_toml_at(dest: &Path, flavor: &str, toml: &str) -> Result<(), String> {
    if flavor != "maskclaw" {
        return Err("MaskClaw is not enabled in this build.".into());
    }
    fs::write(dest, toml).map_err(|e| e.to_string())
}

#[tauri::command]
async fn save_raw_maskclaw_toml(app: AppHandle, toml: String) -> Result<Snapshot, String> {
    if !is_maskclaw_build() {
        return Err("MaskClaw is not enabled in this build.".into());
    }
    with_manager(app, move |app, inner| {
        write_maskclaw_toml(&inner.data_dir, engine_flavor(), &toml)?;
        restart_locked_with_dry_run(inner, maskclaw_save_runs_dry_run())?;
        Ok(snapshot_locked(app, inner))
    })
    .await
}

#[tauri::command]
fn set_telemetry_opt_in(state: State<AppState>, opt_in: bool) -> Result<(), String> {
    let mut inner = state.0.lock().map_err(|e| e.to_string())?;
    inner.telemetry_opt_in = opt_in;
    write_settings(&inner.data_dir, opt_in, true)
}

#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
    if enabled {
        app.autolaunch().enable().map_err(|e| e.to_string())
    } else {
        app.autolaunch().disable().map_err(|e| e.to_string())
    }
}

fn normalize_probe_base(url: &str) -> String {
    url.trim().trim_end_matches('/').to_ascii_lowercase()
}

fn api_key_env_for_base_url(toml: &str, url: &str) -> Option<String> {
    let want = normalize_probe_base(url);
    let mut current_base = None::<String>;
    let mut current_env = None::<String>;
    let mut found = None;
    let flush = |base: &mut Option<String>, env: &mut Option<String>, found: &mut Option<String>| {
        if let (Some(base), Some(env_name)) = (base.take(), env.take()) {
            let have = normalize_probe_base(&base);
            if want == have || want.starts_with(&have) || have.starts_with(&want) {
                *found = Some(env_name);
            }
        }
    };
    for line in toml.lines() {
        let line = line.trim();
        if line.starts_with("[llm_clients.") {
            flush(&mut current_base, &mut current_env, &mut found);
            continue;
        }
        if let Some(rest) = line.strip_prefix("base_url") {
            let value = rest.trim().trim_start_matches('=').trim().trim_matches('"');
            current_base = Some(value.to_string());
        }
        if let Some(rest) = line.strip_prefix("api_key_env") {
            let value = rest.trim().trim_start_matches('=').trim().trim_matches('"');
            current_env = Some(value.to_string());
        }
    }
    flush(&mut current_base, &mut current_env, &mut found);
    found
}

fn probe_bearer(explicit: Option<String>, stored: Option<String>) -> Option<String> {
    explicit
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or(stored)
}

async fn http_get(url: &str) -> Result<(u16, String), String> {
    http_get_auth(url, None).await
}

async fn http_post(url: &str) -> Result<(u16, String), String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(HTTP_TIMEOUT_MS))
        .connect_timeout(Duration::from_millis(HTTP_CONNECT_TIMEOUT_MS))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client.post(url).send().await.map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    Ok((status, body))
}

fn stats_reset_url() -> String {
    format!("{}/v1/stats/reset", listen_url())
}

async fn http_get_auth(url: &str, bearer: Option<&str>) -> Result<(u16, String), String> {
    http_get_auth_timeout(url, bearer, HTTP_TIMEOUT_MS).await
}

async fn http_get_auth_timeout(
    url: &str,
    bearer: Option<&str>,
    timeout_ms: u64,
) -> Result<(u16, String), String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(timeout_ms))
        .connect_timeout(Duration::from_millis(HTTP_CONNECT_TIMEOUT_MS))
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = client.get(url);
    if let Some(token) = bearer.filter(|token| !token.is_empty()) {
        req = req.bearer_auth(token);
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    Ok((status, body))
}

fn models_probe_url(url: &str) -> String {
    let base = url.trim_end_matches('/');
    if base.ends_with("/v1") {
        format!("{base}/models")
    } else {
        format!("{base}/v1/models")
    }
}

fn completions_probe_url(url: &str) -> String {
    let base = url.trim_end_matches('/');
    if base.ends_with("/v1") {
        format!("{base}/chat/completions")
    } else {
        format!("{base}/v1/chat/completions")
    }
}

async fn http_post_json_auth(
    url: &str,
    bearer: Option<&str>,
    body: serde_json::Value,
    timeout_ms: u64,
) -> Result<(u16, String), String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(timeout_ms))
        .connect_timeout(Duration::from_millis(HTTP_CONNECT_TIMEOUT_MS))
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = client.post(url).json(&body);
    if let Some(token) = bearer.filter(|token| !token.is_empty()) {
        req = req.bearer_auth(token);
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    Ok((status, text))
}

#[tauri::command]
async fn fetch_health() -> HealthResult {
    match http_get(&format!("{}/health", listen_url())).await {
        Ok((status, body)) => HealthResult {
            ok: status == 200,
            body,
        },
        Err(err) => HealthResult {
            ok: false,
            body: err,
        },
    }
}

#[tauri::command]
async fn fetch_stats() -> Result<serde_json::Value, String> {
    let (status, body) = http_get(&format!("{}/v1/stats", listen_url())).await?;
    if status != 200 {
        return Err(format!("stats HTTP {status}"));
    }
    serde_json::from_str(&body).map_err(|e| e.to_string())
}

#[tauri::command]
async fn fetch_maskclaw_stats() -> Result<serde_json::Value, String> {
    let (status, body) = http_get(&format!("{}/v1/maskclaw/stats", listen_url())).await?;
    if status != 200 {
        return Err(format!("maskclaw stats HTTP {status}"));
    }
    serde_json::from_str(&body).map_err(|e| e.to_string())
}

#[tauri::command]
async fn reset_engine_stats() -> Result<(), String> {
    let (status, body) = http_post(&stats_reset_url()).await?;
    if status != 200 && status != 204 {
        return Err(format!("reset stats HTTP {status}: {body}"));
    }
    Ok(())
}

#[tauri::command]
async fn fetch_models() -> Result<serde_json::Value, String> {
    let (status, body) = http_get(&format!("{}/v1/models", listen_url())).await?;
    if status != 200 {
        return Err(format!("models HTTP {status}"));
    }
    serde_json::from_str(&body).map_err(|e| e.to_string())
}

#[tauri::command]
async fn probe_backend(
    app: AppHandle,
    url: String,
    api_key: Option<String>,
    model: Option<String>,
) -> ProbeResult {
    let stored = (|| {
        let state = app.try_state::<AppState>()?;
        let inner = state.0.lock().ok()?;
        let toml = fs::read_to_string(active_routes_path(&inner.data_dir)).ok()?;
        let env_name = api_key_env_for_base_url(&toml, &url)?;
        secrets::load_secret(&env_name).ok().flatten()
    })();
    let bearer = probe_bearer(api_key, stored);
    let model_id = model
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if let Some(model_id) = model_id {
        let target = completions_probe_url(&url);
        let payload = serde_json::json!({
            "model": model_id,
            "messages": [{ "role": "user", "content": "ping" }],
            "max_tokens": 1,
            "stream": false
        });
        return match http_post_json_auth(&target, bearer.as_deref(), payload, MODEL_TEST_TIMEOUT_MS)
            .await
        {
            Ok((status, _)) if (200..300).contains(&status) => ProbeResult {
                url: target,
                ok: true,
                label: "Model works".into(),
                detail: format!("HTTP {status}"),
                models: vec![model_id.to_string()],
            },
            Ok((status, _)) => ProbeResult {
                url: target,
                ok: false,
                label: if status == 400 || status == 404 {
                    "Unknown model".into()
                } else {
                    "Unreachable".into()
                },
                detail: format!("HTTP {status}"),
                models: vec![],
            },
            Err(err) => ProbeResult {
                url: target,
                ok: false,
                label: "Unreachable".into(),
                detail: err,
                models: vec![],
            },
        };
    }
    let models_url = models_probe_url(&url);
    match http_get_auth_timeout(&models_url, bearer.as_deref(), MODELS_PROBE_TIMEOUT_MS).await {
        Ok((status, body)) if (200..300).contains(&status) => {
            let models = extract_model_ids(&body);
            ProbeResult {
                url: models_url,
                ok: true,
                label: "Found".into(),
                detail: probe_ok_detail(status),
                models,
            }
        }
        Ok((status, body)) => ProbeResult {
            url: models_url,
            ok: false,
            label: "Not running".into(),
            detail: format!("HTTP {status}: {}", body.chars().take(120).collect::<String>()),
            models: vec![],
        },
        Err(err) => ProbeResult {
            url: models_url,
            ok: false,
            label: "Not running".into(),
            detail: err,
            models: vec![],
        },
    }
}

/// Match the appliance probe: Found + status code, not the full model catalog.
fn probe_ok_detail(status: u16) -> String {
    status.to_string()
}

fn extract_model_ids(body: &str) -> Vec<String> {
    let Ok(json) = serde_json::from_str::<serde_json::Value>(body) else {
        return Vec::new();
    };
    json.get("data")
        .and_then(|d| d.as_array())
        .map(|rows| {
            rows.iter()
                .filter_map(|row| row.get("id").and_then(|id| id.as_str()).map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// Tray layout: Open, a divider, then Quit. Restart stays on HOME, not here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(not(test), allow(dead_code))]
enum TrayMenuPart {
    Item(&'static str, &'static str),
    Separator,
}

#[cfg_attr(not(test), allow(dead_code))]
fn tray_menu_spec() -> &'static [TrayMenuPart] {
    &[
        TrayMenuPart::Item("open", "Open"),
        TrayMenuPart::Separator,
        TrayMenuPart::Item("quit", "Quit"),
    ]
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TrayCommand {
    Open,
    Quit,
}

fn tray_command(id: &str) -> Option<TrayCommand> {
    match id {
        "open" => Some(TrayCommand::Open),
        "quit" => Some(TrayCommand::Quit),
        _ => None,
    }
}

fn show_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn quit_app(app: &AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(mut inner) = state.0.lock() {
            let _ = stop_locked(&mut inner);
        }
    }
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_window(app);
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .setup(|app| {
            let data_dir = ensure_data_dir(app.handle())?;
            let (telemetry_opt_in, _) = read_settings(&data_dir);
            let logs = Arc::new(Mutex::new(VecDeque::new()));
            app.manage(AppState(Mutex::new(AppInner {
                manager: ProcessManager::default(),
                logs,
                telemetry_opt_in,
                data_dir: data_dir.clone(),
            })));

            if let Err(err) = app.autolaunch().enable() {
                eprintln!("autostart enable: {err}");
            }

            let open = MenuItem::with_id(app, "open", "Open", true, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &separator, &quit])?;
            let tray = TrayIconBuilder::with_id("main")
                .icon(include_image!("icons/icon.png"))
                .menu(&menu)
                .on_menu_event(|app, event| match tray_command(event.id.as_ref()) {
                    Some(TrayCommand::Open) => show_window(app),
                    Some(TrayCommand::Quit) => quit_app(app),
                    None => {}
                })
                .tooltip(app_display_name());
            tray.build(app)?;

            let toml_exists = active_routes_path(&data_dir).exists();
            let (_, setup_complete) = read_settings(&data_dir);
            if toml_exists && setup_complete {
                let handle = app.handle().clone();
                // Never block UI/setup on dry-run or spawn; skip if port already taken
                // (e.g. user already runs switchyard-server in a terminal).
                thread::spawn(move || {
                    if let Some(state) = handle.try_state::<AppState>() {
                        if let Err(err) = start_engine_now(&state.0) {
                            eprintln!("switchyard: engine autostart failed: {err}");
                        }
                    }
                });
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_snapshot,
            start_engine,
            stop_engine,
            restart_engine,
            save_setup,
            save_raw_toml,
            save_raw_maskclaw_toml,
            set_telemetry_opt_in,
            set_autostart,
            fetch_health,
            fetch_stats,
            fetch_maskclaw_stats,
            reset_engine_stats,
            fetch_models,
            probe_backend,
            persist_secrets,
            load_setup_secrets,
            open_external_url
        ])
        .build(tauri::generate_context!())
        .expect("error while building Switchyard")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                if let Some(state) = app.try_state::<AppState>() {
                    if let Ok(mut inner) = state.0.lock() {
                        let _ = stop_locked(&mut inner);
                    }
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::net::TcpListener;
    use std::time::Instant;

    #[test]
    fn skip_autostart_when_port_bound() {
        assert!(should_skip_engine_autostart(true));
        assert!(!should_skip_engine_autostart(false));
    }

    #[test]
    fn only_the_x_profile_may_open_externally() {
        assert!(is_allowed_external_url(X_PROFILE_URL));
        assert!(!is_allowed_external_url("https://x.com/someone-else"));
        assert!(!is_allowed_external_url("https://example.com"));
    }

    #[test]
    fn tray_menu_is_open_separator_quit() {
        assert_eq!(
            tray_menu_spec(),
            &[
                TrayMenuPart::Item("open", "Open"),
                TrayMenuPart::Separator,
                TrayMenuPart::Item("quit", "Quit"),
            ]
        );
        assert!(tray_menu_spec().iter().all(|part| {
            !matches!(part, TrayMenuPart::Item("restart", _) | TrayMenuPart::Item(_, "Restart"))
        }));
        assert_eq!(tray_command("open"), Some(TrayCommand::Open));
        assert_eq!(tray_command("quit"), Some(TrayCommand::Quit));
        assert_eq!(tray_command("restart"), None);
    }

    #[test]
    fn tray_icon_png_lives_in_the_tauri_crate() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("icons/icon.png");
        assert!(path.is_file(), "{}", path.display());
    }

    #[test]
    fn start_replaces_an_already_bound_listen_port() {
        assert_eq!(
            decide_start(false, true),
            StartDecision::ReplaceExistingListener
        );
        assert_eq!(decide_start(true, true), StartDecision::AlreadyManaged);
        assert_eq!(decide_start(false, false), StartDecision::Spawn);
    }

    #[test]
    fn detector_save_skips_dry_run_console_spawn() {
        assert!(!maskclaw_save_runs_dry_run());
    }

    #[test]
    fn netstat_parse_finds_listen_pid() {
        let sample = "\r\n  TCP    127.0.0.1:4000         0.0.0.0:0              LISTENING       4242\r\n";
        assert_eq!(parse_listening_pid(sample, 4000), Some(4242));
        assert_eq!(parse_listening_pid(sample, 4001), None);
    }

    #[test]
    fn probe_picks_unsloth_key_env_for_matching_base_url() {
        let toml = r#"
[llm_clients.minimax]
base_url = "https://api.minimax.io/v1"
api_key_env = "MINIMAX_API_KEY"

[llm_clients.unsloth]
base_url = "http://127.0.0.1:8888/v1"
api_key_env = "UNSLOTH_API_KEY"
"#;
        assert_eq!(
            api_key_env_for_base_url(toml, "http://127.0.0.1:8888/v1"),
            Some("UNSLOTH_API_KEY".into())
        );
        assert_eq!(
            api_key_env_for_base_url(toml, "https://api.minimax.io/v1"),
            Some("MINIMAX_API_KEY".into())
        );
    }

    #[test]
    fn probe_bearer_prefers_the_pasted_key() {
        assert_eq!(
            probe_bearer(Some("  sk-live  ".into()), Some("sk-stored".into())).as_deref(),
            Some("sk-live")
        );
        assert_eq!(
            probe_bearer(Some("".into()), Some("sk-stored".into())).as_deref(),
            Some("sk-stored")
        );
        assert_eq!(probe_bearer(None, None), None);
    }

    #[test]
    fn probe_urls_append_models_or_chat_completions() {
        assert_eq!(
            models_probe_url("http://127.0.0.1:8888/v1"),
            "http://127.0.0.1:8888/v1/models"
        );
        assert_eq!(
            completions_probe_url("https://api.minimax.io/v1"),
            "https://api.minimax.io/v1/chat/completions"
        );
        assert_eq!(
            completions_probe_url("https://api.openai.com"),
            "https://api.openai.com/v1/chat/completions"
        );
    }

    #[test]
    fn probe_success_note_is_the_status_not_every_model_id() {
        assert_eq!(probe_ok_detail(200), "200");
        assert!(!probe_ok_detail(200).contains("loaded"));
    }

    #[test]
    fn workspace_routes_toml_wins_over_appdata() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("switchyard-workspace-{nanos}"));
        fs::create_dir_all(root.join("apps").join("desktop")).expect("tree");
        let routes = root.join("routes.toml");
        fs::write(&routes, "schema_version = 1\n").expect("write");
        assert_eq!(
            find_workspace_routes_from(root.join("apps").join("desktop")).as_deref(),
            Some(routes.as_path())
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn port_busy_detects_open_listener() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("addr");
        let accept = thread::spawn(move || {
            let _ = listener.accept();
        });
        assert!(port_busy(addr, Duration::from_millis(200)));
        let _ = TcpStream::connect(addr);
        let _ = accept.join();
    }

    #[test]
    fn port_busy_false_for_closed_port() {
        // Bind and drop so the port is free again.
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("addr");
        drop(listener);
        assert!(!port_busy(addr, Duration::from_millis(100)));
    }

    #[tokio::test]
    async fn http_get_times_out_when_server_never_responds() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("addr");
        thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 128];
                let _ = stream.read(&mut buf);
                thread::sleep(Duration::from_secs(30));
            }
        });
        let url = format!("http://{addr}/health");
        let started = Instant::now();
        let err = http_get(&url).await.expect_err("should time out");
        assert!(
            started.elapsed() < Duration::from_millis(HTTP_TIMEOUT_MS + 1500),
            "elapsed {:?}, err={err}",
            started.elapsed()
        );
        assert!(!err.is_empty());
    }

    #[test]
    fn stats_reset_posts_to_v1_stats_reset() {
        assert_eq!(
            stats_reset_url(),
            format!("{}/v1/stats/reset", listen_url())
        );
    }

    #[test]
    fn maskclaw_flavor_uses_maskclaw_desktop_name() {
        assert_eq!(app_display_name_for("stock"), "Switchyard");
        assert_eq!(app_display_name_for("maskclaw"), "MASKCLAW DESKTOP");
    }

    #[test]
    fn maskclaw_toml_is_a_sibling_of_routes() {
        let routes = PathBuf::from("data").join("routes.toml");
        assert_eq!(
            maskclaw_path_for_routes(&routes),
            PathBuf::from("data").join("maskclaw.toml")
        );
    }

    #[test]
    fn stock_server_args_omit_maskclaw_config() {
        let data_dir = PathBuf::from("C:/data");
        let args = server_args_for(&data_dir, "stock");
        assert!(!args.iter().any(|arg| arg == "--maskclaw-config"));
        assert!(args.contains(&"--config".to_string()));
    }

    #[test]
    fn maskclaw_server_args_include_maskclaw_config() {
        let data_dir = PathBuf::from("C:/data");
        let args = server_args_for(&data_dir, "maskclaw");
        let pos = args
            .iter()
            .position(|arg| arg == "--maskclaw-config")
            .expect("flag");
        assert!(args[pos + 1].ends_with("maskclaw.toml"));
    }

    #[test]
    fn stock_seed_does_not_write_maskclaw_toml() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("switchyard-maskclaw-stock-{nanos}"));
        fs::create_dir_all(&dir).expect("dir");
        let dest = dir.join("maskclaw.toml");
        seed_maskclaw_file(&dest, "stock").expect("seed");
        assert!(!dest.exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn maskclaw_seed_writes_default_sidecar() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("switchyard-maskclaw-seed-{nanos}"));
        let dest = dir.join("maskclaw.toml");
        seed_maskclaw_file(&dest, "maskclaw").expect("seed");
        let body = fs::read_to_string(&dest).expect("read");
        assert!(body.contains("enabled = true"));
        assert!(body.contains("[detectors]"));
        assert!(!body.contains("unsloth"));
        assert!(!body.contains("local_route_id"));
        seed_maskclaw_file(&dest, "maskclaw").expect("idempotent");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn sync_drops_stale_unsloth_local_route() {
        let sidecar = "enabled = true\nforce_local = \"never\"\nlocal_route_id = \"unsloth-local\"\n\n[detectors]\nemail = true\n";
        let routes = "schema_version = 1\n[routes.minimax]\nid = \"minimax-m3\"\n";
        let synced = sync_maskclaw_local_route(sidecar, routes);
        assert!(!synced.contains("unsloth"));
        assert!(!synced.contains("local_route_id"));
        let keep = sync_maskclaw_local_route(
            sidecar,
            "schema_version = 1\n[routes.local]\nid = \"unsloth-local\"\n",
        );
        assert!(keep.contains("unsloth-local"));
    }

    #[test]
    fn stock_build_rejects_maskclaw_toml_writes() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let dest = std::env::temp_dir().join(format!("switchyard-maskclaw-reject-{nanos}.toml"));
        let err = write_maskclaw_toml_at(&dest, "stock", "enabled = true\n").expect_err("stock");
        assert!(err.contains("not enabled"));
        assert!(!dest.exists());
    }

    #[test]
    fn maskclaw_build_writes_maskclaw_toml() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let dest = std::env::temp_dir().join(format!("switchyard-maskclaw-write-{nanos}.toml"));
        write_maskclaw_toml_at(&dest, "maskclaw", "enabled = false\n").expect("write");
        assert_eq!(fs::read_to_string(&dest).expect("read"), "enabled = false\n");
        let _ = fs::remove_file(dest);
    }

    #[cfg(windows)]
    #[test]
    fn hidden_console_flag_is_create_no_window() {
        assert_eq!(WINDOWS_CREATE_NO_WINDOW, 0x0800_0000);
    }
}



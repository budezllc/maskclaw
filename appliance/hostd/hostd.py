#!/usr/bin/env python3
"""MaskClaw appliance hostd: box admin + /control API used by the dashboard."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import socket
import subprocess
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Callable
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

LISTEN_HOST = os.environ.get("MASKCLAW_HOSTD_BIND", "127.0.0.1")
LISTEN_PORT = int(os.environ.get("MASKCLAW_HOSTD_PORT", "8787"))
ENGINE_UNIT = os.environ.get("MASKCLAW_ENGINE_UNIT", "maskclaw-server.service")
SECRET_RE = re.compile(r'(?:^|\n)\s*api_key\s*=\s*"(sk-|AKIA|ghp_|glpat-)', re.M)
BASE_URL_RE = re.compile(r'base_url\s*=\s*"([^"]+)"')
API_KEY_ENV_RE = re.compile(r'api_key_env\s*=\s*"([A-Z][A-Z0-9_]*)"')
ENV_NAME_RE = re.compile(r"^[A-Z][A-Z0-9_]*$")
HOSTNAME_RE = re.compile(r"^(?=.{1,63}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
SESSION_COOKIE = "maskclaw_session"
PBKDF2_ROUNDS = 120_000
MIN_PASSWORD_LEN = 8

SystemctlFn = Callable[[str], None]
NmcliFn = Callable[[list[str]], str]
HostnamectlFn = Callable[[str], None]
RfkillFn = Callable[[], None]


def config_dir() -> Path:
    return Path(os.environ.get("MASKCLAW_CONFIG_DIR", "/etc/maskclaw"))


def caddy_root_ca_path() -> Path | None:
    """Locate Caddy's local root CA (tls internal) for browser trust downloads."""
    override = os.environ.get("MASKCLAW_CADDY_ROOT_CA", "").strip()
    candidates: list[Path] = []
    if override:
        candidates.append(Path(override))
    # Prefer a world-readable copy install/hostd may publish for downloads.
    candidates.append(config_dir() / "caddy-root.crt")
    xdg = os.environ.get("XDG_DATA_HOME", "").strip()
    if xdg:
        candidates.append(Path(xdg) / "caddy" / "pki" / "authorities" / "local" / "root.crt")
    candidates.append(Path("/var/lib/maskclaw/.local/share/caddy/pki/authorities/local/root.crt"))
    for path in candidates:
        try:
            if path.is_file() and path.stat().st_size > 0:
                return path
        except OSError:
            continue
    return None


def publish_caddy_root_ca() -> Path | None:
    """Copy Caddy's root CA to a readable path under the config dir for downloads."""
    src = Path("/var/lib/maskclaw/.local/share/caddy/pki/authorities/local/root.crt")
    try:
        if not (src.is_file() and src.stat().st_size > 0):
            return None
        dest = config_dir() / "caddy-root.crt"
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(src.read_bytes())
        dest.chmod(0o644)
    except OSError:
        return None
    return dest


def run_systemctl(action: str) -> None:
    subprocess.run(
        ["systemctl", action, ENGINE_UNIT],
        check=True,
        timeout=60,
        capture_output=True,
        text=True,
    )


_systemctl: SystemctlFn = run_systemctl


def set_systemctl(fn: SystemctlFn | None) -> None:
    global _systemctl
    _systemctl = fn or run_systemctl


def run_nmcli(args: list[str]) -> str:
    result = subprocess.run(
        ["nmcli", "-t", *args],
        capture_output=True,
        text=True,
        timeout=45,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError((result.stderr or result.stdout or "nmcli failed").strip())
    return result.stdout


def run_hostnamectl(name: str) -> None:
    subprocess.run(
        ["hostnamectl", "set-hostname", name],
        check=True,
        timeout=15,
        capture_output=True,
        text=True,
    )


def run_rfkill_unblock() -> None:
    subprocess.run(["rfkill", "unblock", "wifi"], check=False, timeout=10, capture_output=True)


_nmcli: NmcliFn | None = run_nmcli
_hostnamectl: HostnamectlFn = run_hostnamectl
_rfkill: RfkillFn = run_rfkill_unblock


def set_nmcli(fn: NmcliFn | None | str = "reset") -> None:
    global _nmcli
    if fn == "reset":
        _nmcli = run_nmcli
        return
    _nmcli = None if fn is None else fn  # type: ignore[assignment]


def set_hostnamectl(fn: HostnamectlFn | None) -> None:
    global _hostnamectl
    _hostnamectl = fn or run_hostnamectl


def set_rfkill(fn: RfkillFn | None) -> None:
    global _rfkill
    _rfkill = fn or run_rfkill_unblock


def etc_hostname_path() -> Path:
    return Path(os.environ.get("MASKCLAW_ETC_HOSTNAME", "/etc/hostname"))


def etc_hosts_path() -> Path:
    return Path(os.environ.get("MASKCLAW_ETC_HOSTS", "/etc/hosts"))


def parse_env_file_text(text: str) -> dict[str, str]:
    stored: dict[str, str] = {}
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        name = key.strip()
        if ENV_NAME_RE.match(name):
            stored[name] = value.strip().strip("'").strip('"')
    return stored


def parse_env_file(path: Path) -> dict[str, str]:
    if not path.is_file():
        return {}
    return parse_env_file_text(path.read_text(encoding="utf-8"))


def load_engine_env() -> dict[str, str]:
    env = os.environ.copy()
    env.update(parse_env_file(config_dir() / "engine.env"))
    return env


def extract_api_key_envs(toml: str) -> list[str]:
    names: list[str] = []
    for match in API_KEY_ENV_RE.finditer(toml):
        name = match.group(1)
        if name not in names:
            names.append(name)
    return names


def secret_status() -> list[dict[str, object]]:
    stored = parse_env_file(config_dir() / "engine.env")
    names = extract_api_key_envs(_read_toml("routes.toml"))
    for key in stored:
        if key not in names:
            names.append(key)
    return [{"name": name, "set": bool(stored.get(name))} for name in names]


def write_secrets(values: dict[str, str]) -> None:
    path = config_dir() / "engine.env"
    stored = parse_env_file(path)
    wrote = False
    for key, value in values.items():
        if not ENV_NAME_RE.match(key):
            raise ValueError(f"invalid env name {key}")
        trimmed = value.strip()
        if trimmed:
            stored[key] = trimmed
            wrote = True
    if not wrote:
        raise ValueError("enter at least one API key")
    lines = ["# MaskClaw engine environment. Keep this file private.", ""]
    for key, value in stored.items():
        lines.append(f"{key}={value}")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def parse_secrets_body(raw: bytes) -> dict[str, str]:
    parsed = json.loads(raw.decode("utf-8") or "{}")
    values = parsed.get("values")
    if not isinstance(values, dict):
        raise ValueError("values must be an object")
    out: dict[str, str] = {}
    for key, value in values.items():
        if not isinstance(key, str) or not isinstance(value, str):
            raise ValueError("secret names and values must be strings")
        out[key] = value
    return out


def journal_tail() -> str:
    lines = journal_lines(40)
    for line in reversed(lines):
        if "invalid server config" in line or "environment variable not found" in line:
            return line
    if lines:
        return lines[-1]
    return "engine failed to start"


def journal_lines(max_lines: int = 40) -> list[str]:
    try:
        result = subprocess.run(
            ["journalctl", "-u", ENGINE_UNIT, "-n", str(max_lines), "--no-pager", "-o", "cat"],
            capture_output=True,
            text=True,
            timeout=8,
        )
        return [line for line in (result.stdout or "").splitlines() if line.strip()][-max_lines:]
    except Exception:
        return []


def routing_log_path() -> Path:
    return Path(os.environ.get("MASKCLAW_ROUTING_LOG", "/var/lib/maskclaw/routing.jsonl"))


def tail_file_lines(path: Path, max_lines: int) -> list[str]:
    if not path.is_file():
        return []
    try:
        lines = [line for line in path.read_text(encoding="utf-8", errors="replace").splitlines() if line.strip()]
    except OSError:
        return []
    return lines[-max_lines:]


def activity_logs() -> list[str]:
    return (tail_file_lines(routing_log_path(), 40) + journal_lines(40))[-80:]


def dry_run_config() -> str | None:
    binary = os.environ.get("MASKCLAW_SERVER_BIN", "/opt/maskclaw/bin/switchyard-server")
    if not Path(binary).is_file():
        return None
    routes = config_dir() / "routes.toml"
    maskclaw = config_dir() / "maskclaw.toml"
    cmd = [binary, "--config", str(routes), "--dry-run"]
    if maskclaw.is_file():
        cmd.extend(["--maskclaw-config", str(maskclaw)])
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=30, env=load_engine_env())
    if result.returncode == 0:
        return None
    err = (result.stderr or result.stdout or "dry-run failed").strip()
    return err.splitlines()[-1] if err else "dry-run failed"


def wait_for_engine(timeout_s: float = 8.0) -> bool:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if engine_up():
            return True
        time.sleep(0.25)
    return False


def _read_toml(name: str) -> str:
    path = config_dir() / name
    if not path.is_file():
        return ""
    return path.read_text(encoding="utf-8")


def _write_toml(name: str, toml: str) -> None:
    config_dir().mkdir(parents=True, exist_ok=True)
    (config_dir() / name).write_text(toml, encoding="utf-8")


def engine_up() -> bool:
    url = os.environ.get("MASKCLAW_ENGINE_HEALTH", "http://127.0.0.1:4000/health")
    try:
        with urlopen(url, timeout=2) as response:
            return 200 <= response.status < 300
    except (URLError, TimeoutError, OSError):
        return False


def snapshot() -> dict[str, object]:
    up = engine_up()
    return {
        "listenUrl": "http://127.0.0.1:4000",
        "engineUp": up,
        "lastError": None if up else "Engine is not responding on 127.0.0.1:4000",
        "routesToml": _read_toml("routes.toml"),
        "maskclawToml": _read_toml("maskclaw.toml"),
        "logs": activity_logs(),
    }


def toml_contains_literal_secret(toml: str) -> bool:
    return SECRET_RE.search(toml) is not None


def extract_base_urls(toml: str) -> list[str]:
    seen: list[str] = []
    for match in BASE_URL_RE.finditer(toml):
        url = match.group(1)
        if url not in seen:
            seen.append(url)
    return seen


def models_probe_url(url: str) -> str:
    base = url.rstrip("/")
    return f"{base}/models" if base.endswith("/v1") else f"{base}/v1/models"


def completions_probe_url(url: str) -> str:
    base = url.rstrip("/")
    return f"{base}/chat/completions" if base.endswith("/v1") else f"{base}/v1/chat/completions"


def api_key_env_for_base_url(toml: str, base_url: str) -> str | None:
    """Return the api_key_env for an [llm_clients.*] table whose base_url matches."""
    wanted = base_url.rstrip("/")
    in_client = False
    current_url: str | None = None
    env_name: str | None = None
    matched: str | None = None
    for raw in toml.splitlines():
        line = raw.strip()
        if line.startswith("[") and line.endswith("]"):
            if in_client and current_url and current_url.rstrip("/") == wanted:
                matched = env_name
            in_client = line.startswith("[llm_clients.")
            current_url = None
            env_name = None
            continue
        if not in_client:
            continue
        url_match = re.match(r'base_url\s*=\s*"([^"]+)"', line)
        if url_match:
            current_url = url_match.group(1)
        env_match = re.match(r'api_key_env\s*=\s*"([^"]+)"', line)
        if env_match:
            env_name = env_match.group(1)
    if in_client and current_url and current_url.rstrip("/") == wanted:
        matched = env_name
    return matched


def probe_bearer_for(base_url: str, toml: str | None = None, env: dict[str, str] | None = None) -> str | None:
    source = toml if toml is not None else _read_toml("routes.toml")
    name = api_key_env_for_base_url(source, base_url)
    if not name:
        return None
    values = env if env is not None else load_engine_env()
    key = values.get(name, "").strip()
    return key or None


def probe_status_label(status: int, sent_auth: bool) -> tuple[bool, str]:
    if 200 <= status < 400:
        return True, "Found"
    if status in (401, 403) and not sent_auth:
        return False, "Needs API key"
    if status in (401, 403):
        return False, "Auth failed"
    return False, "Unreachable"


def extract_model_ids(body: str) -> list[str]:
    try:
        parsed = json.loads(body)
    except json.JSONDecodeError:
        return []
    data = parsed.get("data") if isinstance(parsed, dict) else None
    if not isinstance(data, list):
        return []
    ids: list[str] = []
    for item in data:
        if isinstance(item, dict) and isinstance(item.get("id"), str):
            ids.append(item["id"])
    return ids


def probe_url(
    url: str,
    toml: str | None = None,
    env: dict[str, str] | None = None,
    bearer: str | None = None,
    model: str | None = None,
) -> dict[str, object]:
    token = (bearer or "").strip() or probe_bearer_for(url, toml=toml, env=env)
    wanted = (model or "").strip()
    if wanted:
        return probe_model(url, wanted, token)
    target = models_probe_url(url)
    headers: dict[str, str] = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    try:
        req = Request(target, method="GET", headers=headers)
        with urlopen(req, timeout=8) as response:
            body = response.read().decode("utf-8", "replace")
            ok, label = probe_status_label(response.status, bool(token))
            return {
                "url": target,
                "ok": ok,
                "label": label,
                "detail": str(response.status),
                "models": extract_model_ids(body),
            }
    except HTTPError as exc:
        ok, label = probe_status_label(exc.code, bool(token))
        return {"url": target, "ok": ok, "label": label, "detail": f"HTTP {exc.code}", "models": []}
    except Exception as exc:  # noqa: BLE001 — probe must never crash the handler
        return {"url": target, "ok": False, "label": "Not running", "detail": str(exc), "models": []}


def probe_model(url: str, model: str, token: str | None) -> dict[str, object]:
    target = completions_probe_url(url)
    headers: dict[str, str] = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    payload = json.dumps(
        {
            "model": model,
            "messages": [{"role": "user", "content": "ping"}],
            "max_tokens": 1,
            "stream": False,
        }
    ).encode("utf-8")
    try:
        req = Request(target, data=payload, method="POST", headers=headers)
        with urlopen(req, timeout=12) as response:
            response.read(256)
            return {
                "url": target,
                "ok": True,
                "label": "Model works",
                "detail": str(response.status),
                "models": [model],
            }
    except HTTPError as exc:
        unknown = exc.code in (400, 404)
        if exc.code in (401, 403) and not token:
            label = "Needs API key"
        elif exc.code in (401, 403):
            label = "Auth failed"
        elif unknown:
            label = "Unknown model"
        else:
            label = "Unreachable"
        return {
            "url": target,
            "ok": False,
            "label": label,
            "detail": f"HTTP {exc.code}",
            "models": [],
        }
    except Exception as exc:  # noqa: BLE001 — probe must never crash the handler
        return {"url": target, "ok": False, "label": "Unreachable", "detail": str(exc), "models": []}


def parse_toml_body(raw: bytes) -> str:
    parsed = json.loads(raw.decode("utf-8") or "{}")
    toml = parsed.get("toml")
    if not isinstance(toml, str):
        raise ValueError("toml must be a string")
    return toml


def auth_path() -> Path:
    return config_dir() / "dashboard.auth"


def setup_token_path() -> Path:
    return config_dir() / "setup.token"


def sessions_path() -> Path:
    return config_dir() / "sessions.json"


def password_is_set() -> bool:
    return auth_path().is_file() and bool(auth_path().read_text(encoding="utf-8").strip())


def read_setup_token() -> str | None:
    path = setup_token_path()
    if not path.is_file():
        return None
    token = path.read_text(encoding="utf-8").strip()
    return token or None


def write_setup_token(token: str) -> None:
    config_dir().mkdir(parents=True, exist_ok=True)
    path = setup_token_path()
    path.write_text(token + "\n", encoding="utf-8")
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def clear_setup_token() -> None:
    path = setup_token_path()
    if path.is_file():
        path.unlink()


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ROUNDS)
    return "pbkdf2_sha256${}${}${}".format(
        PBKDF2_ROUNDS,
        base64.b64encode(salt).decode("ascii"),
        base64.b64encode(digest).decode("ascii"),
    )


def verify_password(password: str, stored: str) -> bool:
    parts = stored.strip().split("$")
    if len(parts) != 4 or parts[0] != "pbkdf2_sha256":
        return False
    try:
        rounds = int(parts[1])
        salt = base64.b64decode(parts[2])
        expected = base64.b64decode(parts[3])
    except (ValueError, OSError):
        return False
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, rounds)
    return hmac.compare_digest(digest, expected)


def load_sessions() -> list[str]:
    path = sessions_path()
    if not path.is_file():
        return []
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    tokens = parsed.get("tokens") if isinstance(parsed, dict) else None
    if not isinstance(tokens, list):
        return []
    return [item for item in tokens if isinstance(item, str)]


def save_sessions(tokens: list[str]) -> None:
    config_dir().mkdir(parents=True, exist_ok=True)
    path = sessions_path()
    path.write_text(json.dumps({"tokens": tokens}) + "\n", encoding="utf-8")
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def create_session() -> str:
    token = secrets.token_urlsafe(32)
    tokens = load_sessions()
    tokens.append(token)
    save_sessions(tokens)
    return token


def revoke_session(token: str | None) -> None:
    if not token:
        return
    save_sessions([item for item in load_sessions() if item != token])


def clear_sessions() -> None:
    save_sessions([])


def write_password_hash(password: str) -> None:
    if len(password) < MIN_PASSWORD_LEN:
        raise ValueError(f"password must be at least {MIN_PASSWORD_LEN} characters")
    config_dir().mkdir(parents=True, exist_ok=True)
    path = auth_path()
    path.write_text(hash_password(password) + "\n", encoding="utf-8")
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    clear_sessions()


def set_dashboard_password(
    password: str,
    current: str | None,
    setup_token: str | None = None,
) -> None:
    if password_is_set():
        stored = auth_path().read_text(encoding="utf-8").strip()
        if not current or not verify_password(current, stored):
            raise PermissionError("current password is required")
    else:
        expected = read_setup_token()
        if not expected:
            raise PermissionError("setup token is required")
        if not setup_token or not hmac.compare_digest(setup_token.strip(), expected):
            raise PermissionError("invalid setup token")
    write_password_hash(password)
    clear_setup_token()


def login_password(password: str) -> str:
    if not password_is_set():
        raise ValueError("password is not set")
    stored = auth_path().read_text(encoding="utf-8").strip()
    if not verify_password(password, stored):
        raise PermissionError("invalid password")
    return create_session()


def parse_session_cookie(header: str | None) -> str | None:
    if not header:
        return None
    for part in header.split(";"):
        name, _, value = part.strip().partition("=")
        if name == SESSION_COOKIE and value:
            return value
    return None


def session_ok(cookie_header: str | None) -> dict[str, object]:
    set_flag = password_is_set()
    token = parse_session_cookie(cookie_header)
    logged_in = bool(token and token in load_sessions())
    # Gated routes always need a login cookie. Unset password is not an open LAN.
    ok = logged_in
    return {"ok": ok, "passwordSet": set_flag, "loggedIn": logged_in}


def cookie_header(token: str, *, clear: bool = False, secure: bool = False) -> str:
    flags = "Path=/; HttpOnly; SameSite=Strict"
    if secure:
        flags = f"{flags}; Secure"
    if clear:
        return f"{SESSION_COOKIE}=; {flags}; Max-Age=0"
    return f"{SESSION_COOKIE}={token}; {flags}"


def parse_json_object(raw: bytes) -> dict[str, object]:
    parsed = json.loads(raw.decode("utf-8") or "{}")
    if not isinstance(parsed, dict):
        raise ValueError("body must be an object")
    return parsed


def validate_hostname(name: str) -> str:
    host = name.strip().lower()
    if not HOSTNAME_RE.match(host):
        raise ValueError("hostname must be a single DNS label (letters, digits, hyphen)")
    return host


def update_hosts_file(hostname: str) -> None:
    path = etc_hosts_path()
    if path.is_file():
        lines = path.read_text(encoding="utf-8").splitlines()
    else:
        lines = ["127.0.0.1\tlocalhost"]
    replaced = False
    next_lines: list[str] = []
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("127.0.1.1"):
            next_lines.append(f"127.0.1.1\t{hostname}")
            replaced = True
        else:
            next_lines.append(line)
    if not replaced:
        next_lines.append(f"127.0.1.1\t{hostname}")
    path.write_text("\n".join(next_lines) + "\n", encoding="utf-8")


def set_hostname(name: str) -> str:
    host = validate_hostname(name)
    etc_hostname_path().write_text(host + "\n", encoding="utf-8")
    update_hosts_file(host)
    _hostnamectl(host)
    stamp = config_dir() / ".hostname-user"
    config_dir().mkdir(parents=True, exist_ok=True)
    stamp.write_text(host + "\n", encoding="utf-8")
    return host


def iface_kind(nm_type: str) -> str:
    if nm_type == "ethernet":
        return "ethernet"
    if nm_type == "wifi":
        return "wifi"
    return "other"


def parse_device_status(text: str) -> list[dict[str, object]]:
    devices: list[dict[str, object]] = []
    for line in text.splitlines():
        if not line.strip():
            continue
        parts = line.split(":")
        if len(parts) < 3:
            continue
        name, nm_type, state = parts[0], parts[1], parts[2]
        connection = parts[3] if len(parts) > 3 else ""
        kind = iface_kind(nm_type)
        if kind == "other":
            continue
        devices.append(
            {
                "name": name,
                "type": kind,
                "state": state,
                "connected": state == "connected",
                "connection": connection,
                "ip": None,
            }
        )
    return devices


def parse_wifi_list(text: str) -> list[dict[str, object]]:
    networks: list[dict[str, object]] = []
    seen: set[str] = set()
    for line in text.splitlines():
        if not line.strip():
            continue
        parts = line.split(":")
        ssid = parts[0]
        if not ssid or ssid in seen:
            continue
        seen.add(ssid)
        signal = 0
        if len(parts) > 1:
            try:
                signal = int(parts[1])
            except ValueError:
                signal = 0
        security = parts[2] if len(parts) > 2 else ""
        networks.append({"ssid": ssid, "signal": signal, "security": security})
    networks.sort(key=lambda item: int(item["signal"]), reverse=True)
    return networks


def device_ipv4(name: str) -> str | None:
    if _nmcli is None:
        return None
    try:
        text = _nmcli(["-f", "IP4.ADDRESS", "device", "show", name])
    except Exception:
        return None
    for line in text.splitlines():
        _, _, value = line.partition(":")
        addr = value.strip().split("/")[0]
        if addr:
            return addr
    return None


def nmcli_available() -> bool:
    return _nmcli is not None


def network_info() -> dict[str, object]:
    hostname = socket.gethostname()
    addresses: list[str] = []
    try:
        packed = socket.getaddrinfo(hostname, None)
        for item in packed:
            addr = item[4][0]
            if addr not in addresses and "%" not in addr:
                addresses.append(addr)
    except OSError:
        pass
    devices: list[dict[str, object]] = []
    wifi_available = False
    radio_on = False
    connected_ssid: str | None = None
    networks: list[dict[str, object]] = []
    if _nmcli is not None:
        try:
            devices = parse_device_status(_nmcli(["-f", "DEVICE,TYPE,STATE,CONNECTION", "device", "status"]))
            wifi_available = True
            for device in devices:
                ip = device_ipv4(str(device["name"]))
                if ip:
                    device["ip"] = ip
                    if ip not in addresses:
                        addresses.append(ip)
            wifi_dev = next((item for item in devices if item["type"] == "wifi"), None)
            if wifi_dev and wifi_dev["connected"]:
                radio_on = True
                conn = str(wifi_dev.get("connection") or "")
                connected_ssid = conn or None
            try:
                radio = _nmcli(["radio", "wifi"]).strip().lower()
                radio_on = radio in ("enabled", "on")
            except Exception:
                pass
            if radio_on:
                try:
                    networks = parse_wifi_list(_nmcli(["-f", "SSID,SIGNAL,SECURITY", "device", "wifi", "list"]))
                except Exception:
                    networks = []
        except Exception:
            wifi_available = False
            devices = []
    active = next((item for item in devices if item["connected"]), None)
    return {
        "hostname": hostname,
        "addresses": addresses,
        "config_dir": str(config_dir()),
        "wifiAvailable": wifi_available,
        "interfaces": devices,
        "wifi": {
            "available": wifi_available,
            "radioOn": radio_on,
            "connectedSsid": connected_ssid,
            "networks": networks,
        },
        "active": (
            {"device": active["name"], "type": active["type"]}
            if active
            else None
        ),
    }


def connect_ethernet() -> None:
    if _nmcli is None:
        raise RuntimeError("NetworkManager is not available")
    devices = parse_device_status(_nmcli(["-f", "DEVICE,TYPE,STATE,CONNECTION", "device", "status"]))
    ethernet = next((item for item in devices if item["type"] == "ethernet"), None)
    if ethernet is None:
        raise RuntimeError("no ethernet device")
    _nmcli(["device", "connect", str(ethernet["name"])])


def connect_wifi(ssid: str, password: str | None) -> None:
    if _nmcli is None:
        raise RuntimeError("NetworkManager is not available")
    name = ssid.strip()
    if not name:
        raise ValueError("ssid is required")
    _rfkill()
    args = ["device", "wifi", "connect", name]
    if password:
        args.extend(["password", password])
    _nmcli(args)


PUBLIC_PATHS = {
    "/host/health",
    "/health",
    "/host/session",
    "/host/login",
    "/host/logout",
    "/host/password",
    "/host/ca.crt",
}


class HostHandler(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args: object) -> None:
        return

    def _send(
        self,
        code: int,
        body: dict[str, object],
        extra_headers: list[tuple[str, str]] | None = None,
    ) -> None:
        payload = json.dumps(body).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        for key, value in extra_headers or []:
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(payload)

    def _send_bytes(
        self,
        code: int,
        payload: bytes,
        content_type: str,
        extra_headers: list[tuple[str, str]] | None = None,
    ) -> None:
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        for key, value in extra_headers or []:
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(payload)

    def _ca_cert(self) -> None:
        path = caddy_root_ca_path()
        if path is None:
            path = publish_caddy_root_ca()
        if path is None:
            self._send(404, {"error": "ca_not_ready"})
            return
        try:
            payload = path.read_bytes()
        except OSError as exc:
            self._send(500, {"error": str(exc)})
            return
        self._send_bytes(
            200,
            payload,
            "application/x-x509-ca-cert",
            [("Content-Disposition", 'attachment; filename="maskclaw-caddy-root.crt"')],
        )

    def _read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return b""
        return self.rfile.read(length)

    def _cookie(self) -> str | None:
        return self.headers.get("Cookie")

    def _secure_cookie(self) -> bool:
        return (self.headers.get("X-Forwarded-Proto") or "").lower() == "https"

    def _set_cookie(self, token: str, *, clear: bool = False) -> str:
        return cookie_header(token, clear=clear, secure=self._secure_cookie())

    def _gate(self, path: str) -> bool:
        if path in PUBLIC_PATHS:
            return True
        status = session_ok(self._cookie())
        if status["ok"]:
            return True
        self._send(401, {"error": "auth_required", **status})
        return False

    def _session_body(self) -> None:
        status = session_ok(self._cookie())
        code = 200 if status["ok"] else 401
        self._send(code, status)

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path.removesuffix("/") or "/"
        if path == "/host/session":
            self._session_body()
            return
        if not self._gate(path):
            return
        if path in ("/host/health", "/health"):
            self._send(200, {"ok": True})
            return
        if path == "/host/ca.crt":
            self._ca_cert()
            return
        if path == "/host/network":
            self._send(200, network_info())
            return
        if path == "/control/snapshot":
            self._send(200, snapshot())
            return
        if path == "/control/toml/routes":
            self._send(200, {"toml": _read_toml("routes.toml")})
            return
        if path == "/control/toml/maskclaw":
            self._send(200, {"toml": _read_toml("maskclaw.toml")})
            return
        if path == "/control/secrets":
            self._send(200, {"secrets": secret_status()})
            return
        if path in ("/host/config/maskclaw", "/host/config/routes"):
            self._send(501, {"error": "use_/control/toml"})
            return
        self._send(404, {"error": "not_found"})

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path.removesuffix("/") or "/"
        if path == "/host/session":
            self._session_body()
            return
        if path == "/host/login":
            self._login()
            return
        if path == "/host/logout":
            self._logout()
            return
        if path == "/host/password":
            self._password()
            return
        if not self._gate(path):
            return
        if path == "/host/network/ethernet":
            self._ethernet()
            return
        if path == "/host/network/wifi":
            self._wifi()
            return
        if path == "/control/engine/start":
            self._engine_action("start")
            return
        if path == "/control/engine/stop":
            self._engine_action("stop")
            return
        if path == "/control/engine/restart":
            self._engine_action("restart")
            return
        if path == "/control/probe":
            self._probe()
            return
        self._send(404, {"error": "not_found"})

    def do_PUT(self) -> None:  # noqa: N802
        path = urlparse(self.path).path.removesuffix("/") or "/"
        if not self._gate(path):
            return
        if path == "/host/hostname":
            self._hostname()
            return
        if path == "/control/toml/routes":
            self._put_toml("routes.toml", reject_secrets=True)
            return
        if path == "/control/toml/maskclaw":
            self._put_toml("maskclaw.toml", reject_secrets=False)
            return
        if path == "/control/secrets":
            self._put_secrets()
            return
        self._send(404, {"error": "not_found"})

    def _login(self) -> None:
        try:
            body = parse_json_object(self._read_body())
            password = body.get("password")
            if not isinstance(password, str):
                raise ValueError("password must be a string")
            token = login_password(password)
        except ValueError as exc:
            self._send(400, {"error": str(exc)})
            return
        except PermissionError as exc:
            self._send(401, {"error": str(exc)})
            return
        self._send(200, {"ok": True, "passwordSet": True, "loggedIn": True}, [("Set-Cookie", self._set_cookie(token))])

    def _logout(self) -> None:
        revoke_session(parse_session_cookie(self._cookie()))
        self._send(200, {"ok": True, "passwordSet": password_is_set(), "loggedIn": False}, [("Set-Cookie", self._set_cookie("", clear=True))])

    def _password(self) -> None:
        try:
            body = parse_json_object(self._read_body())
            password = body.get("password")
            current = body.get("current")
            setup_token = body.get("setupToken")
            if not isinstance(password, str):
                raise ValueError("password must be a string")
            if current is not None and not isinstance(current, str):
                raise ValueError("current must be a string")
            if setup_token is not None and not isinstance(setup_token, str):
                raise ValueError("setupToken must be a string")
            set_dashboard_password(
                password,
                current if isinstance(current, str) else None,
                setup_token if isinstance(setup_token, str) else None,
            )
        except ValueError as exc:
            self._send(400, {"error": str(exc)})
            return
        except PermissionError as exc:
            msg = str(exc)
            code = 403 if "setup token" in msg else 401
            self._send(code, {"error": msg})
            return
        token = create_session()
        self._send(
            200,
            {"ok": True, "passwordSet": True, "loggedIn": True},
            [("Set-Cookie", self._set_cookie(token))],
        )

    def _hostname(self) -> None:
        try:
            body = parse_json_object(self._read_body())
            name = body.get("hostname")
            if not isinstance(name, str):
                raise ValueError("hostname must be a string")
            host = set_hostname(name)
        except (ValueError, json.JSONDecodeError) as exc:
            self._send(400, {"error": str(exc)})
            return
        except Exception as exc:  # noqa: BLE001
            self._send(500, {"error": str(exc)})
            return
        info = network_info()
        info["hostname"] = host
        self._send(200, info)

    def _ethernet(self) -> None:
        try:
            connect_ethernet()
        except Exception as exc:  # noqa: BLE001
            self._send(400, {"error": str(exc)})
            return
        self._send(200, network_info())

    def _wifi(self) -> None:
        try:
            body = parse_json_object(self._read_body())
            ssid = body.get("ssid")
            password = body.get("password")
            if not isinstance(ssid, str):
                raise ValueError("ssid must be a string")
            if password is not None and not isinstance(password, str):
                raise ValueError("password must be a string")
            connect_wifi(ssid, password if isinstance(password, str) else None)
        except (ValueError, json.JSONDecodeError) as exc:
            self._send(400, {"error": str(exc)})
            return
        except Exception as exc:  # noqa: BLE001
            self._send(400, {"error": str(exc)})
            return
        self._send(200, network_info())

    def _engine_action(self, action: str) -> None:
        try:
            _systemctl(action)
        except Exception as exc:  # noqa: BLE001
            self._send(500, {"error": str(exc)})
            return
        if action != "stop" and not wait_for_engine():
            self._send(500, {"error": journal_tail()})
            return
        self._send(200, snapshot())

    def _put_toml(self, filename: str, *, reject_secrets: bool) -> None:
        try:
            toml = parse_toml_body(self._read_body())
        except (ValueError, json.JSONDecodeError) as exc:
            self._send(400, {"error": str(exc)})
            return
        if reject_secrets and toml_contains_literal_secret(toml):
            self._send(400, {"error": "Do not put secrets in routes.toml. Use api_key_env."})
            return
        _write_toml(filename, toml)
        dry_err = dry_run_config()
        if dry_err:
            try:
                _systemctl("stop")
            except Exception:
                pass
            self._send(400, {"error": dry_err})
            return
        try:
            _systemctl("restart")
        except Exception as exc:  # noqa: BLE001
            self._send(500, {"error": str(exc)})
            return
        if not wait_for_engine():
            self._send(500, {"error": journal_tail()})
            return
        self._send(200, snapshot())

    def _put_secrets(self) -> None:
        try:
            values = parse_secrets_body(self._read_body())
            write_secrets(values)
        except (ValueError, json.JSONDecodeError) as exc:
            self._send(400, {"error": str(exc)})
            return
        self._send(200, {"secrets": secret_status()})

    def _probe(self) -> None:
        raw = self._read_body()
        url = None
        if raw:
            try:
                parsed = json.loads(raw.decode("utf-8"))
                maybe = parsed.get("url")
                if isinstance(maybe, str) and maybe:
                    url = maybe
            except json.JSONDecodeError:
                self._send(400, {"error": "invalid json"})
                return
        if url:
            bearer = None
            model = None
            if isinstance(parsed.get("apiKey"), str) and parsed["apiKey"].strip():
                bearer = parsed["apiKey"].strip()
            if isinstance(parsed.get("model"), str) and parsed["model"].strip():
                model = parsed["model"].strip()
            result = probe_url(url, bearer=bearer, model=model)
            dump = json.dumps(result)
            if bearer and bearer in dump:
                self._send(500, {"error": "probe leaked credential"})
                return
            self._send(200, {"results": [result]})
            return
        results = [probe_url(item) for item in extract_base_urls(_read_toml("routes.toml"))]
        self._send(200, {"results": results})


def main() -> None:
    publish_caddy_root_ca()
    server = ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), HostHandler)
    server.serve_forever()


if __name__ == "__main__":
    main()

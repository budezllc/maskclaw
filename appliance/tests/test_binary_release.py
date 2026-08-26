"""Release contract: Pi media is binary-only; engine builds happen in Docker on the PC."""

from __future__ import annotations

import unittest
from pathlib import Path

ELF_MAGIC = b"\x7fELF"
EM_AARCH64 = 183

ROOT = Path(__file__).resolve().parents[1]


def _read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


class BinaryReleaseTests(unittest.TestCase):
    def test_dockerfile_does_not_copy_engine_source(self) -> None:
        text = _read("docker/engine-aarch64.Dockerfile")
        self.assertIn("FROM rust:", text)
        folded = text.upper().replace("COPYRIGHT", "")
        self.assertNotRegex(folded, r"\bCOPY\b")
        for needle in ("maskclaw/", "crates/", "C:\\Users\\"):
            self.assertNotIn(needle, text)

    def test_install_refuses_engine_source_and_never_runs_cargo(self) -> None:
        text = _read("deploy/install.sh")
        self.assertIn("switchyard-server", text)
        self.assertIn("refusing to install engine source", text)
        self.assertNotIn("cargo ", text)
        self.assertNotIn("rustc", text)
        self.assertNotIn("/opt/maskclaw/src", text)

    def test_install_disables_packaged_caddy_unit(self) -> None:
        text = _read("deploy/install.sh")
        self.assertIn("systemctl disable --now caddy.service", text)
        self.assertIn("systemctl mask caddy.service", text)
        self.assertIn("maskclaw_patch_caddy_tls_hosts", text)
        self.assertIn("NTPSynchronized", text)
        self.assertIn("apt retry", text)
        caddyfile = _read("deploy/caddy/Caddyfile")
        self.assertIn("admin off", caddyfile)
        self.assertIn("handle /host/ca.crt", caddyfile)
        self.assertIn("handle /v1/*", caddyfile)
        self.assertRegex(caddyfile, r"maskclaw\.local[\s\S]*handle /v1/\*")
        self.assertIn("protocols h1 h2", caddyfile)
        self.assertIn("auto_https disable_redirects", caddyfile)
        self.assertIn("systemctl restart maskclaw-caddy.service", text)
        self.assertIn("maskclaw.local", caddyfile)
        self.assertIn("127.0.0.1", caddyfile)
        self.assertNotIn(":443 {", caddyfile)
        self.assertIn("tls internal", caddyfile)
        self.assertIn("redir https://{host}{uri}", caddyfile)
        self.assertIn("handle /control/*", caddyfile)
        self.assertIn("forward_auth", caddyfile)
        self.assertIn("uri /host/session", caddyfile)
        self.assertIn("handle /host/login", caddyfile)
        self.assertIn("handle /v1/*", caddyfile)
        self.assertRegex(caddyfile, r":80[\s\S]*handle /v1/\*")
        self.assertRegex(caddyfile, r"maskclaw.local[\s\S]*handle /control/\*")
        text = _read("deploy/install.sh")
        self.assertIn("network-manager", text)
        self.assertIn(".hostname-user", text)
        unit = _read("deploy/systemd/maskclaw-caddy.service")
        self.assertIn("XDG_CONFIG_HOME=/var/lib/maskclaw", unit)
        self.assertIn("XDG_DATA_HOME=/var/lib/maskclaw/.local/share", unit)
        self.assertIn("Conflicts=caddy.service", unit)
        self.assertIn("StartLimitIntervalSec=0", unit)
        server_unit = _read("deploy/systemd/maskclaw-server.service")
        self.assertIn("EnvironmentFile=-/etc/maskclaw/engine.env", server_unit)
        self.assertIn("--routing-log-file /var/lib/maskclaw/routing.jsonl", server_unit)
        self.assertEqual(_read("hostd/hostd.py"), _read("deploy/hostd/hostd.py"))

    def test_on_pi_script_is_a_hard_failure(self) -> None:
        text = _read("scripts/build-engine-on-pi.sh")
        self.assertIn("exit 1", text)
        self.assertNotIn("cargo build", text)

    def test_docker_scripts_mount_source_read_only(self) -> None:
        ps1 = _read("scripts/build-engine-aarch64.ps1")
        sh = _read("scripts/build-engine-aarch64.sh")
        for text in (ps1, sh):
            self.assertIn("/src:ro", text)
            self.assertIn("CARGO_TARGET_DIR=/target", text)
            self.assertIn("/usr/local/cargo/bin", text)
            self.assertIn("--platform linux/arm64", text)
            self.assertTrue("deploy/bin" in text.replace("\\", "/"))
            self.assertIn("strip", text)
            self.assertNotIn("/opt/maskclaw/src", text)

    def test_deploy_tree_has_no_engine_source(self) -> None:
        deploy = ROOT / "deploy"
        forbidden = []
        for path in deploy.rglob("*"):
            if not path.is_file():
                continue
            if path.name in {"Cargo.toml", "Cargo.lock"} or path.suffix == ".rs":
                forbidden.append(str(path.relative_to(ROOT)))
        self.assertEqual(forbidden, [])

    def test_engine_pin_points_at_local_engine(self) -> None:
        text = _read("ENGINE_PIN")
        self.assertIn("ENGINE_PATH=", text)
        path_line = next(line for line in text.splitlines() if line.startswith("ENGINE_PATH="))
        raw = path_line.split("=", 1)[1].strip()
        self.assertFalse(raw.startswith("/") or (len(raw) > 1 and raw[1] == ":"), msg="ENGINE_PATH must be repo-relative")
        self.assertNotIn("Users", raw)
        engine = Path(raw)
        if not engine.is_absolute():
            engine = (ROOT / engine).resolve()
        self.assertTrue((engine / "Cargo.toml").is_file(), msg=f"missing {engine / 'Cargo.toml'}")
        self.assertTrue((engine / "crates" / "switchyard-server" / "Cargo.toml").is_file())

    def test_built_binary_is_linux_aarch64_elf_when_present(self) -> None:
        path = ROOT / "deploy" / "bin" / "switchyard-server"
        if not path.is_file() or path.stat().st_size < 1024:
            self.skipTest("deploy/bin/switchyard-server not built yet")
        data = path.read_bytes()[:64]
        self.assertTrue(data.startswith(ELF_MAGIC))
        self.assertEqual(data[4], 2)  # ELF64
        self.assertEqual(data[18] | (data[19] << 8), EM_AARCH64)

    def test_stage_bootfs_writes_cloud_init_and_deploy(self) -> None:
        text = _read("scripts/stage-bootfs.ps1")
        self.assertIn("maskclaw-deploy", text)
        self.assertIn("user-data", text)
        self.assertIn("network-config", text)
        self.assertIn("cmdline.txt", text)
        self.assertIn("ssh", text)

    def test_dashboard_build_script_uses_appliance_mode(self) -> None:
        text = _read("scripts/build-dashboard.ps1")
        self.assertIn("build:appliance", text)
        self.assertIn("deploy\\www", text)
        self.assertIn("dashboard", text)
        self.assertNotIn("Users\\", text)


if __name__ == "__main__":
    unittest.main()

import json
import os
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import hostd
from hostd import HostHandler, network_info, set_systemctl


class HostdTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        os.environ["MASKCLAW_CONFIG_DIR"] = self.tmp.name
        os.environ["MASKCLAW_ENGINE_HEALTH"] = "http://127.0.0.1:1/health"
        os.environ["MASKCLAW_ROUTING_LOG"] = str(Path(self.tmp.name) / "routing.jsonl")
        os.environ["MASKCLAW_ETC_HOSTNAME"] = str(Path(self.tmp.name) / "hostname")
        os.environ["MASKCLAW_ETC_HOSTS"] = str(Path(self.tmp.name) / "hosts")
        Path(self.tmp.name, "hosts").write_text("127.0.0.1\tlocalhost\n", encoding="utf-8")
        self.actions: list[str] = []
        self.nmcli_calls: list[list[str]] = []
        self.hostnames: list[str] = []
        set_systemctl(lambda action: self.actions.append(action))
        hostd.set_hostnamectl(lambda name: self.hostnames.append(name))
        hostd.set_rfkill(lambda: None)
        hostd.set_nmcli(self._nmcli)
        self._orig_wait = hostd.wait_for_engine
        self._orig_dry = hostd.dry_run_config
        self._orig_journal = hostd.journal_tail
        self._orig_journal_lines = hostd.journal_lines
        hostd.wait_for_engine = lambda timeout_s=8.0: True
        hostd.dry_run_config = lambda: None
        hostd.journal_tail = lambda: "missing MINIMAX_API_KEY"
        hostd.journal_lines = lambda max_lines=40: []
        self._orig_up = hostd.engine_up
        hostd.engine_up = lambda: False
        Path(self.tmp.name, "routes.toml").write_text("schema_version = 1\n", encoding="utf-8")
        Path(self.tmp.name, "maskclaw.toml").write_text("enabled = true\n", encoding="utf-8")
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), HostHandler)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        hostd.write_setup_token("test-setup-token-for-hostd-tests")
        self.cookie = ""
        status, body, headers = self.request(
            "POST",
            "/host/password",
            {
                "password": "test-password-1",
                "setupToken": "test-setup-token-for-hostd-tests",
            },
            cookie="",
        )
        self.assertEqual(status, 200, body)
        raw = headers.get("Set-Cookie") or headers.get("set-cookie") or ""
        self.cookie = raw.split(";")[0]
        self.assertTrue(self.cookie.startswith("maskclaw_session="))

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        hostd.engine_up = self._orig_up
        hostd.wait_for_engine = self._orig_wait
        hostd.dry_run_config = self._orig_dry
        hostd.journal_tail = self._orig_journal
        hostd.journal_lines = self._orig_journal_lines
        set_systemctl(None)
        hostd.set_hostnamectl(None)
        hostd.set_rfkill(None)
        hostd.set_nmcli("reset")
        self.tmp.cleanup()

    def _nmcli(self, args: list[str]) -> str:
        self.nmcli_calls.append(args)
        joined = " ".join(args)
        if "device status" in joined or (args[:1] == ["-f"] and args[-2:] == ["device", "status"]):
            return "eth0:ethernet:connected:Wired connection 1\nwlan0:wifi:disconnected:\nlo:loopback:unmanaged:\n"
        if "radio" in args:
            return "enabled\n"
        if "wifi" in args and "list" in args:
            return "Office:80:WPA2\nCafe:40:WPA2\n"
        if "device" in args and "show" in args:
            return "IP4.ADDRESS[1]:192.168.1.20/24\n"
        if "connect" in args:
            return ""
        return ""

    def request(
        self,
        method: str,
        path: str,
        body: dict | None = None,
        cookie: str | None = None,
        extra_headers: dict[str, str] | None = None,
    ) -> tuple[int, dict, dict[str, str]]:
        data = None if body is None else json.dumps(body).encode("utf-8")
        headers = {"Content-Type": "application/json"} if data else {}
        use_cookie = self.cookie if cookie is None else cookie
        if use_cookie:
            headers["Cookie"] = use_cookie
        if extra_headers:
            headers.update(extra_headers)
        req = Request(
            f"http://127.0.0.1:{self.port}{path}",
            data=data,
            method=method,
            headers=headers,
        )
        try:
            with urlopen(req, timeout=2) as response:
                extra = {key: value for key, value in response.headers.items()}
                return response.status, json.loads(response.read().decode()), extra
        except HTTPError as error:
            extra = {key: value for key, value in error.headers.items()} if error.headers else {}
            return error.code, json.loads(error.read().decode()), extra

    def test_health(self) -> None:
        status, body, _ = self.request("GET", "/host/health")
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])

    def test_network_has_hostname(self) -> None:
        status, body, _ = self.request("GET", "/host/network")
        self.assertEqual(status, 200)
        self.assertTrue(body["hostname"])
        self.assertIn("addresses", body)

    def test_legacy_toml_path_stays_json(self) -> None:
        status, body, _ = self.request("GET", "/host/config/maskclaw")
        self.assertEqual(status, 501)
        self.assertIn("error", body)

    def test_network_info_does_not_read_sidecar_secrets(self) -> None:
        info = network_info()
        blob = json.dumps(info)
        self.assertNotIn("sk-", blob)
        self.assertNotIn("__MC_", blob)

    def test_snapshot_returns_toml_not_html(self) -> None:
        status, body, _ = self.request("GET", "/control/snapshot")
        self.assertEqual(status, 200)
        self.assertIn("schema_version", body["routesToml"])
        self.assertIsInstance(body["engineUp"], bool)
        self.assertEqual(body["lastError"], "Engine is not responding on 127.0.0.1:4000")
        self.assertEqual(body["logs"], [])

    def test_snapshot_includes_routing_and_console_lines(self) -> None:
        Path(self.tmp.name, "routing.jsonl").write_text(
            '{"model":"maskclaw"}\n{"model":"minimax-m3"}\n',
            encoding="utf-8",
        )
        hostd.journal_lines = lambda max_lines=40: ["switchyard-server listening"]
        status, body, _ = self.request("GET", "/control/snapshot")
        self.assertEqual(status, 200)
        self.assertEqual(
            body["logs"],
            ['{"model":"maskclaw"}', '{"model":"minimax-m3"}', "switchyard-server listening"],
        )
        self.assertNotIn("sk-", json.dumps(body["logs"]))

    def test_put_routes_writes_toml_and_restarts(self) -> None:
        toml = 'schema_version = 1\n[llm_clients.local]\nbase_url = "http://127.0.0.1:8888/v1"\n'
        status, body, _ = self.request("PUT", "/control/toml/routes", {"toml": toml})
        self.assertEqual(status, 200)
        self.assertEqual(body["routesToml"], toml)
        self.assertEqual(self.actions, ["restart"])
        self.assertEqual(Path(self.tmp.name, "routes.toml").read_text(encoding="utf-8"), toml)

    def test_put_routes_rejects_literal_secrets(self) -> None:
        status, body, _ = self.request("PUT", "/control/toml/routes", {"toml": 'api_key = "sk-live"\n'})
        self.assertEqual(status, 400)
        self.assertIn("api_key_env", body["error"])
        self.assertEqual(self.actions, [])

    def test_put_routes_rejects_non_json_body_with_json_error(self) -> None:
        req = Request(
            f"http://127.0.0.1:{self.port}/control/toml/routes",
            data=b"schema_version = 1\n",
            method="PUT",
            headers={"Content-Type": "text/plain", "Cookie": self.cookie},
        )
        with self.assertRaises(HTTPError) as caught:
            urlopen(req, timeout=2)
        self.assertEqual(caught.exception.code, 400)
        body = json.loads(caught.exception.read().decode())
        self.assertIn("error", body)

    def test_put_unimplemented_is_json_not_html(self) -> None:
        status, body, _ = self.request("PUT", "/control/nope", {"toml": "x"})
        self.assertEqual(status, 404)
        self.assertEqual(body["error"], "not_found")

    def test_start_fails_when_engine_never_listens(self) -> None:
        hostd.wait_for_engine = lambda timeout_s=8.0: False
        status, body, _ = self.request("POST", "/control/engine/start")
        self.assertEqual(status, 500)
        self.assertIn("MINIMAX_API_KEY", body["error"])
        self.assertEqual(self.actions, ["start"])

    def test_put_routes_dry_run_failure_stops_crash_loop(self) -> None:
        hostd.dry_run_config = lambda: "llm client minimax could not read api_key_env MINIMAX_API_KEY"
        status, body, _ = self.request("PUT", "/control/toml/routes", {"toml": "schema_version = 1\n"})
        self.assertEqual(status, 400)
        self.assertIn("MINIMAX_API_KEY", body["error"])
        self.assertEqual(self.actions, ["stop"])

    def test_secrets_get_lists_names_without_values(self) -> None:
        Path(self.tmp.name, "routes.toml").write_text(
            'api_key_env = "MINIMAX_API_KEY"\napi_key_env = "UNSLOTH_API_KEY"\n',
            encoding="utf-8",
        )
        Path(self.tmp.name, "engine.env").write_text("MINIMAX_API_KEY=sk-live-should-not-leak\n", encoding="utf-8")
        status, body, _ = self.request("GET", "/control/secrets")
        self.assertEqual(status, 200)
        self.assertEqual(
            body["secrets"],
            [
                {"name": "MINIMAX_API_KEY", "set": True},
                {"name": "UNSLOTH_API_KEY", "set": False},
            ],
        )
        blob = json.dumps(body)
        self.assertNotIn("sk-", blob)
        self.assertNotIn("should-not-leak", blob)

    def test_put_secrets_writes_env_and_restarts(self) -> None:
        Path(self.tmp.name, "routes.toml").write_text('api_key_env = "MINIMAX_API_KEY"\n', encoding="utf-8")
        status, body, _ = self.request(
            "PUT",
            "/control/secrets",
            {"values": {"MINIMAX_API_KEY": "test-key-value"}},
        )
        self.assertEqual(status, 200)
        self.assertEqual(body["secrets"], [{"name": "MINIMAX_API_KEY", "set": True}])
        self.assertNotIn("test-key-value", json.dumps(body))
        env_text = Path(self.tmp.name, "engine.env").read_text(encoding="utf-8")
        self.assertIn("MINIMAX_API_KEY=test-key-value", env_text)
        self.assertEqual(self.actions, [])

    def test_put_secrets_rejects_empty_values(self) -> None:
        status, body, _ = self.request("PUT", "/control/secrets", {"values": {"MINIMAX_API_KEY": "  "}})
        self.assertEqual(status, 400)
        self.assertIn("at least one", body["error"])
        self.assertEqual(self.actions, [])

    def test_extract_model_ids_from_openai_payload(self) -> None:
        self.assertEqual(
            hostd.extract_model_ids('{"data":[{"id":"gemma3"}]}'),
            ["gemma3"],
        )
        self.assertEqual(hostd.models_probe_url("http://127.0.0.1:8888/v1"), "http://127.0.0.1:8888/v1/models")

    def test_probe_sends_api_key_and_does_not_treat_401_as_down(self) -> None:
        toml = (
            "[llm_clients.minimax]\n"
            'base_url = "http://127.0.0.1:PORT/v1"\n'
            'api_key_env = "MINIMAX_API_KEY"\n'
        )
        seen: list[str | None] = []

        class AuthHandler(BaseHTTPRequestHandler):
            def log_message(self, format: str, *args: object) -> None:  # noqa: A003
                return

            def do_GET(self) -> None:
                seen.append(self.headers.get("Authorization"))
                if self.headers.get("Authorization") == "Bearer test-minimax-key":
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(b'{"data":[{"id":"MiniMax-M3"}]}')
                    return
                self.send_response(401)
                self.end_headers()

        server = ThreadingHTTPServer(("127.0.0.1", 0), AuthHandler)
        port = int(server.server_address[1])
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            base = f"http://127.0.0.1:{port}/v1"
            routes = toml.replace("PORT", str(port))
            unauth = hostd.probe_url(base, toml=routes, env={})
            self.assertEqual(unauth["label"], "Needs API key")
            self.assertFalse(unauth["ok"])
            auth = hostd.probe_url(base, toml=routes, env={"MINIMAX_API_KEY": "test-minimax-key"})
            self.assertEqual(auth["label"], "Found")
            self.assertTrue(auth["ok"])
            self.assertEqual(auth["models"], ["MiniMax-M3"])
            self.assertIn("Bearer test-minimax-key", seen)
            self.assertNotIn("test-minimax-key", json.dumps(auth))
        finally:
            server.shutdown()
            server.server_close()

    def test_probe_uses_pasted_key_and_can_test_a_model_id(self) -> None:
        seen: list[tuple[str, str | None, bytes]] = []

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, format: str, *args: object) -> None:  # noqa: A003
                return

            def do_GET(self) -> None:
                seen.append(("GET", self.headers.get("Authorization"), b""))
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"data":[{"id":"MiniMax-M3"},{"id":"MiniMax-M2.5"}]}')

            def do_POST(self) -> None:
                length = int(self.headers.get("Content-Length") or "0")
                body = self.rfile.read(length)
                seen.append(("POST", self.headers.get("Authorization"), body))
                model = json.loads(body.decode()).get("model")
                if model == "MiniMax-M3":
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(b'{"choices":[{"message":{"content":"ok"}}]}')
                    return
                self.send_response(400)
                self.end_headers()

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        port = int(server.server_address[1])
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            base = f"http://127.0.0.1:{port}/v1"
            listed = hostd.probe_url(base, toml="", env={}, bearer="pasted-cloud-key")
            self.assertTrue(listed["ok"])
            self.assertEqual(listed["models"], ["MiniMax-M3", "MiniMax-M2.5"])
            good = hostd.probe_url(base, bearer="pasted-cloud-key", model="MiniMax-M3")
            self.assertTrue(good["ok"])
            self.assertEqual(good["label"], "Model works")
            bad = hostd.probe_url(base, bearer="pasted-cloud-key", model="nope-model")
            self.assertFalse(bad["ok"])
            self.assertEqual(bad["label"], "Unknown model")
            self.assertIn("Bearer pasted-cloud-key", [row[1] for row in seen])
            self.assertNotIn("pasted-cloud-key", json.dumps(listed) + json.dumps(good) + json.dumps(bad))
        finally:
            server.shutdown()
            server.server_close()

    def test_session_unauthorized_before_password_set(self) -> None:
        auth = hostd.auth_path()
        if auth.is_file():
            auth.unlink()
        hostd.clear_sessions()
        status, body, _ = self.request("GET", "/host/session", cookie="")
        self.assertEqual(status, 401)
        self.assertFalse(body["passwordSet"])
        self.assertFalse(body["ok"])
        status, body, _ = self.request("GET", "/control/snapshot", cookie="")
        self.assertEqual(status, 401)

    def test_set_password_login_and_gate(self) -> None:
        # Start from no password so bootstrap is covered.
        auth = hostd.auth_path()
        if auth.is_file():
            auth.unlink()
        hostd.clear_sessions()
        hostd.write_setup_token("bootstrap-token-for-login-test")

        status, body, headers = self.request(
            "POST",
            "/host/password",
            {"password": "correcthorse", "setupToken": "wrong-token"},
            cookie="",
        )
        self.assertEqual(status, 403)

        status, body, headers = self.request(
            "POST",
            "/host/password",
            {"password": "correcthorse", "setupToken": "bootstrap-token-for-login-test"},
            cookie="",
        )
        self.assertEqual(status, 200)
        self.assertTrue(body["passwordSet"])
        cookie = headers.get("Set-Cookie") or headers.get("set-cookie")
        self.assertIn("maskclaw_session=", cookie)
        self.assertNotIn("Secure", cookie)

        status, body, headers = self.request(
            "POST",
            "/host/login",
            {"password": "correcthorse"},
            cookie="",
            extra_headers={"X-Forwarded-Proto": "https"},
        )
        self.assertEqual(status, 200)
        secure_cookie = headers.get("Set-Cookie") or headers.get("set-cookie")
        self.assertIn("Secure", secure_cookie)

        status, body, _ = self.request("GET", "/host/session", cookie="")
        self.assertEqual(status, 401)
        self.assertTrue(body["passwordSet"])

        status, body, _ = self.request("GET", "/control/snapshot", cookie="")
        self.assertEqual(status, 401)

        status, body, headers = self.request("POST", "/host/login", {"password": "wrong-password"}, cookie="")
        self.assertEqual(status, 401)

        status, body, headers = self.request("POST", "/host/login", {"password": "correcthorse"}, cookie="")
        self.assertEqual(status, 200)
        cookie = headers.get("Set-Cookie") or headers.get("set-cookie")
        token = cookie.split(";")[0]
        status, body, _ = self.request("GET", "/host/session", cookie=token)
        self.assertEqual(status, 200)
        self.assertTrue(body["loggedIn"])

        status, body, _ = self.request("POST", "/host/session", cookie=token)
        self.assertEqual(status, 200)

        status, body, _ = self.request(
            "POST",
            "/host/password",
            {"password": "newhorse1", "current": "nope"},
            cookie=token,
        )
        self.assertEqual(status, 401)

        status, body, headers = self.request(
            "POST",
            "/host/password",
            {"password": "newhorse1", "current": "correcthorse"},
            cookie=token,
        )
        self.assertEqual(status, 200)
        new_cookie = (headers.get("Set-Cookie") or headers.get("set-cookie")).split(";")[0]
        status, body, _ = self.request("GET", "/host/session", cookie=token)
        self.assertEqual(status, 401)
        status, body, _ = self.request("GET", "/control/snapshot", cookie=new_cookie)
        self.assertEqual(status, 200)
        self.cookie = new_cookie

    def test_ca_cert_download(self) -> None:
        from urllib.request import Request, urlopen

        ca = Path(self.tmp.name) / "root.crt"
        pem = (
            "-----BEGIN CERTIFICATE-----\n"
            "MIIBtestplaceholder\n"
            "-----END CERTIFICATE-----\n"
        )
        ca.write_text(pem, encoding="utf-8", newline="\n")
        os.environ["MASKCLAW_CADDY_ROOT_CA"] = str(ca)

        req = Request(f"http://127.0.0.1:{self.port}/host/ca.crt", method="GET")
        with urlopen(req, timeout=2) as response:
            raw = response.read().decode("utf-8").replace("\r\n", "\n")
            self.assertEqual(response.status, 200)
            self.assertIn("application/x-x509-ca-cert", response.headers.get("Content-Type", ""))
            self.assertIn("maskclaw-caddy-root.crt", response.headers.get("Content-Disposition", ""))
            self.assertEqual(raw, pem)

        os.environ["MASKCLAW_CADDY_ROOT_CA"] = str(Path(self.tmp.name) / "missing.crt")
        status, body, _ = self.request("GET", "/host/ca.crt", cookie="")
        self.assertEqual(status, 404)
        self.assertEqual(body["error"], "ca_not_ready")
        del os.environ["MASKCLAW_CADDY_ROOT_CA"]

    def test_caddy_root_ca_skips_unreadable(self) -> None:
        blocked = Path(self.tmp.name) / "blocked-root.crt"
        blocked.write_text("-----BEGIN CERTIFICATE-----\nX\n-----END CERTIFICATE-----\n", encoding="utf-8")
        os.environ["MASKCLAW_CADDY_ROOT_CA"] = str(blocked)

        real_is_file = Path.is_file

        def is_file_deny_blocked(self: Path) -> bool:
            if self == blocked:
                raise PermissionError("denied")
            return real_is_file(self)

        with patch.object(Path, "is_file", is_file_deny_blocked):
            self.assertIsNone(hostd.caddy_root_ca_path())
        del os.environ["MASKCLAW_CADDY_ROOT_CA"]

    def test_login_rejected_before_password_set(self) -> None:
        auth = hostd.auth_path()
        if auth.is_file():
            auth.unlink()
        hostd.clear_sessions()
        hostd.write_setup_token("unused-token-for-login-reject")
        status, body, _ = self.request("POST", "/host/login", {"password": "anything1"}, cookie="")
        self.assertEqual(status, 400)

    def test_bootstrap_requires_setup_token(self) -> None:
        auth = hostd.auth_path()
        if auth.is_file():
            auth.unlink()
        hostd.clear_sessions()
        hostd.write_setup_token("required-bootstrap-token")

        status, body, _ = self.request("POST", "/host/password", {"password": "correcthorse"}, cookie="")
        self.assertEqual(status, 403)
        self.assertIn("setup token", body["error"])

        status, body, headers = self.request(
            "POST",
            "/host/password",
            {"password": "correcthorse", "setupToken": "required-bootstrap-token"},
            cookie="",
        )
        self.assertEqual(status, 200)
        self.assertFalse(hostd.setup_token_path().is_file())

    def test_hostname_validation_and_write(self) -> None:
        status, body, _ = self.request("PUT", "/host/hostname", {"hostname": "Bad Host"})
        self.assertEqual(status, 400)
        status, body, _ = self.request("PUT", "/host/hostname", {"hostname": "office-pi"})
        self.assertEqual(status, 200)
        self.assertEqual(self.hostnames, ["office-pi"])
        self.assertEqual(Path(self.tmp.name, "hostname").read_text(encoding="utf-8").strip(), "office-pi")
        self.assertIn("office-pi", Path(self.tmp.name, "hosts").read_text(encoding="utf-8"))
        self.assertTrue(Path(self.tmp.name, ".hostname-user").is_file())

    def test_network_lists_ethernet_and_wifi(self) -> None:
        status, body, _ = self.request("GET", "/host/network")
        self.assertEqual(status, 200)
        self.assertTrue(body["wifiAvailable"])
        types = {item["type"] for item in body["interfaces"]}
        self.assertEqual(types, {"ethernet", "wifi"})
        self.assertEqual(body["wifi"]["networks"][0]["ssid"], "Office")

    def test_connect_wifi_and_ethernet(self) -> None:
        status, body, _ = self.request("POST", "/host/network/wifi", {"ssid": "Office", "password": "secret"})
        self.assertEqual(status, 200)
        self.assertTrue(any("wifi" in call and "connect" in call for call in self.nmcli_calls))
        status, body, _ = self.request("POST", "/host/network/ethernet")
        self.assertEqual(status, 200)
        self.assertTrue(any("device" in call and "connect" in call and "eth0" in call for call in self.nmcli_calls))

    def test_nmcli_missing_reports_unavailable(self) -> None:
        hostd.set_nmcli(None)
        status, body, _ = self.request("GET", "/host/network")
        self.assertEqual(status, 200)
        self.assertFalse(body["wifiAvailable"])
        status, body, _ = self.request("POST", "/host/network/wifi", {"ssid": "Office"})
        self.assertEqual(status, 400)


if __name__ == "__main__":
    os.chdir(Path(__file__).resolve().parent)
    unittest.main()

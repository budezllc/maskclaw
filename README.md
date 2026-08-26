# MASKCLAW

On-prem privacy proxy for OpenAI-compatible LLM clients. Prompts hit MaskClaw first. Secrets and PII become stable placeholders, the redacted request is routed (local or cloud), then originals are restored on the way back.

Two products, one repo:

- **MASKCLAW DESKTOP** — Windows 10/11 app
- **MASKCLAW appliance** — Raspberry Pi 5 box on the LAN

The engine under `engine/` is a Switchyard fork with the MaskClaw privacy layer. Desktop and the Pi both run that engine.

```text
MASKCLAW/
  engine/      switchyard-server + MaskClaw masking
  desktop/     Windows app (Tauri)
  appliance/   Pi 5 deploy (binaries, Caddy, hostd, systemd)
  dashboard/   browser UI the Pi serves (also used in tests)
```

Clone **one** repo. Build desktop, the appliance, or both.

Point Cursor, Continue, Open WebUI, or any OpenAI-compatible SDK at the proxy. Use model id `maskclaw` for smart routing. Other route ids pin a backend.

## Privacy layer

Built-in detectors are on by default (SETTINGS toggles write `maskclaw.toml` and restart the engine):

| Kind | What it matches |
| --- | --- |
| email | `user@domain.tld` |
| phone | North American numbers with separators |
| ssn | `###-##-####` |
| credit_card | 13–19 digit PAN, Luhn-checked |
| jwt | Compact JWTs (`eyJ….….…`) |
| aws_key | IAM access key ids `AKIA…` |
| api_key | `sk-…`, `ghp_…`, `glpat-…`, Slack `xox[baprs]-…` |

Hits become session-stable placeholders `__MC_<kind>_<12 hex>__`. Maps live in RAM only. Sidecar `maskclaw.toml` also supports dictionaries, custom regex, an allowlist, and `force_local` (`never` / `on_unmaskable` / `always`). Stats: `GET /v1/maskclaw/stats`. Missing sidecar, or `enabled = false`, leaves masking off.

## Desktop (Windows)

Produces the **MASKCLAW DESKTOP** installer. It bundles `switchyard-server` built from `engine/`. UI: **HOME**, **MASKED**, **MODELS**, **SETTINGS**. BOX (password, hostname, Ethernet / Wi-Fi) is appliance-only — use the Pi in a browser for that.

| Tool | Notes |
| --- | --- |
| Windows 10/11 x64 | GUI target |
| Node.js 22+ and npm | `desktop/` |
| Rust + Cargo | Tauri app and in-tree engine sidecar |
| Visual Studio Build Tools | MSVC C++ workload and Windows SDK |

```powershell
cd desktop
npm install
npm run tauri:build
```

Dev:

```powershell
cd desktop
npm install
npm run tauri:dev
```

The engine listens at `http://127.0.0.1:4000` (`/v1` for clients). WebView2 is required (Windows 11 usually has it). API keys stay in Windows Credential Manager; `routes.toml` and `maskclaw.toml` live under `%APPDATA%\com.switchyard.app\`.

If desktop is running, you do not need a separate browser UI on that PC.

## Appliance (Raspberry Pi 5)

Builds a Linux aarch64 engine in Docker on the PC, stages Raspberry Pi OS bootfs, and copies the browser UI the Pi serves on **HTTPS 443** (Caddy `tls internal`). Engine **source never goes on the Pi**. LLM `/v1` stays HTTP on **80**.

On the Pi you open the UI in a browser (`https://<pi-ip>/` or `https://maskclaw.local/`). That is the appliance control surface (including BOX), not a third product.

```powershell
cd appliance
pwsh scripts/build-engine-aarch64.ps1
pwsh scripts/build-dashboard.ps1
pwsh scripts/stage-bootfs.ps1 -BootDrive G
```

Bring-up notes: [appliance/DESK-PI.md](appliance/DESK-PI.md). Full appliance docs: [appliance/README.md](appliance/README.md).

To unit-test or visually check the Pi UI on the PC without flashing a card, see [dashboard/README.md](dashboard/README.md). That path is for checks, not day-to-day use on Windows.

## Tests

```powershell
npm test
npm run test:desktop
npm run test:desktop:rust
cd dashboard; pnpm test
cd ..
npm run test:appliance
```

Do not run live Exa/LLM calls in these suites; desktop and dashboard tests are mocked/unit.

## License

The routing engine under `engine/` is [Apache 2.0](engine/LICENSE), Copyright NVIDIA Corporation, plus MaskClaw privacy-layer changes.

Desktop and appliance are MaskClaw product sources in this repository. `dashboard/` is the appliance’s browser UI.

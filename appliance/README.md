# MaskClaw Appliance

MaskClaw is an on-prem **privacy proxy** for OpenAI-compatible LLM clients. Prompts, tool calls, and related text hit a Raspberry Pi 5 on your LAN. MaskClaw **scrubs secrets and PII into stable placeholders**, routes the redacted request to a local or cloud model, then **restores the original values** in the response before they return to the client.

The **`appliance/`** tree is the **Pi 5 appliance**: Linux aarch64 `switchyard-server` binary, Caddy, hostd, systemd, Avahi, and the dashboard static site. Engine Rust source stays in `engine/` on the build PC. The device gets binaries, config, and dashboard assets only.

It is a **technical control** (detect → mask → route → restore). It is not a certification, legal opinion, or a substitute for your own DPA / HIPAA / SOC 2 program.

---



## What it is for

Teams that must send language-model traffic through a box they control:

- Keep emails, SSNs, card numbers, and API keys **off the wire to a cloud provider** (they leave as `__MC_…` tokens).
- Prefer a **local** model when something cannot be safely masked (`force_local`).
- Point Cursor, Continue, Open WebUI, or any OpenAI-compatible SDK at **one base URL** on the LAN.
- Inspect masking counts and routing on a dashboard without dumping secrets into stats.

---



## How a request is handled

```text
Client  --OpenAI /v1-->  Caddy :80  -->  switchyard-server :4000
Browser --HTTPS-------->  Caddy :443 -->  dashboard + hostd :8787
                                           │
                                           ├─ MaskClaw scrub (request IR)
                                           ├─ optional force_local route override
                                           ├─ Switchyard route (maskclaw / pins)
                                           ├─ upstream LLM (local or cloud)
                                           └─ MaskClaw restore (response / stream)
```

1. The client calls an OpenAI-compatible API (`/v1/chat/completions`, `/v1/models`, …). Send `maskclaw` as `model` for smart routing (the dashboard lists it as track 01). Other route ids **pin** a backend.
2. Caddy on port **80** proxies `/v1/`* and `/health` to `switchyard-server` on **4000**. Dashboard, `/host`, and `/control` are on port **443** (Caddy `tls internal`).
3. MaskClaw walks the provider-neutral request IR (messages, tool definitions, tool call arguments, JSON blobs, image/file URLs and names) and runs every enabled detector.
4. Each hit is replaced with a session-stable placeholder `__MC_<kind>_<12 hex>__`. The real string is stored **only in RAM** for that session.
5. Switchyard routes the redacted request. Cloud backends never see the original secret unless you turned masking off.
6. On the way back, MaskClaw substitutes placeholders for originals, including when a stream splits a placeholder across chunks.
7. `/v1/maskclaw/stats` reports counts and detector toggles. The dashboard **rejects** stats payloads that look like they contain secrets (`@`, `__MC_`, `sk-`, `AKIA`).

If `--maskclaw-config` is missing or `enabled = false`, MaskClaw is off and Switchyard routes unredacted.

---



## What it masks, and how

Built-in detectors are **on by default**. Toggle them on **SETTINGS** (writes `maskclaw.toml` and restarts the engine).


| Kind            | What it matches                                                                              | How                                                                         |
| --------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **email**       | Addresses like `user@domain.tld`                                                             | Case-insensitive regex                                                      |
| **phone**       | North American numbers with separators (`(415) 555-1212`, `+1-415-555-1212`)                 | Regex                                                                       |
| **ssn**         | `###-##-####`                                                                                | Regex                                                                       |
| **credit_card** | 13–19 digit PAN with spaces or dashes                                                        | Regex **plus Luhn check** (random digit runs that fail Luhn are left alone) |
| **jwt**         | Compact JWTs (`eyJ….….…`)                                                                    | Regex on three base64url segments                                           |
| **aws_key**     | IAM access key ids `AKIA` + 16 alphanumeric                                                  | Regex                                                                       |
| **api_key**     | Common prefixes: OpenAI-style `sk-…`, GitHub `ghp_…`, GitLab `glpat-…`, Slack `xox[baprs]-…` | Regex                                                                       |


Placeholders are HMAC-SHA256 of `(kind, value)` with a **per-session random 32-byte key**, truncated to 12 hex chars. The same secret in the same session always becomes the same token; a different session gets a different token.

### Dictionaries

`[[dictionary]]` entries use **Aho-Corasick** (literal, multi-pattern). Use them for names, project titles, customer ids, or other exact strings regex would miss.

```toml
[[dictionary]]
type = "project"       # becomes __MC_project_<hex>__
critical = true        # counts toward force_local = "on_unmaskable"
values = ["Project Apollo"]
```



### Custom regex

`[[regex]]` compiles a Rust `regex` crate pattern. Tag a type name and optionally `critical`.

```toml
[[regex]]
type = "employee_id"
pattern = "EMP-[0-9]{5}"
critical = true
```



### Allowlist

Exact strings in `allowlist` are **never** replaced (for example a public support address).

### Residual scan

After masking, MaskClaw counts leftover tokens that look like unmasked secrets: 40+ character `[A-Za-z0-9_-]` runs with both letters and digits that are **not** already placeholders. That **residual** count is a gauge on MASKED. With `force_local = "on_unmaskable"`, residual or **critical** hits can send the request to a local route instead of the cloud.

### Sessions

Maps live **only in process memory** (never written under `/etc` or `/var` as secrets).

- Key: request `session_id`, else `correlation_id`, else a per-process anonymous id.
- TTL: `session_ttl_secs` (factory example **900**). Idle maps expire.
- Restore miss: the model echoed a placeholder this box no longer has (expired session or different process). Counted on MASKED; the client may see the token instead of the original.

---



## Force-local policy

`force_local` in `maskclaw.toml`:


| Value           | Behavior                                                                                                        |
| --------------- | --------------------------------------------------------------------------------------------------------------- |
| `never`         | Keep the client’s / Switchyard route (default example)                                                          |
| `on_unmaskable` | If a **critical** dictionary/regex hit or **residual** high-entropy tokens remain, override to `local_route_id` |
| `always`        | Always override to `local_route_id` when that id is set                                                         |


Factory example sets `local_route_id = "maskclaw"`. Point that route at a LAN model if you want unmaskable traffic to stay on-box.

---



## Routing (Switchyard)

`routes.toml` defines LLM clients, targets, and routes. Typical tracks:

- `maskclaw` — smart / classifier route (dashboard always lists this as **01**).
- Pins such as `lmstudio-local`, `minimax-m3` — send that id as `model` to skip auto-route.

Clients:

1. Set OpenAI-compatible **base URL** to `http://<pi-ip>/v1` (or the URL shown on HOME).
2. Set **model** to `maskclaw` (copied when you pick it on HOME).

Engine listen: `127.0.0.1:4000` behind Caddy. Use port **80** for `/v1` (HTTP, no client cert). Use port **443** for the dashboard.

---



## Appliance stack (technologies)


| Layer            | Technology                                            | Role                                                        |
| ---------------- | ----------------------------------------------------- | ----------------------------------------------------------- |
| Hardware         | Raspberry Pi 5, 64-bit                                | Appliance                                                   |
| OS               | Raspberry Pi OS Lite **64-bit** (Debian)              | Host                                                        |
| Privacy + router | `switchyard-server` (Rust)                            | OpenAI-compatible proxy, MaskClaw crate, Switchyard routes  |
| Masking          | Regex, Luhn, Aho-Corasick, HMAC-SHA256                | Detect, mint placeholders, restore                          |
| Reverse proxy    | **Caddy** (`admin off`)                               | :80 `/v1`+`/health`; :443 TLS dashboard, `/host`, `/control` |
| Box API          | **hostd** (Python 3 stdlib HTTP server)               | Password, sessions, network, hostname, engine control, TOML |
| Dashboard        | React, Vite, Tailwind, Base UI / shadcn               | HOME, MASKED, MODELS, SETTINGS, BOX                         |
| Discovery        | Avahi                                                 | `maskclaw.local` (Windows often needs the DHCP IP instead)  |
| Network          | NetworkManager, `nmcli`, `rfkill`                     | Ethernet + Wi-Fi from BOX                                   |
| Auth (dashboard) | PBKDF2-HMAC-SHA256, HttpOnly `SameSite=Strict` cookie | Required; LAN `/control` gated until set + login            |
| Init             | cloud-init `user-data` / `network-config`             | First boot, factory user                                    |
| Build            | Docker `linux/arm64`, Rust 1.96, `strip`              | Engine binary on the PC, never `cargo` on the Pi            |
| UI build         | pnpm, `build:appliance`                               | `deploy/www`                                                |


Debian’s `caddy.service` is **masked** so it cannot take port 2019 from MaskClaw Caddy.

---



## Dashboard surfaces


| Page         | Purpose                                                                                         |
| ------------ | ----------------------------------------------------------------------------------------------- |
| **HOME**     | Engine start/stop, OpenAI base URLs, model picker (auto-copies id), tracks, stats, activity log |
| **MASKED**   | Match counts, sessions in RAM, residual, critical, restore misses, counts by kind               |
| **MODELS**   | Cloud + local backends, probes, writes `routes.toml`                                            |
| **SETTINGS** | Detector switches, raw `routes.toml` / `maskclaw.toml`                                          |
| **BOX**      | Dashboard password, hostname, Ethernet / Wi-Fi (appliance only)                                 |


`/v1/*` and `/health` on **:80** stay **ungated** so LLM clients do not need a browser cookie or TLS. Dashboard, `/host/*`, and `/control/*` are on **:443** with Caddy `forward_auth`; a dashboard password is required before those routes work.

---



## On-device layout


| Path                                  | Role                                                               |
| ------------------------------------- | ------------------------------------------------------------------ |
| `/opt/maskclaw/bin/switchyard-server` | Engine binary                                                      |
| `/opt/maskclaw/www`                   | Dashboard                                                          |
| `/opt/maskclaw/hostd/hostd.py`        | Box API                                                            |
| `/etc/maskclaw/routes.toml`           | Clients and routes (preserved across restage when already present) |
| `/etc/maskclaw/maskclaw.toml`         | Masking sidecar                                                    |
| `/etc/maskclaw/engine.env`            | Optional env (API keys as `api_key_env`, not in TOML)              |
| `/etc/maskclaw/Caddyfile`             | Site config                                                        |
| `/etc/maskclaw/dashboard.auth`        | Password hash when set                                             |
| `/var/lib/maskclaw/routing.jsonl`     | Routing log (not a secret store)                                   |
| `systemd`                             | `maskclaw-server`, `maskclaw-hostd`, `maskclaw-caddy`              |


This tree (`appliance/`):


| Path                                                                 | Role                                               |
| -------------------------------------------------------------------- | -------------------------------------------------- |
| [hostd/](hostd/)                                                     | Box API source                                     |
| [deploy/](deploy/)                                                   | What first-boot copies onto the Pi                 |
| [ENGINE_PIN](ENGINE_PIN)                                             | Where this PC builds the engine (never copied to the Pi) |
| [scripts/build-engine-aarch64.ps1](scripts/build-engine-aarch64.ps1) | Docker aarch64 engine build                        |
| [scripts/build-dashboard.ps1](scripts/build-dashboard.ps1)           | Build the dashboard into `deploy/www`                  |
| [DESK-PI.md](DESK-PI.md)                                             | Flash and Ethernet bring-up                        |
| [pi-gen/](pi-gen/)                                                   | Later sellable image overlay                       |


---



## Security model (binaries only)

Factory SSH: `admin` **/** `maskclaw`. First SSH login **forces** a password change (`chage`). Sudo requires that password (no NOPASSWD). Dashboard password is separate (BOX) and required before LAN `/control`.

---



## Bring-up (desk Pi)

Full steps: [DESK-PI.md](DESK-PI.md). Short version:

Pi 5 USB-C is **power**, not a gadget port. Flash Raspberry Pi OS Lite 64-bit, then on this PC:

```powershell
pwsh scripts/build-engine-aarch64.ps1
pwsh scripts/build-dashboard.ps1
pwsh scripts/stage-bootfs.ps1 -BootDrive G
```

First boot waits for NTP (or HTTP Date) before apt, retries apt, installs Avahi / Caddy / NetworkManager, and enables the MaskClaw units.

From the PC (Windows often does not resolve `maskclaw.local`):

```text
https://<pi-ip>/
http://<pi-ip>/health
http://<pi-ip>/v1/...
ssh admin@<pi-ip>
```

Open the dashboard over HTTPS (browser will warn on the Caddy internal cert once). Set a dashboard password on first visit before `/control` works.

---



## Example `maskclaw.toml`

```toml
enabled = true
session_ttl_secs = 900
force_local = "never"          # never | on_unmaskable | always
local_route_id = "maskclaw"

allowlist = ["noreply@example.com"]

[detectors]
email = true
phone = true
ssn = true
credit_card = true
jwt = true
aws_key = true
api_key = true

[[dictionary]]
type = "project"
critical = true
values = ["Project Apollo"]

[[regex]]
type = "employee_id"
pattern = "EMP-[0-9]{5}"
```

Shipped factory file: [deploy/config/maskclaw.toml.example](deploy/config/maskclaw.toml.example).


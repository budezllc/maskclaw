# MaskClaw dashboard

Web UI for the sidecar on this machine and the Pi appliance. Lives in `dashboard/` of the MASKCLAW repo.

On the appliance, open **https://<pi-ip>/** (Caddy `tls internal`; browsers warn once). Dev on this PC stays HTTP:

```text
pnpm install
pnpm test
pnpm dev                 # dashboard + /control API, proxies engine to 127.0.0.1:4000
pnpm run dev:appliance   # appliance surface (Box stub + /host proxy)
pnpm run build:appliance # dist/ for the Pi image
```

Open **http://maskclaw.local:5173** or **http://127.0.0.1:5173** (not `localhost`). Hosts entry:

```text
127.0.0.1 maskclaw.local
```

The engine binary defaults to `%LOCALAPPDATA%\MASKCLAW DESKTOP\switchyard-server.exe`. Config lives in `%APPDATA%\com.switchyard.app\` (`routes.toml`, `maskclaw.toml`). Start/stop/restart, probe, and TOML save are on `/control`.


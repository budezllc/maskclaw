# Appliance browser UI (`dashboard/`)

This folder is the browser UI the **Raspberry Pi 5 appliance** serves. It is not a third MaskClaw product. On Windows, use **MASKCLAW DESKTOP**. On the Pi, open **https://\<pi-ip\>/** (Caddy `tls internal`; browsers warn once).

Commands below are for **unit tests** and a **local visual check** of that Pi UI, not day-to-day use.

```text
pnpm install
pnpm test
pnpm dev                 # HTTP check on this PC; proxies engine to 127.0.0.1:4000
pnpm run dev:appliance   # same UI with BOX (Pi admin stub)
pnpm run build:appliance # dist/ copied onto the Pi image
```

If you run the local check, open **http://127.0.0.1:5173** (not `localhost` on this Windows setup). Optional hosts entry: `127.0.0.1 maskclaw.local`.

The engine binary defaults to `%LOCALAPPDATA%\MASKCLAW DESKTOP\switchyard-server.exe`. Config lives in `%APPDATA%\com.switchyard.app\` (`routes.toml`, `maskclaw.toml`). Start/stop/restart, probe, and TOML save are on `/control`.

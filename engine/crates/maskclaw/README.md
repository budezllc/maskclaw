# MaskClaw

Deterministic PII masking for Switchyard. MaskClaw walks the provider-neutral
request IR before routing, replaces secrets with stable placeholders, and
restores them on the way back to the client.

Switchyard's deployment TOML is unchanged. Point the server at a sidecar file:

```text
switchyard-server --config routes.toml --maskclaw-config maskclaw.toml
```

If `--maskclaw-config` is omitted, the server loads `maskclaw.toml` next to
`--config` when that file exists. Missing sidecar means MaskClaw is off.

## Sidecar example

```toml
enabled = true
session_ttl_secs = 900
force_local = "never"          # never | on_unmaskable | always
local_route_id = "local"

allowlist = ["noreply@example.com"]

[[dictionary]]
type = "project"
critical = true
values = ["Project Apollo"]

[[regex]]
type = "employee_id"
pattern = "EMP-[0-9]{5}"
```

Built-in detectors cover email, phone, SSN, credit cards, JWTs, AWS keys, and
common API-key prefixes. Placeholders look like `__MC_email_ab12cd34ef56__` and
are stable for the same secret inside one session.

# Desk Pi 5 bring-up

The Pi 5 USB-C port is **power**, not a flash drive. Use a USB reader on the PC, then Ethernet to the same router. Windows does not resolve `maskclaw.local`; use the Pi’s DHCP IP (router client list).

## 1. Flash Raspberry Pi OS

Raspberry Pi Imager → Raspberry Pi OS Lite **64-bit**. Write the card/stick.

## 2. Engine + dashboard + copy onto bootfs

From `appliance/` on this PC:

```powershell
cd appliance
pwsh scripts/build-engine-aarch64.ps1
pwsh scripts/build-dashboard.ps1
pwsh scripts/stage-bootfs.ps1 -BootDrive G
```

`stage-bootfs` copies `deploy/` as `maskclaw-deploy`, writes factory `user-data` (**admin** / **maskclaw**, password expired on first login), `network-config` (Ethernet required), and an `ssh` enable file. First-boot `install.sh` waits for NTP before apt, retries apt, and **masks** Debian’s `caddy.service` so it cannot steal port 2019 from MaskClaw Caddy.

Safely eject, then boot.

## 3. Boot

Official PSU, stick in a USB 3 port, Ethernet to the same router. First install can take several minutes.

## 4. Check from the PC

```text
https://<pi-ip>/
http://<pi-ip>/health
http://<pi-ip>/v1/...
ssh admin@<pi-ip>
```

Dashboard and BOX admin are **HTTPS** (Caddy `tls internal`; browsers warn once — continue). LLM clients keep using **HTTP** `http://<pi-ip>/v1`. On first open, set a dashboard password before `/control` works.

# Repeatable image (after the desk Pi works)

pi-gen must run on Linux or Docker, not Windows.

1. Confirm `deploy/install.sh` on a real Pi 5 (see [DESK-PI.md](../DESK-PI.md)).
2. Clone [pi-gen](https://github.com/RPi-Distro/pi-gen).
3. Copy [config](config) to the pi-gen tree as `config`.
4. Add a custom stage that copies `../deploy` (binaries + config + www only) into `/boot/firmware/maskclaw-deploy` and enables a oneshot for `firstrun.sh`. Never include engine source.
5. `./build.sh` (or `./build-docker.sh`) and flash the resulting `.img`.

This folder is the overlay contract, not a baked image.

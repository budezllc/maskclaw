#!/bin/sh
# Raspberry Pi OS first-boot: copy from the FAT boot partition and install.
set -eu
MARKER=/var/lib/maskclaw-firstboot-done
if [ -f "$MARKER" ]; then
  exit 0
fi
for candidate in /boot/firmware/maskclaw-deploy /boot/maskclaw-deploy; do
  if [ -x "$candidate/install.sh" ]; then
    /bin/sh "$candidate/install.sh" "$candidate"
    mkdir -p /var/lib
    touch "$MARKER"
    reboot
    exit 0
  fi
done
exit 0

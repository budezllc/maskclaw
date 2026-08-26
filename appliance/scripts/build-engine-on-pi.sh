#!/bin/sh
# Removed: MaskClaw is never compiled on the Pi. End-user media is binary-only.
echo "Do not compile on the Pi. On the Windows/Linux builder run:" >&2
echo "  pwsh scripts/build-engine-aarch64.ps1" >&2
echo "  # or: sh scripts/build-engine-aarch64.sh" >&2
exit 1

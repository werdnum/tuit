#!/usr/bin/env bash
#
# Build Tuit and install it on a connected iPhone.
#
#   ./ios/build-and-install.sh            # the first connected device
#   ./ios/build-and-install.sh <udid>     # a specific device
#   ./ios/build-and-install.sh --list     # list connected devices
#
# Needs Xcode signed in to the team in Project.swift (Settings → Accounts), Tuist
# (brew install tuist), and an iPhone that is paired, unlocked and in Developer Mode.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
CONFIGURATION="${CONFIGURATION:-Release}"
# Local disk: Xcode's index store fails on network and shared volumes.
DERIVED_DATA="${DERIVED_DATA:-$HOME/Library/Developer/Xcode/DerivedData/Tuit-device}"

list_devices() {
    local tmp
    tmp="$(mktemp -t tuit-devices)"
    xcrun devicectl list devices --quiet --json-output "$tmp" >/dev/null
    /usr/bin/python3 - "$tmp" <<'PY'
import json, sys
for d in json.load(open(sys.argv[1])).get("result", {}).get("devices", []):
    hw, props, conn = d.get("hardwareProperties", {}), d.get("deviceProperties", {}), d.get("connectionProperties", {})
    if hw.get("platform", "").lower() != "ios" or conn.get("tunnelState") == "unavailable":
        continue
    print(f"{d.get('identifier')}\t{props.get('name')}\tiOS {props.get('osVersionNumber')}")
PY
    rm -f "$tmp"
}

if [[ "${1:-}" == "--list" ]]; then
    list_devices | column -t -s $'\t'
    exit 0
fi

DEVICE="${1:-$(list_devices | head -n 1 | cut -f1)}"
if [[ -z "$DEVICE" ]]; then
    echo "No iPhone found. Plug it in (or pair it over Wi-Fi in Xcode), unlock it, trust this Mac." >&2
    exit 1
fi

tuist generate --no-open
xcodebuild -project Tuit.xcodeproj -scheme Tuit -configuration "$CONFIGURATION" \
    -destination "id=$DEVICE" -derivedDataPath "$DERIVED_DATA" -allowProvisioningUpdates build
xcrun devicectl device install app --device "$DEVICE" \
    "$DERIVED_DATA/Build/Products/$CONFIGURATION-iphoneos/Tuit.app"
xcrun devicectl device process launch --device "$DEVICE" dev.andrewgarrett.tuit || true
echo "Installed. If iOS says the developer isn't trusted: Settings → General → VPN & Device Management."

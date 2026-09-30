#!/bin/sh
# Xcode Cloud runs this after cloning. The Xcode project isn't checked in, so generate it with
# the Tuist version pinned in ../.mise.toml.
set -eu

curl -fsSL https://mise.run | sh
export PATH="$HOME/.local/bin:$PATH"

cd "$CI_PRIMARY_REPOSITORY_PATH/ios"
mise trust .mise.toml
mise install
mise exec -- tuist generate --no-open

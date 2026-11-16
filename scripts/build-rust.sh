#!/usr/bin/env bash
set -euo pipefail
if ! command -v cargo >/dev/null; then
  installer="$(mktemp)"
  curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs -o "$installer"
  sh "$installer" -y --no-modify-path --profile minimal --default-toolchain 1.100.0
  rm -f "$installer"
  export PATH="${CARGO_HOME:-$HOME/.cargo}/bin:$PATH"
fi
if ! cargo install --list | grep -q '^worker-build v0.7.5:'; then
  cargo install worker-build --version 0.7.5 --locked
fi
# Rust release optimization remains enabled; omit optional Binaryen download.
worker-build --release --no-opt -- --locked

#!/usr/bin/env bash
# Installs the Rust toolchain pinned in rust-toolchain.toml with the runner's
# own rustup (every GitHub-hosted image has it), so no third-party setup
# action runs in CI or in the release jobs. Extra compilation targets — e.g.
# both Mac architectures for the universal build — are the arguments.
#
#   bash scripts/setup-rust.sh [target ...]
#
# The toolchain also becomes rustup's default, so cargo run outside the
# repository (cargo install) uses the same compiler.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
channel="$(sed -n 's/^[[:space:]]*channel[[:space:]]*=[[:space:]]*"\([^"]*\)".*$/\1/p' "$root/rust-toolchain.toml" | head -n 1)"
if [ -z "$channel" ]; then
  echo "::error::rust-toolchain.toml names no channel."
  exit 1
fi

args=(--profile minimal --component rustfmt --component clippy --no-self-update)
for target in ${1+"$@"}; do
  if [ -n "$target" ]; then args+=(--target "$target"); fi
done

rustup toolchain install "$channel" "${args[@]}"
rustup default "$channel"
rustc --version
cargo --version

#!/usr/bin/env bash
set -e
nix-build ./build.nix -o nix_build

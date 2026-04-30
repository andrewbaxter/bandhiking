{ pkgs ? import <nixpkgs> { } }:
let
  tsDeps = pkgs.fetchNpmDeps {
    src = pkgs.lib.cleanSource ./ts;
    hash = "sha256-0iRc4ddAPddeKpnS2nZZEwEOGFaQcdBui0OiHApViR4=";
  };
  staticAssets = pkgs.stdenv.mkDerivation {
    name = "bandhiking-static";
    src = pkgs.lib.cleanSource ./.;
    nativeBuildInputs = [ pkgs.nodejs pkgs.npmHooks.npmConfigHook ];
    npmDeps = tsDeps;
    npmRoot = "ts";
    buildPhase = ''
      cp -r prestatic static
      (
        cd ts
        node_modules/.bin/tsc --build tsconfig.json
        node_modules/.bin/rollup -c
        rm src/*.js
      )
    '';
    installPhase = ''
      mkdir -p $out
      cp -r static/. $out/
    '';
  };
  gitHash = "sha256-G8GDhhem1KveDF/UBSgbaakkAorVsLjPlRNH0ll2l3k=";
in
pkgs.pkgsStatic.rustPlatform.buildRustPackage {
  pname = "bandhiking";
  version = "0.1.0";
  src = pkgs.lib.cleanSourceWith {
    name = "bandhiking-src";
    src = ../.;
  };
  sourceRoot = "bandhiking-src/source";
  cargoLock = {
    lockFile = ./Cargo.lock;
    outputHashes = {
      "good-ormning-0.4.1" = gitHash;
      "good-ormning-core-0.1.0" = gitHash;
      "good-ormning-macros-0.1.0" = gitHash;
    };
  };
  STATIC_DIR = "${staticAssets}";
  nativeBuildInputs = [ pkgs.pkg-config ];
}

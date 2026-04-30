{ pkgs ? import <nixpkgs> { } }:
let
  fenix =
    import
      (fetchTarball "https://github.com/nix-community/fenix/archive/1a79901b0e37ca189944e24d9601c8426675de50.zip")
      { };
  toolchain = fenix.combine [
    fenix.latest.cargo
    fenix.latest.rustc
    fenix.targets.x86_64-unknown-linux-musl.latest.rust-std
  ];
  naersk = pkgs.callPackage
    (fetchTarball "https://github.com/nix-community/naersk/archive/378614f37a6bee5a3f2ef4f825a73d948d3ae921.zip")
    {
      cargo = toolchain;
      rustc = toolchain;
    };
  staticAssets = pkgs.stdenv.mkDerivation {
    name = "bandhiking-static";
    src = pkgs.lib.cleanSource ./.;
    nativeBuildInputs = [ pkgs.nodejs ];
    buildPhase = ''
      cp -r prestatic static
      (
        cd ts
        npm ci
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
in
naersk.buildPackage {
  src = pkgs.lib.cleanSource ./.;
  CARGO_BUILD_TARGET = "x86_64-unknown-linux-musl";
  CARGO_BUILD_RUSTFLAGS = "-C target-feature=+crt-static";
  STATIC_DIR = "${staticAssets}";
  nativeBuildInputs = with pkgs; [ musl.dev pkg-config ];
}

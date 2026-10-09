{
  description = "Tokate contribution workflows";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; };
      tokate = pkgs.callPackage ./nix/package.nix { source = self; };
    in {
      packages.${system} = { inherit tokate; default = tokate; };
      apps.${system}.default = {
        type = "app";
        program = "${tokate}/bin/tokate";
      };
    };
}

{
  description = "Tokate contribution workflows";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { nixpkgs, ... }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
      tokate = pkgs.callPackage ./nix/package.nix { };
    in {
      packages.${system} = { inherit tokate; default = tokate; };
      apps.${system}.default = {
        type = "app";
        program = "${tokate}/bin/tokate";
      };
    };
}

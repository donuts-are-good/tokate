{ lib, buildDotnetModule, dotnetCorePackages, clang, zlib, openssl,
  gitMinimal, gh, bubblewrap, util-linux, coreutils, findutils, curl, gnutar, nix, source }:

buildDotnetModule {
  pname = "tokate";
  version = "0.3.0";
  src = source;
  projectFile = "Tokate.gsproj";
  dotnet-sdk = dotnetCorePackages.sdk_10_0;
  runtimeId = "linux-x64";
  selfContainedBuild = true;
  executables = [ "tokate" ];
  nugetDeps = ./deps.json;
  dotnetFlags = [ "-p:NuGetLockFilePath=packages.nix.lock.json" ];
  nativeBuildInputs = [ clang ];
  buildInputs = [ zlib ];
  runtimeDeps = [ openssl zlib ];
  makeWrapperArgs = [
    "--prefix" "PATH" ":"
    (lib.makeBinPath [ gitMinimal gh bubblewrap util-linux coreutils findutils curl gnutar nix ])
  ];
  meta = {
    description = "Coordinate donor-funded contributions and independent verification";
    homepage = "https://github.com/obselate/tokate";
    mainProgram = "tokate";
    license = lib.licenses.mit;
    platforms = [ "x86_64-linux" ];
  };
}

{ lib, buildDotnetModule, dotnetCorePackages, clang, zlib, openssl,
  gitMinimal, gh, bubblewrap, util-linux, coreutils, findutils, curl, gnutar, nix,
  source ? ../. }:

buildDotnetModule {
  pname = "tokate";
  version = lib.strings.trim (builtins.readFile (source + "/VERSION"));
  src = lib.fileset.toSource {
    root = source;
    fileset = lib.fileset.unions (map (path: source + path) [
      "/VERSION"
      "/Directory.Build.props"
      "/Tokate.gsproj"
      "/global.json"
      "/NuGet.Config"
      "/packages.lock.json"
      "/.editorconfig"
      "/src"
      "/templates"
      "/.github/workflows/tokate-shared.yml"
      "/site/install.sh"
      "/LICENSE"
      "/licenses"
    ]);
  };
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
  postInstall = ''
    mkdir -p "$out/share/licenses/tokate"
    cp LICENSE licenses/* "$out/share/licenses/tokate/"
  '';
  meta = {
    description = "Coordinate donor-funded contributions and independent verification";
    homepage = "https://github.com/obselate/tokate";
    mainProgram = "tokate";
    license = lib.licenses.mit;
    platforms = [ "x86_64-linux" ];
  };
}

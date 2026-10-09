{ writeShellApplication, coreutils, findutils, diffutils }:
writeShellApplication {
  name = "tokate-nix-probe";
  runtimeInputs = [ coreutils findutils diffutils ];
  text = ''
    test ! -r "$1"
    test ! -r "$2"
    test -f result.txt
    cp result.txt /tmp/result
    test "$(find . -name result.txt)" = ./result.txt
    cmp result.txt /tmp/result
    case "$3" in
      network-allowed) exec 3<>/dev/tcp/127.0.0.1/"$4" ;;
      network-denied) if exec 3<>/dev/tcp/127.0.0.1/"$4"; then exit 1; fi ;;
    esac
    printf nix-closure-verified
  '';
}

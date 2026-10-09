# Alpine Linux

Alpine 3.24 x86_64 uses the `linux-musl-x64` NativeAOT release. The installer
selects that archive and verifies its checksum before replacing an installation.
The CLI does not require an installed .NET runtime.

```sh
tokate doctor --external --fix
tokate doctor --fix
```

Setup previews the required `apk` packages and asks before installation. It uses
`doas` or `sudo` for ordinary users. GNU coreutils, findutils and util-linux-misc
provide the required options that BusyBox applets lack.

Pi also needs Bash and Node.js 22.19 or newer with npm. Install Node through Alpine,
then let the official Pi installer manage Pi:

```sh
doas apk add nodejs npm
tokate doctor --harness pi --fix
```

Custom harness and Node paths remain supported. Tokate does not change user
namespace policy or run commands outside the sandbox when isolation fails.

package Tokate

import System.Collections.Generic
import System.IO

internal class NativeBoundary {
    shared {
        internal func Start(network bool, home string, temporary string) List[string] {
            let args = List[string]{
                "--die-with-parent",
                "--new-session",
                "--unshare-user",
                "--unshare-pid",
                "--unshare-ipc",
                "--unshare-uts",
                "--cap-drop",
                "ALL",
                "--clearenv",
                "--setenv",
                "PATH",
                "/usr/bin:/bin",
                "--setenv",
                "HOME",
                home,
                "--setenv",
                "TMPDIR",
                temporary,
                "--setenv",
                "LANG",
                "C.UTF-8"
            }
            if !network {
                args.Add("--unshare-net")
            }
            for path in[]string{"/usr/bin", "/usr/lib", "/usr/share", "/bin", "/lib", "/lib64"} {
                if Directory.Exists(path) {
                    args.AddRange([]string{"--ro-bind", path, path})
                }
            }
            for path in[]string{"/etc/ld.so.cache", "/etc/nsswitch.conf", "/etc/hosts", "/etc/resolv.conf"} {
                if File.Exists(path) {
                    args.AddRange([]string{"--ro-bind", path, path})
                }
            }
            args.AddRange(
                []string{"--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--dir", home, "--dir", temporary}
            )
            return args
        }

        internal func Repository(args List[string], checkout string) {
            Verification.Validate(checkout)
            args.AddRange(
                []string{
                    "--bind",
                    checkout,
                    checkout,
                    "--tmpfs",
                    Path.Combine(checkout, ".git"),
                    "--chmod",
                    "000",
                    Path.Combine(checkout, ".git"),
                    "--chdir",
                    checkout
                }
            )
        }
    }
}

package Tokate

import System.Collections.Generic
import System.IO

internal class SdkBoundary {
    shared {
        internal func Args(checkout string, root string, runtime string, control string, network bool) List[string] {
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
                "/tmp/tokate-agent",
                "--setenv",
                "TMPDIR",
                "/tmp/tokate-tools",
                "--setenv",
                "LANG",
                "C.UTF-8",
                "--setenv",
                "PI_OFFLINE",
                "1"
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
                []string{
                    "--proc",
                    "/proc",
                    "--dev",
                    "/dev",
                    "--tmpfs",
                    "/tmp",
                    "--dir",
                    "/tmp/tokate-agent",
                    "--dir",
                    "/tmp/tokate-tools",
                    "--ro-bind",
                    root,
                    "/tokate-runtime/node_modules",
                    "--ro-bind",
                    runtime,
                    "/tokate-node",
                    "--ro-bind",
                    control,
                    "/tokate-control",
                    "--bind",
                    checkout,
                    checkout,
                    "--tmpfs",
                    Path.Combine(checkout, ".git"),
                    "--chmod",
                    "000",
                    Path.Combine(checkout, ".git"),
                    "--chdir",
                    checkout,
                    "--"
                }
            )
            return args
        }
    }
}

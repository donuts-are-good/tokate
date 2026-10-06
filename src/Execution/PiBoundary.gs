package Tokate

import System
import System.Collections.Generic
import System.IO
import System.Text.Json

internal class PiBoundary {
    shared {
        internal func Endpoint(value string) string {
            var uri Uri
            if !Uri.TryCreate(value, UriKind.Absolute, out uri) ||
                uri.Scheme != "http" ||
                (uri.Host != "127.0.0.1" && uri.Host != "[::1]") ||
                uri.UserInfo != "" ||
                uri.Query != "" ||
                uri.Fragment != "" ||
                uri.AbsolutePath != "/v1" {
                throw Exception(
                    "Pi requires an explicit no-auth HTTP loopback base URL ending in /v1; endpoint details remain private"
                )
            }
            return uri.AbsoluteUri
        }

        internal func Boundary(checkout string, root string, node string, control string, network bool) List[string] {
            Verification.Validate(checkout)
            for path in[]string{root, node, control} {
                if path == checkout || path.StartsWith(checkout + "/") {
                    throw Exception("Pi runtime and control files must be outside the writable checkout")
                }
            }
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
                    node,
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

        internal func Control(control string, model string, endpoint string) {
            Directory.CreateDirectory(
                control,
                UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute
            )
            File.WriteAllText(Path.Combine(control, "bridge.mjs"), ApplicationInfo.Resource("pi-bridge.mjs"))
            File.WriteAllText(
                Path.Combine(control, "models.json"),
                J.Write(
                    J.Map(
                        "providers",
                        J.Map(
                            "tokate-local",
                            J.Map(
                                "baseUrl",
                                endpoint,
                                "api",
                                "openai-completions",
                                "apiKey",
                                "tokate-no-auth",
                                "authHeader",
                                false,
                                "models",
                                []Object{
                                    J.Map(
                                        "id",
                                        model,
                                        "name",
                                        model,
                                        "reasoning",
                                        false,
                                        "input",
                                        []string{"text"},
                                        "contextWindow",
                                        32768,
                                        "maxTokens",
                                        4096,
                                        "cost",
                                        J.Map("input", 0, "output", 0, "cacheRead", 0, "cacheWrite", 0),
                                        "compat",
                                        J.Map(
                                            "supportsDeveloperRole",
                                            false,
                                            "supportsReasoningEffort",
                                            false,
                                            "maxTokensField",
                                            "max_tokens"
                                        )
                                    )
                                }
                            )
                        )
                    )
                )
            )
        }

        internal func Probe(root string, node string, budget RuntimeBudget? = nil) {
            let storage = Directory.CreateDirectory(
                Path.Combine("/tmp", "tokate-pi-probe-" + Guid.NewGuid().ToString("N")),
                UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute
            )
            try {
                let checkout = Path.Combine(storage.FullName, "checkout")
                Directory.CreateDirectory(Path.Combine(checkout, ".git"))
                File.WriteAllText(Path.Combine(checkout, ".git/config"), "synthetic-private")
                File.WriteAllText(Path.Combine(storage.FullName, "credential-sentinel"), "synthetic-private")
                let control = Path.Combine(storage.FullName, "control")
                Control(control, "tokate-probe", "http://127.0.0.1:1/v1")
                let args = Boundary(checkout, root, node, control, false)
                args.AddRange(
                    []string{
                        "/tokate-node",
                        "/tokate-control/bridge.mjs",
                        "probe",
                        checkout,
                        "tokate-probe",
                        "false",
                        Path.Combine(storage.FullName, "credential-sentinel")
                    }
                )
                let result = Commands.Run(
                    "/usr/bin/bwrap",
                    args.ToArray(),
                    checkout,
                    seconds: 30,
                    isolated: true,
                    budget: budget,
                    pidNamespace: true
                )
                if result.Code != 0 ||
                    result.Truncated ||
                    result.ReadFailed ||
                    result
                    .Output
                    .Trim() != "{\"type\":\"pi.probe\",\"version\":\"1.0.0\",\"node\":\"v26.10.0\"}" {
                    throw Exception(
                        "Pi SDK or outer/nested isolation probe failed; requires pi 1.0.0 and tested Node 26.10.0. No inference started"
                    )
                }
            } finally {
                Directory.Delete(storage.FullName, true)
            }
        }
    }
}

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
            let tools = NixRuntime.Tools(checkout, []string{node})
            let runtime = List[string](tools)
            runtime.Add(root)
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
                NixRuntime.SearchPath(tools.ToArray()),
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
            let certificates = LocalPaths.Certificates()
            if certificates != "" {
                for name in[]string{"SSL_CERT_FILE", "GIT_SSL_CAINFO", "CURL_CA_BUNDLE", "NODE_EXTRA_CA_CERTS"} {
                    args.AddRange([]string{"--setenv", name, certificates})
                }
            }
            for path in[]string{"/usr/bin", "/usr/lib", "/usr/share", "/bin", "/lib", "/lib64"} {
                if Directory.Exists(path) {
                    args.AddRange([]string{"--ro-bind", path, path})
                }
            }
            for path in NixRuntime.Paths(runtime.ToArray(), checkout) {
                args.AddRange([]string{"--ro-bind", path, path})
            }
            for path in[]string{
                "/etc/ld.so.cache",
                "/etc/nsswitch.conf",
                "/etc/hosts",
                "/etc/resolv.conf",
                "/etc/ssl/certs/ca-certificates.crt",
                "/etc/ssl/cert.pem",
                "/etc/pki/tls/certs/ca-bundle.crt",
                "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem"
            } {
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

        internal func ModelSettings(
            root string,
            node string,
            model string,
            endpoint string,
            budget RuntimeBudget? = nil
        ) JsonElement {
            let storage = Directory.CreateDirectory(
                Path.Combine("/tmp", "tokate-pi-model-" + Guid.NewGuid().ToString("N")),
                UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute
            )
            try {
                let script = Path.Combine(storage.FullName, "model.mjs")
                File.WriteAllText(script, ApplicationInfo.Resource("pi-model.mjs"))
                let args = List[string]{
                    "--map-current-user",
                    "--net",
                    "--",
                    LocalPaths.NeedSystemTool("env"),
                    "-i",
                    "PATH=" + NixRuntime.SearchPath(NixRuntime.Tools("", []string{node}).ToArray()),
                    "LANG=C.UTF-8",
                    "PI_OFFLINE=1"
                }
                for key in[]string{"HOME", "PI_CODING_AGENT_DIR"} {
                    if let value = Environment.GetEnvironmentVariable(key) {
                        args.Add(key + "=" + value)
                    }
                }
                args.AddRange([]string{node, "--experimental-import-meta-resolve", script, root, model})
                let result = Commands.Run(
                    LocalPaths.NeedSystemTool("unshare"),
                    args.ToArray(),
                    storage.FullName,
                    input: endpoint,
                    seconds: 30,
                    isolated: true,
                    budget: budget
                )
                if result.Code != 0 || result.Truncated || result.ReadFailed {
                    throw Exception(
                        "Pi requires one configured local model at the selected endpoint; no inference started"
                    )
                }
                let limits = RequestData.Parse(result.Output.Trim(), 4096)
                RequestData.Keys(limits, "contextWindow,maxTokens,reasoning,thinkingLevelMap,compat,efforts")
                let contextWindow = J.Number(limits, "contextWindow")
                let maxTokens = J.Number(limits, "maxTokens")
                if contextWindow < 1 || maxTokens < 1 || maxTokens > contextWindow {
                    throw Exception("Pi configured model limits are invalid; no inference started")
                }
                return limits
            } finally {
                Directory.Delete(storage.FullName, true)
            }
        }

        internal func CheckEffort(settings JsonElement, effort string) {
            for level in J.Items(J.Get(settings, "efforts")) {
                if level.GetString() == effort {
                    return
                }
            }
            throw Exception(
                "Pi does not support the selected reasoning effort for this configured model; choose a supported level before starting"
            )
        }

        internal func Control(control string, model string, endpoint string, settings JsonElement) {
            Directory.CreateDirectory(
                control,
                UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute
            )
            File.WriteAllText(Path.Combine(control, "bridge.mjs"), ApplicationInfo.Resource("pi-bridge.mjs"))
            File.WriteAllText(
                Path.Combine(control, "models.json"),
                J.Write(
                    map[string, Object?]{
                        "providers": map[string, Object?]{
                            "tokate-local": map[string, Object?]{
                                "baseUrl": endpoint,
                                "api": "openai-completions",
                                "apiKey": "tokate-no-auth",
                                "authHeader": false,
                                "models": []Object{
                                    map[string, Object?]{
                                        "id": model,
                                        "name": model,
                                        "reasoning": J.Get(settings, "reasoning"),
                                        "thinkingLevelMap": J.Get(settings, "thinkingLevelMap"),
                                        "input": []string{"text"},
                                        "contextWindow": J.Number(settings, "contextWindow"),
                                        "maxTokens": J.Number(settings, "maxTokens"),
                                        "cost": map[string, Object?]{
                                            "input": 0,
                                            "output": 0,
                                            "cacheRead": 0,
                                            "cacheWrite": 0
                                        },
                                        "compat": map[string, Object?]{
                                            "supportsDeveloperRole": false,
                                            "supportsReasoningEffort": J.Get(
                                                J.Get(settings, "compat"),
                                                "supportsReasoningEffort"
                                            ),
                                            "thinkingFormat": J.Text(J.Get(settings, "compat"), "thinkingFormat"),
                                            "maxTokensField": "max_tokens"
                                        }
                                    }
                                }
                            }
                        }
                    }
                )
            )
        }

        internal func Probe(root string, node string, budget RuntimeBudget? = nil) JsonElement {
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
                Control(
                    control,
                    "tokate-probe",
                    "http://127.0.0.1:1/v1",
                    J.Parse(
                        "{\"contextWindow\":32768,\"maxTokens\":4096,\"reasoning\":false,\"thinkingLevelMap\":{},\"compat\":{\"supportsReasoningEffort\":false,\"thinkingFormat\":\"openai\"}}"
                    )
                )
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
                    LocalPaths.NeedSystemTool("bwrap", checkout),
                    args.ToArray(),
                    checkout,
                    seconds: 30,
                    isolated: true,
                    budget: budget,
                    pidNamespace: true
                )
                if result.Code != 0 || result.Truncated || result.ReadFailed {
                    throw Exception(
                        "Pi SDK or outer/nested isolation probe failed. Update pi and Node, then retry the probe. No inference started"
                    )
                }
                let runtime = RequestData.Parse(result.Output.Trim(), 4096)
                if J.Text(runtime, "type") != "pi.probe" || J.Text(runtime, "version") == "" || !J.Text(runtime, "node")
                    .StartsWith("v") {
                    throw Exception(
                        "Pi SDK probe did not report its actual package and Node versions. No inference started"
                    )
                }
                return runtime
            } finally {
                Directory.Delete(storage.FullName, true)
            }
        }
    }
}

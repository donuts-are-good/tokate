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
            return SdkBoundary.Args(checkout, root, node, control, network)
        }

        internal func ModelLimits(
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
                    "/usr/bin/env",
                    "-i",
                    "PATH=/usr/bin:/bin",
                    "LANG=C.UTF-8",
                    "PI_OFFLINE=1"
                }
                for key in[]string{"HOME", "PI_CODING_AGENT_DIR"} {
                    if let value = Environment.GetEnvironmentVariable(key) {
                        args.Add(key + "=" + value)
                    }
                }
                args.AddRange([]string{node, script, root, model})
                let result = Commands.Run(
                    "/usr/bin/unshare",
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
                let limits = RequestData.Parse(result.Output.Trim(), 1024)
                RequestData.Keys(limits, "contextWindow,maxTokens")
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

        internal func Control(control string, model string, endpoint string, contextWindow int32, maxTokens int32) {
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
                                        "reasoning": false,
                                        "input": []string{"text"},
                                        "contextWindow": contextWindow,
                                        "maxTokens": maxTokens,
                                        "cost": map[string, Object?]{
                                            "input": 0,
                                            "output": 0,
                                            "cacheRead": 0,
                                            "cacheWrite": 0
                                        },
                                        "compat": map[string, Object?]{
                                            "supportsDeveloperRole": false,
                                            "supportsReasoningEffort": false,
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
                Control(control, "tokate-probe", "http://127.0.0.1:1/v1", 32768, 4096)
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

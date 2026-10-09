package TokateTests

import System
import System.IO
import System.Net
import System.Net.Sockets
import System.Text.Json.Nodes

internal class NixChecks {
    shared {
        internal func Run(binary string, probe string, unrelated string, nixStore string) {
            Check.That(probe.StartsWith("/nix/store/") && File.Exists(probe), "Missing real Nix probe")
            Check.That(unrelated.StartsWith("/nix/store/") && File.Exists(unrelated), "Missing unrelated store file")
            let listener = TcpListener(IPAddress.Loopback, 0)
            listener.Start()
            try {
                let port = (listener.LocalEndpoint as IPEndPoint)?.Port.ToString() ?? throw Exception("Missing port")
                for mode in[]string{"selected", "network-denied", "network-allowed", "missing", "checkout"} {
                    using let flow = NativeFixture(binary)
                    File.CreateSymbolicLink(Path.Combine(flow.Bin, "nix-store"), nixStore)
                    flow.Initialize()
                    let privateFile = Path.Combine(flow.Temp.Root, "private")
                    File.WriteAllText(privateFile, "synthetic-private-data")
                    var selected = probe
                    if mode == "missing" {
                        selected = "/nix/store/00000000000000000000000000000000-missing/bin/probe"
                    } else if mode == "checkout" {
                        Directory.CreateDirectory(Path.Combine(flow.Upstream, "tools"))
                        File.CreateSymbolicLink(Path.Combine(flow.Upstream, "tools/check"), probe)
                        selected = "./tools/check"
                    }
                    let policyPath = Path.Combine(flow.Upstream, ".github/tokate.json")
                    let policy = Check.Json(File.ReadAllText(policyPath))
                    let command = JsonArray()
                    for word in[]string{selected, privateFile, unrelated, mode, port} {
                        command.Add(JsonValue.Create(word) as JsonNode)
                    }
                    let commands = JsonArray()
                    commands.Add(command as JsonNode)
                    policy["verification"] = commands
                    policy["allow_network"] = JsonValue.Create(mode == "network-allowed")
                    File.WriteAllText(policyPath, policy.ToJsonString())
                    flow.Commit("Select Nix verification runtime")
                    flow.Git("-C", Path.Combine(flow.Bin, "fork"), "fetch", flow.Upstream, "main")
                    flow.Approve()
                    let run = flow.Claim(network: mode == "network-allowed")
                    let accepted = mode == "selected" || mode.StartsWith("network-")
                    let result = flow.Call([]string{"work", "--run", run}, accepted ? 0: 1)
                    if accepted {
                        Check.Contains(File.ReadAllText(Path.Combine(run, "verification.json")), "nix-closure-verified")
                    } else {
                        Check.Contains(
                            result.Error,
                            mode == "checkout" ? "outside the checkout": "closure is unavailable"
                        )
                        Check.That(File.Exists(Path.Combine(run, "run.json")), "Failed runtime removed saved work")
                    }
                    Check.That(
                        File.ReadAllText(privateFile) == "synthetic-private-data",
                        "Verification changed private data"
                    )
                    Check.That(
                        listener.Pending() == (mode == "network-allowed"),
                        "Unexpected Nix verification network access"
                    )
                    if listener.Pending() {
                        using let client = listener.AcceptTcpClient()
                    }
                    flow.NoPr()
                }
            } finally {
                listener.Stop()
            }
            Console.WriteLine(
                "PASS selected Nix closure executes with private and unrelated store files denied; network permissions enforced; missing store and checkout runtime fail without deleting saved work"
            )
        }
    }
}

package TokateTests

import System
import System.Collections.Generic
import System.IO
import System.Security.Cryptography
import Tokate

internal class LocalCodex {
    shared {
        internal func All(binary string, launcher string, native string, standalone string) {
            using let flow = NativeFlow(binary)
            flow.Initialize()
            let node = Environment.GetEnvironmentVariable("TOKATE_PROOF_NODE") ??
                throw Exception("Missing donor-local Node for installation proof")
            Check.Success(
                Check.Run(
                    "/bin/sh",
                    []string{
                        "-c",
                        "PATH=/usr/local/bin:/usr/bin:/bin; if command -v node; then exit 1; fi; \"$1\" --version",
                        "proof",
                        node
                    },
                    flow.Temp.Env
                )
            )
            File.CreateSymbolicLink(Path.Combine(flow.Bin, "node"), node)
            Check.Contains(
                Check.Success(Check.Run(launcher, []string{"--version"}, flow.Temp.Env)),
                "codex-cli 0.160.0"
            )
            let secrets = List[string]()
            for relative in[]string{
                ".netrc",
                ".aws/credentials",
                ".config/gh/hosts.yml",
                ".cache/npm/token",
                ".codex/config.toml"
            } {
                let secret = Path.Combine(flow.Temp.Env["HOME"], relative)
                Directory.CreateDirectory(Path.GetDirectoryName(secret) ?? "")
                File.WriteAllText(secret, "synthetic-local-install-secret")
                secrets.Add(secret)
            }
            let auth = Path.Combine(flow.Temp.Env["CODEX_HOME"], "auth.json")
            File.WriteAllText(auth, "synthetic-local-install-secret")
            secrets.Add(auth)
            let packageSecret = Path.Combine(Path.GetDirectoryName(native) ?? "", "private-config")
            File.WriteAllText(packageSecret, "synthetic-local-install-secret")
            secrets.Add(packageSecret)
            secrets.Add(launcher)
            secrets.Add(node)
            let checkout = Path.Combine(flow.Temp.Root, "isolation-checkout")
            Directory.CreateDirectory(Path.Combine(checkout, ".git"))
            File.WriteAllText(Path.Combine(checkout, ".git/config"), "synthetic-git-secret")
            for selected in[]string{launcher, standalone} {
                File.Delete(Path.Combine(flow.Bin, "codex"))
                File.CreateSymbolicLink(Path.Combine(flow.Bin, "codex"), selected)
                let doctor = CliDiscovery.Envelope(flow.Call([]string{"doctor", "--managed", "--json"}), "doctor", "ok")
                Check.That(doctor["data"]?["tools"] != nil, "Doctor did not report capabilities")
                let choice = CliDiscovery.Envelope(
                    flow.Call(
                        []string{
                            "select",
                            "--repo",
                            "owner/project",
                            "--model",
                            "gpt-6.1-sol",
                            "--effort",
                            "high",
                            "--non-interactive",
                            "--json"
                        }
                    ),
                    "select",
                    "ok"
                )
                Check.That(
                    Check.Text(choice["data"]?["model"]) == "gpt-6.1-sol",
                    "Production offline selection did not retain the requested model"
                )
            }
            for runtime in[]string{native, standalone} {
                let digest = SHA256.HashData(File.ReadAllBytes(runtime))
                let filesystem = "{ \":root\" = \"deny\", \":minimal\" = \"read\", \"/tmp\" = \"write\", " + J.Write(
                    checkout
                ) +
                    " = \"write\", " +
                    J.Write(Path.Combine(checkout, ".git")) + " = \"deny\", " + J.Write(runtime) + " = \"read\" }"
                let args = List[string]{
                    "sandbox",
                    "-P",
                    "tokate",
                    "--include-managed-config",
                    "-C",
                    checkout,
                    "-c",
                    "permissions.tokate.filesystem=" + filesystem,
                    "-c",
                    "permissions.tokate.network.enabled=false",
                    "--",
                    "/usr/bin/env",
                    "-i",
                    "PATH=/usr/local/bin:/usr/bin:/bin",
                    "HOME=/tmp/tokate-home",
                    "CODEX_HOME=/tmp/tokate-home",
                    "/bin/sh",
                    "-c",
                    "set -eu; runtime=$1; shift; test -r \"$$runtime\"; test ! -w \"$$runtime\"; \"$$runtime\" --version; test ! -r .git/config; for secret do test ! -r \"$$secret\"; done; touch isolation-writable; touch /tmp/isolation-writable",
                    "proof",
                    runtime
                }
                args.AddRange(secrets)
                args.Add(runtime == native ? standalone: native)
                Check.Contains(Check.Success(Check.Run(runtime, args.ToArray(), flow.Temp.Env)), "codex-cli 0.160.0")
                Check.That(
                    Convert.ToHexString(digest) == Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(runtime))),
                    "Installed runtime changed"
                )
            }
            let verification = List[string]{
                "/bin/sh",
                "-c",
                "set -eu; test -r .git/config; test ! -w .git/config; for private do test ! -r \"$$private\"; done; touch independent-writable",
                "proof",
                native,
                standalone,
                launcher,
                node
            }
            verification.AddRange(secrets)
            let result = Verification.Run(checkout, verification.ToArray(), false, 30)
            Check.That(result.Code == 0, result.Output + result.Error)
            let unsupported = Path.Combine(flow.Bin, "unsupported-launcher")
            let marker = Path.Combine(flow.Temp.Root, "launcher-discovery-ran")
            File.WriteAllText(
                unsupported,
                "#!/bin/sh\nif test \"$1\" = --version; then echo codex-cli 0.160.0; exit 0; fi\ntouch '" +
                    marker +
                    "'\nexit 1\n"
            )
            File.SetUnixFileMode(unsupported, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute)
            File.Delete(Path.Combine(flow.Bin, "codex"))
            File.CreateSymbolicLink(Path.Combine(flow.Bin, "codex"), unsupported)
            let refusal = Check.Run(binary, []string{"doctor", "--managed", "--json"}, flow.Temp.Env)
            Check.That(refusal.Code != 0, "Unsupported runtime was accepted")
            CliDiscovery.Envelope(refusal, "doctor", "error", "verification_failed")
            Check.Contains(refusal.Output, "Unsupported managed Codex runtime layout")
            Check.That(!File.Exists(marker), "An arbitrary launcher was executed to discover runtime files")
            Check.That(File.ReadAllText(auth) == "synthetic-local-install-secret", "Harness authentication was changed")
            flow.NoInference()
            Console.WriteLine(
                "PASS production doctor and offline selection: unmodified npm launcher and native symlink with donor-local Node, system Node unavailable; runtime read-only; synthetic home/auth/cache/package/Git secrets unreadable; independent verification excludes donor runtime; unsupported launchers diagnosed without discovery execution; no inference"
            )
        }
    }
}

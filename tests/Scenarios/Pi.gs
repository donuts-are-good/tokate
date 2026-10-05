package TokateTests

import Gsharp.Concurrency
import System
import System.Collections.Generic
import System.IO
import Tokate

internal class PiChecks {
    shared {
        private func Reject(action Action) {
            var rejected bool
            try {
                action()
            } catch (error Exception) {
                rejected = true
            }
            Check.That(rejected, "Unsafe pi input was accepted")
        }

        internal func Bridge(root string, node string, directory string, endpoint string, network string) {
            let checkout = Path.Combine(directory, "checkout")
            Directory.CreateDirectory(Path.Combine(checkout, ".git"))
            File.WriteAllText(Path.Combine(checkout, ".git/config"), "synthetic-private")
            Directory.CreateDirectory(Path.Combine(checkout, ".pi/extensions"))
            File.WriteAllText(
                Path.Combine(checkout, ".pi/settings.json"),
                "{\"extensions\":[\"./extensions/hostile.js\"],\"retry\":{\"enabled\":true}}"
            )
            File.WriteAllText(
                Path.Combine(checkout, ".pi/extensions/hostile.js"),
                "throw new Error('HOSTILE_EXTENSION_LOADED');"
            )
            File.WriteAllText(Path.Combine(checkout, "AGENTS.md"), "HOSTILE_CONTEXT_SENTINEL")
            File.WriteAllText(Path.Combine(directory, "private-credential"), "PRIVATE_CREDENTIAL_SENTINEL")
            let control = PiBoundary.Control(directory, "synthetic/model:exact", endpoint)
            let args = PiBoundary.Boundary(checkout, root, node, control, true)
            args.AddRange(
                []string{
                    "/tokate-node",
                    "/tokate-control/bridge.mjs",
                    "run",
                    checkout,
                    "synthetic/model:exact",
                    network
                }
            )
            let result = Commands.Run(
                "/usr/bin/bwrap",
                args.ToArray(),
                checkout,
                "Implement synthetic edits and return a report.",
                seconds: 10,
                isolated: true,
                outputPath: Path.Combine(directory, "events.jsonl"),
                errorPath: Path.Combine(directory, "stderr.log")
            )
            Console.Write(result.Output)
            Console.Error.Write(result.Error)
            if result.Code != 0 || result.Truncated || result.ReadFailed {
                throw Exception("Pi synthetic bridge execution failed")
            }
            PiEvidence.Completed(directory, result.Output, "synthetic/model:exact")
            let check = Verification.Run(
                checkout,
                []string{"/bin/sh", "-c", "test \"$$(cat result.txt)\" = final"},
                false,
                10
            )
            Check.That(check.Code == 0, "Independent owner verification failed")
        }

        private func Signal(cancellation Chan[bool]) {
            using let delay = after(TimeSpan.FromMilliseconds(200))
            select {
                case <- delay { }
            }
            cancellation <- true
        }

        internal func All() {
            let storage = Directory.CreateDirectory(
                Path.Combine("/tmp", "tokate-pi-tests-" + Guid.NewGuid().ToString("N")),
                UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute
            )
            try {
                let root = storage.FullName
                PiBoundary.Endpoint("http://127.0.0.1:8080/v1")
                PiBoundary.Endpoint("http://[::1]:8080/v1")
                for endpoint in[]string{
                    "https://127.0.0.1/v1",
                    "http://remote.example/v1",
                    "http://user:secret@127.0.0.1/v1",
                    "http://127.0.0.1/v1?key=secret",
                    "http://127.0.0.1/v1#secret",
                    "http://127.0.0.1/other"
                } {
                    Reject(() -> PiBoundary.Endpoint(endpoint))
                }
                let policy = Policy(
                    "{\"version\":2,\"model_policy\":\"whitelist\",\"models\":{\"org/model:exact\":[\"absent\"]},\"allowed_tools\":[{\"harness\":\"pi\",\"provider\":\"local-chat-completions\"}],\"max_seconds\":60,\"allow_network\":false,\"verification\":[[\"true\"]],\"required_checks\":[\"test\"]}"
                )
                policy.ValidatePi("org/model:exact", "absent", 60, false)
                Reject(() -> policy.ValidatePi("org/model:exact", "high", 60, false))
                Reject(() -> policy.ValidatePi("org/model:other", "absent", 60, false))
                Reject(() -> policy.ValidatePi("org/model:exact", "absent", 61, false))
                Reject(() -> policy.ValidatePi("org/model:exact", "absent", 60, true))
                Reject(() -> policy.Validate("org/model:exact", "high", 60, false))
                let started = "{\"type\":\"pi.started\",\"model\":\"exact\",\"provider\":\"local-chat-completions\",\"effort\":\"absent\"}\n"
                let completed = "{\"type\":\"pi.completed\",\"model\":\"exact\",\"stop_reason\":\"stop\",\"report\":\"Done\",\"usage\":{\"input_tokens\":2,\"output_tokens\":3}}\n"
                PiEvidence.Completed(root, started + completed, "exact")
                Reject(() -> PiEvidence.Completed(root, started, "exact"))
                Reject(() -> PiEvidence.Completed(root, started + completed + completed, "exact"))
                Reject(() -> PiEvidence.Completed(root, started + completed, "other"))
                Reject(() -> PiEvidence.Completed(root, started + completed.Replace("\"stop\"", "\"length\""), "exact"))
                Reject(() -> PiEvidence.Completed(root, started + completed.Replace("\"Done\"", "\"\""), "exact"))
                Reject(
                    () -> PiEvidence.Completed(root, started + completed.Replace("tokens\":2", "tokens\":-1"), "exact")
                )
                Reject(() -> PiEvidence.Completed(root, started + "malformed", "exact"))
                let checkout = Path.Combine(root, "checkout")
                Directory.CreateDirectory(Path.Combine(checkout, ".git"))
                File.WriteAllText(Path.Combine(checkout, ".git/config"), "private-git")
                let secret = Path.Combine(root, "credential-sentinel")
                File.WriteAllText(secret, "private-credential")
                let modules = Path.Combine(root, "node_modules")
                Directory.CreateDirectory(modules)
                let control = PiBoundary.Control(root, "exact", "http://127.0.0.1:1/v1")
                var args = PiBoundary.Boundary(checkout, modules, "/usr/bin/node", control, false)
                args.AddRange(
                    []string{
                        "/bin/sh",
                        "-c",
                        "test ! -r \"$1\" && test ! -r .git/config && ! touch .git/config && ! touch /usr/bin/tokate-test && test -z \"$$PRIVATE_SENTINEL\" && touch work.txt && touch /tmp/temp.txt && test ! -e /tmp/tokate-pi-tests-outside",
                        "probe",
                        secret
                    }
                )
                var result = Commands.Run("/usr/bin/bwrap", args.ToArray(), checkout, isolated: true)
                Check.That(result.Code == 0, "Real pi filesystem boundary failed: " + result.Error)
                Check.That(File.Exists(Path.Combine(checkout, "work.txt")), "Writable checkout was lost")
                Check.That(File.ReadAllText(secret) == "private-credential", "Outside credential changed")
                Check.That(
                    File.ReadAllText(Path.Combine(checkout, ".git/config")) == "private-git",
                    "Git metadata changed"
                )
                Check.That(!File.Exists(Path.Combine(root, "temp.txt")), "Private temporary storage escaped")
                args = PiBoundary.Boundary(checkout, modules, "/usr/bin/node", control, false)
                args.AddRange([]string{"/bin/sh", "-c", "setsid sh -c 'sleep 2; touch descendant-escaped' & wait"})
                var interrupted bool
                try {
                    Commands.Run("/usr/bin/bwrap", args.ToArray(), checkout, milliseconds: 200, isolated: true)
                } catch (error CommandInterrupted) {
                    interrupted = true
                }
                Check.That(interrupted, "Pi deadline did not interrupt execution")
                Commands.Checked("/bin/sleep", []string{"3"})
                Check.That(
                    !File.Exists(Path.Combine(checkout, "descendant-escaped")),
                    "Timed-out pi descendant survived"
                )
                args = PiBoundary.Boundary(checkout, modules, "/usr/bin/node", control, true)
                args.AddRange(
                    []string{
                        "/usr/bin/bwrap",
                        "--die-with-parent",
                        "--new-session",
                        "--unshare-user",
                        "--unshare-pid",
                        "--unshare-ipc",
                        "--unshare-uts",
                        "--unshare-net",
                        "--cap-drop",
                        "ALL",
                        "--clearenv",
                        "--ro-bind",
                        "/",
                        "/",
                        "--proc",
                        "/proc",
                        "--dev",
                        "/dev",
                        "--tmpfs",
                        "/tmp",
                        "--bind",
                        checkout,
                        checkout,
                        "--tmpfs",
                        Path.Combine(checkout, ".git"),
                        "--chmod",
                        "000",
                        Path.Combine(checkout, ".git"),
                        "--tmpfs",
                        "/tokate-control",
                        "--chmod",
                        "000",
                        "/tokate-control",
                        "--chdir",
                        checkout,
                        "--",
                        "/bin/sh",
                        "-c",
                        "test ! -r /tokate-control/models.json && test ! -r /proc/1/root/tokate-control/models.json && test ! -r .git/config && ! touch /usr/bin/nested-test && touch nested-work.txt"
                    }
                )
                result = Commands.Run("/usr/bin/bwrap", args.ToArray(), checkout, isolated: true)
                Check.That(
                    result.Code == 0 && File.Exists(Path.Combine(checkout, "nested-work.txt")),
                    "Real nested shell boundary failed: " + result.Error
                )
                let hostNetwork = Commands.Checked("/usr/bin/readlink", []string{"/proc/self/ns/net"})
                args = PiBoundary.Boundary(checkout, modules, "/usr/bin/node", control, false)
                args.AddRange([]string{"/usr/bin/readlink", "/proc/self/ns/net"})
                result = Commands.Run("/usr/bin/bwrap", args.ToArray(), checkout, isolated: true)
                Check.That(
                    result.Code == 0 && result.Output.Trim() != hostNetwork,
                    "Denied command network shared host namespace"
                )
                args = PiBoundary.Boundary(checkout, modules, "/usr/bin/node", control, true)
                args.AddRange([]string{"/usr/bin/readlink", "/proc/self/ns/net"})
                result = Commands.Run("/usr/bin/bwrap", args.ToArray(), checkout, isolated: true)
                Check.That(
                    result.Code == 0 && result.Output.Trim() == hostNetwork,
                    "Allowed network lost host namespace"
                )
                args = PiBoundary.Boundary(checkout, modules, "/usr/bin/node", control, false)
                args.AddRange([]string{"/bin/sh", "-c", "setsid sh -c 'sleep 2; touch cancellation-escaped' & wait"})
                let cancellation = Chan[bool](1)
                go Signal(cancellation)
                interrupted = false
                try {
                    Commands.Run("/usr/bin/bwrap", args.ToArray(), checkout, isolated: true, cancellation: cancellation)
                } catch (error CommandInterrupted) {
                    interrupted = true
                }
                Commands.Checked("/bin/sleep", []string{"3"})
                Check.That(
                    interrupted && !File.Exists(Path.Combine(checkout, "cancellation-escaped")),
                    "Cancelled pi descendant survived"
                )
                Console.WriteLine(
                    "PASS pi exact policy, completion failures, real outer isolation, network namespaces and deadline/cancellation descendants"
                )
            } finally {
                Directory.Delete(storage.FullName, true)
            }
        }
    }
}

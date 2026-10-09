package TokateTests

import Gsharp.Concurrency
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Text.Json.Nodes

internal class VerificationChecks {
    shared {
        internal func All(binary string) {
            Layouts(binary)
            RuntimeFiles(binary)
            Alternatives(binary)
            FailClosed(binary)
        }

        private func Layouts(binary string) {
            using let flow = NativeFixture(binary)
            flow.Initialize()
            flow.Approve()
            let run = flow.Claim()
            flow.Mode("verification_fail")
            Check.Contains(flow.Call([]string{"work", "--run", run}, 1).Error, "Owner verification failed")
            flow.Call([]string{"recover", "--run", run, "--prepare"})
            let commit = CorrectionChecks.Correct(flow, run)
            using let baseline = FixtureSnapshot(flow.Temp.Root)
            for mode in[]string{
                "checkout-link",
                "git-link",
                "git-file",
                "git-child-link",
                "alternates",
                "http-alternates",
                "commondir",
                "inside",
                "alias"
            } {
                baseline.Restore()
                let checkout = Path.Combine(run, "checkout")
                let git = Path.Combine(checkout, ".git")
                let sentinel = Path.Combine(flow.Temp.Root, "private-layout")
                File.WriteAllText(sentinel, "synthetic-private-configuration")
                let evidence = File.ReadAllText(Path.Combine(run, "verification.json"))
                var reason = "Git symlinks"
                if mode == "checkout-link" || mode == "git-link" {
                    let path = mode == "checkout-link" ? checkout: git
                    Directory.Move(path, path + "-real")
                    Directory.CreateSymbolicLink(path, path + "-real")
                    reason = "real directories without checkout/Git symlinks"
                } else if mode == "git-file" {
                    Directory.Delete(git, true)
                    File.WriteAllText(git, "gitdir: " + sentinel)
                    reason = "real directories"
                } else if mode == "git-child-link" {
                    File.Delete(Path.Combine(git, "config"))
                    File.CreateSymbolicLink(Path.Combine(git, "config"), sentinel + "-missing")
                } else if mode == "inside" || mode == "alias" {
                    let storage = Path.Combine(checkout, "runtime-tmp")
                    Directory.CreateDirectory(storage)
                    flow.Temp.Env["TMPDIR"] = mode == "alias" ? Directory.CreateSymbolicLink(
                        Path.Combine(flow.Temp.Root, "runtime-alias"),
                        storage
                    )
                        .FullName: storage
                    reason = mode == "alias" ? "real directories without checkout/Git symlinks": "runtime storage must be outside the checkout"
                    Directory.CreateDirectory(Path.Combine(git, "info"))
                    File.AppendAllText(Path.Combine(git, "info/exclude"), "\nruntime-tmp/\n")
                } else {
                    PublishedContribution.Write(git, mode == "commondir" ? mode: "objects/info/" + mode, flow.Temp.Root)
                    reason = "self-contained Git metadata"
                }
                Check.Contains(CorrectionChecks.Recover(flow, run, commit, 1).Error, reason)
                if mode != "inside" && mode != "alias" {
                    Check.That(
                        File.ReadAllText(Path.Combine(run, "verification.json")) == evidence,
                        "Unsafe Git layout reran repository verification"
                    )
                }
                flow.Temp.Env.Remove("TMPDIR")
                Check.That(
                    File.ReadAllText(sentinel) == "synthetic-private-configuration" && !File.Exists(
                        sentinel + "-missing"
                    ),
                    "Unsafe layout touched private data"
                )
                flow.Reload()
                Check.That(Check.Text(flow.State["exec_count"]) == "1", "Unsafe layout spent extra inference")
                flow.NoPr()
            }
            Console.WriteLine(
                "PASS CLI recovery rejects linked checkout/Git metadata, shared Git storage and writable runtime aliases"
            )
        }

        private func RuntimeFiles(binary string) {
            for mode in[]string{"replace", "unlink", "oversize"} {
                using let temp = Temp()
                let source = Path.Combine(temp.Root, "dns-source")
                if mode == "oversize" {
                    File.WriteAllBytes(source, [4 * 1024 * 1024 + 1]byte)
                } else {
                    File.WriteAllText(source, "synthetic-runtime-dns\n")
                }
                let storage = Path.Combine(temp.Root, "runtime-tmp")
                Directory.CreateDirectory(storage)
                temp.Env["TMPDIR"] = storage
                temp.Env["TOKATE_TEST_ROOT"] = temp.Root
                let cli = Path.Combine(temp.Root, "tokate-runtime")
                let tests = Path.Combine(temp.Root, "runtime-tests")
                File.Copy(binary, cli)
                File.Copy(Environment.ProcessPath ?? throw Exception("Missing test executable"), tests)
                temp.Env["TOKATE_BINARY"] = cli
                let args = List[string]{
                    "--die-with-parent",
                    "--unshare-user",
                    "--unshare-pid",
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
                    temp.Root,
                    temp.Root,
                    "--ro-bind",
                    source,
                    "/etc/resolv.conf",
                    "--",
                    tests,
                    "--runtime-files-parent",
                    mode
                }
                Check.Success(TestProcess.Run("/usr/bin/bwrap", args.ToArray(), temp.Env))
                Check.That(Directory.GetFileSystemEntries(storage).Length == 0, "CLI runtime copies leaked from parent")
            }
            Console.WriteLine(
                "PASS CLI work copies replaced/unlinked runtime DNS for nested mounts and rejects oversized input"
            )
        }

        private func FailClosed(binary string) {
            using let flow = NativeFixture(binary)
            flow.Initialize()
            PublishedContribution.Write(flow.Upstream, ".gitignore", "verification-marker\n")
            flow.VerificationPolicy("printf ran > verification-marker; exit 1")
            flow.Approve()
            let run = flow.Claim()
            let marker = Path.Combine(run, "checkout/verification-marker")
            Check.Contains(flow.Call([]string{"work", "--run", run}, 1).Error, "Owner verification failed")
            flow.Call([]string{"recover", "--run", run, "--prepare"})
            let commit = CorrectionChecks.Correct(flow, run)
            let storage = Path.Combine(flow.Temp.Root, "runtime-tmp")
            Directory.CreateDirectory(storage)
            flow.Temp.Env["TMPDIR"] = storage
            let broken = Path.Combine(flow.Temp.Root, "broken-bwrap")
            File.WriteAllText(
                broken,
                "#!/bin/sh\nif [ \"$1\" = --version ]; then printf fixture-bwrap; exit 0; fi\nprintf 'synthetic sandbox startup failure' >&2\nexit 77\n"
            )
            File.SetUnixFileMode(broken, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute)
            using let baseline = FixtureSnapshot(flow.Temp.Root)
            for missing in[]bool{true, false} {
                baseline.Restore()
                File.Delete(marker)
                let args = List[string]{
                    "--die-with-parent",
                    "--unshare-user",
                    "--unshare-pid",
                    "--ro-bind",
                    "/",
                    "/",
                    "--proc",
                    "/proc",
                    "--dev",
                    "/dev",
                    "--bind",
                    flow.Temp.Root,
                    flow.Temp.Root
                }
                if missing {
                    let systemBin = Directory.ResolveLinkTarget("/bin", true)?.FullName ?? "/bin"
                    args.AddRange([]string{"--tmpfs", "/usr/bin"})
                    if systemBin != "/usr/bin" {
                        args.AddRange([]string{"--tmpfs", systemBin})
                    }
                    for tool in[]string{"bash", "env", "git", "setsid", "unshare"} {
                        args.AddRange(
                            []string{"--ro-bind", TestProcess.SystemPath("/usr/bin/" + tool), "/usr/bin/" + tool}
                        )
                    }
                    args.AddRange([]string{"--symlink", "bash", "/usr/bin/sh"})
                    if systemBin != "/usr/bin" {
                        args.AddRange([]string{"--symlink", "/usr/bin/sh", Path.Combine(systemBin, "sh")})
                    }
                } else {
                    args.AddRange([]string{"--ro-bind", broken, "/usr/bin/bwrap"})
                }
                args.AddRange(
                    []string{"--", binary, "recover", "--run", run, "--commit", commit, "--seconds", "30", "--json"}
                )
                let result = TestProcess.Run("/usr/bin/bwrap", args.ToArray(), flow.Temp.Env)
                Check.Envelope(result, "recover", "error", missing ? "missing_tools": "verification_failed")
                if missing {
                    Check.Contains(result.Error, "/usr/bin/bwrap: missing")
                } else {
                    let record = Check.Json(File.ReadAllText(Path.Combine(run, "correction.json")))
                    let checks = record["verification"]?.AsArray() ?? JsonArray()
                    if checks.Count > 0 {
                        Check.Contains(
                            Check.Text(checks[checks.Count - 1]?["error"]),
                            "synthetic sandbox startup failure"
                        )
                    }
                }
                Check.That(!File.Exists(marker), "Repository verification ran without its required sandbox")
                Check.That(
                    Directory.GetFileSystemEntries(storage).Length == 0,
                    "Runtime copies leaked after sandbox startup failure"
                )
                flow.Reload()
                Check.That(Check.Text(flow.State["exec_count"]) == "1", "Sandbox startup failure repeated inference")
                flow.NoPr()
            }
            Console.WriteLine(
                "PASS CLI recovery refuses missing or unusable verification sandbox without running repository code or leaking runtime copies"
            )
        }

        internal func RuntimeFilesParent(binary string, mode string) {
            using let flow = NativeFixture(binary)
            flow.Initialize()
            flow.VerificationPolicy(
                "set -eu; test \"$$(cat /etc/resolv.conf)\" = synthetic-runtime-dns; test \"$$(stat -c '%a %h' /etc/resolv.conf)\" = '600 1'; if printf tampered >> /etc/resolv.conf; then exit 1; fi; bwrap --unshare-user --unshare-pid --ro-bind / / --proc /proc --ro-bind /etc/resolv.conf /etc/resolv.conf -- /bin/sh -c 'test \"$$(cat /etc/resolv.conf)\" = synthetic-runtime-dns'; printf nested-runtime-verified"
            )
            flow.Approve()
            let run = flow.Claim()
            let storage = Environment.GetEnvironmentVariable("TMPDIR") ?? throw Exception("Missing runtime storage")
            flow.Temp.Env["TMPDIR"] = storage
            let source = Path.Combine(Path.GetDirectoryName(storage) ?? "", "dns-source")
            if mode == "replace" {
                File.WriteAllText(source + "-next", "synthetic-replacement-dns\n")
                File.Move(source + "-next", source, true)
            } else if mode == "unlink" {
                File.Delete(source)
            }
            if mode == "oversize" {
                Check.Contains(flow.Call([]string{"work", "--run", run}, 1).Error, "4 MiB runtime-file limit")
                flow.NoPr()
            } else {
                flow.Call([]string{"work", "--run", run})
                Check.Contains(File.ReadAllText(Path.Combine(run, "verification.json")), "nested-runtime-verified")
                Check.That(
                    File.ReadAllText("/etc/resolv.conf") == "synthetic-runtime-dns\n",
                    "Mounted parent DNS changed"
                )
            }
            Check.That(
                Directory.GetFileSystemEntries(storage).Length == 0,
                "Runtime copies leaked after CLI completion"
            )
        }

        private func Alternatives(binary string) {
            using let flow = NativeFixture(binary)
            flow.Initialize()
            flow.VerificationPolicy(
                "set -eu; /usr/bin/awk 'BEGIN { print \"standard-tool-started\" }'; test ! -e /etc/private; if : > /etc/alternatives/unwanted; then exit 1; fi"
            )
            flow.Approve()
            let run = flow.Claim()
            let alternatives = Path.Combine(flow.Temp.Root, "alternatives")
            Directory.CreateDirectory(alternatives)
            File.CreateSymbolicLink(Path.Combine(alternatives, "awk"), "/usr/bin/awk-real")
            let sentinel = Path.Combine(flow.Temp.Root, "system-sentinel")
            File.WriteAllText(sentinel, "synthetic-system-secret")
            let args = List[string]{
                "--die-with-parent",
                "--unshare-user",
                "--unshare-pid",
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
                flow.Temp.Root,
                flow.Temp.Root,
                "--tmpfs",
                "/etc",
                "--ro-bind",
                alternatives,
                "/etc/alternatives",
                "--ro-bind",
                sentinel,
                "/etc/private",
                "--tmpfs",
                "/usr/bin"
            }
            if File.Exists("/etc/ld.so.cache") {
                args.AddRange([]string{"--ro-bind", "/etc/ld.so.cache", "/etc/ld.so.cache"})
            }
            for tool in[]string{"bash", "git", "env", "bwrap", "setsid", "unshare", "cp"} {
                args.AddRange([]string{"--ro-bind", "/usr/bin/" + tool, "/usr/bin/" + tool})
            }
            args.AddRange(
                []string{
                    "--symlink",
                    "bash",
                    "/usr/bin/sh",
                    "--ro-bind",
                    "/usr/bin/awk",
                    "/usr/bin/awk-real",
                    "--symlink",
                    "/etc/alternatives/awk",
                    "/usr/bin/awk",
                    "--",
                    binary,
                    "work",
                    "--run",
                    run
                }
            )
            Check.Success(TestProcess.Run("/usr/bin/bwrap", args.ToArray(), flow.Temp.Env))
            Check.Contains(File.ReadAllText(Path.Combine(run, "verification.json")), "standard-tool-started")
            Check.That(File.ReadAllText(sentinel) == "synthetic-system-secret", "Verification changed system sentinel")
            Console.WriteLine(
                "PASS CLI verification starts system alternatives without exposing unrelated configuration"
            )
        }
    }
}

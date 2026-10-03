package TokateTests

import System
import System.Collections.Generic
import System.IO
import System.Text.Json
import Tokate

internal class ProtectedPathChecks {
    shared {
        internal func Refused(action Action, expected string = "") {
            var refused bool
            try {
                action()
            } catch (error Exception) {
                if expected != "" {
                    Check.Contains(error.Message, expected)
                }
                refused = true
            }
            Check.That(refused, "Protected path or incomplete evidence was accepted")
        }

        private func PolicyText(version int32, paths Object?) string -> J.Write(
            J.Map(
                "version",
                version,
                "models",
                J.Map("fixture", []string{"high"}),
                "max_seconds",
                30,
                "allow_network",
                false,
                "verification",
                []Object{[]string{"/bin/true"}},
                "required_checks",
                []string{"verify"},
                "allowed_tools",
                []Object{J.Map("harness", "codex", "provider", "openai")},
                "protected_paths",
                paths
            )
        )

        internal func Policies() {
            for version in[]int32{1, 2} {
                let valid = List[string]()
                for i in 0 ... 64 {
                    valid.Add(i == 0 ? String('x', 512): "scripts/check-" + i.ToString() + "/")
                }
                Policy(PolicyText(version, valid))
                Policy(PolicyText(version, []string{}))
                for value in[]Object{
                    64,
                    "scripts/verify.sh",
                    []Object{true},
                    []Object? {nil},
                    []string{String('x', 513)}
                } {
                    Refused(
                        () -> {
                            Policy(PolicyText(version, value))
                        }
                    )
                }
                valid.Add("extra")
                Refused(
                    () -> {
                        Policy(PolicyText(version, valid))
                    }
                )
                Refused(
                    () -> {
                        Policy(PolicyText(version, nil))
                    }
                )
                for path in[]string{
                    "",
                    "/",
                    "/scripts/verify.sh",
                    "C:/verify.sh",
                    "scripts\\verify.sh",
                    "a\0b",
                    "a\nb",
                    "a\rb",
                    "a\tb",
                    "a\u007fb",
                    "a\u0085b",
                    ".",
                    "..",
                    "./a",
                    "a/./b",
                    "a/../b",
                    "a//b",
                    "a//",
                    "a/./",
                    "a/../"
                } {
                    Refused(
                        () -> {
                            Policy(PolicyText(version, []string{path}))
                        }
                    )
                }
                let text = PolicyText(
                    version,
                    []string{"scripts/verify.sh", "scripts/checks/", "literal*", "quoted\" ", "é"}
                )
                let policy = Policy(text)
                Check.That(policy.Digest == Data.Hash(text), "Protected paths changed the digest binding")
                for path in[]string{
                    "scripts/verify.sh",
                    "scripts/checks",
                    "scripts/checks/line\n\".sh",
                    "literal*",
                    "quoted\" ",
                    "é",
                    ".github/workflows",
                    ".github/workflows/line\n.yml",
                    ".github/tokate-other"
                } {
                    Refused(() -> ProtectedPaths.Check(policy.Value, path), "protected owner")
                }
                for path in[]string{
                    "scripts/verify.sh-old",
                    "scripts/checks-old/a",
                    "Scripts/verify.sh",
                    "literal-file",
                    "e\u0301"
                } {
                    ProtectedPaths.Check(policy.Value, path)
                }
            }
            Console.WriteLine("PASS v1/v2 protected path policy bounds, literal matching, and digest binding")
        }

        private func Git(temp Temp, checkout string, args ...string) string {
            let all = List[string]{"-C", checkout, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test"}
            all.AddRange(args)
            return Check.Success(Check.Run("/usr/bin/git", all.ToArray(), temp.Env))
        }

        private func LocalRefused(checkout string, policy JsonElement, base string, head string = "") {
            var refused bool
            try {
                ProtectedPaths.Local(checkout, policy, base, head)
            } catch (error Exception) {
                Check.Contains(error.Message, "protected owner")
                refused = true
            }
            Check.That(refused, "Protected local edit was accepted")
        }

        internal func LocalDiffs() {
            for mode in[]string{
                "content",
                "addition",
                "deletion",
                "mode",
                "type",
                "rename-out",
                "rename-in",
                "directory-node",
                "workflow-node",
                "quoted",
                "newline",
                "bom",
                "permitted"
            } {
                using let temp = Temp()
                let checkout = Path.Combine(temp.Root, "checkout")
                Directory.CreateDirectory(Path.Combine(checkout, "scripts/checks"))
                Directory.CreateDirectory(Path.Combine(checkout, ".github/workflows"))
                File.WriteAllText(Path.Combine(checkout, "scripts/verify.sh"), "exit 1\n")
                File.WriteAllText(Path.Combine(checkout, "scripts/checks/original"), "original\n")
                File.WriteAllText(Path.Combine(checkout, "scripts/quoted\" "), "quoted\n")
                File.WriteAllText(Path.Combine(checkout, "ordinary"), "ordinary\n")
                File.WriteAllText(Path.Combine(checkout, "\uFEFFprotected"), "BOM name\n")
                File.WriteAllText(Path.Combine(checkout, ".github/workflows/verify.yml"), "workflow\n")
                Git(temp, checkout, "init", "--quiet", "--template=")
                Git(temp, checkout, "add", "-A")
                Git(temp, checkout, "commit", "--quiet", "-m", "Base")
                let base = Git(temp, checkout, "rev-parse", "HEAD")
                let policy = Policy(
                    PolicyText(
                        1,
                        []string{"scripts/verify.sh", "scripts/checks/", "scripts/quoted\" ", "\uFEFFprotected"}
                    )
                ).Value
                switch mode {
                    case "content" {
                        File.WriteAllText(Path.Combine(checkout, "scripts/verify.sh"), "exit 0\n")
                    }
                    case "addition" {
                        File.WriteAllText(Path.Combine(checkout, "scripts/checks/added"), "new\n")
                    }
                    case "deletion" {
                        File.Delete(Path.Combine(checkout, "scripts/verify.sh"))
                    }
                    case "mode" {
                        File.SetUnixFileMode(
                            Path.Combine(checkout, "scripts/verify.sh"),
                            UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute
                        )
                    }
                    case "type" {
                        File.Delete(Path.Combine(checkout, "scripts/verify.sh"))
                        File.CreateSymbolicLink(Path.Combine(checkout, "scripts/verify.sh"), "../ordinary")
                    }
                    case "rename-out" {
                        Git(temp, checkout, "mv", "scripts/checks/original", "moved")
                    }
                    case "rename-in" {
                        Git(temp, checkout, "mv", "ordinary", "scripts/checks/moved")
                    }
                    case "directory-node" {
                        Directory.Delete(Path.Combine(checkout, "scripts/checks"), true)
                        File.WriteAllText(Path.Combine(checkout, "scripts/checks"), "replacement\n")
                    }
                    case "workflow-node" {
                        Directory.Delete(Path.Combine(checkout, ".github/workflows"), true)
                        File.WriteAllText(Path.Combine(checkout, ".github/workflows"), "replacement\n")
                    }
                    case "quoted" {
                        File.AppendAllText(Path.Combine(checkout, "scripts/quoted\" "), "changed\n")
                    }
                    case "newline" {
                        File.WriteAllText(Path.Combine(checkout, "scripts/checks/line\n\".sh"), "new\n")
                    }
                    case "bom" {
                        File.AppendAllText(Path.Combine(checkout, "\uFEFFprotected"), "changed\n")
                    }
                    case "permitted" {
                        Directory.CreateDirectory(Path.Combine(checkout, "scripts/checks-old"))
                        File.WriteAllText(Path.Combine(checkout, "scripts/checks-old/line\n\" "), "permitted\n")
                    }
                }
                Git(temp, checkout, "add", "-A")
                if mode == "permitted" {
                    ProtectedPaths.Local(checkout, policy, base)
                } else {
                    LocalRefused(checkout, policy, base)
                }
                Git(temp, checkout, "commit", "--quiet", "-m", mode)
                let head = Git(temp, checkout, "rev-parse", "HEAD")
                if mode == "permitted" {
                    ProtectedPaths.Local(checkout, policy, base, head)
                } else {
                    LocalRefused(checkout, policy, base, head)
                }
            }
            Console.WriteLine(
                "PASS staged and committed protected edits, rename endpoints, modes/types, directory replacement and raw Git names"
            )
        }

        internal func All() {
            Policies()
            LocalDiffs()
        }
    }
}

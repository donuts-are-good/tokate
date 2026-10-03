package TokateTests

import Gsharp.Concurrency
import System
import System.Collections.Generic
import System.Diagnostics
import System.Globalization
import System.IO
import System.Security.Cryptography
import System.Text
import System.Text.Json.Nodes

internal class Fixture {
    internal let Root string
    internal let StatePath string
    internal var State JsonNode
    internal let Env Dictionary[string, string] = Dictionary[string, string]()
    internal var Include bool
    internal var Verb string = ""
    internal var Conditional string = ""
    internal var ApiPath string = ""

    internal init(root string) {
        Root = root
        StatePath = Path.Combine(root, "state.json")
        State = Check.Json(File.ReadAllText(StatePath))
        Env["PATH"] = root + ":/usr/bin:/bin"
        Env["HOME"] = Path.Combine(Path.GetDirectoryName(root) ?? "", "home")
        Env["GIT_CONFIG_NOSYSTEM"] = "1"
        for prefix in[]string{"GIT_AUTHOR_", "GIT_COMMITTER_"} {
            Env[prefix + "NAME"] = "Fixture"
            Env[prefix + "EMAIL"] = "fixture@example.test"
        }
    }

    internal func Save() -> File.WriteAllText(StatePath, State.ToJsonString())

    internal func Answer(value JsonNode) int32 {
        if Include {
            let etag = "\"" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value.ToJsonString()))) + "\""
            let initial = State["etag_initial"] == nil ? Check.Text(State["etag_initial_prefix"]) + etag:
            Check.Text(State["etag_initial"])
            let returned = State["etag_returned"] == nil ? Check.Text(State["etag_returned_prefix"]) + etag:
            Check.Text(State["etag_returned"])
            let calls = State["api_calls"]?.AsArray() ?? throw Exception("Missing traffic records")
            var reads int32
            for call in calls {
                if Check.Text(call["method"]) == "GET" && Check.Text(call["path"]) == ApiPath {
                    reads++
                }
            }
            let unchanged = Verb == "GET" &&
                (
                Conditional == "If-None-Match: " +
                    initial ||
                    (Check.Text(State["etag_force_304"]) == "true" && reads > 1)
            )
            if unchanged && Check.Text(State["mode"]).StartsWith("after_304_") {
                let issue = State["issue"] ?? throw Exception("Missing issue")
                if Check.Text(State["mode"]) == "after_304_edit" {
                    issue["title"] = JsonValue.Create("Edited after live revalidation")
                } else {
                    issue["labels"] = JsonArray()
                }
                State["mode"] = JsonValue.Create("")
            }
            let validator = unchanged ? returned: initial
            let current = calls[calls.Count - 1] ?? throw Exception("Missing traffic entry")
            current["etag"] = JsonValue.Create(validator)
            return Response(
                unchanged ? 304: 200,
                unchanged ? nil: value,
                validator == "" ? "": "ETag: " + validator + "\r\n"
            )
        }
        Save()
        Console.WriteLine(value.ToJsonString())
        return 0
    }

    internal func Response(status int32, value JsonNode? = nil, headers string = "") int32 {
        let calls = State["api_calls"]?.AsArray() ?? throw Exception("Missing traffic records")
        let call = calls[calls.Count - 1] ?? throw Exception("Missing traffic entry")
        call["status"] = JsonValue.Create(status)
        Save()
        Console.Write("HTTP/2.0 " + status.ToString() + " Synthetic\r\n")
        Console.Write("Date: " + DateTimeOffset.UtcNow.ToString("r", CultureInfo.InvariantCulture) + "\r\n")
        Console.Write("X-Poll-Interval: 2\r\nX-Synthetic-Ignored: synthetic-response-secret\r\n" + headers + "\r\n")
        if value != nil {
            Console.WriteLine(value.ToJsonString())
        }
        if status >= 400 || status == 304 {
            Console.Error.WriteLine("gh: synthetic-response-secret (HTTP " + status.ToString() + ")")
            return 1
        }
        return 0
    }

    internal func Git(repo string, args[]string, input string? = nil) string {
        let all = List[string]{"-C", Path.Combine(Root, repo)}
        all.AddRange(args)
        return Check.Success(Check.Run("/usr/bin/git", all.ToArray(), Env, input))
    }

    internal func Codex(args[]string) int32 {
        Check.That(
            Environment.GetEnvironmentVariable("CODEX_HOME") == Path.Combine(
                Path.GetDirectoryName(Root) ?? "",
                "codex-home"
            ),
            "Harness home was lost"
        )
        for key in[]string{
            "GH_TOKEN",
            "GITHUB_TOKEN",
            "GH_CONFIG_DIR",
            "XDG_CONFIG_HOME",
            "DBUS_SESSION_BUS_ADDRESS",
            "XDG_RUNTIME_DIR"
        } {
            Check.That(Environment.GetEnvironmentVariable(key) == nil, "GitHub authentication reached Codex: " + key)
        }
        if args[0] == "--version" {
            Console.WriteLine("codex-cli 0.159.3")
            return 0
        }
        if args[0] == "login" {
            Check.That(args.Length == 2 && args[1] == "status", "Unexpected login operation")
            Check.Contains(
                File.ReadAllText(Path.Combine(Environment.GetEnvironmentVariable("CODEX_HOME") ?? "", "identity")),
                "ChatGPT"
            )
            Console.WriteLine("Logged in using ChatGPT")
            return 0
        }
        if args[0] == "sandbox" {
            Check.That(Array.IndexOf(args, "permissions.tokate.network.enabled=false") >= 0, "Network must be disabled")
            if Array.IndexOf(args, "probe") >= 0 {
                if Check.Text(State["mode"]) == "unsupported_sandbox" {
                    return 1
                }
                let checkout = args[Array.IndexOf(args, "-C") + 1]
                if File.Exists(Path.Combine(checkout, "global.json")) {
                    let result = Check.Run(
                        "/usr/bin/dotnet",
                        []string{"msbuild", "-nologo", "-version"},
                        Env,
                        cwd: checkout
                    )
                    Console.Write(result.Output)
                    Console.Error.Write(result.Error)
                    return result.Code
                }
                return 0
            }
            throw Exception("Only the unchanged managed preflight may use the fixture sandbox")
        }
        Check.That(args[0] == "exec", "Expected exec")
        Check.That(Environment.GetEnvironmentVariable("GH_TOKEN") == nil, "GitHub credential reached agent")
        Check.That(Environment.GetEnvironmentVariable("OPENAI_API_KEY") == nil, "API credential reached agent")
        for required in[]string{
            "--strict-config",
            "--ignore-user-config",
            "--ignore-rules",
            "approval_policy=\"never\"",
            "shell_environment_policy.set={ PATH = \"/usr/local/bin:/usr/bin:/bin\", HOME = \"/tmp/tokate-home\", TMPDIR = \"/tmp/tokate-home\" }"
        } {
            Check.That(Array.IndexOf(args, required) >= 0, "Missing boundary: " + required)
        }
        var filesystem bool
        for arg in args {
            if arg.Contains(":root") && arg.Contains("deny") && arg.Contains(".git") {
                filesystem = true
            }
        }
        Check.That(filesystem, "Missing filesystem boundary")
        Check.Contains(Console.In.ReadToEnd(), "Acceptance criteria addressed")
        let count = Check.Text(State["exec_count"])
        State["exec_count"] = JsonValue.Create(count == "" ? 1: Int32.Parse(count) + 1)
        Save()
        let mode = Check.Text(State["mode"])
        if mode == "temporary_isolation" {
            let sentinel = Check.Text(State["temporary_sentinel"])
            Check.That(!File.Exists(sentinel), "Host temporary file reached the managed namespace")
            File.WriteAllText(sentinel, "private agent temporary data")
        }
        if mode == "timeout" || mode == "background" {
            using let child = Process.Start("/usr/bin/sleep", "120") ?? throw Exception("Cannot start timeout fixture")
            File.WriteAllText(Path.Combine(Root, "child.pid"), child.Id.ToString())
            if mode == "timeout" {
                child.WaitForExit()
            }
        }
        if mode == "revoke" {
            let issue = State["issue"] ?? throw Exception("Missing issue")
            issue["labels"] = JsonArray()
            Save()
        }
        let checkout = args[Array.IndexOf(args, "--cd") + 1]
        if mode == "verification_recovery" {
            Directory.CreateDirectory(Path.Combine(checkout, ".tokate-scratch"))
            File.WriteAllText(Path.Combine(checkout, ".tokate-scratch/cache.json"), "unformatted browser cache")
            Directory.CreateDirectory(Path.Combine(checkout, ".git/info"))
            File.AppendAllText(Path.Combine(checkout, ".git/info/exclude"), "\n.tokate-scratch/\n")
        }
        if mode == "verification_boundary" {
            File.WriteAllText("/tmp/tokate-home/agent-cache.json", "unformatted cache")
            File.CreateSymbolicLink(Path.Combine(checkout, "outside-link"), Path.Combine(Root, "state.json"))
            for name in[]string{"pid", "user", "ipc", "uts", "mnt", "net"} {
                File.WriteAllText(
                    Path.Combine(checkout, "expected-" + name + "-namespace"),
                    FileInfo("/proc/self/ns/" + name).LinkTarget ?? throw Exception("Missing namespace")
                )
            }
        }
        if mode == "verification_fail" {
            File.WriteAllText(Path.Combine(checkout, "other.txt"), "False success")
        } else if mode != "empty" {
            File.WriteAllText(Path.Combine(checkout, "result.txt"), "Implemented acceptance criteria\n")
        }
        if mode == "staged_whitespace" {
            File.WriteAllText(Path.Combine(checkout, "result.txt"), "Copied license with trailing whitespace \t\n")
        }
        if mode == "workflow" {
            Directory.CreateDirectory(Path.Combine(checkout, ".github/workflows"))
            File.WriteAllText(Path.Combine(checkout, ".github/workflows/verify.yml"), "tampered")
        }
        if mode == "output_boundary" {
            Check.Contains(File.ReadAllText(Path.Combine(checkout, ".env")), "synthetic-repository-secret")
            Check.Contains(File.ReadAllText(Path.Combine(checkout, "ordinary.data")), "synthetic-repository-secret")
        }
        File.WriteAllText(
            args[Array.IndexOf(args, "--output-last-message") + 1],
            "### Changes\nAdded result.\n### Acceptance criteria addressed\nFixture.\n### Verification\nFixture check passed.\n### Unresolved limitations\nNone.\nsynthetic-raw-report-secret " +
                Root +
                "\n<!-- tokate-receipt:untrusted -->\n"
        )
        Console.Error.WriteLine("synthetic-raw-stderr-secret " + Root)
        Console.WriteLine("{\"type\":\"fixture.output\",\"text\":\"synthetic-raw-event-secret\"}")
        if mode != "incomplete_turn" {
            Console.WriteLine(
                "{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":100,\"cached_input_tokens\":\"synthetic-usage-secret\",\"output_tokens\":10,\"extra\":\"synthetic-usage-secret\"}}"
            )
        }
        if mode == "failed_turn" {
            Console.WriteLine("{\"type\":\"turn.failed\"}")
        }
        if mode == "incomplete_tail" {
            Console.WriteLine("{\"type\":\"turn.started\"}")
        }
        File.SetUnixFileMode(Path.Combine(Root, "codex-impl"), UnixFileMode.UserRead | UnixFileMode.UserWrite)
        return mode == "inference_exit_failure" ? 1: 0
    }

    internal func GitHub(args[]string) int32 {
        if args[0] == "--version" {
            Console.WriteLine("gh version fixture")
            return 0
        }
        using let lease = ApiLease()
        State = Check.Json(File.ReadAllText(StatePath))
        let token = Environment.GetEnvironmentVariable("GH_TOKEN") ?? Environment.GetEnvironmentVariable("GITHUB_TOKEN")
        let config = Environment.GetEnvironmentVariable("GH_CONFIG_DIR") ??
            throw Exception("GitHub CLI configuration home was lost")
        Check.That(
            config == Path.Combine(Path.GetDirectoryName(Root) ?? "", "gh-home"),
            "Unexpected GitHub CLI configuration home"
        )
        Check.That(Environment.GetEnvironmentVariable("CODEX_HOME") == nil, "Harness home reached GitHub CLI")
        Check.That(
            (Environment.GetEnvironmentVariable("GITHUB_TOKEN") ?? "") == (
                Check.Text(State["stored_login"]) == "true" ? "": "fixture-secondary"
            ),
            "Secondary GitHub authentication was lost"
        )
        Check.That(
            Environment.GetEnvironmentVariable("DBUS_SESSION_BUS_ADDRESS") == "unix:path=/synthetic/keyring-bus",
            "Keyring interface was lost"
        )
        Check.That(
            Environment.GetEnvironmentVariable("XDG_CONFIG_HOME") != nil && Environment.GetEnvironmentVariable(
                "XDG_RUNTIME_DIR"
            ) != nil,
            "GitHub configuration/keyring paths were lost"
        )
        let actor = token == nil ? File.ReadAllText(Path.Combine(config, "identity")): (
            token == "fixture-owner" ? "owner": "donor"
        )
        if args[0] == "auth" {
            Check.That(
                args.Length == 3 && args[1] == "git-credential" && args[2] == "get",
                "Unexpected authentication operation"
            )
            Check.Contains(Console.In.ReadToEnd(), "host=github.com")
            State["helper_used"] = JsonValue.Create(true)
            Save()
            Console.Write("username=fixture\npassword=synthetic-gh-credential\n\n")
            return 0
        }
        if args[0] == "pr" && args[1] == "checks" {
            return Answer(State["checks"] ?? JsonArray())
        }
        Check.That(args[0] == "api", "Expected GitHub API")
        Include = Array.IndexOf(args, "--include") >= 0
        Check.That(Include, "API must include response status and headers")
        let method = args[Array.IndexOf(args, "--method") + 1]
        let path = args[Array.IndexOf(args, "--method") + 2]
        ApiPath = path
        Verb = method
        let header = Array.IndexOf(args, "-H")
        Conditional = header >= 0 ? args[header + 1]: ""
        let calls = State["api_calls"]?.AsArray() ?? JsonArray()
        let call = Check.Map("method", method, "path", path, "conditional", Conditional != "", "validator", Conditional)
        call["start"] = JsonValue.Create(Stopwatch.GetTimestamp())
        calls.Add(call)
        State["api_calls"] = calls
        Save()
        if path == Check.Text(State["fault_path"]) {
            let faults = State["faults"]?.AsArray() ?? JsonArray()
            let index = Int32.Parse(Check.Text(State["fault_index"] ?? JsonValue.Create(0)))
            if index < faults.Count {
                let fault = faults[index] ?? throw Exception("Missing fault")
                State["fault_index"] = JsonValue.Create(index + 1)
                Save()
                let pause = Check.Text(fault["pause_ms"])
                if pause != "" {
                    select {
                        case <- after(TimeSpan.FromMilliseconds(Int32.Parse(pause))) { }
                    }
                }
                let status = Int32.Parse(Check.Text(fault["status"]))
                if status == 0 {
                    Console.Error.WriteLine("synthetic-response-secret HTTP 404 in an unauthoritative transport error")
                    return 1
                }
                return Response(
                    status,
                    Check.Map("message", Check.Text(fault["message"])),
                    Check.Text(fault["headers"])
                )
            }
        }
        let body = Array.IndexOf(args, "--input") >= 0 ? Check.Json(Console.In.ReadToEnd()): Check.Json("{}")
        if path == "user" {
            return Answer(
                Check.Map(
                    "login",
                    State["viewer_login"] ?? JsonValue.Create(actor) as JsonNode,
                    "id",
                    State["viewer_id"] ?? JsonValue.Create(123) as JsonNode
                )
            )
        }
        if path.StartsWith("repos/obselate/tokate/releases/tags/") {
            if let release = State["release"] {
                return Answer(release)
            }
            return Response(404)
        }
        let parts = path.Split('/')
        Check.That(parts[0] == "repos", "Expected repository API")
        let repo = parts[1] + "/" + parts[2]
        let folder = repo == "owner/project" ? "upstream": "fork"
        let tail = String.Join("/", parts, 3, parts.Length - 3)
        if tail == "" {
            if folder == "fork" && Check.Text(State["missing_fork"]) == "true" {
                return Response(404)
            }
            return Answer(
                Check.Map(
                    "default_branch",
                    "main",
                    "id",
                    folder == "fork" ? 2: 1,
                    "full_name",
                    repo,
                    "owner",
                    Check.Map("login", parts[1], "id", folder == "fork" ? 123: 1),
                    "permissions",
                    Check.Map("push", actor == parts[1]),
                    "parent",
                    Check.Map("full_name", "owner/project")
                )
            )
        }
        if tail.StartsWith("issues/comments/") {
            return Answer(State["comments"]?[tail.Substring(16)] ?? throw Exception("Missing canonical comment"))
        }
        if tail.StartsWith("compare/") {
            let comparison = tail.Substring(8).Split("...")
            let sha = comparison[1].Split(':')[1]
            Git("upstream", []string{"fetch", Path.Combine(Root, "fork"), sha})
            let names = Git("upstream", []string{"diff", "--name-only", comparison[0], sha})
            let files = JsonArray()
            for file in names.Split('\n') {
                if file != "" {
                    files.Add(Check.Map("filename", file))
                }
            }
            return Answer(Check.Map("status", "ahead", "files", files))
        }
        if tail.StartsWith("commits/") {
            return Answer(Check.Map("sha", Git(folder, []string{"rev-parse", tail.Substring(8)})))
        }
        if tail.StartsWith("contents/") {
            let split = tail.IndexOf("?ref=")
            let file = tail.Substring(9, split - 9)
            let reference = Uri.UnescapeDataString(tail.Substring(split + 5))
            var content string
            try {
                content = Git(folder, []string{"show", reference + ":" + file})
            } catch (error Exception) {
                return Response(404)
            }
            return Answer(
                Check.Map("encoding", "base64", "content", Convert.ToBase64String(Encoding.UTF8.GetBytes(content)))
            )
        }
        if tail.StartsWith("issues/") {
            let issue = State["issue"] ?? throw Exception("Missing issue")
            if tail.Contains("/comments?") && method == "GET" {
                let comments = JsonArray()
                if let saved = State["comments"] {
                    for comment in saved.AsObject() {
                        comments.Add(comment.Value?.DeepClone())
                    }
                }
                return Answer(comments)
            }
            if tail.EndsWith("/comments") && method == "POST" {
                if Check.Text(State["mode"]) == "request_fail_before_write" {
                    return Response(500)
                }
                State["posted_request"] = body.DeepClone()
                let count = State["request_count"] == nil ? 1: Int32.Parse(Check.Text(State["request_count"])) + 1
                State["request_count"] = JsonValue.Create(count)
                let comment = Check.Map(
                    "id",
                    100 + count,
                    "body",
                    Check.Text(body["body"]),
                    "user",
                    Check.Map("login", actor, "id", 123),
                    "issue_url",
                    "https://api.github.com/repos/owner/project/issues/1"
                )
                let comments = State["comments"] ?? JsonObject()
                comments[(100 + count).ToString()] = comment.DeepClone()
                State["comments"] = comments
                if Check.Text(State["mode"]) == "request_fail_after_write" {
                    return Response(500)
                }
                return Answer(comment)
            }
            if method != "GET" {
                if tail.EndsWith("/assignees") {
                    let people = issue["assignees"]?.AsArray() ?? JsonArray()
                    let requested = body["assignees"]?.AsArray() ?? JsonArray()
                    if method == "DELETE" {
                        var index = people.Count - 1
                        while index >= 0 {
                            for person in requested {
                                if Check.Text(people[index]?["login"]) == Check.Text(person) {
                                    people.RemoveAt(index)
                                    break
                                }
                            }
                            index--
                        }
                    } else if Check.Text(State["unassignable"]) != "true" {
                        for person in requested {
                            var found bool
                            for existing in people {
                                if Check.Text(existing["login"]) == Check.Text(person) {
                                    found = true
                                }
                            }
                            if !found {
                                people.Add(Check.Map("login", Check.Text(person)))
                            }
                        }
                    }
                } else if tail.EndsWith("/labels") {
                    let labels = JsonArray()
                    for label in body["labels"]?.AsArray() ?? JsonArray() {
                        labels.Add(Check.Map("name", Check.Text(label)))
                    }
                    issue["labels"] = labels
                } else if method == "DELETE" {
                    issue["labels"] = JsonArray()
                }
            }
            return Answer(issue)
        }
        if tail.StartsWith("labels") {
            return Answer(Check.Map("name", "tokate:approved"))
        }
        if tail.StartsWith("git/ref/heads/") {
            var sha string
            try {
                sha = Git(folder, []string{"rev-parse", "--verify", "refs/heads/" + tail.Substring(14)})
            } catch (error Exception) {
                return Response(404)
            }
            return Answer(Check.Map("object", Check.Map("sha", sha)))
        }
        if tail.StartsWith("git/commits/") {
            let parents = JsonArray()
            let line = Git(folder, []string{"rev-list", "--parents", "-n", "1", tail.Substring(12)}).Split(' ')
            for i in 1 ... line.Length {
                parents.Add(Check.Map("sha", line[i]))
            }
            return Answer(
                Check.Map(
                    "tree",
                    Check.Map("sha", Git(folder, []string{"rev-parse", tail.Substring(12) + "^{tree}"})),
                    "parents",
                    parents
                )
            )
        }
        if tail == "git/trees" {
            Env["GIT_INDEX_FILE"] = Path.Combine(Root, "tree.index")
            Git(
                folder,
                body["base_tree"] == nil ? []string{"read-tree", "--empty"}:
                []string{"read-tree", Check.Text(body["base_tree"])}
            )
            for item in body["tree"]?.AsArray() ?? JsonArray() {
                let sha = Git(folder, []string{"hash-object", "-w", "--stdin"}, Check.Text(item["content"]))
                Git(
                    folder,
                    []string{"update-index", "--add", "--cacheinfo", "100644," + sha + "," + Check.Text(item["path"])}
                )
            }
            return Answer(Check.Map("sha", Git(folder, []string{"write-tree"})))
        }
        if tail == "git/commits" {
            let command = List[string]{"commit-tree", Check.Text(body["tree"])}
            for parent in body["parents"]?.AsArray() ?? JsonArray() {
                command.Add("-p")
                command.Add(Check.Text(parent))
            }
            return Answer(Check.Map("sha", Git(folder, command.ToArray(), Check.Text(body["message"]))))
        }
        if tail == "git/refs" {
            try {
                Git(folder, []string{"update-ref", Check.Text(body["ref"]), Check.Text(body["sha"]), String('0', 40)})
            } catch (error Exception) {
                return Response(422)
            }
            return Answer(Check.Map("ref", Check.Text(body["ref"])))
        }
        if tail.StartsWith("git/refs/heads/") {
            let reference = "refs/heads/" + tail.Substring(15)
            if reference.StartsWith("refs/heads/tokate/contributions/") && Check.Text(
                State["mode"]
            ) == "interrupted_state_write" {
                return Response(500)
            }
            let previous = Git(folder, []string{"rev-parse", reference})
            try {
                Check.That(Check.Text(body["force"]) == "false", "Ref updates must never force")
                Git(folder, []string{"merge-base", "--is-ancestor", previous, Check.Text(body["sha"])})
                Git(folder, []string{"update-ref", reference, Check.Text(body["sha"]), previous})
            } catch (error Exception) {
                return Response(422)
            }
            if reference.StartsWith("refs/heads/tokate/contributions/") && Check.Text(
                State["mode"]
            ) == "lost_state_response" {
                State["mode"] = JsonValue.Create("")
                Save()
                Console.Error.WriteLine("Synthetic interrupted state response")
                return 1
            }
            return Answer(Check.Json("{}"))
        }
        if tail.StartsWith("pulls?") {
            let filter = Array.Find(
                tail.Substring(tail.IndexOf('?') + 1).Split('&'),
                field -> field.StartsWith("base=", StringComparison.Ordinal)
            ) ??
                ""
            let target = filter == "" ? "": Uri.UnescapeDataString(filter.Substring(5))
            let pulls = JsonArray()
            for pull in(State["pulls"] ?? JsonArray()).AsArray() {
                if target == "" || Check.Text(pull["base"]?["ref"]) == target {
                    pulls.Add(pull.DeepClone())
                }
            }
            return Answer(pulls)
        }
        if tail.StartsWith("pulls/") {
            return Answer(State["pulls"]?[0] ?? throw Exception("Missing PR"))
        }
        if tail == "pulls" {
            let count = State["pr_create_count"] == nil ? 1: Int32.Parse(Check.Text(State["pr_create_count"])) + 1
            State["pr_create_count"] = JsonValue.Create(count)
            if Check.Text(State["mode"]) == "pr_fail" {
                return Response(500)
            }
            let branch = Check.Text(body["head"]).Split(':')[1]
            body["number"] = JsonValue.Create(10)
            body["html_url"] = JsonValue.Create("https://github.com/owner/project/pull/10")
            body["state"] = JsonValue.Create("open")
            body["user"] = Check.Map("login", actor, "id", 123)
            body["head"] = Check.Map(
                "sha",
                Git("fork", []string{"rev-parse", branch}),
                "ref",
                branch,
                "repo",
                Check.Map("full_name", "donor/project", "owner", Check.Map("login", "donor", "id", 123))
            )
            body["base"] = Check.Map("ref", Check.Text(body["base"]))
            let pulls = State["pulls"]?.AsArray() ?? JsonArray()
            pulls.Add(body)
            State["pulls"] = pulls
            if Check.Text(State["mode"]) == "revoke_after_pr" {
                let issue = State["issue"] ?? throw Exception("Missing issue")
                issue["labels"] = JsonArray()
            }
            if Check.Text(State["mode"]) == "pr_fail_after_create" {
                Save()
                Console.Error.WriteLine("Synthetic lost PR response: synthetic-response-secret")
                return 1
            }
            return Answer(body)
        }
        throw Exception("Unhandled fixture API: " + path)
    }

    internal func ApiLease() FileStream {
        let deadline = DateTime.UtcNow.AddSeconds(30)
        while true {
            try {
                return File.Open(
                    Path.Combine(Root, "api.lock"),
                    FileMode.OpenOrCreate,
                    FileAccess.ReadWrite,
                    FileShare.None
                )
            } catch (error IOException) {
                if DateTime.UtcNow >= deadline {
                    throw error
                }
                select {
                    case <- after(TimeSpan.FromMilliseconds(10)) { }
                }
            }
        }
    }

    internal func Run(name string, args[]string) int32 {
        for key in[]string{
            "OPENAI_API_KEY",
            "UNRELATED_DONOR_VALUE",
            "GIT_CONFIG_COUNT",
            "GIT_CONFIG_KEY_0",
            "GIT_CONFIG_VALUE_0"
        } {
            Check.That(
                Environment.GetEnvironmentVariable(key) == nil,
                "Unrelated host value reached " + name + ": " + key
            )
        }
        if name.StartsWith("codex") {
            return Codex(args)
        }
        if name == "git" {
            let command = List[string]()
            for arg in args {
                if arg == "https://github.com/owner/project.git" {
                    command.Add(Path.Combine(Root, "upstream"))
                } else if arg == "https://github.com/donor/project.git" {
                    command.Add(Path.Combine(Root, "fork"))
                } else {
                    command.Add(arg == "protocol.file.allow=never" ? "protocol.file.allow=always": arg)
                }
            }
            let push = command.IndexOf("push")
            let correctionPath = Path.Combine(
                Path.GetDirectoryName(Directory.GetCurrentDirectory()) ?? "",
                "correction.json"
            )
            if Check.Text(State["mode"]).StartsWith("change_checked_") && command.Contains("rev-parse") &&
                command.Contains("HEAD") && File.Exists(correctionPath) {
                let correction = Check.Json(File.ReadAllText(correctionPath))
                if Check.Text(correction["state"]) == "verifying" &&
                    (correction["verification"]?.AsArray().Count ?? 0) > 0 {
                    let mode = Check.Text(State["mode"])
                    if mode == "change_checked_head" {
                        Check.Success(
                            Check.Run(
                                "/usr/bin/git",
                                []string{
                                    "-c",
                                    "core.hooksPath=/dev/null",
                                    "commit",
                                    "--allow-empty",
                                    "-m",
                                    "Concurrent head change"
                                },
                                Env
                            )
                        )
                    } else if mode == "change_checked_tree" {
                        File.AppendAllText("result.txt", "Concurrent tree change\n")
                        Check.Success(Check.Run("/usr/bin/git", []string{"add", "result.txt"}, Env))
                    } else {
                        File.AppendAllText(
                            Path.Combine(
                                Path.GetDirectoryName(correctionPath) ?? "",
                                "correction-" + Check.Text(correction["uuid"]),
                                "candidate.patch"
                            ),
                            "Changed complete patch\n"
                        )
                    }
                    State["mode"] = JsonValue.Create("")
                    Save()
                }
            }
            if push >= 0 {
                Check.That(
                    File.Exists(
                        Path.Combine(Path.GetDirectoryName(Directory.GetCurrentDirectory()) ?? "", "publication.json")
                    ),
                    "Publication content must be saved before push"
                )
                for key in[]string{
                    "GH_TOKEN",
                    "GITHUB_TOKEN",
                    "GH_CONFIG_DIR",
                    "XDG_CONFIG_HOME",
                    "DBUS_SESSION_BUS_ADDRESS",
                    "XDG_RUNTIME_DIR"
                } {
                    if let value = Environment.GetEnvironmentVariable(key) {
                        Env[key] = value
                    }
                }
                let credential = command.GetRange(0, push)
                credential.AddRange([]string{"credential", "fill"})
                Check.Contains(
                    Check.Success(
                        Check.Run("/usr/bin/git", credential.ToArray(), Env, "protocol=https\nhost=github.com\n\n")
                    ),
                    "password=synthetic-gh-credential"
                )
                if Check.Text(State["mode"]) == "push_fail" {
                    Console.Error.WriteLine("Synthetic push failure: synthetic-raw-push-secret")
                    return 1
                }
            } else {
                for key in[]string{
                    "GH_TOKEN",
                    "GITHUB_TOKEN",
                    "GH_CONFIG_DIR",
                    "CODEX_HOME",
                    "DBUS_SESSION_BUS_ADDRESS"
                } {
                    Check.That(
                        Environment.GetEnvironmentVariable(key) == nil,
                        "Authentication reached local Git: " + key
                    )
                }
            }
            let result = Check.Run("/usr/bin/git", command.ToArray(), Env)
            if push >= 0 && result.Code == 0 && Check.Text(State["mode"]) == "push_fail_after_write" {
                Console.Error.WriteLine("Synthetic lost push response")
                return 1
            }
            if push >= 0 && result.Code == 0 && Check.Text(State["mode"]) == "revoke_after_push" {
                let latest = Check.Json(File.ReadAllText(StatePath))
                let issue = latest["issue"] ?? throw Exception("Missing issue")
                issue["labels"] = JsonArray()
                File.WriteAllText(StatePath, latest.ToJsonString())
            }
            Console.Write(result.Output)
            Console.Error.Write(result.Error)
            return result.Code
        }
        return GitHub(args)
    }
}

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

internal partial class Fixture {
    internal func Answer(value JsonNode) int32 {
        let padding = Check.Text(State["response_padding"]?[ApiPath])
        if padding != "" {
            value["synthetic_padding"] = JsonValue.Create(String('x', Int32.Parse(padding)))
        }
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
            (Conditional == "If-None-Match: " + initial || (Check.Text(State["etag_force_304"]) == "true" && reads > 1))
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

    internal func Response(status int32, value JsonNode? = nil, headers string = "") int32 {
        let calls = State["api_calls"]?.AsArray() ?? throw Exception("Missing traffic records")
        let call = calls[calls.Count - 1] ?? throw Exception("Missing traffic entry")
        call["status"] = JsonValue.Create(status)
        Save()
        Console.Write("HTTP/2.0 " + status.ToString() + " Synthetic\r\n")
        Console.Write("Date: " + DateTimeOffset.UtcNow.ToString("r", CultureInfo.InvariantCulture) + "\r\n")
        Console.Write(
            "X-Poll-Interval: " +
                (State["poll_interval"] == nil ? "2": Check.Text(State["poll_interval"])) +
                "\r\nX-Synthetic-Ignored: synthetic-response-secret\r\n" +
                headers +
                "\r\n"
        )
        if value != nil {
            Console.WriteLine(value.ToJsonString())
        }
        if status >= 400 || status == 304 {
            Console.Error.WriteLine("gh: synthetic-response-secret (HTTP " + status.ToString() + ")")
            return 1
        }
        return 0
    }

    internal func GitHub(args[]string) int32 {
        if args[0] == "--version" {
            Console.WriteLine("gh version fixture")
            return 0
        }
        let body = Array.IndexOf(args, "--input") >= 0 ? Check.Json(Console.In.ReadToEnd()): Check.Json("{}")
        ClaimRendezvous(args, body)
        using let lease = ApiLease()
        State = Check.Json(File.ReadAllText(StatePath))
        let token = Environment.GetEnvironmentVariable("GH_TOKEN") ?? Environment.GetEnvironmentVariable("GITHUB_TOKEN")
        let config = Environment.GetEnvironmentVariable("GH_CONFIG_DIR")
        if config == nil {
            throw Exception("GitHub CLI configuration home was lost")
        }
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
        let actor = Check.Text(State["self_owned"]) == "true" ? "owner": token == nil ? File.ReadAllText(
            Path.Combine(config, "identity")
        ): (token == "fixture-owner" ? "owner": "donor")
        let actorId = State["viewer_id"] ?? JsonValue.Create(
            actor == "owner" && Check.Text(State["self_owned"]) != "true" ? 1: 123
        ) as JsonNode
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
        Check.That(args[0] == "api", "Expected GitHub API")
        Check.That(Array.IndexOf(args, "--include") >= 0, "API must include response status and headers")
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
        if method == "GET" && path == Check.Text(State["access_revoke_after_path"]) {
            let reads = State["access_downstream_reads"] == nil ? 1:
            Int32.Parse(Check.Text(State["access_downstream_reads"])) + 1
            State["access_downstream_reads"] = JsonValue.Create(reads)
            if reads == Int32.Parse(Check.Text(State["access_revoke_after_read"])) {
                DenyAccess()
                State["access_revoked_on_read"] = JsonValue.Create(true)
            }
            Save()
        }
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
        if path == "user" {
            return Answer(
                Check.Map("login", State["viewer_login"] ?? JsonValue.Create(actor) as JsonNode, "id", actorId)
            )
        }
        if path.StartsWith("user/repos?") {
            if State["fork_discovery"] != nil {
                let publicOnly = Array.IndexOf(path.Split('?')[1].Split('&'), "visibility=public") >= 0
                let repositories = JsonArray()
                for repository in State["fork_discovery"]?.AsArray() ?? JsonArray() {
                    if !publicOnly || Check.Text(repository["private"]) != "true" {
                        repositories.Add(repository.DeepClone())
                    }
                }
                return Answer(repositories)
            }
            return Answer(
                Check.Text(State["missing_fork"]) == "true" ? JsonArray(): Check.Json(
                    "[{\"full_name\":\"donor/project\",\"fork\":true,\"owner\":{\"id\":123}}]"
                )
            )
        }
        if path.StartsWith("users/") {
            let login = path.Substring(6)
            if login == "missing" {
                return Response(404)
            }
            return Answer(Check.Map("login", login, "id", login == "donor" || login == "renamed" ? 123: 124))
        }
        if path.StartsWith("repos/obselate/tokate/releases/tags/") {
            if let release = State["release"] {
                return Answer(release)
            }
            return Response(404)
        }
        let parts = path.Split('/')
        Check.That(parts[0] == "repos", "Expected repository API")
        let repo = (parts[1] + "/" + parts[2]).ToLowerInvariant()
        let folder = State["repository_folders"]?[repo] is JsonNode selected ? Check.Text(selected):
        repo == "owner/project" ? "upstream": "fork"
        let tail = String.Join("/", parts, 3, parts.Length - 3)
        if tail == "" {
            if folder == "fork" && State["fork_pending_reads"] != nil && Int32.Parse(
                Check.Text(State["fork_pending_reads"])
            ) > 0 {
                State["fork_pending_reads"] = JsonValue.Create(Int32.Parse(Check.Text(State["fork_pending_reads"])) - 1)
                return Response(404)
            }
            if folder == "fork" && Check.Text(State["missing_fork"]) == "true" {
                return Response(404)
            }
            return Answer(
                Check.Map(
                    "default_branch",
                    State["default_branch"] == nil ? "main": Check.Text(State["default_branch"]),
                    "id",
                    folder == "fork" ? 2: (State["repo_id"] ?? JsonValue.Create(1) as JsonNode),
                    "full_name",
                    repo,
                    "owner",
                    Check.Map(
                        "login",
                        parts[1],
                        "id",
                        folder == "fork" ? (State["fork_owner_id"] ?? JsonValue.Create(123) as JsonNode): (
                            State["upstream_owner_id"] ?? JsonValue.Create(
                                Check.Text(State["self_owned"]) == "true" ? 123: 1
                            ) as JsonNode
                        )
                    ),
                    "fork",
                    folder == "fork",
                    "permissions",
                    Check.Map(
                        "push",
                        State["fork_push"] ?? JsonValue.Create(
                            String.Equals(actor, parts[1], StringComparison.OrdinalIgnoreCase)
                        ) as JsonNode
                    ),
                    "parent",
                    Check.Map(
                        "full_name",
                        State["fork_parent"] ?? JsonValue.Create("owner/project") as JsonNode,
                        "id",
                        State["repo_id"] ?? JsonValue.Create(1) as JsonNode
                    )
                )
            )
        }
        if tail == "forks" && method == "POST" {
            if !Directory.Exists(Path.Combine(Root, "fork")) {
                Check.Success(
                    TestProcess.Run(
                        "/usr/bin/git",
                        []string{"clone", "--bare", Path.Combine(Root, "upstream"), Path.Combine(Root, "fork")},
                        Env
                    )
                )
            }
            State["fork_creations"] = JsonValue.Create(
                Int32.Parse(Check.Text(State["fork_creations"] ?? JsonValue.Create(0))) + 1
            )
            State["missing_fork"] = JsonValue.Create(false)
            if State["fork_creation_pending"] != nil {
                State["fork_pending_reads"] = State["fork_creation_pending"]?.DeepClone()
            }
            State["fork_name"] = JsonValue.Create("donor/" + Check.Text(body["name"]))
            Save()
            if Check.Text(State["mode"]) == "lost_fork_response" {
                State["mode"] = JsonValue.Create("")
                Save()
                return Response(500)
            }
            return Answer(
                Check.Map(
                    "id",
                    2,
                    "full_name",
                    "donor/" + Check.Text(body["name"]),
                    "fork",
                    true,
                    "owner",
                    Check.Map("id", 123),
                    "parent",
                    Check.Map("full_name", "owner/project", "id", 1),
                    "permissions",
                    Check.Map("push", true)
                )
            )
        }
        if tail.StartsWith("issues/comments/") {
            let comment = State["canonical_comment_override"] ?? State["comments"]?[tail.Substring(16)]
            return Answer(comment ?? throw Exception("Missing canonical comment"))
        }
        if tail.StartsWith("compare/") {
            let comparison = tail.Substring(8).Split("...")
            let comparisonHead = comparison[1].Split(':')
            let sha = comparisonHead[1]
            if comparisonHead[0] != "owner" {
                Git("upstream", []string{"fetch", Path.Combine(Root, "fork"), sha})
            }
            let names = GitRaw("upstream", []string{"diff", "--name-status", "-z", "-M", comparison[0], sha}).Split(
                '\0'
            )
            let files = JsonArray()
            var i int32
            while i < names.Length - 1 {
                let status = names[i++]
                let path = names[i++]
                if status.StartsWith("R") {
                    files.Add(Check.Map("filename", names[i++], "previous_filename", path, "status", "renamed"))
                } else {
                    files.Add(
                        Check.Map(
                            "filename",
                            path,
                            "status",
                            status == "A" ? "added":
                            (status == "D" ? "removed": (status == "T" ? "changed": "modified"))
                        )
                    )
                }
            }
            let commits = JsonArray()
            for commit in Git("upstream", []string{"rev-list", "--reverse", comparison[0] + ".." + sha}).Split('\n') {
                if commit != "" {
                    commits.Add(Check.Map("sha", commit))
                }
            }
            let total = commits.Count
            while commits.Count > 250 {
                commits.RemoveAt(249)
            }
            let value = Check.Map(
                "status",
                comparison[0] == sha ? "identical": "ahead",
                "files",
                files,
                "commits",
                commits,
                "ahead_by",
                total,
                "behind_by",
                0,
                "total_commits",
                total,
                "base_commit",
                Check.Map("sha", comparison[0]),
                "merge_base_commit",
                Check.Map("sha", Git("upstream", []string{"merge-base", comparison[0], sha}))
            )
            let fault = Check.Text(State["overlap_diff_fault_head"]) != "" && Check.Text(
                State["overlap_diff_fault_head"]
            ) != sha ? "": Check.Text(State["diff_fault"])
            if fault == "missing-files" {
                value.AsObject().Remove("files")
            } else if fault == "truncated-files" {
                while files.Count < 300 {
                    files.Add(Check.Map("filename", "extra-" + files.Count.ToString(), "status", "added"))
                }
                value["files"] = files.DeepClone()
            } else if fault == "wrong-base" {
                value["base_commit"] = Check.Map("sha", String('a', 40))
            } else if fault == "wrong-head" {
                value["commits"] = Check.Json("[{\"sha\":\"" + String('a', 40) + "\"}]")
            } else if fault == "missing-previous" {
                value["files"] = Check.Json("[{\"filename\":\"result.txt\",\"status\":\"renamed\"}]")
            } else if fault == "missing-status" {
                value["files"] = Check.Json("[{\"filename\":\"result.txt\"}]")
            } else if fault == "missing-commits" {
                value.AsObject().Remove("commits")
            }
            return Answer(value)
        }
        if tail.StartsWith("commits/") && tail.Contains("/check-runs?") {
            if Check.Text(State["check_change"]) == "base" {
                let target = State["pulls"]?[0]?["base"] ?? throw Exception("Missing base")
                target["ref"] = JsonValue.Create("main")
            }
            let polls = State["check_polls"] == nil ? 0: Int32.Parse(Check.Text(State["check_polls"]))
            if let samples = State["check_sequence"] {
                let entries = samples.AsArray()
                State["checks"] = entries[Math.Min(polls, entries.Count - 1)]?.DeepClone()
            }
            State["check_polls"] = JsonValue.Create(polls + 1)
            let statePath = Check.Text(State["check_state_path"])
            if statePath != "" {
                let times = State["check_state_times"]?.AsArray() ?? JsonArray()
                times.Add(JsonValue.Create(File.GetLastWriteTimeUtc(statePath).Ticks.ToString()) as JsonNode)
                State["check_state_times"] = times
            }
            let effect = Check.Text(State["check_read_effect"])
            if effect == "head" {
                let head = State["pulls"]?[0]?["head"] ?? throw Exception("Missing PR head")
                head["sha"] = JsonValue.Create(String('a', 40))
            } else if effect == "retarget" {
                let target = State["pulls"]?[0]?["base"] ?? throw Exception("Missing PR target")
                target["ref"] = JsonValue.Create("release")
            } else if effect == "approval" {
                let issue = State["issue"] ?? throw Exception("Missing issue")
                issue["labels"] = JsonArray()
            }
            let move = State["overlap_move_target"]
            if move != nil {
                Git(
                    "upstream",
                    []string{"update-ref", "refs/heads/" + Check.Text(move["branch"]), Check.Text(move["sha"])}
                )
                State["overlap_move_target"] = nil
            }
            State["check_read_effect"] = nil
            let runs = JsonArray()
            for check in State["checks"]?.AsArray() ?? JsonArray() {
                let bucket = Check.Text(check["bucket"])
                runs.Add(
                    Check.Map(
                        "name",
                        Check.Text(check["name"]),
                        "status",
                        bucket == "pending" ? "in_progress": "completed",
                        "conclusion",
                        bucket == "pass" ? "success": (
                            bucket == "fail" ? "failure":
                            (bucket == "cancel" ? "cancelled": (bucket == "skipping" ? "skipped": ""))
                        ),
                        "html_url",
                        "https://example.test/check"
                    )
                )
            }
            return Answer(State["check_runs"] ?? Check.Map("total_count", runs.Count, "check_runs", runs))
        }
        if tail.StartsWith("commits/") && tail.Contains("/status?") {
            return Answer(Check.Map("statuses", State["statuses"] ?? JsonArray()))
        }
        if tail.StartsWith("commits/") {
            return Answer(Check.Map("sha", Git(folder, []string{"rev-parse", tail.Substring(8)})))
        }
        if tail.StartsWith("contents/") {
            let split = tail.IndexOf("?ref=")
            let file = tail.Substring(9, split - 9)
            let journal = Check.Text(State["journal_race_path"])
            if file == ".github/tokate-pr.md" && journal != "" {
                if Check.Text(State["journal_race_link"]) == "true" {
                    File.CreateSymbolicLink(journal, Check.Text(State["journal_race_target"]))
                } else {
                    File.WriteAllText(journal, "synthetic-journal-sentinel")
                }
                State["journal_race_path"] = nil
                Save()
            }
            let reference = Uri.UnescapeDataString(tail.Substring(split + 5))
            var content string
            try {
                content = Git(folder, []string{"show", reference + ":" + file})
            } catch (error Exception) {
                return Response(404)
            }
            if file == "access.json" && State["access_override"] != nil {
                content = Check.Text(State["access_override"])
            }
            if file == "state.json" && State["coordination_state_override"] != nil {
                content = Check.Text(State["coordination_state_override"])
            }
            return Answer(
                Check.Map("encoding", "base64", "content", Convert.ToBase64String(Encoding.UTF8.GetBytes(content)))
            )
        }
        if tail.StartsWith("issues/") {
            let issueNumber = tail.Split('/')[1]
            if tail.Contains("/dependencies/blocked_by?") {
                let pages = State["dependency_pages"]?[issueNumber]
                let page = Int32.Parse(tail.Substring(tail.LastIndexOf("page=") + 5))
                if let values = pages {
                    let entries = values.AsArray()
                    return Answer(page <= entries.Count ? entries[page - 1] ?? JsonArray(): JsonArray())
                }
                return Answer(JsonArray())
            }
            let issue = State["issues"]?[issueNumber] ?? State["issue"] ?? throw Exception("Missing issue")
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
                State["workflow_records"] = JsonValue.Create(count)
                State["workflow_jobs"] = JsonValue.Create(count)
                let comment = Check.Map(
                    "id",
                    100 + count,
                    "body",
                    Check.Text(body["body"]),
                    "user",
                    Check.Map("login", actor, "id", actorId),
                    "issue_url",
                    "https://api.github.com/repos/owner/project/issues/1"
                )
                let comments = State["comments"] ?? JsonObject()
                comments[(100 + count).ToString()] = comment.DeepClone()
                State["comments"] = comments
                if Check.Text(State["mode"]) == "request_fail_after_write" {
                    return Response(500)
                }
                if Check.Text(State["mode"]) == "request_rate_after_write" {
                    return Response(429, headers: "Retry-After: 1\r\n")
                }
                if Check.Text(State["mode"]) == "request_ambiguous_after_write" {
                    let duplicate = comment.DeepClone()
                    duplicate["id"] = JsonValue.Create(1000 + count)
                    comments[(1000 + count).ToString()] = duplicate
                    Save()
                    return 1
                }
                let posted = State["request_comments"]?.AsArray() ?? JsonArray()
                posted.Add(comment.DeepClone())
                State["request_comments"] = posted
                if Check.Text(State["mode"]) == "lost_request_response" {
                    State["mode"] = JsonValue.Create("")
                    Save()
                    return 1
                }
                let response = comment.DeepClone()
                switch Check.Text(State["request_response_fault"]) {
                    case "issue" {
                        response["issue_url"] = JsonValue.Create("https://api.github.com/repos/owner/project/issues/2")
                    }
                    case "repo" {
                        response["issue_url"] = JsonValue.Create("https://api.github.com/repos/other/project/issues/1")
                    }
                    case "author" {
                        (response["user"] ?? throw Exception("Missing response author"))["id"] = JsonValue.Create(999)
                    }
                    case "body" {
                        response["body"] = JsonValue.Create("/tokate {}")
                    }
                    case "id" {
                        response["id"] = JsonValue.Create(0)
                    }
                }
                if Check.Text(State["request_response_missing"]) == "true" {
                    comments.AsObject().Remove((100 + count).ToString())
                }
                return Answer(response)
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
            if tail == "git/ref/heads/tokate/access" && State["access_revoke_at"] != nil {
                let count = State["access_reads"] == nil ? 1: Int32.Parse(Check.Text(State["access_reads"])) + 1
                State["access_reads"] = JsonValue.Create(count)
                if count == Int32.Parse(Check.Text(State["access_revoke_at"])) {
                    DenyAccess()
                }
            }
            var sha string
            try {
                sha = Git(
                    folder,
                    []string{"rev-parse", "--verify", "refs/heads/" + Uri.UnescapeDataString(tail.Substring(14))}
                )
            } catch (error Exception) {
                return Response(404)
            }
            return Answer(Check.Map("object", Check.Map("sha", sha, "type", "commit")))
        }
        if tail.StartsWith("git/commits/") {
            let parents = JsonArray()
            let line = Git(folder, []string{"rev-list", "--parents", "-n", "1", tail.Substring(12)}).Split(' ')
            for i in 1 ... line.Length {
                parents.Add(Check.Map("sha", line[i]))
            }
            return Answer(
                Check.Map(
                    "sha",
                    tail.Substring(12),
                    "tree",
                    Check.Map("sha", Git(folder, []string{"rev-parse", tail.Substring(12) + "^{tree}"})),
                    "parents",
                    parents
                )
            )
        }
        if tail.StartsWith("git/trees/") {
            let sha = tail.Substring(10).Split('?')[0]
            let recursive = tail.EndsWith("?recursive=1", StringComparison.Ordinal)
            let entries = JsonArray()
            let args = recursive ? []string{"ls-tree", "-r", "-t", "-z", sha}: []string{"ls-tree", "-z", sha}
            for line in GitRaw(folder, args).Split('\0') {
                if line == "" {
                    continue
                }
                let tab = line.IndexOf('\t')
                let fields = line.Substring(0, tab).Split(' ')
                let entry = Check.Map(
                    "path",
                    line.Substring(tab + 1),
                    "mode",
                    fields[0],
                    "type",
                    fields[1],
                    "sha",
                    fields[2]
                )
                if !recursive && fields[1] == "blob" {
                    entry["size"] = JsonValue.Create(Int32.Parse(Git(folder, []string{"cat-file", "-s", fields[2]})))
                }
                entries.Add(entry)
            }
            let fault = Check.Text(State[recursive ? "tree_fault": "decree_tree_fault"])
            let result = Check.Map("sha", sha, "truncated", fault == "truncated", "tree", entries)
            if recursive && fault == "missing" {
                result.AsObject().Remove("tree")
            } else if recursive && fault == "identity" {
                result["sha"] = JsonValue.Create(String('a', 40))
            } else if recursive && fault == "ancestor" {
                for i in 0 ... entries.Count {
                    if Check.Text(entries[i]?["path"]) == ".github" {
                        entries.RemoveAt(i)
                        break
                    }
                }
                result["tree"] = entries.DeepClone()
            }
            return Answer(result)
        }
        if tail.StartsWith("git/blobs/") {
            let fault = Check.Text(State["decree_blob_fault"])
            if fault == "unreadable" {
                return Response(404)
            }
            let sha = tail.Substring(10)
            let bytes = Blob(folder, sha)
            let blob = Check.Map(
                "sha",
                sha,
                "encoding",
                fault == "encoding" ? "none": "base64",
                "size",
                bytes.Length,
                "content",
                Convert.ToBase64String(fault == "truncated" ? []byte{}: bytes)
            )
            if fault == "missing-size" {
                blob.AsObject().Remove("size")
            }
            return Answer(blob)
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
            for field in[]string{"author", "committer"} {
                let prefix = field == "author" ? "GIT_AUTHOR_": "GIT_COMMITTER_"
                Env[prefix + "NAME"] = body[field] == nil ? "API Fixture": Check.Text(body[field]?["name"])
                Env[prefix + "EMAIL"] = body[field] == nil ? "api-default@example.test": Check.Text(
                    body[field]?["email"]
                )
            }
            let command = List[string]{"commit-tree", Check.Text(body["tree"])}
            for parent in body["parents"]?.AsArray() ?? JsonArray() {
                command.Add("-p")
                command.Add(Check.Text(parent))
            }
            let sha = Git(folder, command.ToArray(), Check.Text(body["message"]))
            if State["api_commits"] == nil {
                State["api_commits"] = JsonArray()
            }
            let commits = State["api_commits"]?.AsArray() ?? throw Exception("Missing API commits")
            commits.Add(Check.Map("sha", sha, "request", body))
            return Answer(Check.Map("sha", sha))
        }
        if tail == "git/refs" {
            if folder == "fork" && Check.Text(body["ref"]).StartsWith("refs/heads/tokate/") {
                Git(folder, []string{"fetch", Path.Combine(Root, "upstream"), Check.Text(body["sha"])})
            }
            try {
                Git(folder, []string{"update-ref", Check.Text(body["ref"]), Check.Text(body["sha"]), String('0', 40)})
            } catch (error Exception) {
                return Response(422)
            }
            if Check.Text(State["mode"]) == "lost_branch_response" && Check.Text(body["ref"]).StartsWith(
                "refs/heads/tokate/issue-"
            ) {
                State["mode"] = JsonValue.Create("")
                Save()
                return Response(500)
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
            if reference == "refs/heads/tokate/access" && Check.Text(State["mode"]) == "access_conflict" {
                DenyAccess()
                State["mode"] = JsonValue.Create("")
            }
            let previous = Git(folder, []string{"rev-parse", reference})
            try {
                Check.That(Check.Text(body["force"]) == "false", "Ref updates must never force")
                Git(folder, []string{"merge-base", "--is-ancestor", previous, Check.Text(body["sha"])})
                Git(folder, []string{"update-ref", reference, Check.Text(body["sha"]), previous})
            } catch (error Exception) {
                return Response(422)
            }
            if reference == "refs/heads/tokate/access" && Check.Text(State["mode"]) == "lost_access_response" {
                State["mode"] = JsonValue.Create("")
                Save()
                return 1
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
            let query = tail.Substring(tail.IndexOf('?') + 1).Split('&')
            let filter = Array.Find(query, field -> field.StartsWith("base=", StringComparison.Ordinal)) ?? ""
            let target = filter == "" ? "": Uri.UnescapeDataString(filter.Substring(5))
            let headFilter = Array.Find(query, field -> field.StartsWith("head=", StringComparison.Ordinal)) ?? ""
            let head = headFilter == "" ? "": Uri.UnescapeDataString(headFilter.Substring(5))
            let pulls = JsonArray()
            for pull in(State["pulls"] ?? JsonArray()).AsArray() {
                if (target == "" || Check.Text(pull["base"]?["ref"]) == target) &&
                    (
                    head == "" || Check.Text(pull["head"]?["repo"]?["owner"]?["login"]) + ":" + Check.Text(
                        pull["head"]?["ref"]
                    ) == head
                ) {
                    pulls.Add(pull.DeepClone())
                }
            }
            if Check.Text(State["pull_history_invalid"]) == "true" {
                return Answer(Check.Map("message", "Unexpected PR response"))
            }
            let pageField = Array.Find(query, field -> field.StartsWith("page=", StringComparison.Ordinal)) ?? "page=1"
            let sizeField = Array.Find(query, field -> field.StartsWith("per_page=", StringComparison.Ordinal)) ??
                "per_page=30"
            let page = Int32.Parse(pageField.Substring(5))
            let size = Int32.Parse(sizeField.Substring(9))
            let rows = JsonArray()
            if Check.Text(State["pull_history_unbounded"]) == "true" {
                for i in 0 ... size {
                    rows.Add(pulls[0]?.DeepClone())
                }
            } else {
                for i in(page - 1) * size ... Math.Min(page * size, pulls.Count) {
                    rows.Add(pulls[i]?.DeepClone())
                }
            }
            return Answer(rows)
        }
        if tail.StartsWith("pulls/") {
            let number = tail.Split('/')[1]
            var selected JsonNode? = nil
            for candidate in State["pulls"]?.AsArray() ?? JsonArray() {
                if Check.Text(candidate["number"]) == number {
                    selected = candidate
                }
            }
            let pull = selected ?? throw Exception("Missing PR")
            if method == "PATCH" {
                if Check.Text(State["mode"]) == "body_fail" {
                    return Response(500)
                }
                pull["body"] = body["body"]?.DeepClone()
                if Check.Text(State["mode"]) == "lost_body_response" {
                    State["mode"] = JsonValue.Create("")
                    Save()
                    Console.Error.WriteLine("Synthetic lost amendment body response")
                    return 1
                }
            }
            return Answer(pull)
        }
        if tail == "pulls" {
            let count = State["pr_create_count"] == nil ? 1: Int32.Parse(Check.Text(State["pr_create_count"])) + 1
            State["pr_create_count"] = JsonValue.Create(count)
            if Check.Text(State["mode"]) == "pr_fail" {
                return Response(500)
            }
            let headParts = Check.Text(body["head"]).Split(':')
            let headLogin = headParts[0]
            let branch = headParts[1]
            let number = Check.Text(State["multiple_pulls"]) == "true" ? 9 + count: 10
            body["number"] = JsonValue.Create(number)
            body["html_url"] = JsonValue.Create("https://github.com/owner/project/pull/" + number.ToString())
            body["state"] = JsonValue.Create("open")
            body["user"] = Check.Map("login", actor, "id", actorId)
            body["head"] = Check.Map(
                "sha",
                Git(headLogin == "owner" ? "upstream": "fork", []string{"rev-parse", branch}),
                "ref",
                branch,
                "repo",
                Check.Map("full_name", headLogin + "/project", "owner", Check.Map("login", headLogin, "id", 123))
            )
            body["base"] = Check.Map("ref", Check.Text(body["base"]), "repo", Check.Map("full_name", repo))
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

    internal func DenyAccess() {
        let reference = "refs/heads/tokate/access"
        let previous = Git("upstream", []string{"rev-parse", reference})
        let access = Check.Json(Git("upstream", []string{"show", previous + ":access.json"}))
        access["members"] = Check.Json("[{\"actor\":123,\"trusted\":true,\"denied\":true,\"issues\":[1]}]")
        let blob = Git("upstream", []string{"hash-object", "-w", "--stdin"}, access.ToJsonString())
        let tree = Git("upstream", []string{"mktree"}, "100644 blob " + blob + "\taccess.json\n")
        let next = Git("upstream", []string{"commit-tree", tree, "-p", previous}, "Concurrent owner denial")
        Git("upstream", []string{"update-ref", reference, next, previous})
    }

    internal func ClaimRendezvous(args[]string, body JsonNode) {
        let method = Array.IndexOf(args, "--method")
        let config = Path.Combine(Root, "claim-rendezvous.json")
        if args[0] != "api" ||
            method < 0 ||
            args[method + 1] != "PATCH" ||
            args[method + 2] != "repos/owner/project/git/refs/heads/tokate/contributions/1" ||
            !File.Exists(config) {
            return
        }
        let rendezvous = Check.Json(File.ReadAllText(config))
        let sha = Check.Text(body["sha"])
        let parents = Git("upstream", []string{"rev-list", "--parents", "-n", "1", sha}).Split(' ')
        Check.That(Check.Text(body["force"]) == "false", "Rendezvous requires a non-forced ref update")
        Check.That(
            parents.Length == 2 && parents[1] == Check.Text(rendezvous["expected"]),
            "Rendezvous requires exactly one parent matching the shared expected state"
        )
        let proposed = Check.Json(Git("upstream", []string{"show", sha + ":state.json"}))
        let participant = Check.Text(proposed["reservation"]?["reservation"])
        let first = Check.Text(rendezvous["first"])
        let second = Check.Text(rendezvous["second"])
        Check.That(participant == first || participant == second, "Unexpected claim rendezvous participant")
        let directory = Check.Text(rendezvous["directory"])
        let peer = Path.Combine(directory, (participant == first ? second: first) + ".arrived")
        let changed = Chan[bool](1)
        using let watcher = FileSystemWatcher(directory, "*.arrived")
        watcher.Created += (sender Object?, event FileSystemEventArgs) -> {
            select {
                case changed <- true { }
                default { }
            }
        }
        watcher.EnableRaisingEvents = true
        let deadline = after(TimeSpan.FromMilliseconds(Int32.Parse(Check.Text(rendezvous["timeout_ms"]))))
        File.WriteAllText(Path.Combine(directory, participant + ".arrived"), "")
        while !File.Exists(peer) {
            select {
                case <- changed { }
                case <- deadline {
                    let message = "Claim rendezvous timed out: " + participant + " missing " + Path.GetFileName(peer)
                    File.WriteAllText(Path.Combine(directory, participant + ".failed"), message)
                    throw Exception(message)
                }
            }
        }
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
}

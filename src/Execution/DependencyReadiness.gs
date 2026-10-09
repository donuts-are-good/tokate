package Tokate

import System
import System.Collections.Generic
import System.IO
import System.Text.Json
import System.Text.RegularExpressions

internal class Dependency {
    internal let Name string
    internal let Version string
    internal let Kind string
    internal let Source string

    internal init(name string, version string, kind string, source string) {
        Name = name
        Version = version
        Kind = kind
        Source = source
    }
}

internal class DependencyReadiness {
    internal let Missing List[Dependency]
    internal let Evidence string
    internal let Offline bool

    internal init(missing List[Dependency], evidence string, offline bool) {
        Missing = missing
        Evidence = evidence
        Offline = offline
    }

    internal func Blocking(network bool) bool -> !network && Missing.Count > 0 && Evidence != ""

    internal func Summary(network bool) string {
        if Missing.Count == 0 {
            return ""
        }
        let shown = Math.Min(5, Missing.Count)
        let names = List[string]()
        for i in 0 ... shown {
            let item = Missing[i]
            names.Add(item.Name + " " + item.Version + " (" + item.Kind + " in " + item.Source + ")")
        }
        var list = String.Join("; ", names)
        if Missing.Count > shown {
            list = list + "; and " + (Missing.Count - shown).ToString() + " more"
        }
        if network {
            return "Dependency readiness: command network access is allowed.\n" +
                "Verification can download packages that the repository does not hold: " +
                list +
                "."
        }
        var text = "Dependency readiness: verification runs with an empty package cache.\n" +
            "Command network access is off.\n" +
            "Not available offline: " +
            list +
            ".\n"
        if Evidence != "" {
            text = text + "Verification reaches dotnet through " + Evidence + ".\n"
        } else {
            text = text + "Tokate cannot tell whether verification needs these downloads.\n"
        }
        text = text + "To allow downloads, start a fresh claim with --allow-network.\n"
        text = text + "The owner policy must allow command network access.\n"
        if Offline {
            text = text + "The offline package source in NuGet.Config does not hold these packages.\n"
        } else {
            text = text + "To stay offline, the owner can commit a NuGet.Config with <clear />\n"
            text = text + "and a package folder in the repository that holds them.\n"
        }
        return text + "Tokate read project files only. It ran no repository command."
    }

    shared {
        internal func Notice(checkout string, run Data, record JsonElement) {
            let network = Allowed(run, record)
            var text = ""
            try {
                text = Inspect(checkout, record).Summary(network)
            } catch (error Exception) {
                text = "Dependency readiness could not be checked: " + error.Message
            }
            if text != "" {
                Terminal.Step(text)
            }
        }

        internal func Require(checkout string, run Data, record JsonElement) {
            let network = Allowed(run, record)
            var text = ""
            try {
                let readiness = Inspect(checkout, record)
                if readiness.Blocking(network) {
                    text = readiness.Summary(network)
                }
            } catch { }
            if text != "" {
                throw CliFailure("dependencies_unavailable", text + "\nNo inference started.")
            }
        }

        private func Allowed(run Data, record JsonElement) bool -> run.Flag("network") && J.Bool(
            J.Get(record, "policy"),
            "allow_network"
        )

        internal func Inspect(checkout string, record JsonElement) DependencyReadiness {
            let root = Path.TrimEndingDirectorySeparator(Path.GetFullPath(checkout))
            let files = List[string]()
            Walk(root, 0, files)
            files.Sort(StringComparer.Ordinal)
            let found = Dictionary[string, Dependency](StringComparer.Ordinal)
            for path in files {
                Scan(root, path, found)
            }
            let sources = OfflineSources(root)
            let keys = List[string](found.Keys)
            keys.Sort(StringComparer.Ordinal)
            let missing = List[Dependency]()
            for key in keys {
                let item = found[key]
                if !Available(root, sources, item) {
                    missing.Add(item)
                }
            }
            var evidence = ""
            if missing.Count > 0 {
                for command in J.Items(J.Get(J.Get(record, "policy"), "verification")) {
                    evidence = Reaches(root, command)
                    if evidence != "" {
                        break
                    }
                }
            }
            return DependencyReadiness(missing, evidence, sources.Count > 0)
        }

        private func Walk(directory string, depth int32, files List[string]) {
            if depth > 6 {
                return
            }
            for entry in Directory.EnumerateFileSystemEntries(directory) {
                if files.Count >= 400 {
                    return
                }
                if FileInfo(entry).LinkTarget != nil {
                    continue
                }
                let name = Path.GetFileName(entry)
                if Directory.Exists(entry) {
                    if Array.IndexOf([]string{".git", ".nuget", "artifacts", "bin", "node_modules", "obj"}, name) < 0 {
                        Walk(entry, depth + 1, files)
                    }
                } else if Interesting(name) {
                    files.Add(entry)
                }
            }
        }

        private func Interesting(name string) bool {
            if name == "global.json" {
                return true
            }
            return Array.IndexOf(
                []string{".csproj", ".fsproj", ".vbproj", ".gsproj", ".proj", ".props", ".targets"},
                Path.GetExtension(name).ToLowerInvariant()
            ) >=
                0
        }

        private func Scan(root string, path string, found Dictionary[string, Dependency]) {
            if FileInfo(path).Length > 262144 {
                return
            }
            let relative = Path.GetRelativePath(root, path)
            let text = File.ReadAllText(path)
            if Path.GetFileName(path) == "global.json" {
                try {
                    let sdks = J.Get(J.Parse(text), "msbuild-sdks")
                    if sdks.ValueKind == JsonValueKind.Object {
                        for item in sdks.EnumerateObject() {
                            if item.Value.ValueKind == JsonValueKind.String {
                                Add(found, item.Name, item.Value.GetString() ?? "", "MSBuild SDK", relative)
                            }
                        }
                    }
                } catch { }
                return
            }
            let xml = Regex.Replace(text, "<!--.*?-->", "", RegexOptions.Singleline)
            for match Match in Regex.Matches(xml, "\\bSdk=\"([^\"]+)\"") {
                for part in match.Groups[1].Value.Split(';') {
                    let slash = part.IndexOf('/')
                    if slash > 0 {
                        Add(
                            found,
                            part.Substring(0, slash).Trim(),
                            part.Substring(slash + 1).Trim(),
                            "MSBuild SDK",
                            relative
                        )
                    }
                }
            }
            for match Match in Regex.Matches(xml, "<Sdk\\b[^>]*\\bName=\"([^\"]+)\"[^>]*\\bVersion=\"([^\"]+)\"") {
                Add(found, match.Groups[1].Value, match.Groups[2].Value, "MSBuild SDK", relative)
            }
            for match Match in Regex.Matches(xml, "<Import\\b[^>]*\\bSdk=\"([^\"/;]+)\"[^>]*\\bVersion=\"([^\"]+)\"") {
                Add(found, match.Groups[1].Value, match.Groups[2].Value, "MSBuild SDK", relative)
            }
            for match Match in Regex.Matches(
                xml,
                "<Package(?:Reference|Version)\\b[^>]*\\bInclude=\"([^\"]+)\"[^>]*\\bVersion=\"([^\"]+)\""
            ) {
                Add(found, match.Groups[1].Value, match.Groups[2].Value, "NuGet package", relative)
            }
        }

        private func Add(
            found Dictionary[string, Dependency],
            name string,
            version string,
            kind string,
            source string
        ) {
            if !Regex.IsMatch(name, "^[A-Za-z0-9][A-Za-z0-9._-]*$") ||
                !Regex.IsMatch(version, "^[A-Za-z0-9][A-Za-z0-9.+-]*$") ||
                name.StartsWith("Microsoft.NET.Sdk", StringComparison.OrdinalIgnoreCase) {
                return
            }
            let key = kind + ":" + name + "/" + version
            if !found.ContainsKey(key) {
                found[key] = Dependency(name, version, kind, source)
            }
        }

        private func Plain(root string, path string) bool {
            var current = path
            while current.Length > root.Length {
                if FileInfo(current).LinkTarget != nil {
                    return false
                }
                current = Path.GetDirectoryName(current) ?? root
            }
            return true
        }

        private func OfflineSources(root string) List[string] {
            let sources = List[string]()
            for entry in Directory.EnumerateFiles(root) {
                if !String.Equals(Path.GetFileName(entry), "nuget.config", StringComparison.OrdinalIgnoreCase) ||
                    FileInfo(entry).LinkTarget != nil ||
                    FileInfo(entry).Length > 65536 {
                    continue
                }
                let text = Regex.Replace(File.ReadAllText(entry), "<!--.*?-->", "", RegexOptions.Singleline)
                let block = Regex.Match(
                    text,
                    "<packageSources>(.*?)</packageSources>",
                    RegexOptions.Singleline | RegexOptions.IgnoreCase
                )
                if !block.Success || !Regex.IsMatch(block.Groups[1].Value, "<clear\\s*/>", RegexOptions.IgnoreCase) {
                    return List[string]()
                }
                for match Match in Regex.Matches(
                    block.Groups[1].Value,
                    "<add\\b[^>]*\\bvalue=\"([^\"]*)\"",
                    RegexOptions.IgnoreCase
                ) {
                    let value = match.Groups[1].Value.Trim()
                    if value == "" || value.Contains("://") ||
                        value.Contains("$") ||
                        value.Contains("%") ||
                        value.StartsWith("/") ||
                        value.StartsWith("~") {
                        return List[string]()
                    }
                    let directory = Path.GetFullPath(value, root)
                    if !directory.StartsWith(root + "/") || !Directory.Exists(directory) || !Plain(root, directory) {
                        return List[string]()
                    }
                    sources.Add(directory)
                }
                return sources
            }
            return sources
        }

        private func Available(root string, sources List[string], item Dependency) bool {
            let name = item.Name.ToLowerInvariant()
            let version = item.Version.ToLowerInvariant()
            let file = item.Name + "." + item.Version + ".nupkg"
            for directory in sources {
                let layered = Path.Combine(directory, name, version, name + "." + version + ".nupkg")
                if File.Exists(layered) && Plain(root, layered) {
                    return true
                }
                for candidate in Directory.EnumerateFiles(directory, "*.nupkg") {
                    if String.Equals(Path.GetFileName(candidate), file, StringComparison.OrdinalIgnoreCase) &&
                        FileInfo(candidate).LinkTarget == nil {
                        return true
                    }
                }
            }
            return false
        }

        private func Mentions(text string) bool -> text.Length <= 262144 && Regex.IsMatch(
            text,
            "(^|[\\s;&|/(\"'=])(dotnet|msbuild)($|[\\s;&|)\"'])",
            RegexOptions.Multiline
        )

        private func Enqueue(
            root string,
            baseDirectory string,
            word string,
            queue List[string],
            seen HashSet[string]
        ) {
            if word == "" || word.Length > 256 {
                return
            }
            try {
                let path = Path.GetFullPath(word, baseDirectory)
                if !path.StartsWith(root + "/") || !seen.Add(path) {
                    return
                }
                if File.Exists(path) && Plain(root, path) && FileInfo(path).Length <= 262144 {
                    queue.Add(path)
                }
            } catch { }
        }

        private func Reaches(root string, command JsonElement) string {
            let queue = List[string]()
            let seen = HashSet[string](StringComparer.Ordinal)
            for word in J.Items(command) {
                let text = word.GetString() ?? ""
                if Mentions(text) {
                    return "a verification command"
                }
                Enqueue(root, root, text, queue, seen)
            }
            var index int32
            while index < queue.Count && index < 16 {
                let path = queue[index]
                index++
                let text = File.ReadAllText(path)
                if Mentions(text) {
                    return Path.GetRelativePath(root, path)
                }
                for match Match in Regex.Matches(text, "[A-Za-z0-9_./-]+\\.(?:sh|bash)") {
                    Enqueue(root, Path.GetDirectoryName(path) ?? root, match.Value, queue, seen)
                    Enqueue(root, root, match.Value, queue, seen)
                }
            }
            return ""
        }
    }
}

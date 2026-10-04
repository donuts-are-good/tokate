package Tokate

import System
import System.Collections.Generic
import System.Text.RegularExpressions

internal class Args {
    internal let Values Dictionary[string, string] = Dictionary[string, string]()
    internal var Command string = "help"
    internal var Help bool = false
    internal var Subject string = ""
    internal var IssueUrl string = ""
    internal init(args[]string) {
        if args.Length == 0 {
            Help = true
            return
        }
        Command = args[0]
        if Command == "--help" || Command == "-h" {
            Command = "help"
        }
        Cli.Find(Command)
        var i int32 = 1
        while i < args.Length {
            let word = args[i]
            if Command == "help" && word == "--version" && Subject == "" {
                Subject = word
                i++
                continue
            }
            if !word.StartsWith("-") {
                if (Command == "help" || Command == "completion" || Command == "defaults") && Subject == "" {
                    Subject = word
                } else if Cli.Find(Command).Has("issue") && IssueUrl == "" && word.StartsWith("https://") {
                    IssueUrl = word
                } else {
                    throw Exception("Unexpected argument: " + word)
                }
                i++
                continue
            }
            let equal = word.IndexOf('=')
            let key = word == "-h" ? "--help": (equal < 0 ? word: word.Substring(0, equal))
            if !key.StartsWith("--") || Values.ContainsKey(key) {
                throw Exception("Invalid or duplicate option: " + key)
            }
            let option = Cli.OptionFor(Command, key.Substring(2))
            if option.Value == "" {
                if equal >= 0 {
                    throw Exception("Flag does not take a value: " + key)
                }
                Values.Add(key, "true")
            } else {
                var value = equal < 0 ? "": word.Substring(equal + 1)
                if equal < 0 {
                    i++
                    if i < args.Length && !args[i].StartsWith("-") {
                        value = args[i]
                    }
                }
                if String.IsNullOrWhiteSpace(value) {
                    throw Exception("Missing value for " + key)
                }
                Values.Add(key, value)
            }
            i++
        }
        if Command == "help" {
            if Subject != "" {
                Cli.Find(Subject)
            }
            Help = true
        } else {
            Help = Get("help") == "true"
        }
    }

    internal func Get(key string, fallback string = "") string {
        var value string
        return Values.TryGetValue("--" + key, out value) ? value: fallback
    }

    internal func Need(key string) string {
        let value = Get(key)
        if value == "" {
            throw Exception("Required: --" + key)
        }
        return value
    }

    internal func Number(key string, fallback string = "") int32 {
        let value = Get(key, fallback)
        var number int32
        if (key == "verification-reserve" && !Regex.IsMatch(value, "^[0-9]+\\z")) || !Int32.TryParse(
            value,
            out number
        ) ||
            number < 1 ||
            ((key == "seconds" || key == "timeout") && number > 86400) {
            throw Exception("Invalid positive number: --" + key)
        }
        return number
    }
}

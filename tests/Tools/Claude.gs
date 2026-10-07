package TokateTests

import System
import System.IO

internal class ClaudeTool {
    shared {
        internal func Run(args[]string) int32 {
            let profile = Environment.GetEnvironmentVariable("CLAUDE_CONFIG_DIR") ?? ""
            let mode = File.ReadAllText(Path.Combine(profile, ".claude.json"))
            if args.Length == 3 && args[2] == "--version" {
                Console.WriteLine("100.0.0 (Claude Code)")
                return 0
            }
            if args.Length == 3 && args[2] == "--help" {
                for flag in[]string{
                    "--restricted",
                    "--safe-mode",
                    "--setting-sources",
                    "--strict-mcp-config",
                    "--mcp-config",
                    "--disable-slash-commands",
                    "--no-chrome",
                    "--tools",
                    "--allowedTools",
                    "--permission-mode",
                    "--permission-prompts",
                    "--settings",
                    "--model",
                    "--effort",
                    "--no-session-persistence",
                    "--output-format",
                    "--verbose",
                    "--print"
                } {
                    if mode != "missing" || flag != "--permission-prompts" {
                        Console.WriteLine("  " + flag + " synthetic documented interface")
                    }
                }
                return 0
            }
            Check.That(
                String.Join(" ", args) == "--restricted --safe-mode auth status --json",
                "Auth status was not standalone restricted safe mode"
            )
            Check.That(
                !Directory.Exists(Path.Combine(Directory.GetCurrentDirectory(), ".git")),
                "Auth status was exposed to a repository"
            )
            Console.Write(File.ReadAllText(Path.Combine(profile, ".credentials.json")))
            return mode == "exit" ? 1: 0
        }
    }
}

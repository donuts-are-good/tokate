package TokateTests

import System
import System.IO

internal class TestTerminal {
    shared {
        internal func Pty(binary string, args[]string, temp Temp, width int32, input string? = nil) Result {
            var command = "stty cols " + width.ToString() + " rows 24; '" + binary.Replace("'", "'\"'\"'") + "'"
            for arg in args {
                command += " '" + arg.Replace("'", "'\"'\"'") + "'"
            }
            if Array.IndexOf(args, "--json") >= 0 {
                command += " 2>'" + Path.Combine(temp.Root, "diagnostics") + "'"
            }
            return TestProcess.Run(
                "/usr/bin/script",
                []string{"-q", "-e", "-c", command, "/dev/null"},
                temp.Env,
                input,
                cwd: temp.Root
            )
        }

        internal func Save(name string, text string) {
            let directory = Environment.GetEnvironmentVariable("TOKATE_TERMINAL_CAPTURE") ?? ""
            if directory != "" {
                Directory.CreateDirectory(directory)
                File.WriteAllText(Path.Combine(directory, name + ".txt"), text)
            }
        }
    }
}

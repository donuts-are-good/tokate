package Tokate

import Gsharp.Concurrency
import System
import System.IO
import System.Runtime.InteropServices

internal class VerificationWorkspace : IDisposable {
    private let Root string
    internal let Original string
    internal let Checkout string
    private let OnCancel ConsoleCancelEventHandler
    private let Termination PosixSignalRegistration
    private let CopyCancellation Chan[bool] = Chan[bool](1)
    private var Cancelled bool

    internal init(directory string, budget RuntimeBudget) {
        Original = Verification.Validate(directory, budget)
        Root = Path.Combine(LocalPaths.DirectoryPath("/tmp"), "tokate-workspace-" + Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(Root, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute)
        Checkout = Path.Combine(Root, "checkout")
        LocalPaths.DirectoryPath(Root)
        OnCancel = ConsoleCancelEventHandler(
            (sender Object?, event ConsoleCancelEventArgs) -> {
                event.Cancel = true
                Cancelled = true
                select {
                    case CopyCancellation <- true { }
                    default { }
                }
            }
        )
        Console.CancelKeyPress += OnCancel
        Termination = PosixSignalRegistration.Create(
            PosixSignal.SIGTERM,
            (context PosixSignalContext) -> {
                context.Cancel = true
                Cancelled = true
                select {
                    case CopyCancellation <- true { }
                    default { }
                }
                KillGroup(Environment.ProcessId, 2)
            }
        )
    }

    shared {
        internal func Create(directory string, budget RuntimeBudget) VerificationWorkspace {
            let workspace = VerificationWorkspace(directory, budget)
            try {
                let result = Commands.Run(
                    LocalPaths.NeedSystemTool("cp", directory),
                    []string{
                        "-a",
                        "--no-preserve=links",
                        "--reflink=auto",
                        "--",
                        workspace.Original + "/.",
                        workspace.Checkout
                    },
                    seconds: 86400,
                    isolated: true,
                    cancellation: workspace.CopyCancellation,
                    budget: budget
                )
                if result.Code != 0 || result.Truncated || result.ReadFailed {
                    throw Exception("Cannot copy the exact verification candidate: " + result.Error)
                }
                Verification.Validate(workspace.Checkout, budget)
                workspace.CheckCancellation()
                return workspace
            } catch (error Exception) {
                workspace.Dispose()
                throw error
            }
        }
    }

    internal func Unchanged(budget RuntimeBudget) {
        CheckCancellation()
        budget.Git(Checkout, "--work-tree=" + Checkout, "diff", "--exit-code", "--no-ext-diff", "--no-textconv")
    }

    internal func CheckCancellation() {
        if Cancelled {
            throw CliFailure("verification_failed", "Verification cancelled")
        }
    }

    private func Remove(directory string) {
        LocalPaths.DirectoryPath(directory)
        File.SetUnixFileMode(directory, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute)
        for entry in Directory.EnumerateFileSystemEntries(directory) {
            if FileInfo(entry).LinkTarget != nil {
                File.Delete(entry)
            } else if Directory.Exists(entry) {
                Remove(entry)
            } else {
                File.Delete(entry)
            }
        }
        Directory.Delete(directory)
    }

    public func Dispose() {
        try {
            Remove(Root)
        } finally {
            Termination.Dispose()
            Console.CancelKeyPress -= OnCancel
        }
    }
}

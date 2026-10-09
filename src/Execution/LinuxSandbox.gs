package Tokate

import System
import System.IO

internal class LinuxSandbox {
    shared {
        private func Setting(path string, value string) bool {
            try {
                return File.ReadAllText(path).Trim() == value
            } catch (error IOException) { } catch (error UnauthorizedAccessException) { }
            return false
        }

        internal func NamespaceFailure() CliFailure {
            if Setting("/proc/sys/user/max_user_namespaces", "0") ||
                Setting("/proc/sys/kernel/unprivileged_userns_clone", "0") {
                return CliFailure(
                    "namespace_disabled",
                    "User namespaces are disabled on this host or in this container. Ask an administrator to provide a host policy that permits Tokate's namespace isolation. Tokate does not change security policy."
                )
            }
            if Setting("/proc/sys/kernel/apparmor_restrict_unprivileged_userns", "1") {
                return CliFailure(
                    "namespace_restricted",
                    "Namespace startup was denied and AppArmor user-namespace restrictions are enabled. Ask an administrator to inspect AppArmor denials for unshare and bubblewrap and permit the required namespace operations. Tokate does not change security policy."
                )
            }
            return CliFailure(
                "namespace_unavailable",
                "Namespace startup failed. Ask an administrator to check kernel namespace support, namespace limits, container restrictions and security policy. Tokate does not change security policy."
            )
        }

        internal func ProbeFailure(result CommandResult, message string) CliFailure {
            for failure in[]string{
                "Creating new namespace failed",
                "No permissions to create new namespace",
                "bwrap: setting up uid map:",
                "Failed to make / slave"
            } {
                if result.Error.Contains(failure, StringComparison.Ordinal) {
                    return NamespaceFailure()
                }
            }
            return CliFailure("verification_failed", message)
        }
    }
}

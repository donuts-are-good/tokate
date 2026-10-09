# Linux sandbox policy

Tokate requires working user, PID, mount and network namespaces. It does not change
AppArmor, SELinux, sysctls or container security settings.

`tokate doctor --external --json` checks independent verification.
`tokate doctor --managed --json` also checks the selected harness sandbox.

| Diagnostic | Action |
| --- | --- |
| `missing_tools` | Install or repair the named executable. |
| `namespace_disabled` | Ask the administrator to review disabled user namespaces. |
| `namespace_restricted` | Namespace startup failed with AppArmor restrictions enabled. Ask the administrator to inspect the corresponding AppArmor denial. |
| `namespace_unavailable` | Check kernel support, namespace limits and container security policy. |
| `verification_failed` | Inspect the sandbox diagnostic. Namespace availability alone does not prove isolation works. |

## Ubuntu AppArmor

Stock Ubuntu 24.04 can deny the namespace operations used by Tokate. An
administrator can allow them for the installed Tokate executable while retaining
the global restriction. Replace the path below with its actual absolute path:

```text
abi <abi/4.0>,
profile tokate /absolute/path/to/tokate flags=(unconfined) {
  userns,
}
```

Save the profile as `/etc/apparmor.d/tokate`, load it with
`sudo apparmor_parser -r /etc/apparmor.d/tokate`, and rerun both doctor scopes as
the regular user. Review the profile again if the executable moves. This permits
namespace setup; Tokate's filesystem and network sandbox checks still must pass.

See [Ubuntu's AppArmor guidance](https://documentation.ubuntu.com/security/security-features/privilege-restriction/apparmor/).

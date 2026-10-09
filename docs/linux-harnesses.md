# Linux harness installations

Tokate is a native executable. npm, Bun and Node are not Tokate dependencies.
Pi requires Node. Existing npm or Bun harness installations are supported without
changing their update owner.

Selection order is `--harness-path`, trusted `PATH`, then documented fallback
locations. Automatic discovery skips executables inside the current checkout,
including symlinks into it. No shell startup files or credential files are read.

| Harness | Linux installation and discovery | Managed work |
| --- | --- | --- |
| Codex | [Native installer](https://learn.chatgpt.com/docs/config-file/environment-variables): `CODEX_INSTALL_DIR/codex`, default `~/.local/bin/codex`. Its package remains under `CODEX_HOME/packages/standalone`. npm and Bun entrypoints are also supported. | Supported, subject to doctor checks. |
| Pi | [Official installer](https://pi.dev/install.sh): `PI_CODING_AGENT_DIR`, default `~/.pi/agent`. The launcher can be in the agent's `bin` directory or a selected user bin directory. npm, Bun and Nix installations are also supported. | Supported, subject to doctor checks. |
| Claude | [Official setup](https://code.claude.com/docs/en/setup): native launcher `~/.local/bin/claude`, npm or distro packages. | Adapter unavailable. |
| OMP | [Official installer](https://github.com/can1357/oh-my-pi/blob/main/scripts/install.sh): `PI_INSTALL_DIR/omp`, default `~/.local/bin/omp`. Bun and Nix alternatives exist. | Adapter unavailable. |
| Hermes | [Official setup](https://hermes-agent.nousresearch.com/docs/getting-started/installation/): use the `~/.local/bin/hermes` launcher. `--dir` selects source independently of `HERMES_HOME` data. | Adapter unavailable. |

For npm, binaries are in [`NPM_CONFIG_PREFIX/bin`](https://docs.npmjs.com/cli/v11/commands/npm/).
For Bun, [`BUN_INSTALL_BIN`](https://bun.sh/docs/runtime/bunfig) selects the global
binary directory, default `~/.bun/bin`. Tokate uses these explicit paths without
reading `.npmrc` or `bunfig.toml`. Other custom locations require `PATH` or
`--harness-path`.

Tokate's confirmed Codex setup uses the official native installer. Its validated
package bubblewrap receives read-only runtime access; the authentication directory
does not. Pi's installation marker must identify the selected launcher. An unrelated
global npm package cannot establish a wrapper's identity.

Run `tokate doctor --managed --harness codex` or
`tokate doctor --managed --harness pi`. These check startup and isolation without
inference. An installed executable alone does not establish managed adapter support.

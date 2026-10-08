# Donate work

Use your own GitHub account and coding harness. Tokate needs Linux x86_64,
glibc 2.34+, Git, the GitHub CLI and bubblewrap with working user namespaces.
Project build tools must be accessible from system paths. Keep managed runs and
harness installations outside `/tmp`.

```sh
gh auth login
tokate status --repo OWNER/REPO
tokate policy --repo OWNER/REPO
```

Choose an approved, available issue. If access is required, request it and wait
for the owner to grant it:

```sh
tokate access --repo OWNER/REPO --operation request --issue 42 --scope trust
```

## Choose a tool

For Codex, use a current native installation with your ChatGPT login:

```sh
codex login
tokate doctor --managed --auth
tokate defaults set --model MODEL --effort EFFORT
tokate select --repo OWNER/REPO
```

Select an owner-allowed model and effort. The offline catalog and login check do
not prove account availability or remaining allowance. `defaults list` shows saved
choices. Add `--profile NAME` to keep several choices and select one per donation.
Profiles store neither budgets nor network consent.

### Local inference with Pi

Install current Pi and Node using [Pi's official instructions](https://pi.dev/).
Configure the model in Pi and start a no-auth HTTP loopback Chat Completions endpoint.
Tokate does not install a harness or start a model server. The owner must allow
`pi/local-chat-completions` and your exact model with `absent` effort.

```sh
tokate defaults set --profile local --harness pi --model 'MODEL_ID' \
  --effort absent --endpoint http://127.0.0.1:8080/v1
tokate select --repo OWNER/REPO --profile local
```

Tokate discovers the SDK and Node from supported npm or managed Pi installations.
For a custom layout, supply absolute `--pi-root` and `--node` paths. There is no
`/usr/bin/node` requirement. Pi's nonsecret SDK metadata must supply the configured
context and output limits. The endpoint must advertise the exact model at
`/v1/models`. Missing or incompatible metadata stops before inference. Remote
endpoints, authentication and paid Pi providers are not supported by this route.

## Claim, work and submit

For example, reserve one hour, including 20 minutes reserved for verification:

```sh
tokate claim https://github.com/OWNER/REPO/issues/42 --profile local \
  --seconds 3600 --verification-reserve 1200
```

Omit `--profile local` to use your default tool choice. Claiming spends no inference.
Tokate posts the request and prints the saved run directory. A pending request is
not a reservation. Wait for coordinator acceptance, then run:

```sh
tokate work --run RUN_DIRECTORY
tokate submit --run RUN_DIRECTORY
```

`work` spends the selected budget and independently verifies completed work.
`submit` requests the draft PR. Tokate discovers or creates your fork. Use `--fork`
only when you need to select one explicitly. You do not need to write request JSON.

`--seconds` caps coding plus verification time, not tokens or server billing.
Command network access defaults off. Downloads need both owner permission and
`--allow-network` on the new claim. Inference connectivity is separate. There is no
automatic retry, continuation or model fallback. Review [data and isolation limits](security.md).

## Check progress

Bare `tokate` offers repository status or saved contributions. Saved inspection
works offline and requires explicit selection. For scripts or a custom run path:

```sh
tokate status --run RUN_DIRECTORY
tokate checks --repo OWNER/REPO --pr 10 --watch
```

Follow the reported next action. Quiet output does not justify restarting work.
Keep the saved directory for [recovery and review changes](recovery.md). The owner
reviews and merges. Older assignment-bound repositories retain their existing
workflow, which can publish from `work`; inspect their policy before starting.

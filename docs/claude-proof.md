# Native Claude checks

Managed Claude execution remains disabled. These checks do not establish a
working donation adapter or subscription availability.

```sh
python3 scripts/claude-download.py --output /tmp/claude
python3 scripts/claude-proof.py --claude /tmp/claude
```

The helper resolves the official latest channel and verifies manifest size and
SHA256. Ordinary synthetic fixtures cover native file and command tools, exact
model requests, command networking, cancellation and child cleanup without
external inference. Reports omit effort, which is checked only in the synthetic
request. Authentication stays in Claude; Tokate retains only bounded native
login metadata. Real subscription use and credential isolation remain unverified.

Use `tokate help claude-capabilities` for the diagnostic gate. Configuration follows
[Claude's CLI](https://code.claude.com/docs/en/cli-reference) and
[sandboxing controls](https://code.claude.com/docs/en/sandboxing).

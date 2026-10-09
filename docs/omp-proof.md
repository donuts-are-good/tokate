# Native OMP proof

Managed OMP is disabled. Use the normal installed SDK and Bun runtime:

```sh
python3 scripts/omp-proof.py --omp-root /installed/node_modules --bun /installed/bun
```

The proof installs nothing, uses synthetic configuration and local protocol
responses, and records the official latest release and actual tested versions.
It tests configured model metadata, native tools, transport, completion and
cleanup without real credentials or inference.

OMP 18.8.6 with Bun 1.4.2: 26 cases passed and 3 were blocked. Commands can reach
the inference loopback network, restricted sessions ignore the tested inline
command hook, and unsupported PTY requests execute a fallback. These blocks
prevent managed support. Exit 1 and the final JSON record report blocked or
failed cases. Passing cases do not establish a working donation adapter.

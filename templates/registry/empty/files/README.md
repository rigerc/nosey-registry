# Nosey registry

This registry holds Nosey data documents. Edit the JSON files directly, then run
the generator to canonicalize them and refresh the manifest and lock:

```sh
nosey registry generate .
```

`registry generate --check` verifies the data is canonical and that the manifest
and lock are current. It never writes. Run it in CI before merging.

`registry refresh .` is only meaningful when `nosey.registry.config.json`
declares `upstreams`; it fetches those files, then regenerates. Registries
without upstreams are left unchanged.

Generated files:

- `nosey.registry.json` — the runtime manifest (identity, files, templates)
- `nosey.registry.lock.json` — input hashes, resolved upstream revisions, counts

Commit both generated files with any data change.

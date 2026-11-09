# Official Nosey Registry

The official [Nosey](https://github.com/rigerc/nosey-9) registry is a catalog of agent skills, technologies, detection rules, and skill recommendations. Nosey uses this registry to suggest skills relevant to the technologies in a workspace and to resolve their upstream sources when installing them.

**[Browse the official registry](https://rigerc.github.io/nosey-9/)** to explore the published catalog. The browser is generated and deployed from the [Nosey application repository](https://github.com/rigerc/nosey-9); this repository maintains the registry data.

## Use the registry with Nosey

Nosey uses the official registry by default, fetching and retaining validated snapshots for offline use. Install Nosey using the instructions in the [application README](https://github.com/rigerc/nosey-9#build-and-run), then run it in a project:

```sh
nosey --cwd /path/to/project scan --json
nosey --cwd /path/to/project search nextjs --json
nosey --cwd /path/to/project doctor --json
```

Search returns skill IDs you can use to install selected skills into your project:

```sh
nosey --cwd /path/to/project install SKILL_ID --agent codex --yes
nosey --cwd /path/to/project list --json
```

Replace `SKILL_ID` with an ID returned by search and select the agent you use. The [Nosey README](https://github.com/rigerc/nosey-9#discover-and-install) covers interactive installs, other agents, updates, and uninstallation.

## What is in this registry?

| Path | Purpose |
| --- | --- |
| `technologies.json` | Technologies and the rules Nosey uses to detect them in workspaces |
| `skills.json` | Skill metadata, technology associations, and upstream source references |
| `mappings.json` | Recommendations linking detected technologies to skills |
| `repositories.json` | Metadata for source repositories |
| `nosey.registry.config.json` | Authoring configuration for this registry |
| `nosey.registry.json` | Generated registry manifest read by Nosey |
| `nosey.registry.lock.json` | Generated lock information for reproducible registry data |
| `assessments/` | Additional quality, evaluation, and source-location data |
| `templates/registry/empty/` | Starter template for creating your own registry |

The JSON files describe skills and their sources; the registry does **not** vendor the underlying skill content.

## Create or add a custom registry

To maintain a separate catalog, initialize a registry from the bundled `empty` template:

```sh
nosey registry init /absolute/path/to/my-registry --ci github --yes
nosey registry generate /absolute/path/to/my-registry
nosey registry add /absolute/path/to/my-registry --id user:local
nosey registry list --json
```

The `--ci github` option is optional and adds GitHub validation and regeneration automation. See the [custom registry template README](templates/registry/empty/files/README.md) for configuring and populating the generated files.

## Contribute or maintain registry data

Make changes to the relevant authoring JSON files and run Nosey's generator to update and check the derived manifest and lock:

```sh
nosey registry generate .
nosey registry generate . --check
```

For documents configured with an upstream source, `nosey registry refresh .` updates the corresponding upstream-backed data. Open a pull request with the relevant source and generated changes; the repository's workflows also validate and regenerate registry data. Avoid manually editing generated manifests, locks, or the statistics table below.

## Provenance and licensing

The data was originally seeded from [skills-catalog](https://github.com/rigerc/skills-catalog) and is now maintained in this repository. Each skill points to an upstream source. Skill content remains subject to its upstream license; Nosey's application MIT license does not relicense registry data or third-party skills. See [NOTICE.md](NOTICE.md) for details.

<!-- BEGIN GENERATED REGISTRY STATS -->
## Registry statistics

| Metric | Count |
| :- | :- |
| Skills | 912 |
| Technologies | 899 |
| Mapping entries | 271 |
| Source repositories | 143 |
<!-- END GENERATED REGISTRY STATS -->

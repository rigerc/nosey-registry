# Curated Agent Skills Registry

A curated catalog of **agent skills** from upstream repositories, organized by technology and enriched with recommendations, source references, and quality assessments. Browse skills, compare sources, and find relevant additions to your coding workflow.

**[Browse the curated skill catalog](https://rigerc.github.io/nosey-9/)** — explore the published registry directly in your browser. No Nosey installation is needed to browse.

This repository maintains the catalog data; the browser is built and published from the [Nosey application repository](https://github.com/rigerc/nosey-9). [Nosey](https://github.com/rigerc/nosey-9) can use the registry to discover relevant skills for your workspace and install them.

<!-- BEGIN GENERATED REGISTRY STATS -->
## Registry statistics

<table>
  <tr>
    <th align="center">Skills</th>
    <th align="center">Technologies</th>
    <th align="center">Mapping entries</th>
    <th align="center">Source repositories</th>
  </tr>
  <tr>
    <td align="center"><h2>912</h2></td>
    <td align="center"><h2>899</h2></td>
    <td align="center"><h2>271</h2></td>
    <td align="center"><h2>143</h2></td>
  </tr>
</table>
<!-- END GENERATED REGISTRY STATS -->

## Explore the catalog

The registry brings together curated skill entries, the technologies they support, recommendations for when to use them, and links back to their upstream sources. The [registry browser](https://rigerc.github.io/nosey-9/) is the easiest way to explore this data; the JSON files below are available for tooling and integrations.

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

For documents configured with an upstream source, `nosey registry refresh .` updates the corresponding upstream-backed data. Open a pull request with the relevant source and generated changes; the repository's workflows also validate and regenerate registry data. Avoid manually editing generated manifests, locks, or the registry statistics at the top of this README.

## Provenance and licensing

The data was originally seeded from [skills-catalog](https://github.com/rigerc/skills-catalog) and is now maintained in this repository. Each skill points to an upstream source. Skill content remains subject to its upstream license; Nosey's application MIT license does not relicense registry data or third-party skills. See [NOTICE.md](NOTICE.md) for details.

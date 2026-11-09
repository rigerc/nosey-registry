# Custom Nosey Registry

This is a starter registry for [Nosey](https://github.com/rigerc/nosey-9), a tool that discovers technologies in a workspace and recommends agent skills. Customize the registry's identity, technology rules, skills, and recommendations to publish a catalog for your own projects or team.

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
    <td align="center"><h2>0</h2></td>
    <td align="center"><h2>0</h2></td>
    <td align="center"><h2>0</h2></td>
    <td align="center"><h2>0</h2></td>
  </tr>
</table>
<!-- END GENERATED REGISTRY STATS -->

## Initialize a registry

If this README was created by `nosey registry init`, your starter files already exist; continue with **Configure your registry**. To create another registry from the official template:

```sh
nosey registry init ./my-registry --ci github --yes
cd my-registry
```

`--ci github` is optional. It adds GitHub Actions for validating, regenerating, and refreshing a hosted registry. See the [Nosey application README](https://github.com/rigerc/nosey-9#settings-and-registries) for other initialization options.

## Configure your registry

Edit `nosey.registry.config.json` before publishing:

- Set `registry.id` to a stable, unique ID and `registry.name` to a meaningful display name. The starter values (`local:example` and `Example Registry`) are placeholders.
- Leave the `manifest` and `files` paths at their defaults unless you also change the corresponding file layout.

The configuration is the authoring input. `nosey.registry.json` is the generated manifest, and `nosey.registry.lock.json` records generated state; do not edit either by hand.

## Add technologies and skills

Edit the JSON documents in the registry root:

| File | What to add |
| --- | --- |
| `repositories.json` | Information about repositories supplying skills |
| `technologies.json` | Technologies and workspace detection rules |
| `skills.json` | Skills, descriptions, technology associations, and source references |
| `mappings.json` | Recommendations connecting technology IDs to skill IDs |

Use consistent IDs across files: a mapping's `technologyId` must refer to a technology, and each recommendation's `skillId` must refer to a skill. The source documents allow authoring overlays; the generator checks and produces the effective registry data. Refer to the [registry JSON schemas](https://github.com/rigerc/nosey-registry/tree/main/schemas) and [official registry examples](https://github.com/rigerc/nosey-registry) for field definitions and valid structures.

## Generate and validate

From the registry root, regenerate derived files after changing authoring data:

```sh
nosey registry generate .
nosey registry generate . --check
```

`generate` writes canonical registry output, including the manifest and lock; `--check` verifies that the committed generated output is up to date without rewriting files. Commit generated changes alongside their authoring inputs.

To refresh inputs that declare an upstream source:

```sh
nosey registry refresh .
nosey registry generate . --check
```

Only files configured for upstream refresh are affected; a new empty registry does not require this step.

## Use this registry with Nosey

Register the completed registry using its absolute filesystem path:

```sh
nosey registry add /absolute/path/to/my-registry --id user:local
nosey registry list --json
```

Nosey also supports project-proposed registries, which require explicit trust approval. Review those proposals with `nosey trust`. For scanning, searching, and installing skills, follow the [Nosey user guide](https://github.com/rigerc/nosey-9#discover-and-install).

## Optional GitHub automation

When initialized with `--ci github`, this scaffold includes `.github/workflows/registry.yml` and `.github/scripts/registry-readme-stats.mjs`. The workflow checks generated output on pull requests, can propose regeneration changes after pushes, and can refresh upstream data on its schedule or by manual dispatch. It also keeps the statistics near the top of this README current. Review proposed generated changes before merging them.

The statistics summary near the top is maintained automatically when the GitHub workflow is enabled. Keep its comment markers intact so the updater can replace the generated section.

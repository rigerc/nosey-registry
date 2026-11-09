import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectStats,
  countRegistryStats,
  renderStatsCards,
  replaceSection,
  isSafeRelativePath,
} from '../scripts/registry-readme-stats.mjs';

function makeRegistry(files) {
  const root = mkdtempSync(join(tmpdir(), 'registry-stats-'));
  const config = {
    schemaVersion: 1,
    registry: { id: 'test:registry', name: 'Test' },
    manifest: 'nosey.registry.json',
    files: {
      technologies: 'technologies.json',
      skills: 'skills.json',
      mappings: 'mappings.json',
      ...files.config,
    },
  };
  if (files.repositories !== undefined) {
    config.files.repositories = files.repositories;
  } else if (files.includeRepositories !== false) {
    config.files.repositories = 'repositories.json';
  }
  if (files.includeRepositories === false) {
    delete config.files.repositories;
  }
  writeFileSync(join(root, 'nosey.registry.config.json'), JSON.stringify(config));
  writeFileSync(join(root, 'technologies.json'), JSON.stringify({ technologies: files.technologies ?? [] }));
  writeFileSync(join(root, 'skills.json'), JSON.stringify({ skills: files.skills ?? [] }));
  writeFileSync(join(root, 'mappings.json'), JSON.stringify({ mappings: files.mappings ?? [] }));
  if (files.repositoriesFile !== undefined) {
    writeFileSync(join(root, files.repositories ?? 'repositories.json'), JSON.stringify({ repositories: files.repositoriesFile }));
  } else if (files.includeRepositories !== false) {
    writeFileSync(join(root, 'repositories.json'), JSON.stringify({ repositories: files.repositoriesArray ?? [] }));
  }
  if (files.customPaths) {
    for (const [name, value] of Object.entries(files.customPaths)) {
      mkdirSync(join(root, ...name.split('/').slice(0, -1)), { recursive: true });
      writeFileSync(join(root, name), JSON.stringify(value));
    }
  }
  return root;
}

test('empty registry produces four zero counts', () => {
  const root = makeRegistry({});
  assert.deepEqual(countRegistryStats(root), {
    skills: 0,
    technologies: 0,
    mappings: 0,
    repositories: 0,
  });
  const result = collectStats(root);
  assert.equal(result.json, JSON.stringify([
    { Metric: 'Skills', Count: '0' },
    { Metric: 'Technologies', Count: '0' },
    { Metric: 'Mapping entries', Count: '0' },
    { Metric: 'Source repositories', Count: '0' },
  ]));
});

test('populated registry returns expected counts and stable row order', () => {
  const root = makeRegistry({
    technologies: [{ id: 't1' }, { id: 't2' }],
    skills: [{ id: 's1' }],
    mappings: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }],
    repositoriesArray: [{ id: 'r1' }, { id: 'r2' }],
  });
  assert.deepEqual(countRegistryStats(root), {
    skills: 1,
    technologies: 2,
    mappings: 3,
    repositories: 2,
  });
});

test('optional repositories file omitted yields zero', () => {
  const root = makeRegistry({ includeRepositories: false });
  assert.equal(countRegistryStats(root).repositories, 0);
});

test('custom document paths are respected', () => {
  const root = makeRegistry({
    technologies: [],
    skills: [],
    mappings: [],
    repositoriesArray: [],
    config: {
      technologies: 'data/tech.json',
      skills: 'data/skill.json',
      mappings: 'data/map.json',
      repositories: 'data/repo.json',
    },
    customPaths: {
      'data/tech.json': { technologies: [{ id: 't' }] },
      'data/skill.json': { skills: [{ id: 'a' }, { id: 'b' }] },
      'data/map.json': { mappings: [{ id: 'm' }] },
      'data/repo.json': { repositories: [{ id: 'r' }, { id: 'r2' }, { id: 'r3' }] },
    },
  });
  mkdirSync(join(root, 'data'), { recursive: true });
  // Recreate files because makeRegistry wrote before directory existed; redo manually.
  rmSync(root, { recursive: true, force: true });
  const root2 = mkdtempSync(join(tmpdir(), 'registry-stats-'));
  const config = {
    schemaVersion: 1,
    registry: { id: 'test:registry', name: 'Test' },
    manifest: 'nosey.registry.json',
    files: {
      technologies: 'data/tech.json',
      skills: 'data/skill.json',
      mappings: 'data/map.json',
      repositories: 'data/repo.json',
    },
  };
  mkdirSync(join(root2, 'data'), { recursive: true });
  writeFileSync(join(root2, 'nosey.registry.config.json'), JSON.stringify(config));
  writeFileSync(join(root2, 'data/tech.json'), JSON.stringify({ technologies: [{ id: 't' }] }));
  writeFileSync(join(root2, 'data/skill.json'), JSON.stringify({ skills: [{ id: 'a' }, { id: 'b' }] }));
  writeFileSync(join(root2, 'data/map.json'), JSON.stringify({ mappings: [{ id: 'm' }] }));
  writeFileSync(join(root2, 'data/repo.json'), JSON.stringify({ repositories: [{ id: 'r' }, { id: 'r2' }, { id: 'r3' }] }));
  assert.deepEqual(countRegistryStats(root2), {
    skills: 2,
    technologies: 1,
    mappings: 1,
    repositories: 3,
  });
});

test('missing required file fails', () => {
  const root = makeRegistry({});
  rmSync(join(root, 'skills.json'));
  assert.throws(() => countRegistryStats(root));
});

test('wrong array type fails', () => {
  const root = makeRegistry({});
  writeFileSync(join(root, 'mappings.json'), JSON.stringify({ mappings: 'not-array' }));
  assert.throws(() => countRegistryStats(root));
  writeFileSync(join(root, 'technologies.json'), JSON.stringify([{ id: 't' }]));
  assert.throws(() => countRegistryStats(root));
});

test('invalid JSON fails', () => {
  const root = makeRegistry({});
  writeFileSync(join(root, 'skills.json'), '{bad');
  assert.throws(() => countRegistryStats(root));
});

test('unsafe file paths fail', () => {
  const root = makeRegistry({});
  const config = JSON.parse(readFileSync(join(root, 'nosey.registry.config.json'), 'utf8'));
  config.files.skills = '../outside.json';
  writeFileSync(join(root, 'nosey.registry.config.json'), JSON.stringify(config));
  assert.throws(() => countRegistryStats(root));
  assert.equal(isSafeRelativePath('../x'), false);
  assert.equal(isSafeRelativePath('a/../b'), false);
  assert.equal(isSafeRelativePath('/abs'), false);
  assert.equal(isSafeRelativePath('a\\b'), false);
});

test('collect JSON uses compact one-line array with identical ordered keys', () => {
  const root = makeRegistry({
    technologies: [{ id: 't' }],
    skills: [{ id: 's' }],
    mappings: [{ id: 'm' }],
    repositoriesArray: [{ id: 'r' }],
  });
  const { json } = collectStats(root);
  assert.equal(json.includes('\n'), false);
  const parsed = JSON.parse(json);
  assert.equal(parsed.length, 4);
  for (const row of parsed) {
    assert.deepEqual(Object.keys(row), ['Metric', 'Count']);
  }
});

test('replacement preserves unrelated content and is idempotent', () => {
  const before = '# Title\n\nIntro.\n\n';
  const after = '\nFooter.\n';
  const table = '| Metric | Count |\n| :-- | :-- |\n| Skills | 2 |';
  const initial = `${before}<!-- BEGIN GENERATED REGISTRY STATS -->\n## Registry statistics\n\n| Metric | Count |\n| :-- | :-- |\n| Skills | 0 |\n<!-- END GENERATED REGISTRY STATS -->${after}`;
  const replaced = replaceSection(initial, table);
  assert.match(replaced, /Skills \| 2/);
  assert.ok(replaced.startsWith(before));
  assert.ok(replaced.endsWith(after));
  const second = replaceSection(replaced, table);
  assert.equal(second, replaced);
});

test('replacement rejects missing, duplicate, and reversed markers', () => {
  const table = '| Metric | Count |\n| :-- | :-- |\n| Skills | 1 |';
  assert.throws(() => replaceSection('no markers', table));
  assert.throws(() => replaceSection('<!-- BEGIN GENERATED REGISTRY STATS -->\n<!-- BEGIN GENERATED REGISTRY STATS -->\n<!-- END GENERATED REGISTRY STATS -->', table));
  assert.throws(() => replaceSection('<!-- END GENERATED REGISTRY STATS -->\n<!-- BEGIN GENERATED REGISTRY STATS -->', table));
});

test('fixed labels prevent pipe or newline injection', () => {
  const root = makeRegistry({
    technologies: [{ name: 'a|b\nc' }],
    skills: [],
    mappings: [],
    repositoriesArray: [],
  });
  const { json } = collectStats(root);
  assert.equal(json, JSON.stringify([
    { Metric: 'Skills', Count: '0' },
    { Metric: 'Technologies', Count: '1' },
    { Metric: 'Mapping entries', Count: '0' },
    { Metric: 'Source repositories', Count: '0' },
  ]));
});

test('stats cards emphasize current counts and are safe to refresh', () => {
  const cards = renderStatsCards({
    skills: 1234,
    technologies: 7,
    mappings: 12,
    repositories: 5,
  });
  assert.match(cards, /<th align="center">Skills<\/th>/);
  assert.match(cards, /<h2>1,234<\/h2>/);
  assert.match(cards, /<h2>7<\/h2>/);
  assert.match(cards, /<h2>12<\/h2>/);
  assert.match(cards, /<h2>5<\/h2>/);
  assert.throws(() => renderStatsCards({
    skills: '<script>',
    technologies: 0,
    mappings: 0,
    repositories: 0,
  }));

  const readme = '# Registry\n\n<!-- BEGIN GENERATED REGISTRY STATS -->\nOld\n<!-- END GENERATED REGISTRY STATS -->\n\nContent.\n';
  const next = replaceSection(readme, cards);
  assert.match(next, /<table>/);
  assert.ok(next.indexOf('<!-- BEGIN GENERATED REGISTRY STATS -->') < next.indexOf('Content.'));
  assert.equal(replaceSection(next, cards), next);
});

test('scaffold helper is byte-identical to canonical script', () => {
  const canonical = readFileSync(new URL('../scripts/registry-readme-stats.mjs', import.meta.url), 'utf8');
  const scaffold = readFileSync(new URL('../templates/registry/empty/files/ci/github/registry-readme-stats.mjs', import.meta.url), 'utf8');
  assert.equal(scaffold, canonical);
});
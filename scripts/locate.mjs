#!/usr/bin/env node
/**
 * Record where each pinned skill's SKILL.md lives (assessments/locations.json).
 * skills.json carries only the repository, commit and skill name, so a path has
 * to be discovered once per pin. Git transport only (blobless fetch + ls-tree).
 *
 *   node scripts/locate.mjs --check          count skills without a current location (no network)
 *   node scripts/locate.mjs --write          discover and record missing/stale locations
 * Options: --max-groups N
 */
import {mkdtempSync, rmSync, appendFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {LOCATIONS_FILE, assertOfficial, loadRegistry, loadLocations, resolvePins, serializeLocations,
  safeSkillPath, parseArgs, writeJson} from './lib.mjs';
import {fetchGroup} from './quality.mjs';

/**
 * Candidates are SKILL.md files whose directory name equals the skill name; a
 * repository-root SKILL.md matches the repository name. Only a unique match is
 * accepted, so a location is never guessed.
 */
export function chooseLocation(paths, skillName, repoName) {
  const hits = paths.filter(path => {
    if (!safeSkillPath(path)) return false;
    if (path === 'SKILL.md') return repoName.toLowerCase() === skillName.toLowerCase();
    return path.slice(0, -'/SKILL.md'.length).split('/').at(-1) === skillName;
  });
  if (hits.length === 1) return {ok: true, path: hits[0]};
  return {ok: false, reason: hits.length ? 'ambiguous: ' + hits.slice(0, 5).join(', ') : 'no SKILL.md named ' + skillName};
}

export async function locateGroup(group, {base, exec} = {}) {
  const work = mkdtempSync(join(tmpdir(), 'locate-'));
  try {
    const fetched = await fetchGroup({repo: group.repo, commit: group.commit, skills: [{dir: ''}]}, work, {base, exec});
    if (!fetched.ok) return group.pins.map(pin => ({pin, error: fetched.code + ': ' + fetched.message}));
    const tree = await fetched.git(['ls-tree', '-r', '--name-only', '-z', 'FETCH_HEAD'], {timeout: 120000});
    if (tree.code !== 0 || tree.stdoutTruncated) return group.pins.map(pin => ({pin, error: 'could not list the pinned tree'}));
    const paths = tree.out.split('\0').filter(p => p === 'SKILL.md' || p.endsWith('/SKILL.md'));
    return group.pins.map(pin => {
      const choice = chooseLocation(paths, pin.skillName, group.repo.split('/')[1]);
      return choice.ok ? {pin, path: choice.path} : {pin, error: choice.reason};
    });
  } finally {rmSync(work, {recursive: true, force: true});}
}

export function groupPins(pins) {
  const groups = new Map();
  for (const pin of pins) {
    const key = pin.repo.toLowerCase() + '@' + pin.commit;
    if (!groups.has(key)) groups.set(key, {repo: pin.repo, commit: pin.commit, pins: []});
    groups.get(key).pins.push(pin);
  }
  return [...groups.values()].sort((a, b) => (a.repo + a.commit).localeCompare(b.repo + b.commit));
}

async function main(argv) {
  const opts = parseArgs(argv, {check: 'bool', write: 'bool', 'max-groups': 'value'});
  if (!opts.check && !opts.write) throw new Error('Usage: locate.mjs --check | --write [--max-groups N]');
  assertOfficial();
  const locations = loadLocations();
  const {unlocated} = resolvePins(loadRegistry().skills, locations);
  const groups = groupPins(unlocated).slice(0, Number(opts['max-groups'] ?? Infinity));
  console.log('Skills needing a location: ' + unlocated.length + ' across ' + groups.length + ' repository groups');
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, 'unlocated=' + unlocated.length + '\n');
  if (opts.check || !groups.length) return;
  let failures = 0;
  for (const group of groups) {
    for (const r of await locateGroup(group)) {
      if (r.error) {failures++; console.log('::warning title=locate::' + r.pin.id + ': ' + r.error); continue;}
      locations.set(r.pin.id, {commit: r.pin.commit, path: r.path});
    }
  }
  const live = new Set(loadRegistry().skills.map(s => s.id));
  for (const id of [...locations.keys()]) if (!live.has(id)) locations.delete(id);
  console.log((writeJson(LOCATIONS_FILE, serializeLocations(locations)) ? 'Wrote ' : 'No changes to ') + LOCATIONS_FILE +
    (failures ? ' (' + failures + ' unresolved)' : ''));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {console.error(error.stack ?? error.message); process.exitCode = 1;});
}

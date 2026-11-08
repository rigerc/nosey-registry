// Shared helpers for the official registry's assessment tooling.
// Everything here is offline: it reads the registry data and the committed
// assessments, never the network.
import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync, existsSync, mkdirSync, renameSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const OFFICIAL_ID = 'nosey:official';
export const CONFIG_FILE = 'nosey.registry.config.json';
export const QUALITY_FILE = 'assessments/quality.json';
export const SCORES_FILE = 'assessments/scores.json';
export const LOCATIONS_FILE = 'assessments/locations.json';
export const WAIVERS_FILE = 'assessments/quality-waivers.json';
export const PROBES_FILE = 'assessments/pin-probes.json';
export const SHA40 = /^[0-9a-f]{40}$/;
export const SHA64 = /^[0-9a-f]{64}$/;

export const sha256 = data => createHash('sha256').update(data).digest('hex');
export const readJson = (file, otherwise = undefined) => {
  const path = resolve(ROOT, file);
  if (!existsSync(path)) {
    if (otherwise !== undefined) return otherwise;
    throw new Error(file + ' is missing');
  }
  return JSON.parse(readFileSync(path, 'utf8'));
};

/** Atomic write; returns false when the file already has identical bytes. */
export function writeText(file, text) {
  const path = resolve(ROOT, file);
  if (existsSync(path) && readFileSync(path, 'utf8') === text) return false;
  mkdirSync(dirname(path), {recursive: true});
  const tmp = path + '.' + process.pid + '.tmp';
  writeFileSync(tmp, text);
  renameSync(tmp, path);
  return true;
}
export const writeJson = (file, value) => writeText(file, JSON.stringify(value, null, 2) + '\n');

/** The tooling is official-registry-only: refuse anything else loudly. */
export function assertOfficial(config = readJson(CONFIG_FILE)) {
  if (config.registry?.id !== OFFICIAL_ID) {
    throw new Error('Assessments are maintained for ' + OFFICIAL_ID + ' only (found ' + config.registry?.id + ')');
  }
  return config;
}

export function loadRegistry(root = ROOT) {
  const read = file => JSON.parse(readFileSync(resolve(root, file), 'utf8'));
  const config = read(CONFIG_FILE);
  const skills = read(config.files.skills);
  return {config, skillsDoc: skills, skills: skills.skills};
}

/** owner/repo of a GitHub https URI; throws for anything else. */
export function repoOf(uri) {
  const url = new URL(uri);
  const parts = url.pathname.replace(/\.git$/, '').split('/').filter(Boolean);
  if (url.origin !== 'https://github.com' || parts.length !== 2 || url.search || url.hash ||
      !parts.every(p => /^[A-Za-z0-9._-]+$/.test(p) && p !== '.' && p !== '..')) {
    throw new Error('Unsupported skill repository URI: ' + uri);
  }
  return parts.join('/');
}

/** A skill's immutable upstream coordinates, or null when it is not commit-pinned. */
export function pinOf(skill) {
  const {source} = skill;
  if (source?.kind !== 'git' || !SHA40.test(source.ref ?? '')) return null;
  return {id: skill.id, repo: repoOf(source.uri), commit: source.ref, skillName: source.skillName};
}

const SAFE_PATH = /^[A-Za-z0-9._@+()-]+(?:\/[A-Za-z0-9._@+()-]+)*$/;
export const safeSkillPath = path => typeof path === 'string' && SAFE_PATH.test(path) &&
  (path === 'SKILL.md' || path.endsWith('/SKILL.md')) && !path.split('/').some(p => p === '.' || p === '..');

/**
 * Locations map a pinned skill to its SKILL.md path. A location is valid only
 * for the commit it was recorded at; a re-pin makes it stale until relocated.
 */
export function loadLocations() {
  const doc = readJson(LOCATIONS_FILE, {schema_version: 1, locations: {}});
  return new Map(Object.entries(doc.locations));
}
export function serializeLocations(map) {
  const locations = Object.fromEntries([...map].sort(([a], [b]) => (a < b ? -1 : 1)));
  return {schema_version: 1, registry_id: OFFICIAL_ID, locations};
}

/** Pinned skills with a usable location. `dir` is '' for a repository-root skill. */
export function resolvePins(skills, locations) {
  const located = [];
  const unlocated = [];
  for (const skill of skills) {
    // Quarantined skills are not evaluated: their upstream is gone and nothing should depend on it.
    if (skill.quarantine) continue;
    const pin = pinOf(skill);
    if (!pin) continue;
    const loc = locations.get(skill.id);
    if (loc && loc.commit === pin.commit && safeSkillPath(loc.path)) {
      located.push({...pin, path: loc.path, dir: loc.path === 'SKILL.md' ? '' : loc.path.slice(0, -'/SKILL.md'.length)});
    } else unlocated.push(pin);
  }
  return {located, unlocated};
}

/** Skills added or re-pinned between two skills.json documents. */
export function changedSkills(headSkills, baseSkills) {
  const old = new Map(baseSkills.map(s => [s.id, s]));
  return headSkills.filter(s => {
    const prev = old.get(s.id);
    return !prev || prev.source?.ref !== s.source?.ref || prev.source?.uri !== s.source?.uri ||
      prev.source?.skillName !== s.source?.skillName;
  }).map(s => s.id);
}

export const pagesUrl = (repo, commit, path) => 'https://github.com/' + repo + '/blob/' + commit + '/' + path;
export const rawUrl = (repo, commit, path) => 'https://raw.githubusercontent.com/' + repo + '/' + commit + '/' +
  path.split('/').map(encodeURIComponent).join('/');

export function parseArgs(argv, flags) {
  const out = {_: []};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {out._.push(a); continue;}
    const name = a.slice(2);
    const spec = flags[name];
    if (spec === undefined) throw new Error('Unknown argument: ' + a);
    if (spec === 'bool') out[name] = true;
    else {
      if (i + 1 >= argv.length) throw new Error('Missing value for ' + a);
      out[name] = argv[++i];
    }
  }
  return out;
}

#!/usr/bin/env node
/**
 * Project the assessments onto the registry data the Nosey CLI reads:
 *   skills.json                  quality, score, assessment on each skill
 *   nosey.registry.config.json   repositoryScores (mean score per repository)
 *
 * The assessments are the source of truth; this is a pure function of them, so
 * CI can run `sync.mjs --check` to reject hand-edited or out-of-date results.
 * Skills carrying a non-automated (manual) assessment are never touched.
 * After --write, run `nosey registry generate .` to refresh the lock file.
 *
 *   node scripts/sync.mjs --check | --write
 */
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ROOT, CONFIG_FILE, QUALITY_FILE, SCORES_FILE, assertOfficial, loadRegistry, loadLocations, resolvePins,
  readJson, writeText, parseArgs} from './lib.mjs';
import {TOOL, fingerprint as qualityFingerprint, isCurrent as qualityCurrent} from './quality.mjs';
import {evaluator, current as scoreCurrent} from './jev.mjs';

/** pass → excellent, warn → good, fail → fair (one error) or poor (more). Not evaluated → no label. */
export function qualityLabel(entry) {
  if (!entry || entry.status === 'not_evaluated') return null;
  if (entry.status === 'pass') return 'excellent';
  if (entry.status === 'warn') return 'good';
  return entry.counts.errors > 1 ? 'poor' : 'fair';
}

/** Open JEV scores are 1..5 means; the registry scale is 0..100. */
export const scoreOf = overall => Math.round(overall / 5 * 1000) / 10;
const mean = xs => Math.round(xs.reduce((a, b) => a + b, 0) / xs.length * 100) / 100;
const day = timestamp => timestamp.slice(0, 10);

export function project({skills, config, pins, quality, scores}) {
  const qFp = qualityFingerprint();
  const sFp = evaluator().fingerprint;
  const qualityById = new Map((quality?.entries ?? []).map(e => [e.id, e]));
  const scoreById = new Map((scores?.entries ?? []).map(e => [e.id, e]));
  const perRepository = new Map();
  const next = skills.map(skill => {
    if (skill.assessment && skill.assessment.method !== 'automated') return skill;
    const {quality: _q, score: _s, assessment: _a, ...base} = skill;
    const pin = pins.get(skill.id);
    const q = pin && qualityCurrent(qualityById.get(skill.id), pin, qFp) ? qualityById.get(skill.id) : null;
    const s = pin && scoreCurrent(scoreById.get(skill.id), pin, sFp) ? scoreById.get(skill.id) : null;
    const label = qualityLabel(q);
    const score = s ? scoreOf(s.overall_score) : null;
    if (label === null && score === null) return base;
    const assessors = [];
    const dates = [];
    if (label !== null) {assessors.push('skill-validator ' + TOOL.version); dates.push(day(q.evaluated_at));}
    if (score !== null) {assessors.push('Open JEV ' + scores.evaluator.model_release); dates.push(day(s.evaluated_at));}
    if (score !== null && skill.repositoryId) {
      if (!perRepository.has(skill.repositoryId)) perRepository.set(skill.repositoryId, []);
      perRepository.get(skill.repositoryId).push(score);
    }
    return {...base, ...(label !== null ? {quality: label} : {}), ...(score !== null ? {score} : {}),
      assessment: {method: 'automated', assessedAt: dates.sort().at(-1), assessor: assessors.join(' + ')}};
  });
  const repositoryScores = Object.fromEntries([...perRepository].sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([id, values]) => [id, {averageScore: mean(values), scoreCount: values.length}]));
  const nextConfig = {};
  for (const [key, value] of Object.entries(config)) {
    if (key === 'repositoryScores') continue;
    if (key === 'source' && Object.keys(repositoryScores).length) nextConfig.repositoryScores = repositoryScores;
    nextConfig[key] = value;
  }
  if (Object.keys(repositoryScores).length && !('repositoryScores' in nextConfig)) nextConfig.repositoryScores = repositoryScores;
  return {skills: next, config: nextConfig};
}

export function render(registry, pins, quality, scores) {
  const {skills, config} = project({skills: registry.skills, config: registry.config, pins, quality, scores});
  return {
    skills: JSON.stringify({...registry.skillsDoc, skills}, null, 2) + '\n',
    config: JSON.stringify(config, null, 2) + '\n',
  };
}

async function main(argv) {
  const opts = parseArgs(argv, {check: 'bool', write: 'bool'});
  if (!opts.check && !opts.write) throw new Error('Usage: sync.mjs --check | --write');
  const config = assertOfficial();
  const registry = loadRegistry();
  const {located} = resolvePins(registry.skills, loadLocations());
  const pins = new Map(located.map(p => [p.id, p]));
  const text = render(registry, pins, readJson(QUALITY_FILE, null), readJson(SCORES_FILE, null));
  const targets = [[config.files.skills, text.skills], [CONFIG_FILE, text.config]];
  if (opts.check) {
    const drift = targets.filter(([file, expected]) => readFileSync(resolve(ROOT, file), 'utf8') !== expected).map(([file]) => file);
    if (drift.length) {
      console.error('Assessments are not projected into: ' + drift.join(', ') + '. Run `node scripts/sync.mjs --write` and `nosey registry generate .`.');
      process.exitCode = 1;
    } else console.log('Assessment projection is up to date.');
    return;
  }
  for (const [file, expected] of targets) console.log((writeText(file, expected) ? 'Updated ' : 'Unchanged ') + file);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {console.error(error.stack ?? error.message); process.exitCode = 1;});
}

#!/usr/bin/env node
/**
 * Open JEV scoring for the official registry's pinned skills.
 *
 * The scores come from the SHA-pinned Open JEV GitHub Action (see
 * .github/workflows/score-jev.yml). This module holds everything around it:
 * planning, bounded input preparation, response normalisation, merging and the
 * offline invariants. Nothing here calls a model or executes fetched content.
 *
 *   node scripts/jev.mjs check
 *   node scripts/jev.mjs plan      [--limit 0..64] [--mode all-needed|unscored|stale] [--out PATH]
 *   node scripts/jev.mjs prepare   --id ID [--out PATH] [--meta PATH]
 *   node scripts/jev.mjs normalize --meta PATH --result PATH --out PATH
 *   node scripts/jev.mjs merge     [--dir PATH]
 */
import {readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, appendFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ROOT, OFFICIAL_ID, SCORES_FILE, SHA40, SHA64, assertOfficial, loadRegistry, loadLocations, resolvePins,
  readJson, writeJson, sha256, rawUrl, pagesUrl, parseArgs, safeSkillPath} from './lib.mjs';

export const QUESTIONS_FILE = 'config/open-jev-questions.json';
export const ACTION = 'intikhab49/open-jev-typed-decision-engine@4c3c85ee6238f24a464c9285d1786aabc51a753b';
export const MODEL_RELEASE = 'model-v1';
export const STATE_LIMIT = 4000;
export const STATE_VERSION = 1;
export const MAX_SOURCE_BYTES = 262144;
export const DIMENSIONS = ['trigger_clarity', 'instruction_quality', 'correctness', 'safety', 'context_efficiency'];
export const LIMITATION = 'Open JEV reviews at most the first 4,000 UTF-16 code units of SKILL.md; supporting files and runtime behavior are not assessed. Scores have no written reasons or recommendations.';
// Part of the evaluator identity: changing it would invalidate every stored score.
const TRANSFORM = 'index+1,mean,informational';

const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) &&
  Number.isFinite(Date.parse(value));
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
export const outputKey = id => sha256(id).slice(0, 20);

/* ---------- evaluator identity ---------- */

function fingerprintOf(config) {
  return sha256(JSON.stringify({action: config.action_ref, model: config.model_release, questions: config.questions,
    stateLimit: config.state_limit_code_units, stateVersion: config.state_format_version, transform: TRANSFORM}));
}

export function checkEvaluator(config) {
  if (!exact(config, ['provider', 'action_ref', 'model_release', 'state_format_version', 'questions_sha256', 'fingerprint',
      'ranking_calibrated', 'state_limit_code_units', 'questions', 'scope']) || config.provider !== 'open-jev-action' ||
      !/^[\w.-]+\/[\w.-]+@[a-f0-9]{40}$/.test(config.action_ref) || typeof config.model_release !== 'string' || !config.model_release ||
      !Number.isInteger(config.state_format_version) || config.state_format_version < 1 ||
      config.state_limit_code_units !== STATE_LIMIT || config.scope !== LIMITATION || config.ranking_calibrated !== false ||
      !exact(config.questions, DIMENSIONS) || DIMENSIONS.some(d => !exact(config.questions[d], ['type', 'criteria', 'instructions']) ||
        config.questions[d].type !== 'score' || typeof config.questions[d].instructions !== 'string' ||
        !Array.isArray(config.questions[d].criteria) || config.questions[d].criteria.length !== 5 ||
        config.questions[d].criteria.some(c => typeof c !== 'string' || !c))) throw new Error('Malformed Open JEV evaluator');
  if (config.questions_sha256 !== sha256(JSON.stringify(config.questions)) || config.fingerprint !== fingerprintOf(config)) {
    throw new Error('Open JEV evaluator fingerprint does not match its configuration');
  }
}

export function evaluator(questions = readJson(QUESTIONS_FILE)) {
  const config = {provider: 'open-jev-action', action_ref: ACTION, model_release: MODEL_RELEASE,
    state_format_version: STATE_VERSION, questions_sha256: sha256(JSON.stringify(questions)), fingerprint: '',
    ranking_calibrated: false, state_limit_code_units: STATE_LIMIT, questions, scope: LIMITATION};
  config.fingerprint = fingerprintOf(config);
  checkEvaluator(config);
  return config;
}

/* ---------- sources ---------- */

/** repository/path/commit of an entry's recorded blob URL. */
export function parseSourceUrl(source) {
  const url = new URL(source.url);
  const parts = url.pathname.split('/').filter(Boolean);
  const path = parts.slice(4).join('/');
  if (url.origin !== 'https://github.com' || url.search || url.hash || parts.length < 5 || parts[2] !== 'blob' ||
      parts[3] !== source.commit || !SHA40.test(source.commit) || !safeSkillPath(path)) throw new Error('Invalid pinned SKILL.md source');
  return {repository: parts[0] + '/' + parts[1], path, commit: source.commit};
}

export function current(entry, pin, fp) {
  if (entry?.status !== 'evaluated' || entry.fingerprint !== fp) return false;
  try {
    const saved = parseSourceUrl(entry.source);
    return saved.repository.toLowerCase() === pin.repo.toLowerCase() && saved.path === pin.path && saved.commit === pin.commit;
  } catch {return false;}
}

export function loadSource() {
  assertOfficial();
  const {skills} = loadRegistry();
  const {located, unlocated} = resolvePins(skills, loadLocations());
  return {pins: new Map(located.map(p => [p.id, p])), unlocated, skillCount: skills.length};
}

/* ---------- entries and report ---------- */

export function checkEntry(e) {
  if (!exact(e, ['id', 'status', 'source', 'input_sha256', 'fingerprint', 'evaluated_at', 'result_kind', 'evaluation', 'overall_score']) ||
      typeof e.id !== 'string' || e.id.split(':').length < 3 || e.status !== 'evaluated' ||
      !exact(e.source, ['url', 'commit']) || !SHA64.test(e.fingerprint ?? '') || !SHA64.test(e.input_sha256 ?? '') ||
      !timestamp(e.evaluated_at) || e.result_kind !== 'open_jev_scores' || !exact(e.evaluation, ['scores']) ||
      !exact(e.evaluation.scores, DIMENSIONS)) throw new Error('Invalid evaluated entry ' + e?.id);
  parseSourceUrl(e.source);
  for (const key of DIMENSIONS) {
    const s = e.evaluation.scores[key];
    if (!exact(s, ['score', 'confidence', 'mode']) || !Number.isInteger(s.score) || s.score < 1 || s.score > 5 ||
        !Number.isFinite(s.confidence) || s.confidence < 0 || s.confidence > 1 || s.mode !== 'model') {
      throw new Error('Invalid score dimension ' + key + ' for ' + e.id);
    }
  }
  const mean = DIMENSIONS.reduce((n, key) => n + e.evaluation.scores[key].score, 0) / DIMENSIONS.length;
  if (e.overall_score !== mean) throw new Error('Inconsistent score mean ' + e.id);
  return e;
}

const emptySummary = () => ({total: 0, evaluated: 0, stale: 0, pending: 0, unlocated: 0});

/** Coverage is derived from pins and the evaluator identity; stale evidence stays inspectable. */
export function buildReport(rows, source, {config = evaluator(), previous = null, now = new Date().toISOString()} = {}) {
  checkEvaluator(config);
  const seen = new Set();
  for (const e of rows) {
    checkEntry(e);
    if (seen.has(e.id)) throw new Error('Duplicate score ID ' + e.id);
    seen.add(e.id);
  }
  const known = new Set([...source.pins.keys(), ...source.unlocated.map(p => p.id)]);
  const entries = rows.filter(e => known.has(e.id)).sort(byId);
  const byKey = new Map(entries.map(e => [e.id, e]));
  const summary = emptySummary();
  for (const id of known) {
    const pin = source.pins.get(id);
    const entry = byKey.get(id);
    summary.total++;
    if (!pin) summary.unlocated++;
    else if (!entry) summary.pending++;
    else if (current(entry, pin, config.fingerprint)) summary.evaluated++;
    else summary.stale++;
  }
  const next = {schema_version: 1, registry_id: OFFICIAL_ID, generated_at: now, evaluator: config, summary, entries};
  if (previous && JSON.stringify({...next, generated_at: null}) === JSON.stringify({...previous, generated_at: null})) {
    next.generated_at = previous.generated_at;
  }
  return next;
}

export function checkReport(doc, source) {
  if (doc === null) return true;
  if (!exact(doc, ['schema_version', 'registry_id', 'generated_at', 'evaluator', 'summary', 'entries']) ||
      doc.schema_version !== 1 || doc.registry_id !== OFFICIAL_ID || !timestamp(doc.generated_at) ||
      !Array.isArray(doc.entries)) throw new Error('Malformed Open JEV report');
  checkEvaluator(doc.evaluator);
  let last = null;
  for (const e of doc.entries) {
    checkEntry(e);
    if (last !== null && !(last < e.id)) throw new Error('Score IDs must be uniquely sorted: ' + e.id);
    last = e.id;
  }
  if (source) {
    // The entries must match the located pins (no orphans, unique, sorted). The summary is derived coverage
    // and may lag: adding or re-pinning a skill makes it pending/stale until the next scoring run, and that
    // must not fail the PR that changes the data. `merge` recomputes it.
    const fresh = buildReport(doc.entries, source, {config: doc.evaluator, previous: doc, now: doc.generated_at});
    if (JSON.stringify(fresh.entries) !== JSON.stringify(doc.entries)) throw new Error('Score entries do not match the located skills; run scripts/jev.mjs merge and commit the result');
  }
  return true;
}

/* ---------- planning, preparation, normalisation, merge ---------- */

/**
 * What a run may score: `unscored` = no entry yet, `stale` = an entry that is no longer current
 * (re-pinned skill or changed evaluator), `all-needed` = both (default).
 */
export const MODES = ['all-needed', 'unscored', 'stale'];

export function plan(source, report, {limit = 8, mode = 'all-needed'} = {}) {
  if (!Number.isInteger(limit) || limit < 0 || limit > 64) throw new Error('Limit must be 0..64');
  if (!MODES.includes(mode)) throw new Error('Mode must be one of ' + MODES.join(', '));
  checkReport(report);
  const saved = new Map((report?.entries ?? []).map(e => [e.id, e]));
  const fp = evaluator().fingerprint;
  const wanted = pin => {
    const entry = saved.get(pin.id);
    if (current(entry, pin, fp)) return false;
    return mode === 'all-needed' || (mode === 'unscored') === !entry;
  };
  const todo = [...source.pins.values()].sort(byId).filter(wanted)
    .map(pin => ({id: pin.id, key: outputKey(pin.id), commit: pin.commit}));
  return {fingerprint: fp, mode, count: Math.min(limit, todo.length), remaining: Math.max(0, todo.length - limit),
    include: todo.slice(0, limit)};
}

export async function prepare(pin, {fetchImpl = fetch, config = evaluator()} = {}) {
  const response = await fetchImpl(rawUrl(pin.repo, pin.commit, pin.path), {redirect: 'manual', signal: AbortSignal.timeout(20000)});
  if (response.status !== 200 || !response.body) throw new Error('Pinned source HTTP ' + response.status);
  if (Number(response.headers.get('content-length') || '0') > MAX_SOURCE_BYTES) throw new Error('Source too large');
  const parts = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > MAX_SOURCE_BYTES) throw new Error('Source too large');
    parts.push(chunk);
  }
  if (!total) throw new Error('Empty source');
  const bytes = Buffer.concat(parts);
  const text = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  return {
    state: {skill_id: pin.id, repository: pin.repo, source_commit: pin.commit, source_path: pin.path,
      document_kind: 'SKILL.md', document_excerpt: text.slice(0, STATE_LIMIT), is_truncated: text.length > STATE_LIMIT},
    meta: {id: pin.id, key: outputKey(pin.id), source: {repository: pin.repo, path: pin.path, commit: pin.commit},
      fingerprint: config.fingerprint, input_sha256: sha256(bytes)},
  };
}

export function normalize(meta, raw, date = '1970-01-01T00:00:00Z', config = evaluator()) {
  if (!meta?.id || !SHA40.test(meta.source?.commit ?? '') || !SHA64.test(meta.input_sha256 ?? '') ||
      meta.fingerprint !== config.fingerprint) throw new Error('Invalid evaluation metadata');
  if (raw?.workflow !== null || !raw.decisions || Object.keys(raw.decisions).length !== DIMENSIONS.length) {
    throw new Error('Unexpected action response');
  }
  const scores = {};
  for (const key of DIMENSIONS) {
    const d = raw.decisions[key];
    const answer = Number(d?.answer);
    if (!['number', 'string'].includes(typeof d?.answer) || String(d.answer).trim() === '' || d?.type !== 'score' || d.mode !== 'model' ||
        !Number.isInteger(answer) || answer < 0 || answer > 4 || !Number.isFinite(d.confidence) || d.confidence < 0 || d.confidence > 1 ||
        !d.distribution || Object.keys(d.distribution).length !== 5 || !['0', '1', '2', '3', '4'].every(k => Object.hasOwn(d.distribution, k))) {
      throw new Error('Invalid typed answer ' + key);
    }
    const probabilities = Object.values(d.distribution);
    if (probabilities.some(v => typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) ||
        Math.abs(probabilities.reduce((a, b) => a + b, 0) - 1) > 0.02) throw new Error('Invalid probabilities ' + key);
    scores[key] = {score: answer + 1, confidence: d.confidence, mode: 'model'};
  }
  const overall = Math.round(DIMENSIONS.reduce((n, key) => n + scores[key].score, 0) / DIMENSIONS.length * 10000) / 10000;
  return checkEntry({id: meta.id, status: 'evaluated', source: {url: pagesUrl(meta.source.repository, meta.source.commit, meta.source.path), commit: meta.source.commit},
    input_sha256: meta.input_sha256, fingerprint: meta.fingerprint, evaluated_at: date, result_kind: 'open_jev_scores',
    evaluation: {scores}, overall_score: overall});
}

/** Accept only candidates that match a current pin and evaluator; keep newer evidence. */
export function merge(candidates, before, source, now = new Date().toISOString()) {
  checkReport(before);
  const rows = new Map((before?.entries ?? []).map(e => [e.id, e]));
  let accepted = 0;
  for (const e of candidates) {
    checkEntry(e);
    const pin = source.pins.get(e.id);
    if (!pin || !current(e, pin, evaluator().fingerprint)) continue;
    const old = rows.get(e.id);
    if (old?.fingerprint === e.fingerprint && (Date.parse(old.evaluated_at) > Date.parse(e.evaluated_at) ||
        JSON.stringify(old) === JSON.stringify(e))) continue;
    rows.set(e.id, e);
    accepted++;
  }
  const next = buildReport([...rows.values()], source, {config: evaluator(), previous: before, now});
  checkReport(next, source);
  return {next, accepted};
}

/* ---------- CLI ---------- */

const out = (file, value) => {
  const path = resolve(ROOT, file);
  mkdirSync(dirname(path), {recursive: true});
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
};
const output = (name, value) => process.env.GITHUB_OUTPUT && appendFileSync(process.env.GITHUB_OUTPUT, name + '=' + value + '\n');

async function main([command, ...argv]) {
  const flags = {limit: 'value', mode: 'value', out: 'value', id: 'value', meta: 'value', result: 'value', dir: 'value'};
  const a = parseArgs(argv, flags);
  const report = readJson(SCORES_FILE, null);
  if (command === 'check') {
    const source = loadSource();
    checkReport(report, source);
    const coverage = buildReport(report?.entries ?? [], source, {config: report?.evaluator ?? evaluator(), previous: report, now: report?.generated_at ?? new Date().toISOString()}).summary;
    console.log('Open JEV report OK: ' + JSON.stringify(coverage) + (report ? '' : ' (no report yet)'));
  } else if (command === 'plan') {
    const result = plan(loadSource(), report, {limit: Number(a.limit ?? 8), mode: a.mode ?? 'all-needed'});
    out(a.out ?? '.nosey-eval/plan.json', result);
    output('matrix', JSON.stringify({include: result.include}));
    output('count', result.count);
    console.log('Open JEV (' + result.mode + '): ' + result.count + ' skills planned, ' + result.remaining + ' pending');
  } else if (command === 'prepare') {
    const pin = loadSource().pins.get(a.id);
    if (!pin) throw new Error('Unknown located skill: ' + a.id);
    const {state, meta} = await prepare(pin);
    out(a.out ?? '.nosey-eval/state.json', state);
    out(a.meta ?? '.nosey-eval/meta.json', meta);
    console.log('Prepared inert, pinned skill ' + pin.id);
  } else if (command === 'normalize') {
    if (!a.meta || !a.result || !a.out) throw new Error('Required --meta --result --out');
    const value = normalize(JSON.parse(readFileSync(resolve(ROOT, a.meta), 'utf8')), JSON.parse(readFileSync(resolve(ROOT, a.result), 'utf8')),
      new Date().toISOString().replace(/\.\d+Z$/, 'Z'));
    out(a.out, value);
    console.log('Recorded score for ' + value.id);
  } else if (command === 'merge') {
    const dir = resolve(ROOT, a.dir ?? '.nosey-eval/results');
    const candidates = existsSync(dir) ? readdirSync(dir).filter(n => n.endsWith('.json')).sort()
      .map(n => JSON.parse(readFileSync(join(dir, n), 'utf8'))) : [];
    const {next, accepted} = merge(candidates, report, loadSource());
    const changed = writeJson(SCORES_FILE, next);
    output('changed', changed);
    output('accepted', accepted);
    console.log('Open JEV merged ' + accepted + ' successful evaluations; changed=' + changed);
  } else throw new Error('Usage: jev.mjs check | plan | prepare | normalize | merge');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {console.error(error.message); process.exitCode = 1;});
}

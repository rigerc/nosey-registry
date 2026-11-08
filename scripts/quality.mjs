#!/usr/bin/env node
/**
 * Offline skill-validator quality results for the official registry's pinned skills.
 *
 * Network model: Git transport only (a treeless fetch for a few selected
 * paths, otherwise a blobless fetch per repository+commit), followed by a
 * sparse checkout of whole selected skill directories recursively.
 * No GitHub REST/GraphQL API calls. Fetched content is never executed; it is
 * only read by skill-validator. Live link checking and LLM scoring are not run.
 *
 *   node scripts/quality.mjs --check                 offline invariants (CI)
 *   node scripts/quality.mjs --write [--all]         refresh missing/stale entries
 *   node scripts/quality.mjs --gate --base <sha>     evaluate changed pins only; no write
 *   node scripts/quality.mjs --plan --base <sha>     count changed targets (no network)
 *   node scripts/quality.mjs --plan-refresh         count missing/stale targets (no network)
 *   node scripts/quality.mjs --print-version         validator version to install
 * Options: --ids a,b  --max-groups N  --deadline-minutes N  --concurrency N  --enforce
 * Env: SKILL_VALIDATOR_BIN (default skill-validator), QUALITY_GIT_BASE (tests).
 */
import {readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, appendFileSync, readdirSync, lstatSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync, spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ROOT, OFFICIAL_ID, QUALITY_FILE, WAIVERS_FILE, SHA40, assertOfficial, loadRegistry, loadLocations,
  resolvePins, changedSkills} from './lib.mjs';

const RETRYABLE = new Set(['throttled', 'network_error', 'fetch_failed', 'timeout']);
const MAX_FINDINGS = 200;
const MAX_MESSAGE = 500;
const sleep = ms => new Promise(done => setTimeout(done, ms));
/** Resource planning is performed from Git trees before checkout. Git transport
 *  cannot reliably impose a hard cap on bytes transferred over the network. */
export const LIMITS = {
  maxFilesPerSkill: 5000,
  maxBytesPerSkill: 50 * 1024 * 1024,
  maxFilesPerGroup: 50000,
  maxBytesPerGroup: 512 * 1024 * 1024,
  groupTimeoutMs: 10 * 60 * 1000,
  minSpacingMs: 1000,
};

/** Single source of truth for what is run. Changing any field makes entries stale. */
export const TOOL = {
  name: 'skill-validator',
  version: 'v1.8.0',
  checks: ['structure', 'content', 'contamination'], // 'links' is deliberately excluded
  flags: ['--allow-extra-frontmatter', '--allow-dirs=evals'],
};
export const MAPPER_VERSION = 2;

const sha256 = text => createHash('sha256').update(text).digest('hex');
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const round = n => Math.round(n * 10000) / 10000;

export function fingerprint(tool = TOOL) {
  return sha256(JSON.stringify({
    version: tool.version, checks: [...tool.checks].sort(), flags: [...tool.flags].sort(),
    mapper: MAPPER_VERSION,
  }));
}

export function toolBlock(tool = TOOL) {
  return {name: tool.name, version: tool.version, checks: [...tool.checks], flags: [...tool.flags],
    config_sha256: fingerprint(tool)};
}

/** Located pins are already {id, repo, path, dir, commit}; see lib.resolvePins. */
export function isCurrent(cached, loc, fp) {
  if (!cached || cached.source?.commit !== loc.commit || cached.source?.path !== loc.path ||
      cached.fingerprint !== fp) return false;
  return !(cached.status === 'not_evaluated' && RETRYABLE.has(cached.not_evaluated?.code));
}

export function selectTargets(locs, cache, {all = false, ids = null, only = null, fp = fingerprint()} = {}) {
  const targets = [];
  for (const loc of locs) {
    if (ids && !ids.has(loc.id)) continue;
    if (only && !only.has(loc.id)) continue;
    if (all || !isCurrent(cache.get(loc.id), loc, fp)) targets.push(loc);
  }
  return targets;
}

export function groupTargets(targets) {
  const groups = new Map();
  for (const loc of targets) {
    const key = loc.repo.toLowerCase() + '@' + loc.commit; // GitHub owner/repo names are case-insensitive
    if (!groups.has(key)) groups.set(key, {repo: loc.repo, commit: loc.commit, skills: []});
    groups.get(key).skills.push(loc);
  }
  return [...groups.values()].sort((a, b) => (a.repo + a.commit).localeCompare(b.repo + b.commit));
}

/* ---------- process helper ---------- */

export function run(cmd, args, {cwd, input = '', timeout = 120000, env = {}} = {}) {
  return new Promise(done => {
    let out = '';
    let err = '';
    let timedOut = false;
    let stdoutTruncated = false;
    let child;
    try {
      child = spawn(cmd, args, {cwd, env: {...process.env, GIT_TERMINAL_PROMPT: '0', ...env},
        stdio: ['pipe', 'pipe', 'pipe']});
    } catch (error) {
      done({code: -1, out, err: String(error.message), timedOut});
      return;
    }
    const timer = setTimeout(() => {timedOut = true; child.kill('SIGKILL');}, timeout);
    child.stdout.on('data', d => {if (out.length + d.length > 32 * 1024 * 1024) stdoutTruncated = true; else out += d;});
    child.stderr.on('data', d => {err = (err + d).slice(-8192);});
    child.on('error', error => {clearTimeout(timer); done({code: -1, out, err: String(error.message), timedOut});});
    child.on('close', code => {clearTimeout(timer); done({code, out, err, timedOut, stdoutTruncated});});
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export function classifyGitFailure({err = '', timedOut = false}) {
  if (timedOut) return 'timeout';
  if (/ENOENT/.test(err)) return 'fetch_failed';
  if (/\b429\b|rate limit|too many requests|abuse/i.test(err)) return 'throttled';
  if (/not our ref|couldn't find remote ref|repository not found|does not appear to be a git repository|\b404\b|unadvertised object|bad object/i.test(err)) return 'upstream_missing';
  if (/could not read username|authentication failed|terminal prompts disabled|\b40[13]\b|permission denied/i.test(err)) return 'auth_required';
  if (/could not resolve host|connection (reset|timed out|refused)|early eof|unexpected disconnect|ssl|tls|curl \d+|hung up|transfer closed|low speed/i.test(err)) return 'network_error';
  return 'fetch_failed';
}

const clean = (text, workdir = '') => String(text ?? '')
  .split(workdir && workdir.length > 1 ? workdir : '\0').join('')
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, MAX_MESSAGE) || 'unknown';

/** Disk accounting is a second line of defense after the tree-size preflight. */
export function dirBytes(path, {skipGit = false, cap = Infinity} = {}) {
  let total = 0;
  const stack = [path];
  while (stack.length && total <= cap) {
    const current = stack.pop();
    let entries;
    try {entries = readdirSync(current, {withFileTypes: true});} catch {continue;}
    for (const e of entries) {
      if (skipGit && e.name === '.git') continue;
      const full = join(current, e.name);
      if (e.isDirectory()) stack.push(full);
      else try {total += lstatSync(full).size;} catch { /* vanished */ }
    }
  }
  return total;
}

/* ---------- Git: fetch trees, plan, then selectively download blobs ---------- */
export const GIT_ENV = {GIT_LFS_SKIP_SMUDGE: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_ATTR_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0'};

export function gitRunner(repoDir, exec, local) {
  return (args, opts = {}) => exec('git', [
    '-c', 'core.hooksPath=/dev/null', '-c', 'core.symlinks=false', '-c', 'core.fsmonitor=false',
    '-c', 'submodule.recurse=false', '-c', 'filter.lfs.smudge=', '-c', 'filter.lfs.process=',
    '-c', 'filter.lfs.required=false', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always',
    '-c', 'protocol.file.allow=' + (local ? 'always' : 'never'),
    '-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=60', '-c', 'advice.detachedHead=false',
    ...args], {cwd: repoDir, env: GIT_ENV, ...opts});
}

const remaining = deadline => Math.max(1, Math.min(240000, deadline - Date.now()));
export async function fetchGroup(group, work, {exec = run, base = process.env.QUALITY_GIT_BASE || 'https://github.com/',
  deadline = Infinity} = {}) {
  const name = group.repo.split('/')[1];
  if (!name || name === '.' || name === '..') return {ok: false, code: 'upstream_missing', message: 'Invalid repository name'};
  const repoDir = join(work, name);
  mkdirSync(repoDir, {recursive: true});
  const git = gitRunner(repoDir, exec, base.startsWith('file:'));
  const steps = [
    () => git(['init', '-q'], {timeout: remaining(deadline)}),
    () => git(['remote', 'add', 'origin', base + group.repo + '.git'], {timeout: remaining(deadline)}),
    // For small groups, fetch the commit first, and lazily hydrate tree metadata
    // only along selected paths. For dense groups, reuse blobless trees.
    () => git(['fetch', '-q', '--depth=1',
      '--filter=' + (group.skills.length <= 4 && group.skills.every(s => s.dir) ? 'tree:0' : 'blob:none'),
      'origin', group.commit], {timeout: remaining(deadline)}),
  ];
  for (const step of steps) {
    if (Date.now() >= deadline) return {ok: false, code: 'timeout', message: 'Repository group exceeded its deadline'};
    const result = await step();
    if (result.code !== 0 || result.timedOut) return {ok: false, code: classifyGitFailure(result), message: clean(result.err, work)};
  }
  return {ok: true, repoDir, git};
}

/** Count every Git-tracked path inside each selected skill directory.
 * Never use ls-tree -l on a partial clone: Git downloads missing blobs to
 * determine their sizes. Check actual bytes on disk after targeted checkout.
 * Small groups hydrate only tree objects along the location-selected paths.
 */
export async function planTrees(git, skills, {deadline = Infinity} = {}) {
  const wanted = new Set(skills.map(s => s.dir));
  const stats = new Map([['', {files: 0}]]);
  const rootFiles = {files: 0};
  for (const dir of wanted) stats.set(dir, {files: 0});
  const scoped = wanted.size <= 4 && !wanted.has('');
  const trees = scoped ? [...wanted].map(dir => ({dir, rev: 'FETCH_HEAD:' + dir}))
    : [{dir: '', rev: 'FETCH_HEAD'}];
  for (const {dir, rev} of trees) {
    if (Date.now() >= deadline) return {ok: false, code: 'timeout', message: 'Git tree enumeration exceeded deadline'};
    const result = await git(['ls-tree', '-r', '-z', rev], {timeout: remaining(deadline)});
    if (result.code !== 0 || result.timedOut || result.stdoutTruncated) {
      return {ok: false, code: result.timedOut ? 'timeout' : 'fetch_failed',
        message: 'Could not enumerate pinned Git tree: ' + dir};
    }
    for (const line of result.out.split('\0')) {
      if (!line) continue;
      const tab = line.indexOf('\t');
      if (tab < 0) return {ok: false, code: 'fetch_failed', message: 'Malformed git ls-tree output'};
      if (scoped) {stats.get(dir).files++; continue;}
      const path = line.slice(tab + 1);
      stats.get('').files++;
      if (!path.includes('/')) rootFiles.files++;
      for (let i = path.lastIndexOf('/'); i > 0; i = path.lastIndexOf('/', i - 1)) {
        const prefix = path.slice(0, i);
        if (wanted.has(prefix)) stats.get(prefix).files++;
      }
    }
  }
  return {ok: true, stats, rootFiles};
}

export async function checkoutPlanned(fetched, dirs, {deadline = Infinity} = {}) {
  const {git} = fetched;
  if (!dirs.includes('')) {
    // Git non-cone patterns are glob expressions: reject metacharacters so
    // an untrusted upstream path cannot widen the checkout unexpectedly.
    if (dirs.some(dir => /[\[\]*?\\\r\n]/.test(dir))) {
      return {ok: false, code: 'fetch_failed', message: 'Skill path cannot be represented safely as a sparse-checkout pattern'};
    }
    // Slash-suffixed directory patterns include every nested tracked file,
    // not just known folders (references/, scripts/, assets/, etc).
    // Unlike cone mode, unrelated repository-root files are excluded.
    const set = await git(['sparse-checkout', 'set', '--no-cone', '--stdin'],
      {input: [...new Set(dirs)].map(dir => '/' + dir + '/').join('\n') + '\n', timeout: remaining(deadline)});
    if (set.code !== 0 || set.timedOut) return {ok: false, code: classifyGitFailure(set), message: clean(set.err)};
  }
  if (Date.now() >= deadline) return {ok: false, code: 'timeout', message: 'Repository group exceeded its deadline'};
  const result = await git(['checkout', '-q', '--detach', 'FETCH_HEAD'], {timeout: remaining(deadline)});
  return result.code === 0 && !result.timedOut ? {ok: true}
    : {ok: false, code: classifyGitFailure(result), message: clean(result.err)};
}

export async function treeSha(git, dir, {deadline = Infinity} = {}) {
  const result = await git(['rev-parse', dir ? 'FETCH_HEAD:' + dir : 'FETCH_HEAD^{tree}'],
    {timeout: remaining(deadline)});
  const sha = result.out.trim();
  return result.code === 0 && SHA40.test(sha) ? sha : undefined;
}

/* ---------- validator ---------- */

export async function runValidator(skillDir, {bin = process.env.SKILL_VALIDATOR_BIN || 'skill-validator',
  tool = TOOL, exec = run, timeout = 60000} = {}) {
  const args = ['check', '--max-depth=0', '--only=' + tool.checks.join(','), ...tool.flags, '-o', 'json', skillDir];
  const result = await exec(bin, args, {timeout});
  if (result.timedOut) return {ok: false, code: 'timeout', message: 'skill-validator timed out'};
  if (result.stdoutTruncated) return {ok: false, code: 'unparseable_output', message: 'Validator output exceeded capture limit'};
  // Exit 0/1/2 all carry a report; anything else is a usage error or crash.
  if (![0, 1, 2].includes(result.code)) {
    return {ok: false, code: 'validator_crashed', message: clean(result.err || 'exit ' + result.code, skillDir)};
  }
  try {
    const report = JSON.parse(result.out);
    if (!report || !Array.isArray(report.results)) throw new Error('missing results');
    return {ok: true, report};
  } catch (error) {
    return {ok: false, code: 'unparseable_output', message: 'Could not parse validator JSON: ' + clean(error.message)};
  }
}

const ratio = n => Math.min(1, Math.max(0, round(Number(n) || 0)));
const count = n => Math.max(0, Math.trunc(Number(n) || 0));

export function mapReport(report, workdir = '') {
  const order = {error: 0, warning: 1, info: 2};
  const findings = report.results.filter(r => r.level in order).map(r => ({
    level: r.level, category: clean(r.category).slice(0, 64), message: clean(r.message, workdir),
    ...(r.file ? {file: String(r.file).slice(0, 300)} : {}), ...(r.line > 0 ? {line: Math.trunc(r.line)} : {}),
  }));
  const counts = {errors: 0, warnings: 0, infos: 0};
  for (const f of findings) counts[f.level === 'error' ? 'errors' : f.level === 'warning' ? 'warnings' : 'infos']++;
  findings.sort((a, b) => order[a.level] - order[b.level]); // stable: validator order within a level
  const status = counts.errors ? 'fail' : counts.warnings ? 'warn' : 'pass';
  const out = {status, counts, findings: findings.slice(0, MAX_FINDINGS)};
  if (findings.length > MAX_FINDINGS) out.findings_truncated = true;

  const metrics = {};
  const files = report.token_counts?.files ?? [];
  const otherTotal = count(report.other_token_counts?.total);
  if (report.token_counts) {
    const standard = count(report.token_counts.total);
    const skillMd = files.filter(f => /^SKILL\.md/.test(f.file)).reduce((n, f) => n + count(f.tokens), 0);
    const references = files.filter(f => String(f.file).startsWith('references/')).reduce((n, f) => n + count(f.tokens), 0);
    const total = standard + otherTotal;
    metrics.tokens = {skill_md: skillMd, references, other: Math.max(0, total - skillMd - references), total};
  }
  const c = report.content_analysis;
  if (c) {
    metrics.content = {
      word_count: count(c.word_count), sentence_count: count(c.sentence_count),
      section_count: count(c.section_count), list_item_count: count(c.list_item_count),
      code_block_count: count(c.code_block_count), code_block_ratio: ratio(c.code_block_ratio),
      code_languages: [...new Set(c.code_languages ?? [])].sort(),
      imperative_count: count(c.imperative_count), imperative_ratio: ratio(c.imperative_ratio),
      information_density: ratio(c.information_density),
      instruction_specificity: ratio(c.instruction_specificity),
      strong_markers: count(c.strong_markers), weak_markers: count(c.weak_markers),
    };
  }
  const k = report.contamination_analysis;
  if (k) {
    metrics.contamination = {
      level: ['low', 'medium', 'high'].includes(k.contamination_level) ? k.contamination_level : 'low',
      score: ratio(k.contamination_score), language_mismatch: Boolean(k.language_mismatch),
      scope_breadth: count(k.scope_breadth),
      ...(k.primary_category ? {primary_category: String(k.primary_category)} : {}),
      mismatched_categories: [...new Set(k.mismatched_categories ?? [])].sort(),
      multi_interface_tools: [...new Set(k.multi_interface_tools ?? [])].sort(),
    };
  }
  if (Object.keys(metrics).length) out.metrics = metrics;
  return out;
}

/* ---------- evaluation ---------- */
function baseEntry(loc, fp, now, tree, tool = TOOL) {
  return {id: loc.id, source: {repository: loc.repo, path: loc.path, commit: loc.commit,
    ...(tree ? {tree_sha: tree} : {})}, fingerprint: fp, validator_version: tool.version,
    checks: [...tool.checks], evaluated_at: now};
}
const failed = (loc, fp, now, code, message, tree, tool) => ({
  ...baseEntry(loc, fp, now, tree, tool), status: 'not_evaluated',
  not_evaluated: {code, message: clean(message)},
});

export async function evaluateGroup(group, {tool = TOOL, now, exec = run, base, bin, poolSize = 4,
  validatorTimeout = 60000, cache = new Map(), limits = LIMITS, runDeadline = Infinity} = {}) {
  const started = Date.now();
  const deadline = Math.min(started + limits.groupTimeoutMs, runDeadline);
  const fp = fingerprint(tool);
  const work = mkdtempSync(join(tmpdir(), 'quality-'));
  const stats = {fetches: 1, ms: 0, bytes: 0, reused: 0, resourceLimited: 0};
  const fail = (loc, code, message, tree) => failed(loc, fp, now, code, message, tree, tool);
  try {
    const fetched = await fetchGroup(group, work, {exec, base, deadline});
    if (!fetched.ok) return {...stats, throttled: fetched.code === 'throttled',
      entries: group.skills.map(s => fail(s, fetched.code, fetched.message))};
    const planned = await planTrees(fetched.git, group.skills, {deadline});
    if (!planned.ok) return {...stats, throttled: false,
      entries: group.skills.map(s => fail(s, planned.code, planned.message))};
    const entries = new Array(group.skills.length);
    const todo = [];
    // Non-cone sparse checkout includes only selected directories; root-level
    // SKILL.md makes the whole repository the selected skill directory.
    // Bytes are checked after checkout, never with ls-tree -l.
    let plannedGroupFiles = group.skills.some(s => s.dir === '') ? planned.rootFiles.files : 0;
    const coveredDirs = new Set();
    for (const [index, loc] of group.skills.entries()) {
      if (Date.now() >= deadline) {entries[index] = fail(loc, 'timeout', 'Repository group deadline exceeded'); continue;}
      const tree = await treeSha(fetched.git, loc.dir, {deadline});
      const hit = cache.get(loc.id);
      if (tree && hit?.source?.tree_sha === tree && hit.fingerprint === fp &&
          !(hit.status === 'not_evaluated' && RETRYABLE.has(hit.not_evaluated?.code))) {
        entries[index] = {...hit, source: {...hit.source, repository: loc.repo, path: loc.path, commit: loc.commit, tree_sha: tree}};
        stats.reused++;
      } else {
        const size = planned.stats.get(loc.dir);
        if (!size || size.files > limits.maxFilesPerSkill) {
          entries[index] = fail(loc, 'resource_limit', 'Skill directory exceeds tracked-file budget', tree);
          stats.resourceLimited++;
        } else {
          // Avoid double-counting skill subdirectories nested under another selected dir.
          const covered = [...coveredDirs].some(d => !d || loc.dir.startsWith(d + '/'));
          const incrementFiles = loc.dir ? size.files : Math.max(0, size.files - plannedGroupFiles);
          if (!covered && plannedGroupFiles + incrementFiles > limits.maxFilesPerGroup) {
            entries[index] = fail(loc, 'resource_limit', 'Repository group tracked-file budget exceeded', tree);
            stats.resourceLimited++;
          } else {
            if (!covered) {plannedGroupFiles += incrementFiles; coveredDirs.add(loc.dir);}
            todo.push({index, loc, tree});
          }
        }
      }
    }
    if (todo.length) {
      const checkout = await checkoutPlanned(fetched, todo.map(t => t.loc.dir), {deadline});
      if (!checkout.ok) {
        for (const t of todo) entries[t.index] = fail(t.loc, checkout.code, checkout.message, t.tree);
      } else if (dirBytes(fetched.repoDir, {skipGit: true, cap: limits.maxBytesPerGroup}) > limits.maxBytesPerGroup) {
        for (const t of todo) entries[t.index] = fail(t.loc, 'resource_limit', 'Materialized repository group exceeds disk budget', t.tree);
        stats.resourceLimited += todo.length;
      } else {
        let next = 0;
        const worker = async () => {
          while (next < todo.length) {
            const {index, loc, tree} = todo[next++];
            if (Date.now() >= deadline) {entries[index] = fail(loc, 'timeout', 'Repository group deadline exceeded', tree); continue;}
            const dir = join(fetched.repoDir, loc.dir);
            if (!existsSync(join(dir, 'SKILL.md'))) {
              entries[index] = fail(loc, 'upstream_missing', 'SKILL.md is absent at the pinned commit', tree);
            } else if (dirBytes(dir, {skipGit: true, cap: limits.maxBytesPerSkill}) > limits.maxBytesPerSkill) {
              entries[index] = fail(loc, 'resource_limit', 'Skill directory exceeds size budget', tree);
              stats.resourceLimited++;
            } else {
              const timeout = Math.max(1, Math.min(validatorTimeout, deadline - Date.now()));
              const result = await runValidator(dir, {bin, tool, exec, timeout});
              entries[index] = result.ok
                ? {...baseEntry(loc, fp, now, tree, tool), ...mapReport(result.report, work)}
                : fail(loc, result.code, result.message, tree);
            }
          }
        };
        await Promise.all(Array.from({length: Math.min(poolSize, todo.length)}, worker));
      }
    }
    stats.bytes = dirBytes(work);
    return {...stats, ms: Date.now() - started, throttled: false, entries};
  } finally {rmSync(work, {recursive: true, force: true});}
}

function makeSpacer(ms) {
  let next = 0;
  return async () => {
    const now = Date.now();
    const at = Math.max(now, next);
    next = at + ms;
    if (at > now) await sleep(at - now);
  };
}

export async function evaluate(targets, {concurrency = 2, deadline = Infinity, maxGroups = Infinity,
  limits = LIMITS, onGroup = () => {}, ...opts} = {}) {
  const groups = groupTargets(targets).slice(0, maxGroups);
  const spacer = makeSpacer(limits.minSpacingMs);
  const results = [];
  const totals = {ms: 0, bytes: 0, reused: 0, resourceLimited: 0};
  let next = 0, fetches = 0, stopped = null;
  async function worker() {
    while (!stopped && next < groups.length) {
      if (Date.now() > deadline) {stopped = 'deadline'; return;}
      const group = groups[next++];
      await spacer();
      if (stopped) return;
      if (Date.now() >= deadline) {stopped = 'deadline'; return;}
      const result = await evaluateGroup(group, {...opts, limits, runDeadline: deadline});
      fetches += result.fetches;
      for (const k of Object.keys(totals)) totals[k] += result[k];
      results.push(...result.entries);
      onGroup(group, result);
      if (result.throttled) stopped = 'throttled';
    }
  }
  await Promise.all(Array.from({length: Math.min(concurrency, groups.length)}, worker));
  const done = new Set(results.map(e => e.id));
  const skippedIds = targets.filter(t => !done.has(t.id)).map(t => t.id);
  return {entries: results, fetches, stopped, skipped: skippedIds.length, skippedIds, totals};
}

/* ---------- document ---------- */

export function summarize(entries) {
  const by = {pass: 0, warn: 0, fail: 0, not_evaluated: 0};
  let errors = 0;
  let warnings = 0;
  for (const e of entries) {
    by[e.status]++;
    errors += e.counts?.errors ?? 0;
    warnings += e.counts?.warnings ?? 0;
  }
  return {total: entries.length, by_status: by, errors, warnings};
}

export function emptyDoc(now = '1970-01-01T00:00:00Z') {
  return {schema_version: 1, registry_id: OFFICIAL_ID, generated_at: now,
    tool: toolBlock(), summary: summarize([]),
    coverage: {pinned: 0, current: 0, stale: 0, missing: 0, orphan: 0}, entries: []};
}

export function coverageOf(entries, locs, fp = fingerprint()) {
  const pinned = new Map(locs.map(l => [l.id, l]));
  const cache = new Map(entries.map(e => [e.id, e]));
  const out = {pinned: pinned.size, current: 0, stale: 0, missing: 0, orphan: 0};
  for (const loc of pinned.values()) {
    const cached = cache.get(loc.id);
    if (!cached) out.missing++;
    else if (isCurrent(cached, loc, fp)) out.current++;
    else out.stale++;
  }
  for (const e of entries) if (!pinned.has(e.id)) out.orphan++;
  return out;
}

/** Preserve the last real verdict if reevaluation failed for the same exact pin. */
export function buildDoc(prev, fresh, locs, {now, tool = TOOL} = {}) {
  const pinned = new Set(locs.map(l => l.id));
  const map = new Map(prev.entries.filter(e => pinned.has(e.id)).map(e => [e.id, e]));
  for (const entry of fresh) {
    const old = map.get(entry.id);
    const keepOld = entry.status === 'not_evaluated' && old && old.status !== 'not_evaluated' &&
      old.source.commit === entry.source.commit && old.source.path === entry.source.path &&
      old.source.repository.toLowerCase() === entry.source.repository.toLowerCase();
    if (!keepOld) map.set(entry.id, entry);
  }
  const entries = [...map.values()].sort(byId);
  const doc = {schema_version: 1, registry_id: OFFICIAL_ID, generated_at: prev.generated_at,
    tool: toolBlock(tool), summary: summarize(entries), coverage: coverageOf(entries, locs, fingerprint(tool)), entries};
  if (JSON.stringify([doc.tool, doc.summary, doc.coverage, doc.entries]) !==
      JSON.stringify([prev.tool, prev.summary, prev.coverage, prev.entries])) doc.generated_at = now;
  return doc;
}

/** Pretty header, one compact line per entry: reviewable diffs, ~3x smaller file. */
export function serialize(doc) {
  const {entries, ...rest} = doc;
  const head = JSON.stringify(rest, null, 2).slice(0, -2);
  const body = entries.length ? '[\n' + entries.map(e => '    ' + JSON.stringify(e)).join(',\n') + '\n  ]' : '[]';
  return head + ',\n  "entries": ' + body + '\n}\n';
}

/** Semantics JSON Schema cannot express. Coverage is reported, never enforced (it lags main). */
export function checkDoc(doc, locs) {
  const problems = [];
  const pinned = new Map(locs.map(l => [l.id, l]));
  if (doc.registry_id !== OFFICIAL_ID) problems.push('registry_id must be ' + OFFICIAL_ID);
  if (doc.tool?.config_sha256 !== fingerprint({...TOOL, ...doc.tool})) {
    problems.push('tool.config_sha256 does not match tool version/checks/flags');
  }
  if (JSON.stringify(summarize(doc.entries)) !== JSON.stringify(doc.summary)) problems.push('summary does not match entries');
  let previous = null;
  for (const e of doc.entries) {
    if (previous !== null && !(previous < e.id)) problems.push('entries not strictly sorted by id at ' + e.id);
    previous = e.id;
    const loc = pinned.get(e.id);
    if (!loc) continue; // Orphans can lag until the refresh workflow prunes them.
    if (loc.commit === e.source.commit &&
        (loc.repo.toLowerCase() !== e.source.repository.toLowerCase() || loc.path !== e.source.path)) {
      problems.push(e.id + ': source differs from registry location at same commit');
    }
    if (e.status === 'not_evaluated') continue;
    const n = {errors: 0, warnings: 0, infos: 0};
    for (const f of e.findings) n[f.level === 'error' ? 'errors' : f.level === 'warning' ? 'warnings' : 'infos']++;
    const exact = !e.findings_truncated;
    for (const key of Object.keys(n)) {
      if (exact ? n[key] !== e.counts[key] : n[key] > e.counts[key]) problems.push(e.id + ': counts.' + key + ' disagree with findings');
    }
    const expected = e.counts.errors ? 'fail' : e.counts.warnings ? 'warn' : 'pass';
    if (e.status !== expected) problems.push(e.id + ': status ' + e.status + ' inconsistent with counts');
    if (e.findings_truncated && e.findings.length !== MAX_FINDINGS) problems.push(e.id + ': findings_truncated without 200 findings');
  }
  const coverage = coverageOf(doc.entries, locs);
  return {problems, coverage};
}

/* ---------- reporting ---------- */

const cell = text => String(text ?? '').replace(/[|\r\n<>]/g, ' ').slice(0, 160);
const annotate = text => String(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

export function reportMarkdown(entries, {title = 'Skill quality', fetches = 0, skipped = 0, stopped = null, includePassed = false} = {}) {
  const summary = summarize(entries);
  const lines = ['## ' + title, '',
    '- Evaluated: **' + summary.total + '** (pass ' + summary.by_status.pass + ', warn ' + summary.by_status.warn +
      ', fail ' + summary.by_status.fail + ', not evaluated ' + summary.by_status.not_evaluated + ')',
    '- Git fetches: **' + fetches + '**; GitHub REST API requests: **0**'];
  if (skipped) lines.push('- Not attempted this run: **' + skipped + '**' + (stopped ? ' (stopped: ' + stopped + ')' : ''));
  const order = ['fail', 'not_evaluated', 'warn', 'pass'];
  const notable = entries.filter(e => includePassed || e.status !== 'pass').sort((a, b) =>
    order.indexOf(a.status) - order.indexOf(b.status) || byId(a, b));
  if (notable.length) {
    lines.push('', '| Skill | Status | Errors | Warnings | First finding |', '| --- | --- | ---: | ---: | --- |');
    for (const e of notable.slice(0, 50)) {
      const first = e.status === 'not_evaluated' ? e.not_evaluated.code + ': ' + e.not_evaluated.message
        : e.findings[0]?.message;
      lines.push('| ' + cell(e.id) + ' | ' + e.status + ' | ' + (e.counts?.errors ?? '') + ' | ' +
        (e.counts?.warnings ?? '') + ' | ' + cell(first) + ' |');
    }
    if (notable.length > 50) lines.push('', 'Plus ' + (notable.length - 50) + ' more.');
  }
  lines.push('', 'Quality results come from skill-validator on pinned upstream content. They are not a security, licensing or availability audit.');
  return lines.join('\n') + '\n';
}

/* ---------- waivers and PR gate ---------- */
export function findWaiver(waivers, entry, today = new Date().toISOString().slice(0, 10)) {
  return waivers.find(w => w.id === entry.id && w.commit === entry.source.commit &&
    w.applies_to.includes(entry.status) && (!w.expires || w.expires >= today)) ?? null;
}
export function checkWaivers(doc, locs) {
  const problems = [];
  const seen = new Set();
  const verified = new Map(locs.map(l => [l.id, l]));
  for (const w of doc.waivers) {
    const key = w.id + '@' + w.commit;
    if (seen.has(key)) problems.push('duplicate waiver: ' + key);
    seen.add(key);
    if (!verified.has(w.id)) problems.push('waiver for unknown skill: ' + w.id);
    else if (verified.get(w.id).commit !== w.commit) problems.push('waiver pinned to an old commit (remove it): ' + w.id);
  }
  return problems;
}
export function gateVerdict(entries, {waivers = [], skippedIds = [], today} = {}) {
  const blocking = [], waived = [];
  for (const e of entries) {
    if (e.status !== 'fail' && e.status !== 'not_evaluated') continue;
    const waiver = findWaiver(waivers, e, today);
    (waiver ? waived : blocking).push(waiver ? {entry: e, waiver} : e);
  }
  return {blocking, waived, unattempted: skippedIds};
}

/* ---------- CLI ---------- */

const readJson = file => JSON.parse(readFileSync(resolve(ROOT, file), 'utf8'));
/** skills.json as committed at <base>; an absent file (first introduction) means no skills. */
function skillsAt(base, file) {
  if (!SHA40.test(base ?? '')) throw new Error('--base must be a full 40-character Git SHA');
  try {
    const data = execFileSync('git', ['show', base + ':' + file],
      {cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore']});
    return JSON.parse(data).skills;
  } catch { return []; }
}

function parseArgs(argv) {
  const opts = {mode: null, all: false, ids: null, base: null, maxGroups: Infinity, deadlineMinutes: 0, concurrency: 2,
    enforce: process.env.QUALITY_GATE === 'enforce'};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {if (i + 1 >= argv.length) throw new Error('Missing value for ' + a); return argv[++i];};
    if (['--check', '--write', '--gate', '--plan', '--plan-refresh', '--print-version'].includes(a)) opts.mode = a.slice(2);
    else if (a === '--enforce') opts.enforce = true;
    else if (a === '--all') opts.all = true;
    else if (a === '--ids') opts.ids = new Set(value().split(',').filter(Boolean));
    else if (a === '--base') opts.base = value();
    else if (a === '--max-groups') opts.maxGroups = Number(value());
    else if (a === '--deadline-minutes') opts.deadlineMinutes = Number(value());
    else if (a === '--concurrency') opts.concurrency = Number(value());
    else throw new Error('Unknown argument: ' + a);
  }
  if (!opts.mode) throw new Error('Usage: quality.mjs --check | --write [--all] | --plan-refresh [--all] | --gate --base <sha> [--enforce] | --plan --base <sha> | --print-version');
  if ([opts.maxGroups, opts.deadlineMinutes, opts.concurrency].some(n => !Number.isFinite(n) && n !== Infinity || n < 0) || opts.concurrency === 0 || (opts.mode === 'gate' || opts.mode === 'plan') && !SHA40.test(opts.base ?? '')) throw new Error('Invalid numeric option');
  return opts;
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.mode === 'print-version') {console.log(TOOL.version); return;}
  const config = assertOfficial();
  const {skills} = loadRegistry();
  const {located, unlocated} = resolvePins(skills, loadLocations());
  if (unlocated.length) console.log('Skills without a current location (run scripts/locate.mjs): ' + unlocated.length);
  const exists = existsSync(resolve(ROOT, QUALITY_FILE));
  const started = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const prev = exists ? readJson(QUALITY_FILE) : emptyDoc(started);

  const waiverDoc = existsSync(resolve(ROOT, WAIVERS_FILE)) ? readJson(WAIVERS_FILE) : {waivers: []};
  if (opts.mode === 'check') {
    if (!exists) throw new Error(QUALITY_FILE + ' is missing');
    const {problems, coverage} = checkDoc(prev, located);
    problems.push(...checkWaivers(waiverDoc, located));
    console.log('Quality coverage: ' + JSON.stringify(coverage) + ' (reported, not enforced)');
    for (const p of problems) console.error(p);
    if (problems.length) process.exitCode = 1;
    return;
  }
  const cache = new Map(prev.entries.map(e => [e.id, e]));
  const gating = opts.mode === 'gate' || opts.mode === 'plan';
  const only = gating ? new Set(changedSkills(skills, skillsAt(opts.base, config.files.skills))) : null;
  // A PR gate must re-validate changed pins; its cache comes from untrusted PR files.
  // --all also means actual re-evaluation, never just a tree-SHA cache hit.
  const targets = selectTargets(located, cache, {all: opts.all || gating, ids: opts.ids, only});
  if (opts.mode === 'plan' || opts.mode === 'plan-refresh') {
    const groups = groupTargets(targets).length;
    console.log((gating ? 'Changed pins' : 'Missing/stale pins') + ' needing evaluation: ' + targets.length +
      ' across ' + groups + ' repository+commit groups');
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT,
      'targets=' + targets.length + '\ngroups=' + Math.min(groups, opts.maxGroups) + '\n');
    return;
  }
  const deadline = opts.deadlineMinutes ? Date.now() + opts.deadlineMinutes * 60000 : Infinity;
  const result = await evaluate(targets, {concurrency: opts.concurrency, deadline,
    cache: (opts.all || gating) ? new Map() : cache,
    maxGroups: opts.maxGroups, now: started, onGroup: (g, r) => console.log(
      g.repo + '@' + g.commit.slice(0, 10) + ': ' + r.entries.length + ' skills, ' + r.ms + ' ms, ' +
      (r.bytes / 1048576).toFixed(1) + ' MiB on disk, ' + r.reused + ' reused')});
  const title = opts.mode === 'gate' ? 'Skill quality: changed pins' : 'Skill quality refresh';
  const report = reportMarkdown(result.entries, {title, fetches: result.fetches, skipped: result.skipped, stopped: result.stopped});
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
  if (opts.mode === 'gate' && process.env.QUALITY_PR_REPORT_FILE) {
    writeFileSync(process.env.QUALITY_PR_REPORT_FILE, reportMarkdown(result.entries, {
      title: 'Skill quality results for this PR', fetches: result.fetches,
      skipped: result.skipped, stopped: result.stopped, includePassed: true,
    }));
  }
  if (opts.mode === 'gate') {
    const verdict = gateVerdict(result.entries, {waivers: waiverDoc.waivers, skippedIds: result.skippedIds});
    const level = opts.enforce ? 'error' : 'warning';
    const prefix = opts.enforce ? '' : '[report-only] ';
    for (const e of verdict.blocking) {
      const why = e.status === 'fail' ? (e.findings.find(f => f.level === 'error')?.message ?? 'failed')
        : 'not evaluated (' + e.not_evaluated.code + '): ' + e.not_evaluated.message;
      console.log('::' + level + ' title=skill-validator::' + annotate(prefix + e.id + ': ' + why));
    }
    for (const {entry, waiver} of verdict.waived) console.log('::notice title=skill-validator::' + annotate(entry.id + ' waived: ' + waiver.reason));
    for (const id of verdict.unattempted) console.log('::' + level + ' title=skill-validator::' + annotate(prefix + id + ': not attempted (' + (result.stopped ?? 'incomplete') + ')'));
    const incomplete = verdict.blocking.length + verdict.unattempted.length;
    if (incomplete && !opts.enforce) console.log('Report-only mode: ' + incomplete + ' item(s) would block under QUALITY_GATE=enforce.');
    if (incomplete && opts.enforce) process.exitCode = 1;
    return;
  }
  const doc = buildDoc(prev, result.entries, located, {now: started});
  if (serialize(doc) !== (exists ? readFileSync(resolve(ROOT, QUALITY_FILE), 'utf8') : '')) {
    mkdirSync(resolve(ROOT, 'assessments'), {recursive: true});
    writeFileSync(resolve(ROOT, QUALITY_FILE), serialize(doc));
    console.log('Wrote ' + QUALITY_FILE + ' (coverage ' + JSON.stringify(doc.coverage) + ')');
  } else console.log('No changes to ' + QUALITY_FILE);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {console.error(error.stack ?? error.message); process.exitCode = 1;});
}

#!/usr/bin/env node
/**
 * Keep skill pins current and notice upstream skills that have vanished.
 *
 *   node scripts/pins.mjs --check     offline consistency check of skills.json and assessments/pin-probes.json
 *   node scripts/pins.mjs --write     probe every pinned skill's repository and rewrite the pins
 * Options: --max-groups N (repositories per run), --deadline-minutes N
 * Env: QUARANTINE=enforce  write `quarantine` into skills.json (otherwise report only)
 *      QUALITY_GIT_BASE    git remote base, for tests (default https://github.com/)
 *      PINS_SUMMARY_FILE   also write the markdown summary here (used as the PR body)
 *
 * A skill is re-pinned only when its directory differs from the pinned commit's.
 * It is quarantined after two misses at least MIN_STRIKE_GAP_DAYS apart: the
 * repository is gone (404) or the skill is absent at the repository's HEAD.
 * Transient failures (network, rate limits, 5xx, renames) never count as a miss.
 */
import {mkdtempSync, rmSync, appendFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {LOCATIONS_FILE, PROBES_FILE, SCORES_FILE, SHA40, assertOfficial, loadRegistry, loadLocations, serializeLocations,
  pinOf, readJson, parseArgs, writeJson} from './lib.mjs';
import {fetchGroup, gitRunner, classifyGitFailure, run} from './quality.mjs';
import {chooseLocation} from './locate.mjs';
import {loadSource, merge as mergeScores} from './jev.mjs';

export const MIN_STRIKE_GAP_DAYS = 5;
export const REQUIRED_MISSES = 2;
export const RAILS = {maxQuarantine: 25, maxFraction: 0.05};

const DAY = 86400000;
const daysBetween = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / DAY);

/**
 * Decide what to do with one pinned skill given what was observed upstream.
 * probe: {repo: 'ok'|'gone'|'error', head, headHits, sameTree, pinReachable}
 *   headHits    SKILL.md candidates for this skill at HEAD (undefined when not inspected)
 *   sameTree    the skill directory at HEAD equals the pinned commit's (undefined when unknown)
 *   pinReachable false when the pinned commit can no longer be fetched
 * Returns {action: 'keep'|'bump'|'missing'|'skip', reason?}.
 */
export function decide(pin, probe = {}) {
  if (probe.repo === 'gone') return {action: 'missing', reason: 'repo_gone'};
  if (probe.repo !== 'ok') return {action: 'skip'};
  // A quarantined skill is always inspected; others trust their location while HEAD is the pin.
  if (probe.head === pin.commit && !pin.quarantined) return {action: 'keep'};
  if (probe.headHits === undefined) return {action: 'skip'};
  if (probe.headHits === 0) return {action: 'missing', reason: 'skill_absent'};
  if (probe.headHits > 1) return {action: 'skip'};
  if (probe.head === pin.commit) return {action: 'keep'};
  if (probe.pinReachable === false) return {action: 'bump'};
  if (probe.sameTree === true) return {action: 'keep'};
  if (probe.sameTree === false) return {action: 'bump'};
  return {action: 'skip'};
}

/**
 * Apply decisions to the registry. Pure: returns new skills, locations and
 * probe history plus a summary; nothing is written here.
 * decisions: Map id → decide() result, with `ref` and `path` on a bump.
 */
export function apply({skills, locations, history, decisions, today, enforce = false, rails = RAILS}) {
  const nextHistory = structuredClone(history);
  const nextLocations = new Map(locations);
  const summary = {bumped: [], restored: [], quarantined: [], wouldQuarantine: [], strikes: [], skipped: [],
    railTripped: false, pinned: 0};
  const candidates = [];
  const pinned = skills.filter(skill => pinOf(skill));
  summary.pinned = pinned.length;

  let next = skills.map(skill => {
    const pin = pinOf(skill);
    if (!pin) return skill;
    const decision = decisions.get(skill.id);
    if (!decision || decision.action === 'skip') {
      if (decision) summary.skipped.push(skill.id);
      return skill;
    }
    if (decision.action === 'keep' || decision.action === 'bump') {
      delete nextHistory[skill.id];
      let out = skill;
      if (decision.action === 'bump') {
        out = {...out, source: {...out.source, ref: decision.ref}};
        nextLocations.set(skill.id, {commit: decision.ref, path: decision.path});
        summary.bumped.push(skill.id);
      }
      if (out.quarantine) {
        const {quarantine: _removed, ...restored} = out;
        out = restored;
        summary.restored.push(skill.id);
      }
      return out;
    }
    // missing
    if (skill.quarantine) {
      return enforce ? {...skill, quarantine: {...skill.quarantine, lastChecked: today}} : skill;
    }
    const previous = nextHistory[skill.id];
    let entry;
    if (!previous || previous.reason !== decision.reason) {
      entry = {misses: 1, firstMissAt: today, lastMissAt: today, reason: decision.reason};
    } else if (daysBetween(previous.lastMissAt, today) >= MIN_STRIKE_GAP_DAYS) {
      entry = {...previous, misses: previous.misses + 1, lastMissAt: today};
    } else entry = previous;
    nextHistory[skill.id] = entry;
    summary.strikes.push(skill.id + ' (' + entry.reason + ', miss ' + entry.misses + ')');
    if (entry.misses >= REQUIRED_MISSES) candidates.push({id: skill.id, reason: entry.reason, pin});
    return skill;
  });

  const limit = Math.min(rails.maxQuarantine, Math.max(1, Math.floor(pinned.length * rails.maxFraction)));
  if (candidates.length > limit) {
    summary.railTripped = true;
    summary.wouldQuarantine = candidates.map(c => c.id);
  } else if (!enforce) {
    summary.wouldQuarantine = candidates.map(c => c.id);
  } else {
    const byId = new Map(candidates.map(c => [c.id, c]));
    next = next.map(skill => {
      const candidate = byId.get(skill.id);
      if (!candidate) return skill;
      summary.quarantined.push(skill.id);
      return {...skill, quarantine: {reason: candidate.reason, since: today, lastSeenRef: candidate.pin.commit, lastChecked: today}};
    });
  }

  const live = new Set(skills.map(s => s.id));
  for (const id of Object.keys(nextHistory)) if (!live.has(id)) delete nextHistory[id];
  return {skills: next, locations: nextLocations, history: nextHistory, summary};
}

/** Offline consistency between skills.json and the probe history. Returns a list of problems. */
export function checkConsistency(skills, history) {
  const problems = [];
  const byId = new Map(skills.map(s => [s.id, s]));
  for (const skill of skills) {
    if (!skill.quarantine) continue;
    const entry = history[skill.id];
    if (!entry || entry.misses < REQUIRED_MISSES || entry.reason !== skill.quarantine.reason) {
      problems.push(skill.id + ': quarantine has no matching probe history (needs ' + REQUIRED_MISSES + ' misses with the same reason)');
    }
    if (!SHA40.test(skill.quarantine.lastSeenRef ?? '')) problems.push(skill.id + ': quarantine.lastSeenRef is not a full commit');
  }
  for (const id of Object.keys(history)) {
    if (!byId.has(id)) problems.push(id + ': probe history for an unknown skill');
  }
  return problems;
}

/* ---------- network probing ---------- */

const lsRemoteHead = out => out.split('\n').map(line => line.split('\t')).find(([, ref]) => ref === 'HEAD')?.[0];

/** Anonymous HEAD on the repository page; 404 is the only proof that a repository is gone. */
export async function githubRepoMissing(repo, {fetchImpl = fetch} = {}) {
  try {
    const response = await fetchImpl('https://github.com/' + repo, {method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(20000)});
    return response.status === 404;
  } catch {return false;}
}

/**
 * Observe one repository for its pins. Returns Map id → probe (see decide).
 * Never throws: failures become {repo: 'error'}.
 */
export async function probeRepo(repo, pins, {base = process.env.QUALITY_GIT_BASE || 'https://github.com/', exec = run,
  confirmGone = githubRepoMissing, deadline = Infinity} = {}) {
  const probes = new Map();
  const setAll = probe => {for (const pin of pins) probes.set(pin.id, probe(pin));};
  const work = mkdtempSync(join(tmpdir(), 'pins-'));
  try {
    const local = base.startsWith('file:');
    const listing = await gitRunner(work, exec, local)(['ls-remote', base + repo + '.git', 'HEAD'], {timeout: 120000});
    if (listing.code !== 0 || listing.timedOut) {
      const kind = classifyGitFailure(listing);
      const gone = (kind === 'upstream_missing' || kind === 'auth_required') && await confirmGone(repo);
      setAll(() => ({repo: gone ? 'gone' : 'error'}));
      return probes;
    }
    const head = lsRemoteHead(listing.out);
    if (!head || !SHA40.test(head)) {setAll(() => ({repo: 'error'})); return probes;}
    const inspect = pins.filter(pin => pin.commit !== head || pin.quarantined);
    for (const pin of pins) if (!inspect.includes(pin)) probes.set(pin.id, {repo: 'ok', head});
    if (!inspect.length) return probes;

    const fetched = await fetchGroup({repo, commit: head, skills: [{dir: ''}]}, work, {base, exec, deadline});
    if (!fetched.ok) {for (const pin of inspect) probes.set(pin.id, {repo: 'error'}); return probes;}
    const tree = await fetched.git(['ls-tree', '-r', '--name-only', '-z', 'FETCH_HEAD'], {timeout: 120000});
    if (tree.code !== 0 || tree.stdoutTruncated) {for (const pin of inspect) probes.set(pin.id, {repo: 'error'}); return probes;}
    const skillFiles = tree.out.split('\0').filter(p => p === 'SKILL.md' || p.endsWith('/SKILL.md'));
    const headDirs = new Map();
    for (const pin of inspect) {
      let choice = chooseLocation(skillFiles, pin.skillName, repo.split('/')[1]);
      let hits = skillFiles.filter(p => chooseLocation([p], pin.skillName, repo.split('/')[1]).ok).length;
      // Several same-named skills: follow the one recorded at pin time while it still exists.
      if (!choice.ok && hits > 1 && pin.path && skillFiles.includes(pin.path)) {choice = {ok: true, path: pin.path}; hits = 1;}
      const probe = {repo: 'ok', head, headHits: hits};
      if (choice.ok) {
        probe.headPath = choice.path;
        const dir = choice.path === 'SKILL.md' ? '' : choice.path.slice(0, -'/SKILL.md'.length);
        const sha = await fetched.git(['rev-parse', dir ? 'FETCH_HEAD:' + dir : 'FETCH_HEAD^{tree}'], {timeout: 60000});
        headDirs.set(pin.id, sha.code === 0 ? sha.out.trim() : undefined);
      }
      probes.set(pin.id, probe);
    }
    // Compare against each distinct pinned commit's copy of the skill directory.
    const commits = [...new Set(inspect.filter(p => probes.get(p.id).headPath).map(p => p.commit))];
    for (const commit of commits) {
      const fetchPin = await fetched.git(['fetch', '-q', '--depth=1', '--filter=blob:none', 'origin', commit], {timeout: 120000});
      const reachable = fetchPin.code === 0 && !fetchPin.timedOut;
      const definitelyGone = !reachable && classifyGitFailure(fetchPin) === 'upstream_missing';
      for (const pin of inspect.filter(p => p.commit === commit && probes.get(p.id).headPath)) {
        const probe = probes.get(pin.id);
        if (!reachable) {if (definitelyGone) probe.pinReachable = false; continue;}
        const pinned = await fetched.git(['rev-parse', pin.dir ? 'FETCH_HEAD:' + pin.dir : 'FETCH_HEAD^{tree}'], {timeout: 60000});
        const now = headDirs.get(pin.id);
        if (pinned.code === 0 && now) probe.sameTree = pinned.out.trim() === now;
      }
    }
    return probes;
  } finally {rmSync(work, {recursive: true, force: true});}
}

/* ---------- report ---------- */

export function render(summary, {enforce, probed, total}) {
  const list = (title, ids) => ids.length ? '### ' + title + ' (' + ids.length + ')\n' + ids.map(id => '- `' + id + '`').join('\n') + '\n\n' : '';
  let text = '## Skill pins\n\nProbed ' + probed + ' of ' + total + ' pinned skills. Quarantine is ' +
    (enforce ? '**enforced**' : '**report-only** (set repository variable `QUARANTINE=enforce` to write it)') + '.\n\n';
  if (summary.railTripped) {
    text += '> **Safety rail tripped:** ' + summary.wouldQuarantine.length + ' skills would be newly quarantined, which is more than the allowed ' +
      RAILS.maxQuarantine + ' or ' + RAILS.maxFraction * 100 + '%. No quarantine was written. Check for an upstream outage before retrying.\n\n';
  }
  text += list('Re-pinned', summary.bumped) + list('Restored from quarantine', summary.restored) +
    list('Quarantined', summary.quarantined) + list(enforce ? 'Ready to quarantine' : 'Would quarantine', summary.railTripped ? [] : summary.wouldQuarantine) +
    list('Misses recorded', summary.strikes.map(s => s.split(' ')[0])) + list('Skipped (transient or ambiguous)', summary.skipped);
  if (!summary.bumped.length && !summary.restored.length && !summary.quarantined.length && !summary.strikes.length) text += 'No changes.\n\n';
  text += 'Pins are re-pinned only when the skill directory differs from the pinned commit. Checks run in this workflow replace PR checks, ' +
    'because pull requests opened with `GITHUB_TOKEN` do not trigger other workflows.\n';
  return text;
}

async function main(argv) {
  const opts = parseArgs(argv, {check: 'bool', write: 'bool', 'max-groups': 'value', 'deadline-minutes': 'value'});
  if (!opts.check && !opts.write) throw new Error('Usage: pins.mjs --check | --write [--max-groups N --deadline-minutes N]');
  assertOfficial();
  const registry = loadRegistry();
  const history = readJson(PROBES_FILE, {schema_version: 1, probes: {}}).probes;
  if (opts.check) {
    const problems = checkConsistency(registry.skills, history);
    for (const problem of problems) console.error('pins: ' + problem);
    if (problems.length) process.exitCode = 1;
    else console.log('Pin probe history is consistent (' + Object.keys(history).length + ' open, ' +
      registry.skills.filter(s => s.quarantine).length + ' quarantined).');
    return;
  }

  const enforce = process.env.QUARANTINE === 'enforce';
  const today = process.env.PINS_TODAY || new Date().toISOString().slice(0, 10);
  const deadline = opts['deadline-minutes'] ? Date.now() + Number(opts['deadline-minutes']) * 60000 : Infinity;
  const pins = registry.skills.map(skill => {
    const pin = pinOf(skill);
    return pin && {...pin, quarantined: Boolean(skill.quarantine)};
  }).filter(Boolean);
  const locations = loadLocations();
  for (const pin of pins) {
    const loc = locations.get(pin.id);
    pin.path = loc && loc.commit === pin.commit ? loc.path : undefined;
    pin.dir = pin.path && pin.path !== 'SKILL.md' ? pin.path.slice(0, -'/SKILL.md'.length) : '';
  }
  const byRepo = new Map();
  for (const pin of pins) {
    const key = pin.repo.toLowerCase();
    if (!byRepo.has(key)) byRepo.set(key, {repo: pin.repo, pins: []});
    byRepo.get(key).pins.push(pin);
  }
  const groups = [...byRepo.values()].sort((a, b) => a.repo.localeCompare(b.repo)).slice(0, Number(opts['max-groups'] ?? Infinity));
  const decisions = new Map();
  let probed = 0;
  for (const group of groups) {
    if (Date.now() >= deadline) {console.log('::warning title=pins::deadline reached; remaining repositories are left for the next run'); break;}
    const probes = await probeRepo(group.repo, group.pins, {deadline});
    for (const pin of group.pins) {
      const decision = decide(pin, probes.get(pin.id));
      const probe = probes.get(pin.id);
      if (decision.action === 'bump') {
        decision.ref = probe.head;
        decision.path = probe.headPath;
      }
      decisions.set(pin.id, decision);
      probed++;
    }
  }
  const result = apply({skills: registry.skills, locations, history, decisions, today, enforce});
  const changed = [writeJson(registry.config.files.skills, {...registry.skillsDoc, skills: result.skills}),
    writeJson(LOCATIONS_FILE, serializeLocations(result.locations)),
    writeJson(PROBES_FILE, {schema_version: 1, probes: Object.fromEntries(Object.entries(result.history).sort(([a], [b]) => (a < b ? -1 : 1)))})];
  // Score entries of newly quarantined skills would otherwise fail `jev.mjs check` as orphans.
  const scores = readJson(SCORES_FILE, null);
  if (scores && result.summary.quarantined.length) writeJson(SCORES_FILE, mergeScores([], scores, loadSource()).next);
  const text = render(result.summary, {enforce, probed, total: pins.length});
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + '\n');
  if (process.env.PINS_SUMMARY_FILE) writeFileSync(process.env.PINS_SUMMARY_FILE, text);
  console.log(changed.some(Boolean) ? 'Updated pin data.' : 'No pin changes.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {console.error(error.stack ?? error.message); process.exitCode = 1;});
}

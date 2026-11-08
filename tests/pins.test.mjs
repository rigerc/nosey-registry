import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pinOf, resolvePins} from '../scripts/lib.mjs';
import {decide, apply, checkConsistency, probeRepo, MIN_STRIKE_GAP_DAYS} from '../scripts/pins.mjs';
import {project} from '../scripts/sync.mjs';

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const skill = (id, extra = {}) => ({id, name: id, technologies: [],
  source: {kind: 'git', uri: 'https://github.com/o/r', ref: OLD, skillName: id.split(':').at(-1)}, ...extra});
const quarantine = {reason: 'repo_gone', since: '2026-11-01', lastSeenRef: OLD};
const pin = (extra = {}) => ({id: 'o:r:a', repo: 'o/r', commit: OLD, skillName: 'a', dir: 'skills/a', ...extra});

test('decide: transient and ambiguous observations never count as missing', () => {
  assert.deepEqual(decide(pin(), {repo: 'error'}), {action: 'skip'});
  assert.deepEqual(decide(pin(), {}), {action: 'skip'});
  assert.deepEqual(decide(pin(), {repo: 'ok', head: NEW, headHits: 2}), {action: 'skip'});
  assert.deepEqual(decide(pin(), {repo: 'ok', head: NEW, headHits: 1}), {action: 'skip'});
  assert.deepEqual(decide(pin(), {repo: 'ok', head: NEW}), {action: 'skip'});
});

test('decide: keep, bump and missing', () => {
  assert.equal(decide(pin(), {repo: 'ok', head: OLD}).action, 'keep');
  assert.equal(decide(pin(), {repo: 'ok', head: NEW, headHits: 1, sameTree: true}).action, 'keep');
  assert.equal(decide(pin(), {repo: 'ok', head: NEW, headHits: 1, sameTree: false}).action, 'bump');
  assert.equal(decide(pin(), {repo: 'ok', head: NEW, headHits: 1, pinReachable: false}).action, 'bump');
  assert.deepEqual(decide(pin(), {repo: 'ok', head: NEW, headHits: 0}), {action: 'missing', reason: 'skill_absent'});
  assert.deepEqual(decide(pin(), {repo: 'gone'}), {action: 'missing', reason: 'repo_gone'});
});

test('decide: a quarantined skill is always inspected, even when HEAD is its pin', () => {
  assert.deepEqual(decide(pin({quarantined: true}), {repo: 'ok', head: OLD}), {action: 'skip'});
  assert.equal(decide(pin({quarantined: true}), {repo: 'ok', head: OLD, headHits: 1}).action, 'keep');
  assert.equal(decide(pin({quarantined: true}), {repo: 'ok', head: OLD, headHits: 0}).action, 'missing');
});

const run = (skills, decisions, over = {}) => apply({skills, locations: new Map(), history: {}, today: '2026-11-08',
  decisions: new Map(Object.entries(decisions)), enforce: true, ...over});

test('apply: a bump moves the pin and its location, and clears strikes', () => {
  const history = {'o:r:a': {misses: 1, firstMissAt: '2026-11-01', lastMissAt: '2026-11-01', reason: 'skill_absent'}};
  const r = run([skill('o:r:a')], {'o:r:a': {action: 'bump', ref: NEW, path: 'skills/a/SKILL.md'}}, {history});
  assert.equal(r.skills[0].source.ref, NEW);
  assert.deepEqual(r.locations.get('o:r:a'), {commit: NEW, path: 'skills/a/SKILL.md'});
  assert.deepEqual(r.history, {});
  assert.deepEqual(r.summary.bumped, ['o:r:a']);
});

test('apply: quarantine needs two misses at least five days apart', () => {
  const missing = {'o:r:a': {action: 'missing', reason: 'repo_gone'}};
  let r = run([skill('o:r:a')], missing);
  assert.equal(r.history['o:r:a'].misses, 1);
  assert.equal(r.skills[0].quarantine, undefined);
  // A second probe the same week (e.g. a manual dispatch) is not a second strike.
  r = run(r.skills, missing, {history: r.history, today: '2026-11-10'});
  assert.equal(r.history['o:r:a'].misses, 1);
  assert.equal(r.skills[0].quarantine, undefined);
  r = run(r.skills, missing, {history: r.history, today: '2026-11-' + String(8 + MIN_STRIKE_GAP_DAYS).padStart(2, '0')});
  assert.equal(r.history['o:r:a'].misses, 2);
  assert.deepEqual(r.skills[0].quarantine, {reason: 'repo_gone', since: '2026-11-13', lastSeenRef: OLD, lastChecked: '2026-11-13'});
  assert.deepEqual(Object.keys(r.skills[0].quarantine), ['reason', 'since', 'lastSeenRef', 'lastChecked']);
  assert.deepEqual(checkConsistency(r.skills, r.history), []);
});

test('apply: a transient skip or a found skill resets nothing it should not, and restores a quarantined skill', () => {
  const history = {'o:r:a': {misses: 1, firstMissAt: '2026-11-01', lastMissAt: '2026-11-01', reason: 'repo_gone'}};
  let r = run([skill('o:r:a')], {'o:r:a': {action: 'skip'}}, {history});
  assert.deepEqual(r.history, history, 'a skip leaves the strike intact');
  r = run([skill('o:r:a')], {'o:r:a': {action: 'keep'}}, {history});
  assert.deepEqual(r.history, {}, 'finding the skill clears the strike');
  const quarantined = skill('o:r:a', {quarantine: {...quarantine, lastChecked: '2026-11-02'}});
  r = run([quarantined], {'o:r:a': {action: 'bump', ref: NEW, path: 'a/SKILL.md'}}, {history: {'o:r:a': {misses: 2, reason: 'repo_gone'}}});
  assert.equal(r.skills[0].quarantine, undefined);
  assert.equal(r.skills[0].source.ref, NEW);
  assert.deepEqual(r.summary.restored, ['o:r:a']);
  assert.deepEqual(r.history, {});
});

test('apply: without QUARANTINE=enforce nothing is written to skills, but strikes are recorded', () => {
  const history = {'o:r:a': {misses: 1, firstMissAt: '2026-11-01', lastMissAt: '2026-11-01', reason: 'repo_gone'}};
  const r = run([skill('o:r:a')], {'o:r:a': {action: 'missing', reason: 'repo_gone'}}, {history, enforce: false});
  assert.equal(r.skills[0].quarantine, undefined);
  assert.equal(r.history['o:r:a'].misses, 2);
  assert.deepEqual(r.summary.wouldQuarantine, ['o:r:a']);
});

test('apply: the safety rail refuses a mass quarantine but still records strikes and re-pins', () => {
  const skills = Array.from({length: 10}, (_, i) => skill('o:r:s' + i));
  const history = Object.fromEntries(skills.slice(0, 4).map(s => [s.id, {misses: 1, firstMissAt: '2026-10-01', lastMissAt: '2026-10-01', reason: 'repo_gone'}]));
  const decisions = Object.fromEntries(skills.slice(0, 4).map(s => [s.id, {action: 'missing', reason: 'repo_gone'}]));
  decisions['o:r:s9'] = {action: 'bump', ref: NEW, path: 's9/SKILL.md'};
  const r = run(skills, decisions, {history, rails: {maxQuarantine: 2, maxFraction: 0.5}});
  assert.equal(r.summary.railTripped, true);
  assert.equal(r.skills.filter(s => s.quarantine).length, 0);
  assert.equal(r.skills[9].source.ref, NEW);
  assert.equal(Object.values(r.history).filter(h => h.misses === 2).length, 4);
});

test('checkConsistency rejects a quarantine without matching history', () => {
  const skills = [skill('o:r:a', {quarantine})];
  assert.equal(checkConsistency(skills, {}).length, 1);
  assert.equal(checkConsistency(skills, {'o:r:a': {misses: 2, reason: 'skill_absent'}}).length, 1);
  assert.equal(checkConsistency(skills, {'o:r:a': {misses: 2, reason: 'repo_gone'}}).length, 0);
  assert.equal(checkConsistency([skill('o:r:a')], {'o:r:gone': {misses: 1, reason: 'repo_gone'}}).length, 1);
});

test('quarantined skills are not evaluated and stay out of repository averages', () => {
  const skills = [skill('o:r:a', {quarantine}), skill('o:r:b')];
  assert.deepEqual(resolvePins(skills, new Map([['o:r:a', {commit: OLD, path: 'a/SKILL.md'}], ['o:r:b', {commit: OLD, path: 'b/SKILL.md'}]])).located.map(p => p.id), ['o:r:b']);
  const scored = skill('o:r:a', {quarantine, repositoryId: 'o:r', score: 10, quality: 'poor'});
  const {skills: projected, config} = project({skills: [scored], config: {source: {}}, pins: new Map(), quality: null, scores: null});
  assert.deepEqual(projected[0], scored);
  assert.equal(config.repositoryScores, undefined);
  assert.ok(pinOf(scored), 'a quarantined skill keeps a valid pin');
});

/* ---- end to end against local file:// repositories ---- */

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {cwd, encoding: 'utf8'}).trim();

function makeRepo(base, repo, files) {
  const dir = join(base, repo + '.git');
  mkdirSync(dir, {recursive: true});
  git(dir, 'init', '-q', '-b', 'main');
  commit(dir, files, 'init');
  return dir;
}
function commit(dir, files, message) {
  for (const [path, body] of Object.entries(files)) {
    if (body === null) {rmSync(join(dir, path), {force: true}); continue;}
    mkdirSync(join(dir, path, '..'), {recursive: true});
    writeFileSync(join(dir, path), body);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '--allow-empty', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
}

async function observe(base, repo, p, confirmGone = async () => true) {
  const probes = await probeRepo(repo, [p], {base: 'file://' + base + '/', confirmGone});
  return probes.get(p.id);
}

test('probeRepo against local repositories: unchanged, changed, moved, removed and deleted', async () => {
  const base = mkdtempSync(join(tmpdir(), 'pins-e2e-'));
  try {
    const dir = makeRepo(base, 'o/r', {'skills/a/SKILL.md': 'one', 'skills/a/ref.md': 'x', 'other.md': 'x'});
    const first = git(dir, 'rev-parse', 'HEAD');
    const p = pin({repo: 'o/r', commit: first, dir: 'skills/a'});

    assert.equal(decide(p, await observe(base, 'o/r', p)).action, 'keep', 'HEAD is the pin');

    commit(dir, {'other.md': 'changed'}, 'unrelated');
    assert.equal(decide(p, await observe(base, 'o/r', p)).action, 'keep', 'HEAD moved but the skill directory is identical');

    const changed = commit(dir, {'skills/a/ref.md': 'edited'}, 'edit skill');
    let probe = await observe(base, 'o/r', p);
    let decision = decide(p, probe);
    assert.equal(decision.action, 'bump');
    assert.equal(probe.head, changed);
    assert.equal(probe.headPath, 'skills/a/SKILL.md');

    commit(dir, {'skills/a/SKILL.md': null, 'skills/a/ref.md': null}, 'remove skill');
    assert.deepEqual(decide(p, await observe(base, 'o/r', p)), {action: 'missing', reason: 'skill_absent'});

    assert.deepEqual(decide(p, await observe(base, 'o/missing', pin({repo: 'o/missing', commit: first}))), {action: 'missing', reason: 'repo_gone'});
    assert.deepEqual(decide(p, await observe(base, 'o/missing', pin({repo: 'o/missing', commit: first}), async () => false)), {action: 'skip'},
      'an unconfirmed failure is transient');
  } finally {rmSync(base, {recursive: true, force: true});}
});

test('probeRepo restores a quarantined skill when it reappears and keeps a moved-but-identical directory', async () => {
  const base = mkdtempSync(join(tmpdir(), 'pins-e2e-'));
  try {
    const dir = makeRepo(base, 'o/r', {'skills/a/SKILL.md': 'one'});
    const first = git(dir, 'rev-parse', 'HEAD');
    const p = pin({repo: 'o/r', commit: first, dir: 'skills/a', quarantined: true});
    assert.equal(decide(p, await observe(base, 'o/r', p)).action, 'keep', 'present again at its pin');
    commit(dir, {'skills/a/SKILL.md': null, 'moved/a/SKILL.md': 'one'}, 'move skill');
    const probe = await observe(base, 'o/r', pin({...p, quarantined: false}));
    assert.equal(probe.headPath, 'moved/a/SKILL.md');
    assert.equal(probe.sameTree, true, 'identical content at a new path is the same skill');
    assert.equal(decide(pin({...p, quarantined: false}), probe).action, 'keep');
  } finally {rmSync(base, {recursive: true, force: true});}
});

test('probeRepo follows the recorded location when several skills share a name', async () => {
  const base = mkdtempSync(join(tmpdir(), 'pins-e2e-'));
  try {
    const dir = makeRepo(base, 'o/r', {'skills/a/SKILL.md': 'one', 'extra/a/SKILL.md': 'two'});
    const first = git(dir, 'rev-parse', 'HEAD');
    const p = pin({repo: 'o/r', commit: first, dir: 'skills/a', path: 'skills/a/SKILL.md'});
    commit(dir, {'skills/a/SKILL.md': 'one, edited'}, 'edit');
    assert.equal(decide(p, await observe(base, 'o/r', p)).action, 'bump');
    assert.equal(decide(pin({...p, path: undefined}), await observe(base, 'o/r', pin({...p, path: undefined}))).action, 'skip',
      'without a recorded location an ambiguous skill is never guessed');
  } finally {rmSync(base, {recursive: true, force: true});}
});

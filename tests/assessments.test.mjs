import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {ROOT, QUALITY_FILE, SCORES_FILE, repoOf, pinOf, safeSkillPath, resolvePins, changedSkills, loadRegistry,
  loadLocations, readJson} from '../scripts/lib.mjs';
import {chooseLocation} from '../scripts/locate.mjs';
import {fingerprint, isCurrent, selectTargets, mapReport, checkDoc, groupTargets} from '../scripts/quality.mjs';
import {ALL_DIMENSIONS, DIMENSIONS, evaluator, mappedTechnologies, checkEvaluator, checkEntry, normalize, merge, plan, buildReport, checkReport, loadSource, current, outputKey} from '../scripts/jev.mjs';
import {qualityLabel, scoreOf, project, render} from '../scripts/sync.mjs';

const SHA = 'a'.repeat(40);
const skill = (id, extra = {}) => ({id, name: id, technologies: [], repositoryId: 'o:r',
  source: {kind: 'git', uri: 'https://github.com/o/r', ref: SHA, skillName: id.split(':').at(-1)}, ...extra});

test('repoOf accepts only plain GitHub repository URIs', () => {
  assert.equal(repoOf('https://github.com/o/r'), 'o/r');
  assert.equal(repoOf('https://github.com/o/r.git'), 'o/r');
  for (const bad of ['https://example.com/o/r', 'https://github.com/o', 'https://github.com/o/r/x', 'https://github.com/o/..'])
    assert.throws(() => repoOf(bad), bad);
});

test('pinOf requires a full commit; resolvePins requires a location at that commit', () => {
  assert.equal(pinOf({...skill('o:r:a'), source: {kind: 'git', uri: 'https://github.com/o/r', ref: 'main', skillName: 'a'}}), null);
  const skills = [skill('o:r:a'), skill('o:r:b'), skill('o:r:c')];
  const locations = new Map([['o:r:a', {commit: SHA, path: 'skills/a/SKILL.md'}],
    ['o:r:b', {commit: 'b'.repeat(40), path: 'skills/b/SKILL.md'}], ['o:r:c', {commit: SHA, path: '../x/SKILL.md'}]]);
  const {located, unlocated} = resolvePins(skills, locations);
  assert.deepEqual(located.map(p => [p.id, p.dir]), [['o:r:a', 'skills/a']]);
  assert.deepEqual(unlocated.map(p => p.id), ['o:r:b', 'o:r:c']);
  assert.equal(safeSkillPath('SKILL.md'), true);
  assert.equal(safeSkillPath('a/../SKILL.md'), false);
});

test('changedSkills reports additions and re-pins only', () => {
  const base = [skill('o:r:a'), skill('o:r:b')];
  const head = [skill('o:r:a'), {...skill('o:r:b'), source: {...skill('o:r:b').source, ref: 'c'.repeat(40)}}, skill('o:r:c')];
  assert.deepEqual(changedSkills(head, base), ['o:r:b', 'o:r:c']);
  assert.deepEqual(changedSkills(base, base), []);
});

test('chooseLocation accepts only an unambiguous match', () => {
  assert.deepEqual(chooseLocation(['x/a/SKILL.md', 'x/b/SKILL.md'], 'a', 'r'), {ok: true, path: 'x/a/SKILL.md'});
  assert.equal(chooseLocation(['x/a/SKILL.md', 'y/a/SKILL.md'], 'a', 'r').ok, false);
  assert.equal(chooseLocation(['x/b/SKILL.md'], 'a', 'r').ok, false);
  assert.deepEqual(chooseLocation(['SKILL.md'], 'R', 'r'), {ok: true, path: 'SKILL.md'});
});

test('quality targets are missing or stale pins and group per repository commit', () => {
  const fp = fingerprint();
  const loc = {id: 'o:r:a', repo: 'o/r', path: 'a/SKILL.md', dir: 'a', commit: SHA};
  const fresh = {id: loc.id, fingerprint: fp, status: 'pass', source: {commit: SHA, path: 'a/SKILL.md'}};
  assert.equal(isCurrent(fresh, loc, fp), true);
  assert.equal(isCurrent({...fresh, fingerprint: 'x'}, loc, fp), false);
  assert.equal(isCurrent({...fresh, status: 'not_evaluated', not_evaluated: {code: 'network_error'}}, loc, fp), false);
  assert.equal(selectTargets([loc], new Map([[loc.id, fresh]])).length, 0);
  assert.equal(selectTargets([loc], new Map([[loc.id, fresh]]), {all: true}).length, 1);
  assert.equal(groupTargets([loc, {...loc, id: 'o:r:b', dir: 'b'}]).length, 1);
});

test('mapReport derives status from findings', () => {
  const map = results => mapReport({results});
  assert.equal(map([]).status, 'pass');
  assert.equal(map([{level: 'warning', category: 'X', message: 'm'}]).status, 'warn');
  assert.equal(map([{level: 'error', category: 'X', message: 'm'}, {level: 'warning', category: 'X', message: 'm'}]).status, 'fail');
});

test('quality labels and score scale', () => {
  assert.equal(qualityLabel({status: 'pass'}), 'excellent');
  assert.equal(qualityLabel({status: 'warn'}), 'good');
  assert.equal(qualityLabel({status: 'fail', counts: {errors: 1}}), 'fair');
  assert.equal(qualityLabel({status: 'fail', counts: {errors: 2}}), 'poor');
  assert.equal(qualityLabel({status: 'not_evaluated'}), null);
  assert.equal(qualityLabel(undefined), null);
  assert.equal(scoreOf(4.4), 88);
  assert.equal(scoreOf(5), 100);
});

function response(answers) {
  const decisions = {};
  ALL_DIMENSIONS.forEach((key, i) => {
    decisions[key] = {type: 'score', mode: 'model', answer: answers[i] ?? 3, confidence: 0.3,
      distribution: {0: 0.1, 1: 0.1, 2: 0.2, 3: 0.3, 4: 0.3}};
  });
  return {workflow: null, decisions};
}
const meta = (id = 'o:r:a') => ({id, key: outputKey(id), source: {repository: 'o/r', path: 'a/SKILL.md', commit: SHA},
  fingerprint: evaluator().fingerprint, input_sha256: 'd'.repeat(64)});

test('normalize maps typed answers 0..4 to scores 1..5 and rejects malformed responses', () => {
  const entry = normalize(meta(), response([4, 3, 4, 4, 2]), '2026-01-02T03:04:05Z');
  assert.equal(entry.overall_score, 4.4);
  assert.equal(entry.evaluation.scores.trigger_clarity.score, 5);
  // technology_fit is stored but never part of the overall score.
  assert.equal(entry.evaluation.scores.technology_fit.score, 4);
  assert.equal(normalize(meta(), response([4, 3, 4, 4, 2, 0]), '2026-01-02T03:04:05Z').overall_score, 4.4);
  assert.throws(() => normalize(meta(), response([4, 3, 4, 4, 9])));
  assert.throws(() => normalize({...meta(), fingerprint: 'e'.repeat(64)}, response([0, 0, 0, 0, 0])));
  assert.throws(() => normalize(meta(), {workflow: null, decisions: {}}));
});

test('merge keeps only evidence that matches a current pin', () => {
  const pin = {id: 'o:r:a', repo: 'o/r', path: 'a/SKILL.md', dir: 'a', commit: SHA};
  const source = {pins: new Map([[pin.id, pin]]), unlocated: []};
  const good = normalize(meta(), response([4, 4, 4, 4, 4]), '2026-01-02T03:04:05Z');
  const wrongCommit = normalize({...meta(), source: {...meta().source, commit: 'f'.repeat(40)}}, response([0, 0, 0, 0, 0]), '2026-01-02T03:04:05Z');
  const unknown = normalize(meta('o:r:zzz'), response([0, 0, 0, 0, 0]), '2026-01-02T03:04:05Z');
  const {next, accepted} = merge([wrongCommit, unknown, good], null, source, '2026-02-01T00:00:00.000Z');
  assert.equal(accepted, 1);
  assert.equal(next.summary.evaluated, 1);
  assert.deepEqual(next.entries.map(e => e.id), ['o:r:a']);
  assert.equal(plan(source, next).count, 0);
  assert.equal(plan(source, null).count, 1);
  assert.throws(() => plan(source, null, {limit: 65}));
  assert.equal(current(good, pin, evaluator().fingerprint), true);
});

test('plan mode selects unscored, stale or both', () => {
  const pin = {id: 'o:r:a', repo: 'o/r', path: 'a/SKILL.md', dir: 'a', commit: SHA};
  const added = {id: 'o:r:b', repo: 'o/r', path: 'b/SKILL.md', dir: 'b', commit: SHA};
  const scored = merge([normalize(meta(), response([4, 4, 4, 4, 4]), '2026-01-02T03:04:05Z')], null,
    {pins: new Map([[pin.id, pin]]), unlocated: []}, '2026-02-01T00:00:00.000Z').next;
  // a is stale (re-pinned), b is unscored.
  const source = {pins: new Map([[pin.id, {...pin, commit: 'f'.repeat(40)}], [added.id, added]]), unlocated: []};
  const ids = opts => plan(source, scored, opts).include.map(e => e.id);
  assert.deepEqual(ids({}), ['o:r:a', 'o:r:b']);
  assert.deepEqual(ids({mode: 'all-needed'}), ['o:r:a', 'o:r:b']);
  assert.deepEqual(ids({mode: 'unscored'}), ['o:r:b']);
  assert.deepEqual(ids({mode: 'stale'}), ['o:r:a']);
  assert.equal(plan(source, scored, {mode: 'unscored', limit: 0}).remaining, 1);
  // A current skill is never queued in any mode.
  const upToDate = {pins: new Map([[pin.id, pin]]), unlocated: []};
  for (const mode of ['all-needed', 'unscored', 'stale']) assert.equal(plan(upToDate, scored, {mode}).count, 0);
  assert.throws(() => plan(source, scored, {mode: 'nope'}), /Mode must be/);
});

test('a newly added or re-pinned skill does not fail the score coverage check', () => {
  const pin = {id: 'o:r:a', repo: 'o/r', path: 'a/SKILL.md', dir: 'a', commit: SHA};
  const added = {id: 'o:r:b', repo: 'o/r', path: 'b/SKILL.md', dir: 'b', commit: SHA};
  const scored = merge([normalize(meta(), response([4, 4, 4, 4, 4]), '2026-01-02T03:04:05Z')], null,
    {pins: new Map([[pin.id, pin]]), unlocated: []}, '2026-02-01T00:00:00.000Z').next;
  // Added skill: pending, summary lags the data.
  const withAdded = {pins: new Map([[pin.id, pin], [added.id, added]]), unlocated: []};
  assert.equal(checkReport(scored, withAdded), true);
  assert.equal(buildReport(scored.entries, withAdded, {previous: scored, now: scored.generated_at}).summary.pending, 1);
  // Re-pinned skill: its score becomes stale but is still kept.
  const repinned = {pins: new Map([[pin.id, {...pin, commit: 'f'.repeat(40)}]]), unlocated: []};
  assert.equal(checkReport(scored, repinned), true);
  // Orphan evidence for a skill that no longer exists is still rejected.
  assert.throws(() => checkReport(scored, {pins: new Map(), unlocated: []}), /do not match/);
});

test('project writes derived fields, leaves manual assessments and removes stale automated ones', () => {
  const fp = fingerprint();
  const pins = new Map([['o:r:a', {id: 'o:r:a', repo: 'o/r', path: 'a/SKILL.md', dir: 'a', commit: SHA}]]);
  const quality = {entries: [{id: 'o:r:a', fingerprint: fp, status: 'warn', counts: {errors: 0, warnings: 1}, evaluated_at: '2026-01-01T00:00:00Z',
    source: {commit: SHA, path: 'a/SKILL.md'}}]};
  const scoreEntry = normalize(meta(), response([4, 4, 4, 4, 4]), '2026-01-02T03:04:05Z');
  const scores = {evaluator: evaluator(), entries: [scoreEntry]};
  const manual = skill('o:r:m', {quality: 'poor', assessment: {method: 'manual-review', assessedAt: '2025-01-01'}});
  const stale = skill('o:r:s', {quality: 'good', score: 50, assessment: {method: 'automated', assessedAt: '2025-01-01'}});
  const {skills, config} = project({skills: [skill('o:r:a'), manual, stale], config: {schemaVersion: 1, source: {x: 1}}, pins, quality, scores});
  assert.deepEqual([skills[0].quality, skills[0].score, skills[0].assessment.assessedAt], ['good', 100, '2026-01-02']);
  assert.equal(skills[1].quality, 'poor');
  assert.equal(skills[2].quality, undefined);
  assert.equal(skills[2].assessment, undefined);
  assert.deepEqual(config.repositoryScores, {'o:r': {averageScore: 100, scoreCount: 1}});
  assert.deepEqual(Object.keys(config), ['schemaVersion', 'repositoryScores', 'source']);
});

test('the committed assessments are internally consistent and fully projected', () => {
  const registry = loadRegistry();
  const {located} = resolvePins(registry.skills, loadLocations());
  assert.equal(located.length, registry.skills.length);
  const quality = readJson(QUALITY_FILE);
  assert.deepEqual(checkDoc(quality, located).problems, []);
  const source = loadSource();
  const scores = readJson(SCORES_FILE);
  assert.equal(checkReport(scores, source), true);
  assert.equal(buildReport(scores.entries, source, {previous: scores, now: scores.generated_at}).summary.total, registry.skills.length);
  const text = render(registry, new Map(located.map(p => [p.id, p])), quality, scores);
  assert.equal(readFileSync(resolve(ROOT, registry.config.files.skills), 'utf8'), text.skills);
  assert.equal(readFileSync(resolve(ROOT, 'nosey.registry.config.json'), 'utf8'), text.config);
});

test('technology_fit is additive: it leaves the fingerprint alone and older five-dimension entries stay valid', () => {
  const config = evaluator();
  assert.deepEqual(Object.keys(config.questions), ALL_DIMENSIONS);
  const core = {...config, questions: Object.fromEntries(DIMENSIONS.map(d => [d, config.questions[d]]))};
  // Same identity with and without the extra question.
  const legacy = JSON.parse(readFileSync(resolve(ROOT, SCORES_FILE), 'utf8')).evaluator;
  assert.equal(legacy.fingerprint, config.fingerprint);
  assert.doesNotThrow(() => checkEvaluator(legacy));
  assert.throws(() => checkEvaluator({...core, questions: {...core.questions, extra: config.questions.safety}}));
  const withFit = normalize(meta(), response([4, 3, 4, 4, 2, 1]), '2026-01-02T03:04:05Z');
  const { technology_fit: _fit, ...fiveScores } = withFit.evaluation.scores;
  const legacyEntry = {...withFit, evaluation: {scores: fiveScores}};
  assert.doesNotThrow(() => checkEntry(legacyEntry));
  assert.equal(legacyEntry.overall_score, withFit.overall_score);
  assert.throws(() => checkEntry({...withFit, evaluation: {scores: {...fiveScores, technology_fit: {score: 9, confidence: 0.5, mode: 'model'}}}}));
});

test('mappedTechnologies lists the technologies a skill is recommended for', () => {
  const technologies = [{id: 'android', name: 'Android'}, {id: 'clerk', name: 'Clerk'}, {id: 'astro', name: 'Astro'}];
  const rec = (skillId, allTechnologies) => ({skillId, priority: 'optional', reason: 'r', ...(allTechnologies ? {when: {allTechnologies}} : {})});
  const mappings = [
    {id: 'm1', technologyId: 'astro', recommendations: [rec('o:r:a'), rec('o:r:other')]},
    {id: 'm2', technologyId: 'android', recommendations: [rec('o:r:a', ['clerk']), rec('o:r:a', ['clerk'])]},
  ];
  assert.deepEqual(mappedTechnologies('o:r:a', mappings, technologies),
    [{technology: 'Android', also_requires: ['Clerk']}, {technology: 'Astro'}]);
  assert.deepEqual(mappedTechnologies('o:r:none', mappings, technologies), []);
});

test('rescore re-runs current skills, missing technology_fit first and then oldest', () => {
  const pins = ['a', 'b', 'c', 'd'].map(n => ({id: 'o:r:' + n, repo: 'o/r', path: n + '/SKILL.md', dir: n, commit: SHA}));
  const source = {pins: new Map(pins.map(p => [p.id, p])), unlocated: []};
  const entry = (pin, date, withFit = true) => {
    const e = normalize({...meta(pin.id), source: {repository: 'o/r', path: pin.path, commit: SHA}}, response([4, 4, 4, 4, 4]), date);
    if (!withFit) delete e.evaluation.scores.technology_fit;
    return e;
  };
  const rows = [entry(pins[0], '2026-03-01T00:00:00Z'), entry(pins[1], '2026-01-01T00:00:00Z'),
    entry(pins[2], '2026-05-01T00:00:00Z', false)];
  const report = merge(rows, null, source, '2026-06-01T00:00:00.000Z').next;
  // d is unscored and never rescored; c lacks technology_fit; then b (oldest) before a.
  assert.deepEqual(plan(source, report, {mode: 'rescore'}).include.map(e => e.id), ['o:r:c', 'o:r:b', 'o:r:a']);
  const limited = plan(source, report, {mode: 'rescore', limit: 1});
  assert.deepEqual([limited.count, limited.remaining], [1, 2]);
  assert.deepEqual(plan(source, report, {mode: 'unscored'}).include.map(e => e.id), ['o:r:d']);
  // A stale entry belongs to `stale`, not `rescore`.
  const repinned = {pins: new Map([...source.pins, ['o:r:a', {...pins[0], commit: 'f'.repeat(40)}]]), unlocated: []};
  assert.ok(!plan(repinned, report, {mode: 'rescore'}).include.some(e => e.id === 'o:r:a'));
});

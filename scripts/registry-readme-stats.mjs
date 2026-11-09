#!/usr/bin/env node
// Dependency-free collector and README section replacer for registry statistics.
//
// collect: reads the registry declared by nosey.registry.config.json and writes
// a compact JSON array to $GITHUB_OUTPUT (and stdout).
// replace: reads GENERATED_TABLE from the environment and rewrites only the
// delimited README section (legacy interface).
// refresh: renders a prominent, self-contained stats summary from local JSON.

import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BEGIN_MARKER = '<!-- BEGIN GENERATED REGISTRY STATS -->';
const END_MARKER = '<!-- END GENERATED REGISTRY STATS -->';
const HEADING = '## Registry statistics';
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isSafeRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (value.includes('\0') || value.includes('\\')) return false;
  if (path.isAbsolute(value)) return false;
  const parts = value.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return false;
  return true;
}

function fail(message) {
  throw new Error(message);
}

function readJsonFile(root, relativePath, label) {
  if (!isSafeRelativePath(relativePath)) {
    fail(`unsafe ${label} path: ${relativePath}`);
  }
  const absolutePath = path.resolve(root, relativePath);
  const relativeToRoot = path.relative(root, absolutePath);
  if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
    fail(`unsafe ${label} path: ${relativePath}`);
  }
  let raw;
  try {
    raw = readFileSync(absolutePath, 'utf8');
  } catch (error) {
    fail(`cannot read ${label}: ${error.code || error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(`invalid JSON in ${label}: ${error.message}`);
  }
  return parsed;
}

function countNamedArray(document, key, label) {
  if (!isPlainObject(document)) {
    fail(`${label} must contain a JSON object`);
  }
  if (!Array.isArray(document[key])) {
    fail(`${label} must contain a "${key}" array`);
  }
  return document[key].length;
}

export function loadRegistryConfig(root = process.cwd()) {
  const configPath = path.join(root, 'nosey.registry.config.json');
  let raw;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch (error) {
    fail(`cannot read nosey.registry.config.json: ${error.code || error.message}`);
  }
  let config;
  try {
    config = JSON.parse(raw);
  } catch (error) {
    fail(`invalid JSON in nosey.registry.config.json: ${error.message}`);
  }
  if (!isPlainObject(config)) {
    fail('nosey.registry.config.json must contain a JSON object');
  }
  if (!isPlainObject(config.files)) {
    fail('nosey.registry.config.json must declare a "files" object');
  }
  const files = config.files;
  for (const key of ['technologies', 'skills', 'mappings']) {
    if (typeof files[key] !== 'string' || !isSafeRelativePath(files[key])) {
      fail(`nosey.registry.config.json must declare a safe "${key}" file path`);
    }
  }
  if (files.repositories !== undefined &&
      (typeof files.repositories !== 'string' || !isSafeRelativePath(files.repositories))) {
    fail('nosey.registry.config.json must declare a safe "repositories" file path');
  }
  return { root: path.resolve(root), config, files };
}

export function countRegistryStats(root = process.cwd()) {
  const { files } = loadRegistryConfig(root);
  const technologiesDocument = readJsonFile(root, files.technologies, 'technologies document');
  const skillsDocument = readJsonFile(root, files.skills, 'skills document');
  const mappingsDocument = readJsonFile(root, files.mappings, 'mappings document');

  const counts = {
    skills: countNamedArray(skillsDocument, 'skills', 'skills document'),
    technologies: countNamedArray(technologiesDocument, 'technologies', 'technologies document'),
    mappings: countNamedArray(mappingsDocument, 'mappings', 'mappings document'),
    repositories: 0,
  };

  if (files.repositories !== undefined) {
    const repositoriesDocument = readJsonFile(root, files.repositories, 'repositories document');
    counts.repositories = countNamedArray(repositoriesDocument, 'repositories', 'repositories document');
  }

  return counts;
}

export function collectStats(root = process.cwd()) {
  const counts = countRegistryStats(root);
  // Keep the row labels and calculation independent of any registry data.
  const orderedRows = [
    { Metric: 'Skills', Count: String(counts.skills) },
    { Metric: 'Technologies', Count: String(counts.technologies) },
    { Metric: 'Mapping entries', Count: String(counts.mappings) },
    { Metric: 'Source repositories', Count: String(counts.repositories) },
  ];
  const json = JSON.stringify(orderedRows);
  return { counts, rows: orderedRows, json };
}

export function renderStatsCards(counts) {
  const metrics = [
    ['Skills', counts.skills],
    ['Technologies', counts.technologies],
    ['Mapping entries', counts.mappings],
    ['Source repositories', counts.repositories],
  ];
  for (const [label, value] of metrics) {
    if (!Number.isSafeInteger(value) || value < 0) {
      fail(`invalid count for ${label}`);
    }
  }
  return [
    '<table>',
    '  <tr>',
    ...metrics.map(([label]) => `    <th align="center">${label}</th>`),
    '  </tr>',
    '  <tr>',
    ...metrics.map(([, value]) => `    <td align="center"><h2>${value.toLocaleString('en-US')}</h2></td>`),
    '  </tr>',
    '</table>',
  ].join('\n');
}

function countOccurrences(value, needle) {
  let count = 0;
  let index = 0;
  while ((index = value.indexOf(needle, index)) !== -1) {
    count += 1;
    index += needle.length;
  }
  return count;
}

export function replaceSection(content, table) {
  if (typeof content !== 'string') {
    fail('README content must be a string');
  }
  if (typeof table !== 'string') {
    fail('generated table must be a string');
  }
  const beginCount = countOccurrences(content, BEGIN_MARKER);
  const endCount = countOccurrences(content, END_MARKER);
  if (beginCount !== 1 || endCount !== 1) {
    fail('README must contain exactly one begin and one end generated-stats marker');
  }
  const beginIndex = content.indexOf(BEGIN_MARKER);
  const endIndex = content.indexOf(END_MARKER);
  if (endIndex < beginIndex) {
    fail('generated-stats markers are in the wrong order');
  }

  const normalizedTable = table
    .trim()
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n');

  const section = [
    BEGIN_MARKER,
    HEADING,
    '',
    normalizedTable,
    END_MARKER,
  ].join('\n');

  return content.slice(0, beginIndex) + section + content.slice(endIndex + END_MARKER.length);
}

// Compatibility aliases for callers and tests.
export const collect = collectStats;
export const collectRegistryStats = collectStats;
export const collectJson = (root = process.cwd()) => collectStats(root).json;
export const collectAsString = collectJson;
export const collectText = collectJson;
export const collectString = collectJson;
export const countStats = countRegistryStats;
export const calculateStats = countRegistryStats;
export const buildRows = (root = process.cwd()) => collectStats(root).rows;
export const buildStatsRows = buildRows;
export const replaceReadmeSection = replaceSection;
export const replaceMarkers = replaceSection;
export const replace = (content, table) => replaceSection(content, table);

const defaultExport = {
  isSafeRelativePath,
  loadRegistryConfig,
  countRegistryStats,
  collectStats,
  renderStatsCards,
  collect,
  collectRegistryStats,
  collectJson,
  collectAsString,
  collectText,
  collectString,
  countStats,
  calculateStats,
  buildRows,
  buildStatsRows,
  replaceSection,
  replaceReadmeSection,
  replaceMarkers,
  replace,
};
export default defaultExport;

function printUsage() {
  process.stderr.write('Usage: registry-readme-stats.mjs <collect|replace|refresh> [path]\n');
}

function runCollect(rootArgument) {
  const root = rootArgument || process.cwd();
  const result = collectStats(root);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `json=${result.json}\n`, 'utf8');
  }
  process.stdout.write(`${result.json}\n`);
}

function runReplace(fileArgument) {
  const filePath = fileArgument || process.env.README_PATH || 'README.md';
  const table = process.env.GENERATED_TABLE ?? process.env.TABLE ?? '';
  const content = readFileSync(filePath, 'utf8');
  const next = replaceSection(content, table);
  writeFileSync(filePath, next, 'utf8');
}

function runRefresh(fileArgument) {
  const filePath = fileArgument || process.env.README_PATH || 'README.md';
  const content = readFileSync(filePath, 'utf8');
  const cards = renderStatsCards(countRegistryStats());
  writeFileSync(filePath, replaceSection(content, cards), 'utf8');
}

function main() {
  const command = process.argv[2];
  const argument = process.argv[3];
  try {
    if (command === 'collect') {
      runCollect(argument);
    } else if (command === 'replace') {
      runReplace(argument);
    } else if (command === 'refresh') {
      runRefresh(argument);
    } else {
      printUsage();
      process.exitCode = 2;
    }
  } catch (error) {
    process.stderr.write(`${error && error.message ? error.message : error}\n`);
    process.exitCode = 1;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main();
}

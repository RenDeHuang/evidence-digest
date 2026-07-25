#!/usr/bin/env node
/**
 * Synthesizes a plausible web/public/api/ tree so the app can be exercised locally
 * without the real pipeline. Taxonomy comes from the real
 * pipeline/config/taxonomy/*.json files (rules stripped for the public shape);
 * journals come from the real pipeline/config/journals.json. Everything else —
 * ~120 studies, their derived topic/day/highlights/search-index files, and the
 * manifest — is fabricated but schema-shaped, per contract/api.schema.json and
 * shared/types.ts.
 *
 * Output is dev-only and gitignored (web/.gitignore -> public/api/). Run with
 * `npm run fixtures` from web/.
 */
import { readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.join(__dirname, '..');
const REPO_ROOT = path.join(WEB_ROOT, '..');
const OUT_DIR = path.join(WEB_ROOT, 'public', 'api');

const TAXONOMY_DIR = path.join(REPO_ROOT, 'pipeline', 'config', 'taxonomy');
const JOURNALS_PATH = path.join(REPO_ROOT, 'pipeline', 'config', 'journals.json');
const SCORING_PATH = path.join(REPO_ROOT, 'pipeline', 'config', 'scoring.json');

// Every specialty taxonomy file, read dynamically — the pipeline config currently
// defines 20 specialties (general-medicine, hematology, oncology, medical-ai,
// cardiology, ...); hardcoding a subset here would silently go stale as more are
// added.
const TAXONOMY_FILES = (await readdir(TAXONOMY_DIR)).filter((f) => f.endsWith('.json'));

// ---------------------------------------------------------------------------
// Small deterministic-ish RNG so a re-run is reproducible unless FIXTURE_SEED
// is changed — handy for debugging a specific-looking fixture set.
// ---------------------------------------------------------------------------
let seed = Number(process.env.FIXTURE_SEED ?? 20260724);
function rand() {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
}
function randomInt(min, max) {
  return Math.floor(rand() * (max - min + 1)) + min;
}
function pick(arr) {
  return arr[randomInt(0, arr.length - 1)];
}
function pickN(arr, n) {
  const pool = [...arr];
  const out = [];
  for (let i = 0; i < n && pool.length > 0; i++) {
    out.push(pool.splice(randomInt(0, pool.length - 1), 1)[0]);
  }
  return out;
}
function chance(p) {
  return rand() < p;
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}
function daysAgo(n) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return d;
}

// ---------------------------------------------------------------------------
// Load real config
// ---------------------------------------------------------------------------
const rawTaxonomies = await Promise.all(
  TAXONOMY_FILES.map(async (f) => JSON.parse(await readFile(path.join(TAXONOMY_DIR, f), 'utf8'))),
);
rawTaxonomies.sort((a, b) => a.order - b.order);

const journalsConfig = JSON.parse(await readFile(JOURNALS_PATH, 'utf8'));
const scoring = JSON.parse(await readFile(SCORING_PATH, 'utf8'));

// Public (stripped) taxonomy — additionalProperties:false in the contract, so only
// slug/name/blurb survive per topic, and slug/name/icon/blurb/topics per specialty.
const publicTaxonomy = {
  version: 1,
  specialties: rawTaxonomies.map((sp) => ({
    slug: sp.slug,
    name: sp.name,
    icon: sp.icon,
    blurb: sp.blurb,
    topics: sp.topics.map((t) => ({ slug: t.slug, name: t.name, blurb: t.blurb })),
  })),
};

// Flat topic list carrying along the *unstripped* rules (mesh/phrases) purely as a
// vocabulary source for generating plausible-sounding fixture text — never written
// to the output tree.
const flatTopics = rawTaxonomies.flatMap((sp) =>
  sp.topics.map((t) => ({
    slug: t.slug,
    name: t.name,
    specialtySlug: sp.slug,
    specialtyName: sp.name,
    mesh: t.rules?.mesh ?? [],
    phrases: t.rules?.phrases ?? [],
  })),
);

const taxonomySpecialtySlugs = new Set(rawTaxonomies.map((sp) => sp.slug));
const journalsBySpecialty = new Map();
for (const j of journalsConfig.journals) {
  if (!taxonomySpecialtySlugs.has(j.specialty)) continue; // defensive: skip any journal whose specialty has no taxonomy file
  const list = journalsBySpecialty.get(j.specialty) ?? [];
  list.push(j);
  journalsBySpecialty.set(j.specialty, list);
}

const publicJournals = journalsConfig.journals.map((j) => ({
  name: j.name,
  ta: j.ta,
  specialty: j.specialty,
  tier: j.tier,
  scope: j.scope,
  pubmedUrl: `https://pubmed.ncbi.nlm.nih.gov/?term=%22${encodeURIComponent(j.ta)}%22%5Bta%5D`,
}));

// ---------------------------------------------------------------------------
// Fixture text generators
// ---------------------------------------------------------------------------
const FIRST_NAMES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'J', 'K', 'L', 'M', 'N', 'P', 'R', 'S', 'T', 'W'];
const SURNAMES = [
  'Alvarez', 'Bennett', 'Chen', 'Delgado', 'Eriksson', 'Fischer', 'Gupta', 'Haddad', 'Ibrahim',
  'Jansen', 'Kowalski', 'Lindqvist', 'Mensah', 'Nakamura', 'Ortiz', 'Patel', 'Quintero', 'Rossi',
  'Sato', 'Thompson', 'Ueda', 'Vasquez', 'Weber', 'Xu', 'Yamamoto', 'Zimmer', 'Okafor', 'Kim',
];

function fakeAuthor() {
  return `${pick(SURNAMES)} ${pick(FIRST_NAMES)}${pick(FIRST_NAMES)}`;
}
function fakeAuthors() {
  const n = randomInt(1, 9);
  return Array.from({ length: Math.min(n, 12) }, fakeAuthor);
}
function authorLine(authors) {
  if (authors.length === 0) return '';
  if (authors.length <= 3) return authors.join(', ');
  return `${authors.slice(0, 3).join(', ')}, et al`;
}

const EVIDENCE_LEVEL_WEIGHTS = [
  ['guideline', 2],
  ['meta-analysis', 6],
  ['rct', 14],
  ['trial', 10],
  ['observational', 28],
  ['review', 16],
  ['basic', 12],
  ['case-report', 8],
  ['other', 4],
];
function weightedEvidenceLevel() {
  const total = EVIDENCE_LEVEL_WEIGHTS.reduce((s, [, w]) => s + w, 0);
  let r = rand() * total;
  for (const [level, w] of EVIDENCE_LEVEL_WEIGHTS) {
    if (r < w) return level;
    r -= w;
  }
  return 'other';
}

const PUB_TYPES_BY_LEVEL = {
  guideline: ['Practice Guideline'],
  'meta-analysis': ['Meta-Analysis', 'Systematic Review'],
  rct: ['Randomized Controlled Trial', 'Clinical Trial, Phase III'],
  trial: ['Clinical Trial', 'Clinical Trial, Phase II'],
  observational: ['Observational Study', 'Multicenter Study'],
  review: ['Review'],
  basic: ['Journal Article'],
  'case-report': ['Case Reports'],
  other: ['Journal Article', 'Comment'],
};

function titleFor(level, topic) {
  const phrase = pick(topic.phrases) ?? topic.name;
  switch (level) {
    case 'guideline':
      return `${topic.specialtyName} society guideline update: management of ${topic.name.toLowerCase()}`;
    case 'meta-analysis':
      return `${cap(phrase)} for ${topic.name.toLowerCase()}: a systematic review and meta-analysis`;
    case 'rct':
      return `${cap(phrase)} versus standard of care in ${topic.name.toLowerCase()}: a randomized trial`;
    case 'trial':
      return `Phase ${pick(['1', '2', '1/2'])} study of ${phrase} in ${topic.name.toLowerCase()}`;
    case 'observational':
      return `Outcomes of ${phrase} in ${topic.name.toLowerCase()}: a multicentre cohort study`;
    case 'review':
      return `${cap(topic.name)}: a narrative review of current evidence`;
    case 'basic':
      return `Mechanistic insights into ${phrase} in ${topic.name.toLowerCase()}`;
    case 'case-report':
      return `${cap(phrase)}-associated presentation in ${topic.name.toLowerCase()}: a case report`;
    default:
      return `${cap(topic.name)} in clinical practice: an evidence update`;
  }
}
function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function abstractSectionsFor(level, topic) {
  const phrase = pick(topic.phrases) ?? topic.name.toLowerCase();
  const n = randomInt(48, 2400);
  const sites = randomInt(1, 42);
  const hr = (rand() * 1.4 + 0.3).toFixed(2);
  const ciLow = (Number(hr) - rand() * 0.2).toFixed(2);
  const ciHigh = (Number(hr) + rand() * 0.3).toFixed(2);
  const pValue = rand() < 0.7 ? `<0.0${randomInt(1, 5)}` : `=0.${randomInt(6, 30)}`;
  const direction = rand() < 0.5 ? 'improved' : 'reduced';

  return {
    BACKGROUND: `The role of ${phrase} in patients with ${topic.name.toLowerCase()} remains incompletely defined, and prospective data are limited.`,
    METHODS:
      level === 'meta-analysis'
        ? `We searched MEDLINE, Embase, and CENTRAL through ${new Date().getFullYear()} and pooled results from eligible studies using a random-effects model.`
        : `We conducted a ${level === 'rct' ? 'randomized, controlled' : 'prospective'} study of ${n} patients with ${topic.name.toLowerCase()} across ${sites} ${sites === 1 ? 'center' : 'centers'}.`,
    RESULTS: `${cap(phrase)} was associated with ${direction} outcomes relative to comparison (hazard ratio ${hr}, 95% CI ${ciLow}-${ciHigh}; P${pValue}).`,
    CONCLUSIONS: `These findings support consideration of ${phrase} as part of the management approach to ${topic.name.toLowerCase()}, pending confirmation in further studies.`,
  };
}

function scoreFor({ level, tier, entryDate, hasTrialId, openAccess, isMulticentre, pubTypes }) {
  const evidencePoints = scoring.evidenceLevels[level]?.points ?? 0;
  const tierPoints = scoring.journalTier[String(tier)] ?? 0;
  const days = Math.round((Date.now() - new Date(entryDate).getTime()) / 86_400_000);
  const recency = scoring.recency.maxPoints * Math.pow(0.5, days / scoring.recency.halfLifeDays);

  let bonus = 0;
  if (hasTrialId) bonus += scoring.bonuses.hasTrialId;
  if (openAccess) bonus += scoring.bonuses.openAccess;
  if (isMulticentre) bonus += scoring.bonuses.multicentre;

  let penalty = 0;
  if (pubTypes.some((t) => /correction|retract/i.test(t))) penalty += scoring.penalties.correction;
  if (pubTypes.includes('Comment')) penalty += scoring.penalties.comment;

  const raw = evidencePoints + tierPoints + recency + bonus - penalty;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

// ---------------------------------------------------------------------------
// Generate studies
// ---------------------------------------------------------------------------
const STUDY_COUNT = 120;
const WINDOW_DAYS = scoring.limits.servedWindowDays;
let pmidCounter = 39_400_000;

const studies = [];
for (let i = 0; i < STUDY_COUNT; i++) {
  const topic = pick(flatTopics);
  const journalPool = journalsBySpecialty.get(topic.specialtySlug) ?? journalsConfig.journals;
  const journalCfg = pick(journalPool);
  const level = weightedEvidenceLevel();
  const entryDateObj = daysAgo(randomInt(0, WINDOW_DAYS - 1));
  const entryDate = isoDate(entryDateObj);
  // pubdate is on/near entryDate, sometimes month/year precision only.
  const pubPrecision = pick(['day', 'day', 'day', 'month', 'year']);
  const pd = new Date(entryDateObj);
  pd.setDate(pd.getDate() - randomInt(0, 14));
  const pubdate =
    pubPrecision === 'day'
      ? isoDate(pd)
      : pubPrecision === 'month'
        ? isoDate(pd).slice(0, 7)
        : isoDate(pd).slice(0, 4);

  const pmid = String(pmidCounter++);
  const authors = fakeAuthors();
  const hasAbstract = chance(0.94);
  const openAccess = chance(0.42);
  const hasTrialId = level !== 'review' && level !== 'basic' && chance(0.22);
  const isMulticentre = chance(0.3);
  const isCorrection = i > 4 && chance(0.02);
  const isRetraction = !isCorrection && i > 4 && chance(0.012);

  let pubTypes = [...(PUB_TYPES_BY_LEVEL[level] ?? ['Journal Article'])];
  if (isCorrection) pubTypes = ['Published Erratum', ...pubTypes];
  if (isRetraction) pubTypes = ['Retraction of Publication', ...pubTypes];

  // A minority of studies also match a second topic (usually in the same
  // specialty) so the app's cross-topic de-duplication has something to do.
  const topics = [topic.slug];
  const specialties = [topic.specialtySlug];
  if (chance(0.18)) {
    const sibling = pick(flatTopics.filter((t) => t.specialtySlug === topic.specialtySlug && t.slug !== topic.slug));
    if (sibling) topics.push(sibling.slug);
  }
  if (chance(0.06)) {
    const other = pick(flatTopics.filter((t) => t.specialtySlug !== topic.specialtySlug));
    if (other) {
      topics.push(other.slug);
      specialties.push(other.specialtySlug);
    }
  }

  const score = scoreFor({
    level,
    tier: journalCfg.tier,
    entryDate,
    hasTrialId,
    openAccess,
    isMulticentre,
    pubTypes,
  });

  const sections = hasAbstract ? abstractSectionsFor(level, topic) : {};
  const abstract = hasAbstract ? Object.values(sections).join(' ') : '';
  const takeaway = hasAbstract ? sections.CONCLUSIONS : '';

  const doi = `10.5555/ed.${pmid}`;
  const pmcid = openAccess ? `PMC${randomInt(9_000_000, 9_999_999)}` : null;
  const trialIds = hasTrialId ? [`NCT0${randomInt(1000000, 9999999)}`] : [];
  const mesh = pickN(topic.mesh.length > 0 ? topic.mesh : [topic.name], Math.min(topic.mesh.length, randomInt(2, 6)));
  const keywords = pickN(topic.phrases, Math.min(topic.phrases.length, randomInt(2, 5)));

  studies.push({
    pmid,
    doi,
    title: cap(titleFor(level, topic)),
    abstract,
    sections,
    takeaway,
    authors,
    authorLine: authorLine(authors),
    journal: { name: journalCfg.name, ta: journalCfg.ta, tier: journalCfg.tier },
    specialties,
    topics,
    pubTypes,
    evidence: {
      level,
      label: scoring.evidenceLevels[level].label,
      rank: scoring.evidenceLevels[level].rank,
    },
    score,
    pubdate,
    entryDate,
    url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
    doiUrl: `https://doi.org/${doi}`,
    pmcid,
    openAccess,
    mesh,
    keywords,
    trialIds,
    hasAbstract,
  });
}

// ---------------------------------------------------------------------------
// Derive served files
// ---------------------------------------------------------------------------
const now = new Date();
const generatedAt = now.toISOString();

const days = Array.from(new Set(studies.map((s) => s.entryDate))).sort((a, b) => (a < b ? 1 : -1));
const latestDay = days[0];

const topicCounts = {};
const specialtyCounts = {};
for (const s of studies) {
  for (const t of s.topics) topicCounts[t] = (topicCounts[t] ?? 0) + 1;
  for (const sp of s.specialties) specialtyCounts[sp] = (specialtyCounts[sp] ?? 0) + 1;
}

const manifest = {
  dataVersion: 1,
  generatedAt,
  windowDays: WINDOW_DAYS,
  days,
  latestDay,
  totalStudies: studies.length,
  journalCount: journalsConfig.journals.length,
  topicCounts,
  specialtyCounts,
};

function toStudyCard(s) {
  const { abstract, sections, mesh, keywords, ...card } = s;
  return card;
}

// topics/<slug>.json — one per topic that has >=1 study. Topics with zero studies
// deliberately get NO file, so the app's "missing topic file -> no studies yet"
// (not an error) path actually gets exercised.
const topicsDir = path.join(OUT_DIR, 'topics');
const topicFilesWritten = [];
for (const topic of flatTopics) {
  const matches = studies.filter((s) => s.topics.includes(topic.slug));
  if (matches.length === 0) continue;
  matches.sort((a, b) => (a.entryDate < b.entryDate ? 1 : a.entryDate > b.entryDate ? -1 : b.score - a.score));
  const capped = matches.slice(0, scoring.limits.perTopicFile);
  const file = {
    topic: topic.slug,
    specialty: topic.specialtySlug,
    generatedAt,
    total: matches.length,
    returned: capped.length,
    studies: capped.map(toStudyCard),
  };
  topicFilesWritten.push([topic.slug, file]);
}

// days/<date>.json — full Study objects, one file per date that has studies.
const dayFiles = days.map((date) => {
  const dayStudies = studies.filter((s) => s.entryDate === date);
  return [date, { date, generatedAt, total: dayStudies.length, studies: dayStudies }];
});

// highlights.json — top-scoring studies from the last 7 days, capped per specialty.
const since = isoDate(daysAgo(6));
const recentSorted = studies
  .filter((s) => s.entryDate >= since)
  .slice()
  .sort((a, b) => b.score - a.score);
const perSpecialtyCount = {};
const highlightPicks = [];
for (const s of recentSorted) {
  const sp = s.specialties[0];
  perSpecialtyCount[sp] = perSpecialtyCount[sp] ?? 0;
  if (perSpecialtyCount[sp] >= scoring.limits.highlightsPerSpecialty) continue;
  perSpecialtyCount[sp]++;
  highlightPicks.push(s);
  if (highlightPicks.length >= scoring.limits.highlights) break;
}
const highlights = {
  generatedAt,
  since,
  // NOTE: contract/api.schema.json's highlightsFile.studies references the FULL
  // study.schema.json (with abstract/mesh/keywords), but shared/types.ts types
  // HighlightsFile.studies as StudyCard[] (trimmed). This fixture follows
  // shared/types.ts, since that's what the web app actually parses — see the
  // final report for this contract mismatch.
  studies: highlightPicks.map(toStudyCard),
};

// search-index.json — compact, high-signal-only.
const searchSince = isoDate(daysAgo(scoring.limits.searchIndexWindowDays - 1));
const searchIndex = {
  generatedAt,
  minScore: scoring.limits.searchIndexMinScore,
  windowDays: scoring.limits.searchIndexWindowDays,
  entries: studies
    .filter((s) => s.score >= scoring.limits.searchIndexMinScore && s.entryDate >= searchSince)
    .map((s) => ({ p: s.pmid, t: s.title, j: s.journal.name, d: s.entryDate, s: s.score, tp: s.topics })),
};

const journalsFile = {
  generatedAt,
  count: publicJournals.length,
  journals: publicJournals,
};

// ---------------------------------------------------------------------------
// Write everything
// ---------------------------------------------------------------------------
await rm(OUT_DIR, { recursive: true, force: true });
await mkdir(topicsDir, { recursive: true });
await mkdir(path.join(OUT_DIR, 'days'), { recursive: true });

async function writeJson(filePath, data) {
  await writeFile(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

await writeJson(path.join(OUT_DIR, 'manifest.json'), manifest);
await writeJson(path.join(OUT_DIR, 'taxonomy.json'), publicTaxonomy);
await writeJson(path.join(OUT_DIR, 'journals.json'), journalsFile);
await writeJson(path.join(OUT_DIR, 'highlights.json'), highlights);
await writeJson(path.join(OUT_DIR, 'search-index.json'), searchIndex);
for (const [slug, file] of topicFilesWritten) {
  await writeJson(path.join(topicsDir, `${slug}.json`), file);
}
for (const [date, file] of dayFiles) {
  await writeJson(path.join(OUT_DIR, 'days', `${date}.json`), file);
}

const emptyTopics = flatTopics.filter((t) => !topicFilesWritten.some(([slug]) => slug === t.slug));

console.log(`Wrote fixtures to ${path.relative(REPO_ROOT, OUT_DIR)}/`);
console.log(`  ${studies.length} studies across ${days.length} days`);
console.log(`  ${topicFilesWritten.length} topic files written; ${emptyTopics.length} topics intentionally left with no file (tests the 404 -> "no studies yet" path): ${emptyTopics.map((t) => t.slug).join(', ') || '(none)'}`);
console.log(`  ${highlightPicks.length} highlights, ${searchIndex.entries.length} search-index entries`);
console.log(`  ${publicJournals.length} journals, ${publicTaxonomy.specialties.length} specialties, ${flatTopics.length} topics`);

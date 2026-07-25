#!/usr/bin/env node
/**
 * check-contract.mjs
 *
 * Guards against the pipeline's data shape and the frontend's type contract drifting
 * apart. Both `contract/study.schema.json` (the source of truth consumed by Python)
 * and `shared/types.ts` (the source of truth consumed by TypeScript) describe the
 * SAME `Study` object by hand, because a JSON Schema and a `.tsx`-friendly interface
 * can't be generated from one file without adding a build dependency neither the
 * pipeline nor the web app otherwise needs. Two hand-maintained descriptions of one
 * shape WILL drift eventually; this script is the tripwire.
 *
 * It performs two checks:
 *
 *   1. Field parity: every field in `study.schema.json`'s `required` array must have
 *      a matching, non-optional member in the `Study` TypeScript interface, and
 *      vice versa. (The schema declares every field required and every interface
 *      member non-optional by design — see the "Every field is always present"
 *      language in both files — so this also catches an accidentally-optional `?`
 *      field slipping into either side.)
 *
 *   2. StudyCard shape: `shared/types.ts` defines
 *        export type StudyCard = Omit<Study, 'abstract' | 'sections' | 'mesh' | 'keywords'>;
 *      This script asserts the Omit list is EXACTLY those four keys — no more, no
 *      fewer — because StudyCard is the shape shipped in every `api/topics/*.json`
 *      file and a silent change to it changes the wire payload for every reader.
 *
 * No dependencies: Node stdlib only (fs, path, url). Deliberately does not pull in
 * a TypeScript parser — `shared/types.ts` is simple enough that a brace-counting
 * walk over the `Study` interface body, plus a couple of regexes, is enough to be
 * reliable and stays readable without adding a devDependency to the whole repo just
 * to run one CI check.
 *
 * Usage:  node scripts/check-contract.mjs
 * Exit code 0 on success, 1 with a precise diff on any mismatch.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(SCRIPT_DIR, '..');
const SCHEMA_PATH = path.join(REPO_ROOT, 'contract', 'study.schema.json');
const TYPES_PATH = path.join(REPO_ROOT, 'shared', 'types.ts');

const EXPECTED_STUDY_CARD_OMIT = ['abstract', 'sections', 'mesh', 'keywords'];

/** Small formatting helpers so failures are easy to scan, not just true/false. */
const bullet = (items) => items.map((i) => `    - ${i}`).join('\n');

function fail(message) {
  console.error(`\n✗ check-contract: ${message}\n`);
  process.exitCode = 1;
}

function readRequired(filePath, label) {
  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`Could not read ${label} at ${filePath}: ${err.message}`);
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Step 1: load contract/study.schema.json and pull out its `required` list.
// ---------------------------------------------------------------------------

const schemaRaw = readRequired(SCHEMA_PATH, 'contract/study.schema.json');
let schema;
try {
  schema = JSON.parse(schemaRaw);
} catch (err) {
  console.error(`\n✗ check-contract: contract/study.schema.json is not valid JSON: ${err.message}\n`);
  process.exit(1);
}

if (!Array.isArray(schema.required) || schema.required.length === 0) {
  console.error('\n✗ check-contract: contract/study.schema.json has no non-empty "required" array.\n');
  process.exit(1);
}

const schemaRequiredFields = [...schema.required].sort();

// ---------------------------------------------------------------------------
// Step 2: load shared/types.ts and extract the body of `export interface Study`.
// ---------------------------------------------------------------------------

const typesSource = readRequired(TYPES_PATH, 'shared/types.ts');

/**
 * Finds `interface <name> {` and walks forward counting brace depth to find the
 * matching close brace. This is a simple, well-scoped substitute for a real TS
 * parser: it only needs to work on ONE interface body that we already know
 * contains no nested object-literal types (Study's few object-shaped fields —
 * `journal`, `evidence` — reference named interfaces, not inline `{ ... }`
 * literals, so no nested `{` appears inside the body).
 */
function extractInterfaceBody(source, interfaceName) {
  const marker = `interface ${interfaceName} {`;
  const markerStart = source.indexOf(marker);
  if (markerStart === -1) {
    throw new Error(`Could not find "interface ${interfaceName} {" in shared/types.ts`);
  }
  const bodyStart = markerStart + marker.length;
  let depth = 1;
  let i = bodyStart;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  if (depth !== 0) {
    throw new Error(`Unbalanced braces while scanning "interface ${interfaceName}" body.`);
  }
  return source.slice(bodyStart, i);
}

/**
 * Pulls top-level field names out of an interface body, one field per source line
 * (which is how shared/types.ts is formatted throughout). Skips blank lines,
 * `//` line comments, and `/** ... *\/` block comments (including the multi-line
 * doc comments that precede several fields). A field line looks like
 * `  fieldName: SomeType;` or `  fieldName?: SomeType;` — the leading identifier
 * before an optional `?` and a `:` is the field name.
 */
function extractFieldNames(interfaceBody) {
  const fields = [];
  const optionalFields = [];
  let inBlockComment = false;

  for (const rawLine of interfaceBody.split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;

    if (inBlockComment) {
      if (line.includes('*/')) inBlockComment = false;
      continue;
    }
    if (line.startsWith('/**') || line.startsWith('/*')) {
      if (!line.includes('*/')) inBlockComment = true;
      continue;
    }
    if (line.startsWith('*') || line.startsWith('//')) continue;

    const match = line.match(/^([A-Za-z_$][\w$]*)(\?)?\s*:/);
    if (match) {
      fields.push(match[1]);
      if (match[2]) optionalFields.push(match[1]);
    }
  }
  return { fields, optionalFields };
}

let studyBody;
try {
  studyBody = extractInterfaceBody(typesSource, 'Study');
} catch (err) {
  console.error(`\n✗ check-contract: ${err.message}\n`);
  process.exit(1);
}

const { fields: studyFields, optionalFields: studyOptionalFields } = extractFieldNames(studyBody);
const studyFieldsSorted = [...studyFields].sort();

// ---------------------------------------------------------------------------
// Step 3: compare the two field lists.
// ---------------------------------------------------------------------------

const requiredSet = new Set(schemaRequiredFields);
const studySet = new Set(studyFieldsSorted);

const missingFromInterface = schemaRequiredFields.filter((f) => !studySet.has(f));
const extraInInterface = studyFieldsSorted.filter((f) => !requiredSet.has(f));

let ok = true;

if (missingFromInterface.length > 0) {
  ok = false;
  fail(
    [
      'contract/study.schema.json lists fields as required that are missing from the',
      '`Study` interface in shared/types.ts:',
      bullet(missingFromInterface),
    ].join('\n'),
  );
}

if (extraInInterface.length > 0) {
  ok = false;
  fail(
    [
      'The `Study` interface in shared/types.ts has fields that are not in',
      "contract/study.schema.json's `required` array (either add them to the schema,",
      'or remove them from the interface):',
      bullet(extraInInterface),
    ].join('\n'),
  );
}

if (studyOptionalFields.length > 0) {
  ok = false;
  fail(
    [
      'contract/study.schema.json documents Study as "every field is always present"',
      '(optional info uses null or [], never a missing key), but these `Study` interface',
      'members are marked optional with `?` in shared/types.ts:',
      bullet(studyOptionalFields),
    ].join('\n'),
  );
}

if (ok) {
  console.log(
    `✓ Study field parity: ${schemaRequiredFields.length} fields match between ` +
      'contract/study.schema.json and the Study interface in shared/types.ts.',
  );
}

// ---------------------------------------------------------------------------
// Step 4: StudyCard must omit exactly abstract, sections, mesh, keywords.
// ---------------------------------------------------------------------------

const omitPattern =
  /export\s+type\s+StudyCard\s*=\s*Omit<\s*Study\s*,\s*((?:'[^']+'\s*\|?\s*)+)>\s*;/;
const omitMatch = typesSource.match(omitPattern);

if (!omitMatch) {
  ok = false;
  fail(
    'Could not find `export type StudyCard = Omit<Study, \'...\'>;` in shared/types.ts. ' +
      'StudyCard must be defined as an Omit<Study, ...> so this script can verify which ' +
      'fields it drops.',
  );
} else {
  const omittedFields = [...omitMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const omittedSorted = [...omittedFields].sort();
  const expectedSorted = [...EXPECTED_STUDY_CARD_OMIT].sort();

  const missingFromOmit = expectedSorted.filter((f) => !omittedFields.includes(f));
  const unexpectedInOmit = omittedFields.filter((f) => !EXPECTED_STUDY_CARD_OMIT.includes(f));
  const isDuplicated = new Set(omittedFields).size !== omittedFields.length;

  if (missingFromOmit.length > 0 || unexpectedInOmit.length > 0 || isDuplicated) {
    ok = false;
    const lines = [
      'StudyCard must omit exactly these four fields — no more, no fewer — because it is',
      'the shape shipped in every api/topics/*.json file:',
      `    expected: ${JSON.stringify(expectedSorted)}`,
      `    found:    ${JSON.stringify(omittedSorted)}`,
    ];
    if (missingFromOmit.length > 0) {
      lines.push('  Missing from the Omit list:', bullet(missingFromOmit));
    }
    if (unexpectedInOmit.length > 0) {
      lines.push('  Unexpectedly present in the Omit list:', bullet(unexpectedInOmit));
    }
    if (isDuplicated) {
      lines.push('  The Omit list contains a duplicate entry.');
    }
    fail(lines.join('\n'));
  } else {
    console.log(
      `✓ StudyCard omits exactly ${JSON.stringify(expectedSorted)}, as required.`,
    );
  }
}

// ---------------------------------------------------------------------------

if (!ok) {
  console.error('check-contract: FAILED — the pipeline and the frontend have drifted apart.\n');
  process.exit(1);
}

console.log('check-contract: OK\n');

# Contributing to Evidence Digest

Thanks for considering it. Most contributions to this project are config changes
(a journal, a topic, a classification rule) rather than code, and are genuinely
easy to make well. This document covers both.

## The one rule that matters most: topic slugs are permanent

A topic's `slug` (e.g. `cardio-heart-failure`) in `pipeline/config/taxonomy/*.json`
becomes a URL path, an RSS/Atom feed filename, and a stored subscriber preference
the moment it ships. **Never rename or remove a topic slug.** If a topic needs a
better name or scope, add a new topic and let the old one fade (or explicitly
mark it deprecated in its `blurb`) rather than renaming it — a rename silently
breaks every bookmark, every RSS reader subscription, and every subscriber's saved
preferences pointing at the old slug, with no error to tell them.

## Proposing a journal

Journals live in [`pipeline/config/journals.json`](pipeline/config/journals.json).
Easiest path: open a [Journal request](../../issues/new?template=journal_request.yml)
issue — it asks for exactly the fields below. To do it yourself:

1. Find the journal's exact **MEDLINE title abbreviation** — the `ta` field.
   This is the only journal identifier that doesn't drift (full titles and ISSNs
   both do). Look it up in the [NLM Catalog](https://www.ncbi.nlm.nih.gov/nlmcatalog/journals)
   or from the "Abbreviation" field on any of the journal's PubMed records.
2. Add an entry with `name`, `ta`, `specialty` (must match an existing specialty
   slug in `pipeline/config/taxonomy/`), `tier` (1 = practice-defining/flagship,
   2 = leading subspecialty, 3 = solid specialty — this only affects score, never
   whether a study is included), and `scope` (`"all"` unless the journal is a
   broad multidisciplinary title like *Nature* or *Science*, in which case use
   `"topic"` so only clinically relevant papers are pulled in via `topicFilter`).
3. Run `python -m evidence_digest.cli check`. A journal returning 0 hits over its
   check window almost always means the `ta` is wrong — fix it before opening a PR.

## Proposing a topic, or fixing a misclassification

Topics live one specialty per file under
[`pipeline/config/taxonomy/`](pipeline/config/taxonomy/). A study joins a topic
by accumulating points from `mesh` (highest weight — human-curated, but note
freshly indexed records often have none yet), `phrases` (title/keyword/abstract,
matched as whole phrases with word boundaries), and `acronyms` (case-SENSITIVE,
for initialisms like `AML` where lowercase would be nonsense) against
`scoring.json`'s `classifier.assignThreshold`. Use `not` for veto phrases that
should disqualify a match regardless of points (e.g. "renal failure" vetoing the
heart-failure topic). Full mechanics, including why case-sensitivity and MeSH
sparsity matter:
[evidence-digest-docs/taxonomy.md](https://github.com/muhammadali-k/evidence-digest-docs/blob/main/taxonomy.md).

For a misclassified study, open a
[Topic misclassification](../../issues/new?template=topic_misclassification.yml)
issue with the PMID, the topic it got, the topic it should have gotten, and why —
that's usually enough to turn into a one-line rule fix.

## Proposing a scoring or ranking change

Ranking weights live in [`pipeline/config/scoring.json`](pipeline/config/scoring.json).
Changes here affect every reader's ordering, so explain the reasoning in your PR
description (ideally with a worked example — "study X currently scores Y, should
score Z, because ..."). See
[evidence-digest-docs/ranking.md](https://github.com/muhammadali-k/evidence-digest-docs/blob/main/ranking.md)
for how the current weights were reasoned about.

## Running the tests

```bash
# Config validity + a live PubMed check of every journal abbreviation
python -m evidence_digest.cli validate
python -m evidence_digest.cli check

# Pipeline unit tests
python -m unittest discover -s pipeline/tests

# Contract parity (schema <-> shared/types.ts)
node scripts/check-contract.mjs

# Web app
cd web && npm install && npx tsc --noEmit && npm run build

# Worker
cd worker && npm install && npx tsc --noEmit
```

All of the above run in CI (`.github/workflows/ci.yml`) on every pull request.

## Commit conventions

Commit subjects are short, imperative, and prefixed by area when it helps a
reviewer scan `git log`:

- `data: ...` — reserved for the bot-authored harvest commits (`data: harvest
  2026-07-24 (1,204 new studies)`). Don't hand-author commits with this prefix.
- `taxonomy: ...`, `journals: ...`, `scoring: ...` — config changes in
  `pipeline/config/`.
- `pipeline: ...`, `web: ...`, `worker: ...` — code changes scoped to one part
  of the stack.
- `docs: ...`, `ci: ...`, `chore: ...` — as they sound.

Keep the subject line under ~72 characters; put the "why" in the body if it
isn't obvious from the diff.

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). Be kind.

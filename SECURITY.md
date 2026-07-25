# Security Policy

## Reporting a vulnerability

Please **do not** open a public GitHub issue for a security report.

Use GitHub's private reporting instead: go to this repository's **Security** tab
→ **Report a vulnerability**, which opens a private advisory only the maintainer
can see. That channel is enabled on this repository and is the fastest route.

(No email address is published here deliberately — a plain-text address on a
public repository gets scraped within days. If private advisories are not an
option for you, open a normal issue saying only that you have a security report
and asking for a contact, without any details of the finding.)

Please include:

- What you found and where (URL, endpoint, or file).
- Steps to reproduce, or a proof-of-concept if you have one.
- What you think the impact is.

You should get an acknowledgement within a few days. This is a solo-maintained
open-source project on a free tier, not a funded security program — there is no
bug bounty, but real reports are taken seriously and credited (with your
permission) once fixed.

## What is in scope

- **The Cloudflare Worker** (`worker/`) — the only part of this system that
  handles anything resembling personal data (an email address and topic
  preferences) or accepts write requests from the public internet (subscribe,
  unsubscribe, manage-preferences endpoints). This is the highest-value target
  and the most interesting place to look.
- **The GitHub Actions workflows** (`.github/workflows/`) — particularly
  anything that could leak `NCBI_API_KEY`, `PUBMED_EMAIL`, `BREVO_API_KEY`, or
  the repository's `contents: write` / `pages: write` permissions to an
  untrusted pull request (e.g. via `pull_request_target` misuse, or a workflow
  that echoes a secret into a log or into build output).
- **The static web app** (`web/`) — XSS via rendered study titles/abstracts
  (PubMed content, so technically third-party input), open redirect issues in
  the subscribe/manage flow, or anything that could exfiltrate a reader's
  stored preferences.

## What is out of scope

- The harvest pipeline (`pipeline/`) processes public PubMed data only and
  writes to a repository the maintainer controls; a malformed PubMed record
  causing a harvest failure is a bug report, not a security report (unless you
  can show it leads to something like arbitrary code execution or a supply-chain
  issue — that *is* in scope).
- Rate-limiting PubMed's own API, or PubMed/NLM infrastructure itself — report
  those to NLM, not here.
- Missing security headers or "best practice" findings on a static site with no
  authentication and no user-supplied content rendered as HTML, without a
  concrete exploit — these are welcome as regular (public) issues, not private
  security reports.

## What data this project actually stores

Evidence Digest's read path (the website, the RSS/Atom feeds) is fully static
and anonymous: no cookies, no accounts, no analytics, no tracking of any kind.

The **only** place any reader data is stored is the Cloudflare D1 database behind
the optional email Worker, and only for readers who choose to subscribe. Per the
Worker's design, that is limited to: an email address and topic/frequency
preferences. No browsing history, no IP address retention beyond what Cloudflare's
platform itself logs transiently for abuse prevention, and no data is sold or
shared with any third party other than Brevo, strictly as the transactional email
provider used to deliver the digest you signed up for. See
[evidence-digest-docs/privacy.md](https://github.com/muhammadali-k/evidence-digest-docs/blob/main/privacy.md)
for the full, reader-facing privacy statement, and
[evidence-digest-docs/architecture.md](https://github.com/muhammadali-k/evidence-digest-docs/blob/main/architecture.md)
for the Worker's trust/threat model.

## Supported versions

This project does not maintain multiple released versions — `main` is always the
supported, deployed version. Fixes land as new commits, not backports.

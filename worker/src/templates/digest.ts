import type { Frequency, StudyCard } from '../../../shared/types';
import type { SpecialtyGroup } from '../digest';
import type { RenderedEmail } from './confirm';
import { renderEmailShell, escapeHtml } from './layout';

export interface DigestEmailParams {
  groups: SpecialtyGroup[];
  corrections: StudyCard[];
  frequency: Frequency;
  manageUrl: string;
  unsubscribeUrl: string;
  siteUrl: string;
}

function specialtyNameList(names: string[]): string {
  if (names.length === 0) return 'your topics';
  if (names.length <= 3) return names.join(', ');
  return `${names.slice(0, 2).join(', ')}, and ${names.length - 2} more`;
}

function buildSubject(groups: SpecialtyGroup[], totalStudies: number, correctionsCount: number): string {
  if (totalStudies > 0) {
    const names = groups.map((g) => g.name);
    return `Evidence Digest — ${totalStudies} new ${totalStudies === 1 ? 'study' : 'studies'} in ${specialtyNameList(names)}`;
  }
  return `Evidence Digest — ${correctionsCount} correction${correctionsCount === 1 ? '' : 's'} to studies you follow`;
}

function evidenceBadge(label: string): string {
  return `<span class="muted" style="display:inline-block; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.03em; color:#5c6270; background-color:#f0f1f3; border-radius:4px; padding:2px 7px; margin-left:8px; vertical-align:middle;">${escapeHtml(label)}</span>`;
}

function studyBlockHtml(s: StudyCard): string {
  const doiLine = s.doiUrl
    ? `<a href="${escapeHtml(s.doiUrl)}" style="color:#2b6cb0; text-decoration:none;">DOI: ${escapeHtml(s.doi ?? '')}</a>`
    : '';
  return `
    <tr>
      <td style="padding:0 0 18px 0;">
        <div style="font-size:15px; line-height:1.5; margin:0 0 4px;">
          <a href="${escapeHtml(s.url)}" class="text" style="color:#1a1d23; font-weight:600; text-decoration:none;">${escapeHtml(s.title)}</a>${evidenceBadge(s.evidence.label)}
        </div>
        <div class="muted" style="font-size:12.5px; color:#5c6270; margin:0 0 6px;">
          ${escapeHtml(s.journal.name)} &middot; ${escapeHtml(s.pubdate)}${s.authorLine ? ` &middot; ${escapeHtml(s.authorLine)}` : ''}
        </div>
        ${s.takeaway ? `<div class="text" style="font-size:14px; line-height:1.55; color:#2a2e37; margin:0 0 6px;">${escapeHtml(s.takeaway)}</div>` : ''}
        ${doiLine ? `<div style="font-size:12.5px;">${doiLine}</div>` : ''}
      </td>
    </tr>`;
}

function studyBlockText(s: StudyCard): string {
  const lines = [
    `- ${s.title} [${s.evidence.label}]`,
    `  ${s.journal.name} · ${s.pubdate}${s.authorLine ? ` · ${s.authorLine}` : ''}`,
  ];
  if (s.takeaway) lines.push(`  ${s.takeaway}`);
  lines.push(`  ${s.url}`);
  if (s.doiUrl) lines.push(`  DOI: ${s.doiUrl}`);
  return lines.join('\n');
}

function correctionRowHtml(s: StudyCard): string {
  return `
    <tr>
      <td style="padding:0 0 10px 0;">
        <a href="${escapeHtml(s.url)}" class="muted" style="color:#5c6270; font-size:13.5px; text-decoration:underline;">${escapeHtml(s.title)}</a>
        <div class="muted" style="font-size:12px; color:#8a8f9a;">${escapeHtml(s.journal.name)} &middot; ${escapeHtml(s.pubdate)}</div>
      </td>
    </tr>`;
}

/** { subject, html, text } for a digest email. Groups are pre-ordered by the
 * taxonomy's specialty order and already capped/ranked by digest.ts. */
export function digestEmail(params: DigestEmailParams): RenderedEmail {
  const { groups, corrections, frequency, manageUrl, unsubscribeUrl, siteUrl } = params;
  const totalStudies = groups.reduce((n, g) => n + g.studies.length, 0);
  const subject = buildSubject(groups, totalStudies, corrections.length);
  const preheader =
    totalStudies > 0
      ? `${totalStudies} new ${totalStudies === 1 ? 'study' : 'studies'} matched your Evidence Digest topics.`
      : `${corrections.length} correction${corrections.length === 1 ? '' : 's'} to studies you follow.`;

  const groupsHtml = groups
    .map(
      (g) => `
    <h2 class="text" style="font-size:16px; margin:20px 0 4px; color:#1a1d23;">${g.icon ? `${escapeHtml(g.icon)} ` : ''}${escapeHtml(g.name)}</h2>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tbody>
      ${g.studies.map(studyBlockHtml).join('')}
    </tbody></table>`,
    )
    .join('');

  const correctionsHtml =
    corrections.length > 0
      ? `
    <h2 class="muted" style="font-size:14px; margin:24px 0 6px; color:#5c6270; border-top:1px solid #e6e8eb; padding-top:16px;">Corrections &amp; retractions</h2>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tbody>
      ${corrections.map(correctionRowHtml).join('')}
    </tbody></table>`
      : '';

  const bodyHtml = `
    <h1 class="text" style="margin:0 0 4px; font-size:19px; color:#1a1d23;">Your Evidence Digest</h1>
    <p class="muted" style="margin:0 0 12px; font-size:13px; color:#5c6270;">${escapeHtml(frequency)} digest</p>
    ${groupsHtml}
    ${correctionsHtml}
  `;

  const footerHtml = `
    <p class="muted" style="margin:0 0 10px; font-size:12px; line-height:1.6; color:#5c6270;">
      You're receiving this because you subscribed to these topics on Evidence Digest, a free study-alert service. Data from PubMed&reg;/MEDLINE, courtesy of the U.S. National Library of Medicine. Evidence Digest is not affiliated with or endorsed by NLM.
    </p>
    <p class="muted" style="margin:0; font-size:12px; line-height:1.6; color:#5c6270;">
      <a href="${escapeHtml(manageUrl)}">Manage preferences</a>
      &nbsp;&middot;&nbsp;
      <a href="${escapeHtml(unsubscribeUrl)}">Unsubscribe</a>
      &nbsp;&middot;&nbsp;
      <a href="${escapeHtml(siteUrl)}">${escapeHtml(siteUrl.replace(/^https?:\/\//, ''))}</a>
    </p>
  `;

  const html = renderEmailShell({ title: subject, preheader, bodyHtml, footerHtml });

  const textParts: string[] = ['Your Evidence Digest', `(${frequency} digest)`, ''];
  for (const g of groups) {
    textParts.push(`== ${g.icon ? `${g.icon} ` : ''}${g.name} ==`);
    for (const s of g.studies) textParts.push(studyBlockText(s), '');
  }
  if (corrections.length > 0) {
    textParts.push('== Corrections & retractions ==');
    for (const s of corrections) textParts.push(`- ${s.title} (${s.journal.name}, ${s.pubdate})`, `  ${s.url}`);
    textParts.push('');
  }
  textParts.push(
    "You're receiving this because you subscribed on Evidence Digest.",
    'Data from PubMed/MEDLINE, courtesy of the U.S. National Library of Medicine.',
    '',
    `Manage preferences: ${manageUrl}`,
    `Unsubscribe: ${unsubscribeUrl}`,
    `${siteUrl}`,
  );

  return { subject, html, text: textParts.join('\n') };
}

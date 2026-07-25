import type { Frequency } from '../../../shared/types';
import { renderEmailShell, button, escapeHtml } from './layout';

export interface ConfirmEmailParams {
  topicNames: string[];
  frequency: Frequency;
  confirmUrl: string;
  siteUrl: string;
  expiryDays: number;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/** The double opt-in email. One clear call to action, the topics the reader
 * chose listed back to them, and an explicit "if you did not request this,
 * ignore it" line — nothing further is sent unless the link is clicked. */
export function confirmEmail(params: ConfirmEmailParams): RenderedEmail {
  const { topicNames, frequency, confirmUrl, siteUrl, expiryDays } = params;
  const topicsList = topicNames.length > 0 ? topicNames.join(', ') : '(no topics selected)';

  const subject = 'Confirm your Evidence Digest subscription';
  const preheader = `Confirm to start receiving your ${frequency} Evidence Digest.`;

  const bodyHtml = `
    <h1 class="text" style="margin:0 0 16px; font-size:20px; color:#1a1d23;">Confirm your subscription</h1>
    <p class="text" style="margin:0 0 16px; font-size:15px; line-height:1.6; color:#1a1d23;">
      You (or someone using this address) requested a <strong>${escapeHtml(frequency)}</strong> Evidence Digest for:
    </p>
    <p class="text" style="margin:0 0 20px; font-size:15px; line-height:1.6; color:#1a1d23; padding:12px 16px; background-color:#f4f5f7; border-radius:8px;">
      ${escapeHtml(topicsList)}
    </p>
    <p style="margin:0 0 24px;">${button(confirmUrl, 'Confirm subscription')}</p>
    <p class="muted" style="margin:0 0 8px; font-size:13px; line-height:1.6; color:#5c6270;">
      This link expires in ${expiryDays} days.
    </p>
    <p class="muted" style="margin:0; font-size:13px; line-height:1.6; color:#5c6270;">
      If you did not request this, ignore this email and nothing further will be sent — the address will not be added without confirmation.
    </p>
  `;

  const footerHtml = `
    <p class="muted" style="margin:0; font-size:12px; line-height:1.6; color:#5c6270;">
      Evidence Digest &middot; <a href="${escapeHtml(siteUrl)}">${escapeHtml(siteUrl.replace(/^https?:\/\//, ''))}</a>
    </p>
  `;

  const html = renderEmailShell({ title: subject, preheader, bodyHtml, footerHtml });

  const text = [
    'Confirm your subscription',
    '',
    `You (or someone using this address) requested a ${frequency} Evidence Digest for:`,
    topicsList,
    '',
    `Confirm: ${confirmUrl}`,
    '',
    `This link expires in ${expiryDays} days.`,
    '',
    'If you did not request this, ignore this email and nothing further will be sent.',
    '',
    `Evidence Digest — ${siteUrl}`,
  ].join('\n');

  return { subject, html, text };
}

export interface ManageLinkEmailParams {
  manageUrl: string;
  siteUrl: string;
}

/** Sent when /api/subscribe is called for an address that is already active.
 * We never reveal that fact in the HTTP response (enumeration-safe), but the
 * only party who can read this email is whoever controls the address, so a
 * fresh manage link there is safe and useful. */
export function manageLinkEmail(params: ManageLinkEmailParams): RenderedEmail {
  const { manageUrl, siteUrl } = params;
  const subject = "You're already subscribed to Evidence Digest";
  const preheader = 'Here is a fresh link to manage your preferences.';

  const bodyHtml = `
    <h1 class="text" style="margin:0 0 16px; font-size:20px; color:#1a1d23;">You're already subscribed</h1>
    <p class="text" style="margin:0 0 20px; font-size:15px; line-height:1.6; color:#1a1d23;">
      This address already has an active Evidence Digest subscription. Use the link below to review or change your topics, frequency, or unsubscribe.
    </p>
    <p style="margin:0 0 24px;">${button(manageUrl, 'Manage my subscription')}</p>
    <p class="muted" style="margin:0; font-size:13px; line-height:1.6; color:#5c6270;">
      If you did not request this, no action is needed — your existing preferences are unchanged.
    </p>
  `;

  const footerHtml = `
    <p class="muted" style="margin:0; font-size:12px; line-height:1.6; color:#5c6270;">
      Evidence Digest &middot; <a href="${escapeHtml(siteUrl)}">${escapeHtml(siteUrl.replace(/^https?:\/\//, ''))}</a>
    </p>
  `;

  const html = renderEmailShell({ title: subject, preheader, bodyHtml, footerHtml });

  const text = [
    "You're already subscribed",
    '',
    'This address already has an active Evidence Digest subscription.',
    `Manage it: ${manageUrl}`,
    '',
    'If you did not request this, no action is needed.',
    '',
    `Evidence Digest — ${siteUrl}`,
  ].join('\n');

  return { subject, html, text };
}

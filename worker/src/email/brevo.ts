import type { EmailProvider, OutgoingEmail, SendResult } from './types';
import { withRetry } from './types';

/** Brevo (formerly Sendinblue) transactional email. Default provider —
 * Brevo's free plan is 300 emails/day, which is the real ceiling this
 * system is designed around (see wrangler.toml BATCH_SIZE comment). */
export class BrevoEmailProvider implements EmailProvider {
  constructor(private readonly apiKey: string) {}

  async send(msg: OutgoingEmail): Promise<SendResult> {
    const headers: Record<string, string> = { ...msg.headers };

    const res = await withRetry(() =>
      fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'api-key': this.apiKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          sender: { email: msg.from.email, name: msg.from.name },
          to: [{ email: msg.to }],
          ...(msg.replyTo ? { replyTo: { email: msg.replyTo } } : {}),
          subject: msg.subject,
          htmlContent: msg.html,
          textContent: msg.text,
          headers: Object.keys(headers).length > 0 ? headers : undefined,
          tags: msg.tags,
        }),
      }),
    );

    const data = (await res.json()) as { messageId?: string };
    return { id: data.messageId ?? 'unknown' };
  }
}

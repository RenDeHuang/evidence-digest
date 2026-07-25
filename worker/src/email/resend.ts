import type { EmailProvider, OutgoingEmail, SendResult } from './types';
import { withRetry } from './types';

/** Resend transactional email, as an alternative to Brevo. */
export class ResendEmailProvider implements EmailProvider {
  constructor(private readonly apiKey: string) {}

  async send(msg: OutgoingEmail): Promise<SendResult> {
    const res = await withRetry(() =>
      fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: `${msg.from.name} <${msg.from.email}>`,
          to: [msg.to],
          ...(msg.replyTo ? { reply_to: msg.replyTo } : {}),
          subject: msg.subject,
          html: msg.html,
          text: msg.text,
          headers: msg.headers,
          tags: msg.tags?.map((name) => ({ name, value: 'true' })),
        }),
      }),
    );

    const data = (await res.json()) as { id?: string };
    return { id: data.id ?? 'unknown' };
  }
}

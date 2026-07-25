import type { EmailProvider, OutgoingEmail, SendResult } from './types';

/** Logs the rendered email instead of sending. This is what runs when
 * EMAIL_PROVIDER is unset or "console", so `wrangler dev` works with zero
 * credentials. Never logs the recipient address (no PII in console.log). */
export class ConsoleEmailProvider implements EmailProvider {
  async send(msg: OutgoingEmail): Promise<SendResult> {
    const id = `console-${crypto.randomUUID()}`;
    // eslint-disable-next-line no-console
    console.log(
      `[email:console] id=${id} subject=${JSON.stringify(msg.subject)} headers=${JSON.stringify(msg.headers ?? {})}`,
    );
    // eslint-disable-next-line no-console
    console.log(`[email:console] ---- text/plain ----\n${msg.text}`);
    // eslint-disable-next-line no-console
    console.log(`[email:console] ---- text/html ----\n${msg.html}`);
    return { id };
  }
}

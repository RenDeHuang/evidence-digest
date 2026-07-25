import type { Env } from '../env';
import type { EmailProvider } from './types';
import { BrevoEmailProvider } from './brevo';
import { ResendEmailProvider } from './resend';
import { ConsoleEmailProvider } from './console';

export type { EmailProvider, OutgoingEmail, SendResult } from './types';
export { EmailProviderError } from './types';

/** Selects the provider named by EMAIL_PROVIDER. Returns null for "none" (no
 * secret required, no requests ever made) — callers must treat null as "email
 * is not configured on this deployment" and fail closed, never silently
 * drop the send. Falls back to console (never throws) for an unrecognized
 * value so a typo in the var doesn't 500 the whole API. */
export function getEmailProvider(env: Env): EmailProvider | null {
  switch (env.EMAIL_PROVIDER) {
    case 'brevo':
      if (!env.BREVO_API_KEY) throw new Error('EMAIL_PROVIDER=brevo but BREVO_API_KEY is not set');
      return new BrevoEmailProvider(env.BREVO_API_KEY);
    case 'resend':
      if (!env.RESEND_API_KEY) throw new Error('EMAIL_PROVIDER=resend but RESEND_API_KEY is not set');
      return new ResendEmailProvider(env.RESEND_API_KEY);
    case 'none':
      return null;
    case 'console':
    default:
      return new ConsoleEmailProvider();
  }
}

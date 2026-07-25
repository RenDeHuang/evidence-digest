export interface OutgoingEmail {
  to: string;
  from: { email: string; name: string };
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
  tags?: string[];
}

export interface SendResult {
  id: string;
}

/** A 4xx from the provider is permanent (bad request/address — do not retry)
 * — EXCEPT 429, which is rate-limiting, not a bad request, and is treated as
 * transient exactly like a 5xx (retry once with a short backoff, then record
 * the failure and let the cron's consecutive-failure counter take over). */
export class EmailProviderError extends Error {
  readonly status: number;
  readonly permanent: boolean;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`email provider error ${status}: ${body.slice(0, 500)}`);
    this.name = 'EmailProviderError';
    this.status = status;
    this.body = body.slice(0, 2000);
    this.permanent = isPermanent(status);
  }
}

function isPermanent(status: number): boolean {
  return status >= 400 && status < 500 && status !== 429;
}

export interface EmailProvider {
  send(msg: OutgoingEmail): Promise<SendResult>;
}

/** Shared retry policy for adapters that call a real HTTP API: on a
 * transient (5xx or 429) failure, wait briefly and try exactly once more. A
 * permanent (other 4xx) failure throws immediately without retrying. */
export async function withRetry(attempt: () => Promise<Response>): Promise<Response> {
  const first = await attempt();
  if (first.ok) return first;

  const body = await safeText(first);
  if (isPermanent(first.status)) {
    throw new EmailProviderError(first.status, body);
  }

  // Transient (5xx or 429): one retry with a short backoff.
  await new Promise((resolve) => setTimeout(resolve, 500));
  const second = await attempt();
  if (second.ok) return second;
  throw new EmailProviderError(second.status, await safeText(second));
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

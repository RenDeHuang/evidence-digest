import type { Env } from './env';

/** Optional Cloudflare Turnstile check, gated entirely on TURNSTILE_SECRET
 * being configured. Absent secret -> verification is skipped silently, so a
 * zero-config deployment still works. Present secret + missing/invalid
 * client token -> rejected. */
export async function verifyTurnstile(env: Env, token: unknown, remoteIp: string): Promise<boolean> {
  if (!env.TURNSTILE_SECRET) return true; // not configured: skip silently
  if (typeof token !== 'string' || token.length === 0) return false;

  try {
    const form = new URLSearchParams();
    form.set('secret', env.TURNSTILE_SECRET);
    form.set('response', token);
    if (remoteIp !== 'unknown') form.set('remoteip', remoteIp);

    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch {
    return false;
  }
}

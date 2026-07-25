/** Small response helpers shared by every route. Every response goes through
 * one of these so the security headers and content-type are never forgotten. */

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

export function json(body: unknown, init: { status?: number; headers?: HeadersInit } = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers });
}

export function html(body: string, init: { status?: number; headers?: HeadersInit } = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'text/html; charset=utf-8');
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
  return new Response(body, { status: init.status ?? 200, headers });
}

export function redirect(location: string, status: 301 | 302 = 302): Response {
  const headers = new Headers({ Location: location });
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
  return new Response(null, { status, headers });
}

export function notFound(): Response {
  return json({ ok: false, error: 'not_found' }, { status: 404 });
}

export function methodNotAllowed(): Response {
  return json({ ok: false, error: 'method_not_allowed' }, { status: 405 });
}

export function badRequest(error: string, detail?: string): Response {
  return json({ ok: false, error, ...(detail ? { detail } : {}) }, { status: 400 });
}

/** A tiny, dependency-free HTML page for the couple of spots (confirm/unsubscribe
 * landing) where a human clicked a link in an email and there is no SPA route to
 * hand them to for an error case. Not used for anything that accepts input. */
export function simplePage(title: string, message: string, siteUrl: string): string {
  const t = escapeHtml(title);
  const m = escapeHtml(message);
  const u = escapeHtml(siteUrl);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${t} — Evidence Digest</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; background:#f4f5f7; color:#1a1d23; margin:0; padding:40px 20px; }
  .card { max-width: 480px; margin: 0 auto; background:#fff; border-radius:12px; padding:32px; box-shadow:0 1px 3px rgba(0,0,0,.08); }
  h1 { font-size:20px; margin:0 0 12px; }
  p { line-height:1.5; color:#444; }
  a { color:#2b6cb0; }
  @media (prefers-color-scheme: dark) {
    body { background:#0f1115; color:#e6e6e6; }
    .card { background:#1a1d23; box-shadow:none; }
    p { color:#b8bcc4; }
    a { color:#7bb0e8; }
  }
</style>
</head>
<body>
  <div class="card">
    <h1>${t}</h1>
    <p>${m}</p>
    <p><a href="${u}">Return to Evidence Digest</a></p>
  </div>
</body>
</html>`;
}

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

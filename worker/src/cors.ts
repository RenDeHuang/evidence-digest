import type { Env } from './env';

const DEV_ORIGIN = 'http://localhost:5173';

/** Origins allowed to call this API from browser JS. Deliberately never "*":
 * several endpoints accept a body or mutate state via a token in the query
 * string, and a wildcard would let any page on the internet read the (masked)
 * responses cross-origin. */
function allowedOrigins(env: Env): string[] {
  return [env.ALLOWED_ORIGIN, DEV_ORIGIN];
}

export function corsHeaders(request: Request, env: Env): Headers {
  const headers = new Headers();
  const origin = request.headers.get('Origin');
  if (origin && allowedOrigins(env).includes(origin)) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Vary', 'Origin');
  }
  return headers;
}

export function withCors(response: Response, request: Request, env: Env): Response {
  const cors = corsHeaders(request, env);
  const headers = new Headers(response.headers);
  cors.forEach((v, k) => headers.set(k, v));
  return new Response(response.body, { status: response.status, headers });
}

export function handlePreflight(request: Request, env: Env): Response {
  const headers = corsHeaders(request, env);
  headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type');
  headers.set('Access-Control-Max-Age', '86400');
  return new Response(null, { status: 204, headers });
}

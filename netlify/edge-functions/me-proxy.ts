// Same-origin proxy for the Magic Eden public API.
//
// Why this exists: Magic Eden allowlists Access-Control-Allow-Origin to its own
// domain, so a browser on tothemoonsoon.xyz cannot call the API directly — every
// request fails with "No 'Access-Control-Allow-Origin' header". Server to server
// the same request is fine, so the page calls /api/me/* and we fetch upstream.
//
// The cache is not a nicety. Magic Eden allows 180 requests a minute per IP and
// every visitor leaves through Netlify's addresses, so without it a few dozen
// people polling at once would exhaust one shared budget. With a 25s TTL, a
// hundred visitors cost the same one upstream call as a single visitor.

const UPSTREAM = 'https://api-mainnet.magiceden.dev/v2/';
const TTL = 25;

// Only the endpoints the alerts tab actually needs. Without this the proxy would
// forward anything, which makes the site an open relay for someone else's traffic.
const ALLOWED = [
  /^collections\/[a-z0-9_]{1,64}\/(activities|stats|listings)$/,
  /^tokens\/[A-Za-z0-9]{32,44}$/
];

function fail(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return fail('method not allowed', 405);
  }

  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/me\/+/, '');
  if (!ALLOWED.some(function (re) { return re.test(path); })) {
    return fail('path not allowed', 404);
  }

  const target = UPSTREAM + path + url.search;
  const cacheKey = new Request(target, { method: 'GET' });

  let store: Cache | null = null;
  try {
    store = await caches.open('me-proxy-v1');
  } catch (e) {
    store = null; // caching unavailable: still correct, just more upstream calls
  }

  if (store) {
    try {
      const hit = await store.match(cacheKey);
      if (hit) {
        const body = await hit.text();
        return new Response(body, {
          status: 200,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'public, max-age=' + TTL,
            'x-me-cache': 'hit'
          }
        });
      }
    } catch (e) { /* treat a bad cache read as a miss */ }
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, { headers: { accept: 'application/json' } });
  } catch (e) {
    return fail('upstream unreachable', 502);
  }

  if (!upstream.ok) {
    // 429 is passed through unchanged so the page can back off instead of retrying.
    return fail('upstream responded ' + upstream.status, upstream.status === 429 ? 429 : 502);
  }

  const body = await upstream.text();
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'public, max-age=' + TTL,
    'netlify-cdn-cache-control': 'public, max-age=' + TTL + ', durable',
    'x-me-cache': 'miss'
  };
  const remaining = upstream.headers.get('x-ratelimit-remaining');
  if (remaining) headers['x-me-ratelimit-remaining'] = remaining;

  if (store) {
    try {
      await store.put(cacheKey, new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=' + TTL }
      }));
    } catch (e) { /* a failed cache write must not fail the request */ }
  }

  return new Response(body, { status: 200, headers: headers });
}

export const config = { path: '/api/me/*', cache: 'manual' };

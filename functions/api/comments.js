// Public comment endpoint. Deployed by Cloudflare Pages from this repo's functions/
// directory; the site itself stays a static Astro build.
import {
  validateComment, isLikelySpam, SLUG_RE, RATE_LIMIT_PER_MINUTE, MAX_COMMENTS_PER_POST,
} from '../_lib/comments.js';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

export async function hashIp(ip, salt) {
  const bytes = new TextEncoder().encode(`${salt ?? ''}:${ip ?? ''}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function turnstilePasses(token, secret, ip) {
  // This only runs once COMMENTS_DB is confirmed bound (see the guard in onRequestPost
  // below), which means the site was genuinely provisioned. A bound database with no
  // secret is a misconfiguration, not an unprovisioned preview — fail closed rather
  // than silently accepting unchallenged writes on a live site.
  if (!secret) return false;
  const form = new FormData();
  form.append('secret', secret);
  form.append('response', token ?? '');
  if (ip) form.append('remoteip', ip);
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
  const data = await res.json().catch(() => ({}));
  return data.success === true;
}

export async function onRequestGet({ request, env }) {
  if (!env.COMMENTS_DB) return json({ error: 'comments are not enabled for this site' }, 404);
  const slug = new URL(request.url).searchParams.get('slug') ?? '';
  if (!SLUG_RE.test(slug)) return json({ error: 'bad slug' }, 400);
  const { results } = await env.COMMENTS_DB
    .prepare('SELECT id, author, body, created_at FROM comments WHERE slug = ? AND status = ? ORDER BY created_at ASC LIMIT ' + MAX_COMMENTS_PER_POST)
    .bind(slug, 'approved')
    .all();
  return json({ comments: results ?? [] });
}

export async function onRequestPost({ request, env }) {
  if (!env.COMMENTS_DB) return json({ error: 'comments are not enabled for this site' }, 404);
  let input;
  try {
    input = await request.json();
  } catch {
    return json({ error: 'bad json' }, 400);
  }

  const { ok, errors, value } = validateComment(input);
  if (!ok) return json({ error: 'invalid', fields: errors }, 400);

  const ip = request.headers.get('cf-connecting-ip') ?? '';
  if (!(await turnstilePasses(input?.token, env.TURNSTILE_SECRET, ip))) {
    return json({ error: 'challenge failed' }, 403);
  }

  const ipHash = await hashIp(ip, env.IP_SALT);
  const since = new Date(Date.now() - 60_000).toISOString();
  const recent = await env.COMMENTS_DB
    .prepare('SELECT COUNT(*) AS n FROM comments WHERE ip_hash = ? AND created_at > ?')
    .bind(ipHash, since)
    .first();
  if ((recent?.n ?? 0) >= RATE_LIMIT_PER_MINUTE) return json({ error: 'slow down' }, 429);

  await env.COMMENTS_DB
    .prepare('INSERT INTO comments (id, slug, author, email, body, status, ip_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(
      crypto.randomUUID(),
      value.slug,
      value.author,
      value.email,
      value.body,
      isLikelySpam(value.body) ? 'spam' : 'pending',
      ipHash,
      new Date().toISOString(),
    )
    .run();

  return json({ status: 'pending' }, 201);
}

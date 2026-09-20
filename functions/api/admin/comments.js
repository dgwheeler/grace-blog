// Moderation endpoint. Cortex calls this with the site's ADMIN_TOKEN; no reader ever does.
const STATUSES = ['pending', 'approved', 'spam'];

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

function constantTimeEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authorised(request, env) {
  const expected = env.ADMIN_TOKEN ?? '';
  if (!expected) return false;
  const header = request.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  return constantTimeEquals(token, expected);
}

export async function onRequestGet({ request, env }) {
  if (!authorised(request, env)) return json({ error: 'unauthorised' }, 401);
  const status = new URL(request.url).searchParams.get('status') ?? 'pending';
  if (!STATUSES.includes(status)) return json({ error: 'bad status' }, 400);
  const { results } = await env.COMMENTS_DB
    .prepare('SELECT id, slug, author, email, body, status, created_at FROM comments WHERE status = ? ORDER BY created_at DESC LIMIT 500')
    .bind(status)
    .all();
  return json({ comments: results ?? [] });
}

export async function onRequestPost({ request, env }) {
  if (!authorised(request, env)) return json({ error: 'unauthorised' }, 401);
  let input;
  try {
    input = await request.json();
  } catch {
    return json({ error: 'bad json' }, 400);
  }
  const id = String(input?.id ?? '');
  const action = String(input?.action ?? '');
  if (!id) return json({ error: 'id required' }, 400);

  if (action === 'approve') {
    await env.COMMENTS_DB
      .prepare('UPDATE comments SET status = ?, approved_at = ? WHERE id = ?')
      .bind('approved', new Date().toISOString(), id)
      .run();
    return json({ status: 'ok' });
  }
  if (action === 'delete') {
    await env.COMMENTS_DB.prepare('DELETE FROM comments WHERE id = ?').bind(id).run();
    return json({ status: 'ok' });
  }
  return json({ error: 'unknown action' }, 400);
}

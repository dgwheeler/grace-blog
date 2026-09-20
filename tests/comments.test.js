import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { validateComment, isLikelySpam, MAX_BODY } from '../functions/_lib/comments.js';

describe('validateComment', () => {
  const good = { slug: 'on-shipping', author: 'Ada', body: 'This landed for me.', email: 'ada@example.com' };

  it('accepts a well-formed comment and trims it', () => {
    const r = validateComment({ ...good, author: '  Ada  ', body: '  This landed for me.  ' });
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ slug: 'on-shipping', author: 'Ada', body: 'This landed for me.', email: 'ada@example.com' });
  });

  it('rejects a slug that is not a plain post slug', () => {
    for (const slug of ['', '../etc', 'Has Spaces', 'UPPER', 'a'.repeat(121)]) {
      expect(validateComment({ ...good, slug }).errors).toContain('slug');
    }
  });

  it('rejects an empty or oversized body', () => {
    expect(validateComment({ ...good, body: ' ' }).errors).toContain('body');
    expect(validateComment({ ...good, body: 'x'.repeat(MAX_BODY + 1) }).errors).toContain('body');
  });

  it('rejects an oversized author and one containing a link', () => {
    expect(validateComment({ ...good, author: 'a'.repeat(61) }).errors).toContain('author');
    expect(validateComment({ ...good, author: 'buy at http://spam.example' }).errors).toContain('author');
  });

  it('treats email as optional but validates it when given', () => {
    const none = validateComment({ ...good, email: '' });
    expect(none.ok).toBe(true);
    expect(none.value.email).toBeNull();
    expect(validateComment({ ...good, email: 'not-an-email' }).errors).toContain('email');
  });

  it('survives a missing or non-object payload', () => {
    expect(validateComment(undefined).ok).toBe(false);
    expect(validateComment(null).ok).toBe(false);
  });
});

describe('isLikelySpam', () => {
  it('flags a body with more than two links', () => {
    expect(isLikelySpam('see http://a.example http://b.example http://c.example')).toBe(true);
  });

  it('leaves an ordinary body alone', () => {
    expect(isLikelySpam('I read this twice. See http://a.example for the paper.')).toBe(false);
  });
});

import { onRequestGet, onRequestPost, hashIp } from '../functions/api/comments.js';

function fakeDb(rows = []) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      const call = { sql, args: [] };
      calls.push(call);
      const stmt = {
        bind(...args) { call.args = args; return stmt; },
        async all() { return { results: rows }; },
        async first() { return rows[0] ?? null; },
        async run() { return { success: true }; },
      };
      return stmt;
    },
  };
}

// A bound COMMENTS_DB means the site was provisioned, which means a secret was set too
// (Cortex's provisioning route always sends one). Default the fixture env to a passing
// Turnstile challenge so tests that aren't specifically about Turnstile don't have to
// think about it; tests that ARE about Turnstile override TURNSTILE_SECRET and/or fetch.
const env = { COMMENTS_DB: null, TURNSTILE_SECRET: 'sk', IP_SALT: 'pepper' };
const req = (url, init) => new Request(url, init);

let realFetch;
beforeEach(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ success: true }), { status: 200 });
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('GET /api/comments', () => {
  it('returns approved comments for a slug', async () => {
    const db = fakeDb([{ id: 'c1', author: 'Ada', body: 'Yes.', created_at: '2026-09-15T00:00:00.000Z' }]);
    const res = await onRequestGet({ request: req('https://s.example/api/comments?slug=on-shipping'), env: { ...env, COMMENTS_DB: db } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ comments: [{ id: 'c1', author: 'Ada', body: 'Yes.', created_at: '2026-09-15T00:00:00.000Z' }] });
    expect(db.calls[0].sql).toContain('status = ?');
    expect(db.calls[0].args).toEqual(['on-shipping', 'approved']);
    expect(db.calls[0].sql).not.toContain('email');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('rejects a bad slug without touching the database', async () => {
    const db = fakeDb();
    const res = await onRequestGet({ request: req('https://s.example/api/comments?slug=../etc'), env: { ...env, COMMENTS_DB: db } });
    expect(res.status).toBe(400);
    expect(db.calls).toHaveLength(0);
  });

  it('returns 404 and touches nothing when the site has not been provisioned (no COMMENTS_DB)', async () => {
    const res = await onRequestGet({ request: req('https://s.example/api/comments?slug=on-shipping'), env: { ...env, COMMENTS_DB: undefined } });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'comments are not enabled for this site' });
  });
});

describe('POST /api/comments', () => {
  const post = (body, extraEnv = {}) => onRequestPost({
    request: req('https://s.example/api/comments', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9' },
      body: JSON.stringify(body),
    }),
    env: { ...env, ...extraEnv },
  });

  it('returns 404 and touches nothing when the site has not been provisioned (no COMMENTS_DB)', async () => {
    const res = await post({ slug: 'on-shipping', author: 'Ada', body: 'This landed.' }, { COMMENTS_DB: undefined });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'comments are not enabled for this site' });
  });

  it('fails closed with 403 and writes nothing when the database is bound but no Turnstile secret is configured', async () => {
    const db = fakeDb([{ n: 0 }]);
    const res = await post({ slug: 'on-shipping', author: 'Ada', body: 'This landed.' }, { COMMENTS_DB: db, TURNSTILE_SECRET: '' });
    expect(res.status).toBe(403);
    expect(db.calls).toHaveLength(0);
  });

  it('stores a valid comment as pending and answers 201', async () => {
    const db = fakeDb([{ n: 0 }]);
    const res = await post({ slug: 'on-shipping', author: 'Ada', body: 'This landed.' }, { COMMENTS_DB: db });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ status: 'pending' });
    const insert = db.calls.find(c => c.sql.startsWith('INSERT'));
    expect(insert.args[1]).toBe('on-shipping');
    expect(insert.args[5]).toBe('pending');
    expect(insert.args[6]).toMatch(/^[0-9a-f]{64}$/);      // ip_hash, not the IP
    expect(JSON.stringify(insert.args)).not.toContain('203.0.113.9');
  });

  it('files a link-stuffed body as spam rather than pending', async () => {
    const db = fakeDb([{ n: 0 }]);
    await post({ slug: 'on-shipping', author: 'Ada', body: 'http://a.example http://b.example http://c.example' }, { COMMENTS_DB: db });
    expect(db.calls.find(c => c.sql.startsWith('INSERT')).args[5]).toBe('spam');
  });

  it('rejects an invalid payload with the offending fields', async () => {
    const db = fakeDb([{ n: 0 }]);
    const res = await post({ slug: 'on-shipping', author: '', body: 'x' }, { COMMENTS_DB: db });
    expect(res.status).toBe(400);
    expect((await res.json()).fields).toEqual(expect.arrayContaining(['author', 'body']));
    expect(db.calls.find(c => c.sql.startsWith('INSERT'))).toBeUndefined();
  });

  it('refuses a fourth comment from the same address inside a minute', async () => {
    const db = fakeDb([{ n: 3 }]);
    const res = await post({ slug: 'on-shipping', author: 'Ada', body: 'Again.' }, { COMMENTS_DB: db });
    expect(res.status).toBe(429);
    expect(db.calls.find(c => c.sql.startsWith('INSERT'))).toBeUndefined();
  });

  it('rejects the comment when Turnstile says no', async () => {
    const db = fakeDb([{ n: 0 }]);
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ success: false }), { status: 200 });
    try {
      const res = await post({ slug: 'on-shipping', author: 'Ada', body: 'Hello.', token: 'bad' }, { COMMENTS_DB: db, TURNSTILE_SECRET: 'sk' });
      expect(res.status).toBe(403);
      expect(db.calls.find(c => c.sql.startsWith('INSERT'))).toBeUndefined();
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('accepts the comment when Turnstile says yes', async () => {
    const db = fakeDb([{ n: 0 }]);
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ success: true }), { status: 200 });
    try {
      const res = await post({ slug: 'on-shipping', author: 'Ada', body: 'Hello.', token: 'good' }, { COMMENTS_DB: db, TURNSTILE_SECRET: 'sk' });
      expect(res.status).toBe(201);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('hashIp', () => {
  it('is salted, hex, and stable', async () => {
    const a = await hashIp('203.0.113.9', 'pepper');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashIp('203.0.113.9', 'pepper')).toBe(a);
    expect(await hashIp('203.0.113.9', 'other')).not.toBe(a);
  });
});

import { onRequestGet as adminGet, onRequestPost as adminPost } from '../functions/api/admin/comments.js';

const adminEnv = (db) => ({ COMMENTS_DB: db, ADMIN_TOKEN: 'secret-token' });
const authed = (init = {}) => ({ ...init, headers: { ...(init.headers ?? {}), authorization: 'Bearer secret-token' } });

describe('admin comments endpoint', () => {
  it('refuses a request with no token, a wrong token, or when no token is configured', async () => {
    const db = fakeDb();
    const url = 'https://s.example/api/admin/comments?status=pending';
    expect((await adminGet({ request: req(url), env: adminEnv(db) })).status).toBe(401);
    expect((await adminGet({ request: req(url, { headers: { authorization: 'Bearer wrong' } }), env: adminEnv(db) })).status).toBe(401);
    expect((await adminGet({ request: req(url, authed()), env: { COMMENTS_DB: db, ADMIN_TOKEN: '' } })).status).toBe(401);
    expect(db.calls).toHaveLength(0);
  });

  it('lists comments of one status, newest first', async () => {
    const db = fakeDb([{ id: 'c1', slug: 'on-shipping', author: 'Ada', email: null, body: 'Yes.', status: 'pending', created_at: '2026-09-15T00:00:00.000Z' }]);
    const res = await adminGet({ request: req('https://s.example/api/admin/comments?status=pending', authed()), env: adminEnv(db) });
    expect(res.status).toBe(200);
    expect((await res.json()).comments).toHaveLength(1);
    expect(db.calls[0].args).toEqual(['pending']);
    expect(db.calls[0].sql).toContain('ORDER BY created_at DESC');
  });

  it('defaults to pending and rejects an unknown status', async () => {
    const db = fakeDb();
    await adminGet({ request: req('https://s.example/api/admin/comments', authed()), env: adminEnv(db) });
    expect(db.calls[0].args).toEqual(['pending']);
    const res = await adminGet({ request: req('https://s.example/api/admin/comments?status=nonsense', authed()), env: adminEnv(fakeDb()) });
    expect(res.status).toBe(400);
  });

  it('approves a comment, stamping approved_at', async () => {
    const db = fakeDb();
    const res = await adminPost({
      request: req('https://s.example/api/admin/comments', authed({ method: 'POST', body: JSON.stringify({ action: 'approve', id: 'c1' }) })),
      env: adminEnv(db),
    });
    expect(res.status).toBe(200);
    expect(db.calls[0].sql).toContain('UPDATE comments SET status = ?');
    expect(db.calls[0].args[0]).toBe('approved');
    expect(db.calls[0].args[2]).toBe('c1');
  });

  it('deletes a comment', async () => {
    const db = fakeDb();
    await adminPost({
      request: req('https://s.example/api/admin/comments', authed({ method: 'POST', body: JSON.stringify({ action: 'delete', id: 'c1' }) })),
      env: adminEnv(db),
    });
    expect(db.calls[0].sql).toContain('DELETE FROM comments');
    expect(db.calls[0].args).toEqual(['c1']);
  });

  it('rejects an unknown action', async () => {
    const db = fakeDb();
    const res = await adminPost({
      request: req('https://s.example/api/admin/comments', authed({ method: 'POST', body: JSON.stringify({ action: 'drop-table', id: 'c1' }) })),
      env: adminEnv(db),
    });
    expect(res.status).toBe(400);
    expect(db.calls).toHaveLength(0);
  });
});

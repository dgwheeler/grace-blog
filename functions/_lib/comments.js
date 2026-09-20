// Pure helpers shared by the public and admin comment endpoints. No Workers APIs here,
// so this file is unit-tested by tests/comments.test.js.

export const SLUG_RE = /^[a-z0-9-]{1,120}$/;
export const MAX_AUTHOR = 60;
export const MIN_BODY = 2;
export const MAX_BODY = 4000;
export const MAX_EMAIL = 200;
export const RATE_LIMIT_PER_MINUTE = 3;
export const MAX_COMMENTS_PER_POST = 200;

const LINK_RE = /https?:\/\//gi;

export function linkCount(text) {
  return (String(text ?? '').match(LINK_RE) || []).length;
}

export function isLikelySpam(body) {
  return linkCount(body) > 2;
}

export function validateComment(input) {
  const src = input && typeof input === 'object' ? input : {};
  const slug = String(src.slug ?? '').trim();
  const author = String(src.author ?? '').trim();
  const body = String(src.body ?? '').trim();
  const email = String(src.email ?? '').trim();

  const errors = [];
  if (!SLUG_RE.test(slug)) errors.push('slug');
  if (author.length < 1 || author.length > MAX_AUTHOR || linkCount(author) > 0) errors.push('author');
  if (body.length < MIN_BODY || body.length > MAX_BODY) errors.push('body');
  if (email && (email.length > MAX_EMAIL || !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email))) errors.push('email');

  return { ok: errors.length === 0, errors, value: { slug, author, body, email: email || null } };
}

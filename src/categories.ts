// Auto-generated from site config — do not edit manually.

export interface Category {
  slug: string;
  label: string;
  subtitle: string;
}

export const CATEGORIES: Category[] = [
  { slug: 'after_two_thirty', label: 'After Two Thirty', subtitle: '' },
  { slug: 'before_two_thirty', label: 'Before Two Thirty', subtitle: 'before the school bell rings' },
];

export function getCategoryLabel(slug: string): string {
  return CATEGORIES.find(c => c.slug === slug)?.label || slug;
}

export function getCategorySubtitle(slug: string): string {
  return CATEGORIES.find(c => c.slug === slug)?.subtitle || '';
}

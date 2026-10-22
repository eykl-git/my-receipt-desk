/** Fixed category list (design §4, A15). */
export const CATEGORY_IDS = ['dining', 'books', 'transport', 'groceries', 'office', 'other'] as const;
export type CategoryId = (typeof CATEGORY_IDS)[number];

export const CATEGORIES: ReadonlyArray<{ id: CategoryId; name: string }> = Object.freeze([
  { id: 'dining', name: 'Dining' },
  { id: 'books', name: 'Books & stationery' },
  { id: 'transport', name: 'Transport & parking' },
  { id: 'groceries', name: 'Groceries' },
  { id: 'office', name: 'Office supplies' },
  { id: 'other', name: 'Other' },
]);

export function categoryName(id: CategoryId): string {
  return CATEGORIES.find((c) => c.id === id)?.name ?? id;
}

export function isCategoryId(value: unknown): value is CategoryId {
  return typeof value === 'string' && (CATEGORY_IDS as readonly string[]).includes(value);
}

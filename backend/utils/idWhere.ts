/**
 * ID-format-aware Prisma where-clause helper.
 *
 * Entities may be referenced by either their legacy 24-char hex ID
 * (stored in the `mongoId` column) or by their native PG UUID (`id`).
 *
 * This utility inspects the incoming string:
 *  - UUID pattern  → `{ id: value }`   (native PG lookup)
 *  - Anything else → `{ mongoId: value }` (legacy ID lookup)
 *
 * Usage:
 *   db().campaign.findFirst({ where: { ...idWhere(someId), isDeleted: false } })
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUUID(value: string): boolean {
  return UUID_RE.test(value);
}

export function idWhere(value: string): { id: string } | { mongoId: string } {
  return isUUID(value) ? { id: value } : { mongoId: value };
}

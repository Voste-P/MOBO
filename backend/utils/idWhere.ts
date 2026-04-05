/**
 * ID-format-aware Prisma where-clause helper.
 *
 * All entities use native PostgreSQL UUIDs as their primary key.
 * This utility validates the format and returns a Prisma `where` clause.
 *
 * Usage:
 *   db().campaign.findFirst({ where: { ...idWhere(someId), isDeleted: false } })
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUUID(value: string): boolean {
  return UUID_RE.test(value);
}

export function idWhere(value: string): { id: string } {
  return { id: value };
}

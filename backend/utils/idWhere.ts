/**
 * ID-format-aware Prisma where-clause helper.
 *
 * All entities use native PostgreSQL UUIDs as their primary key.
 * This utility validates the format and returns a Prisma `where` clause.
 *
 * If the supplied value is not a valid UUID the helper substitutes the
 * nil UUID (`00000000-0000-0000-0000-000000000000`) so the subsequent
 * Prisma query returns `null` instead of crashing PostgreSQL with
 * "invalid input syntax for type uuid".
 *
 * Usage:
 *   db().campaign.findFirst({ where: { ...idWhere(someId), isDeleted: false } })
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

export function isUUID(value: string): boolean {
  return UUID_RE.test(value);
}

export function idWhere(value: string): { id: string } {
  return { id: UUID_RE.test(value) ? value : NIL_UUID };
}

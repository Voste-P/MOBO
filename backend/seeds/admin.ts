// Admin seeding — PG-only via Prisma.
import { randomUUID } from 'node:crypto';
import { hashPassword } from '../services/passwords.js';
import { prisma } from '../database/prisma.js';

export type SeedAdminArgs = {
  mobile?: string;
  username?: string;
  password?: string;
  name?: string;
  forcePassword?: boolean;
  forceUsername?: boolean;
};

export async function seedAdminOnly(args: SeedAdminArgs = {}) {
  const username = String(args.username ?? process.env.ADMIN_SEED_USERNAME ?? 'root')
    .trim()
    .toLowerCase();
  const mobile = String(args.mobile ?? process.env.ADMIN_SEED_MOBILE ?? '9000000000').trim();
  const password = String(args.password ?? process.env.ADMIN_SEED_PASSWORD ?? 'ChangeMe_123!');
  const name = String(args.name ?? process.env.ADMIN_SEED_NAME ?? 'Root Admin').trim();

  const isProd = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
  const looksPlaceholder = (value: string | undefined) => {
    if (!value) return true;
    const v = value.trim();
    if (!v) return true;
    if (v.includes('REPLACE_ME')) return true;
    if (v.toLowerCase().includes('changeme')) return true;
    if (v.startsWith('<') && v.endsWith('>')) return true;
    return false;
  };

  if (!username) throw new Error('seedAdminOnly: username is required');
  if (!mobile) throw new Error('seedAdminOnly: mobile is required');
  if (!password) throw new Error('seedAdminOnly: password is required');
  if (!name) throw new Error('seedAdminOnly: name is required');

  // Production safety: never silently seed a weak/default admin password.
  if (isProd) {
    if (looksPlaceholder(process.env.ADMIN_SEED_USERNAME) && !args.username) {
      throw new Error('seedAdminOnly: ADMIN_SEED_USERNAME must be set in production');
    }
    if (looksPlaceholder(process.env.ADMIN_SEED_PASSWORD) && !args.password) {
      throw new Error('seedAdminOnly: ADMIN_SEED_PASSWORD must be set in production');
    }
  }

  const shouldForcePassword = args.forcePassword === true;
  const shouldForceUsername = args.forceUsername === true;

  const db = prisma();

  // Try to find existing admin by username first, then by mobile.
  let user = await db.user.findFirst({ where: { username, isDeleted: false } });
  if (!user) {
    user = await db.user.findFirst({ where: { mobile, isDeleted: false } });
  }

  // Avoid clobbering an existing different user with the same username.
  if (user && user.username && user.username !== username) {
    const existingByUsername = await db.user.findFirst({ where: { username, isDeleted: false } });
    if (existingByUsername && existingByUsername.id !== user.id) {
      throw new Error(`seedAdminOnly: username '${username}' is already taken`);
    }
  }

  if (!user) {
    const passwordHash = await hashPassword(password);
    user = await db.user.create({
      data: {
        mongoId: randomUUID(),
        name,
        username,
        mobile,
        passwordHash,
        role: 'admin' as any,
        roles: ['admin'] as any,
        status: 'active' as any,
      },
    });
  } else {
    const updateData: any = {
      name,
      mobile,
      role: 'admin',
      roles: Array.from(new Set(['admin', ...(user.roles as string[] ?? [])])),
      status: 'active',
      isDeleted: false,
    };
    if (!user.username || shouldForceUsername) updateData.username = username;
    if (shouldForcePassword) {
      updateData.passwordHash = await hashPassword(password);
    }
    user = await db.user.update({ where: { id: user.id }, data: updateData });
  }

  return user;
}

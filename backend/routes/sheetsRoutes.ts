import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import type { Env } from '../config/env.js';
import { requireAuth } from '../middleware/auth.js';
import { exportToGoogleSheet, refreshUserGoogleToken } from '../services/sheetsService.js';
import { writeAuditLog } from '../services/audit.js';
import { logAccessEvent, logChangeEvent, logErrorEvent } from '../config/appLogs.js';
import { businessLog } from '../config/logger.js';
import { prisma, isPrismaAvailable } from '../database/prisma.js';
import { idWhere } from '../utils/idWhere.js';

const sheetExportSchema = z.object({
  title: z.string().trim().min(1).max(200),
  sheetName: z.string().trim().min(1).max(100).optional(),
  headers: z.array(z.string().min(1)).min(1).max(500),
  rows: z.array(z.array(z.union([z.string(), z.number(), z.null()]))).max(50_000),
});

export function sheetsRoutes(env: Env): Router {
  const router = Router();

  // All sheets endpoints require authentication
  router.use(requireAuth(env));

  // Rate limiter: 10 exports per 15 min in production (protects Google API quota)
  const sheetsWriteLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: process.env.NODE_ENV === 'production' ? 10 : 100,
    keyGenerator: (req) => (req as any).auth?.userId || req.ip || 'anon',
    message: { error: { code: 'RATE_LIMITED', message: 'Too many export requests. Please wait and try again.' } },
  });

  /**
   * POST /api/sheets/export
   * Creates a new Google Spreadsheet from provided headers + rows.
   * If the user has a connected Google account, the sheet is created in THEIR Drive.
   * Otherwise falls back to the service account.
   * Body: { title, sheetName?, headers: string[], rows: (string|number|null)[][] }
   * Returns: { spreadsheetId, spreadsheetUrl, sheetTitle }
   */
  router.post('/export', sheetsWriteLimiter, async (req, res, next) => {
    try {
      const { title, sheetName, headers, rows } = sheetExportSchema.parse(req.body);

      // Sanitize rows: coerce cells to string/number/null only
      const sanitizedRows = rows.map((row) => {
        return row.map((cell) => {
          if (cell === null || cell === undefined) return null;
          if (typeof cell === 'number') return cell;
          return String(cell);
        });
      });

      // Try user's own Google OAuth token first (sheet goes to THEIR Drive)
      let userAccessToken: string | null = null;
      let sharingEmail: string | null = null;
      try {
        const userId = (req as any).auth?.userId;
        if (userId && isPrismaAvailable()) {
          const db = prisma();
          const pgUser = await db.user.findFirst({
            where: idWhere(userId),
            select: { id: true, googleRefreshToken: true, googleEmail: true, email: true },
          });
          if (pgUser) {
            const refreshToken = pgUser.googleRefreshToken || null;
            sharingEmail = pgUser.googleEmail || pgUser.email || null;
            if (refreshToken) {
              userAccessToken = await refreshUserGoogleToken(refreshToken, env);
              if (!userAccessToken) {
                // Token refresh failed — clear invalid token
                await db.user.update({
                  where: { id: pgUser.id },
                  data: { googleRefreshToken: null },
                }).catch(() => {});
              }
            }
          }
        }
      } catch {
        // Fall back to service account silently
      }

      const result = await exportToGoogleSheet(env, { title, sheetName, headers, rows: sanitizedRows }, userAccessToken, sharingEmail);

      businessLog.info(`[Export] User ${(req as any).auth?.userId} exported Google Sheet — "${result.sheetTitle}", ${rows.length} rows`, { actorUserId: (req as any).auth?.userId, spreadsheetId: result.spreadsheetId, title: result.sheetTitle, rowCount: rows.length, ip: req.ip });

      // Audit trail
      writeAuditLog({
        req,
        action: 'GOOGLE_SHEET_EXPORTED',
        entityType: 'Export',
        entityId: result.spreadsheetId,
        metadata: {
          spreadsheetId: result.spreadsheetId,
          title: result.sheetTitle,
          rowCount: rows.length,
        },
      });

      logChangeEvent({
        actorUserId: (req as any).auth?.userId,
        actorRoles: (req as any).auth?.roles,
        actorIp: req.ip,
        entityType: 'Export',
        entityId: result.spreadsheetId,
        action: 'CREATE',
        requestId: String((res as any).locals?.requestId || ''),
        metadata: { title: result.sheetTitle, rowCount: rows.length },
      });

      logAccessEvent('RESOURCE_ACCESS', {
        userId: (req as any).auth?.userId,
        roles: (req as any).auth?.roles,
        ip: req.ip,
        resource: 'GoogleSheet',
        requestId: String((res as any).locals?.requestId || ''),
        metadata: { action: 'SHEET_EXPORTED', spreadsheetId: result.spreadsheetId, title: result.sheetTitle, rowCount: rows.length },
      });

      return res.json(result);
    } catch (err: any) {
      logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'EXTERNAL_SERVICE', severity: 'medium', userId: (req as any).auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'sheets/export' } });
      // Surface a clear error when Service Account auth is not configured
      if (err?.message?.includes('GOOGLE_SHEETS_AUTH_MISSING')) {
        return res.status(503).json({
          error: {
            code: 'SHEETS_AUTH_NOT_CONFIGURED',
            message: 'Google Sheets export is not available. The server administrator must configure a Google Cloud Service Account. See server logs for setup instructions.',
          },
        });
      }
      next(err);
    }
  });

  return router;
}

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import type { Env } from '../config/env.js';
import { requireAuth, requireRoles } from '../middleware/auth.js';
import { makeInviteController } from '../controllers/inviteController.js';
import { makeAdminController } from '../controllers/adminController.js';

export function adminRoutes(env: Env): Router {
  const router = Router();
  const invites = makeInviteController();
  const admin = makeAdminController();

  router.use(requireAuth(env));
  router.use(requireRoles('admin'));

  const adminLimiter = rateLimit({
    windowMs: 15 * 60_000,
    limit: env.NODE_ENV === 'production' ? 900 : 10_000,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({
        error: { code: 'RATE_LIMITED', message: 'Too many requests. Please wait a few minutes and try again.' },
      });
    },
  });
  router.use(adminLimiter);

  router.get('/invites', invites.adminListInvites);
  router.post('/invites', invites.adminCreateInvite);
  router.post('/invites/revoke', invites.adminRevokeInvite);
  router.delete('/invites/:code', invites.adminDeleteInvite);

  // ID parameter validation middleware for destructive delete endpoints
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const LEGACY_ID_RE = /^[0-9a-fA-F]{24}$/;
  const validateIdParam = (paramName: string) => (req: any, res: any, next: any) => {
    const val = req.params[paramName];
    if (!UUID_RE.test(val) && !LEGACY_ID_RE.test(val)) {
      return res.status(400).json({ error: { code: 'INVALID_ID', message: `Invalid ${paramName} format` } });
    }
    next();
  };

  // Require X-Confirm-Delete header for destructive operations to prevent accidental deletion
  const requireDeleteConfirmation = (req: any, res: any, next: any) => {
    if (req.headers['x-confirm-delete'] !== 'true') {
      return res.status(400).json({ error: { code: 'CONFIRMATION_REQUIRED', message: 'Set X-Confirm-Delete: true header to confirm deletion' } });
    }
    next();
  };

  router.get('/config', admin.getSystemConfig);
  router.patch('/config', admin.updateSystemConfig);

  router.get('/users', admin.getUsers);
  router.get('/financials', admin.getFinancials);
  router.get('/stats', admin.getStats);
  router.get('/growth', admin.getGrowth);
  router.get('/products', admin.getProducts);
  router.patch('/users/status', admin.updateUserStatus);
  router.delete('/products/:dealId', validateIdParam('dealId'), requireDeleteConfirmation, admin.deleteDeal);
  router.delete('/users/:userId', validateIdParam('userId'), requireDeleteConfirmation, admin.deleteUser);
  router.delete('/wallets/:userId', validateIdParam('userId'), requireDeleteConfirmation, admin.deleteWallet);

  router.post('/orders/reactivate', admin.reactivateOrder);

  router.get('/audit-logs', admin.getAuditLogs);

  // Security question templates CRUD
  router.get('/security-question-templates', admin.getSecurityQuestionTemplates);
  router.post('/security-question-templates', admin.createSecurityQuestionTemplate);
  router.patch('/security-question-templates/:questionId', admin.updateSecurityQuestionTemplate);
  router.delete('/security-question-templates/:questionId', admin.deleteSecurityQuestionTemplate);

  return router;
}

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import type { Env } from '../config/env.js';
import { makeProductsController } from '../controllers/productsController.js';
import { requireAuth, requireRoles } from '../middleware/auth.js';

export function productsRoutes(env: Env): Router {
  const router = Router();
  const controller = makeProductsController();

  // Rate-limit redirect/pre-order creation to prevent abuse.
  const redirectLimiter = rateLimit({
    windowMs: 60_000,
    limit: env.NODE_ENV === 'production' ? 30 : 1000,
    standardHeaders: true,
    legacyHeaders: false,
  });

  router.get('/products', requireAuth(env), requireRoles('shopper'), (_req, res, next) => {
    res.setHeader('Cache-Control', 'private, max-age=60');
    next();
  }, controller.listProducts);

  // Redirect tracking: returns a URL + creates a REDIRECTED pre-order.
  router.post('/deals/:dealId/redirect', requireAuth(env), requireRoles('shopper'), redirectLimiter, controller.trackRedirect);

  return router;
}

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import type { Env } from '../config/env.js';
import { makeAuthController } from '../controllers/authController.js';
import { requireAuth } from '../middleware/auth.js';

export function authRoutes(env: Env): Router {
  const router = Router();
  const controller = makeAuthController(env);

  // Auth responses contain credentials/tokens; they must not be cached.
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  const authLimiter = rateLimit({
    windowMs: 15 * 60_000,
    limit: env.NODE_ENV === 'production' ? 60 : 10_000,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
      const body = (req as any).body || {};
      const identifierRaw =
        body.mobile || body.username || body.brandCode || body.code || body.mediatorCode || body.email;
      const identifier = String(identifierRaw || 'anon').toLowerCase().trim();
      const ip = String(req.ip || 'unknown');
      return `${ip}:${identifier}`;
    },
    handler: (_req, res) => {
      res.status(429).json({
        error: { code: 'RATE_LIMITED', message: 'Too many requests. Please wait a few minutes and try again.' },
      });
    },
  });

  router.post('/register', authLimiter, controller.register);
  router.post('/login', authLimiter, controller.login);
  router.post('/refresh', authLimiter, controller.refresh);

  router.get('/me', requireAuth(env), controller.me);

  router.post('/register-ops', authLimiter, controller.registerOps);
  router.post('/register-brand', authLimiter, controller.registerBrand);
  router.patch('/profile', requireAuth(env), controller.updateProfile);

  // Security questions & forgot password
  router.post('/security-questions', requireAuth(env), controller.saveSecurityQuestions);
  router.post('/forgot-password/lookup', authLimiter, controller.forgotPasswordLookup);
  router.post('/forgot-password/reset', authLimiter, controller.forgotPasswordReset);

  return router;
}

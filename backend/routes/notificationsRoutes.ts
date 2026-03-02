import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import type { Env } from '../config/env.js';
import { requireAuth } from '../middleware/auth.js';
import { makeNotificationsController } from '../controllers/notificationsController.js';
import { makePushNotificationsController } from '../controllers/pushNotificationsController.js';

export function notificationsRoutes(env: Env): Router {
  const router = Router();
  const controller = makeNotificationsController();
  const push = makePushNotificationsController(env);

  // Rate-limit push subscription endpoints to prevent spam.
  const pushWriteLimiter = rateLimit({
    windowMs: 60_000,
    limit: env.NODE_ENV === 'production' ? 10 : 1000,
    standardHeaders: true,
    legacyHeaders: false,
  });

  router.get('/', requireAuth(env), (_req, res, next) => {
    res.setHeader('Cache-Control', 'private, max-age=10');
    next();
  }, controller.list);

  router.get('/push/public-key', push.publicKey);
  router.post('/push/subscribe', requireAuth(env), pushWriteLimiter, push.subscribe);
  router.delete('/push/subscribe', requireAuth(env), pushWriteLimiter, push.unsubscribe);

  return router;
}

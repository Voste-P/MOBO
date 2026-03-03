import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import type { Env } from '../config/env.js';
import { requireAuth } from '../middleware/auth.js';
import { makeTicketsController } from '../controllers/ticketsController.js';
import { ROLE_ISSUE_TYPES } from '../validations/tickets.js';

export function ticketsRoutes(env: Env): Router {
  const router = Router();
  const tickets = makeTicketsController();

  // Rate-limit ticket write operations to prevent spam.
  const ticketWriteLimiter = rateLimit({
    windowMs: 60_000,
    limit: env.NODE_ENV === 'production' ? 15 : 1000,
    standardHeaders: true,
    legacyHeaders: false,
  });

  // Return role-specific issue types for the current user
  router.get('/tickets/issue-types', requireAuth(env), (req, res) => {
    const role = String(req.auth?.roles?.[0] || 'shopper');
    const types = ROLE_ISSUE_TYPES[role] || ROLE_ISSUE_TYPES.shopper;
    res.json({ issueTypes: types, role });
  });

  router.get('/tickets', requireAuth(env), tickets.listTickets);
  router.post('/tickets', requireAuth(env), ticketWriteLimiter, tickets.createTicket);
  router.patch('/tickets/:id', requireAuth(env), ticketWriteLimiter, tickets.updateTicket);
  router.delete('/tickets/:id', requireAuth(env), ticketWriteLimiter, tickets.deleteTicket);

  return router;
}

import { z } from 'zod';

// Role-specific issue type options for the ticket system
export const ROLE_ISSUE_TYPES: Record<string, readonly string[]> = {
  shopper: ['Cashback Delay', 'Wrong Amount', 'Order Issue', 'Product Issue', 'Delivery Problem', 'Refund Request', 'Feedback', 'Other'],
  user: ['Cashback Delay', 'Wrong Amount', 'Order Issue', 'Product Issue', 'Delivery Problem', 'Refund Request', 'Feedback', 'Other'],
  mediator: ['Commission Delay', 'Team Issue', 'Campaign Problem', 'Payout Issue', 'Buyer Complaint', 'Feedback', 'Other'],
  agency: ['Brand Campaign Issue', 'Mediator Performance', 'Payout Delay', 'Technical Issue', 'Campaign Setup', 'Feedback', 'Other'],
  brand: ['Campaign Setup', 'Agency Connection', 'Order Dispute', 'Payment Issue', 'Quality Concern', 'Feedback', 'Other'],
} as const;

// Cascade routing: which role should handle tickets from each role
export const TICKET_TARGET_ROLE: Record<string, string> = {
  shopper: 'mediator',   // buyer → mediator
  mediator: 'agency',    // mediator → agency
  agency: 'brand',       // agency → brand
  brand: 'admin',        // brand → admin
} as const;

// NOTE: Clients may send userId/userName/role from legacy UI forms.
// We intentionally DO NOT trust those fields and derive identity from auth context.
export const createTicketSchema = z.object({
  orderId: z.string().min(1).optional(),
  issueType: z.string().min(1).max(200),
  description: z.string().min(1).max(5000),
  userId: z.string().min(1).optional(),
  userName: z.string().min(1).max(200).optional(),
  role: z.string().min(1).max(50).optional(),
});

// Escalation: the next tier above each target role
export const ESCALATION_PATH: Record<string, string> = {
  mediator: 'agency',    // mediator → agency
  agency: 'brand',       // agency → brand
  brand: 'admin',        // brand → admin
} as const;

export const updateTicketSchema = z.object({
  status: z.enum(['Open', 'Resolved', 'Rejected']),
  resolutionNote: z.string().max(1000).optional(),
  escalate: z.boolean().optional(),
});

/** Role hierarchy level — used to gate resolve/reject/escalate on targetRole */
export const ROLE_LEVEL: Record<string, number> = {
  shopper: 0,
  user: 0,
  mediator: 1,
  agency: 2,
  brand: 3,
  admin: 4,
  ops: 4,
} as const;

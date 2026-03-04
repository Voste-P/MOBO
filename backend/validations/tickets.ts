import { z } from 'zod';

// Role-specific issue type options for the ticket system
export const ROLE_ISSUE_TYPES: Record<string, readonly string[]> = {
  shopper: ['Cashback Delay', 'Wrong Amount', 'Order Issue', 'Product Issue', 'Delivery Problem', 'Refund Request', 'Feedback', 'Other'],
  mediator: ['Commission Delay', 'Team Issue', 'Campaign Problem', 'Payout Issue', 'Buyer Complaint', 'Other'],
  agency: ['Brand Campaign Issue', 'Mediator Performance', 'Payout Delay', 'Technical Issue', 'Campaign Setup', 'Other'],
  brand: ['Campaign Setup', 'Agency Connection', 'Order Dispute', 'Payment Issue', 'Quality Concern', 'Other'],
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
  priority: z.enum(['low', 'medium', 'high', 'urgent']).optional().default('medium'),

  userId: z.string().min(1).optional(),
  userName: z.string().min(1).max(200).optional(),
  role: z.string().min(1).max(50).optional(),
});

export const updateTicketSchema = z.object({
  status: z.enum(['Open', 'Resolved', 'Rejected']),
  resolutionNote: z.string().max(1000).optional(),
});

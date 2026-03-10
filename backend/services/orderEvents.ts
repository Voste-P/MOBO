export type OrderEventType =
  | 'ORDERED'
  | 'PROOF_SUBMITTED'
  | 'VERIFIED'
  | 'REJECTED'
  | 'FRAUD_ALERT'
  | 'SETTLED'
  | 'UNSETTLED'
  | 'CAP_EXCEEDED'
  | 'FROZEN_DISPUTED'
  | 'MISSING_PROOF_REQUESTED'
  | 'STATUS_CHANGED'
  | 'WORKFLOW_TRANSITION'
  | 'WORKFLOW_FROZEN'
  | 'WORKFLOW_REACTIVATED';

export type OrderEvent = {
  type: OrderEventType;
  at: Date;
  actorUserId?: string;
  metadata?: any;
};

/** Maximum events per order to prevent unbounded JSON array growth. */
const MAX_ORDER_EVENTS = 500;

export function pushOrderEvent(events: any[] | undefined, event: OrderEvent) {
  const arr = Array.isArray(events) ? events : [];
  // If at capacity, drop the oldest non-terminal events to make room
  if (arr.length >= MAX_ORDER_EVENTS) {
    arr.splice(0, arr.length - MAX_ORDER_EVENTS + 1);
  }
  arr.push({
    type: event.type,
    at: event.at,
    actorUserId: event.actorUserId as any,
    metadata: event.metadata,
  });
  return arr;
}

export function isTerminalAffiliateStatus(status: string): boolean {
  return (
    status === 'Approved_Settled' ||
    status === 'Cap_Exceeded' ||
    status === 'Frozen_Disputed'
  );
}

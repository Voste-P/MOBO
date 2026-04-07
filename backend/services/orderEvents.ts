export type OrderEventType =
  | 'ORDERED'
  | 'PROOF_SUBMITTED'
  | 'VERIFIED'
  | 'REJECTED'
  | 'SETTLED'
  | 'UNSETTLED'
  | 'CAP_EXCEEDED'
  | 'FROZEN_DISPUTED'
  | 'MISSING_PROOF_REQUESTED'
  | 'PROOFS_CANCELLED'
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
  // If at capacity, drop oldest entries keeping last (MAX - 1) items
  if (arr.length >= MAX_ORDER_EVENTS) {
    const keep = arr.slice(-(MAX_ORDER_EVENTS - 1));
    arr.length = 0;
    arr.push(...keep);
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

-- One-time data repair: recalculate campaigns.used_slots from actual orders.
--
-- Root cause: rejectOrderProof was decrementing used_slots on proof rejection
-- but the slot was never re-incremented when the buyer re-uploaded proofs.
-- This left used_slots under-counted for campaigns that had rejection cycles.
--
-- Run once against the production database after deploying the code fix.
-- Safe to re-run — it is idempotent.
--
-- IMPORTANT: Set the search_path to match your Prisma DATABASE_URL schema.
-- Your pgAdmin schemas: buzzma_dev, buzzma_production, buzzma_test.
-- Change the line below to target the correct environment.
SET search_path TO buzzma_production;

UPDATE campaigns c
SET used_slots = COALESCE(sub.cnt, 0)
FROM (
  SELECT oi.campaign_id, COUNT(DISTINCT o.id) AS cnt
  FROM orders o
  JOIN order_items oi ON oi.order_id = o.id
  WHERE o.is_deleted  = false
    AND oi.is_deleted = false
    AND o.workflow_status NOT IN ('CREATED', 'REDIRECTED', 'REJECTED', 'FAILED')
  GROUP BY oi.campaign_id
) sub
WHERE c.id = sub.campaign_id
  AND c.used_slots <> sub.cnt;

-- Also zero-out campaigns that have NO qualifying orders but a positive used_slots
-- (e.g. all orders were cancelled but used_slots was never fully decremented).
UPDATE campaigns c
SET used_slots = 0
WHERE c.used_slots > 0
  AND c.is_deleted = false
  AND NOT EXISTS (
    SELECT 1
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE oi.campaign_id = c.id
      AND o.is_deleted  = false
      AND oi.is_deleted = false
      AND o.workflow_status NOT IN ('CREATED', 'REDIRECTED', 'REJECTED', 'FAILED')
  );

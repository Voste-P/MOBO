-- Sync schema drift: columns added via `db push` but missing from migrations.
-- These 3 nullable columns exist in schema.prisma but were never captured in a
-- migration file.  On a fresh CI database they do not exist, causing Prisma
-- runtime failures.

-- 1. pending_connections.deleted_at
ALTER TABLE "pending_connections" ADD COLUMN IF NOT EXISTS "deleted_at" TIMESTAMP(3);

-- 2. order_items.deleted_at
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "deleted_at" TIMESTAMP(3);

-- 3. push_subscriptions.deleted_at
ALTER TABLE "push_subscriptions" ADD COLUMN IF NOT EXISTS "deleted_at" TIMESTAMP(3);

-- Missing indexes (declared in schema.prisma, never created by any migration)
CREATE INDEX IF NOT EXISTS "brands_deleted_at_status_idx" ON "brands"("deleted_at", "status");
CREATE INDEX IF NOT EXISTS "agencies_deleted_at_status_idx" ON "agencies"("deleted_at", "status");
CREATE INDEX IF NOT EXISTS "campaigns_brand_user_id_idx" ON "campaigns"("brand_user_id");
CREATE INDEX IF NOT EXISTS "campaigns_allowed_agency_codes_idx" ON "campaigns" USING GIN ("allowed_agency_codes");
CREATE INDEX IF NOT EXISTS "campaigns_assignments_idx" ON "campaigns" USING GIN ("assignments");
CREATE INDEX IF NOT EXISTS "deals_deleted_at_active_idx" ON "deals"("deleted_at", "active");
CREATE INDEX IF NOT EXISTS "orders_buyer_mobile_deleted_at_idx" ON "orders"("buyer_mobile", "deleted_at");
CREATE INDEX IF NOT EXISTS "mediator_profiles_parent_agency_code_idx" ON "mediator_profiles"("parent_agency_code");
CREATE INDEX IF NOT EXISTS "payouts_deleted_at_requested_at_idx" ON "payouts"("deleted_at", "requested_at" DESC);

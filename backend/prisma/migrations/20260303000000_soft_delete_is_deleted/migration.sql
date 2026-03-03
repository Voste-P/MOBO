-- Migration: Replace deletedAt/deletedBy with isDeleted Boolean flag
-- Audit trail uses updatedAt/updatedBy (already existing columns)
-- @approved-destructive: Intentional column removal — old deleted_at/deleted_by columns
-- replaced by is_deleted Boolean. All code already migrated to use isDeleted.

-- Step 1: Add is_deleted column to all tables
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "is_deleted" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "pending_connections" ADD COLUMN IF NOT EXISTS "is_deleted" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "brands" ADD COLUMN IF NOT EXISTS "is_deleted" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "agencies" ADD COLUMN IF NOT EXISTS "is_deleted" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "mediator_profiles" ADD COLUMN IF NOT EXISTS "is_deleted" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "shopper_profiles" ADD COLUMN IF NOT EXISTS "is_deleted" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "is_deleted" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "is_deleted" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "is_deleted" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "is_deleted" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "wallets" ADD COLUMN IF NOT EXISTS "is_deleted" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "is_deleted" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "payouts" ADD COLUMN IF NOT EXISTS "is_deleted" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "is_deleted" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "push_subscriptions" ADD COLUMN IF NOT EXISTS "is_deleted" BOOLEAN NOT NULL DEFAULT false;

-- Step 2: Backfill is_deleted from deleted_at
UPDATE "users" SET "is_deleted" = true WHERE "deleted_at" IS NOT NULL;
UPDATE "pending_connections" SET "is_deleted" = true WHERE "deleted_at" IS NOT NULL;
UPDATE "brands" SET "is_deleted" = true WHERE "deleted_at" IS NOT NULL;
UPDATE "agencies" SET "is_deleted" = true WHERE "deleted_at" IS NOT NULL;
UPDATE "mediator_profiles" SET "is_deleted" = true WHERE "deleted_at" IS NOT NULL;
UPDATE "shopper_profiles" SET "is_deleted" = true WHERE "deleted_at" IS NOT NULL;
UPDATE "campaigns" SET "is_deleted" = true WHERE "deleted_at" IS NOT NULL;
UPDATE "deals" SET "is_deleted" = true WHERE "deleted_at" IS NOT NULL;
UPDATE "orders" SET "is_deleted" = true WHERE "deleted_at" IS NOT NULL;
UPDATE "order_items" SET "is_deleted" = true WHERE "deleted_at" IS NOT NULL;
UPDATE "wallets" SET "is_deleted" = true WHERE "deleted_at" IS NOT NULL;
UPDATE "transactions" SET "is_deleted" = true WHERE "deleted_at" IS NOT NULL;
UPDATE "payouts" SET "is_deleted" = true WHERE "deleted_at" IS NOT NULL;
UPDATE "tickets" SET "is_deleted" = true WHERE "deleted_at" IS NOT NULL;
UPDATE "push_subscriptions" SET "is_deleted" = true WHERE "deleted_at" IS NOT NULL;

-- Step 3: Drop old columns
ALTER TABLE "users" DROP COLUMN IF EXISTS "deleted_at", DROP COLUMN IF EXISTS "deleted_by";
ALTER TABLE "pending_connections" DROP COLUMN IF EXISTS "deleted_at";
ALTER TABLE "brands" DROP COLUMN IF EXISTS "deleted_at", DROP COLUMN IF EXISTS "deleted_by";
ALTER TABLE "agencies" DROP COLUMN IF EXISTS "deleted_at", DROP COLUMN IF EXISTS "deleted_by";
ALTER TABLE "mediator_profiles" DROP COLUMN IF EXISTS "deleted_at", DROP COLUMN IF EXISTS "deleted_by";
ALTER TABLE "shopper_profiles" DROP COLUMN IF EXISTS "deleted_at", DROP COLUMN IF EXISTS "deleted_by";
ALTER TABLE "campaigns" DROP COLUMN IF EXISTS "deleted_at", DROP COLUMN IF EXISTS "deleted_by";
ALTER TABLE "deals" DROP COLUMN IF EXISTS "deleted_at", DROP COLUMN IF EXISTS "deleted_by";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "deleted_at", DROP COLUMN IF EXISTS "deleted_by";
ALTER TABLE "order_items" DROP COLUMN IF EXISTS "deleted_at";
ALTER TABLE "wallets" DROP COLUMN IF EXISTS "deleted_at", DROP COLUMN IF EXISTS "deleted_by";
ALTER TABLE "transactions" DROP COLUMN IF EXISTS "deleted_at", DROP COLUMN IF EXISTS "deleted_by";
ALTER TABLE "payouts" DROP COLUMN IF EXISTS "deleted_at", DROP COLUMN IF EXISTS "deleted_by";
ALTER TABLE "tickets" DROP COLUMN IF EXISTS "deleted_at", DROP COLUMN IF EXISTS "deleted_by";
ALTER TABLE "push_subscriptions" DROP COLUMN IF EXISTS "deleted_at";

-- Step 4: Create new indexes using is_deleted
CREATE INDEX IF NOT EXISTS "users_mobile_is_deleted_idx" ON "users"("mobile", "is_deleted");
CREATE INDEX IF NOT EXISTS "users_username_is_deleted_idx" ON "users"("username", "is_deleted");
CREATE INDEX IF NOT EXISTS "users_is_deleted_created_at_idx" ON "users"("is_deleted", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "brands_is_deleted_status_idx" ON "brands"("is_deleted", "status");
CREATE INDEX IF NOT EXISTS "agencies_is_deleted_status_idx" ON "agencies"("is_deleted", "status");
CREATE INDEX IF NOT EXISTS "campaigns_is_deleted_created_at_idx" ON "campaigns"("is_deleted", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "deals_mediator_is_deleted_active_idx" ON "deals"("mediator_code", "is_deleted", "active");
CREATE INDEX IF NOT EXISTS "deals_is_deleted_active_idx" ON "deals"("is_deleted", "active");
CREATE INDEX IF NOT EXISTS "orders_is_deleted_created_at_idx" ON "orders"("is_deleted", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "orders_is_deleted_affiliate_status_idx" ON "orders"("is_deleted", "affiliate_status", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "orders_user_workflow_is_deleted_idx" ON "orders"("user_id", "workflow_status", "is_deleted");
CREATE INDEX IF NOT EXISTS "orders_brand_workflow_is_deleted_idx" ON "orders"("brand_user_id", "workflow_status", "is_deleted");
CREATE INDEX IF NOT EXISTS "orders_manager_is_deleted_idx" ON "orders"("manager_name", "is_deleted", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "orders_buyer_mobile_is_deleted_idx" ON "orders"("buyer_mobile", "is_deleted");
CREATE INDEX IF NOT EXISTS "transactions_is_deleted_created_at_idx" ON "transactions"("is_deleted", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "payouts_is_deleted_requested_at_idx" ON "payouts"("is_deleted", "requested_at" DESC);
CREATE INDEX IF NOT EXISTS "tickets_user_is_deleted_idx" ON "tickets"("user_id", "is_deleted", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "tickets_is_deleted_created_at_idx" ON "tickets"("is_deleted", "created_at" DESC);

-- Step 5: Drop old indexes (best effort)
DROP INDEX IF EXISTS "users_mobile_deleted_at_idx";
DROP INDEX IF EXISTS "users_username_deleted_at_idx";
DROP INDEX IF EXISTS "users_deleted_at_created_at_idx";
DROP INDEX IF EXISTS "brands_deleted_at_status_idx";
DROP INDEX IF EXISTS "agencies_deleted_at_status_idx";
DROP INDEX IF EXISTS "campaigns_deleted_at_created_at_idx";
DROP INDEX IF EXISTS "deals_mediator_code_deleted_at_active_idx";
DROP INDEX IF EXISTS "deals_deleted_at_active_idx";
DROP INDEX IF EXISTS "orders_deleted_at_created_at_idx";
DROP INDEX IF EXISTS "orders_deleted_at_affiliate_status_created_at_idx";
DROP INDEX IF EXISTS "orders_user_id_workflow_status_deleted_at_idx";
DROP INDEX IF EXISTS "orders_brand_user_id_workflow_status_deleted_at_idx";
DROP INDEX IF EXISTS "orders_manager_name_deleted_at_created_at_idx";
DROP INDEX IF EXISTS "orders_buyer_mobile_deleted_at_idx";
DROP INDEX IF EXISTS "transactions_deleted_at_created_at_idx";
DROP INDEX IF EXISTS "payouts_deleted_at_requested_at_idx";
DROP INDEX IF EXISTS "tickets_user_id_deleted_at_created_at_idx";
DROP INDEX IF EXISTS "tickets_deleted_at_created_at_idx";

-- Step 6: Add ticket cascade routing fields
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "target_role" TEXT;
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "priority" TEXT NOT NULL DEFAULT 'medium';
CREATE INDEX IF NOT EXISTS "tickets_target_role_is_deleted_idx" ON "tickets"("target_role", "is_deleted", "created_at" DESC);

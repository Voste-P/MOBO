-- Remove all mongo_id columns and related indexes from every table.
-- Also drop the migration_sync table that tracked Mongo→PG migration state.

-- Drop unique indexes on mongo_id first
DROP INDEX IF EXISTS "users_mongo_id_key";
DROP INDEX IF EXISTS "brands_mongo_id_key";
DROP INDEX IF EXISTS "agencies_mongo_id_key";
DROP INDEX IF EXISTS "mediator_profiles_mongo_id_key";
DROP INDEX IF EXISTS "shopper_profiles_mongo_id_key";
DROP INDEX IF EXISTS "campaigns_mongo_id_key";
DROP INDEX IF EXISTS "deals_mongo_id_key";
DROP INDEX IF EXISTS "orders_mongo_id_key";
DROP INDEX IF EXISTS "wallets_mongo_id_key";
DROP INDEX IF EXISTS "transactions_mongo_id_key";
DROP INDEX IF EXISTS "payouts_mongo_id_key";
DROP INDEX IF EXISTS "invites_mongo_id_key";
DROP INDEX IF EXISTS "tickets_mongo_id_key";
DROP INDEX IF EXISTS "push_subscriptions_mongo_id_key";
DROP INDEX IF EXISTS "suspensions_mongo_id_key";
DROP INDEX IF EXISTS "audit_logs_mongo_id_key";
DROP INDEX IF EXISTS "system_configs_mongo_id_key";

-- Drop mongo_id columns from all tables
ALTER TABLE "users" DROP COLUMN IF EXISTS "mongo_id";
ALTER TABLE "brands" DROP COLUMN IF EXISTS "mongo_id";
ALTER TABLE "agencies" DROP COLUMN IF EXISTS "mongo_id";
ALTER TABLE "mediator_profiles" DROP COLUMN IF EXISTS "mongo_id";
ALTER TABLE "shopper_profiles" DROP COLUMN IF EXISTS "mongo_id";
ALTER TABLE "campaigns" DROP COLUMN IF EXISTS "mongo_id";
ALTER TABLE "deals" DROP COLUMN IF EXISTS "mongo_id";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "mongo_id";
ALTER TABLE "wallets" DROP COLUMN IF EXISTS "mongo_id";
ALTER TABLE "transactions" DROP COLUMN IF EXISTS "mongo_id";
ALTER TABLE "payouts" DROP COLUMN IF EXISTS "mongo_id";
ALTER TABLE "invites" DROP COLUMN IF EXISTS "mongo_id";
ALTER TABLE "tickets" DROP COLUMN IF EXISTS "mongo_id";
ALTER TABLE "push_subscriptions" DROP COLUMN IF EXISTS "mongo_id";
ALTER TABLE "suspensions" DROP COLUMN IF EXISTS "mongo_id";
ALTER TABLE "audit_logs" DROP COLUMN IF EXISTS "mongo_id";
ALTER TABLE "system_configs" DROP COLUMN IF EXISTS "mongo_id";

-- Drop the migration_sync table entirely
DROP TABLE IF EXISTS "migration_sync";

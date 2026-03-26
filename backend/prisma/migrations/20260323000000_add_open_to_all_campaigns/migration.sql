-- Add open_to_all column to campaigns table
ALTER TABLE "campaigns" ADD COLUMN "open_to_all" BOOLEAN NOT NULL DEFAULT false;

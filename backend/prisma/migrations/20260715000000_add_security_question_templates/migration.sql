-- CreateTable
CREATE TABLE "security_question_templates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "question_id" INTEGER NOT NULL,
    "label" VARCHAR(300) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "security_question_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "security_question_templates_question_id_key" ON "security_question_templates"("question_id");

-- CreateIndex
CREATE INDEX "security_question_templates_is_active_sort_order_idx" ON "security_question_templates"("is_active", "sort_order");

-- Seed the 7 original hardcoded questions so existing questionId references remain valid
INSERT INTO "security_question_templates" ("id", "question_id", "label", "is_active", "sort_order", "created_at", "updated_at") VALUES
  (gen_random_uuid(), 1, 'What was your childhood nickname?', true, 1, NOW(), NOW()),
  (gen_random_uuid(), 2, 'What is the name of your first school?', true, 2, NOW(), NOW()),
  (gen_random_uuid(), 3, 'What was the name of your first best friend?', true, 3, NOW(), NOW()),
  (gen_random_uuid(), 4, 'What is your favorite childhood food?', true, 4, NOW(), NOW()),
  (gen_random_uuid(), 5, 'What was your first mobile phone model?', true, 5, NOW(), NOW()),
  (gen_random_uuid(), 6, 'What is your favorite childhood game?', true, 6, NOW(), NOW()),
  (gen_random_uuid(), 7, 'What was the name of your first teacher?', true, 7, NOW(), NOW());

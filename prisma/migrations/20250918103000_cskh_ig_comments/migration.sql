-- CreateTable
CREATE TABLE "cskh_ig_media" (
    "id" UUID NOT NULL,
    "page_id" TEXT NOT NULL,
    "ig_media_id" VARCHAR(64) NOT NULL,
    "media_type" VARCHAR(32),
    "caption" TEXT,
    "permalink" VARCHAR(512),
    "thumbnail_url" VARCHAR(512),
    "last_comment_at" TIMESTAMPTZ(6),
    "tenant_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "cskh_ig_media_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "cskh_ig_comments" (
    "id" UUID NOT NULL,
    "page_id" TEXT NOT NULL,
    "ig_media_id" VARCHAR(64) NOT NULL,
    "ig_comment_id" VARCHAR(64) NOT NULL,
    "parent_ig_comment_id" VARCHAR(64),
    "text" TEXT NOT NULL,
    "author_username" VARCHAR(255),
    "author_ig_id" VARCHAR(64),
    "direction" VARCHAR(16) NOT NULL DEFAULT 'inbound',
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "commented_at" TIMESTAMPTZ(6) NOT NULL,
    "tenant_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "cskh_ig_comments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "cskh_ig_media_page_id_ig_media_id_key" ON "cskh_ig_media"("page_id", "ig_media_id");
CREATE INDEX "cskh_ig_media_tenant_id_last_comment_at_idx" ON "cskh_ig_media"("tenant_id", "last_comment_at" DESC);
CREATE INDEX "cskh_ig_media_page_id_last_comment_at_idx" ON "cskh_ig_media"("page_id", "last_comment_at" DESC);

CREATE UNIQUE INDEX "cskh_ig_comments_ig_comment_id_key" ON "cskh_ig_comments"("ig_comment_id");
CREATE INDEX "cskh_ig_comments_page_id_ig_media_id_commented_at_idx" ON "cskh_ig_comments"("page_id", "ig_media_id", "commented_at" DESC);
CREATE INDEX "cskh_ig_comments_tenant_id_commented_at_idx" ON "cskh_ig_comments"("tenant_id", "commented_at" DESC);

ALTER TABLE "cskh_ig_media" ADD CONSTRAINT "cskh_ig_media_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "cskh_ig_comments" ADD CONSTRAINT "cskh_ig_comments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "cskh_ig_comments" ADD CONSTRAINT "cskh_ig_comments_page_id_ig_media_id_fkey" FOREIGN KEY ("page_id", "ig_media_id") REFERENCES "cskh_ig_media"("page_id", "ig_media_id") ON DELETE CASCADE ON UPDATE CASCADE;
-- CreateTable
CREATE TABLE "cskh_fb_posts" (
    "id" UUID NOT NULL,
    "page_id" TEXT NOT NULL,
    "fb_post_id" VARCHAR(64) NOT NULL,
    "message" TEXT,
    "permalink" TEXT,
    "thumbnail_url" TEXT,
    "last_comment_at" TIMESTAMPTZ(6),
    "tenant_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "cskh_fb_posts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "cskh_fb_comments" (
    "id" UUID NOT NULL,
    "page_id" TEXT NOT NULL,
    "fb_post_id" VARCHAR(64) NOT NULL,
    "fb_comment_id" VARCHAR(64) NOT NULL,
    "parent_fb_comment_id" VARCHAR(64),
    "text" TEXT NOT NULL,
    "author_name" VARCHAR(255),
    "author_fb_id" VARCHAR(64),
    "direction" VARCHAR(16) NOT NULL DEFAULT 'inbound',
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "commented_at" TIMESTAMPTZ(6) NOT NULL,
    "tenant_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "cskh_fb_comments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "cskh_fb_posts_page_id_fb_post_id_key" ON "cskh_fb_posts"("page_id", "fb_post_id");
CREATE INDEX "cskh_fb_posts_tenant_id_last_comment_at_idx" ON "cskh_fb_posts"("tenant_id", "last_comment_at" DESC);
CREATE INDEX "cskh_fb_posts_page_id_last_comment_at_idx" ON "cskh_fb_posts"("page_id", "last_comment_at" DESC);

CREATE UNIQUE INDEX "cskh_fb_comments_fb_comment_id_key" ON "cskh_fb_comments"("fb_comment_id");
CREATE INDEX "cskh_fb_comments_page_id_fb_post_id_commented_at_idx" ON "cskh_fb_comments"("page_id", "fb_post_id", "commented_at" DESC);
CREATE INDEX "cskh_fb_comments_tenant_id_commented_at_idx" ON "cskh_fb_comments"("tenant_id", "commented_at" DESC);

ALTER TABLE "cskh_fb_posts" ADD CONSTRAINT "cskh_fb_posts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "cskh_fb_comments" ADD CONSTRAINT "cskh_fb_comments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "cskh_fb_comments" ADD CONSTRAINT "cskh_fb_comments_page_id_fb_post_id_fkey" FOREIGN KEY ("page_id", "fb_post_id") REFERENCES "cskh_fb_posts"("page_id", "fb_post_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Remap UserRole → admin / manager / staff / user (CQA)

CREATE TYPE "UserRole_new" AS ENUM ('admin', 'manager', 'staff', 'user');

ALTER TABLE "users" ADD COLUMN "roles_new" "UserRole_new"[] NOT NULL DEFAULT ARRAY[]::"UserRole_new"[];

UPDATE "users" u
SET "roles_new" = COALESCE(mapped.roles, ARRAY[]::"UserRole_new"[])
FROM (
  SELECT
    u2.id,
    ARRAY_AGG(
      CASE x::text
        WHEN 'admin' THEN 'admin'::"UserRole_new"
        WHEN 'store_manager' THEN 'manager'::"UserRole_new"
        WHEN 'manager' THEN 'manager'::"UserRole_new"
        WHEN 'sales' THEN 'staff'::"UserRole_new"
        WHEN 'staff' THEN 'staff'::"UserRole_new"
        WHEN 'warehouse_staff' THEN 'staff'::"UserRole_new"
        WHEN 'purchasing' THEN 'staff'::"UserRole_new"
        WHEN 'user' THEN 'user'::"UserRole_new"
        ELSE 'user'::"UserRole_new"
      END
      ORDER BY ordinality
    ) AS roles
  FROM "users" u2
  LEFT JOIN LATERAL unnest(u2."roles") WITH ORDINALITY AS t(x, ordinality) ON true
  GROUP BY u2.id
) mapped
WHERE u.id = mapped.id;

ALTER TABLE "users" DROP COLUMN "roles";
ALTER TABLE "users" RENAME COLUMN "roles_new" TO "roles";

DROP TYPE "UserRole";
ALTER TYPE "UserRole_new" RENAME TO "UserRole";

ALTER TABLE "users" ALTER COLUMN "roles" SET DEFAULT ARRAY[]::"UserRole"[];

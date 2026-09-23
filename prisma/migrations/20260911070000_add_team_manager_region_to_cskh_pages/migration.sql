-- Gắn nhãn quản lý cho kênh CSKH (facebook_cskh_configs): team, người quản lý, khu vực.
-- Nhập tay ở Cài đặt → tab Kênh, không ràng buộc FK tới bảng User/Team nào.
ALTER TABLE "facebook_cskh_configs"
  ADD COLUMN "team" VARCHAR(120),
  ADD COLUMN "manager_name" VARCHAR(120),
  ADD COLUMN "region" VARCHAR(120);

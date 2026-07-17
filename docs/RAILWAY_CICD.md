# CI/CD Deploy CQA_BE (Docker Hub → Railway)

Railway đang chạy image **`viejhaf/cqa-be:latest`** (không build từ GitHub).

```text
push main
  → GitHub Actions: docker build (linux/amd64) → push Docker Hub
  → railway redeploy API + Worker  (kéo lại :latest)
```

## GitHub Secrets (bắt buộc)

| Secret | Giá trị |
|--------|---------|
| `RAILWAY_TOKEN` | Project Token (Railway → Project → Settings → Tokens) |
| `RAILWAY_SERVICE_API` | Service ID của cqa-be |
| `RAILWAY_SERVICE_WORKER` | Service ID của worker |
| `DOCKERHUB_USERNAME` | Username Docker Hub (vd `viejhaf`) |
| `DOCKERHUB_TOKEN` | Access Token Docker Hub (Account Settings → Security) |

## Workflows

| File | Khi chạy |
|------|----------|
| `ci.yml` | PR / push — npm build |
| `deploy-railway.yml` | Push `main` hoặc **Actions → Deploy Railway → Run workflow** |

### Test thủ công
1. Actions → **Deploy Railway** → **Run workflow**
2. `service` = `both`
3. `skip_docker_push` = `false` (full) hoặc `true` (chỉ redeploy Railway)

## Railway (không cần connect nhánh GitHub)

- Source Image: `viejhaf/cqa-be:latest`
- API: `CSKH_RUN_MODE=api`, Start Command mặc định / `node dist/main.js`
- Worker: `CSKH_RUN_MODE=worker`, Start Command `node dist/worker.js`
- Healthcheck API (khuyến nghị): `/api/v1/health`

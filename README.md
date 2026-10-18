# GKRsysterm
This is a systerm driven by AI for Gaokao preference submission.

## 前端：夜航 Night Voyage

前端工程位于 [`src/frontend`](src/frontend)，使用 React、TypeScript 和 Vite，包含院校星图、院校专属回声页、推荐与志愿工作台、账号及审核演示。

在仓库根目录执行（需要 Node.js 22.18+ 和 pnpm）：

```sh
cd src/frontend
pnpm install --frozen-lockfile
pnpm run dev
```

默认使用本地演示数据，访问 http://127.0.0.1:5173 。运行 `pnpm run contract:check`、`pnpm run test` 与 `pnpm run build` 完成测试和构建；构建后运行 `pnpm run standalone` 生成可直接打开的单文件演示，生成文件不进入 Git。

- [前端启动、页面与后端配置](src/frontend/README.md)
- [接口对接规范](docs/contracts/API.md) 与 [OpenAPI 契约](docs/contracts/openapi.json)
- [架构和已实现范围](src/frontend/docs/FRONTEND.md)、[验证记录](src/frontend/docs/VALIDATION.md)
- [系统技术方案](docs/技术方案.md)
- [开发者日志](docs/开发日志.md)：逐次提交的改动、作者、验证和合并记录。
- [提交与协作约定](CONTRIBUTING.md)：每次提交同步追加日志，保留其他开发者的历史。
- [统一测试入口与覆盖范围](test/README.md)：仓库根目录运行 `.\test\run.ps1`，用例集中在 `test/`，自动生成本地报告。

## 后端：M0–M1

真实后端位于 [`src/backend`](src/backend)，使用 FastAPI、SQLAlchemy、Alembic 和 PostgreSQL 17。已整合同事 v0.4 前端，提供注册审批、统一登录与权限隔离、画像版本、官方资料导入、异步规则推荐、反馈及志愿草案。50 项共享接口的实际支持范围见后端说明，后续阶段功能返回明确的未开放状态。

没有本机 PostgreSQL 可使用随项目提供的 Docker Compose，数据库仅绑定 `127.0.0.1:55432`，与其他容器分开保存。按[后端启动与测试说明](src/backend/README.md)初始化数据库和管理员，并分别启动 API、Worker；前端设置 `VITE_API_MODE=http` 后启动。默认前端仍是演示模式。

- [后端实际接口、数据字典和前端差异](docs/contracts/BACKEND.md)
- [生成的完整后端 OpenAPI](docs/contracts/backend-openapi.json)

真实 PostgreSQL、并发事务、当前 v0.4 前端访问层及浏览器登录权限已联调；测试使用合成资料。注册申请、审批、画像和推荐工作流已有页面。未预装真实招生数据；模型、向量检索、学校认证审核、长期记忆和案例共享等 M2–M4 功能未完成，不能用演示模式的效果作为真实后端能力。

## Docker 一键部署

如果需要一次启动前端、FastAPI、PostgreSQL 和后台 Worker，可在仓库根目录执行：

```sh
python deploy/manage.py up
```

脚本会首次生成 `deploy/.env` 中的本地密钥，构建镜像，等待 PostgreSQL 健康检查并执行 Alembic 迁移。默认访问地址为 http://localhost:8080；本地配置使用 HTTP 和非 Secure Cookie，适合开发验证。创建首个管理员：

```sh
docker compose --env-file deploy/.env -f deploy/compose.prod.yaml exec api \
  python -m app.cli create-admin --nickname 管理员 --email you@example.com
```

常用运维命令：

```sh
python deploy/manage.py status
python deploy/manage.py logs
python deploy/manage.py backup
python deploy/manage.py down
```

生产部署必须使用 HTTPS 反向代理，并在 `deploy/.env` 中设置 `APP_ENV=production`、`COOKIE_SECURE=true` 和准确的 HTTPS `ALLOWED_ORIGINS`。不要提交 `deploy/.env`、数据库数据、上传文件或 `backups/`。完整的部署、备份和恢复说明见 [`deploy/README.md`](deploy/README.md)。

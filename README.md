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

真实 PostgreSQL、并发事务、当前 v0.4 前端访问层及浏览器登录权限已有联调测试，测试使用合成资料。领航员内填写省份、报考年份、位次、三门选科并同意使用画像后，即可直接查看规则推荐；分数、意向省份/城市、院校、专业与预算均可稍后补充。用户确认新信息后生成新画像版本，并在领航员里更新推荐，原任务与快照保留。普通问答接入 OpenAI 兼容模型（DeepSeek），检索已发布招生计划并流式回答；没有招生计划时回退到全国院校名录，只按地区/层次列学校，不判断分数或专业。模型回答与经过校验的推荐结果分别展示。生源省份与想去的省份分开处理，聊天不会静默改写画像。详细流程、字段映射及部署抓取条件见[领航员对接说明](docs/contracts/NAVIGATOR.md)。工具型 Agent、向量检索、学校认证审核、长期记忆和案例共享等 M2–M4 功能仍未完成。

## 招生数据自动抓取

招生来源集中在 [`config/admission_sources.json`](config/admission_sources.json)，但当前默认关闭省级招生计划抓取（`discovery.enabled=false`、`auto_start=false`）。项目只自动同步全国院校基础资料，管理页默认只显示全国名录；浙江招生计划抓取仅在显式启用该配置后由管理员触发，结果仍需审核。

模型使用 OpenAI 兼容接口，密钥只放在 `deploy/.env`/`src/backend/.env`：

```sh
MODEL_BASE_URL=https://your-provider.example/v1
MODEL_API_KEY=...
MODEL_NAME=...
```

抓取/模型抽取结果先进入 `crawl_runs` 暂存区，保存原始快照、证据和模型版本；管理员必须在管理页或审核 API 批准后才会生成 `ImportBatch` 并由 Worker 发布。支持 HTML、PDF 和 XLS/XLSX 附件；真实站点常把 XLS 标成 `text/html`，后端按文件魔数识别，数千行的表格按表头确定性映射，模型负责选择链接而不是逐行猜测。未配置模型、源站不可达、robots 拒绝或字段不完整时自动抓取会失败/跳过，手工 JSON/CSV 导入仍然可用。当前只覆盖浙江 2026 普通类，不能把模型结果当作已核验的官方数据。

自动启动还要求没有已发布的招生单位，且相同配置指纹没有已有抓取记录。部署脚本先等待 PostgreSQL、完成数据库迁移，再启动抓取 Worker，避免首次部署时访问尚未创建的数据表。

## Docker 一键部署

全国院校基础资料已加入自动同步：部署完成迁移后，后台抓取教育部普通及成人高校完整名单，AI分析后进入管理员待审区。管理员在 `/#/admin/admissions` 的“院校资料管理”选择重新抓取、分析、查看差异并决定更新或拒绝；未经确认不改正式资料。[全国名录说明与接口](docs/contracts/CATALOG.md)包含完整性检查、官方来源和验证方法。分省招生计划和推荐规则仍按当前浙江范围执行。

在一台新机器上，启动 Docker Desktop 后只需执行：

```sh
python deploy/manage.py init
```

它会生成 `deploy/.env` 本地密钥，提示输入 DeepSeek 兼容接口地址、模型名、API key，以及首个管理员的昵称、邮箱和隐藏密码；随后构建镜像、启动前端/FastAPI/PostgreSQL/Worker、执行数据库迁移并创建管理员。模型参数会同步写入已存在的 `src/backend/.env`。默认访问地址为 http://localhost:8080。首次初始化后，日常启动使用 `python deploy/manage.py start`；代码变更后用 `python deploy/manage.py up` 重建并迁移。

常用运维命令：

```sh
python deploy/manage.py status
python deploy/manage.py logs
python deploy/manage.py backup
python deploy/manage.py down
```

生产部署必须使用 HTTPS 反向代理，并在 `deploy/.env` 中设置 `APP_ENV=production`、`COOKIE_SECURE=true` 和准确的 HTTPS `ALLOWED_ORIGINS`。不要提交 `deploy/.env`、数据库数据、上传文件或 `backups/`。完整的部署、备份和恢复说明见 [`deploy/README.md`](deploy/README.md)。

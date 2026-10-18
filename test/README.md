# 本地测试与持续集成

本目录集中保存可执行测试、真实前后端联调脚本及统一入口。原 `src/backend/tests`、`src/frontend/tests` 的用例迁移至此，保留历史；应用代码仍位于 `src/backend`、`src/frontend`。本目录不声称覆盖完整生产验收。

## 运行前准备

需要 Python 3.12、Node.js 22.18+（已验证24）、pnpm 11.25.0。按[后端启动说明](../src/backend/README.md)安装 `requirements.lock` 至 `src/backend/.venv`，并在 `src/frontend` 执行 `pnpm install --frozen-lockfile`。后端测试还需要 PATH 中的 ffmpeg/ffprobe、运行中的 PostgreSQL 和已存在的独立测试库。

本机没有 PostgreSQL 时，使用后端随附的 Docker Compose。以下命令从仓库根目录运行；先完成后端 `.env` 初始化，已存在的数据库不用重复创建：

```powershell
docker compose --project-directory src/backend up -d --wait
docker compose --project-directory src/backend exec -T postgres createdb -U night_voyage night_voyage_test
```

测试默认读取后端本地连接配置，把数据库名切换为 `night_voyage_test`；也可通过环境变量 `TEST_DATABASE_URL` 指定专用 PostgreSQL 库，名称必须以 `_test` 结尾。**迁移往返会删除并重建测试库中的项目表，测试会反复清空这些表。请勿把业务数据放入该库，也不要与其他开发者共享同一测试库。** 默认开发库不会被修改。

脚本不安装依赖、不启动 Docker、不创建数据库，也不启动正式业务服务；真实联调使用用例自行启动并结束的回环临时 API/Worker。账号、录音和招生资料均为合成测试材料，不向官方资料网站发起请求。

## 一键运行

Windows PowerShell，在仓库根目录执行：

```powershell
.\test\run.ps1
```

也可仅运行一组：

```powershell
.\test\run.ps1 -Suite frontend
.\test\run.ps1 -Suite backend
```

Python 跨平台入口（可从任意目录用脚本绝对路径调用）：

```sh
python test/run.py --suite all
python test/run.py --suite backend --python python
```

默认优先使用仓库内后端虚拟环境；`--python` 或 PowerShell 的 `-Python` 可以指定已装锁定依赖的解释器。后台测试套件始终启用真实前端联调，因此即使 `--suite backend` 也需要 Node 和前端依赖。脚本按顺序执行，第一步失败即停止，返回非零退出码；尚未执行的步骤不会被算作通过。前端套件包括契约、用例、TypeScript与生产构建；后端套件包括代码规范、格式、迁移往返、契约和全部pytest用例。

## 目录与报告

| 路径 | 内容 |
|---|---|
| `backend/` | PostgreSQL领域回归、v0.4接口、审批/推荐并发、权限与会话验收 |
| `backend/fixtures/` | 固定的旧版契约回归夹具，不用于生产协议 |
| `frontend/` | Node/TypeScript领域、Mock、HTTP夹具、契约与SSE测试 |
| `integration/backend-smoke.mjs` | 当前真实前端访问层→临时API→Worker→PostgreSQL闭环，由后端用例调用 |
| `run.py`、`run.ps1` | 统一执行和报告入口 |
| `COVERAGE.md` | 需求、用例位置和未覆盖范围 |
| `LOCAL-RESULTS.md` | 本轮实际运行结果摘要 |
| `reports/<北京时间-随机ID>/` | 每次运行的独立日志、summary.json、后端JUnit XML和临时夹具，均不进Git |

`summary.json` 保存已完成步骤、退出码、耗时、开始结束时间（UTC）和总体成功状态。后端JUnit XML记录具体用例结果；日志不主动输出环境变量，但仍应在对外分享前检查。临时数据库、上传文件、环境配置和报告目录不提交到仓库。GitHub Actions使用相同入口，上传JSON/XML/日志报告保留7天，不上传临时私有材料。

同一工作区的后端运行使用 `reports/backend.lock` 防止两个统一脚本并行清空同一库。若程序被强制结束，先确认没有测试/API/Worker仍在执行，再手动移除该锁并重跑；锁不会自动过期。跨工作区或手动调用pytest不受此锁保护，必须自行使用不同测试库。单项调试可在 `src/backend` 执行 `python -m pytest ../../test/backend/test_login_acceptance.py -q`；前端原有 `pnpm run test` 仍有效。

## 验证边界

Node HTTP夹具测试与真实服务联调分开记录。当前没有自动浏览器点击脚本，前一阶段的桌面浏览器人工验收记录不等于本目录可以自动复现的浏览器测试。本轮不包含手机/多浏览器矩阵、性能/弱网、生产备份恢复、真实招生资料核验及M2–M4功能；完整范围见覆盖说明。

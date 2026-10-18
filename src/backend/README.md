# 夜航 M0–M1 后端

Python 3.12、FastAPI、Pydantic、SQLAlchemy 2、psycopg 3、Alembic、PostgreSQL 17。认证使用 Argon2id 和服务端 Cookie 会话；数据库持久任务由独立 Worker 消费。源码按 `app/modules/` 业务模块组织，API 与 Worker 共用规则、版本数据和结果校验。依赖精确版本见 `requirements.lock`。

本阶段覆盖浙江 2026 普通类按专业招生的规则辅助查询，已整合前端 v0.4 的注册审批、画像、异步推荐与反馈工作流。没有预装真实招生数据，不连接模型，不计算录取概率。详细实现、50 项共享接口的支持范围及阶段限制见 [共享后端说明](../../docs/contracts/BACKEND.md)。

## 本机没有 PostgreSQL 时

采用 Docker Desktop 的 Linux 容器。无需安装 Windows PostgreSQL 服务，也不使用 SQLite 替代事务验证。启动 Docker Desktop 后，从本目录执行以下 PowerShell 命令。已有 `.venv` 或 `.env` 时跳过对应创建步骤，设置脚本不会覆盖已有配置。

```powershell
python -m venv .venv
.venv/Scripts/python.exe -m pip install -r requirements.lock
.venv/Scripts/python.exe scripts/setup_local.py
docker compose up -d --wait
.venv/Scripts/python.exe -m alembic upgrade head
.venv/Scripts/python.exe -m app.cli create-admin --nickname 管理员 --email your-address@example.com
```

管理员密码通过终端隐藏输入；不是前端演示密码。创建命令输出系统用户 ID，应妥善记录。正式账号只能由此受控命令创建管理员，或由注册审批产生普通用户；客户端不能提交角色。自动化环境可通过 `NV_ADMIN_PASSWORD` 注入初始化密码，切勿写入代码或提交日志。

容器仅映射 `127.0.0.1:55432`，具备健康检查，数据库保存在项目命名卷中。`.env` 由脚本生成随机数据库密码和 APP_SECRET，已被 Git 忽略。端口冲突时同时修改 POSTGRES_PORT 和 DATABASE_URL。数据库账号和 APP_SECRET 应保持稳定，随意改密会与现有卷不一致，也会影响申请查询凭据。需要停止时运行 `docker compose stop`，恢复运行 `docker compose start`；不要使用删除卷的参数。

在两个终端分别启动 API 与 Worker（都在 `src/backend`）：

```powershell
.venv/Scripts/python.exe -m uvicorn app.main:create_app --factory --host 127.0.0.1 --port 8000
```

```powershell
.venv/Scripts/python.exe -m app.workers.runner
```

`http://127.0.0.1:8000/health` 检查数据库连接及迁移表，`/docs` 为开发接口文档。Worker 不在 API 进程里自动运行；停掉 Worker 后导入和异步推荐仍在数据库排队。`--once` 只消费至多一个任务，适合排查。

## 接上现有前端

第三个终端进入 `src/frontend`：

```powershell
pnpm install --frozen-lockfile
$env:VITE_API_MODE = 'http'
pnpm run dev
```

访问 `http://127.0.0.1:5173/#/login`，使用刚创建的真实账号。Vite 已将 `/api` 代理到本机 8000；无需改登录页。匿名时院校列表为空是正常情况，管理员复核并导入真实官方资料后才出现数据。统一登录页不显示角色，服务端返回权限决定进入个人区或管理区。前端原有演示账号仅在 Mock 模式有效。

改用其他前端端口时同步 `.env` 的 ALLOWED_ORIGINS，并重启 API。浏览器与 API 应使用同一主机名；开发阶段优先通过 Vite 代理。当前前端开发默认 Mock，生产构建默认 HTTP；建议部署时显式设置 `VITE_API_MODE=http`。standalone 始终为演示模式。线上同源反向代理 `/api`、启用 HTTPS 与 `COOKIE_SECURE=true`、`APP_ENV=production`，SSE 关闭代理缓冲。

## 自动验证

测试只允许以 `_test` 结尾的 PostgreSQL 数据库，会清空其中本项目的表。第一次先创建独立库（已存在时不重复执行）：

```powershell
docker compose exec -T postgres createdb -U night_voyage night_voyage_test
.venv/Scripts/python.exe -m scripts.check_migrations
.venv/Scripts/python.exe -m ruff check app tests scripts
.venv/Scripts/python.exe -m ruff format --check app tests scripts
.venv/Scripts/python.exe -m scripts.export_openapi --check
$env:NV_LIVE_FRONTEND = '1'
.venv/Scripts/python.exe -m pytest -q
```

未设置 TEST_DATABASE_URL 时自动沿用本地连接参数、只把库名改为 `night_voyage_test`。共享数据库环境必须显式指定专用测试库，不能对开发数据运行回退或测试。完整测试需要 Node.js、前端锁文件依赖和 PATH 中的 ffmpeg/ffprobe；不设置 NV_LIVE_FRONTEND 时只跳过真实前端适配器测试。该测试启动临时 Uvicorn 和 Worker，调用当前 v0.4 的实际 `src/frontend/src/api.ts`，最后停止临时服务；其账号和招生数据均为合成测试材料。

Windows 若切换执行账户后遇到临时目录权限错误，可用自己拥有的、新建且未使用的目录作为 pytest `--basetemp`，并用 `-p no:cacheprovider` 避免旧缓存权限。pytest 会清理指定临时目录，不能指向已有业务文件。最新整合验证结果见[开发日志](../../docs/开发日志.md)。有一个 Starlette 对 TestClient 的 httpx 弃用提示，不影响当前测试。

Linux/CI 使用 `.venv/bin/python` 或激活后的 `python`；GitHub Actions 已配置 PostgreSQL 服务、迁移、契约、测试及真实适配器联调。

## 数据与维护

- 注册音频支持完整 PCM WAV 和浏览器常见 WebM/OGG/MP3/M4A，最多 120 秒、10 MiB；按文件实际内容检查，保留原始录音，不依赖模型转写。非 WAV 需要 PATH 中的 ffmpeg 和 ffprobe，缺失返回 503；解析限定管道输入、超时和解码长度，不允许外部协议读取。部署前确认两个工具可用，Linux CI 已安装；本机沿用已有安装。
- 学校认证附件接受有效 PNG、JPEG 或未加密、最多 20 页 PDF，最多 10 MiB。当前只支持私有上传待审；M2 认证审核尚未开放，上传不会授予认证权限。
- 文件保存在 `runtime/private`，不设置静态公开路由。终态注册材料保留默认 30 天；运行 `.venv/Scripts/python.exe -m app.cli cleanup` 清除过期材料、过期会话与限流窗口。待审申请不因超时自动释放占用。部署时安排日常清理任务并限制运行目录的操作系统访问权限。
- 备份需同时覆盖 PostgreSQL 和私有文件；本阶段尚未执行生产备份恢复演练。意外断电在文件入库前可留下孤立文件，尚未实现自动孤立文件清理。
- 修改模型后新增 Alembic 迁移；已共享迁移不要改写。运行 `python -m scripts.export_openapi` 更新后端契约，前端兼容契约由前端 `pnpm run contract` 生成。双方契约和测试随同一 PR 提交。
- 锁文件更新使用 Python 3.12 + pip-tools，执行 `pip-compile --output-file=requirements.lock requirements.in` 后重新验证；当前锁文件锁定版本但未包含 wheel 哈希。

仅提交功能分支 PR，按[协作约定](../../CONTRIBUTING.md)随每次提交追加开发日志；不要提交 `.env`、密码、数据库卷、上传材料、测试缓存或打包产物。

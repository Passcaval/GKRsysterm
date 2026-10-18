# 夜航 · Night Voyage

高考志愿查询与推荐系统前端，React 19 + TypeScript + Vite。与 Python / FastAPI / PostgreSQL 服务分离部署。

工程根目录为仓库中的 `src/frontend/`，下方命令均在此目录执行。

**离线预览：安装依赖后运行 `pnpm run standalone`，再双击生成的 `夜航-交互预览.html`。** 页面、素材、样式和脚本打包为单文件，固定使用演示模式；查看生成文件时无需启动服务，离线预览使用系统字体。该文件属于可复现的构建产物，不提交到仓库。

## 启动

需要 Node.js 22.18+（当前验证为 24）、pnpm 11.25.0（与 packageManager 一致）。在本目录运行：

```powershell
pnpm install --frozen-lockfile
pnpm run dev
```

打开 http://127.0.0.1:5173 。默认 `mock` 演示模式，完全不需要后端。首次安装后的版本以 `pnpm-lock.yaml` 为准。

```powershell
pnpm run contract:check
pnpm run test
pnpm run build
pnpm run preview
pnpm run standalone
```

若本机 pnpm 的启动包装器有问题，可直接执行等价命令：

```powershell
node --experimental-strip-types --test tests/*.test.ts
node node_modules/typescript/bin/tsc -b
node node_modules/vite/bin/vite.js build
node node_modules/vite/bin/vite.js --host 127.0.0.1
```

## 切换真实后端

将 `.env.example` 复制为 `.env.local`，设置后重启开发服务：

```dotenv
VITE_API_MODE=http
VITE_API_BASE_URL=/api/v1
```

开发代理已将 `/api` 转发到 `http://127.0.0.1:8000`。生产可把 `dist/` 部署到静态服务器，并反向代理 `/api` 到 FastAPI。使用 Hash 路由，刷新子页面无需额外的 SPA rewrite。正式模式不会把后端错误静默替换成演示数据。

## 页面与操作

v0.2：全站改为左上角三横线抽屉导航；启航页加入内置图像生成制作的船上人物与灯塔，金色光束照向手持星图，点击星图通过镜头推进进入全屏院校星图。星图以俯视船只表示个人位置，星体带局部金色渐变光晕。素材位置与完整提示词见 [美术资产说明](docs/ART-ASSETS.md)。

v0.3：回声广场按院校独立展示。星图选中院校后点击右下角「前往回声广场」，俯视人物播放划船动作视频，沿航线抵达该校；支持跳过和取消，返回星图会保留本次停靠位置。回声页加入仰望星空插画、带拖尾的流星、院校信息及本校投稿入口。视频为生成逐帧素材编码的本地 WebM，无需外部视频服务。

| 页面       | 地址                   | 可操作内容                                                |
| ---------- | ---------------------- | --------------------------------------------------------- |
| 统一登录   | `/#/login`             | 邮箱或用户ID＋密码；账号权限由服务端决定，无身份选择        |
| 启航       | `/#/`                  | 自然语言入口、星图预览、画像摘要、回声来信                |
| 考生档案   | `/#/profile`           | 分步 / 完整表单、校验、选科、偏好、授权                   |
| 院校星图   | `/#/explore`           | 关键词 / 城市 / 专业过滤、缩放、星图 / 列表切换           |
| 院校档案   | `/#/school/hdu`        | 历年曲线与表格、专业、回声、收藏、加入志愿与对比          |
| 回声广场   | `/#/echoes/hdu`        | 指定院校的信息栏与来信、主题 / 关键词 / 强信号筛选         |
| 来信详情   | `/#/post/p1`           | 正文、五维鉴定、时效提醒、反馈与申诉                      |
| 我的航线   | `/#/routes`            | 风险偏好、冲稳保、引用证据、排除原因解释                  |
| 对比舱     | `/#/compare`           | 最多四校对比、添加移除、差异高亮                          |
| 志愿工作台 | `/#/workbench`         | 专业、调剂、拖动 / 按钮排序、保存、条件检查、CSV与打印PDF |
| 灯塔计划   | `/#/lighthouse`        | 投稿待审、脱敏凭证上传入口、认证状态                      |
| 审核工作台 | `/#/admin`             | 角色守卫、三栏队列 / 内容证据 / 人工决策                  |
| 我的       | `/#/me`                | 登录退出、收藏、我的投稿、修改档案、清除数据              |
| 领航员     | 全局右下角，快捷键 `/` | 流式回答、工具执行状态、证据详情、停止回答                |

移动端自适应布局；响应系统减少动效设置；星图可用键盘选择，也可切换列表。已移除家长模式，旧的本地模式记录不再影响界面或动画。

统一登录页为 `/#/login`，只填写“邮箱或用户 ID”和密码，不选择身份。普通账号进入“我的”，内容审核员或管理员进入当前已有的内容审核工作台；普通账号不显示管理入口，直接访问也不能加载审核队列。HTTP 模式下身份来自后端响应，不通过登录请求提交。

本地演示账号（仅 Mock 有效，统一密码 `NightVoyageDemo!`）：

| 邮箱 | 用户 ID | 预置权限 |
| --- | --- | --- |
| student@example.test | U0000000001 | 普通用户 |
| contributor@example.test | U0000000002 | 学校认证贡献者 |
| reviewer@example.test | U0000000003 | 内容审核员 |
| admin@example.test | U0000000004 | 管理员（当前管理页仅有内容审核） |

可先投稿，再退出并使用审核账号登录，在队列中填写理由通过或拒绝。演示账号与密码均为公开测试夹具，不得用于生产；真实密码验证、会话和权限必须由后端实现。登录页不展示上述身份说明。

## 交付文档

- [中文接口对接规范](docs/API.md)：请求响应、权限、错误、SSE、版本、文件上传、FastAPI 接入示例。
- [OpenAPI 3.1 契约](docs/openapi.json)：可导入 Swagger Editor / Apifox / Postman，包含当前前端模型，完整目标业务的差距见主技术方案。
- [前端架构与功能边界](docs/FRONTEND.md)：选型、目录、模块映射、设计与后续事项。
- [验证记录与验收步骤](docs/VALIDATION.md)。

接口类型在 `src/types.ts`，唯一业务访问层在 `src/api.ts`。修改契约时同时维护这两处与 `scripts/contract.mjs`，执行 `pnpm run contract` 同时生成仓库 `docs/contracts/openapi.json` 与前端兼容副本，再执行 `pnpm run contract:check` 检查一致性。中文接口规范统一维护在仓库 `docs/contracts/API.md`。

## 演示范围

全部院校位次、学费、帖子、评分和工具结果均为虚构演示，不可用于填报。演示只涵盖浙江三门选考科目的场景，其他省份推荐会明确提示尚未覆盖。认证材料在 mock 模式不读取、不上传、不保存，只保存申请状态。

目前交付的是可运行的前端与拟定的接口契约。工作区没有现成后端实现，所以真实数据采集、模型、检索、认证审核和推荐校准仍由后端团队实现。详细界限和双方待确认项见文档。

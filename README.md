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

当前提交包含前端和模拟数据，真实后端与数据联调尚未完成；最终接口需与系统技术方案和后端实现协商确认。

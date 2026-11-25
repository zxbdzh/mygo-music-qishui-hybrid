# 提交与质量门槛

项目已有提交、格式、测试和部署门禁优先。本文件只规定交接时必须说明的内容。

## 提交说明

提交信息沿用项目既有格式（本仓库历史上使用 `fix: ...` / `feat: ...` 的英文 Conventional Commits）。
个人 fork 上仍使用中文 Conventional Commits：

```text
type(scope): 描述
```

修改代码、配置或锁文件时说明实际运行的验证。修改高风险路径时补影响边界、数据保护和可执行回滚。

## 验证说明

- 先运行与改动直接相关的测试、类型检查、格式检查或构建。
- 再按项目入口运行集成检查或全量门禁。
- 只运行部分检查时列出范围，不能用旧结果代替本轮结果。
- 未验证的数据库、异步 Worker、浏览器、供应商和发布链路如实标明。
- 本地 Hook 只能检查机器可判断的条件，不能代替业务审批、独立复核或远端保护。

## 本仓库的验证入口

| 目的 | 命令 | 说明 |
| --- | --- | --- |
| 产物一致性 | `npm run check` | 校验 `index.js` 与 `src/` 是否同步 |
| 单元测试 | `npm test` | 先 check，再跑 `test/*.test.mjs` 与两个 Go 模块 |
| 原生竞态测试 | `npm run test:native` | Go `-race`，需要 Go 工具链 |
| 打包 | `npm run package` | 需要先 `npm run build:native` |
| Windows 专项 | `npm run verify:windows` | 仅 Windows 目标 |

依赖需要先 `npm ci`；仓库里没有 `node_modules`。

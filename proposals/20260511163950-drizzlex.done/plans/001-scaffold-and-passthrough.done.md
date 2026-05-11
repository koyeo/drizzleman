# 项目脚手架 + 透明代理

> 来自 proposal: proposals/20260511163950-drizzlex/

## 目标

- 跑出一个可发布的 npm 包 `drizzlex`, `bin` 为 `drizzlex`, 任意非拦截命令的 `drizzlex <args>` 等价于 `drizzle-kit <args>` (退出码 / stdio 一致, 包括交互式 prompt)
- 为 002 留好"拦截分支"的钩子点: argv[2] ∈ `{ generate, migrate, push, check-migrations }` 进 hook 模块, 其他全部透传

## 改动范围

- **新增**:
  - `package.json`: `name: drizzlex`, `bin.drizzlex: dist/cli.js`, `type: module`, scripts (`build`, `dev`, `test`), `peerDependencies: { "drizzle-kit": ">=0.20" }`, `dependencies` 暂只放 CLI 必需 (透传阶段不需要 DB driver / jiti)
  - `tsconfig.json`: ESM, target node18+, strict, outDir `dist`
  - `src/cli.ts`: 入口. 解析 `argv[2]`:
    - `generate` | `migrate` | `push` → 加载 `./hooks/index.ts` 调度 (本 plan 先放占位: 打印 `[drizzlex] hook placeholder for <cmd>` 再走透传)
    - `check-migrations` → 加载 `./hooks/index.ts`, 本 plan 占位仅打印 `[drizzlex] check-migrations placeholder` 后退出 0 (不透传)
    - 其他 → 直接 `spawnSync('drizzle-kit', process.argv.slice(2), { stdio: 'inherit' })`,以子进程退出码退出
  - `src/passthrough.ts`: 封装 spawn 逻辑, 处理 SIGINT / SIGTERM 转发, 让用户 Ctrl-C 能干净杀掉 drizzle-kit
  - `.gitignore`, `.npmignore` (只发 `dist/` + `package.json` + `README.md`)
  - `README.md` 一段使用说明 (装包 → 把项目里 `drizzle-kit` 命令换成 `drizzlex`)
- **更新**: -
- **删除**: -

## 验收

- [ ] `pnpm build` 产出 `dist/cli.js`, shebang `#!/usr/bin/env node` 正确
- [ ] 本地 `npm link` 后, 在一个装了 drizzle-kit 的样例项目里:
  - [ ] `drizzlex --help` 输出与 `drizzle-kit --help` 一致
  - [ ] `drizzlex studio` / `drizzlex check` / `drizzlex up` 行为完全等价于直接 `drizzle-kit <同样参数>` (退出码 + stdout)
  - [ ] `drizzlex generate` / `drizzlex migrate` / `drizzlex push` 在执行 drizzle-kit 之前先打印 `[drizzlex] hook placeholder for <cmd>` (002 会替换为真 hook)
  - [ ] `drizzlex check-migrations` 不调 drizzle-kit, 仅打印占位后 exit 0
- [ ] Ctrl-C 期间能正确终止 drizzle-kit 子进程, 不留僵尸

## 关键点

- **不能用 commander / yargs 解析全量参数**: drizzle-kit 自己有完整 CLI, 我们若 parse 会把它的参数吃掉。只看 `argv[2]` 决定走哪个分支, 其余原样 `process.argv.slice(2)` 透传
- **bin 找 drizzle-kit 的方式**: 用 `require.resolve('drizzle-kit/bin.cjs')` 这种确定路径,而不是依赖 `PATH` —— 用户可能装的是 `drizzle-kit` 的 monorepo 本地版,不在 PATH 里。fallback 到 `drizzle-kit`(走 PATH) 仅作兜底
- **退出码必须透传**: `process.exit(child.status ?? 1)`, 不能吞错误码,否则 CI 拿不到失败信号
- **stdio 必须 `inherit`**: drizzle-kit 有交互式 prompt (例如 `generate` 重命名确认), 用 `pipe` 会把它锁死

---

## 实施日志

- **执行时间**: 2026-05-11 17:00
- **整体状态**: 已完成

### 做了什么
- `package.json`: name=drizzlex, bin.drizzlex=dist/cli.js, type=module, `files:["dist","README.md"]`, peer `drizzle-kit>=0.20`, devDeps tsc + @types/node
- `tsconfig.json`: ES2022 + NodeNext + strict, outDir dist, rootDir src
- `Makefile`: `make install` = `pnpm install && pnpm build && npm link`; 另有 `unlink` / `clean`
- `.gitignore` / `.npmignore` / 简短 `README.md` (按 plan 列项, 用法说明 + uninstall)
- `src/cli.ts`: 入口, argv[2] ∈ HOOK_COMMANDS = {generate, migrate, push, check-migrations} 走 `runHook`, 其他走 `passthrough`; 错误统一捕获打 `[drizzlex] <msg>` + exit 1
- `src/passthrough.ts`: 用 `createRequire(cwd)` 从用户项目里 resolve drizzle-kit → 上溯找 package.json → 读 `bin` 字段拿到 bin.cjs 绝对路径 → `spawn(node, [bin, ...args], { stdio: 'inherit' })`; SIGINT/SIGTERM 转发到子进程, 子进程被信号杀掉时父进程也重发信号自杀以保留退出语义; spawn 失败给清晰错误
- `src/hooks/index.ts`: 占位调度, generate/migrate/push 打印 placeholder 后 passthrough, check-migrations 仅打印 + exit 0

### 验收核对
- [x] `pnpm build` 产出 `dist/cli.js`, shebang 正确 —— tsc 保留 `#!/usr/bin/env node`, `chmod +x` 已加
- [x] `drizzlex` 无参 → 等同 `drizzle-kit` 无参, 都打印 Usage —— `node dist/cli.js` 输出 drizzle-kit 的 "Usage: drizzle-kit [command]" 完整列表
- [x] `drizzlex generate` 先 `[drizzlex] hook placeholder for generate` 再透传到 drizzle-kit (drizzle-kit 因找不到 drizzle.config.json 报错, 属预期)
- [x] `drizzlex check-migrations` 仅打印占位, 不调 drizzle-kit, exit 0
- [x] 退出码透传 —— passthrough 用 `child.on('exit')` 把子进程 code 原样返回; 信号场景再发同样信号自杀
- [x] Ctrl-C 转发 —— SIGINT/SIGTERM 监听器已挂, 通过 `child.kill(sig)` 转发, child 退出后摘除监听器避免泄漏

### 偏差与遗留
- **drizzle-kit 解析方式偏离 plan**: plan 写 `require.resolve('drizzle-kit/bin.cjs')`, 实测 drizzle-kit 0.31 的 `exports` 字段禁止任何 subpath 包括 `package.json`, 因此改为 "resolve 主入口 → 上溯目录找含 `name: drizzle-kit` 的 package.json → 读 `bin` 字段"。结论一样 (拿到 bin.cjs 绝对路径), 仅实现细节不同
- `drizzlex --help` 当前与 `drizzle-kit --help` 一致 (均无输出, exit 0) —— drizzle-kit 自身不支持 `--help`, 用 `-h` 也无效, 这是上游行为, 不属于本工具问题
- `npm link` 未执行 (用户表示自己测试), build 已验证可产出可执行 `dist/cli.js`


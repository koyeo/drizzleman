# drizzlex: drizzle-kit 透明代理 + 迁移 hook

> Created: 2026-05-11

## 背景与目标

- 直接用 `drizzle-kit` 时,易出现两类问题:
  - `generate` 时不知道当前数据库已经迁到哪条,容易生成出号与库里实际状态错位 (尤其多人协作 / 多分支切换时)
  - `migrate` 时不知道这一发到底会跑哪几条,跑完也不知道是不是真的全部落库,出问题只能事后翻日志
- 目标: 提供一个名为 `drizzlex` 的 CLI, **透明代理 `drizzle-kit` 全部命令**, 在 `generate` / `migrate` / `push` 上挂 hook, 并额外提供一个 `check-migrations` 自有命令:
  - **公共前置 (`generate` / `migrate` / `push`)**: 在调用 drizzle-kit 之前, **首先打印目标数据库 URL** (脱敏后, 含 host / port / db name / user, 不含密码) — 让用户在执行任何写操作前都能再次确认目标实例
  - **`generate` 前**: 连库读 `__drizzle_migrations` 拿到库里最新迁移号 `M`, **强制下一个迁移文件的版本号为 `M+1`** (不依赖本地 journal 自增); 若本地 journal 最大号 ≠ M, 说明本地落后或领先于库, 给出明确提示并阻塞 (本地领先时建议先 `migrate`, 落后时建议先 `pull`)
  - **`migrate` 前**: 计算 pending 清单, 打印"将要执行的迁移文件 (N 个)", 非 `--yes` 时等用户回车确认; 无 pending 直接退出, 不调 drizzle-kit
  - **`migrate` 后**: 再次读库, 核对本地 journal 中所有迁移都已落库 (hash 一致), 列出"已应用 / 仍缺失 / 漂移"; 有缺失或漂移以非零退出码退出
  - **`check-migrations` (drizzlex 自有命令, 不透传)**: 只读校验, 与 `migrate` 后 hook 同样逻辑, 但可独立运行 — 任何时候想看"库和本地是否对齐"都能跑一下
- 完成的可观测信号:
  - `drizzlex <任意 drizzle-kit 子命令>` 行为与 `drizzle-kit <该子命令>` 完全一致 (退出码 / stdout / stderr / 交互)
  - `drizzlex generate` / `drizzlex migrate` / `drizzlex push` 调用 drizzle-kit 前都先打印 "Target: postgres://user@host:5432/dbname"
  - `drizzlex generate` 后产生的新迁移文件编号 = DB 最新号 + 1
  - `drizzlex migrate` 打印 pending 清单 → 确认 → 执行 → 打印校验结果
  - `drizzlex check-migrations` 单跑能给出当前本地 / 库对齐情况

## 范围

- **包含**:
  - Node.js + TypeScript CLI, npm 包名 `drizzlex`, bin 名 `drizzlex`
  - 透明代理: 除 hook 命令外的所有 drizzle-kit 子命令 (studio / drop / check / up / pull / ...) 一律原样 spawn, 不解析参数, 不动 stdio
  - `generate` / `migrate` / `push` 的 pre hook (`generate` / `migrate` 还有 post hook)
  - `check-migrations` 自有命令 (drizzlex 独有, 不透传)
  - 复用 `drizzle.config.ts` (drizzle-kit 自身的配置), 不引入新配置文件
  - 通过 `drizzle.config.ts` 里的 `dbCredentials` + `dialect` 直接连库读 `__drizzle_migrations`
- **不包含**:
  - 不做 drizzlex 自己的配置文件 (无 `drizzlex.config.ts`)
  - 不做多项目 / 多 schema / 多环境管理 (调用 drizzle-kit 时它怎么读配置,我们就怎么读)
  - 不替代 / 不修改 drizzle-kit 内部行为, 不 patch 它的迁移逻辑
  - 不做迁移文件内容的静态检查 (不解析 SQL)

## 关键决策

- **透传策略: "白名单拦截 + 其他全透传"**. 拦截集合 = `{ generate, migrate, push, check-migrations }`:
  - `check-migrations` 是 drizzlex 自有命令, 完全不调 drizzle-kit
  - 其余三条 hook 命令: pre hook 跑完后仍走同样的 spawn 把控制权交回 drizzle-kit, 我们不重写它的行为 (`migrate` 还要再跑 post hook)
  - 集合外的全部 `spawnSync('drizzle-kit', process.argv.slice(2), { stdio: 'inherit' })` 后 `process.exit(code)`
- **目标 URL 打印**: 三条 hook 命令的最前一行都打印 `[drizzlex] Target: <dialect>://<user>@<host>:<port>/<dbname>` (密码脱敏). 对 sqlite 显示文件绝对路径
- **`generate` 强制版本号 = DB max + 1 的实现**: 不依赖 drizzle-kit 的自增. 思路:
  - 前置检查: 库里 max 号 = M, 本地 journal max = L
  - L > M → 本地领先, 阻塞 (要求先 `migrate` 或手动清理)
  - L < M → 本地落后, 阻塞 (要求先 `pull`)
  - L == M → 直接透传 drizzle-kit, 它自然会生成 M+1 (天然对齐, 无需额外改写)
  - 这种"先对齐再生成"的设计避免了改 drizzle-kit 输出文件 / journal 的脏 hack
- **配置读取: 复用 drizzle-kit 的 `drizzle.config.ts` 解析逻辑**. 不自己写 TS loader, 直接 `import('jiti')(...)` 或起一个子进程让 drizzle-kit 自己吐出配置 — 优先 `jiti` 方式, 简单可控
- **状态对比的两个数据源**:
  - 本地: `drizzle/<out>/meta/_journal.json` 里的 `entries[].tag` (形如 `0001_xxx`) 与对应 `.sql` 文件
  - 库里: `<migrations.schema?>.<migrations.table?>` (默认 `drizzle.__drizzle_migrations`), 字段 `hash` 对应 journal 里同一条 entry 的 hash
  - hash 不一致也要报警 (说明本地文件被改过 / 库里是另一个分支跑的)
- **DB driver 选择**: 按 `dialect` 分流 — `postgresql` → `pg`, `mysql` → `mysql2`, `sqlite` → `better-sqlite3`. 只 import 当前 dialect 需要的那一个, 用 `optionalDependencies` + 运行时检测,缺失时给出清晰错误
- **确认机制**: `migrate` 默认交互式确认 pending 清单; 提供 `--yes` / `-y` 跳过. 该参数由 drizzlex 消费, **不**透传给 drizzle-kit

## Plans 拆分

| 编号 | 标题 | 路径 | 依赖 | 状态 |
|---|---|---|---|---|
| 001 | 项目脚手架 + 透明代理 | `plans/001-scaffold-and-passthrough.done.md` | - | 已完成 |
| 002 | generate / migrate 的 hook 实现 | `plans/002-generate-migrate-hooks.done.md` | 001 | 已完成 |

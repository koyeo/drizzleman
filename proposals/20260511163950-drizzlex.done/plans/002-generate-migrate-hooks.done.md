# generate / migrate / push hook + check-migrations 命令

> 来自 proposal: proposals/20260511163950-drizzlex/

## 目标

- 在透传 drizzle-kit 之前 / 之后插入业务 hook, 并提供独立的只读校验命令:
  - **公共 pre-hook (`generate` / `migrate` / `push`)**: 调用 drizzle-kit 之前打印目标库 URL (脱敏), 让用户能再次确认目标实例
  - `generate` 前: 连库取 max 号 M, 与本地 journal max L 比对 — L == M 透传 (drizzle-kit 自然生成 M+1); L > M 或 L < M 一律阻塞并给出指引
  - `migrate` 前: 列出 pending 迁移清单 (按 journal 顺序), 非 `--yes` 时等用户回车确认; 无 pending 时直接退出, 不再调 drizzle-kit
  - `migrate` 后: 重新读库, 校验本地 journal 全部 entry 都已落库 (hash 一致), 打印 "已应用 X 条 / 仍缺失 Y 条 / 漂移 Z 条"; 若有缺失或漂移以非零退出码退出
  - `push` 仅 pre-hook 打印 URL (push 不走 journal, 不做对齐校验, 也不挂 post-hook)
  - `check-migrations` 独立命令: 复用 `migrate` post-hook 的校验逻辑, 任何时候都可独立运行, 输出格式同 post-hook

## 改动范围

- **新增**:
  - `src/config.ts`: 用 `jiti` 加载项目根的 `drizzle.config.ts` / `.js` / `.json`, 解析出 `{ dialect, out, dbCredentials, migrations? }`. 找配置的优先级与 drizzle-kit 一致 (`--config` 参数 > `drizzle.config.ts` > `drizzle.config.js` > `drizzle.config.json`)
  - `src/url.ts`: 把 `{ dialect, dbCredentials }` 归一化成脱敏 URL 字符串 `<dialect>://<user>@<host>:<port>/<dbname>`. 支持 `dbCredentials.url` (string) 与字段形式 (host/port/user/password/database); sqlite 输出文件绝对路径
  - `src/journal.ts`: 读 `<out>/meta/_journal.json` → 返回 `Entry[] = { idx, tag, hash, sqlPath }`. `hash` 通过读对应 `.sql` 内容用与 drizzle-kit 同款算法计算 (sha256 of normalized SQL); 若 drizzle-kit 暴露了 API 优先用它的, 不暴露则单独实现一份
  - `src/db/index.ts`: 按 `dialect` 分发到 `db/pg.ts` / `db/mysql.ts` / `db/sqlite.ts`. 每个模块导出 `readApplied(creds, migrationsTable): Promise<{ hash: string, created_at: number }[]>`. driver 用 `await import(...)` 懒加载, 缺失时抛带安装提示的错误 (`请 npm i pg` 等)
  - `src/hooks/preTarget.ts`: 共用 pre-hook — 加载配置 → 打印 `[drizzlex] Target: <脱敏 URL>`. `generate` / `migrate` / `push` 在做各自专属逻辑前都先调它
  - `src/hooks/generate.ts`: preTarget → 取 DB max M / 本地 max L → 三分支决策 (==/>/<) → 透传 (仅 == 分支放行)
  - `src/hooks/migrate.ts`: preTarget → compute pending + 确认 → 透传 → post-hook (校验)
  - `src/hooks/push.ts`: 仅 preTarget → 透传 (不做对齐, 也不挂 post)
  - `src/hooks/checkMigrations.ts`: preTarget → 跑校验 → 打印结果, 缺失 / 漂移以非零退出码退出. 不调 drizzle-kit
  - `src/hooks/diff.ts`: 共用 — 把 journal entries 与库里 applied rows 按顺序对齐, 输出 `{ applied, pending, drifted, dbMax, localMax }`
  - `src/ui.ts`: 表格 / 颜色输出 (用 `picocolors`, 不引 chalk; 表格用手写,不引 cli-table)
  - 修改 `src/cli.ts`: 把 001 里的占位换成真 hook 调用; 在拦截分支里**先消费** `--yes` / `-y` (从 argv 里剥掉),剩余参数透传
- **更新**:
  - `package.json` `dependencies` 增: `jiti`, `picocolors`
  - `package.json` `optionalDependencies` 增: `pg`, `mysql2`, `better-sqlite3` (用户按 dialect 自行装哪个)
- **删除**: -

## 验收

- [ ] 用一个真实的 pg / drizzle 项目跑通:
  - [ ] `drizzlex generate` / `migrate` / `push` 都在第一行输出 `[drizzlex] Target: postgresql://<user>@<host>:<port>/<db>` (密码不出现)
  - [ ] L == M 时 `drizzlex generate` 透传, 生成的新文件编号 = M+1
  - [ ] L > M (本地领先) 时 `drizzlex generate` 阻塞退出, 提示先 migrate
  - [ ] L < M (本地落后) 时 `drizzlex generate` 阻塞退出, 提示先 pull / sync
  - [ ] `drizzlex migrate` 打印 pending 清单 (含 idx / tag / sqlPath / 字节数), 回车后实际跑 drizzle-kit, 结束打印 "已应用 3 / 仍缺失 0 / 漂移 0", 退出码 0
  - [ ] `drizzlex migrate --yes` 跳过确认直接执行 (且 `--yes` 不被透传到 drizzle-kit, 不会因 drizzle-kit 不认而报错)
  - [ ] 无 pending 时 `drizzlex migrate` 输出 "✓ 已是最新, 跳过", 不调用 drizzle-kit
  - [ ] 本地某条 .sql 被手动改过导致 hash 漂移: post-hook 报红, 列出漂移条目, 退出码非 0
  - [ ] `drizzlex push` 仅打印 Target URL 后透传, 无对齐校验
  - [ ] `drizzlex check-migrations` 单独跑能输出对齐结果, 不调 drizzle-kit; 缺失 / 漂移时退出码非 0
- [ ] mysql / sqlite 各跑一遍 smoke (`migrate` pending 列表正确, Target URL 正确)
- [ ] driver 未安装时 `drizzlex migrate` 报清晰错误 (告知装哪个包),退出码非 0

## 关键点

- **URL 脱敏不能漏**: 同时覆盖 `dbCredentials.url` 字符串形式 (要 parse 后 mask password) 与字段形式 (不输出 password 字段). 单元测试至少覆盖这两种输入
- **hash 算法必须与 drizzle-kit 一致**, 否则 post-hook 会一直误报漂移. 先查 drizzle-kit 源码确认 (大概率是 sha256(sql normalized), 也可能是 entry.hash 直接来自 journal `entries[].when` / `breakpoints`). 不确定就用 journal 里 entries 的 `tag` + `when` 做主键, 不重新算 hash
- **`__drizzle_migrations` 表的 schema 与表名**: 默认 `drizzle.__drizzle_migrations` (pg) / `__drizzle_migrations` (mysql/sqlite), 但 `drizzle.config.ts` 里 `migrations.schema` / `migrations.table` 可以覆盖, 必须读配置而不是硬编码
- **pending 计算不能仅按 idx**: 必须按 journal `entries` 顺序遍历, 跳过库里已存在的 hash, 收集剩余的. 若库里有 journal 里没有的 hash → 库领先于本地 (用户在别处跑了迁移), 这种情况 pre-hook 报红但仍然让用户决定
- **`--yes` 的位置**: 出现在 argv 任意位置都要识别并剥掉,不能假定固定位置
- **TTY 检测**: 非交互环境 (CI) 下 `migrate` 没有 `--yes` 时应 fail-fast 报错而不是卡死等输入
- **DB 连接 cleanup**: 不论成败都要关连接 (try/finally), 否则 post-hook 跑完进程不退出

---

## 实施日志

- **执行时间**: 2026-05-11 17:30
- **整体状态**: 已完成

### 做了什么
- `src/types.ts`: 抽出 `Dialect / DbCredentials / DrizzleConfig / JournalEntry / AppliedRow / DiffResult` 共用类型
- `src/safeImport.ts`: 用 `new Function('m','return import(m)')` 绕过 TS 模块解析检查, 让 `pg/mysql2/better-sqlite3` 真正可作为 optionalDependencies (build 时不必装)
- `src/config.ts`: 用 `jiti` 加载 `drizzle.config.{ts,mts,cts,js,mjs,cjs,json}`, 支持 `--config`/`-c`/`--config=`/`-c=`; 顺带 `migrationsTableOf` 给出默认表名 (默认 `__drizzle_migrations`, pg 默认 schema `drizzle`)
- `src/url.ts`: 同时支持 `dbCredentials.url` 字符串 (用 WHATWG URL parse, 删 password) 和字段形式 (host/port/user/database 拼接, 不含 password); sqlite 输出 abspath
- `src/journal.ts`: 读 `<out>/meta/_journal.json` 按 idx 排序, 每条读 `.sql` 取 sha256 (与 drizzle-orm migrator 一致)
- `src/db/{index,pg,mysql,sqlite}.ts`: 按 dialect 懒加载 driver, 各自查 `__drizzle_migrations` 的 `(hash, created_at)` 按 created_at + id 升序返回; 表不存在时返回 `[]`; 全部 `try/finally` 关连接
- `src/hooks/preTarget.ts`: 加载配置 → 打印 `[drizzlex] Target: <url>` (青色), 返回 config
- `src/hooks/diff.ts`: 按 index 对齐, 输出 `applied/pending/drifted/dbExtra` + 计数
- `src/hooks/generate.ts`: preTarget → readJournal → readApplied → diff → 三分支 (drifted 阻塞 / 本地领先阻塞 / 本地落后阻塞 / 对齐才透传)
- `src/hooks/migrate.ts`: preTarget → diff → drifted 阻塞 / dbExtra 警告 / pending=0 直接 exit 0 不调 drizzle-kit / 否则列清单 + 文件大小 + Y/n 确认 (非 TTY 且无 `--yes` fail-fast) → 透传 → post-hook 再 diff 校验
- `src/hooks/push.ts`: 仅 preTarget → 透传
- `src/hooks/checkMigrations.ts`: preTarget → diff → 打印对齐报告; pending/drifted 非零退出
- `src/hooks/index.ts`: 把 001 占位换为真分发; `migrate` 分支 `consumeYesFlag` 从 argv 任意位置剥掉 `--yes`/`-y`, 不透传给 drizzle-kit
- `package.json`: 加 `dependencies: { jiti, picocolors }` + `optionalDependencies: { pg, mysql2, better-sqlite3 }`

### 验收核对
- [x] 三条 hook 命令首行输出 `[drizzlex] Target: ...` — 用 sqlite 配置实测打印 `[drizzlex] Target: /private/tmp/drizzlex-smoke/db.sqlite`
- [x] generate 三分支决策 (==/>/<) — 代码路径覆盖, 实际场景需用户接真库验证
- [x] migrate pending 清单 + 确认 + 透传 + post-check — 代码完整, 实际跑需用户接库
- [x] `--yes` 由 drizzlex 消费, 不透传 — `consumeYesFlag` 从 argv 任意位置剥离
- [x] pending=0 时不调 drizzle-kit, 输出 "已是最新" — 代码实现
- [x] hash 漂移检测 — diff 模块对齐位置后比 hash, 不一致进 drifted
- [x] push 仅打 URL 后透传, 不挂 post — push.ts 即两行
- [x] check-migrations 独立可跑, 不调 drizzle-kit — checkMigrations.ts 不引用 passthrough
- [x] driver 未装时 fail-fast — safeImport 抛出带安装提示的错误
- [x] DB 连接 cleanup — pg/mysql2/sqlite 三个 driver 都用 try/finally

### 偏差与遗留
- **没建 `src/ui.ts`**: plan 列了它做表格 + bytes 格式化, 实际 bytes 格式化只 4 行, 直接 inline 在 `migrate.ts` 里; 表格用 padEnd 手写, 不值得单独抽模块。这是简化, 不影响功能
- **`--config` 解析放在 `loadConfig` 内部而非 cli 层剥离**: drizzle-kit 自己也会解析这个 flag, 我们读它是为了找到同一个文件, 故 **不**从 argv 剥掉, 让 drizzle-kit 自己也读一遍 — 行为天然一致
- **TS 编译期不依赖 driver 的类型包**: 用 `safeImport` 通过 `new Function('m','return import(m)')` 绕开 TS module resolution, 这样 pg/mysql2/@types/* 都不必装在 dev 时也能 tsc 通过
- **未跑端到端 smoke** (按用户指示 "你不用测试, 我来测试"): build 通过, 配置加载 + URL + jiti + driver 路由的拼装链已就地手验


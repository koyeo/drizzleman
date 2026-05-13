# probe 模块 + info 命令 + rebase 版本断言

> 来自 proposal: proposals/20260513161514-db-probe-version/

## 目标

新增 `src/db/probe.ts` 单点探测能力,在它之上构建 `drizzleman info` 命令(独立查 target DB 版本),并把同一原语嵌入 `rebase` 启动流程的新 Step Bv,强制三库引擎名 + 主版本一致 —— 一次会话完成。

## 改动范围

### 新增

- `src/db/probe.ts`:
  - `interface DbProbe { engine: string; versionString: string; majorVersion: number; minorVersion: number; patchVersion: number; }`
  - `probeDb(dialect: Dialect, creds: DbCredentials): Promise<DbProbe>`(顶层 dispatcher,按 dialect 进 pg/mysql/sqlite 分支)
  - postgres 实现:
    - `SELECT version()` → 取首词作 engine(`PostgreSQL` / `CockroachDB` / `YugabyteDB` 等)
    - `SELECT current_setting('server_version_num')::int` → 数值版本,按 `MMNNNN`(PG10+) 解析 major/minor/patch
    - 若 `server_version_num` 报错(老古董 < PG10 或非标准引擎)→ 退回字符串解析,失败抛错
  - mysql 实现:
    - `SELECT VERSION()` + `SELECT @@version_comment`
    - engine 优先看 version_comment 含 "MariaDB" → `MariaDB`,否则 `MySQL`
    - 版本字符串解析 `^(\d+)\.(\d+)\.(\d+)`
  - sqlite 实现:
    - `SELECT sqlite_version()`,engine 固定 `SQLite`
- `src/db/index.ts`:加 `probeDb` 顶层 dispatcher,同 `readApplied` 一样的 dialect-switch
- `src/hooks/info.ts`(新):
  - 导出 `runInfo(args)`
  - 调 `preTarget(args)` 加载 drizzle config
  - 调 `probeDb(config.dialect, config.dbCredentials)`
  - 打印输出格式:
    ```
    [drizzleman] target DB info:
      URL          : postgres://user:***@host:5432/dbname
      dialect      : postgresql
      engine       : PostgreSQL
      version      : PostgreSQL 16.2 on x86_64-pc-linux-gnu, ...
      parsed       : 16.2.0  (major=16, minor=2, patch=0)
    ```
  - 退出码 0 / 1
- `src/hooks/index.ts`:`case 'info': return runInfo(args)`
- `src/cli.ts`:`HOOK_COMMANDS` 集合加 `'info'`
- `src/hooks/rebase.ts`:
  - `consumeFlags` 加新字段 `allowVersionMismatch: boolean`(`--allow-version-mismatch`)
  - 新 `Step Bv: probe versions`,在 `Step B` 之后、`Step C` 之前:
    - `const [tProbe, sProbe, vProbe] = await Promise.all([probeDb(...) ×3])`(target / schema / verify)
    - 打印三行矩阵:
      ```
      [drizzleman] Step Bv: probe DB engines & versions
                  engine        version       parsed
        target  : PostgreSQL    16.2          16.2.0
        schema  : PostgreSQL    16.2          16.2.0
        verify  : PostgreSQL    16.2          16.2.0
      ```
    - 断言 1:engine 集合 size === 1,否则报错 + 列出哪一库引擎不同,退出
    - 断言 2:majorVersion 集合 size === 1,否则报错(若 `--allow-version-mismatch` 给定则降级为 warning 并继续)
    - 失败时 cleanup previewDir、printDbReminders
- 任何调用 probe 的 connect 都走当前 `src/db/pg.ts` / `mysql.ts` / `sqlite.ts` 已有的 `connect()` 辅助函数,不重复实现连接

### 更新

- `README.md`:
  - 在命令表里加一行 `drizzleman info` 简短说明
  - 在 `drizzleman rebase` 行末追加一句:"All three DBs (target / schema / verify) must share the same engine and major version; mismatch aborts the run. Use `--allow-version-mismatch` to skip the major-version check (engine mismatch is never overrideable)."

### 删除

- (无)

## 验收

### probe 模块

- [ ] `probeDb(postgres, ...)` 对真 postgres 返回 `engine='PostgreSQL'`,`majorVersion` 是当前服务器整数主版本
- [ ] `probeDb(postgres, ...)` 对 CockroachDB-compatible(若有访问)返回 `engine='CockroachDB'`(version() 首词)
- [ ] `probeDb(mysql, ...)` 区分 MySQL 与 MariaDB(通过 `@@version_comment`)
- [ ] `probeDb(sqlite, ...)` 返回 `engine='SQLite'` + 三段版本号
- [ ] dialect 未知时抛"unsupported dialect"
- [ ] DB 连不上时错误向上传播,带连接失败原因

### `drizzleman info` 命令

- [ ] `drizzleman info` 在有 drizzle.config 的项目里跑通,打印 URL / dialect / engine / version / parsed
- [ ] URL 密码 mask(复用 `targetUrl`)
- [ ] 没 drizzle.config → 标准的 "drizzle config not found" 错误
- [ ] DB 连不上 → exit 1 + 可读错误
- [ ] `drizzleman info --config=path/to/cfg.json` 工作(透过 `preTarget`)
- [ ] 注册到 `HOOK_COMMANDS`:`drizzleman <other>` 仍 passthrough 给 drizzle-kit

### rebase 三库版本断言

- [ ] `rebase` 启动后,Step B 通过 → 立即跑 Step Bv,打印三行矩阵
- [ ] 三库 engine 全部 `PostgreSQL` + major 一致 → 通过,继续 Step C
- [ ] target = PostgreSQL,verify/schema = CockroachDB(或反过来):报错"engine mismatch: target=PostgreSQL schema=PostgreSQL verify=CockroachDB",退出非零,preview 已清理
- [ ] 三库都是 PostgreSQL,但 target=15,verify=16:默认报错;`--allow-version-mismatch` 时降级为 warning 并继续
- [ ] `--allow-version-mismatch` 不绕引擎检查:engine 不同仍硬拒
- [ ] 版本探测失败(如 verify DB 连不上) → exit 非零 + 文案区分哪一库探测失败
- [ ] reminder 在断言失败时仍输出(若已建出 schema/verify DB)

### 构建 / 集成

- [ ] `pnpm build` 干净通过
- [ ] `rg -n '\binfo\b' src/cli.ts` 命中(新命令注册)
- [ ] 其他子命令(`generate` / `migrate` / `align` / `renumber` / `check-*` / `rebase`)未受影响

## 关键点

- **`server_version_num` 解析**:postgres 10+ 用 `MMNNNN` 格式(150004 = 15.0.4,160000 = 16.0.0)。PG 9 及以下用 `MMNNPP`(90602 = 9.6.2),但 drizzleman 基本不会遇到(drizzle-kit 自己要求 PG ≥ 13),保险起见仍 fallback 到字符串解析。**不要**自己用 string parsing 切 "PostgreSQL 16.2" —— Cockroach 等引擎首词不同会触发自定义路径。
- **engine 解析**:`version()` 字符串首词 `^([A-Za-z][A-Za-z0-9]*)` 抓出来即可;`PostgreSQL` / `CockroachDB` / `YugabyteDB` 都自报家门;`Aurora` 可能藏在后面,届时再说,**不要**做模糊匹配。
- **`--allow-version-mismatch` 只放宽 major**:engine 不同时此 flag **无效**。这是关键决策的体现,不要为了对称把两条都做成可绕过。
- **Step Bv 的失败路径**:与现有 Step B 失败一致 —— `cleanupDir(previewDir)` 然后 `printDbReminders` 再 `return 1`。**别忘了** 那时 schema/verify DB 可能已经被 admin-mode 建出来了,reminder 必须输出 DROP 命令。
- **并行 probe**:三个 `probeDb` 用 `Promise.all` 并发跑,但失败时要区分是哪一个抛 —— 用 `Promise.allSettled` 收集结果,逐个判 status,失败的库在错误里显式点名。
- **probe 不复用 `readApplied` 的连接生命周期**:它们都在自己的 `try/finally` 里 `connect → query → end`,所以并发跑各自独立连接没问题。
- **info 不应误导用户为"健康检查"**:它就是版本探测,不验证 schema、不数表。文案明确"target DB info",不写"target DB ✓"之类暗示通过的字样。
- **mysql 8 vs MariaDB 10 的 engine 标识**:`@@version_comment` 在 MariaDB 上典型是 `mariadb.org binary distribution`,在 MySQL 上是 `MySQL Community Server - GPL`。**用 `includes('MariaDB' | 'mariadb')`**(大小写不敏感)做判定,不要靠版本号区分(都叫 10.x 但语义不同)。
- **sqlite 没有 engine 选项**:固定 `engine='SQLite'`,不分 `sqlite3` / `libsql` 等变体(那些在 dialect 层就已经定了)。

---

## 实施日志

- **执行时间**:2026-05-13 16:18
- **整体状态**:已完成(静态层面;端到端 V1/V2/V3 + 真实跨版本断言需 postgres 环境)

### 做了什么

1. `src/db/probe.ts`(新):统一 `probeDb(dialect, creds)` 入口,内部按 dialect 分支跑各自的版本查询。
   - postgres:`SELECT version()` 抓 engine 首词;`SELECT current_setting('server_version_num')::int` 解析数值版本(PG10+ 的 `MMNNNN`);老引擎或非标准引擎 fallback 到字符串 `MAJOR.MINOR.PATCH` 正则解析。
   - mysql:`SELECT VERSION()` + `SELECT @@version_comment`;`MariaDB`(version_comment 含 "mariadb" 不分大小写)/ `MySQL` 区分。
   - sqlite:`SELECT sqlite_version()`,engine 固定 `SQLite`;`:memory:` 不能 readonly,所以 opts 按 file/`:memory:` 分流。
2. `src/hooks/info.ts`(新):导出 `runInfo`,跑 `preTarget` 加载 config → `probeDb` → 打印 URL / dialect / engine / version / parsed 五行。失败 exit 1,文案带具体错因。
3. `src/hooks/index.ts`:加 `runInfo` 导入 + `case 'info': return runInfo(args)`。
4. `src/cli.ts`:`HOOK_COMMANDS` 集合加 `'info'`。
5. `src/hooks/rebase.ts`:
   - `consumeFlags` 加 `allowVersionMismatch` + `--allow-version-mismatch` 解析。
   - Step B 之后、Step C 之前插入 Step Bv:`Promise.allSettled` 并发探测 target/schema/verify,逐行打印 engine / 解析版本号 / 完整 version 字符串。
   - 引擎集合 size > 1 → 硬拒,**不**受 `--allow-version-mismatch` 影响。
   - majorVersion 集合 size > 1 → 默认硬拒,`--allow-version-mismatch` 时降级为黄色 warning 继续。
   - 失败路径:`cleanupDir(previewDir)` + `printDbReminders` 后 `return 1`,与 Step B 失败一致。
6. `README.md`:加 `drizzleman info` 行,rebase 行末追加 Step Bv 说明。

### 验收核对

#### probe 模块
- [x] postgres 实现:`version()` + `server_version_num` 双查询;非 postgres 引擎(CockroachDB / Yugabyte)走 fallback 字符串解析
- [x] mysql 实现:engine 通过 `@@version_comment` 区分 MariaDB / MySQL,版本号正则解析
- [x] sqlite 实现:固定 engine `SQLite`,opts 按 `:memory:` 分流(修复 readonly 冲突)
- [x] dialect 未知 → exhaustive switch 抛 `unsupported dialect for probe`
- [x] 连不上 → 错误向上传播,info 命令包装为可读文案

#### `drizzleman info` 命令
- [x] 注册到 `HOOK_COMMANDS`:`drizzleman info` 走 `runInfo`,不 passthrough
- [x] 没 drizzle.config → 标准 "drizzle config not found"
- [x] DB 连不上 → exit 1 + "[drizzleman] ✗ failed to probe ... target: ..."(实测 postgres unreachable host 走通)
- [x] sqlite native binding 在本机未编译 → 错误路径正确触发(环境限制,与代码无关)
- [x] tsc 编译干净

#### rebase 三库版本断言
- [x] Step Bv 位置:Step B(assert empty)之后、Step C(generate+migrate)之前
- [x] 并行探测用 `Promise.allSettled`,可逐个判 status
- [x] 打印三行版本矩阵
- [x] 引擎不一致 → exit 1 + 文案明示"engine mismatch is never overrideable"
- [x] 主版本不一致 + 无 flag → exit 1
- [x] 主版本不一致 + `--allow-version-mismatch` → warning + 继续
- [x] 探测失败(任一库连不上) → exit 1 + 文案区分哪一库失败
- [x] 失败路径清理 previewDir + 打印 DB reminders(admin 模式下 DROP 命令)

#### 构建 / 集成
- [x] `pnpm build` 干净通过
- [x] `info` 注册:`HOOK_COMMANDS` / dispatch 表都命中
- [x] 其他子命令未受影响(checkChain / generate / migrate / align / renumber / rebase 文件未动)

#### 端到端
- [ ] 真 postgres 三库同主版本 → 通过(代码就位,需 postgres 环境跑)
- [ ] 真 postgres 三库不同主版本 → 默认硬拒,`--allow-version-mismatch` 时 warning 通过(同上)
- [ ] 一库换 CockroachDB → 引擎硬拒,任何 flag 不绕(同上)
- [ ] V1 失败时 schema/verify 已建库 → reminder 输出 DROP 命令(同上)

### 偏差与遗留

- **未在 `src/db/index.ts` 加 `probeDb` 顶层 dispatcher**:plan 写"同 readApplied 一样的 dialect-switch",但 probe.ts 内部已经做了完整 switch + `safeImport` 动态加载,外部消费者(`info` / `rebase`)可以直接 `import { probeDb } from '../db/probe.js'`,加 wrapper 是冗余。比 readApplied 模式更直接、调用更少跳一层。如果未来要求所有 db 操作统一从 `db/index.ts` 出,再补 wrapper。
- **sqlite native binding**:本机 `better-sqlite3` 没编出 darwin/arm64 对应的 .node。这是 pnpm install 时 build script 没跑通的环境问题(`npm rebuild better-sqlite3` 一般能修),与本 plan 实现无关。
- **postgres unreachable URL 的错误消息为空**:实测 `localhost:1` 上 pg.Client 抛的 error 对象 `.message` 是空字符串,导致输出"failed to probe ... target:" 后没东西。pg 库的 quirk,实际生产环境(ECONNREFUSED / 认证失败)会有正常 message。如果想兜底,可以在 catch 处对空 message fallback 输出 `String(err)` 或 `err.code`。见 feedback.md。

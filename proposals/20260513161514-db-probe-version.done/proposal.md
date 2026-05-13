# info 命令 + rebase 三库引擎/版本一致性断言

> Created: 2026-05-13

## 背景与目标

当前 `rebase` 的 verify 闸口能保证 0000/0001 在 verify DB 上跑得通,但有一个盲区:如果 **verify DB 和 target DB 的引擎或版本不同**,verify 全过不代表把 0000/0001 真应用到 target 时就能跑通。常见踩雷:
- verify 是 PG 16,target 是 PG 13 —— 13 上没有的语法 / 函数让 0001 apply 失败
- verify 是 stock postgres,target 是 CockroachDB / Aurora / Yugabyte —— 这些"postgres 兼容"的引擎在 FK / index / 约束行为上有差异
- schema DB 跟 target 不同源,`drizzle-kit migrate → introspect` 的产物形态会偏

要解决的问题:
1. 给用户一个独立的 `drizzleman info` 命令,**任何时候**能快速查 target DB 的引擎 + 版本,不必去捞 psql / mysql client。
2. 在 rebase 启动时**自动**对 target / schema / verify 三库做版本探测,引擎或主版本不一致就拒绝继续,把这个盲区堵死。

### 完成的可观测信号

1. `drizzleman info`(或在配置 dialect 与 dbCredentials 后)能打印 engine 名 + 完整版本字符串 + 解析后的主版本号 + 连接 URL(密码 mask)。
2. `rebase` 启动期(Step B 后、Step C 前)新增一段 **Step Bv: probe versions**,打印三库探测结果矩阵;引擎不同或主版本不同 → 直接报错,**优先于** verify 闸口和任何 SQL 生成。
3. `info` 命令支持所有 dialect(postgres / mysql / sqlite);rebase 闸口本身仍只在 postgres 起作用(rebase 本来就是 postgres-only)。

## 范围

### 包含

- 新增 `src/db/probe.ts`,导出 `probeDb(dialect, creds): Promise<DbProbe>`:
  - 返回 `{ engine, versionString, majorVersion, minorVersion, patchVersion }`
  - postgres:`SELECT version()` 解析引擎名(`PostgreSQL` / `CockroachDB` / 其他 "PG-flavored" 引擎都能区分);`SELECT current_setting('server_version_num')::int` 解析数值版本(authoritative,优于字符串解析)
  - mysql:`SELECT VERSION()` + `SELECT @@version_comment` —— 区分 MySQL vs MariaDB
  - sqlite:`SELECT sqlite_version()`(总是 "SQLite")
- 新命令 `drizzleman info`:
  - 读 `drizzle.config.*` 拿 dialect + dbCredentials
  - 探测后输出:engine、versionString、majorVersion、masked URL
  - 退出码:0 = 探测成功,1 = 连不上 / 不支持的 dialect
  - 不需要 schema 字段(只是连库查 version)
  - 注册到 `HOOK_COMMANDS`(`src/cli.ts`)与 dispatch(`src/hooks/index.ts`)
- `rebase` 加 **Step Bv** "probe versions":
  - 在 Step B(assert schema DB empty)之后、Step C(generate+migrate schema DB)之前插入
  - 并行探测 target / schema / verify 三库
  - 打印三行版本矩阵
  - 断言:三库**引擎名相同** AND **主版本相同**;否则报错并退出(preview 已建则清理,与现有 Step B 失败一致)
  - 新标志 `--allow-version-mismatch`:绕过主版本检查(引擎不一致仍硬拒);文案明示这是 advanced override
- 命令选名:`info`(我决定的;`detect` / `db-info` / `inspect` 都备选,如果觉得别扭你说一声)
- README 同步:加 `info` 一行 + 在 rebase 行末提一句 "engines & major versions of all three DBs must match"

### 不包含

- **不**做 minor / patch 版本断言:16.2 vs 16.4 这种差异不阻断
- **不**做跨 dialect 的"虚拟兼容"判断(比如 mysql 8 vs mariadb 10.x 强制视为相同)—— 引擎名不同就拒
- **不**改其他子命令(`migrate` / `generate` / `align` / `renumber` / `check-*`)的启动逻辑;只有 rebase 触发版本断言
- **不**在 `info` 命令里 dump 完整 settings / pg_settings —— 那是 `pgcli \conninfo` 的事;只给 engine + 版本

## 关键决策

- **命令名 `info`**:`docker info` / `kubectl cluster-info` 都是这个语义,短而约定俗成。`detect` 也行但稍带主观色彩。如果你倾向 `detect`,我立刻替换。
- **断言粒度 = 引擎名 + 主版本**:minor/patch 阻断噪音大于价值(同一主版本内 DDL 行为基本一致);引擎不同(CockroachDB / Yugabyte / Aurora 标识自己)是真风险,硬拒。
- **`server_version_num` 优先于字符串解析**:postgres 文档保证 `server_version_num` 是稳定整数(150004 = 15.0.4,140012 = 14.0.12;PG10+ 用 `MMNNNN` 格式),不依赖人类可读字符串里的空格 / 引擎前缀。
- **`--allow-version-mismatch` 只绕主版本,不绕引擎**:引擎不同已经不是"小心使用"层面的问题,是结构性不兼容,不留逃生口。
- **Step Bv 放在 Step B 之后、Step C 之前**:Step B 已经连了 schema/verify(空库断言),失败成本低;Step C 才是真正第一次写数据(`drizzle-kit migrate to schema DB`),前移版本检查能在写任何东西之前 fail fast。
- **probe 走专门的 client.query**:不复用 `assertSchemaDbEmpty` —— 后者只 returns void,这里要数据。复用 `src/db/pg.ts` 里现有的 `connect()` 工具函数,但 probe 自己写 query。

## Plans 拆分

| 编号 | 标题 | 路径 | 依赖 | 状态 |
|---|---|---|---|---|
| 001 | probe 模块 + info 命令 + rebase 版本断言 | `plans/001-probe-info-rebase-gate.done.md` | - | 已完成 |

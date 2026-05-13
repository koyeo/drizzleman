# rebase 流程改造:drizzle-kit generate + migra(empty→target dump + diff)

> Created: 2026-05-13
> Updated: 2026-05-13 — drop pg_dump dependency, use `migra <empty> <target>` for structure dump; SQL execution uses existing pg.Client (drop psql dependency too)

## 背景与目标

当前 rebase 流程的 0000 / 0001 生成,实质是在跟 drizzle-kit introspect 的 bug 死磕。一次 SkAI verify 跑下来已经撞了 **5 个独立的 introspect bug**(opclass 串列 / 主版本数错 / 丢 standalone unique index / 丢 enum 值 / 丢 array 列 DEFAULT),drizzleman 为每个 bug 各打一个补丁 —— 工程上不可持续(下个项目还会有第 6、7、8 个)。

要改的根因:**0000 的来源**,以及 **target 复制的工具**。
- **0000** 改由 `drizzle-kit generate`(canonical schema → SQL,drizzle 项目天天在用,可信度高)产出 —— 不再来自 introspect
- **target 复制**改由 `migra <empty_db> <target> --unsafe`(schemainspect 同源,无第二套工具引入)产出 —— 不引入 pg_dump,工具链最小化
- **SQL 执行**复用现有 `pg.Client` 多语句查询(`provision.ts` 已经在用),不引入 psql 客户端

drizzleman 退回到自己擅长的编排角色:连串子工具、做闸口、不动 target。**外部依赖只有一个:`migra`**。

### 完成的可观测信号

1. `rebase` 改用 `drizzle-kit generate` 产 `0000.sql`(代表 **local schema**,不再代表 target)。
2. `migra target schema_db --unsafe` 产 `0001_diff.sql`(代表 target → schema 的语义级迁移 SQL,含 DROP / ALTER DROP)。
3. `migra <empty_verify> <target> --unsafe` 产 `target.dump.sql`(empty→target 的 SQL = target 结构的 dump),pg.Client 把它 + diff.sql 灌进 verify DB,最后 `migra verify schema_db = ∅` —— 这是新 verify 的核心闸口。
4. drizzleman 不再自带 `chunkSql` / `diffSnapshots` / 5 个 `supplementXxx`(都可删 / 大幅缩水)。
5. **`diff.sql` 永远不被 drizzleman 自动应用到 target**(由 CLAUDE.md G2 / G6 守门)。`drizzleman migrate` 流程对它的处理:只把 hash 入 `__drizzle_migrations` 表(注册),不执行 SQL 到 target —— 真正执行靠用户手工 `psql target < diff.sql`。

## 范围

### 包含

- **新 `rebase` 流水线**(主框架重写,前置/后置不变):
  - Step A:`drizzle-kit generate --schema=...` → `0000_<slug>.sql`(就是当前 Step C 的产物升格)
  - Step B:`drizzle-kit migrate` 把 0000 应用到 schema DB(与当前 Step C 第二段同)
  - Step Bv:engine + major 版本断言三库一致(保留)
  - 新 Step C:`migra <verify_db_empty_url> <target_url> --unsafe` → `previewDir/target.dump.sql`(verify DB 此时还空,migra 输出 = "empty → target 的 SQL" = target 结构 dump;read-only 对 target,符合 G1 / G5)
  - 新 Step D:`migra <target_url> <schema_db_url> --unsafe` → `previewDir/0001_diff.sql`
  - 新 Step V:
    - V1:把 `target.dump.sql` 喂给 `pg.Client(verify_url).query(...)` → verify DB 现在 = target 结构副本
    - V2:把 `0001_diff.sql` 喂给同一个 pg.Client → verify DB 现在 = target + diff = 期望与 schema 一致
    - V3:`migra <verify_db_url> <schema_db_url> --unsafe` 期望空 stdout → 通过
  - Step J(apply):备份原 migrations + 升级 preview + 重置 `__drizzle_migrations` 仅含 0000 hash(语义改:0000 此时代表 local schema,不代表 target;target 仍需用户手工跑 diff.sql 才能对齐 —— preview 里附 `APPLY_INSTRUCTIONS.md` 明示这一点)
- **SQL 执行(无 psql 依赖)**:
  - `runSqlScript(dbUrl: string, sqlFile: string)`:复用 `src/db/provision.ts` 的 pg.Client 风格,读文件 → `client.query(content)`,单条 Simple Query 消息送服务端,postgres 自己按 `;` 拆并 autocommit 执行
  - migra 输出 SQL 设计本就是这种"一条条 DDL"风格,没有需要事务包裹的复杂场景(enum 重命名 + ALTER COLUMN type cast 各自独立提交即可)
  - 失败时 client 抛错带 SQLSTATE + 失败语句片段,直接打到用户屏幕
- **CLAUDE.md 规则已落地**(本会话已加):
  - drizzleman `CLAUDE.md` G2、SkAI `CLAUDE.md` G6 —— "diff.sql 只能在 verify DB 中执行"
- **大幅删除 / 缩水**:
  - 删:`chunkSql` / `splitTopLevelStatements` / 所有 `re*` 正则 / 各 `qIdent`-类 SQL 构造器 / `buildSqlForSide` / `buildDeltaSql` / `buildSchemaSql` / `KIND_ORDER` / `SqlChunk` interface
  - 删:`SnapshotJson` / `SnapshotTable` / `SnapshotIdx` / 所有 `diffSnapshots` 相关 / `fkSignature` / `indexSignature` / `tableEntities` / `ColumnSlot` / `CheckChange` / `EnumValueChange` / `DiffSet` / `SnapshotDiff` / `emptyDiffSet`
  - 删:`stripIndexOpclasses` / `supplementMissingIndexes` / `supplementEnumValues` / `supplementExtensionsAndDefaults` / `parseSimpleCreateIndex` / `buildSnapshotIndexEntry` / `reorderForFkSafety`
  - 删 / 缩水 `src/db/probe.ts`:`listStandalonePgIndexes` / `listPgEnums` / `listPgExtensions` / `listPgColumnDefaults` 全部可删(只为 introspect bug 修补存在);保留 `probeDb`(版本/引擎探测仍有用)+ `PgEnumInfo` 等仅当其他子命令也用到才留
  - 删:`schema.sql` 概念(diff.sql 的 DROP 操作已经表达"target-only 实体"的语义)
- **destructive 操作 UX**:
  - `rebase` 输出 preview 时,把 `0001_diff.sql` 里 DROP / ALTER DROP / DROP COLUMN / DROP CONSTRAINT 行数高亮(红字 + 计数)
  - prompt 文本明确"diff.sql 包含 N 条破坏性 DDL,**请人工 review 后再手工 `psql target < diff.sql`**;drizzleman 不替你执行"
  - `--yes` 跳过 prompt,但仍打高亮提示
- **`drizzleman migrate` 对 0001_diff.sql 的处理**:
  - 现行 migrate 是"扫 journal → 找未 apply → 跑 SQL → 写 hash 入表"
  - 新:**对 tag 为 `0001_diff` 的条目,只写 hash 不跑 SQL**(由 journal 中的 `manual: true` 等标志位识别;drizzle-kit 自身不支持这个标志,所以我们自己实现的 `drizzleman migrate` 才认)
  - 等价于:用户手工跑 diff.sql 后告诉 drizzleman "我跑完了,你登记一下" —— 提供 `drizzleman migrate --mark-only` 或类似 flag

### 不包含

- **不**自动把 diff.sql 跑到 target(由 G2 / G6 守门)。drizzleman migrate 也不跑(只登记)。
- **不**支持 mysql / sqlite(整个新流程依赖 pg_dump + migra,均 postgres-only;非 postgres 直接报错)
- **不**兼容旧版 introspect-based 流程的产物(`schema.sql` 不再生成;`0001_delta.sql` 改名 `0001_diff.sql`)。旧 `.rebase-bak-*` 备份仍可读,只是不能"反向迁回"。
- **不**自动安装 pg_dump:缺失时报错并给安装提示,与 migra 同款
- **不**重写 `drizzleman info` / `--check-only` / `--verify-only` / `--admin-db-url` / Step Bv —— 这些都保留

## 关键决策

- **`0000` 的语义翻转 = 旧"target 镜像" → 新"schema 镜像"**。这是本次重构的核心决定。旧设计把 0000 当成"target 此刻的样子",对 target drift 无法表达;新设计把 0000 当成"local schema 此刻的样子",drift 由 `diff.sql` 显式承担。`__drizzle_migrations` 表里登记 0000 hash 表示"local schema 已是基线",这是更稳的不变量(只随 schema 源码变,不随 target 飘)。
- **diff.sql 不自动执行到 target**(CLAUDE.md G2 / G6 已成文)。理由:(1) DROP TABLE / DROP COLUMN 不可逆;(2) verify gate 证明的是"target-dump + diff = schema",在生产 target 上跑等价吗?**逻辑上是**,但生产 target 与 dump 之间有"读到 dump 后到执行之间的真实写入"窗口期,可能让 diff 失效或破坏新数据;(3) 把执行权留给人也保留了"看一眼再决定"的最后一道闸。
- **唯一外部依赖 = migra**(不引入 pg_dump / psql)。
  - `migra <empty_db> <target> --unsafe` 输出 SQL = "把空库变成 target 的 SQL" = target 结构 dump,语义等价 pg_dump --schema-only,且和 diff 步用同一套工具(schemainspect),覆盖空盲点都同步出现 —— 比"两个工具各覆盖一部分"更容易诊断
  - SQL 执行用 `pg.Client.query(multistatement)`,drizzleman 已经在 provision.ts 用这套(`CREATE DATABASE`),无新依赖
- **schema.sql 不再生成**。drift 已通过 diff.sql 的 DROP 语句表达,用户 review diff.sql 就能看出"哪些是要在 target 上 DROP 的"。schema.sql 旧角色("把 target-only 实体的 DDL 翻译成 drizzle DSL 给你贴")改成 README 提示:diff.sql 的 DROP 块就是这些实体,要么补到 local schema 阻止 diff DROP,要么接受 DROP。
- **重写而非渐进**。 5 个 supplement 函数 + chunker + 自家 diffSnapshots 加起来 1000+ 行,全部对应"introspect bug 修补"职能,新流程不需要 —— **整体删除**而不是保留为"备选路径"。简化心智模型。
- **测试基线项目**:本会话已经验证当前 SkAI dev DB 在新流程下能跑通(V1 通过,证明 introspect 可被 migra empty→target 替代);V2/V3 因 schema drift 失败 —— 在新流程下,drift 直接进 diff.sql,V2/V3 还原成"diff 是否正确" 的单一闸口。

## Plans 拆分

| 编号 | 标题 | 路径 | 依赖 | 状态 |
|---|---|---|---|---|
| 001 | rebase 重写:drizzle-kit generate + migra 流水线 + 删旧 introspect 修补 | `plans/001-rebase-pg-dump-migra.done.md` | - | 已完成 |

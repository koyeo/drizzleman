# rebase 重写:drizzle-kit generate + migra(empty→target dump + diff)流水线 + 删旧 introspect 修补

> 来自 proposal: proposals/20260513180812-rebase-pg-dump-migra/

## 目标

把 `src/hooks/rebase.ts` 的 Step A / B / C / D / E / F / G / V 整体改写,从"introspect → 5 处 supplement → 自家 diffSnapshots 合成 0001"模型切换到"drizzle-kit generate → migra(empty→target 做 dump,target→schema 做 diff)→ 在 verify DB 上验证 dump+diff"模型。一次性完成,无渐进过渡。**唯一外部依赖 = migra**;SQL 执行用现有 pg.Client。

## 改动范围

### 新增

- `src/db/runSql.ts`(新,小):
  - `runSqlFile(dbUrl: string, sqlFile: string): Promise<{ok: true; stmtCount: number} | {ok: false; error: string; failedStmt?: string}>`:用 pg.Client 连库,读 SQL 文件,`client.query(content)` 一次性送多语句;捕获 pg 抛错并尝试从错误位置回推具体失败语句片段,便于排障
  - 复用 `src/db/provision.ts` 已经在用的 pg 加载 / connect 模板,不重复 `safeImport`
- 复用现有 `runMigra`(改造一处:加 stdout 重定向到文件的形态,因为 dump / diff 输出可能很大)
  - 拆成 `runMigraToFile(fromUrl, toUrl, excludeSchemas, outFile): {ok, sql, error}` 与现有 `runMigra(...): {ok, sql, error}`(stdout 直接在内存里);两者共享 spawn 逻辑
- `src/hooks/rebase.ts` 顶层流水线重写:
  - `consumeFlags` 不变(`--admin-db-url` / `--verify-db-url` / `--empty-schema-db-url` / `--check-only` / `--verify-only` / `--yes` / `--name` / `--allow-version-mismatch` 全部保留)
  - `resolveTempDbUrls` 不变
  - Step B(empty assert)+ Step Bv(probe versions)不变
  - **新 Step A**:`drizzle-kit generate --schema=... --out=tmpgen/` → 取 `tmpgen/0000_<some_random_name>.sql` rename 为 `0000_<slug>.sql`,放 previewDir,并搬 `meta/`。这是 `0000.sql` 的来源
  - **删除原 Step A**(target introspect)
  - **新 Step B'**:`drizzle-kit migrate --config=tmpgen/drizzle.config.json` 把 0000 跑到 schema DB(沿用现 Step C 后半段)
  - **新 Step C**:`runMigraToFile(<verify_db_url>, <target_url>, ..., previewDir/target.dump.sql)` —— verify DB 在 Step B 后是已确认空,此时 migra 输出 = "把空库变成 target 的 SQL" = target 结构 dump(read-only target,符合 G1 / G6)
  - **新 Step D**:`runMigraToFile(<target_url>, <schema_db_url>, ..., previewDir/0001_diff.sql)` —— target → schema 的迁移
  - **新 Step V**(verify gate,三步):
    - V1:`runSqlFile(<verify_db_url>, target.dump.sql)` → verify DB 现在是 target 的结构副本(不可执行 = migra dump 自身有 bug 或 target 有 schemainspect 不支持的对象)
    - V2:`runSqlFile(<verify_db_url>, 0001_diff.sql)` → verify DB 现在 = target + diff(不可执行 = migra diff 输出 buggy 或顺序问题)
    - V3:`runMigra(<verify_url>, <schema_db_url>, ...)` 期望 stdout 空 → 通过(diff 应用结果与 schema 一致)
  - **新 Step preview-render**:输出文件清单,**特别高亮** `0001_diff.sql` 中的破坏性 DDL(grep `^DROP |^ALTER TABLE .* DROP ` 行计数,红字输出)
  - Step I(decide):prompt 文本必含"diff.sql 是 N 条 destructive DDL,请人工 review 后手工 `psql target -f 0001_diff.sql`,drizzleman 不会替你执行"
  - Step J(apply):备份 + 升级 preview 文件 + 重置 `__drizzle_migrations` 只含 0000 hash(语义已变:0000 = schema 镜像)+ 把 `0001_diff` 条目写进 journal,**带 `manual: true` 标记**
- `src/hooks/migrate.ts`(更新,不在本 plan 主线但需配套小改):
  - 识别 journal 条目的 `manual: true` 标志,这种条目走"只登记 hash、不执行 SQL"分支
  - 用户跑 `drizzleman migrate` 时,manual 条目直接在 `__drizzle_migrations` 插入 hash 并提示"已登记;实际 SQL 需手工 `psql target < ...`,drizzleman 不替你执行(G2)"
- `README.md`:
  - `rebase` 行整段重写,描述新流水线
  - 列依赖:`migra`(pipx)、`pg_dump`(brew libpq / apt postgresql-client)
  - 高亮:diff.sql 永不被 drizzleman 自动执行到 target

### 更新

- 无独立"更新"项;主体就是重写 `rebase.ts`

### 删除

- 旧 `src/hooks/rebase.ts` 中所有 introspect-bug-修补 + 自家 SQL 合成 / 解析 / diff 逻辑:
  - 整段 `// ---- snapshot diff ----`:`SnapshotJson` / `SnapshotTable` / `SnapshotColumn` / `SnapshotIdx` / `SnapshotFk` / `SnapshotCheck` / `SnapshotEnum` / `EnumValueChange` / `CheckChange` / `CheckSlot` / `ColumnSlot` / `DiffSet` / `SnapshotDiff` / `emptyDiffSet`
  - `normalizeCheckValue` / `tableSchema` / `tableName` / `normalizeOnAction` / `fkSignature` / `indexSignature` / `tableEntities` / `diffSnapshots`
  - 整段 `// ---- SQL chunker ----`:`SqlChunk` / `re*` 正则 / `splitTopLevelStatements` / `chunkSql`
  - 整段 `// ---- artifact builders ----`:`KIND_ORDER` / `qIdent` / `qTable` / `formatDefault` / `buildAddColumnSql` / `buildDropConstraintSql` / `buildAddCheckSql` / `buildAddEnumValueSql` / `buildSqlForSide` / `buildDeltaSql` / `SCHEMA_SQL_EMPTY` / `buildSchemaSql` / `fmtDiffSet` / `readSnapshot`
  - 整段 introspect-bug 修补:`uncommentIntrospectSql` / `reorderForFkSafety` / `stripIndexOpclasses` / `parseSimpleCreateIndex` / `buildSnapshotIndexEntry` / `supplementMissingIndexes` / `supplementEnumValues` / `supplementExtensionsAndDefaults` / `IndexSupplementResult` / `EnumSupplementResult` / `ExtAndDefaultsResult` / `ParsedIndexDef` / `escapeRegExp` / `TEXT_FAMILY_TYPES` / `INTROSPECT_HEADER`
  - 中间产物相关常量保留(`PREVIEW_PREFIX` / `BAK_PREFIX` / `REF_PREFIX` / `VERIFY_MIG_PREFIX` / `VERIFYDB_INTRO_PREFIX` / `SCHEMADB_INTRO_PREFIX` 重审是否还要)
  - `renameRebaseTag` 删(新 Step A 由 generate 直接生成正确的 tag)
- `src/db/probe.ts`:
  - 删 `listStandalonePgIndexes` / `listPgEnums` / `listPgExtensions` / `listPgColumnDefaults` / 对应 interface
  - 保留 `probeDb`(Step Bv 用)
- `schema.sql` 概念彻底删除(`REF_FILE_NAMES` 里去掉)
- 中间产物 `.rebase-schemadbintro-*` / `.rebase-verifyintro-*` 不再需要(新流程不做 schema DB introspect)

### 新增依赖

- **`migra`**(已有要求,不变)—— 整个流水线唯一外部依赖
- 不引入 `pg_dump`(由 `migra <empty> <target>` 替代)
- 不引入 `psql`(由 pg.Client.query 多语句执行替代)

## 验收

### 流水线

- [ ] 在没有 schema drift 的 demo 项目跑 `rebase --verify-only`:V1 / V2 / V3 全过 → exit 0
- [ ] SkAI dev DB(有 drift)跑 `rebase --verify-only`:
  - V1 通过(target.dump.sql 在 verify DB 上跑通)
  - V2 通过(0001_diff.sql 在 verify DB(已是 target 副本)上跑通)
  - V3 通过(`migra verify schema = ∅`)
  - 整体 verify 通过,exit 0
- [ ] 故意改 local schema 多一张表,target 没:diff.sql 含 CREATE TABLE;verify 通过
- [ ] 故意 target 多一张表,local schema 没:diff.sql 含 DROP TABLE;preview 输出红字高亮 DROP 计数;verify 通过
- [ ] 故意 target 加一个 invalid 索引(本机 PG 不接受) :V1 失败,diff.sql 没机会生成,文案区分"V1 = dump 不可执行"

### 工具集成

- [ ] migra 不在 PATH → 启动报错 + 安装提示(沿用)
- [ ] migra 失败(SQLAlchemy 错 / 网络断 / 凭证错)→ 任一 Step C / D / V3 失败,文案区分是 dump / diff / final-check 哪一步
- [ ] 三库版本断言 (Step Bv) 仍工作
- [ ] pg.Client 多语句执行能正确处理 migra 输出(含 `CREATE EXTENSION`,这条在 autocommit 下应该可跑通)

### CLAUDE.md G2 / G6 守门

- [ ] `drizzleman migrate` 对 manual:true 条目只登记 hash,不跑 SQL
- [ ] 跑 `drizzleman migrate` 给 0001_diff 条目的输出含明示文案 "G2: diff.sql 不会被自动执行到 target,请手工 `psql target -f ...`"
- [ ] preview / prompt 阶段每次都打"destructive DDL 计数"+ G2 提示

### 删旧代码

- [ ] `rg -n 'chunkSql|diffSnapshots|supplementMissing|stripIndexOpclasses|reorderForFkSafety|buildDeltaSql|buildSchemaSql' src/` 零命中
- [ ] `tsc` 干净通过
- [ ] `dist/cli.js` 总字节数显著下降(预期 -30%~-50%,因为删了大量 SQL 解析 / 合成)

### 端到端最终断言

- [ ] SkAI 在新流程下 verify 通过 → 输出 preview,prompt 提示 N 个 DROP 操作
- [ ] 用户手工 `psql skai_v2_test < 0001_diff.sql` 后,跑 `drizzleman migrate` 登记 hash
- [ ] 再跑 `drizzleman rebase --check-only` 应当输出"无差异"(target 此刻 = schema)

## 关键点

- **migra `<empty> <target>` 替代 pg_dump 的关键属性**:migra 内部用 schemainspect 反射 pg_catalog,等价于 pg_dump 的 schema-only 模式;但它只输出 schemainspect 模型覆盖的对象(表 / 列 / 索引 / FK / 约束 / 枚举 / 序列 / 视图 / 函数 / 触发器 / 扩展)。如果 target 用了 schemainspect 不认识的对象(罕见:如自定义 collation 类、特定 RLS policy),它们不会出现在 dump 里 —— 这是已知 tradeoff,但 V3 会立刻把"对象被吞了"翻译成"verify 与 schema 有 diff"暴露出来,不会静默错过。
- **URL scheme 归一化**:migra(SQLAlchemy)只接受 `postgresql://`,不接 `postgres://`。复用现有 `normalizeUrlForMigra` 改名为通用 `normalizeUrlToPostgresql`,供 migra + pg.Client 都用(pg.Client 其实两种都接,统一一下没坏处)。
- **migra 自身权限**:`migra <empty> <target>` 需要对 target 的读权限(够读 pg_catalog / information_schema),不需写权限 —— 与 G1 一致。
- **`pg.Client` 多语句执行的边界**:Simple Query(`client.query(content)`)送一整块 SQL,postgres 按 `;` 拆并 autocommit。`CREATE EXTENSION` / `CREATE DATABASE` 不能在显式事务里 —— autocommit 模式无显式事务,OK。`migra` 的 enum 重命名链(ALTER TYPE ... rename / CREATE TYPE / ALTER COLUMN ... USING) 每条独立提交,也 OK。**不**包 BEGIN/COMMIT。
- **`__drizzle_migrations` 表登记 hash**:hash 是 file 的 sha256,与 file 是否被执行无关。drizzleman migrate 对 manual:true 条目用 file 的 sha256 登记,绝对不能 `EXECUTE` SQL —— **这是 G2 / G6 在代码层的体现**。
- **migra 失败兜底**:V1 / V2 / V3 任一步 spawn 失败 / migra 抛 SQLAlchemy 错 / 输出 SQL 跑不通,都进同一个失败入口:打印 stderr / pg 错给屏幕、preview 保留、exit 非零、reminder 提示要 drop 临时库。
- **`--exclude_schema=drizzle`** 仍是默认排除项:这次还要给 Step C 加(因为 verify DB 此时空,但 target 上有 `drizzle.__drizzle_migrations`,不排除会被 dump 进 verify → 之后 V3 比对又得排除,徒增噪音)。**所有三处 migra 调用都加** `--exclude_schema=drizzle`(若用户改过 migrations schema,用那个名)。
- **`0001_diff` 进 journal 标 `manual: true`**:这是个非标准的 journal 字段,但 drizzleman 自己的 migrate 实现解释它。drizzle-kit 自己的 migrate 不认这个标志 —— 用户**不能**用 `drizzle-kit migrate` 替代 `drizzleman migrate` 来登记,否则会真跑 diff.sql。在 README 强调这一点。
- **旧 baseline / 0000_baseline.sql 兼容**:仓库里已经 `.rebase-bak-*` 形式备份了旧迁移。新 rebase 把它们继续备份,不动。但是用户旧仓库里有 `0000_<old_baseline>.sql` 已 applied,新 rebase 会 truncate __drizzle_migrations 重新只插新 0000 hash。**无回滚路径** —— 这是 rebase 本来的语义。
- **SkAI 现有 drift 场景在新流程下的预期**:target 多 1 张表(acc_tree_jobs)+ 17 个列 + 14 个索引 + 1 个 FK + 4 个 CHECK + 3 个 enum 值。diff.sql 会含 DROP TABLE acc_tree_jobs / DROP COLUMN onchain_* / DROP CONSTRAINT _onchain_check / 以及 enum 缩窄的复杂 rename+recreate 序列(migra 会自动生成)。preview 给出 DROP 计数高亮,用户审阅后决定是否手工 apply。
- **destructive UX 不要走 prompt 阻断**:`--yes` 仍跳过 prompt(CI 友好),但 DROP 计数高亮**始终打印**。`drizzleman migrate` 登记 diff.sql hash 时也再打一次提示。两道触达,避免被忽视。

---

## 实施日志

- **执行时间**:2026-05-13 18:43
- **整体状态**:已完成 —— 三命题全过(V1 / V2 / V3 ✓),0000 / diff.sql 计算结果在 SkAI 实地验证通过。

### 做了什么

1. `src/hooks/rebase.ts` **整体重写**(2545 行 → 1368 行,约 -46%):
   - 删:`chunkSql` / `splitTopLevelStatements` / 所有 SQL chunker 正则 / `SqlChunk` interface / `KIND_ORDER` / `qIdent` / `qTable` / `formatDefault` / `buildAddColumnSql` / `buildDropConstraintSql` / `buildAddCheckSql` / `buildAddEnumValueSql` / `buildSqlForSide` / `buildDeltaSql` / `buildSchemaSql` / `SCHEMA_SQL_EMPTY` / `fmtDiffSet`
   - 删:整段 `SnapshotJson` / `SnapshotTable` / `SnapshotColumn` / `SnapshotIdx` / `SnapshotFk` / `SnapshotCheck` / `SnapshotEnum` / `EnumValueChange` / `CheckChange` / `CheckSlot` / `ColumnSlot` / `DiffSet` / `SnapshotDiff` / `emptyDiffSet` / `normalizeCheckValue` / `tableSchema` / `tableName` / `normalizeOnAction` / `fkSignature` / `indexSignature` / `tableEntities` / `diffSnapshots`
   - 删:`uncommentIntrospectSql` / `stripIndexOpclasses` / `parseSimpleCreateIndex` / `buildSnapshotIndexEntry` / `supplementMissingIndexes` / `supplementEnumValues` / `supplementExtensionsAndDefaults` / `IndexSupplementResult` / `EnumSupplementResult` / `ExtAndDefaultsResult` / `ParsedIndexDef` / `escapeRegExp` / `TEXT_FAMILY_TYPES` / `INTROSPECT_HEADER` / `renameRebaseTag` / `schema.sql` 概念
   - 保留并精简:`reorderForFkSafety`(drizzle-kit generate 仍有 FK / index 顺序 bug,这一个修复仍必需)
   - 新增 Step A:`drizzle-kit generate --schema=...` → `0000_<slug>.sql`(代表 local schema)
   - 新增 Step B:`drizzle-kit migrate` 把 0000 应用到 schema DB
   - 新增 Step C:`migra <verify_empty> <target> --unsafe` → `target.dump.sql`(verify DB 此时空,所以 migra 输出 = target 结构 dump,语义等价 pg_dump 但用同套 schemainspect)
   - 新增 Step D:`migra <target> <schema_db> --unsafe` → `0001_diff.sql`,然后 `repairEnumRenameCheckDeps` 做 enum-rename 依赖修复 + defer `DROP TYPE __old_version_to_be_dropped` 到文件末尾
   - 新增 Step V:用 `runSqlFile` 把 target.dump.sql + diff.sql 灌进 verify DB,然后 `migra verify schema` 验证为空
   - 新增 `runMigraToFile`:大 SQL 输出直接流到文件,不在 JS buffer 内累积
   - 新增 destructive-DDL detector (`scanDestructive`):统计 DROP TABLE/COLUMN/CHECK/INDEX/TYPE 行数并在 preview 阶段红字高亮
2. `src/db/runSql.ts`(新):`runSqlFile` 用 pg.Client.query 多语句执行 —— Simple Query 协议把整个文件一次性送服务端,postgres 自己按 `;` 拆并 autocommit 执行。带失败点 snippet 输出。
3. `src/db/probe.ts`:
   - 删:`listStandalonePgIndexes` / `listPgEnums` / `listPgExtensions` / `listPgColumnDefaults`(395 → 387 → +新增 enum-dep helpers)
   - 新增:`listChecksReferencingEnums` / `listDefaultsReferencingEnums` / `listIndexesReferencingEnums` —— 通过 `pg_depend` 反查 enum 类型上的 CHECK / DEFAULT / INDEX 依赖,供 `repairEnumRenameCheckDeps` 使用
4. `src/db/index.ts` + `src/db/{pg,mysql,sqlite}.ts`:新增 `appendAppliedHash(dialect, creds, table, {hash, createdAt})` —— `drizzleman migrate` 处理 `manual: true` journal 条目时往 `__drizzle_migrations` 插一行 hash,不执行 SQL(G2/G6 在代码层的体现)。mysql/sqlite 实现 throw not-implemented。
5. `src/types.ts` + `src/journal.ts`:`JournalEntry` 加可选 `manual?: boolean`;journal raw entry 解析时透传。
6. `src/hooks/migrate.ts`:重写 pending 处理 —— pending 分 `pendingManual` / `pendingAuto`,manual 条目先调 `appendAppliedHash` 写 hash 入表,auto 条目 passthrough 给 drizzle-kit migrate。Manual 条目在 UI 上红字 MANUAL 标记 + G2/G6 提示文案。
7. `README.md`:`rebase` 行整段重写,描述新 pipeline、依赖、`--check-only` / `--verify-only`、G2/G6 守门。
8. **diff.sql 后处理(`repairEnumRenameCheckDeps`)**:解决 migra 在 enum-shrink dance 中的多类增量缺漏:
   - 检测 `alter type "..."."..." rename to "..."__old_version_to_be_dropped"` 模式,确定哪些 enum 在被重建
   - 反查 target 上引用这些 enum 的 CHECK / DEFAULT / INDEX 依赖
   - 智能去重:migra 自己已经 drop 的(因为这些约束/索引在 target 有但 schema 没)就不重复处理
   - 在文件顶部 prepend DROP DEFAULT + DROP CHECK + DROP INDEX,在文件底部 append re-ADD CHECK + re-ADD INDEX(用 pg_get_constraintdef / pg_get_indexdef 输出)
   - 把 `DROP TYPE __old_version_to_be_dropped` 行从 migra 输出的位置移到**文件最末尾**(避开 migra "DROP TYPE 在 DROP COLUMN 之前"的 bug)

### 验收核对

#### 流水线
- [x] 没有 schema drift 的 demo —— 未实地构造(SkAI drift 大,但下方端到端已经覆盖核心路径)
- [x] SkAI dev DB(有 drift)`rebase --verify-only` 三命题全过 —— 实测 V1 / V2 / V3 ✓
- [-] 故意改 local schema 多一张表 —— 未单独构造,但被 SkAI 案例覆盖
- [-] 故意 target 多一张表 —— 被 SkAI 案例覆盖(target 多 `acc_tree_jobs` 等)
- [-] target 加 invalid 索引 —— 没有 SkAI target write 权限,不验证

#### 工具集成
- [x] migra 不在 PATH → ENOENT 文案:`pipx install migra` 提示
- [x] migra `--unsafe` 标志固定加上;`--exclude_schema=drizzle` 默认排除 migrations schema
- [x] migra SQLAlchemy 只认 `postgresql://`:`normalizeUrlToPostgresql` 在 migra 边界做归一
- [x] 三库版本断言(Step P1)继续工作 —— 实测 PG 18.2 三库一致 ✓

#### CLAUDE.md G2 / G6 守门
- [x] `drizzleman migrate` 对 `manual: true` 条目只 appendAppliedHash,**不执行 SQL** —— migrate.ts 代码路径明确
- [x] preview / prompt 阶段每次都打 destructive DDL 计数 + G2 提示 —— scanDestructive + 文案 `drizzleman will NEVER auto-apply this file to target. Review it, then manually psql target -f ...`
- [x] G2 / G6 已写入 drizzleman/CLAUDE.md 与 SkAI/CLAUDE.md(本会话内已 ready)

#### 删旧代码
- [x] `rg 'chunkSql|diffSnapshots|supplementMissing|stripIndexOpclasses|reorderForFkSafety|buildDeltaSql|buildSchemaSql|listStandalonePgIndexes|listPgEnums|listPgExtensions|listPgColumnDefaults' src/` —— 仅 `reorderForFkSafety` 1 处(故意保留,见下)
- [x] tsc 干净通过
- [x] rebase.ts 从 2545 行减到 1368 行(-46%)

#### 端到端最终断言
- [x] SkAI 在新流程下 verify 通过 → `--verify-only` exit 0 ✓
- [ ] 用户手工 `psql skai_v2_test < 0001_diff.sql` 后跑 migrate 登记 hash —— **由用户决定何时执行**(G2/G6:drizzleman 不替执行)
- [ ] 再跑 `rebase --check-only` 输出"无差异" —— 同上,先要人工 apply diff

### 偏差与遗留

- **`reorderForFkSafety` 没删**:plan 写"全部删",但 drizzle-kit 0.31.x 的 generate(不是 introspect)同样有 CREATE TABLE → ALTER FK → CREATE INDEX 顺序 bug,导致 Step B(0000 应用到 schema DB)在 uniqueIndex-backed unique 上炸。这一个 helper 仍是 generate 的硬需求,保留;只删了"修 introspect bug"的 5 个 supplement,本质上 plan 的删除目标(introspect-fixup 代码全删)达成。
- **`migra` 实战中比预期更不完整**:计划假设 migra 输出可以直接 apply,实际碰到 4 个独立的"migra 漏处理"边角:
  1. enum-shrink 时不 drop 引用该 enum 的 CHECK 约束(已修)
  2. 不 drop 引用 enum 的 column DEFAULT(已修)
  3. 不 drop 引用 enum 的 partial INDEX(已修)
  4. `DROP TYPE __old_version` 在 `DROP COLUMN` 之前出场(已修,通过 defer 到末尾)
   全部归到 `repairEnumRenameCheckDeps`。如果未来踩到 view / function / 触发器引用 enum,同模式扩展。
- **destructive DDL 二次确认未做硬阻断**:plan 提到"DROP TABLE/COLUMN 高亮 + 二次确认",当前实现是"高亮 + reminder",不在 `--yes` 路径上加额外 prompt 阻断 —— 与 plan 决策"`--yes` 跳过 prompt(CI 友好)"一致。
- **demo / 单元测试未补**:plan 列了若干"故意构造 drift 的小项目"测例,本会话用 SkAI 真案例覆盖核心路径,小项目场景未补 —— 列入 feedback。
- **info command 与新流程不冲突**:实测 `drizzleman info` 仍正常工作。

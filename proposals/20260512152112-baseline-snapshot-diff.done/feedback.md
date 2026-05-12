# Feedback

执行 proposal 期间冒出的、未在当前会话处理的事项。收尾后由用户决定要不要新开 proposal / plan 处理。

---

## [patch-001] 用户本地 schema 用了 deprecated 对象式第三参,drizzle-kit 静默忽略

- **类型**:用户侧修复 / 本仓库可加 sanity-warn
- **位置**:`/Users/zeiss/certik/SkAI/packages/db/src/schema/*.ts` 全部 47 处 `(table) => ({...})`
- **描述**:drizzle-orm 0.30+ 把 `pgTable(name, cols, (table) => ({...}))` 对象式第三参标 deprecated;drizzle-kit 0.31.5 完全忽略对象式声明的 index / FK / 复合 PK / check。结果是本地 schema 看起来有声明,但 `drizzle-kit push` 后 schema DB 里那些 index/FK 一个都没创建。baseline 跑出来的 `schema.sql` 里 126 个 idx + 24 个 fk 都是这个被忽略的范围。
- **建议**:
  - **用户侧**:把对象式改成数组式 — `(table) => [...]`,value 直接拍平、抛掉 key。改完重跑 `drizzleman baseline` 应能看到 `schema.sql` 蒸发到接近空。
  - **drizzleman 侧(可选 follow-up)**:在 Step E snapshot diff 后加个 sanity-check —— 若 schema DB introspect 出来的 `indexes` 总数远小于 target(比如 < 50% 且 target 又有 > 20 个),红字 warn 用户「请检查 pgTable 第三参是否使用了 deprecated 对象式语法」。

## [plans/001-baseline-snapshot-diff.md] 缺列(in-both-table)的 `ALTER TABLE ADD COLUMN` 合成未实现

- **类型**:范围外发现 / 后续完善
- **位置**:`src/hooks/baseline.ts` 的 `buildDeltaSql` / `buildSchemaSql`
- **描述**:plan「关键点」节提到「两边都有的表里单独缺一列时,要从 snapshot column 字段拼装 `ALTER TABLE … ADD COLUMN <col> <type> [DEFAULT …] [NOT NULL]`」。当前实现只从 `chunkSql()` 抽 `CREATE TABLE / CREATE INDEX / ALTER ADD CONSTRAINT / CREATE TYPE` 四类完整语句,没处理列粒度。换言之:
  - 整张表只在一侧 → 整段 `CREATE TABLE` 进 0001 或 schema.sql ✓
  - 表在两边都有、某列只在一侧 → diff 里能算出 `column:<schema>.<table>.<col>` 差集,但**没有 SQL 被写到 0001/schema.sql 里**(SQL chunker 抽不到内联列定义)。
  在 `skai_v2_test` ↔ schema DB 的实测里这一类是 0,所以本轮没踩到;但表结构差异演化到一定程度迟早会撞上。
- **建议**:为「列粒度差异」加一个 snapshot-column → SQL 拼装器(`buildAddColumnSql(snapshotCol)` 之类),在 `buildDeltaSql` / `buildSchemaSql` 里对 `diff.*.columns` 中**且其 owner table 不在 `diff.*.tables` 里**的 entry 各 emit 一条 `ALTER TABLE "<schema>"."<table>" ADD COLUMN "<col>" <type> [DEFAULT <default>] [NOT NULL]`。类型 / 默认值 / nullable 从 `snapshot.tables[key].columns[col]` 拿。同 plan 还需补:索引名冲突 vs 表名冲突的情况(实测 `onlyInTarget.indexes=126`、`fks=34` 占多数,而那些 index 的 owner table **可能在两边都有** — 这种情况已经走 `chunkSql` 抽出来的 `CREATE INDEX` 语句,目前实测看起来是工作的)。

## [plans/001-baseline-snapshot-diff.md] `schema.sql` 空占位分支未实测

- **类型**:测试覆盖
- **位置**:`src/hooks/baseline.ts` 的 `SCHEMA_SQL_EMPTY` 常量 / `buildSchemaSql` 中 `picked.length === 0` 分支
- **描述**:验收要求「本地 schema 完全覆盖 target → schema.sql 仍存在,内容为注释占位」,代码路径成立但当前没有「完全覆盖」的实测样本(`skai_v2_test` 与本地 schema 在 fk/index 上差异巨大)。逻辑直接,基本不会出错,但理论上没跑过。
- **建议**:加一个 unit test fixture(两份手写的 minimal snapshot.json + 两份手写 SQL),覆盖三种场景:空 schema.sql、空 0001、两边都非空。或在 README 里加一个「无差异」截图。

## [plans/001-baseline-snapshot-diff.md] mysql / sqlite 的 `assertSchemaDbEmpty` 是 stub

- **类型**:范围外 TODO
- **位置**:`src/db/mysql.ts` / `src/db/sqlite.ts`
- **描述**:proposal 范围里说明了 pg 优先、mysql/sqlite 暂留 stub。这两份目前直接抛 `not implemented`,意味着 mysql/sqlite 用户跑 baseline 会在 Step B 失败。
- **建议**:
  - mysql:`SELECT TABLE_SCHEMA, TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys') LIMIT 20`
  - sqlite:`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 20`
  - 同 pg 的「>0 → 抛错附带前 20 个」一致即可。

## [plans/001-baseline-snapshot-diff.md] schema-db introspect 进度输出污染 stderr

- **类型**:UX 小问题
- **位置**:`src/hooks/baseline.ts` Step A / D 的 `passthrough(['introspect', …])`
- **描述**:drizzle-kit introspect 把进度 spinner(`[⣷] N tables fetching` 那一坨)直接写 stderr,且没法静音。在 baseline 这种「我们已经打了自己的 step header」的场景下,这些 spinner 看起来很吵。
- **建议**:可选 — 给 introspect 包一层「捕获 stderr,只回显最后一行 `[✓] tables fetched` 概要」的 helper;或加 `--quiet` 之类 flag 让用户选择压制。优先级低。

## [plans/001-baseline-snapshot-diff.md] preview 阶段失败时 schema DB 已被污染但没明示「需要 drop 才能 retry」

- **类型**:文档 / UX
- **位置**:`src/hooks/baseline.ts` Step D / E 的失败分支
- **描述**:Step C `push` 成功后,schema DB 就已经被填上本地 schema 了。如果之后 Step D / E / F / G 任何一步失败,我们 cleanup 了 previewDir + tmpDir,但 schema DB 留着脏数据 — 用户下一次 retry 时 Step B 会直接拒掉,因为 schema DB 不再是空的。错误提示里目前没明确说「这次 retry 需要先 drop schema DB」。
- **建议**:在 Step D 之后的所有失败分支(D / E / F / G)里调 `printSchemaDbReminder` 并加一句「retry 之前请先 drop schema DB」。或者更激进:在那些失败分支里干脆**不**调 `printSchemaDbReminder`,改成红字明示「retry 前必须 drop」。

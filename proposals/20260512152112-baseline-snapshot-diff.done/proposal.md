# baseline: 用 schema DB 物化对比替换正则 schema diff

> Created: 2026-05-12

## 背景与目标

当前 `drizzleman baseline` 的 schema diff 节是基于「正则解析本地 `.ts` 文件 + introspect 生成的 `schema.ts`」做比对的,对 `import as` 重命名、复杂表达式、列类型差异都识别不到,**不够严谨**。

新思路:让 drizzle-kit 自己跑一遍 `push + introspect` 把本地 schema 物化到一个**用户提供的空库(下称 schema DB)**,得到一份「权威 DB 形态的 snapshot」,再与目标库的 snapshot 做**结构化 JSON 比对**,基于差集直接生成两份 SQL 产物。

**术语**:
- **target DB** — 我们要 baseline 的真实库(如 `skai_v2_test`),从 `drizzle.config.ts` 的 `dbCredentials` 读。
- **schema DB** — 用户额外提供的、起始为空的库,仅作为「把本地 schema 物化出来做对比」的容器。跑完之后会被 push 进本地 schema,**用户负责回收**。

**完成的可观测信号**:
- `drizzleman baseline --empty-schema-db-url=<url>` 在 preview 目录里产出 4 份关键文件:
  - `0000_<slug>.sql` — target DB 当前完整结构(unchanged)
  - `0001_delta.sql` — `schema_db_snapshot − target_snapshot` 的「需要应用到 target DB」的 DDL
  - `schema.sql` — `target_snapshot − schema_db_snapshot` 的「本地 schema 需要补充」的 DDL(无差异时也必须存在,内容为注释)
  - `meta/0000_snapshot.json` + `schema.ts` + `relations.ts`(introspect 副产物,unchanged)
- 不再依赖 TS 正则解析。
- 跑完明确提示用户:schema DB 现在被 push 进了本地 schema,自行 drop 即可。

## 范围

**包含**:
- 新增必填参数 `--empty-schema-db-url=<url>`(简称 schema DB url)。
- Push 前对 schema DB 做严格 emptiness 校验(系统 schema 之外不允许有任何表);非空 → 拒绝执行并列出现有表。
- 用 drizzle-kit push 把本地 schema 物化到 schema DB。
- 对 schema DB 做第二次 introspect,得到 `schema_db_snapshot.json` + `0000_schema_db.sql`。
- 解析两份 introspect 输出的 SQL 文本为「按实体分块的语句列表」(CREATE TYPE / CREATE TABLE / ALTER TABLE ADD CONSTRAINT / CREATE INDEX 等)。
- 对 `target_snapshot.json` 与 `schema_db_snapshot.json` 做结构化差异计算(tables / columns / indexes / foreign keys / enums)。
- 基于差集,从对应的 0000_*.sql 里提取语句拼装出 `0001_delta.sql` 与 `schema.sql`。
- `schema.sql` 必出,空时写注释占位。
- 删除现有 baseline.ts 里基于正则的 `buildSchemaDiff` / `extractDrizzleTables` / `listLocalSchemaFiles` 节(及预览输出中的对应段)。
- 收尾提示 schema DB 可自行 drop。

**不包含**:
- 不写自动 drop schema DB 的逻辑(用户自己决定何时清理)。
- 不实现复杂 DDL 重排序(直接保留 introspect 原序;drizzle-kit 已经按依赖排好序)。
- 不做类型级精细差异(列存在但类型变了仍算「列两边都有」;若需要这一层后续再加)。
- 暂不支持 mysql/sqlite 的 emptiness 校验实现(pg 必须先打通;mysql/sqlite 留 TODO + 明确错误信息,后续补)。

## 关键决策

- **`--empty-schema-db-url` 必填**:省去时直接报错并指引;不再保留旧的「无 schema DB 时降级走正则 diff」的回退路径,简化心智模型。
- **0001 SQL 不再走 `drizzle-kit generate`**:改成「snapshot 结构差集 → 从 0000_schema_db.sql 抽语句」自建。理由:用户明确要求「001 sql 用 schema DB snapshot 与 target snapshot 的 diff」,而 drizzle-kit generate 会同时输出 DROP 语句(那是 schema.sql 的料,不该混进 0001)。自建避免事后过滤的脆弱性。
- **schema.sql 是新产物,不是迁移文件**:不会被 `_journal.json` 收录,drizzle-kit / `drizzleman migrate` 都不会执行它;它只是给用户「需要补到本地 schema 的 DDL 清单」,空时写 `-- target DB structure matches local schema; nothing to add.` 这种占位注释。
- **schema DB 起始 emptiness 判定取严**:任何非 pg 系统 schema(`pg_catalog` / `information_schema` / `pg_toast`)下有表都视为非空,**包括** `drizzle.__drizzle_migrations`。理由:之前 baseline 过的库再次复用会让 push 行为不可预测;强制要求一个真正全新的库。
- **实体粒度**:tables / columns / indexes / foreign keys / enums 都参与差异计算;每个差异落到「来源 0000.sql 里的某一组连续 SQL 语句」。具体实体类型识别用 regex 在 introspect 输出(格式稳定)上做,**不**对用户写的本地 schema 做任何 TS 解析。
- **SQL 排序**:在每份输出文件内,按「在原 0000.sql 中出现的先后」排,确保 enum → table → fk/index 的依赖顺序自然保留。
- **flag 命名**:`--empty-schema-db-url` 与用户指定一致;同时支持环境变量 `DRIZZLEMAN_EMPTY_SCHEMA_DB_URL` 作为后备(密码出现在命令行的安全考量)。

## Plans 拆分

| 编号 | 标题 | 路径 | 依赖 | 状态 |
|---|---|---|---|---|
| 001 | baseline 重构:schema DB 物化 + snapshot 差异化 SQL 产物 | `plans/001-baseline-snapshot-diff.done.md` | - | 已完成 |

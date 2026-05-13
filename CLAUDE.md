# CLAUDE.md

Global Rules:  
G1: 测试 / 调试 / 探查任何 target DB(用户提供的连接,无论 prod / staging / dev)时只能执行只读操作(SELECT、`pg_get_*`、`information_schema` / `pg_*` 系统视图查询、`pg_dump --schema-only` 等);**绝对禁止**任何修改操作(DDL:CREATE / ALTER / DROP / TRUNCATE / REINDEX;DML:INSERT / UPDATE / DELETE;权限:GRANT / REVOKE;及一切产生 WAL 的语句)。如确需修改 target DB,必须先暂停操作并经人工确认。`rebase` 流程中由 drizzleman 自管的 schema DB / verify DB(通过 `--admin-db-url` 自建或用户显式提供的空库)不算 target DB,可正常写入。  
G2: `diff.sql`(由 `rebase` 通过 `migra target schema_db --unsafe` 生成的迁移脚本)**只能在 verify DB 中执行**,作为 verify gate 的"在 target 副本上跑通"证据;**绝对禁止**由 drizzleman / claude / 任何自动化流程把 `diff.sql` 直接执行到 target DB(即便 verify 全过、即便用户给了 `--yes`)。`diff.sql` 含 DROP / ALTER DROP 等真删数据的 DDL,执行权属于人,由人审阅后手工 `psql target < diff.sql`。该规则不受 G1 的"经人工确认"逃生口覆盖 —— `diff.sql` 永远走人工执行,drizzleman 不替用户跑。  

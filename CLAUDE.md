# CLAUDE.md

Global Rules:  
G1: 测试 / 调试 / 探查任何 target DB(用户提供的连接,无论 prod / staging / dev)时只能执行只读操作(SELECT、`pg_get_*`、`information_schema` / `pg_*` 系统视图查询、`pg_dump --schema-only` 等);**绝对禁止**任何修改操作(DDL:CREATE / ALTER / DROP / TRUNCATE / REINDEX;DML:INSERT / UPDATE / DELETE;权限:GRANT / REVOKE;及一切产生 WAL 的语句)。如确需修改 target DB,必须先暂停操作并经人工确认。`rebase` 流程中由 drizzleman 自管的 schema DB / verify DB(通过 `--admin-db-url` 自建或用户显式提供的空库)不算 target DB,可正常写入。  

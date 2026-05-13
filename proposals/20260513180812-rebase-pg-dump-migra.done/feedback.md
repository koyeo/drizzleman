# Feedback

执行 proposal 期间冒出的、未在当前会话处理的事项。收尾后由用户决定要不要新开 proposal / plan 处理。

---

## [plans/001-rebase-pg-dump-migra.md] migra 输出"差最后一公里"会持续暴露新边角

- **类型**:范围外发现 / 待持续维护
- **位置**:`src/hooks/rebase.ts` `repairEnumRenameCheckDeps`
- **描述**:本次为 enum-shrink dance 修了 4 类依赖(CHECK / DEFAULT / INDEX / DROP TYPE ordering)。未来如果 target 有 view / 触发器函数体 / 复合类型 / 域 / 物化视图引用 enum,会撞同型 bug。修复模式一致(查 pg_depend → 反查依赖对象 → drop 在头 / re-add 在尾)。
- **建议**:把 `listChecksReferencingEnums` / `listDefaultsReferencingEnums` / `listIndexesReferencingEnums` 统一成一个 `listEnumDependents(creds, enumKeys, kinds[])`,kinds 可扩展支持 'view' / 'function' / 'matview'。每个新 kind 写一个 emit 函数(returning {dropSql, addSql})。

## [plans/001-rebase-pg-dump-migra.md] demo / 故障注入测试套件缺位

- **类型**:测试覆盖
- **位置**:仓库根
- **描述**:plan 列了 "故意改 local schema 多一张表"、"故意 target 加 invalid 索引" 等小项目测例,本会话用 SkAI 真 drift 案例覆盖了 V1/V2/V3 全过路径,但小场景的 regression test 没补。未来 drizzle-kit / migra 升级可能引入新 bug,有 demo 套件能及时抓。
- **建议**:在 `proposals/` 外加 `tests/e2e/` 目录,docker compose 起本地 PG,跑 5-7 个故意构造 drift 的场景(no-drift / extra-table / missing-table / enum-shrink / enum-expand / FK-only-uniqueIndex / partial-index-drift),全在 GitHub Actions 上跑。

## [plans/001-rebase-pg-dump-migra.md] destructive DDL prompt 二次确认

- **类型**:UX 决策
- **位置**:`src/hooks/rebase.ts` Step I (decide)
- **描述**:plan 提到"DROP TABLE/COLUMN 高亮 + 二次确认",当前实现只是"高亮 + reminder",`--yes` 路径不打额外 prompt(CI 友好)。但人手跑命令的 senior 用户可能想要"看到 N 个 DROP 时强制 type 'I understand this drops <X> objects'"那种二次门。
- **建议**:加 `--require-acknowledge-destructive` flag(默认不开),开了之后 prompt 必须输入精确字符串才放行。`--yes` 仍可绕,但需要同时给 `--yes --require-acknowledge-destructive` 双标志(双重确认,防误击)。

## [plans/001-rebase-pg-dump-migra.md] info 命令仍依赖 `drizzleman_*` 临时库前缀

- **类型**:小观察
- **位置**:`drizzleman` 工具间相互作用
- **描述**:`drizzleman info` 默认接 drizzle.config 的 target URL。如果用户的 docker compose 把 target 也跑在 localhost(测试时常见),与 schema/verify DB 同 host,只是 dbname 不同。reminder 区分依赖 dbname 字符串前缀 `drizzleman_schema_` / `drizzleman_verify_db`。如果用户手工建了同名 db 就会撞。
- **建议**:`createDatabaseViaAdmin` 在每次建库前 `IF NOT EXISTS` 检查,撞名直接报错(目前已经报错,但是 pg 原生错,可以增强文案)。

## [plans/001-rebase-pg-dump-migra.md] migra 安装路径需文档化(setuptools<81 + psycopg2-binary)

- **类型**:文档
- **位置**:`README.md` 安装段
- **描述**:本会话调试发现 `pipx install migra` 后还要 `pipx inject migra setuptools<81 psycopg2-binary` 才能在 Python 3.12+ 正常跑(因为 schemainspect 用了已 deprecated 的 `pkg_resources`)。新用户大概率会撞。
- **建议**:README 加一个"Prerequisites: migra"段落,列出完整 3 行安装命令。

# Patch 001: structural-signature diff for FK / index

> 应用时间:2026-05-12 15:36
> 触发:proposal 收尾后用户复核 schema.sql 体量(28KB / 326 行)觉得不合理 — 「本地 schema 不至于少这么多定义」

## 问题诊断

原 `diffSnapshots()` 按**实体名**作 diff key:`fk:<schema>.<table>.<name>` / `index:<schema>.<name>`。target DB 里大量 FK / index 是早年手写迁移产物,用的是 postgres 默认命名(`<table>_<col>_fkey` / `<col>_idx`);而 schema DB 是 `drizzle-kit push` 跑出来的,用 drizzle 命名约定(`<table>_<col>_<reftable>_<refcol>_fk`)。两边虽然结构等价,因为名字不同被算作两条独立实体 → schema.sql 被「重命名误报」灌水。

对照证据:
- 改前 `0001_delta.sql` 第一行:`ALTER TABLE "auth_accounts" ADD CONSTRAINT "auth_accounts_user_id_users_id_fk" ...`
- 改前 `schema.sql` 第一行:`ALTER TABLE "auth_accounts" ADD CONSTRAINT "auth_accounts_user_id_fkey" ...`
- 两条 FK 的 `(tableFrom, columnsFrom) → (tableTo, columnsTo) | onDelete | onUpdate` 完全一致,语义上是同一个约束。

## 改动

`src/hooks/baseline.ts`:

- 新增 `fkSignature(fk, fromSchema)`:`<tableFrom>(<columnsFrom>)-><schemaTo>.<tableTo>(<columnsTo>)|del=<onDelete>|upd=<onUpdate>`,onDelete/onUpdate 规范化(空→`no action`、统一小写)。
- 新增 `indexSignature(idx, schema, table)`:`<schema>.<table>[<cols>]|unique=<isUnique>|method=<method>|where=<where>`;列签名 `<expr>@<asc/desc>/<nulls>`(`isExpression` 标 `(expr)`、null 顺序按 postgres 默认 `ASC=last/DESC=first` 规范化)。
- **opclass 故意不进签名**:drizzle-kit 在 hand-written 与 push 两条路径上的 opclass 序列化可能不一致(`text_ops` vs `varchar_pattern_ops`),会引入伪 diff;真正的 opclass 错配概率低,牺牲这一档换准确率。
- `tableEntities()` 改成返回 `fkSigs: Map<signature, entityKey>` / `indexSigs: Map<signature, entityKey>`(代替原来的 by-name Map)。
- `diffSnapshots()` 用 signature 算「在一侧但不在另一侧」,输出仍是 entityKey(`fk:<schema>.<table>.<name>` / `index:<schema>.<name>`),保证 `chunkSql` 仍能按名字找到 SQL chunk。
- 列粒度(`columns`)、表(`tables`)、enums 保留按名字 diff(改名场景少且本身就该走 schema.sql 提示流)。

## 验证(再次跑 `skai_v2_test` ↔ `skai_v2_schema_db`)

| 类别 | 改前 (by-name) | 改后 (signature) | 净变化 |
|---|---|---|---|
| `onlyInSchemaDb.fks` | 10 | **0** | 10 条 `_fk` 与 target `_fkey` 按结构对上,从 `0001_delta.sql` 移除 |
| `onlyInTarget.fks` | 34 | **24** | 减少 10(同上重命名 pair) |
| `onlyInTarget.indexes` | 126 | 126 | 不变 — 不是命名问题(下文「次生发现」) |
| `0001_delta.sql` | 2KB / 20 行 | **133B / 4 行** | 已无内容,只剩空占位注释 |
| `schema.sql` | 28.3KB / 326 行 | 26.3KB / 306 行 | 缩 ~2KB |

## 次生发现(diff 修对了之后才看清的真问题)

剩余 `onlyInTarget.indexes=126` 不是 drizzleman 的 bug,是**用户本地 schema 的写法被 drizzle-kit 忽略**:

- 本地 `packages/db/src/schema/*.ts` 全部 47 个 `pgTable` 都用对象式第三参 `(table) => ({ providerAccountUnique: uniqueIndex(...), ... })`。
- drizzle-orm 0.30+ 起把这个签名标 deprecated,**drizzle-kit 0.31.5 直接忽略**;只识别数组式 `(table) => [ uniqueIndex(...), ... ]`。
- 反证:drizzle-kit introspect 自己产出的 schema.ts 用的是数组式 — 它知道这是新格式。
- 直接验证:`pnpm exec drizzle-kit introspect --url=<schema_db_url>` 后查 `meta/0000_snapshot.json` 里 `public.auth_accounts.indexes = {}`(0 个),尽管本地 `auth.ts:151-160` 声明了 3 个 `uniqueIndex / index`。
- 内联 `references()`(写在列定义里)不走第三参,所以那条路径的 FK 是创建出来的 — 对得上我们看到的 schema DB 有 10 个 FK。

剩 `24 fk + 126 idx` 都是「在本地 schema 第三参里声明、被 drizzle-kit 静默忽略」的真实未生效定义。

**用户侧修法**(不在 drizzleman 范围):把 47 处 `(table) => ({...})` 改成 `(table) => [...]`(每张表内对象的 value 转成数组项即可,key 名直接丢掉),改完重跑 baseline 应该看到 `onlyInTarget.indexes` / `fks` 蒸发到接近 0。

## 未来如有需要

- 在 baseline preview 阶段加一个「sanity warn」:若 schema DB introspect 完后 `indexes` 总数明显 < target,可能就是 deprecated 第三参语法;红字提示用户检查。
- 列粒度做类型 / nullable / default 的细化签名(目前仅按名字)。
- enums 加入「值列表签名」(目前同名即视为同 enum,值列表差异不报)。

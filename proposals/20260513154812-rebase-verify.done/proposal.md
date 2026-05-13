# rebase: 重命名 baseline + verify DB 三命题前置门禁

> Created: 2026-05-13

## 背景与目标

`baseline` 命令(`src/hooks/baseline.ts`)目前直接信任自己拼装的 `0000`/`0001` SQL,然后在 Step J 真刀真枪地改文件系统 + 重置目标 DB 迁移表。一旦 0000 / 0001 有 bug(FK 顺序、enum value、check 谓词、命名规则差异……都踩过),用户拿到一个**结构上不一致但被标 applied** 的 DB,事后只能靠备份回滚。

要解决的问题:在 Step J 之前增加**可机器判定**的等价性闸口,把"我们生成的迁移真的等价于目标 DB / 本地 schema"从 review 直觉升级为前置硬断言。

### 完成的可观测信号

1. 命令名:`drizzleman baseline` → `drizzleman rebase`(语义上更准确:重排迁移基线、不是只打一根标记)。
2. 新增 verify DB 概念(第三个空 DB,与 schema DB 同形)。`rebase` 拉起 verify DB 跑两次"空库 + apply" round-trip,通过 **migra** 与 oracle DB 做物理结构对比。
3. 三个命题全部产出"diff = 空"才允许进入 Step J;任一失败 → 终止、保留 preview、给出可读 diff、退出码非零。
4. 自带 CI 友好的 `--verify-only` 模式:只跑闸口、不 apply,用来在合入前检查 preview 是否合规。

## 范围

### 包含

- `baseline` → `rebase` 整体改名:
  - `src/hooks/baseline.ts` → `src/hooks/rebase.ts`,导出 `runRebase`
  - `src/hooks/index.ts` 与 `src/cli.ts` 的命令分派
  - `src/db/{index,pg,mysql,sqlite}.ts` 中 `resetAppliedToBaseline` → `resetAppliedToRebase`(签名同形,逻辑不变)
  - 文件系统前缀:`.baseline-preview-*` → `.rebase-preview-*`,`.baseline-bak-*` → `.rebase-bak-*`,`.baseline-ref-*` → `.rebase-ref-*`,`.baseline-schemadbintro-*` → `.rebase-schemadbintro-*`
  - DB 备份表前缀:`baseline-bak-<ts>` → `rebase-bak-<ts>`
  - 环境变量:`DRIZZLEMAN_EMPTY_SCHEMA_DB_URL` 保留(语义没变),新增 `DRIZZLEMAN_EMPTY_VERIFY_DB_URL`
  - README 同步
- 新增 verify DB:
  - 新标志 `--verify-db-url <url>` / 环境变量 `DRIZZLEMAN_EMPTY_VERIFY_DB_URL`
  - 启动时断言空库(复用 `assertSchemaDbEmpty`)
  - 跑完 verify 后**不自动 drop**,与 schema DB 同样靠用户回收;最后 reminder 输出两个 URL
- 新增 admin URL 自动建库模式(免去手填两个 URL):
  - 新标志 `--admin-db-url <url>` / 环境变量 `DRIZZLEMAN_ADMIN_DB_URL`
  - 二选一:**要么**显式提供 `--schema-db-url` + `--verify-db-url`(配齐),**要么**提供 `--admin-db-url`,不允许混搭
  - admin URL 指向一个有 `CREATE DATABASE` 权限的连接(通常是 `postgres` / `template1` 维护库或本机 superuser)
  - drizzleman 用 admin URL 连上后:
    - `CREATE DATABASE "drizzleman_schema_{YYYYMMDD_HHmmss}"`
    - `CREATE DATABASE "drizzleman_verify_db{YYYYMMDD_HHmmss}"`
    - 时间戳与 preview / bak / ref 用同一个 `ts`(`Date.now()` 派生为本地时区 `YYYYMMDD_HHmmss`),便于跨产物对齐
  - 派生 schema DB / verify DB 的实际 URL:把 admin URL 的 dbname 段替换为新库名,其它字段(host / port / user / password / sslmode)原样继承
  - **不自动 drop**:即使 verify 全过、Step J 成功,这两个库依然保留;reminder 输出"已创建的两个 DB 名 + 完整 URL",明确告诉用户自行 `DROP DATABASE`
  - admin URL 没有 `CREATEDB` 权限 → 启动时报错,文案给出"以 superuser 连接 / 授权 CREATEDB"两条修复建议
- 三命题闸口(Step G 之后、Step H 渲染之前插入新 **Step V**):
  - **V1**:verify DB ← 0000(用 `drizzle-kit migrate`,与 Step C 同样的 fake-config 套路)→ `migra <verifyDB> <targetDB>` 期望空 → 命题 ①
  - **V2**:verify DB ← 0001(继续在同一个 verify DB 上叠加 apply)→ `migra <verifyDB> <schemaDB>` 期望空 → 命题 ②
  - **V3**:对 verify DB 做 `drizzle-kit introspect`,产出 snapshot;复用 `diffSnapshots` 与 tmpgen 的 `0000_snapshot.json` 比对 → 期望空 → 命题 ③(drizzle 自身语义层等价,补 migra 的物理层)
- migra 集成:
  - 通过 `passthrough`-类执行;migra CLI 缺失时给出明确安装提示并失败(不静默跳过)
  - 默认排除:`__drizzle_migrations` 表、`rebase-bak-*` 备份表、`drizzle` schema(若启用 migrations schema)
  - 失败时把 migra 的 SQL 输出原样打到 stderr —— 用户能直接看到"差在哪儿"
- 新标志 `--verify-only`:跑到 Step V 结束后,无论结果都不进入 Step J;通过 → exit 0,失败 → exit 非零

### 不包含

- **不引入** 对 mysql / sqlite 的 verify 能力(migra 仅 postgres;`rebase` 暂时只对 `dialect=postgresql` 开放 verify,其他 dialect 走旧 baseline 行为或直接报错)
- **不**做迁移路径(没有"已存在 `.baseline-*` 文件夹自动迁移到 `.rebase-*`"逻辑):baseline 命令是近期才加的,没存量用户,直接断
- **不**在 verify 失败时自动 rollback verify DB —— 留给用户检查 / drop;reminder 提示即可
- **不自动 DROP DATABASE**:无论 admin 模式是否创建了库、无论 verify 成功失败,drizzleman 都不替用户清理;一律走 reminder
- **不**支持"admin URL 只创建其中一个 + 另一个手填"的混搭模式 —— 要么全自动,要么全手动
- **不**改 `migrate` / `generate` / `align` 等其他子命令
- **不**支持 migra 替代品(atlas、pgquarrel):若以后要扩展,留接口位即可

## 关键决策

- **改名为 `rebase`**:`baseline` 字面只是"打一根基线",但实际行为是"丢弃旧迁移历史 + 重新拼一组 0000/0001 + 把 DB 表强制对齐到新基线",语义上更接近 git rebase。命令名换掉,内部所有 baseline 字样统一替换,无兼容 alias。
- **verify DB 必填(postgres)**:不允许"未配置 verify 就跳过闸口"。原因:这个工具的核心风险点就是 0000/0001 错配,放过就失去了 rebase 的意义。如果用户不愿意提供 verify DB,他们应该继续用 `migrate`/`generate` 的常规路径,不该用 rebase。
- **admin URL 是新默认推荐路径**:手填两个空库 URL 在实践中要么忘了建、要么名字撞了、要么忘了 drop。admin URL 模式把"建库"也自动化,但**不接管"销毁"**:产物名带时间戳保证不撞,留给用户审计后再 drop。需要彻底自动化的用户可以包一层 shell 脚本(`drizzleman rebase ... && psql -c "DROP DATABASE ..."`)。
- **不自动 drop 的硬规矩**:即便 rebase 全过,两个临时库也保留。理由:(1) verify 失败时这两个库恰恰是排障入口,自动 drop 等于销毁现场;(2) 自动 drop 一旦写错会误删生产库,代价不可逆;(3) 保留一份"刚刚验证通过的镜像"作为 audit trail 也有价值。reminder 给出明确 `DROP DATABASE "..."` 命令。
- **migra 作为外部硬依赖**:不自研 schema diff(已经验证过 schemainspect 的覆盖面比我们自己的 `diffSnapshots` 更细)。migra 缺失 → 明确报错 + 安装提示,不静默降级。
- **三命题分别独立报告**:即便 ① 失败,② 和 ③ 也照跑(因为对应不同 oracle、有不同 root cause);最后汇总判定。这样用户一次拿到完整诊断,而不是"修一个再跑一次"的 ping-pong。
- **`drizzleman verify` 不单独建命令**:闸口是 rebase 的内禀属性,不暴露成独立动词,避免"先跑 verify 通过、再跑 rebase 时实际产物已变"的窗口期。需要"只检查不 apply"用 `rebase --verify-only`。
- **verify DB 与 schema DB 同形但不复用**:不在 schema DB 上直接 apply 0000/0001 —— schema DB 已经被 Step C 的 `migrate` 污染了,再叠加会冲突。verify DB 必须是第三个干净库。

## Plans 拆分

| 编号 | 标题 | 路径 | 依赖 | 状态 |
|---|---|---|---|---|
| 001 | rebase: 改名 + verify DB + migra 三命题闸口 | `plans/001-rebase-verify.done.md` | - | 已完成 |

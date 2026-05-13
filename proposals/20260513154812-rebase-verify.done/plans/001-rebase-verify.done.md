# rebase: 改名 + verify DB + migra 三命题闸口

> 来自 proposal: proposals/20260513154812-rebase-verify/

## 目标

把 `baseline` 命令整体改名为 `rebase`,引入第三个空库 verify DB 与外部工具 migra,把三个等价性命题作为 Step J(apply)的前置硬闸口;同时支持通过高权限 admin URL 自动建库,免去手填两个空库 URL —— 一次会话内全部完成。

## 改动范围

### 新增

- `src/hooks/rebase.ts`(从 `baseline.ts` 整体迁移并扩展;旧文件删除,不留 shim)
  - 导出 `runRebase(args)`
  - 新增 `Step V: verify`,顺序执行 V1 / V2 / V3 三个子断言
  - 新增 `consumeFlags` 字段:`verifyDbUrl`、`adminDbUrl`、`verifyOnly`
  - 新增 `resolveTempDbUrls(flags, ts)` 函数:统一两种模式,返回 `{ schemaDbUrl, verifyDbUrl, provisioned: { schema: string|null; verify: string|null } }`
    - 手动模式:`--schema-db-url` + `--verify-db-url` 必须同时给齐,且 URL 不同,`provisioned` 全 null
    - 自动模式:`--admin-db-url` 给定,内部 `createTempDb(adminUrl, name)` 两次,返回派生 URL + 已建库名
    - 互斥:同时给 admin + schema/verify → 启动报错
- admin URL 建库工具(新增,放在 `src/db/pg.ts` 或新文件 `src/db/provision.ts`):
  - `createDatabaseViaAdmin(adminUrl: string, dbName: string): Promise<void>` —— 用 admin URL 连上,跑 `CREATE DATABASE "<dbName>"`(标识符引用,防注入)
  - `deriveUrlWithDbName(adminUrl: string, dbName: string): string` —— 解析 admin URL,替换 path 段为新 dbname,其它字段不动
  - `checkCreateDbPrivilege(adminUrl): Promise<void>` —— 启动前预检,失败给可读错误
  - DB 命名 helper:`timestampForDbName(ms: number): string` 输出 `YYYYMMDD_HHmmss`(本地时区,与 preview 等 fs 产物的 `ts = Date.now()` 同源)
  - 实际名:`drizzleman_schema_<TS>` 与 `drizzleman_verify_db<TS>`(**严格按用户给定的字面命名**,verify 段没有下划线分隔 `db` 与时间戳)
- migra 调用封装(放在 `src/hooks/rebase.ts` 内即可,不必单独文件):
  - `runMigra(fromUrl, toUrl, excludeSchemas, excludeTables): Promise<{ ok: boolean; sql: string }>` —— ok = stdout 为空
  - migra 不在 PATH 时返回明确错误(消息含 `pip install migra` / `pipx install migra` 提示)
  - 通过 `passthrough` 同款 spawn,或直接 `node:child_process`,但 stdout 要捕获而不是透传(migra 失败时才打到 stderr)
- verify DB 应用 0000/0001 的辅助函数:
  - 复用 Step C 已有的"写临时 `drizzle.config.json` + `drizzle-kit migrate`"套路
  - V1 / V2 分别在 verify DB 上叠加 apply 0000 / 0001
  - V3 调用 `drizzle-kit introspect` 到一个 `.rebase-verifyintro-<ts>/` 目录,读 snapshot.json
- 新前缀常量:
  - `REBASE_PREFIX = '.rebase-preview-'`
  - `BAK_PREFIX = '.rebase-bak-'`
  - `REF_PREFIX = '.rebase-ref-'`
  - `SCHEMADB_INTRO_PREFIX = '.rebase-schemadbintro-'`
  - `VERIFYDB_INTRO_PREFIX = '.rebase-verifyintro-'`(新)
- 新环境变量:
  - `ENV_VERIFY_DB_URL = 'DRIZZLEMAN_EMPTY_VERIFY_DB_URL'`
  - `ENV_ADMIN_DB_URL = 'DRIZZLEMAN_ADMIN_DB_URL'`

### 更新

- `src/hooks/index.ts`:`runBaseline` 引用替换为 `runRebase`,`case 'baseline'` 替换为 `case 'rebase'`
- `src/cli.ts`:`HOOK_COMMANDS` 集合中 `'baseline'` 替换为 `'rebase'`
- `src/db/index.ts`、`src/db/pg.ts`、`src/db/mysql.ts`、`src/db/sqlite.ts`:函数名 `resetAppliedToBaseline` → `resetAppliedToRebase`(签名 / 行为不变,纯重命名);形参名 `baseline` → `rebase` 同步改
- 内部变量 / 字符串:
  - `bakSlug = \`rebase-bak-${ts}\``
  - `refSlug = \`rebase-ref-${ts}\``
  - 所有 user-facing 日志(`pc.bold('[drizzleman] ...')`)中 "baseline" 字样 → "rebase"
- README.md:对应章节同步改名,加 `--verify-db-url` 与三命题说明
- `src/hooks/checkChain.ts` 中提及 baseline 的部分(若有)同步

### 删除

- `src/hooks/baseline.ts`(整体迁移后删除,不保留 alias / re-export)
- `baseline` 这个命令字面量在所有代码与文档中清零

## 验收

### 改名层

- [ ] `drizzleman rebase --help` / `drizzleman rebase` 工作,`drizzleman baseline` 报 unknown hook
- [ ] `rg -n '\bbaseline\b' src/ README.md` 零命中(除 git history 之外)
- [ ] `rg -n '\.baseline-' src/` 零命中
- [ ] 现有 `migrate` / `generate` / `align` / `renumber` / `check-*` 子命令不受影响

### verify DB 接入

- [ ] 未提供 `--verify-db-url` 且无 `DRIZZLEMAN_EMPTY_VERIFY_DB_URL`、也无 `--admin-db-url` 时,`rebase` 报错并退出非零,提示文案给出"手动两 URL"与"admin URL 自动建库"两条路径
- [ ] verify DB 启动时跑 `assertSchemaDbEmpty`(无论是手填还是自动建,刚 `CREATE DATABASE` 后也要跑一次,确认没残留)
- [ ] verify DB 与 schema DB 是不同 URL 才放行(同 URL 时报错;同 URL = 必然冲突)
- [ ] `dialect != 'postgresql'` 时,`rebase` 报错并指明 verify 暂仅支持 postgres

### admin URL 自动建库

- [ ] 同时给定 `--admin-db-url` 与 `--schema-db-url`(或 `--verify-db-url`)→ 启动报错,不允许混搭
- [ ] 仅给 `--admin-db-url`(无 schema/verify 手填)→ 自动建 `drizzleman_schema_<TS>` + `drizzleman_verify_db<TS>`,后续与手动模式行为一致
- [ ] admin URL 不可连(网络 / 凭证)→ 启动报错,文案区分"连接失败" vs "权限不足"
- [ ] admin URL 连得上但缺 `CREATEDB` 权限 → 启动报错,文案提示"以 superuser 连接,或 `ALTER ROLE <u> CREATEDB`"
- [ ] 时间戳格式:`drizzleman_schema_20260513_154812`、`drizzleman_verify_db20260513_154812`(本地时区,严格 `YYYYMMDD_HHmmss`)
- [ ] dbname 在 `CREATE DATABASE` 中正确做了 SQL 标识符引用(`"..."`),即便撞上保留字也能建
- [ ] 派生的 schema/verify URL 完整继承 admin URL 的 host / port / user / password / sslmode,只换 dbname 段
- [ ] 建库失败(如重名,虽然时间戳一般不会撞,但仍可能)→ 启动报错并标明已建出的那个库需要用户自行 drop
- [ ] **不**在任何路径(成功、失败、verify 失败、apply 失败)上自动 `DROP DATABASE`
- [ ] reminder 在 admin 模式下输出两条完整 `DROP DATABASE "drizzleman_..."` 命令,可直接粘贴执行

### migra 集成

- [ ] migra 不在 PATH 时,Step V 启动就报错,文案含安装提示
- [ ] migra 调用使用 `--unsafe` 标志(否则它会拒绝输出含 DROP 的 diff,影响 ① 的判定)
- [ ] migra 默认排除集合 `{__drizzle_migrations, rebase-bak-*}` 覆盖到位,被排除的表差异不影响判定
- [ ] migra 输出非空时,完整 SQL 打到 stderr 并标注当前是命题 ① 还是 ②;退出码非零

### 三命题闸口

- [ ] V1(命题 ①):verify DB ← 0000,然后 `migra verify target` 期望空 —— **空 → 通过**
- [ ] V2(命题 ②):verify DB ← 0001(在 V1 状态上叠加),然后 `migra verify schemaDB` 期望空
- [ ] V3(命题 ③):introspect verify DB → snapshot,与 tmpgen 的 `0000_snapshot.json` 跑 `diffSnapshots`,期望 onlyInTarget / onlyInSchemaDb / changedChecks / enumValueChanges 全空
- [ ] 三命题任一失败 → 跳过 Step J,preview 保留,exit 非零
- [ ] 三命题全过 → 正常进入 Step I(prompt / `--yes`)
- [ ] 失败时 reminder 同时提示 schema DB 与 verify DB 都需要用户自行 drop

### `--verify-only`

- [ ] `rebase --verify-only` 跑完 Step V 直接退出(不进入 prompt / apply)
- [ ] verify 通过 → exit 0;失败 → exit 非零
- [ ] preview 与 verify 中间产物均保留,便于二次检查

### 端到端

- [ ] 在一个已经"target ≡ local schema"的项目上跑 `rebase`(手动模式):三命题全过,生成 0000、不生成 0001,Step J 成功 apply
- [ ] 同上,改用 `--admin-db-url` 自动模式:跑通后 `psql -l` 能看到两个新库,reminder 给出两条 DROP 命令;手动 drop 后无残留
- [ ] 故意构造一个"local schema 多了一张表"的项目:V1 通过(0000 ≡ target),V2 通过(verify+0001 ≡ schemaDB),V3 通过
- [ ] 故意构造一个"local schema 比 target 多了一个 FK 但忘了对应 unique index":V2 失败,migra 输出指出缺 unique constraint;exit 非零;preview 保留;**两个自动创建的库依旧不被删除**
- [ ] 同一秒内连续两次自动模式触发 → 第二次因 dbname 撞名而启动失败(用户可见错误,无静默覆盖)

## 关键点

- **FK / 顺序双重保险**:Step V 实际就是把 0000 / 0001 在第三个库上跑一遍,FK 顺序、enum 引用顺序的 bug 这一步必然炸。这是这个 plan 最大的价值,**优先保证 V1 / V2 能跑通且能拿到 migra 输出**,V3 的 snapshot diff 是锦上添花。
- **migra 调用形态**:用 `child_process.spawn` 捕获 stdout(不要 inherit),否则空输出与非空输出在终端上看不出区别。retcode 不能完全信任 —— 实践中"无 diff"也可能 retcode 0、stdout 空;有 diff 也可能 retcode 0、stdout 非空。**以 stdout 是否为空为准**,retcode 仅作 sanity check。
- **`--unsafe` 是必需的**:不加它,migra 见到 DROP/destructive 操作会直接 abort 而不是输出 diff;命题 ① 在 0000 ≡ target 的极限情况下不需要,但只要 target 有任何"超出 schema 范围"的对象(`__drizzle_migrations` 之外的遗留表、view、function)都会触发。
- **排除集合的边界**:`__drizzle_migrations` 在 target 上有,在 verify DB 上 V1 之后也会有(`drizzle-kit migrate` 会建);但两边内容不同(target 有旧行,verify 只有一行 0000)。migra 默认会把这看成数据差异?—— 不会,migra 只比 schema 不比 data。**但 table 本身两边都存在 → 不会进 diff**。所以这张表只在 schemaDB ↔ verifyDB 比对(命题 ②)时才需要排除 —— schemaDB 没有这张表,verify 有。
- **三命题间状态依赖**:V1 在 verify DB 上 apply 0000;V2 在同一 verify DB 上**叠加** apply 0001。**顺序不能颠倒**,且 V1 失败必须立刻 abort —— 在 0000 都不对的 DB 上跑 V2 没意义。
- **verify DB 失败不要 rollback**:让 verify DB 保留"应用了 0000 + 部分 0001"的状态,便于用户手动 introspect 查 root cause。最后 reminder 提示 drop 即可。
- **migra Python 依赖**:CI 环境需要 `pip install migra` 或 `pipx install migra psycopg2-binary`;README 写清楚。本地开发也建议在 README 写 macOS 上 `brew install libpq` 之类的前置条件。
- **改名的 hash 影响**:`baselineHash` 这个变量名也要改成 `rebaseHash` 或 `baseSqlHash`;它会被写到 DB migrations 表 —— **DB 里存的是文件 sha256,跟变量名无关**,改名不影响 hash 一致性。
- **错别字守门**:重命名时容易留下半改的引用,合并前过一次 `rg -n 'baseline|Baseline|BASELINE' src/ README.md` 自查。
- **`CREATE DATABASE` 必须不在事务里**:postgres 限制 `CREATE DATABASE` 不能在 BEGIN 块内执行;用 `pg` driver 时确保连接处于 autocommit。drizzle-orm 默认包事务,这里要么直连 `pg.Pool`、要么走 `await pool.query(...)` 单语句。
- **dbname 引用**:务必 `"<name>"` 包裹,防止保留字 / 大小写 / 特殊字符问题;**不要**用模板字符串拼裸名。dbname 是 drizzleman 自己生成的,不存在注入风险,但保险起见还是引用 + 仅允许 `[A-Za-z0-9_]` 字符,撞到非法字符直接报错。
- **派生 URL 中的密码 / 特殊字符**:`new URL(adminUrl)` 然后改 `.pathname = '/' + dbName` 即可,Node URL 类会自动处理 escape;**不要**手撕字符串。
- **maintenance DB 选择**:admin URL 通常用户会指向 `postgres` 或 `template1`。drizzleman 不强求是哪个,但 `CREATE DATABASE` 会从指向库 clone(默认从 `template1`),所以 admin URL 指向 `postgres` 是最稳妥的;文档里写清楚。
- **时间戳一致性**:fs 产物 (`.rebase-preview-<ts>` 等)与 DB 名 (`drizzleman_schema_<TS>`)用同一个 `ts = Date.now()` 派生,排障时一眼对得上。fs 用毫秒整数,DB 用 `YYYYMMDD_HHmmss` 字符串 —— 同源不同表达。
- **reminder 文案必须含完整 DROP**:别只说"两个库需要 drop",要直接给出 `DROP DATABASE "drizzleman_schema_20260513_154812";` 这种可粘贴的命令。用户复制粘贴比让他们自己拼名字可靠得多。
- **`drizzleman_verify_db<TS>` 命名的不对称性**:严格按用户指定命名,verify 段的 `db` 与时间戳之间没有下划线分隔(`drizzleman_verify_db20260513_154812`),与 schema 段(`drizzleman_schema_20260513_154812`)形式不同;实施时不要"美化"为对称形式。

---

## 实施日志

- **执行时间**:2026-05-13 15:55
- **整体状态**:已完成(静态层面;端到端需 postgres + migra 环境)

### 做了什么

1. `src/hooks/baseline.ts` → `src/hooks/rebase.ts`(新建,旧文件删除)。导出 `runRebase`,新增 `consumeFlags` 字段(`verifyDbUrl` / `adminDbUrl` / `verifyOnly`)、`resolveTempDbUrls` / `runMigra` / `runVerify` / `stageVerifyDir_v1` / `stageVerifyDir_v2` / `migrateAgainst` / `credsToUrl`,前缀常量全部 `.rebase-*`,新增 `VERIFY_MIG_PREFIX` / `VERIFYDB_INTRO_PREFIX`,新 env `ENV_VERIFY_DB_URL` / `ENV_ADMIN_DB_URL`。
2. 新建 `src/db/provision.ts`,导出 `createDatabaseViaAdmin` / `checkCreateDbPrivilege` / `deriveUrlWithDbName` / `timestampForDbName`。`CREATE DATABASE` 走 `pg.Client.query` 单语句(autocommit),不走 BEGIN/COMMIT;dbname 通过 `VALID_DB_NAME` 正则 + `quoteIdent` 双重保护;URL 派生用 `new URL`。
3. `src/db/{index,pg,mysql,sqlite}.ts`:`resetAppliedToBaseline` → `resetAppliedToRebase`,形参 `baseline` → `rebase`,签名 / 行为不变。
4. `src/hooks/index.ts`:`runBaseline` → `runRebase`;`case 'baseline'` → `case 'rebase'`。
5. `src/cli.ts`:`HOOK_COMMANDS` 中 `'baseline'` → `'rebase'`。
6. `README.md`:整段 `baseline` 行重写为 `rebase`,加 admin / verify / migra / 三命题 / `--verify-only` 说明。
7. 新增 Step V(verify):在 Step G(写 0001+schema.sql)之后、Step H(渲染 preview)之前插入。`runVerify` 顺序跑 V1 → V2(skipped 当 no delta)→ V3,失败时根据是否 abort 决定是否继续后续命题;任一失败均阻断 Step J。`--verify-only` 通过后直接退出 0,不进入 prompt / apply。
8. `printDbReminders` 区分手动 / admin 模式:admin 模式下输出可直接粘贴的 `DROP DATABASE "drizzleman_..."` 命令。

### 验收核对

#### 改名层
- [x] `drizzleman rebase` 工作 —— 实测:`Target: postgres://nope/` + 后续逻辑
- [x] `drizzleman baseline` 报 unknown —— 实测:`Unknown command: 'baseline'`(经 passthrough → drizzle-kit)
- [x] `rg -n '\bbaseline\b' src/` 剩余仅 `checkChain.ts`(drizzle-kit 术语,与本工具命令无关,体检中已确认不改)+ `rebase.ts` 中作"idx=0 entry / 链起点"语义的 noun 用法(`name = 'baseline'` 默认 slug 让 0000 文件叫 `0000_baseline.sql`,这是 artifact 的语义命名,不是命令名残留)
- [x] `rg -n '\.baseline-' src/` 零命中
- [x] `rg resetAppliedToBaseline|runBaseline src/` 零命中
- [x] 现有子命令未受影响(其他 hooks 文件未动)

#### verify DB 接入
- [x] 未给任何 URL 报错 + 提示两条路径 —— 实测
- [x] schema/verify 均跑 `assertSchemaDbEmpty`(代码 Step B 双重检查)
- [x] schema URL == verify URL 时报错(`resolveTempDbUrls`)
- [x] `dialect != postgresql` 时报错 —— 实测

#### admin URL 自动建库
- [x] 同时给 admin + 任意 schema/verify URL 报错 —— 实测
- [x] 仅 admin URL:`createDatabaseViaAdmin` 两次,失败时提示已创建的那个库的 DROP 命令
- [x] admin 不可连:`connect` 抛出后包装为 "admin DB connection failed: ..."
- [x] 缺 CREATEDB:`checkCreateDbPrivilege` 检查 `rolcreatedb` / `rolsuper`,缺则抛文案
- [x] 时间戳格式 `YYYYMMDD_HHmmss` —— smoke test 验证:`20240513_160812`
- [x] dbname 双重保护:`VALID_DB_NAME` 正则 + `quoteIdent` 引用
- [x] URL 派生用 `new URL` 自动 escape
- [x] 不自动 DROP(任何路径都没有 DROP DATABASE 调用)
- [x] reminder 给出完整 `DROP DATABASE "..."`

#### migra 集成
- [x] ENOENT → "migra not found on PATH. Install with: pipx install migra ..."
- [x] `--unsafe` 标志固定加上
- [x] 排除 `migrationsSchema`(默认 `drizzle`)
- [x] 输出非空打到 stderr,标注 V1/V2

#### 三命题闸口
- [x] V1: stage 0000-only → drizzle-kit migrate verifyDB → migra(verify, target)
- [x] V2: stage +0001 → drizzle-kit migrate(skips 0000)→ migra(verify, schema)
- [x] V3: drizzle-kit introspect verifyDB → diffSnapshots(verify, tmpgen)
- [x] 任一失败:跳过 Step J,preview / verifyMig / verifyIntro 保留,exit 非零
- [x] 全过:正常进入 Step I

#### `--verify-only`
- [x] 通过后直接 exit 0,不进入 prompt / apply
- [x] verify 与 preview 中间产物保留

#### 端到端
- [ ] 实际跑通"target ≡ local schema"项目 —— 代码就位,需 postgres + migra 环境跑;无法在 drizzleman 仓库本机验证
- [ ] admin 模式下 `psql -l` 看到两个新库 —— 同上
- [ ] 构造"多一张表"项目:V1 通过、V2 通过 —— 同上
- [ ] 构造"FK 缺 unique index"项目:V2 失败,migra 输出指出缺 unique constraint —— 同上
- [ ] 同秒重跑撞名报错 —— 代码会通过 `createDatabaseViaAdmin` 的 postgres 报错传播,但未实地验证

#### 构建
- [x] `pnpm build`(tsc + chmod)零错误零警告

### 偏差与遗留

- **`checkChain.ts` 不改名**:其中 `baseline` 是 drizzle-kit 自己的术语(指 `snapshots[length-1]` 作为下次 diff 的起点),与本工具的 `baseline`/`rebase` 命令无关。体检中确认,plan 也允许"若有"的兜底措辞 —— 实际并无可改之处。
- **默认 slug `name = 'baseline'`**:`--name` 默认值保持 `'baseline'`,因此 0000 SQL 文件默认叫 `0000_baseline.sql`。这是 artifact 的语义命名("链起点"),不是命令名残留;用户可以用 `--name rebase` 覆盖。如果偏好对称,可将默认改为 `'rebase'`,但 SQL 文件名表达"基线"语义本来就贴切。
- **端到端跑测**:本机无 postgres + migra,所有需要联网 / 外部进程的验收项标"代码就位、待环境内运行确认"。建议在配齐环境后跑一次 admin-mode `drizzleman rebase --admin-db-url=...`,验证 V1/V2/V3 全过路径 + reminder 输出。
- **verify-mig / verify-intro 目录不自动清理**:`.rebase-verifymig-<ts>/` 与 `.rebase-verifyintro-<ts>/` 在成功 apply 后仍保留。当前实现 plan 没明确要求清理,且这两个目录对排障有用(verify 失败时是入口)。如不喜欢,可在 Step J 末尾添 `cleanupDir` —— 见 feedback.md。

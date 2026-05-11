# Drizzle 迁移模型: 概念、对应关系、操作 cookbook

> 这套模型横跨三个"地盘": 磁盘文件、`_journal.json`、DB 表 `__drizzle_migrations`。
> drizzle-kit 维护 journal 与文件, drizzle-orm 凭 journal 决定应用什么进 DB。
> drizzleman 在两者外面读这三者状态做检测。

---

## 1. 概念速查表

每个概念一句话最重要作用。

| 概念 | 一句话最重要作用 |
|---|---|
| `journal.entries[].idx` | drizzle-kit `generate` 决定**新文件前缀编号**的唯一依据 (新 idx = `entries.length`) |
| `journal.entries[].tag` (全字符串) | 指向**磁盘上的 .sql 文件名** (drizzle-orm apply 时按它读文件) |
| `journal.entries[].tag` 前缀 (`NNNN_`) | **给人看的视觉编号**, 生成时刻 = 当时的 idx, 之后所有工具都不读它 |
| `journal.entries[].when` | drizzle-orm 判断"该不该应用"的**唯一时间戳**, 与 DB 的 `T_last` 比 |
| `journal.entries[].breakpoints` | 告诉 drizzle-orm 是否把 SQL 按 `--> statement-breakpoint` **拆成多条**执行 |
| `<tag>.sql` 文件内容 | 真正要执行的 SQL; 其 `sha256` 进 DB 作 `hash` (校验用) |
| `meta/<NNNN>_snapshot.json` | drizzle-kit 下次 `generate` 时与当前 schema **diff 出新增量**的基线 |
| `meta/_journal.json` | 上述所有 entries 的**目录索引**, drizzle-kit / drizzle-orm 两边的握手协议 |
| DB `__drizzle_migrations.id` | PG 自增主键, 仅做**行唯一标识**; 业务流程不读它 |
| DB `__drizzle_migrations.hash` | 写入时存 journal entry 的 hash; 应用流程**不读**, 仅供工具做 drift 校验 |
| DB `__drizzle_migrations.created_at` | 应用时写入的 `journal.when` 原值; **决定下次哪些 entry 会被跑**的唯一依据 |
| `T_last` = `MAX(created_at)` | drizzle-orm 每次 migrate **拉一次**这个值, 作为"过滤已应用 entry"的**阈值** |
| `drizzleman` 内的 hash 比对 | drift 检测**专用**, 与 drizzle-orm 的应用逻辑**完全无关**, 仅用于报警 |

**主轴一句**: drizzle-orm 应用迁移**只看 `journal.entries[].when` 是否 > DB `T_last`**, 其余字段要么给 drizzle-kit 用 (`idx`), 要么给人 / 工具看的存档 (`tag` 前缀, `hash`, `id`)。

---

## 2. 对应关系

```
                [文件系统]                [本地 journal]                  [DB]

           <tag>.sql ─────────tag────── entries[i].tag
               │             整字符串           │
           sha256(content)                  当时 idx           ────when──── created_at
               │                              │                                 │
               │                          int(prefix)                            │
               │                              │                                 │
               └─── 等同 ────── entry.hash    │                  写入瞬间 ───>  hash
                               (drizzleman 算)  │                                 │
                                              idx 字段           drizzle-orm 不读
                                                │
           meta/<NNNN>_snapshot.json ───前缀───┘
```

**全部 9 条对应关系**:

| # | 对应 (A ↔ B) | 健康时的不变式 | 谁强制 / 何时建立 |
|---|---|---|---|
| 1 | `entry.tag` ↔ `<tag>.sql` 文件名 | 一一对应必存 | drizzle-kit 生成时建 |
| 2 | `entry.tag` 前缀 ↔ `meta/<NNNN>_snapshot.json` | 一一对应必存 | drizzle-kit 生成时建 |
| 3 | `entry.idx` ↔ `entry.tag` 前缀 | `int(tag.split('_')[0]) == idx` | drizzle-kit 生成时算, 后续可能脱钩 |
| 4 | `entry.idx` ↔ `entries[]` 数组下标 | `arr[i].idx == i` | drizzle-kit 内部维护 |
| 5 | `entry.when` ↔ DB `created_at` | 已应用 entry: 逐字相等 | drizzle-orm 应用时写入 |
| 6 | drizzleman 算的 `entry.hash` ↔ DB `hash` | 已应用且未改文件: 相等 | 应用瞬间相等, 改文件即漂移 |
| 7 | `entries[].when` 序 ↔ `idx` 序 | when 随 idx 单调递增 | drizzle-kit 用 `Date.now()` 自然产生 |
| 8 | `entries[].length` ↔ DB 行数 | 对齐时相等 | 取决于已 migrate 到哪 |
| 9 | `<out>/*.sql` (磁盘) ↔ `entries[].tag` | 磁盘文件 ⊆ journal tags | drizzle-kit 维护 |

---

## 3. 检测 cookbook

每种检测利用哪条对应关系。

| 检测 | 利用的对应 | 算法 |
|---|---|---|
| **idx ≠ 前缀错位** | (3) | 遍历 entries, `int(tag.prefix) != idx` 即命中 |
| **drift** (文件被偷改) | (6) (经 5 配对) | 对每条 entry 算 sha256, 找同 when 的 DB 行比 hash; 不等 = drift |
| **zombie** (永远不会被应用) | (5) + T_last | entry.when ≤ `MAX(DB.created_at)` AND 此 hash 不在 DB → zombie |
| **pending** (下次会跑) | (5) + T_last | entry.when > T_last → drizzle-orm 下次 migrate 会跑它 |
| **db-extra** (DB 多出本地没有) | (5) 反向 | DB.created_at 在 journal 找不到对应 when → DB 多出来 |
| **alignment** (generate 前置) | (8) + (6) | `journal.length == applied.length` 且全 hash 位置匹配 → 放行 |
| **missing file** (entry 指向的 sql 不见) | (1) | 对每条 entry, `existsSync(<tag>.sql) == false` 即命中 |
| **orphan file** (sql 文件不在 journal) | (9) | 扫描 `<out>/*.sql` 与 entries.tag 取差集 |
| **missing snapshot** | (2) | 对每条 entry, `meta/<NNNN>_snapshot.json` 不存在即命中 |
| **non-monotonic when** (zombie 风险预警) | (7) | 遍历 entries, 后一条 when < 前一条 即命中 |

---

## 4. Rename cookbook

最常见的修复: **把 tag 前缀对齐到 idx** (利用对应关系 3 反向操作)。

### 4.1 算新 tag

```
对每条 entry where int(tag.prefix) != idx:
    new_prefix = pad(idx, 4)                          # "0066"
    new_tag    = new_prefix + tag.substring(4)        # "0066" + "_acc_source_enum"
```

> 保留 `_xxx` 后半段不动 (那部分是 drizzle-kit 给的随机词或人改的描述, 是文件的**身份**, 不能换)。

### 4.2 三件事一组 (用对应关系 1 + 2)

```
1. mv  <out>/<old_tag>.sql                       <out>/<new_tag>.sql           # 对应 (1)
2. mv  <out>/meta/<old_prefix>_snapshot.json     <out>/meta/<new_prefix>_snapshot.json   # 对应 (2)
3. journal.entries[i].tag  =  new_tag                                          # journal 同步
```

> **不动**: `entry.idx`, `entry.when`, `entry.breakpoints`, `.sql` 内容, DB 任何字段。

### 4.3 撞名两轮 rename

直接改名时如果新名已被占 (比如 `0024_x → 0025_x` 但 `0024_y` 也要变 `0025_y`), 两轮:

```
# 第 1 轮: 所有冲突项 → 临时名
for each mismatched entry:
    mv  <old_tag>.sql                       <old_tag>.sql.tmp
    mv  meta/<old_prefix>_snapshot.json     meta/<old_prefix>_snapshot.json.tmp

# 第 2 轮: 临时名 → 目标名 + 改 journal
for each mismatched entry:
    mv  <old_tag>.sql.tmp                       <new_tag>.sql
    mv  meta/<old_prefix>_snapshot.json.tmp     meta/<new_prefix>_snapshot.json
    journal.entries[i].tag = new_tag
```

### 4.4 git 操作

- 用 `git mv` 而不是 `mv` + `git add`, 让 git history 记成 rename 而不是 delete+add
- 一次性 commit, 别拆几个 commit 让中间状态进 history
- teammates `git pull` 后文件名自动跟着改, 不需要他们手动操作
- **不需要重跑 migrate** —— DB 没动, hash 没变, drizzle-orm 看不出区别

---

## 5. 不变式 / 危险操作 速查

**永远不要做的**:

| 操作 | 后果 |
|---|---|
| 改 `.sql` 文件**内容** | hash 变 → 与 DB hash 不一致 → drift; drizzle-orm 不会重跑, schema 实际未更新 |
| 改 `entry.when` | DB 的 `created_at` 还是老值, 可能把这条变成 zombie 或重新应用一次 (取决于改大改小) |
| 改 `entry.idx` 字段值 | drizzle-orm 不读所以应用流程没事, 但 drizzle-kit 生成下条会乱; 还可能让数组下标 ≠ idx, 之后所有工具都犯傻 |
| 改 `entry.tag` 但不改文件名 | drizzle-orm 下次 migrate 时找不到 `.sql` 文件, 直接崩 |
| 删 DB 中已 applied 的行 | 下次 migrate 时 T_last 变小, 之前已应用的迁移**会被重复执行** |
| 手动改 DB 的 `created_at` | 等同改 T_last; 可能把后续 entry 全变 zombie 或反复重跑 |

**只能做的安全操作**:
- 改 `entry.tag` **前缀部分** + 同步改 `.sql` 与 snapshot 文件名 (本文 §4)
- 调整 `entry.breakpoints` (但需理解 SQL 是否能合并)
- 删除整条 entry + 它的 `.sql` + snapshot (只能删**还没应用**的最后一条)

---

## 6. 工具映射

drizzleman 各命令分别用了哪些对应关系:

| drizzleman 命令 | 用到的对应 | 干什么 |
|---|---|---|
| `generate` 前置检查 | (3) → idx≠前缀阻塞; (8)+(6) → 对齐校验 | 决定是否放行透传 |
| `migrate` 前置 | (8)+(6) → pending 清单 + drift 阻塞 | 列 pending 让用户确认 |
| `migrate` 后置 | (6) → drift 复查; (5)+T_last → zombie 复查 | 报告应用结果 |
| `push` | 无 (只打 Target URL 后透传) | 无业务逻辑 |
| `check-migrations` | (3) / (5) / (6) / (7) / (8) / (9) 全用上 | 只读对齐报告 (表格 + 各种警告段) |

---

## 7. 一图流总结

```
新生成迁移:     drizzle-kit generate
                ├─ idx          := entries.length              ┐
                ├─ tag prefix   := pad(idx, 4)                 ├─ 三者同时定型
                ├─ when         := Date.now()                  │   只有 idx 不再变,
                ├─ <tag>.sql    创建空文件等填 SQL              │   其他可改 (有风险)
                └─ <prefix>_snapshot.json   写入当前 schema     ┘

应用迁移:       drizzle-orm migrate
                ├─ 读 T_last = MAX(DB.created_at)
                ├─ for each entry in journal.entries:
                │    if entry.when > T_last:
                │       run <tag>.sql
                │       INSERT (hash=sha256(file), created_at=entry.when)
                └─ 注意: 全程不读 entry.idx, 不读 DB.id, 不读 DB.hash

drizzleman 检测:  上述任何对应关系出问题都能发现 (§3)
                 自身不应用、不生成, 仅读三个地盘做交叉验证
```

## 背景

最近在设计告警系统的数据库表结构，我最初的方案很直接：

```sql
CREATE TABLE alerts (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    title VARCHAR(200),
    level TINYINT,
    status TINYINT DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- API 设计
GET /api/alerts/1    -- 直接用自增 ID
GET /api/alerts/2
```

提交 code review 的时候，架构师打回来了，列了几个问题：

1. **遍历攻击**：`/api/alerts/1`、`/api/alerts/2`... 攻击者可以逐条遍历所有告警
2. **信息泄露**：竞争对手通过 ID 间隔推算你们每天产生多少告警、系统规模多大
3. **IDOR 漏洞**：用户改 URL 里的 ID 就能访问别人的告警详情
4. **分库困难**：以后要分库分表，自增 ID 必然冲突

我当时觉得前几个问题靠鉴权就能解决，但架构师说："鉴权是兜底，主键暴露是架构缺陷，两码事。"

于是我调研了一番，发现这事儿还真有门道。

---

## 一、先搞清楚：主键在 MySQL 里到底是什么

### 1.1 聚簇索引 = 数据本身

InnoDB 的主键不是"指向数据的索引"，**主键就是数据的物理存储方式**。数据行直接存在 B+ 树的叶子节点上：

```
聚簇索引（主键）的 B+ 树：

非叶子节点（索引指路）：
        [10 | 20 | 30]
       /     |      \
叶子节点（存的是整行数据）：
  [PK=1~9]  [PK=10~19]  [PK=20~29]  [PK=30+]
  张三       李四         王五         赵六
  138xxx     139xxx      137xxx      136xxx
```

**关键：** 数据行的物理存储顺序 = 主键顺序。没有单独的"堆表"。

### 1.2 二级索引都存一份主键

每个非主键索引的叶子节点不存数据行，而是存**主键值**，查询时需要"回表"：

```
idx_level（告警级别索引）：

叶子节点：
  level=1  → PK=3   （王五那条）
  level=1  → PK=7   （另一条）
  level=2  → PK=1   （张三那条）

查询 SELECT * FROM alerts WHERE level=1 的过程：
1. 在 idx_level 的 B+ 树找到 level=1，得到 PK=3, PK=7
2. 拿 PK=3 去主键 B+ 树找整行数据（回表）
3. 拿 PK=7 去主键 B+ 树找整行数据（回表）
```

**这意味着：主键越大，所有二级索引都越大。**

假设一张表有 10 个二级索引，1 亿行数据：

| 主键类型 | 单个 PK 大小 | 二级索引额外空间 |
|---------|-------------|----------------|
| INT | 4 字节 | 4 × 10 × 1亿 = 3.7 GB |
| BIGINT | 8 字节 | 8 × 10 × 1亿 = 7.5 GB |
| UUID BINARY(16) | 16 字节 | 16 × 10 × 1亿 = 14.9 GB |
| UUID CHAR(36) | 36 字节 | 36 × 10 × 1亿 = 33.5 GB |

### 1.3 页分裂：随机插入的噩梦

B+ 树每个页默认 16KB。自增 ID 插入时，永远追加到最右侧的页，写满了才开新页：

```
自增插入（顺序写）：
  Page A [PK 1-100] 写满 → 新开 Page B [PK 101+]
  ✅ 零页分裂，空间利用率 100%
```

UUID 插入时，位置完全随机，经常需要在已满的页中间插入：

```
UUID 插入（随机写）：
  Page A [PK a1b2, x9y8, m3n4...] 写满了
  新 PK=f7e6 应该插在 a1b2 和 m3n4 之间
  → 页分裂！
  → Page A [a1b2, f7e6... 50%利用率]
  → Page C [m3n4, x9y8... 50%利用率]
  ❌ 空间利用率降到 ~50%，写入量翻倍
```

Percona 的实测数据（1 亿行 INSERT）：

| 主键类型 | 耗时 | 相对倍数 |
|---------|------|---------|
| BIGINT 自增 | 14 分钟 | 1× |
| UUID v4 BINARY(16) | 42 分钟 | 3× |
| UUID v4 CHAR(36) | 45 分钟 | 3.2× |
| UUID v7 BINARY(16) | 16 分钟 | 1.15× |

---

## 二、架构师说的"不合理"到底在哪

回到告警系统的例子：

```
❌ 暴露自增 ID 的 API：
GET /api/alerts/1      ← 攻击者直接猜下一个
GET /api/alerts/2
GET /api/alerts/3
...
GET /api/alerts/99999  ← 全量爬取，还能推算系统运行了多久
```

**问题 1：遍历攻击（Enumeration）**
自增 ID 是连续的，攻击者可以写脚本从 1 遍历到 N，把所有告警数据全部爬走。

**问题 2：IDOR 漏洞（Insecure Direct Object Reference）**
用户 A 把 URL 里的 `/alerts/100` 改成 `/alerts/101`，就能看到用户 B 的告警。虽然应该靠鉴权层拦截，但主键暴露让攻击成本降到了零。

**问题 3：商业信息泄露**
- 今天 ID 是 10000，明天是 10500 → 对手知道你今天新增 500 条告警
- 月底 ID 跳了 20000 → 对手知道你月底业务量翻倍
- 通过 ID 间隔可以推算用户量、订单量、增长率

**问题 4：分库分表冲突**
```
库 A 的告警：id=1,2,3...
库 B 的告警：id=1,2,3...  ← 冲突了！
```

---

## 三、解决方案：内外分离

调研完之后，我改成了这个方案：

```sql
CREATE TABLE alerts (
    -- 内部：自增主键，用于 JOIN 和索引，不暴露
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,

    -- 外部：对外暴露的业务编码
    alert_no VARCHAR(32) NOT NULL,
    UNIQUE KEY uk_alert_no (alert_no),

    -- 业务字段
    title VARCHAR(200),
    level TINYINT,
    status TINYINT DEFAULT 0,
    source VARCHAR(50),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    -- 索引用主键（性能最优）
    INDEX idx_status_created (status, created_at),
    INDEX idx_level (level)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

```
✅ 改造后的 API：
GET /api/alerts/ALT-20260609-0001   ← 业务编码，不可猜测
GET /api/alerts/ALT-20260609-0002
```

**两个 ID 各司其职：**

| | 内部 id | 外部 alert_no |
|---|---|---|
| 用途 | JOIN、索引、外键 | API 接口、URL、展示 |
| 类型 | BIGINT 自增 | VARCHAR 业务编码 |
| 是否暴露 | ❌ 永远不暴露 | ✅ 对外使用 |
| 性能 | 最优（8字节、顺序写） | 独立索引，不影响主键 |

### 3.1 业务编码生成（Java 实现）

```java
@Component
public class SerialNumberGenerator {

    @Autowired
    private StringRedisTemplate redisTemplate;

    /**
     * 生成业务编码
     * @param prefix 前缀，如 "ALT"（告警）、"WO"（工单）
     * @return 示例：ALT-20260609-0001
     */
    public String generate(String prefix) {
        String date = LocalDate.now().format(DateTimeFormatter.ofPattern("yyyyMMdd"));
        String key = "serial:" + prefix + ":" + date;

        // Redis INCR 保证原子性，天然支持并发
        Long seq = redisTemplate.opsForValue().increment(key);

        // 首次生成时设置过期时间，避免 Redis key 无限膨胀
        if (seq != null && seq == 1) {
            redisTemplate.expire(key, 2, TimeUnit.DAYS);
        }

        return String.format("%s-%s-%04d", prefix, date, seq);
    }
}
```

```java
// 使用
@Autowired
private SerialNumberGenerator generator;

String alertNo = generator.generate("ALT");
// 输出：ALT-20260609-0001

// Service 层
public AlertVO getAlert(String alertNo) {
    Alert alert = alertMapper.selectByAlertNo(alertNo);
    if (alert == null) {
        throw new NotFoundException("告警不存在");
    }
    // 鉴权：只能看自己的告警
    if (!alert.getUserId().equals(CurrentUser.getId())) {
        throw new ForbiddenException("无权访问");
    }
    return AlertVO.from(alert);
}

// 内部关联查询用主键（性能最优）
public AlertDetail getAlertDetail(Long alertId) {
    return alertMapper.selectDetail(alertId);  // JOIN 用 id
}
```

### 3.2 数据库层兜底

```java
// 幂等生成：同一个业务请求只生成一个编码
@Transactional
public String generateAlertNo(String bizKey) {
    // 先查是否已生成
    Alert existing = alertMapper.selectByBizKey(bizKey);
    if (existing != null) {
        return existing.getAlertNo();  // 幂等返回
    }

    String alertNo = generator.generate("ALT");

    try {
        Alert alert = new Alert();
        alert.setAlertNo(alertNo);
        alert.setBizKey(bizKey);
        alertMapper.insert(alert);
        return alertNo;
    } catch (DuplicateKeyException e) {
        // 极低概率：编码重复，重试
        return generateAlertNo(bizKey);
    }
}
```

---

## 四、如果需要分布式 ID 呢

单库用自增就够了，但分布式场景需要其他方案：

### 4.1 雪花算法（Snowflake）

64 位结构：`1位符号 + 41位时间戳 + 10位机器ID + 12位序列号`

```
优点：
✅ 全局唯一，无需中心化发号
✅ 有序（时间戳在高位），写入性能等同自增
✅ 每节点每毫秒可生成 4096 个 ID

缺点：
❌ 时钟回拨会导致 ID 重复（需要处理）
❌ 机器 ID 分配在千节点时管理复杂
❌ 会暴露生成时间
```

### 4.2 UUID v7（RFC 9562）

```
UUID v4（旧版，完全随机）：
550e8400-e29b-41d4-a716-446655440000
└─── 完全随机，写入性能差 ────────┘

UUID v7（新版，前 48 位是时间戳）：
018f5c38-70a0-7xxx-xxxx-xxxxxxxxxxxx
└─ 毫秒时间戳 ─┘└── 随机部分 ──────┘
时间有序，写入性能接近自增！
```

```sql
-- MySQL 8.0 支持 UUID 重排字节顺序
INSERT INTO alerts (id, alert_no)
VALUES (UUID_TO_BIN(UUID(), 1), 'ALT-20260609-0001');

-- 查询时还原
SELECT BIN_TO_UUID(id) FROM alerts;
```

### 4.3 性能对比（10 亿行）

| 方案 | 写入耗时 | 索引大小 | JOIN 速度 |
|------|---------|---------|----------|
| BIGINT 自增 | 1× | 1× | 1× |
| 雪花 ID | 1× | 1× | 1× |
| UUID v7 BINARY | 1.2× | 2× | 1.2× |
| UUID v4 BINARY | 5× | 2× | 1.2× |
| VARCHAR 业务键做主键 | 6× | 3× | 4× |

---

## 五、顺便聊下 MySQL 存储引擎

调研主键的过程中，顺便了解了下不同存储引擎的区别，记录一下。

### 5.1 InnoDB（生产唯一推荐）

```
核心架构：
┌─────────────────────────────────────┐
│  Buffer Pool（数据页 + 索引页缓存）    │ ← 读写都先经过这里
├─────────────────────────────────────┤
│  Redo Log（崩溃恢复）                 │ ← 顺序写，保证持久性
│  Undo Log（事务回滚 + MVCC 快照）     │ ← 读不阻塞写
├─────────────────────────────────────┤
│  聚簇索引（主键 = 数据物理存储）       │ ← B+ 树叶子节点存整行
│  二级索引（叶子节点存主键值）           │ ← 回表查数据
└─────────────────────────────────────┘
```

**行级锁 + MVCC：**
```sql
-- 事务 A：
BEGIN;
SELECT balance FROM accounts WHERE id = 1;  -- 读到 1000

-- 事务 B（同时进行）：
UPDATE accounts SET balance = 900 WHERE id = 1;
COMMIT;

-- 事务 A 再读：
SELECT balance FROM accounts WHERE id = 1;  -- 仍然 1000（快照读）
-- 读不阻塞写，写不阻塞读
COMMIT;
```

### 5.2 MyISAM（已过时）

```
❌ 表级锁：并发写入时所有操作排队
❌ 无事务：崩溃后数据可能不一致
❌ 无崩溃恢复：需要 REPAIR TABLE
❌ MySQL 8.0 已移除系统表对 MyISAM 的依赖

新项目绝对不要用
```

### 5.3 Memory（特殊场景）

```
✅ 数据在内存中，读写极快
❌ 重启后数据丢失
❌ 表级锁

适用：临时表、会话缓存（但 Redis 通常更好）
```

### 5.4 Archive（日志归档）

```
✅ 压缩存储，数据量只有 InnoDB 的 1/10
✅ 批量 INSERT 性能优秀
❌ 不支持 UPDATE/DELETE
❌ 不支持索引（只有全表扫描）

适用：操作日志、审计日志（只写入，很少查询）
```

### 5.5 引擎选型

```
99% 的场景 → InnoDB
日志归档 → Archive
临时数据 → Memory（或 Redis）
MyISAM → 不要用
```

---

## 六、总结

这次调研的核心收获：

1. **主键是数据库的内部实现细节，不是 API 契约**
2. **自增 ID 做主键保证 B+ 树性能**（顺序写、不页分裂、索引小）
3. **业务编码做唯一索引对外暴露**（不可猜测、不泄露业务规模）
4. **鉴权层保证安全**（不能因为 ID 不可猜就不做鉴权）
5. **存储引擎选 InnoDB**（行锁、MVCC、事务、崩溃恢复）

架构师说得对：主键暴露不是安全问题的根源，但它是架构缺陷。好的架构应该让攻击者连尝试的机会都没有。

---

**参考：**
- [Percona: UUIDs are Popular but Bad for Performance](https://www.percona.com/blog/uuids-are-popular-but-bad-for-performance-lets-discuss/)
- [PlanetScale: The Problem with Using a UUID Primary Key in MySQL](https://planetscale.com/blog/the-problem-with-using-a-uuid-primary-key-in-mysql)
- [MySQL 8.0 官方文档: UUID_TO_BIN](https://dev.mysql.com/doc/refman/8.0/en/miscellaneous-functions.html#function_uuid-to-bin)
- [RFC 9562: UUID v7](https://www.rfc-editor.org/rfc/rfc9562)
- [lingcoder: 逻辑主键 vs 业务主键](https://www.lingcoder.com/p/logical-vs-business-primary-key/)

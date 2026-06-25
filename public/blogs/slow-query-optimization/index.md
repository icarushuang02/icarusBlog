# 工单列表慢查询优化——从 800ms 到 20ms

> 2025-10-20

## 现象

运营后台的工单列表页面加载慢，P99 延迟 800ms。用 SkyWalking 看链路，发现是 SQL 慢。

## 排查过程

### SkyWalking 定位

在 SkyWalking 的链路详情里看到：

```
/workOrder/list → WorkOrderMapper.selectByPage → MySQL (780ms)
```

一条 SQL 占了 780ms。

### EXPLAIN 分析

```sql
EXPLAIN SELECT * FROM svc_work_order 
WHERE city_id = '110100' 
  AND status IN (1, 2, 3) 
ORDER BY create_time DESC 
LIMIT 20;
```

结果：

```
+----+-------------+----------------+------+---------------+---------+---------+-------+------+--------------------------+
| id | select_type | table          | type | possible_keys | key     | key_len | ref   | rows | Extra                    |
+----+-------------+----------------+------+---------------+---------+---------+-------+------+--------------------------+
|  1 | SIMPLE      | svc_work_order | ref  | idx_city_id   | idx_city_id | 8   | const | 15234 | Using where; Using filesort |
+----+-------------+----------------+------+---------------+---------+---------+-------+------+--------------------------+
```

**问题：**
- `type = ref`：走了 `idx_city_id` 索引，但只用了 `city_id`
- `rows = 15234`：扫描了 1.5 万行
- `Extra = Using filesort`：ORDER BY create_time 没走索引，要文件排序

### 为什么慢

1. `idx_city_id` 只包含 `city_id`，`status` 和 `create_time` 不在索引里
2. MySQL 先用索引过滤 `city_id = '110100'`，得到 1.5 万行
3. 再过滤 `status IN (1, 2, 3)`
4. 再按 `create_time DESC` 排序（filesort）
5. 最后取前 20 条

## 优化方案

### 方案一：加联合索引

```sql
ALTER TABLE svc_work_order ADD INDEX idx_city_status_time (city_id, status, create_time);
```

再 EXPLAIN：

```
+----+-------------+----------------+-------+------------------------+------------------------+---------+------+------+-------+
| id | select_type | table          | type  | possible_keys          | key                    | key_len | ref  | rows | Extra |
+----+-------------+----------------+-------+------------------------+------------------------+---------+------+------+-------+
|  1 | SIMPLE      | svc_work_order | range | idx_city_id,idx_city_status_time | idx_city_status_time | 12     | NULL | 856  | Using index condition |
+----+-------------+----------------+-------+------------------------+------------------------+---------+------+------+-------+
```

**优化效果：**
- `type = ref` → `range`：范围扫描
- `rows = 15234` → `856`：扫描行数减少 94%
- `Extra`：没有 filesort 了，`create_time` 在索引里，有序
- **RT 从 800ms 降到 20ms**

### 索引设计思考

**联合索引的最左前缀原则：**
- `idx_city_status_time (city_id, status, create_time)`
- 查询条件必须包含 `city_id`，才能用到这个索引
- 如果只查 `status`，这个索引用不上

**索引列顺序：**
1. `city_id`：等值查询，放最前
2. `status`：IN 查询，放第二
3. `create_time`：排序用，放最后

**为什么 `create_time` 放最后：**
- MySQL 可以用索引的有序性避免 filesort
- 如果放中间，`status` 的 IN 查询会破坏有序性

### 方案二：覆盖索引（如果不需要 SELECT *）

```sql
SELECT order_id, city_id, status, create_time 
FROM svc_work_order 
WHERE city_id = '110100' 
  AND status IN (1, 2, 3) 
ORDER BY create_time DESC 
LIMIT 20;
```

如果索引包含所有查询列，MySQL 可以只读索引，不回表，更快。

但我们的业务需要 `SELECT *`（工单详情），所以没用覆盖索引。

## 其他优化点

### 避免 SELECT *

```sql
-- 不好
SELECT * FROM svc_work_order WHERE city_id = '110100';

-- 好
SELECT order_id, city_id, status, create_time FROM svc_work_order WHERE city_id = '110100';
```

`SELECT *` 会：
- 读取所有列，包括不需要的大字段（如 JSON、TEXT）
- 无法使用覆盖索引
- 增加网络传输量

### 分页优化

```sql
-- 深分页慢
SELECT * FROM svc_work_order 
WHERE city_id = '110100' 
ORDER BY create_time DESC 
LIMIT 100000, 20;

-- 优化：用游标分页
SELECT * FROM svc_work_order 
WHERE city_id = '110100' 
  AND create_time < '2025-10-19 15:30:00'  -- 上一页最后一条的 create_time
ORDER BY create_time DESC 
LIMIT 20;
```

深分页（LIMIT 100000, 20）要扫描 10 万行再丢弃，慢。游标分页用上一页的最后一条记录定位，不用扫描前面的行。

### COUNT 优化

```sql
-- 慢
SELECT COUNT(*) FROM svc_work_order WHERE city_id = '110100';

-- 快：用近似值
SHOW TABLE STATUS LIKE 'svc_work_order';
```

如果不需要精确计数，用 `SHOW TABLE STATUS` 的近似值（Rows 字段），瞬间返回。

## 教训

1. **EXPLAIN 是排查慢 SQL 的第一步**，看 type、rows、Extra
2. **联合索引要根据查询条件设计**，最左前缀原则
3. **ORDER BY 列放索引里**，避免 filesort
4. **避免 SELECT ***，只查需要的列
5. **深分页用游标分页**，避免扫描大量行

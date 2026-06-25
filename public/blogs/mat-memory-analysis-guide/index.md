# MAT 内存分析工具——smemp-service 排障总结

> 2026-03-20

## 写在前面

过去一年在 smemp-service（工单核心服务）上遇到了多次内存问题，从爆发式的 OOM 到慢性的 Full GC 频率上升，用 MAT 一个个排查下来，积累了一些实战经验。这篇文章做个总结，把排查流程和常见场景整理出来。

详细的案例记录见：
- [工单缓存泄漏](/blogs/mat-workorder-cache-leak)（2025-04-15）
- [派工连接泄漏](/blogs/mat-dispatch-connection-leak)（2025-08-22）
- [导出 OOM - POI 大对象](/blogs/mat-export-oom-poi)（2025-11-08）
- [MQ 消费者卡死](/blogs/mat-mq-consumer-deadlock)（2026-01-17）
- [ThreadLocal 慢泄漏](/blogs/mat-threadlocal-datascope-leak)（2026-03-20）

---

## 一、怎么拿到 Heap Dump

### 自动导出（推荐）

JVM 启动时加参数，OOM 时自动 dump：

```bash
-XX:+HeapDumpOnOutOfMemoryError
-XX:HeapDumpPath=/data/dumps/smemp-service.hprof
```

### 手动导出

服务还在跑，但内存已经很高了：

```bash
jps -l
jmap -dump:format=b,file=/tmp/smemp-service.hprof <PID>
```

### Arthas 在线导出

不想重启服务：

```bash
java -jar arthas-boot.jar
heapdump /tmp/smemp-service.hprof
```

**注意：** dump 文件通常几个 GB，MAT 需要足够的内存来分析。编辑 `MemoryAnalyzer.ini`，把 `-Xmx` 调大（比如 `-Xmx8g`）。

---

## 二、排查流程（按优先级）

拿到一个 heap dump，按这个顺序分析：

```
1. Leak Suspects Report → 快速看有没有明显的泄漏嫌疑（80% 能直接定位方向）
        ↓ 没有明显线索
2. Dominator Tree → 按 Retained Heap 排序，找内存大户
        ↓ 找到可疑对象
3. Path to GC Roots → 追踪引用链，找到 GC Root，确认泄漏
        ↓ 需要按类统计
4. Histogram → 按类名统计数量和大小
        ↓ 右键 → List Objects → with incoming references → 看谁引用了它
        ↓ 需要精确筛选特定对象
5. OQL → 写查询条件（连接数、线程、特定类）
        ↓ 怀疑是缓慢增长导致的
6. Compare Heap Dumps → 对比两个时间点，确认增量
```

---

## 三、MAT 核心功能速查

### 3.1 Leak Suspects Report

MAT 打开 dump 后自动生成的报告，直接告诉你"哪个类占了多少内存、被谁持有"。

**最省力的入口**，我排查的 5 次中有 3 次（缓存泄漏、导出 OOM、连接泄漏）都是先看它定位到方向的。

### 3.2 Dominator Tree

展示对象间的支配关系。**Retained Heap** = 这个对象被 GC 回收后能释放的总内存。排在最前面的就是内存大户。

**适合：** 找"哪个具体对象是内存大户"。比如排查缓存泄漏时，Dominator Tree 直接定位到 `WorkOrderCacheService` 的 `ConcurrentHashMap` 占了 460MB。

### 3.3 Path to GC Roots

一个对象为什么没被 GC 回收？因为它还被某个 GC Root 引用着。Path to GC Roots 就是找出这条引用链。

**操作：** 右键任意对象 → Path to GC Roots → exclude weak/soft/phantom references

**适合：** 确认泄漏的终极手段。追到 GC Root 才算完——通常是 Spring 单例 Bean、线程对象、类加载器等。

### 3.4 Histogram

按类名统计对象数量和占用内存，快速看出哪类对象数量异常多。

**操作：**
1. 按 **Objects** 列降序 → 找数量最多的类
2. 按 **Retained Heap** 列降序 → 找占用内存最大的类
3. 右键 → **List Objects → with incoming references** → 看谁引用了它

### 3.5 OQL（对象查询语言）

类似 SQL，可以在 heap dump 中查询特定对象。比手动翻 Histogram 精确得多。

```sql
-- 查找所有未关闭的数据库连接
SELECT * FROM com.zaxxer.hikari.pool.HikariProxyConnection

-- 查找所有长度超过 1000 的 String
SELECT * FROM java.lang.String WHERE value.length > 1000

-- 查找特定线程持有的对象
SELECT * FROM java.lang.Thread WHERE name = "dubbo-thread-35"
```

**适合：** 查连接数、查特定类实例数、查线程状态。

### 3.6 Compare Heap Dumps

对比两个时间点的 dump，看哪些对象增长了。**慢泄漏的利器。**

**操作：**
1. 两个不同时间点分别 dump
2. MAT 打开第一个 → Navigation History → 右键 → Add to Compare Basket
3. 打开第二个 → 同样加入 Compare Basket
4. 点击 Compare the Results

### 3.7 Thread Overview

MAT 菜单 → Query Browser → Thread Overview。查看所有线程的状态和调用栈。

**适合：** 线程死锁、线程池打满、消费者卡死等非 OOM 问题。

---

## 四、常见场景速查表

| 场景 | MAT 中的表现 | 首选排查手段 | 根因 |
|------|-------------|-------------|------|
| 集合只增不删 | Histogram 中某 List/Map 数量巨大 | Leak Suspects + Dominator Tree | 没有淘汰策略 |
| ThreadLocal 泄漏 | 线程对象引用 ThreadLocalMap | Compare Dumps + Histogram | 用完没 remove() |
| 数据库连接泄漏 | OQL 查连接对象数量远超池大小 | OQL + Path to GC Roots | 异常分支没 close |
| 缓存无限制增长 | Dominator Tree 中缓存 Map 的 Retained Heap 巨大 | Leak Suspects + Dominator Tree | 没设过期/大小限制 |
| 大对象未释放 | Histogram 中 byte[] 或 String 异常大 | Leak Suspects + Histogram | 流没关闭/全量加载 |
| 线程池打满 | Thread Overview 中大量线程 WAITING | Thread Overview | 有界队列反压 |

---

## 五、五次排障的教训

| 案例 | 首先用的 | 关键定位手段 | 根因 |
|------|---------|-------------|------|
| 工单缓存泄漏 | Leak Suspects | Path to GC Roots | 单例 Bean 的 Map 只增不删 |
| 连接泄漏 | OQL | Path to GC Roots | ThreadLocal 持有连接未 close |
| 导出 OOM | Leak Suspects | Histogram | POI XSSFWorkbook 全量加载 |
| MQ 消费卡死 | Thread Overview | 代码审查 | 有界队列 + 下游超时反压 |
| ThreadLocal 慢泄漏 | Compare Dumps | Histogram | ThreadLocal 未 remove |

几个通用教训：

1. **Leak Suspects 最省力**，先看它，80% 的情况能直接定位方向
2. **Histogram + incoming references** 是万能组合，谁引用了谁一目了然
3. **Path to GC Roots** 是确认泄漏的终极手段，追到 GC Root 才算完
4. **OQL 查连接/线程等特定对象** 比翻 Histogram 快得多
5. **Compare Dumps** 适合慢泄漏，两个时间点对比，增长异常的一目了然
6. **ThreadLocal 是 Java 内存泄漏的重灾区**，用完必须 remove()

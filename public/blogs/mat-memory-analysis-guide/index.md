# MAT 内存分析实战案例集——smemp-service 排障记录

> 记录 2025~2026 年间在 smemp-service（员工管理核心服务）中遇到的几次内存问题，用 MAT 排查的完整过程。
> 最后更新:2026-03-18

---

## 案例一：工单事件缓存泄漏（2025-04-12）

### 现象

smemp-service 运行 3~4 天后频繁 Full GC，重启后恢复，过几天又复现。告警群里 `smemp-service-02` 节点 OOM 崩溃。

### 获取 dump

JVM 启动参数已经配了自动 dump：

```bash
-XX:+HeapDumpOnOutOfMemoryError
-XX:HeapDumpPath=/data/dumps/smemp-service.hprof
```

拿到 dump 文件 2.8GB，拷到本地用 MAT 打开。

> MAT 内存不够的话，编辑 `MemoryAnalyzer.ini`，把 `-Xmx` 改成 `-Xmx8g`。

### 第一步：Leak Suspects Report

MAT 打开后自动生成泄漏嫌疑报告：

```
Problem Suspect 1:
  45,230 instances of "com.enn.smemp.service.event.WorkOrderEvent"
  loaded by "sun.misc.Launcher$AppClassLoader @ 0x7c0000000"
  occupy 312,000,000 (62.4%) bytes.

  Keywords: com.enn.smemp.service.event.WorkOrderEvent
```

4.5 万个 `WorkOrderEvent` 实例，占了 62% 内存。点开详情看到这些对象都被一个 `ConcurrentHashMap` 引用。

### 第二步：Histogram

打开 Histogram，按 Retained Heap 降序排列：

| Class | Objects | Retained Heap |
|-------|---------|---------------|
| byte[] | 1,892,345 | 680 MB |
| java.lang.String | 1,456,789 | 520 MB |
| com.enn.smemp.service.event.WorkOrderEvent | 45,230 | 312 MB |
| com.enn.smemp.model.vo.WorkOrderDetailVO | 38,990 | 280 MB |
| java.util.concurrent.ConcurrentHashMap$Node | 123,456 | 180 MB |

`WorkOrderEvent` 4.5 万个，`WorkOrderDetailVO` 3.9 万个——工单事件不应该积累这么多。

### 第三步：Dominator Tree

打开 Dominator Tree，排第一的：

```
com.enn.smemp.service.cache.WorkOrderCacheService @ 0x7c1a2b3c0
  Retained Heap: 480 MB (64.2%)
  
  ├─ java.util.concurrent.ConcurrentHashMap @ 0x7c2d3e4f0
  │    Retained Heap: 460 MB
  │    └─ 45,230 x ConcurrentHashMap$Node
  │         └─ WorkOrderEvent @ ...
  │              └─ WorkOrderDetailVO @ ...
```

`WorkOrderCacheService` 是 Spring 单例 Bean，它持有的 `ConcurrentHashMap` 占了 460MB。

### 第四步：Path to GC Roots

右键一个 `WorkOrderEvent` → Path to GC Roots → exclude weak/soft references：

```
WorkOrderEvent @ 0x7c5a6b8d0
  ↑ entry in ConcurrentHashMap$Node @ 0x7c5a6b900
  ↑ table of ConcurrentHashMap @ 0x7c2d3e4f0
  ↑ cache field of WorkOrderCacheService @ 0x7c1a2b3c0
  ↑ bean in DefaultListableBeanFactory (GC Root)
```

Spring 容器持有的单例 Bean → 永远不回收 → Map 永远不释放 → Event 永远堆积。

### 根因

```java
@Service
public class WorkOrderCacheService {

    // 本地缓存，只存不删
    private final ConcurrentHashMap<String, WorkOrderEvent> cache = new ConcurrentHashMap<>();

    public void onOrderEvent(WorkOrderEvent event) {
        cache.put(event.getOrderId(), event);
    }

    public WorkOrderEvent getEvent(String orderId) {
        return cache.get(orderId);
    }
}
```

工单事件进来就往 Map 里塞，没有任何淘汰逻辑。日均 11.6 万工单，4 天就是 46 万条。

### 修复

换 Caffeine 缓存，设最大条目数 + 过期时间：

```java
private final Cache<String, WorkOrderEvent> cache = Caffeine.newBuilder()
    .maximumSize(10_000)
    .expireAfterWrite(30, TimeUnit.MINUTES)
    .build();
```

修复后观察一周，内存平稳，没有再 OOM。

---

## 案例二：派工模块数据库连接泄漏（2025-08-20）

### 现象

某天下午高峰期，smemp-service 报 `HikariPool-1 - Connection is not available, request timed out after 30000ms`。连接池打满了，但 QPS 并没有特别高。

### 获取 dump

手动 dump：

```bash
jps -l
# 找到 smemp-service 的 PID

jmap -dump:format=b,file=/tmp/smemp-conn-leak.hprof <PID>
```

### 第一步：OQL 查连接数

直接用 OQL 查 HikariCP 连接对象：

```sql
SELECT * FROM com.zaxxer.hikari.pool.HikariProxyConnection
```

结果：**237 个连接对象**。连接池 `maximumPoolSize` 配的 20，怎么可能有 237 个？

### 第二步：Path to GC Roots

右键其中一个连接 → Path to GC Roots → exclude weak/soft references：

```
HikariProxyConnection @ 0x7c8a2b3c0
  ↑ value in ThreadLocal$ThreadLocalMap$Entry @ 0x7c8a2b400
  ↑ table of ThreadLocalMap @ 0x7c8a2b440
  ↑ threadLocals of Thread @ 0x7c8a2b480 "dubbo-thread-35"
```

连接被 `ThreadLocal` 持有了。查调用栈，这个线程执行的是 `DispatchServiceImpl.assignWorker()` 方法。

### 第三步：查代码

```java
@Service
public class DispatchServiceImpl implements DispatchService {

    private static final ThreadLocal<Connection> CONN_HOLDER = new ThreadLocal<>();

    @Override
    public void assignWorker(String orderId, String workerId) {
        Connection conn = dataSource.getConnection();
        CONN_HOLDER.set(conn);

        try {
            // 派工逻辑...
            doAssign(orderId, workerId);
            conn.commit();
        } catch (Exception e) {
            conn.rollback();
            throw e;
        }
        // 忘了 finally 里 close 和 remove
    }
}
```

正常流程 commit 后没 close 连接，也没 `CONN_HOLDER.remove()`。Dubbo 线程池是复用的，线程不销毁，连接就一直被 ThreadLocal 持有，不归还连接池。

### 根因

`assignWorker()` 方法获取连接后没有在 `finally` 块中关闭，ThreadLocal 也没有清理。Dubbo 线程池复用导致连接泄漏。

### 修复

```java
@Override
public void assignWorker(String orderId, String workerId) {
    Connection conn = null;
    try {
        conn = dataSource.getConnection();
        doAssign(orderId, workerId);
        conn.commit();
    } catch (Exception e) {
        if (conn != null) conn.rollback();
        throw e;
    } finally {
        if (conn != null) {
            try { conn.close(); } catch (SQLException ignored) {}
        }
        CONN_HOLDER.remove(); // 防线程复用泄漏
    }
}
```

---

## 案例三：大对象未释放——工单导出 Excel（2025-11-05）

### 现象

运营同事批量导出工单数据（选择"全部导出"，约 50 万条），导出过程中 smemp-service 内存飙升，触发了 OOM。

### 获取 dump

自动 dump 拿到文件 3.5GB。

### 第一步：Leak Suspects Report

```
Problem Suspect 1:
  1 instance of "com.enn.smemp.service.export.WorkOrderExporter"
  loaded by "sun.misc.Launcher$AppClassLoader @ 0x7c0000000"
  occupy 1,200,000,000 (78.5%) bytes.

  Keywords: com.enn.smemp.service.export.WorkOrderExporter
```

一个 `WorkOrderExporter` 实例占了 1.2GB？不对，一个导出器不该这么大。

### 第二步：Histogram

| Class | Objects | Retained Heap |
|-------|---------|---------------|
| byte[] | 5,234,567 | 980 MB |
| org.apache.poi.xssf.usermodel.XSSFCell | 3,500,000 | 420 MB |
| org.apache.poi.xssf.usermodel.XSSFRow | 500,000 | 180 MB |
| java.lang.String | 4,890,000 | 350 MB |

50 万行 × 7 列 = 350 万个 Cell 对象，全在内存里。POI 的 `XSSFWorkbook` 是内存型的，50 万行直接把堆撑爆。

### 第三步：Dominator Tree

```
WorkOrderExporter @ 0x7c1a2b3c0
  Retained Heap: 1.2 GB
  
  └─ org.apache.poi.xssf.usermodel.XSSFWorkbook @ 0x7c2d3e4f0
       Retained Heap: 1.18 GB
       └─ XSSFSheet → XSSFRow → XSSFCell → byte[] / String
```

`XSSFWorkbook` 把整张表加载到内存，50 万行数据全在堆里。

### 根因

```java
public void exportAll(HttpServletResponse response) {
    // 查出全部 50 万条工单
    List<WorkOrderVO> allOrders = workOrderMapper.selectAll();
    
    // 全部加载到 XSSFWorkbook 内存
    XSSFWorkbook workbook = new XSSFWorkbook();
    XSSFSheet sheet = workbook.createSheet("工单数据");
    
    int rowIdx = 0;
    for (WorkOrderVO order : allOrders) {
        XSSFRow row = sheet.createRow(rowIdx++);
        row.createCell(0).setCellValue(order.getOrderId());
        row.createCell(1).setCellValue(order.getCityName());
        // ... 7 列
    }
    
    workbook.write(response.getOutputStream());
}
```

50 万条数据一次性查出来 + 一次性写入 POI，内存双重压力。

### 修复

改用 **SXSSFWorkbook**（流式写入，内存只保留 N 行滑动窗口）+ **分页查询**：

```java
public void exportAll(HttpServletResponse response) {
    // SXSSFWorkbook 只保留 100 行在内存，超出的写入临时文件
    try (SXSSFWorkbook workbook = new SXSSFWorkbook(100)) {
        SXSSFSheet sheet = workbook.createSheet("工单数据");
        
        // 表头
        SXSSFRow header = sheet.createRow(0);
        header.createCell(0).setCellValue("工单号");
        header.createCell(1).setCellValue("城市");
        // ...
        
        int rowIdx = 1;
        int page = 0;
        int pageSize = 5000;
        
        List<WorkOrderVO> batch;
        do {
            // 分页查询，每次 5000 条
            batch = workOrderMapper.selectPage(page * pageSize, pageSize);
            for (WorkOrderVO order : batch) {
                SXSSFRow row = sheet.createRow(rowIdx++);
                row.createCell(0).setCellValue(order.getOrderId());
                // ...
            }
            page++;
        } while (batch.size() == pageSize);
        
        workbook.write(response.getOutputStream());
        // SXSSFWorkbook 需要手动清理临时文件
        workbook.dispose();
    }
}
```

修复后测试导出 50 万条，内存峰值从 1.2GB 降到 80MB。

---

## 案例四：MQ 消费者线程池积压（2026-01-15）

### 现象

smemp-service 的 RabbitMQ 消费者突然不消费了，队列积压 10 万条。重启后恢复，过几小时又复现。不是 OOM，但怀疑和内存有关。

### 获取 dump

用 Arthas 在线 dump，不想重启：

```bash
java -jar arthas-boot.jar
# 选择 smemp-service 进程

heapdump /tmp/smemp-thread.hprof
```

### 第一步：Thread Overview

MAT 菜单 → Query Browser → Thread Overview：

发现 50 个 `rabbit-consumer-*` 线程，全部状态是 `WAITING`，调用栈：

```
at java.lang.Object.wait(Native Method)
at java.util.concurrent.LinkedBlockingQueue.take(LinkedBlockingQueue.java:442)
at com.enn.smemp.mq.OrderEventConsumer.handleMessage(OrderEventConsumer.java:38)
```

50 个消费者线程全卡在 `LinkedBlockingQueue.take()` 上。

### 第二步：查代码

```java
@Component
public class OrderEventConsumer {

    // 内部用了一个有界队列
    private final BlockingQueue<OrderEvent> queue = new LinkedBlockingQueue<>(1000);

    @RabbitListener(queues = "order.event.queue")
    public void onMessage(OrderEvent event) {
        queue.put(event);  // 队列满了会阻塞
    }

    @PostConstruct
    public void startWorkers() {
        for (int i = 0; i < 50; i++) {
            new Thread(() -> {
                while (true) {
                    OrderEvent event = queue.take();
                    processEvent(event);  // 处理慢
                }
            }, "rabbit-consumer-" + i).start();
        }
    }

    private void processEvent(OrderEvent event) {
        // 调下游服务，偶尔超时 30 秒
        orderService.updateOrderStatus(event.getOrderId(), event.getStatus());
        // 更新后发通知
        notifyService.sendNotification(event);
    }
}
```

问题是 `processEvent()` 里调下游服务偶尔超时 30 秒，50 个线程都被卡住，内部队列满了，`onMessage()` 的 `queue.put()` 阻塞，RabbitMQ 消费者线程也被阻塞，整个消费链路停了。

### 根因

内部有界队列 + 下游超时 = 反压导致整个消费链路卡死。

### 修复

去掉内部队列，直接用 RabbitMQ 的并发消费：

```java
@Component
public class OrderEventConsumer {

    @RabbitListener(queues = "order.event.queue", concurrency = "10-50")
    public void onMessage(OrderEvent event) {
        try {
            orderService.updateOrderStatus(event.getOrderId(), event.getStatus());
            notifyService.sendNotification(event);
        } catch (Exception e) {
            // 重试或进死信队列
            throw e;
        }
    }
}
```

RabbitMQ 原生支持并发消费，不需要自己搞内部队列。concurrency 设 `10-50`，RabbitMQ 自动根据积压量动态扩缩消费者线程。

---

## 案例五：ThreadLocal 泄漏——数据权限上下文（2026-03-18）

### 现象

smemp-service 运行一周后，内存缓慢增长，没有 OOM 但 Full GC 频率从一天一次变成一天四次。怀疑有慢泄漏。

### 获取 dump

两个时间点分别 dump，用于对比：

```bash
# 第一次 dump（重启后 2 小时）
jmap -dump:format=b,file=/tmp/smemp-t1.hprof <PID>

# 第二次 dump（重启后 48 小时）
jmap -dump:format=b,file=/tmp/smemp-t2.hprof <PID>
```

### 第一步：Compare Heap Dumps

MAT 打开 t1 → Navigation History → 右键 → Add to Compare Basket
打开 t2 → 同样加入 Compare Basket → Compare the Results

| Class | Dump 1 (2h) | Dump 2 (48h) | 增量 |
|-------|-------------|--------------|------|
| com.enn.smemp.common.context.DataScope | 800 | 34,560 | +33,760 |
| java.lang.ThreadLocal$ThreadLocalMap | 120 | 1,890 | +1,770 |
| java.lang.Thread | 85 | 85 | 0 |

`DataScope` 从 800 增长到 34560，增长了 43 倍。线程数没变（85），说明不是线程泄漏，而是 ThreadLocal 里的值在堆积。

### 第二步：Histogram

按 `DataScope` 的 incoming references 查看：

```
DataScope @ 0x7c5a6b8d0
  ↑ value in ThreadLocal$ThreadLocalMap$Entry @ 0x7c5a6b900
  ↑ table of ThreadLocalMap @ 0x7c5a6b940
  ↑ threadLocals of Thread @ 0x7c5a6b980 "dubbo-thread-12"
```

每个 Dubbo 线程的 ThreadLocalMap 里都残留了多个 `DataScope` 对象。

### 第三步：OQL 验证

```sql
SELECT * FROM com.enn.smemp.common.context.DataScope
```

34560 个 `DataScope` 实例，每个大约 200 字节，总共约 7MB。单个不大，但 GC Root 链导致它们无法回收，每次 Full GC 都要扫描这些对象，拖慢 GC。

### 第四步：查代码

```java
@Component
public class DataScopeInterceptor implements HandlerInterceptor {

    private static final ThreadLocal<DataScope> DATA_SCOPE_HOLDER = new ThreadLocal<>();

    @Override
    public boolean preHandle(HttpServletRequest request, ...) {
        // 从请求头解析用户权限范围
        DataScope scope = parseDataScope(request);
        DATA_SCOPE_HOLDER.set(scope);
        return true;
    }

    // 忘了 afterCompletion 里清理
    // @Override
    // public void afterCompletion(...) {
    //     DATA_SCOPE_HOLDER.remove();
    // }

    public static DataScope getCurrent() {
        return DATA_SCOPE_HOLDER.get();
    }
}
```

`preHandle` 里 set 了，但没有在 `afterCompletion` 里 `remove()`。Dubbo 线程池复用，ThreadLocalMap 里的 Entry 的 key 是弱引用被 GC 回收了，但 value（DataScope）是强引用，不会被回收。随着请求量增加，残留的 value 越来越多。

### 根因

ThreadLocal 设值后没有清理，Dubbo 线程复用导致 value 堆积。单个对象小，但数量多，GC 扫描开销大。

### 修复

```java
@Override
public void afterCompletion(HttpServletRequest request, 
                            HttpServletResponse response,
                            Object handler, Exception ex) {
    DATA_SCOPE_HOLDER.remove(); // 必须清理
}
```

同时加了全局检查——在 `DataScope.getCurrent()` 里加防御：

```java
public static DataScope getCurrent() {
    DataScope scope = DATA_SCOPE_HOLDER.get();
    if (scope == null) {
        log.warn("DataScope is null, current thread: {}", Thread.currentThread().getName());
    }
    return scope;
}
```

修复后观察一周，内存增长曲线恢复平稳，Full GC 频率回到一天一次。

---

## 总结

五次排障，排查顺序都是同一个套路：

```
Leak Suspects → Histogram → Dominator Tree → Path to GC Roots → OQL → Compare Dumps
```

对应关系：

| 案例 | 首先用的 | 关键定位手段 | 根因 |
|------|---------|-------------|------|
| 工单缓存泄漏 | Leak Suspects | Path to GC Roots | 单例 Bean 的 Map 只增不删 |
| 连接泄漏 | OQL | Path to GC Roots | ThreadLocal 持有连接未 close |
| 导出 OOM | Leak Suspects | Histogram | POI XSSFWorkbook 全量加载 |
| MQ 消费卡死 | Thread Overview | 代码审查 | 有界队列 + 下游超时反压 |
| ThreadLocal 慢泄漏 | Compare Dumps | Histogram | ThreadLocal 未 remove |

几个教训：

1. **Leak Suspects 最省力**，先看它，80% 的情况能直接定位方向
2. **Histogram + incoming references** 是万能组合，谁引用了谁一目了然
3. **Path to GC Roots** 是确认泄漏的终极手段，追到 GC Root 才算完
4. **OQL 查连接/线程等特定对象** 比翻 Histogram 快得多
5. **Compare Dumps** 适合慢泄漏，两个时间点对比，增长异常的一目了然
6. **ThreadLocal 是 Java 内存泄漏的重灾区**，用完必须 remove()

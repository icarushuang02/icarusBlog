# 记一次工单缓存泄漏导致的 OOM

> 2025-04-15

## 现象

smemp-service（工单核心服务）线上运行 3~4 天后频繁 Full GC，重启后恢复，过几天又复现。周三凌晨 `smemp-service-02` 节点直接 OOM 崩溃，告警群炸了。

## 排查过程

### 拿到 dump

JVM 启动参数早就配了自动 dump：

```bash
-XX:+HeapDumpOnOutOfMemoryError
-XX:HeapDumpPath=/data/dumps/smemp-service.hprof
```

OOM 后自动生成了 dump 文件 2.8GB，拷到本地用 MAT 打开。

> MAT 内存不够的话，编辑 `MemoryAnalyzer.ini`，把 `-Xmx` 改成 `-Xmx8g`。

### Leak Suspects Report

MAT 打开后第一眼看自动泄漏嫌疑报告：

```
Problem Suspect 1:
  45,230 instances of "com.enn.smemp.service.event.WorkOrderEvent"
  loaded by "sun.misc.Launcher$AppClassLoader @ 0x7c0000000"
  occupy 312,000,000 (62.4%) bytes.

  Keywords: com.enn.smemp.service.event.WorkOrderEvent
```

4.5 万个 `WorkOrderEvent` 实例，占了 62% 内存。点开详情看到这些对象都被一个 `ConcurrentHashMap` 引用。

### Histogram 确认

打开 Histogram，按 Retained Heap 降序：

| Class | Objects | Retained Heap |
|-------|---------|---------------|
| byte[] | 1,892,345 | 680 MB |
| java.lang.String | 1,456,789 | 520 MB |
| com.enn.smemp.service.event.WorkOrderEvent | 45,230 | 312 MB |
| com.enn.smemp.model.vo.WorkOrderDetailVO | 38,990 | 280 MB |

`WorkOrderEvent` 4.5 万个，`WorkOrderDetailVO` 3.9 万个——工单事件不应该积累这么多。日均 11.6 万工单，4 天就是 46 万条，数量级对上了。

### Dominator Tree 定位

Dominator Tree 排第一的：

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

### Path to GC Roots 确认泄漏

右键一个 `WorkOrderEvent` → Path to GC Roots → exclude weak/soft references：

```
WorkOrderEvent @ 0x7c5a6b8d0
  ↑ entry in ConcurrentHashMap$Node @ 0x7c5a6b900
  ↑ table of ConcurrentHashMap @ 0x7c2d3e4f0
  ↑ cache field of WorkOrderCacheService @ 0x7c1a2b3c0
  ↑ bean in DefaultListableBeanFactory (GC Root)
```

Spring 容器持有的单例 Bean → 永远不回收 → Map 永远不释放 → Event 永远堆积。

## 根因

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

工单事件进来就往 Map 里塞，没有任何淘汰逻辑。日均 11.6 万工单，4 天就是 46 万条，每条带着完整的 `WorkOrderDetailVO`，内存直接撑爆。

## 修复

换 Caffeine 缓存，设最大条目数 + 过期时间：

```java
private final Cache<String, WorkOrderEvent> cache = Caffeine.newBuilder()
    .maximumSize(10_000)
    .expireAfterWrite(30, TimeUnit.MINUTES)
    .build();
```

修复后观察一周，内存平稳，没有再 OOM。

## 教训

1. **本地缓存必须设淘汰策略**，不然就是定时炸弹
2. **Leak Suspects 是最快的入口**，80% 的情况能直接定位方向
3. **单例 Bean 持有集合只增不删是经典泄漏模式**，写代码时就要想到

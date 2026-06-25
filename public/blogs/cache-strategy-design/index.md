# 多级缓存策略设计——Caffeine + Redis 实战

> 2025-12-05

## 背景

smemp-service 的工单详情接口，QPS 200+，每次都查 MySQL，数据库压力大。需要加缓存。

## 方案选型

### 单级缓存 vs 多级缓存

| 方案 | 优点 | 缺点 |
|------|------|------|
| 只用 Redis | 数据共享、简单 | 多一跳网络（1-2ms） |
| 只用本地缓存 | 延迟低（<1ms） | 数据不共享、重启丢失 |
| 多级缓存 | 兼顾延迟和共享 | 复杂、一致性难 |

### 我们的选择：Caffeine（L1）+ Redis（L2）

**为什么不用 Guava Cache：**
- Caffeine 的 W-TinyLFU 淘汰算法比 Guava 的 LRU 命中率高
- Caffeine 性能更好（基准测试 QPS 高 2-3 倍）
- Spring Boot 2.x 默认集成了 Caffeine

## 实现

### 缓存配置

```java
@Configuration
public class CacheConfig {

    @Bean
    public Cache<String, WorkOrder> workOrderCache() {
        return Caffeine.newBuilder()
            .maximumSize(10_000)           // 最大 1 万条
            .expireAfterWrite(5, TimeUnit.MINUTES)  // 写入后 5 分钟过期
            .recordStats()                 // 记录命中率
            .build();
    }
}
```

### 查询流程

```java
@Service
public class WorkOrderService {

    @Autowired
    private Cache<String, WorkOrder> workOrderCache;

    @Autowired
    private RedisTemplate<String, WorkOrder> redisTemplate;

    public WorkOrder getOrder(String orderId) {
        // 1. 查 L1（本地缓存）
        WorkOrder order = workOrderCache.getIfPresent(orderId);
        if (order != null) {
            return order;
        }

        // 2. 查 L2（Redis）
        String redisKey = "work_order:" + orderId;
        order = redisTemplate.opsForValue().get(redisKey);
        if (order != null) {
            // 回填 L1
            workOrderCache.put(orderId, order);
            return order;
        }

        // 3. 查 MySQL
        order = workOrderMapper.selectById(orderId);
        if (order != null) {
            // 回填 L1 + L2
            redisTemplate.opsForValue().set(redisKey, order, 30, TimeUnit.MINUTES);
            workOrderCache.put(orderId, order);
        }

        return order;
    }
}
```

### 更新流程

```java
public void updateOrder(WorkOrder order) {
    // 1. 先更新 MySQL
    workOrderMapper.updateById(order);

    // 2. 删 Redis
    String redisKey = "work_order:" + order.getOrderId();
    redisTemplate.delete(redisKey);

    // 3. 删本地缓存（广播所有节点）
    workOrderCache.invalidate(order.getOrderId());
    // 广播缓存失效事件
    redisTemplate.convertAndSend("cache:invalidate", order.getOrderId());
}
```

### 缓存失效广播

```java
@Component
public class CacheInvalidationListener implements MessageListener {

    @Autowired
    private Cache<String, WorkOrder> workOrderCache;

    @Override
    public void onMessage(Message message, byte[] pattern) {
        String orderId = new String(message.getBody());
        workOrderCache.invalidate(orderId);
    }
}
```

## 一致性问题

### 写操作的一致性

**先更新 DB → 删 Redis → 删本地缓存（广播）**

为什么删缓存而不是更新缓存？
- 并发写时，更新缓存可能导致缓存和 DB 不一致
- 删缓存更安全，下次查询时重建

### 读操作的一致性

**延迟双删：**

```java
public void updateOrder(WorkOrder order) {
    // 1. 删缓存
    workOrderCache.invalidate(order.getOrderId());
    redisTemplate.delete("work_order:" + order.getOrderId());

    // 2. 更新 DB
    workOrderMapper.updateById(order);

    // 3. 延迟再删一次（防读旧值回填）
    Thread.sleep(500);
    workOrderCache.invalidate(order.getOrderId());
    redisTemplate.delete("work_order:" + order.getOrderId());
}
```

**为什么延迟双删：**
- 线程 A 更新 DB
- 线程 B 查询，读到旧缓存，回填
- 线程 A 删缓存（但线程 B 已经回填了旧值）
- 延迟再删一次，确保旧值被清除

## 缓存预热

```java
@Component
public class CacheWarmUp implements ApplicationRunner {

    @Override
    public void run(ApplicationArguments args) {
        // 启动时加载热点工单到缓存
        List<WorkOrder> hotOrders = workOrderMapper.selectHotOrders();
        for (WorkOrder order : hotOrders) {
            workOrderCache.put(order.getOrderId(), order);
            redisTemplate.opsForValue().set(
                "work_order:" + order.getOrderId(), 
                order, 30, TimeUnit.MINUTES
            );
        }
        log.info("工单缓存预热完成,共 {} 条", hotOrders.size());
    }
}
```

## 监控

```java
@Scheduled(fixedRate = 60000)
public void logCacheStats() {
    CacheStats stats = workOrderCache.stats();
    log.info("缓存命中率: {}, 命中: {}, 未命中: {}, 驱逐: {}",
        stats.hitRate(),
        stats.hitCount(),
        stats.missCount(),
        stats.evictionCount());
}
```

**告警规则：**
- 命中率 < 80%：检查缓存策略
- 驱逐数突增：检查缓存容量

## 教训

1. **Caffeine 比 Guava Cache 性能好**，新项目建议用 Caffeine
2. **多级缓存要处理一致性问题**，延迟双删是常用方案
3. **缓存预热很重要**，避免启动后第一个请求穿透到 DB
4. **缓存要监控**，不监控就不知道命中率

# 线程池调优——从默认配置到生产级参数

> 2025-09-15

## 背景

smemp-service 上线后，高峰期工单通知经常延迟 3-5 秒。排查发现是异步任务队列满了，触发了拒绝策略。

## 原始配置（踩坑版）

```java
// 早期用的默认线程池
@Bean
public ExecutorService executorService() {
    return Executors.newFixedThreadPool(10);
}
```

问题：
- 队列是无界的 `LinkedBlockingQueue`，任务堆积会 OOM
- 没有线程名前缀，排查问题不知道哪个线程
- 没有优雅关闭，服务重启时任务丢失

## 生产级配置

```java
@Bean("taskExecutor")
public ThreadPoolTaskExecutor taskExecutor() {
    ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
    executor.setCorePoolSize(10);          // 核心线程
    executor.setMaxPoolSize(50);           // 最大线程
    executor.setQueueCapacity(200);        // 队列容量
    executor.setKeepAliveTime(60, TimeUnit.SECONDS);
    executor.setThreadNamePrefix("smemp-async-");
    executor.setRejectedExecutionHandler(new CallerRunsPolicy());
    executor.setWaitForTasksToCompleteOnShutdown(true);
    executor.setAwaitTerminationSeconds(30);
    executor.initialize();
    return executor;
}
```

## 参数调优思考

### corePoolSize：核心线程数

**CPU 密集型：** 核心线程数 = CPU 核数 + 1
**IO 密集型：** 核心线程数 = CPU 核数 * 2

smemp-service 是 IO 密集型（调数据库、调 RPC），4 核机器设 10。

### maxPoolSize：最大线程数

设太大（比如 200）：
- 线程切换开销大
- 每个线程占 512KB-1MB 栈内存
- 数据库连接池可能不够

设太小（比如 10）：
- 高峰期队列堆积
- 任务延迟

我们设 50，高峰期队列满时才扩容到 50。

### queueCapacity：队列容量

**无界队列（默认 Integer.MAX_VALUE）：** 任务堆积会 OOM
**有界队列：** 设太小（比如 10）频繁触发拒绝策略；设太大（比如 10000）任务延迟高

我们设 200，平衡内存和延迟。

### rejectedExecutionHandler：拒绝策略

| 策略 | 行为 | 适用场景 |
|------|------|---------|
| AbortPolicy | 抛异常 | 不允许丢任务 |
| CallerRunsPolicy | 调用者线程执行 | 不丢任务，降速 |
| DiscardPolicy | 静默丢弃 | 可丢弃的非关键任务 |
| DiscardOldestPolicy | 丢弃最老的 | 优先处理最新任务 |

**smemp-service 选 CallerRunsPolicy：** 工单通知不能丢，但可以降速。队列满时由调用者线程执行，相当于背压。

**踩坑：** 早期用 AbortPolicy，高峰期队列满直接抛异常，工单通知丢失，用户投诉。

### 线程名前缀

```java
executor.setThreadNamePrefix("smemp-async-");
```

排查问题时能快速定位是哪个线程池的线程。没有前缀的话，线程名是 `pool-1-thread-1`，看不出来源。

### 优雅关闭

```java
executor.setWaitForTasksToCompleteOnShutdown(true);
executor.setAwaitTerminationSeconds(30);
```

服务关闭时：
- 不再接收新任务
- 等待队列中的任务执行完
- 最多等 30 秒

没有优雅关闭的话，服务重启时队列中的任务会丢失。

## 监控线程池

```java
@Component
public class ThreadPoolMonitor implements ScheduledTaskExecutor {

    @Autowired
    @Qualifier("taskExecutor")
    private ThreadPoolTaskExecutor executor;

    @Scheduled(fixedRate = 60000)  // 每分钟打印一次
    public void monitor() {
        ThreadPoolExecutor threadPool = executor.getThreadPoolExecutor();
        log.info("线程池状态: 活跃线程={}, 池大小={}, 队列积压={}, 已完成任务={}",
            threadPool.getActiveCount(),
            threadPool.getPoolSize(),
            threadPool.getQueue().size(),
            threadPool.getCompletedTaskCount());
    }
}
```

**Grafana 看板：**
- 活跃线程数：正常 < 核心线程数，高峰期接近最大线程数
- 队列积压：正常 0，高峰期 < 100，接近 200 就要告警
- 已完成任务数：趋势图，能看出任务量变化

## 教训

1. **不要用 Executors 工具类**，阿里规范强制要求自定义线程池
2. **队列必须有界**，无界队列是定时炸弹
3. **拒绝策略要根据业务选**，不能无脑丢弃
4. **线程池要监控**，不监控就不知道有没有问题
5. **优雅关闭必须配**，不然重启丢任务

# RabbitMQ 消费者卡死——用 MAT 看线程状态

> 2026-01-17

## 现象

smemp-service 的 RabbitMQ 消费者突然不消费了，RabbitMQ 管理后台看到 `order.event.queue` 队列积压 10 万条。重启后恢复，过几小时又复现。

这次不是 OOM，内存没爆，但怀疑和线程有关。

## 排查过程

### Arthas 在线 dump

不想重启，用 Arthas 在线导出：

```bash
java -jar arthas-boot.jar
# 选择 smemp-service 进程

heapdump /tmp/smemp-thread.hprof
```

### Thread Overview

MAT 菜单 → Query Browser → Thread Overview：

发现 50 个 `rabbit-consumer-*` 线程，全部状态是 `WAITING`，调用栈：

```
at java.lang.Object.wait(Native Method)
at java.util.concurrent.LinkedBlockingQueue.take(LinkedBlockingQueue.java:442)
at com.enn.smemp.mq.OrderEventConsumer.handleMessage(OrderEventConsumer.java:38)
```

50 个消费者线程全卡在 `LinkedBlockingQueue.take()` 上。

### Histogram 辅助验证

Histogram 里看到 `LinkedBlockingQueue` 的 `Node` 数量：

| Class | Objects | Retained Heap |
|-------|---------|---------------|
| java.util.concurrent.LinkedBlockingQueue$Node | 1,000 | 120 KB |

队列容量 1000，刚好满了。

### 查代码

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
                    processEvent(event);
                }
            }, "rabbit-consumer-" + i).start();
        }
    }

    private void processEvent(OrderEvent event) {
        // 调下游服务，偶尔超时 30 秒
        orderService.updateOrderStatus(event.getOrderId(), event.getStatus());
        notifyService.sendNotification(event);
    }
}
```

### 根因链路

```
下游服务偶尔超时 30 秒
    ↓
processEvent() 卡住，50 个线程都被卡住
    ↓
内部队列 1000 个位置满了
    ↓
onMessage() 的 queue.put() 阻塞
    ↓
RabbitMQ 消费者线程也被阻塞
    ↓
整个消费链路停了
```

问题是 `processEvent()` 里调下游服务偶尔超时 30 秒，50 个线程都被卡住，内部队列满了，`onMessage()` 的 `queue.put()` 阻塞，RabbitMQ 消费者线程也被阻塞，整个消费链路停了。

## 修复

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
            throw e; // 重试或进死信队列
        }
    }
}
```

RabbitMQ 原生支持并发消费，不需要自己搞内部队列。concurrency 设 `10-50`，RabbitMQ 自动根据积压量动态扩缩消费者线程。

## 教训

1. **Thread Overview 不只是看内存**，线程状态分析也是 MAT 的重要用途
2. **不要自己搞内部队列**，RabbitMQ 本身就有并发消费能力
3. **有界队列 + 下游超时 = 反压**，这是经典的生产者-消费者死锁模式
4. **Arthas 在线 dump** 是不想重启时的好帮手

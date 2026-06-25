# RabbitMQ 消费者卡死——有界队列反压问题

> 2026-01-17

## 现象

smemp-service 的 RabbitMQ 消费者突然不消费了，RabbitMQ 管理后台看到 `order.event.queue` 队列积压 10 万条。重启后恢复，过几小时又复现。

## 排查过程

### Arthas 在线 dump

不想重启，用 Arthas 在线导出：

```bash
java -jar arthas-boot.jar
# 选择 smemp-service 进程

heapdump /tmp/smemp-thread.hprof
```

### MAT Thread Overview

MAT 菜单 → Query Browser → Thread Overview：

发现 50 个 `rabbit-consumer-*` 线程，全部状态是 `WAITING`，调用栈：

```
at java.lang.Object.wait(Native Method)
at java.util.concurrent.LinkedBlockingQueue.take(LinkedBlockingQueue.java:442)
at com.enn.smemp.mq.OrderEventConsumer.handleMessage(OrderEventConsumer.java:38)
```

50 个消费者线程全卡在 `LinkedBlockingQueue.take()` 上。

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

## 问题分析

### 为什么用内部队列？

最初的想法是"解耦"：RabbitMQ 消费者线程只负责接收，内部线程池负责处理。这样 RabbitMQ 消费者线程不会被业务逻辑阻塞。

### 为什么出问题？

1. **有界队列 + 下游超时 = 反压**：下游偶尔超时 30 秒，50 个线程都被卡住，队列满了，`put()` 阻塞，RabbitMQ 消费者也被阻塞
2. **自己实现的并发消费不如 RabbitMQ 原生**：RabbitMQ 本身就有 `concurrency` 参数支持并发消费

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

### 参数说明

- `concurrency = "10-50"`：最小 10 个消费者线程，最大 50 个
- RabbitMQ 根据队列积压量动态扩缩：积压少时 10 个线程，积压多时扩到 50
- 不需要自己搞内部队列，RabbitMQ 原生支持

### prefetch 参数

```java
@RabbitListener(queues = "order.event.queue", concurrency = "10-50", prefetch = 200)
```

- `prefetch = 200`：每次从队列取 200 条
- 设太小（比如 1）：消费者频繁取消息，网络开销大
- 设太大（比如 10000）：内存压力大，且不公平（处理慢的消费者会积压）

## 手动 ACK 配置

```yaml
spring:
  rabbitmq:
    listener:
      simple:
        acknowledge-mode: manual  # 手动 ACK
        prefetch: 200
```

```java
@RabbitListener(queues = "order.event.queue", concurrency = "10-50")
public void onMessage(Message message, Channel channel) throws IOException {
    try {
        processEvent(message);
        channel.basicAck(message.getMessageProperties().getDeliveryTag(), false);
    } catch (Exception e) {
        channel.basicNack(message.getMessageProperties().getDeliveryTag(), false, true);
    }
}
```

**手动 ACK 的好处：**
- 处理成功才 ack，处理失败 nack 重试
- 避免自动 ACK 时消费者崩溃导致消息丢失

## 教训

1. **不要自己搞内部队列**，RabbitMQ 本身就有并发消费能力
2. **有界队列 + 下游超时 = 反压**，这是经典的生产者-消费者死锁模式
3. **Thread Overview 不只是看内存**，线程状态分析也是 MAT 的重要用途
4. **手动 ACK** 是消息可靠性的基础

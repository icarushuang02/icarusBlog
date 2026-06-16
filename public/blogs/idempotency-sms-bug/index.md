## 问题

最近生产上出了一个 bug。同事写了一段批量发短信的代码，逻辑看起来没毛病：查未发送的用户 → 发短信 → 循环直到全部发完。

```java
private int sendSmsToUsersByBatch(Long gasOutageRecordId, Integer userType,
        String messageTemplate, String companyCode, Integer cityId) {
    int totalSent = 0;
    int batchSize = 100;

    while (true) {
        // 查询未发送用户（状态=0）
        List<UserDetail> userList = mdGasOutUserDetailService
                .queryUnsentSmsUsersByBatch(gasOutageRecordId, userType, batchSize);

        if (CollectionUtils.isEmpty(userList)) { break; }

        for (UserDetail user : userList) {
            // 构建并发送短信 ...
            smsService.sendSmsToUsersByBatch(smsInputPo);
            totalSent++;
        }

        if (userList.size() < batchSize) { break; }
    }

    // 批量更新发送状态
    mdGasOutUserDetailService.batchUpdateSmsDeliveryStatus(
            gasOutageRecordId, userType, smsDeliveryStatus);

    return totalSent;
}
```

结果：**同一个客户收到了 100 条一模一样的短信。**

---

## 问题在哪？

看出来了吗？

`batchUpdateSmsDeliveryStatus`（更新发送状态）是在 `while` 循环**外面**调用的。

这意味着什么？每一轮循环查出来的都是"未发送"的同一批用户，因为状态一直没更新。第一轮发了 100 条，但数据库里的状态还是 0。第二轮查出来的还是这 100 个人，又发一遍。循环 100 次，同一个客户就收到了 100 条短信。

---

## 架构师的解法

架构师看了代码说了一句话：

> **你应该在发短信之前，就默认已经发过了。**

什么意思？不是先发再更新状态，而是**先更新状态再发短信**。如果发送失败，再回滚状态。

```java
for (UserDetail user : userList) {
    // 1. 先标记为"已发送"（默认已经发过了）
    mdGasOutUserDetailService.markAsSending(user.getId());

    try {
        // 2. 然后才发短信
        smsService.sendSmsToUsersByBatch(smsInputPo);
    } catch (Exception e) {
        // 3. 发送失败，回滚状态
        mdGasOutUserDetailService.markAsFailed(user.getId());
    }
}
```

这样即使程序崩溃在发送之后、更新状态之前，最坏的结果是"状态标记为已发送但实际没发出去"，而不是"发了 100 遍"。

**漏发一条可以补发，多发一条没法撤回。**

---

## 这种思维叫什么？

这种思维方式有几个名字，本质上是同一件事：

### 幂等性（Idempotency）

同一个操作执行一次和执行多次，结果是一样的。

- ❌ 当前代码：发短信不是幂等的，发 100 次就是 100 条短信
- ✅ 修复后：先标记状态再发送，重复执行只会重复标记（状态已经是"发送中"了），不会重复发短信

### 乐观锁（Optimistic Locking）的变体

不是用数据库锁来防并发，而是**用状态前置来防重复**。先占位，再做事。做完了确认，做失败了回滚。

### 防御性编程（Defensive Programming）

**假设最坏的情况一定会发生。** 程序可能在任何一行崩溃、网络可能在任何时刻断开、数据库可能在任何操作中超时。

原代码的假设是：循环能正常跑完，最后统一更新状态。但现实是程序可能在循环中途崩溃，状态没更新，下次又发一遍。

---

## 更通用的模式

这个 bug 背后的模式在很多场景下都会出现：

**支付回调：** 第三方支付通知你"用户已付款"，你更新订单状态。但如果你先发货再更新状态，回调重复通知就会重复发货。

**消息消费：** MQ 消费者处理消息，先处理业务再 ACK。如果处理完但 ACK 前崩溃了，消息会被重新投递，重复处理。

**定时任务：** 定时任务查询待处理数据，处理完更新状态。如果任务超时被重新调度，同一批数据会被处理两次。

解法都是一样的：**状态前置 + 失败回滚。**

---

## 总结

这次 bug 给我最大的启发不是技术细节，而是思维方式的转变：

**不要想"成功了之后怎么办"，要想"失败了会怎样"。**

原代码的思路是：发完短信 → 更新状态。这是从成功路径出发的思考方式。

架构师的思路是：先占位 → 再做事 → 失败了回滚。这是从失败路径出发的思考方式。

后者才是生产环境该有的思维。因为在生产环境里，**任何可能出错的地方，一定会出错。**

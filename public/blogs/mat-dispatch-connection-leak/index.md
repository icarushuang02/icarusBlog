# 派工模块数据库连接泄漏排查

> 2025-08-22

## 现象

周一下午高峰期，smemp-service 报了一堆 `HikariPool-1 - Connection is not available, request timed out after 30000ms`。连接池打满了，但监控显示 QPS 并没有特别高，比上周同期还低。

## 排查过程

### 手动 dump

当时服务还在跑，没 OOM，但连接池打满了。手动 dump：

```bash
jps -l
# 找到 smemp-service 的 PID

jmap -dump:format=b,file=/tmp/smemp-conn-leak.hprof <PID>
```

### OQL 直接查连接数

Histogram 翻起来太慢，直接用 OQL 查 HikariCP 连接对象：

```sql
SELECT * FROM com.zaxxer.hikari.pool.HikariProxyConnection
```

结果：**237 个连接对象**。连接池 `maximumPoolSize` 配的 20，怎么可能有 237 个？

### Path to GC Roots 追踪

右键其中一个连接 → Path to GC Roots → exclude weak/soft references：

```
HikariProxyConnection @ 0x7c8a2b3c0
  ↑ value in ThreadLocal$ThreadLocalMap$Entry @ 0x7c8a2b400
  ↑ table of ThreadLocalMap @ 0x7c8a2b440
  ↑ threadLocals of Thread @ 0x7c8a2b480 "dubbo-thread-35"
```

连接被 `ThreadLocal` 持有了。看了下这个线程的调用栈，执行的是 `DispatchServiceImpl.assignWorker()` 方法。

### 查代码

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

### 用 OQL 验证泄漏规模

```sql
SELECT * FROM com.zaxxer.hikari.pool.HikariProxyConnection
```

237 个连接，按 Path to GC Roots 分组，发现分布在 237 个不同的 Dubbo 线程里。每个线程都执行过 `assignWorker()`，连接都没归还。

## 根因

`assignWorker()` 方法获取连接后没有在 `finally` 块中关闭，ThreadLocal 也没有清理。Dubbo 线程池复用导致连接泄漏。

正常情况下连接池 20 个连接够用，但泄漏后每次调用都"借"一个连接不还，几天下来就耗尽了。

## 修复

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

## 教训

1. **ThreadLocal 必须配对使用（set/finally remove）**，这是铁律
2. **连接泄漏用 OQL 查最直接**，`SELECT * FROM HikariProxyConnection` 一下就能看到数量是否异常
3. **Path to GC Roots 是确认泄漏的终极手段**，追到线程级才能定位到代码
4. **异常分支最容易漏 close**，写代码时先写 finally 再写业务逻辑

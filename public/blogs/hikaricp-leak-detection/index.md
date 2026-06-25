# HikariCP 泄漏检测实战——从日志告警到 MAT 定位

> 2025-06-10

## 背景

smemp-service 上线 HikariCP 泄漏检测后，生产日志开始出现告警：

```
WARN  com.zaxxer.hikari.proxy.ConnectionProxy - Connection com.mysql.cj.jdbc.ConnectionImpl@7c8a2b3c0 
(has been abandoned for 62,345ms) is being returned to the pool
```

这意味着有连接超过 60 秒没归还。虽然连接最终被回收了，但高峰期会导致连接池耗尽。

## 配置泄漏检测

在 `application.yml` 中开启：

```yaml
spring:
  datasource:
    hikari:
      maximum-pool-size: 20
      minimum-idle: 5
      connection-timeout: 30000
      leak-detection-threshold: 60000  # 60 秒未归还就告警
```

**参数说明：**
- `leak-detection-threshold`：设 0 表示不检测，设太小（比如 1000）会有很多误报（正常慢查询也会触发）
- 生产环境建议 60 秒，比 `connection-timeout`（30 秒）大，避免和超时告警混淆

## 排查过程

### 从日志定位到代码

告警日志里有连接对象的 hashCode，但没有调用栈。需要用 MAT 分析 heap dump。

### OQL 查泄漏的连接

```sql
SELECT * FROM com.zaxxer.hikari.pool.HikariProxyConnection
```

查出 237 个连接对象，远超 `maximumPoolSize`（20）。说明有连接没归还。

### Path to GC Roots 追踪

右键其中一个连接 → Path to GC Roots → exclude weak/soft references：

```
HikariProxyConnection @ 0x7c8a2b3c0
  ↑ value in ThreadLocal$ThreadLocalMap$Entry @ 0x7c8a2b400
  ↑ table of ThreadLocalMap @ 0x7c8a2b440
  ↑ threadLocals of Thread @ 0x7c8a2b480 "dubbo-thread-35"
```

连接被 ThreadLocal 持有。查调用栈，执行的是 `DispatchServiceImpl.assignWorker()`。

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

## 根因

1. `assignWorker()` 获取连接后没有在 `finally` 块中关闭
2. ThreadLocal 也没有清理
3. Dubbo 线程池复用，线程不销毁，连接一直被 ThreadLocal 持有

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
        CONN_HOLDER.remove();
    }
}
```

## HikariCP 参数调优思考

### maximum-pool-size：不是越大越好

公式：`最大连接数 = (CPU 核数 * 2) + 有效磁盘数`

我们 4 核机器，设 20 留有余量。设太大（比如 100）反而会：
- MySQL 连接数有上限（默认 151）
- 连接切换开销增大
- 每个连接占内存（MySQL 每个连接约 1MB）

### max-lifetime：避免 MySQL 断开连接

```yaml
max-lifetime: 1800000  # 30 分钟
```

MySQL 的 `wait_timeout` 默认 8 小时。如果连接存活超过 `wait_timeout`，MySQL 会主动断开，但 HikariCP 不知道，下次用就会报错。

设 `max-lifetime` 比 `wait_timeout` 小，HikariCP 会主动回收老连接，避免被 MySQL 断开。

### idle-timeout：回收空闲连接

```yaml
idle-timeout: 600000  # 10 分钟
```

空闲连接超过 10 分钟就回收。低峰期减少连接数，释放 MySQL 资源。

### connection-timeout：获取连接超时

```yaml
connection-timeout: 30000  # 30 秒
```

超过 30 秒获取不到连接就抛异常。设太短（比如 1 秒）高峰期容易超时；设太长（比如 5 分钟）用户等不起。

## 教训

1. **leak-detection-threshold 是生产必配**，不配就不知道有泄漏
2. **ThreadLocal + 连接是经典泄漏模式**，用完必须 finally close + remove
3. **HikariCP 参数要根据机器配置调**，不是默认值就最优
4. **MAT 的 OQL 查连接对象**是定位连接泄漏的最快方式

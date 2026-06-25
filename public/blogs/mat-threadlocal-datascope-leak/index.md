# ThreadLocal 慢泄漏——数据权限上下文排查

> 2026-03-20

## 现象

smemp-service 运行一周后，内存缓慢增长，没有 OOM 但 Full GC 频率从一天一次变成一天四次。不是爆发式的，是慢性的，重启后又从头开始涨。

这种慢泄漏比 OOM 更难查，因为不会自动 dump。

## 排查过程

### 两个时间点手动 dump

```bash
# 第一次 dump（重启后 2 小时）
jmap -dump:format=b,file=/tmp/smemp-t1.hprof <PID>

# 第二次 dump（重启后 48 小时）
jmap -dump:format=b,file=/tmp/smemp-t2.hprof <PID>
```

### Compare Heap Dumps 对比

MAT 打开 t1 → Navigation History → 右键 → Add to Compare Basket
打开 t2 → 同样加入 Compare Basket → Compare the Results

| Class | Dump 1 (2h) | Dump 2 (48h) | 增量 |
|-------|-------------|--------------|------|
| com.enn.smemp.common.context.DataScope | 800 | 34,560 | +33,760 |
| java.lang.ThreadLocal$ThreadLocalMap | 120 | 1,890 | +1,770 |
| java.lang.Thread | 85 | 85 | 0 |

`DataScope` 从 800 增长到 34560，增长了 43 倍。线程数没变（85），说明不是线程泄漏，而是 ThreadLocal 里的值在堆积。

### Histogram 查 incoming references

按 `DataScope` 查 incoming references：

```
DataScope @ 0x7c5a6b8d0
  ↑ value in ThreadLocal$ThreadLocalMap$Entry @ 0x7c5a6b900
  ↑ table of ThreadLocalMap @ 0x7c5a6b940
  ↑ threadLocals of Thread @ 0x7c5a6b980 "dubbo-thread-12"
```

每个 Dubbo 线程的 ThreadLocalMap 里都残留了多个 `DataScope` 对象。

### OQL 验证

```sql
SELECT * FROM com.enn.smemp.common.context.DataScope
```

34560 个 `DataScope` 实例，每个大约 200 字节，总共约 7MB。单个不大，但 GC Root 链导致它们无法回收，每次 Full GC 都要扫描这些对象，拖慢 GC。

### Path to GC Roots 确认

```
DataScope @ 0x7c5a6b8d0
  ↑ value in ThreadLocal$ThreadLocalMap$Entry @ 0x7c5a6b900
  ↑ table of ThreadLocalMap @ 0x7c5a6b940
  ↑ threadLocals of Thread @ 0x7c5a6b980 "dubbo-thread-12"
  ↑ (GC Root: Thread 对象)
```

ThreadLocalMap 的 Entry 的 key（DataScope 对象的弱引用）已经被 GC 回收了，但 value（DataScope 实例）是强引用，不会被回收。随着请求量增加，残留的 value 越来越多。

### 查代码

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

`preHandle` 里 set 了，但没有在 `afterCompletion` 里 `remove()`。Dubbo 线程池复用，ThreadLocalMap 里的 Entry 的 key 是弱引用被 GC 回收了，但 value（DataScope）是强引用，不会被回收。

## 根因

ThreadLocal 设值后没有清理，Dubbo 线程复用导致 value 堆积。单个对象小（200 字节），但数量多（3.4 万），GC 扫描开销大，Full GC 频率上升。

## 修复

```java
@Override
public void afterCompletion(HttpServletRequest request, 
                            HttpServletResponse response,
                            Object handler, Exception ex) {
    DATA_SCOPE_HOLDER.remove(); // 必须清理
}
```

同时加了防御性检查：

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

## 教训

1. **Compare Heap Dumps 是慢泄漏的利器**，两个时间点对比，增长异常的一目了然
2. **ThreadLocal 是 Java 内存泄漏的重灾区**，用完必须 remove()
3. **ThreadLocal 的 key 是弱引用但 value 是强引用**，key 被回收后 value 还在，这就是泄漏的根因
4. **慢泄漏不会触发 OOM**，但会拖慢 GC，影响系统稳定性

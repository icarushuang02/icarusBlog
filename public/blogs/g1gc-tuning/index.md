# G1 GC 调优——从 Full GC 频繁到一天一次

> 2026-02-10

## 背景

smemp-service 上线后，Full GC 从一天一次变成一天四次。GC 日志显示 Mixed GC 频繁，但堆内存使用率并不高。

## GC 日志分析

### 开启 GC 日志

```bash
-Xloggc:/data/logs/gc.log
-XX:+PrintGCDetails
-XX:+PrintGCDateStamps
-XX:+PrintGCTimeStamps
-XX:+PrintGCApplicationStoppedTime
```

### 日志内容

```
2026-02-10T10:15:23.456+0800: 12345.678: [GC pause (G1 Evacuation Pause) (young) 12345.678: [Eden: 1024M(1024M)->0B(1024M) Survivors: 128M->128M Heap: 2048M(4096M)->1024M(4096M)]
2026-02-10T10:15:25.789+0800: 12347.012: [GC pause (G1 Evacuation Pause) (mixed) 12347.012: [Eden: 1024M(1024M)->0B(1024M) Survivors: 128M->128M Heap: 2048M(4096M)->1024M(4096M)]
```

**问题：**
- Mixed GC 频率太高（每 2 秒一次）
- 堆使用率才 50%（2048M/4096M），不应该这么频繁

## 参数分析

### 原始配置

```bash
-Xmx4g -Xms4g
-XX:+UseG1GC
-XX:MaxGCPauseMillis=200
-XX:InitiatingHeapOccupancyPercent=45
```

### 问题定位

`InitiatingHeapOccupancyPercent=45`：堆使用 45% 就触发并发标记。

我们的堆 4GB，45% 是 1.8GB。系统运行时堆使用经常在 2GB 左右，刚好超过阈值，所以频繁触发并发标记和 Mixed GC。

## 调优方案

### 方案一：提高触发阈值

```bash
-XX:InitiatingHeapOccupancyPercent=65
```

堆使用 65%（2.6GB）才触发并发标记。调整后 Mixed GC 频率从每 2 秒降到每 30 秒。

### 方案二：调整 Region 大小

```bash
-XX:G1HeapRegionSize=8m
```

默认 Region 大小是堆大小 / 2048。4GB 堆默认 Region 是 2MB。

增大到 8MB 后：
- 大对象（> 4MB）可以直接分配在 Humongous Region，不用连续 Region
- 减少 Region 数量，降低 GC 扫描开销

### 方案三：调整目标停顿时间

```bash
-XX:MaxGCPauseMillis=100
```

默认 200ms，调到 100ms 后：
- G1 会更积极地回收，减少每次 GC 的停顿时间
- 但 GC 频率会增加

**权衡：** 我们选择保持 200ms，因为业务对延迟不敏感，更在意 GC 频率。

## 最终配置

```bash
-Xmx4g -Xms4g
-XX:+UseG1GC
-XX:MaxGCPauseMillis=200
-XX:G1HeapRegionSize=8m
-XX:InitiatingHeapOccupancyPercent=65
-XX:G1ReservePercent=15
-XX:ConcGCThreads=4
-XX:ParallelGCThreads=8
```

### 参数说明

| 参数 | 值 | 说明 |
|------|-----|------|
| MaxGCPauseMillis | 200 | 目标停顿时间 200ms |
| G1HeapRegionSize | 8m | Region 大小 8MB |
| InitiatingHeapOccupancyPercent | 65 | 堆使用 65% 触发并发标记 |
| G1ReservePercent | 15 | 预留 15% 内存防晋升失败 |
| ConcGCThreads | 4 | 并发标记线程数 |
| ParallelGCThreads | 8 | 并行回收线程数 |

## 调优效果

| 指标 | 调优前 | 调优后 |
|------|--------|--------|
| Full GC 频率 | 4 次/天 | 1 次/天 |
| Mixed GC 频率 | 每 2 秒 | 每 30 秒 |
| 平均 GC 停顿 | 150ms | 120ms |
| CPU 使用率 | 35% | 25% |

## G1 GC 原理

### Region 划分

G1 把堆划分为多个大小相等的 Region（默认 2048 个）：
- Eden Region：新生代
- Survivor Region：存活区
- Old Region：老年代
- Humongous Region：大对象（> Region 大小 / 2）

### GC 流程

1. **Young GC**：回收 Eden 和 Survivor
2. **并发标记**：标记存活对象
3. **Mixed GC**：回收 Eden、Survivor 和部分 Old
4. **Full GC**：整堆回收（尽量避免）

### 调优思路

**目标：** 减少 Full GC，控制 Mixed GC 频率

**手段：**
- 提高 `InitiatingHeapOccupancyPercent`：延迟并发标记触发
- 增大 `G1HeapRegionSize`：减少 Region 数量
- 调整 `ConcGCThreads`：并发标记更快完成
- 设置 `G1ReservePercent`：预留内存防晋升失败

## 教训

1. **GC 日志必须开**，不看日志就不知道 GC 状态
2. **InitiatingHeapOccupancyPercent 不是越低越好**，太低会频繁 Mixed GC
3. **Region 大小要根据堆大小调**，大堆用大 Region
4. **调优要观察一周**，看效果再决定是否继续调
5. **Full GC 不可避免**，目标是减少频率而不是消除

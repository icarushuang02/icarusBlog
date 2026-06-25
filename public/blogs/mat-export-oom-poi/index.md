# 工单导出 OOM——POI 大对象内存分析

> 2025-11-08

## 现象

运营同事在后台批量导出工单数据，选择了"全部导出"（约 50 万条）。点击导出后，smemp-service 内存飙升，触发了 OOM，服务重启。

## 排查过程

### Leak Suspects Report

自动 dump 拿到文件 3.5GB，MAT 打开后 Leak Suspects：

```
Problem Suspect 1:
  1 instance of "com.enn.smemp.service.export.WorkOrderExporter"
  loaded by "sun.misc.Launcher$AppClassLoader @ 0x7c0000000"
  occupy 1,200,000,000 (78.5%) bytes.

  Keywords: com.enn.smemp.service.export.WorkOrderExporter
```

一个 `WorkOrderExporter` 实例占了 1.2GB？不对，一个导出器不该这么大。

### Histogram 定位大对象

| Class | Objects | Retained Heap |
|-------|---------|---------------|
| byte[] | 5,234,567 | 980 MB |
| org.apache.poi.xssf.usermodel.XSSFCell | 3,500,000 | 420 MB |
| org.apache.poi.xssf.usermodel.XSSFRow | 500,000 | 180 MB |
| java.lang.String | 4,890,000 | 350 MB |

50 万行 × 7 列 = 350 万个 Cell 对象，全在内存里。POI 的 `XSSFWorkbook` 是内存型的，50 万行直接把堆撑爆。

### Dominator Tree 确认

```
WorkOrderExporter @ 0x7c1a2b3c0
  Retained Heap: 1.2 GB
  
  └─ org.apache.poi.xssf.usermodel.XSSFWorkbook @ 0x7c2d3e4f0
       Retained Heap: 1.18 GB
       └─ XSSFSheet → XSSFRow → XSSFCell → byte[] / String
```

`XSSFWorkbook` 把整张表加载到内存，50 万行数据全在堆里。

## 根因

```java
public void exportAll(HttpServletResponse response) {
    // 查出全部 50 万条工单
    List<WorkOrderVO> allOrders = workOrderMapper.selectAll();
    
    // 全部加载到 XSSFWorkbook 内存
    XSSFWorkbook workbook = new XSSFWorkbook();
    XSSFSheet sheet = workbook.createSheet("工单数据");
    
    int rowIdx = 0;
    for (WorkOrderVO order : allOrders) {
        XSSFRow row = sheet.createRow(rowIdx++);
        row.createCell(0).setCellValue(order.getOrderId());
        row.createCell(1).setCellValue(order.getCityName());
        // ... 7 列
    }
    
    workbook.write(response.getOutputStream());
}
```

两个问题：
1. `selectAll()` 一次性查出 50 万条，List 本身占几百 MB
2. `XSSFWorkbook` 是内存型，350 万个 Cell 全在堆里

## 修复

改用 **SXSSFWorkbook**（流式写入，内存只保留 N 行滑动窗口）+ **分页查询**：

```java
public void exportAll(HttpServletResponse response) {
    try (SXSSFWorkbook workbook = new SXSSFWorkbook(100)) {
        SXSSFSheet sheet = workbook.createSheet("工单数据");
        
        // 表头
        SXSSFRow header = sheet.createRow(0);
        header.createCell(0).setCellValue("工单号");
        header.createCell(1).setCellValue("城市");
        // ...
        
        int rowIdx = 1;
        int page = 0;
        int pageSize = 5000;
        
        List<WorkOrderVO> batch;
        do {
            batch = workOrderMapper.selectPage(page * pageSize, pageSize);
            for (WorkOrderVO order : batch) {
                SXSSFRow row = sheet.createRow(rowIdx++);
                row.createCell(0).setCellValue(order.getOrderId());
                // ...
            }
            page++;
        } while (batch.size() == pageSize);
        
        workbook.write(response.getOutputStream());
        workbook.dispose(); // 清理临时文件
    }
}
```

修复后测试导出 50 万条，内存峰值从 1.2GB 降到 80MB。

## 教训

1. **XSSFWorkbook 是内存型，SXSSFWorkbook 是流式型**，大数据量导出必须用后者
2. **大数据量查询必须分页**，selectAll 是定时炸弹
3. **Leak Suspects + Histogram 组合**，先定位到 Exporter，再看内部哪个对象大，两步搞定

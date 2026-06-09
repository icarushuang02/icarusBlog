---
title: Spring Boot + Dubbo 微服务集成 IM 即时通讯的完整实践
date: 2026-06-05
tags: [Java, Spring Boot, Dubbo, 即时通讯, 架构设计, IM, MyBatis]
categories: 后端开发
---

## 一、需求背景

售后服务场景下，师傅上门服务前需要与用户沟通确认时间、地址等信息。系统需要支持：

1. 师傅查看与用户的对话记录
2. 师傅发送文本/图片/语音消息
3. 未读消息提醒和轮询
4. 消息已读标记
5. 消息角标汇总（最新一条消息 + 未读数）

我们对接了一个独立部署的 IM 通讯服务，本文记录了从零集成的完整过程，包括架构设计、接口封装、数据组装、Mapper 规范和踩坑经验。

---

## 二、整体架构设计

### 2.1 系统架构

```
┌─────────────────────────────────────────────────────────────────┐
│                          前端 APP                                │
└───────────────────────────┬─────────────────────────────────────┘
                            │ HTTP
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Web 层 (Spring MVC)                          │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  AiReminderController                                   │    │
│  │  - /queryMessageSessionInfoList  查询消息会话            │    │
│  │  - /sendMessage                  发送消息                │    │
│  │  - /queryChatSessionPage         会话分页列表            │    │
│  │  - /queryUnReadSessionList       未读会话轮询            │    │
│  └──────────────────────────┬──────────────────────────────┘    │
│                             │ 参数校验、鉴权、masterId 提取      │
└─────────────────────────────┼───────────────────────────────────┘
                              │ Dubbo RPC
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Service 层 (Dubbo Provider)                    │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  ChatServerServiceImpl                                   │    │
│  │  - getToken()                    Token 管理              │    │
│  │  - getSessionSummary()           角标汇总                │    │
│  │  - getMessageSessionList()       消息会话查询            │    │
│  │  - sendMessage()                 发送消息                │    │
│  │  - querySessionList()            会话列表                │    │
│  │  - queryUnReadSessionList()      未读轮询                │    │
│  │  - setMessageRead()              已读标记                │    │
│  └───────┬──────────────────────────────┬──────────────────┘    │
│          │                              │                       │
│          │ HTTP                         │ Dubbo                 │
│          ▼                              ▼                       │
│  ┌──────────────┐           ┌──────────────────────┐            │
│  │  IM 服务      │           │  本地业务服务          │            │
│  │  (外部)       │           │  - WorkOrderInfo     │            │
│  │  - Token      │           │  - TaskDetail        │            │
│  │  - 消息收发    │           │  - EmployeeInfo      │            │
│  │  - 会话管理    │           │  - AiReminder        │            │
│  └──────────────┘           └──────────────────────┘            │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 模块划分

```
ecej-smemp-service (Dubbo Provider)
├── ecej-smemp-service-api              # 接口定义 + DTO
│   ├── api/requestthird/
│   │   └── ChatServerService.java      # 服务接口
│   └── dto/requestthird/
│       ├── MessageSessionQueryDTO      # 会话查询入参
│       ├── MessageSessionInfoVO        # 会话查询出参
│       ├── ChatMessageVO               # 消息 VO
│       └── SendMessageDTO              # 发送消息入参
│
├── ecej-smemp-service-core             # 数据层
│   ├── mapper/
│   │   └── SmempAiReminderPOMapper     # 基础 CRUD（MBG 生成）
│   └── po/
│       └── SmempAiReminderPO           # 实体
│
└── ecej-smemp-service-provider         # 服务实现
    ├── mapper/
    │   └── SmempAiReminderPOExtendMapper  # 自定义查询
    ├── impl/requestthird/
    │   └── ChatServerServiceImpl          # IM 核心实现
    └── impl/appredesign/
        └── AiReminderServiceImpl          # 消息提醒实现

ecej-smemp-web (Spring MVC Consumer)
└── controller/appredesign/
    └── AiReminderController              # HTTP 接口
```

### 2.3 依赖注入关系

```java
// Web 层通过 Dubbo 注入 Service
@Resource
private ChatServerService chatServerService;

// Service 层注入本地业务服务
@Resource
private WorkOrderInfoService workOrderInfoService;
@Resource
private SvcUserLevelTaskDetailService scSvcUserLevelTaskDetailService;

// Service 层注入 IM 服务配置
@Resource
private SmartCompanionProperties smartCompanionProperties;  // baseUrl, appId, appSecret
@Autowired
@Qualifier("restTemplate")
private RestTemplate restTemplate;
@Resource
private RedisTemplate<String, String> redisTemplate;

// Mapper 注入（注意区分基础 Mapper 和 Extend Mapper）
@Resource
private SmempAiReminderPOMapper smempAiReminderPOMapper;          // 基础 CRUD
@Resource
private SmempAiReminderPOExtendMapper smempAiReminderPOExtendMapper;  // 自定义查询
```

---

## 三、功能实现详解

### 3.1 Token 管理

IM 服务使用 Token 鉴权，有效期有限。用 Redis 做缓存，过期前 5 分钟自动刷新。

#### 配置类

```java
@Data
@Component
@ConfigurationProperties(prefix = "im.api")
public class ImProperties {
    private String baseUrl;
    private String appId;
    private String appSecret;
}
```

#### 流程

```
getToken()
    │
    ├── 1. 查 Redis 缓存 (key: "im:token")
    │       ├── 命中 → 直接返回
    │       └── 未命中 → 继续
    │
    ├── 2. POST /token 请求 IM 服务
    │       入参: { appId, appSecret }
    │       出参: { token, expiresIn }
    │
    ├── 3. 写入 Redis，TTL = expiresIn - 300
    │
    └── 4. 返回 token
```

#### 伪代码

```java
public String getToken() {
    String cachedToken = redis.get("im:token");
    if (cachedToken != null) return cachedToken;

    JSONObject body = new JSONObject();
    body.put("appId", properties.getAppId());
    body.put("appSecret", properties.getAppSecret());

    String response = restTemplate.post(baseUrl + "/token", body);
    JSONObject result = JSON.parseObject(response);

    if (result.getInteger("code") == 0) {
        JSONObject data = result.getJSONObject("data");
        String token = data.getString("token");
        Long expiresIn = data.getLong("expiresIn");

        long cacheTime = expiresIn != null ? expiresIn - 300 : 3500;
        redis.set("im:token", token, cacheTime, TimeUnit.SECONDS);
        return token;
    }
    return null;
}
```

---

### 3.2 角标汇总（getSessionSummary）

查询未读消息数和最新一条消息摘要，用于消息列表的角标展示。

#### 返回结构

```json
{
    "unreadCount": 3,
    "messageSummary": {
        "sessionId": "sess_001",
        "userInfo": { "userId": "u_001", "name": "张三", "avatar": "..." },
        "masterInfo": { "masterId": "m_001", "name": "李师傅", "avatar": "..." },
        "messageVO": {
            "content": "您好，请问明天上午可以上门维修吗？",
            "createTimeMs": 1780035545000,
            ...
        }
    },
    "createTimeMs": 1780035545000
}
```

#### 伪代码

```java
public Map<String, Object> getSessionSummary(String masterId) {
    Map<String, Object> result = new HashMap<>();
    result.put("unreadCount", 0);
    result.put("messageSummary", null);

    String token = getToken();
    if (token == null) return result;

    String url = baseUrl + "/session/summary?masterId=" + masterId;
    String response = restTemplate.get(url, token);
    JSONObject jsonResult = JSON.parseObject(response);

    if (jsonResult.getInteger("code") == 0) {
        JSONObject data = jsonResult.getJSONObject("data");
        if (data != null) {
            result.put("unreadCount", data.getInteger("unreadCount"));
            result.put("messageSummary", data.get("messageSummary"));

            // createTimeMs 提升到顶层，方便消费端直接使用
            JSONObject messageSummary = data.getJSONObject("messageSummary");
            if (messageSummary != null) {
                JSONObject messageVO = messageSummary.getJSONObject("messageVO");
                if (messageVO != null) {
                    result.put("createTimeMs", messageVO.getLong("createTimeMs"));
                }
            }
        }
    }
    return result;
}
```

#### 消费端使用

```java
// 直接用时间戳构造 Date，不再解析字符串
Map<String, Object> summary = chatServerService.getSessionSummary(empId);
Object createTimeMs = summary.get("createTimeMs");
if (createTimeMs instanceof Number) {
    dto.setCreateTime(new Date(((Number) createTimeMs).longValue()));
}
```

**踩坑**：之前用 `new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss").parse(createTime.toString())` 解析 ISO 8601 格式，既冗长又容易出错。改为直接用时间戳 `createTimeMs`，一步到位。

---

### 3.3 消息会话列表查询

最复杂的功能，串联 IM 接口和本地业务数据。

#### 调用链路

```
前端请求
    │  POST /v1/aiReminder/queryMessageSessionInfoList
    │  入参: token, orderId, orderType, sessionId?, mobile?, messageId?, pageSize?, loadNewer?
    ▼
┌─────────────────────────────────────────────────────────┐
│  Web 层                                                 │
│  1. 校验 orderId, orderType 非空                        │
│  2. sessionId/mobile 互斥（有 sessionId 不传 mobile）   │
│  3. 从 token 提取 masterId                              │
│  4. 组装 DTO，调用 Service                              │
└──────────────────────────┬──────────────────────────────┘
                           │ Dubbo
                           ▼
┌─────────────────────────────────────────────────────────┐
│  Service 层                                             │
│  1. 获取 Token                                          │
│  2. 组装 IM 请求参数（空值不传）                         │
│  3. POST /session/info/list                             │
│  4. 解析响应：sessionId, userInfo, masterInfo, list     │
│  5. 查询订单地址（本地业务数据）                         │
│  6. 组装返回                                            │
└─────────────────────────────────────────────────────────┘
```

#### 伪代码 - Service 层

```java
public SessionInfoVO getMessageSessionList(SessionQueryDTO queryDTO) {
    SessionInfoVO vo = new SessionInfoVO();
    String token = getToken();
    if (token == null) return vo;

    // 组装请求参数
    JSONObject body = new JSONObject();
    body.put("masterId", queryDTO.getMasterId());
    body.put("orderId", queryDTO.getOrderId());
    body.put("orderType", queryDTO.getOrderType());
    body.put("pageSize", queryDTO.getPageSize() != null ? queryDTO.getPageSize() : 10);

    // sessionId/mobile 互斥
    if (isNotBlank(queryDTO.getSessionId())) {
        body.put("sessionId", queryDTO.getSessionId());
    } else if (isNotBlank(queryDTO.getMobile())) {
        body.put("mobile", queryDTO.getMobile());
    }

    // 调用 IM 服务
    String response = restTemplate.post(baseUrl + "/session/info/list", body, token);
    JSONObject result = JSON.parseObject(response);

    if (result.getInteger("code") == 0) {
        JSONObject data = result.getJSONObject("data");
        vo.setSessionId(data.getString("sessionId"));
        vo.setAllowSendMessage(data.getBooleanValue("allowSendMessage"));
        vo.setOrderCategory(data.getString("orderCategory"));
        vo.setUserInfo(parseUserInfo(data.getJSONObject("userInfo")));
        vo.setMasterInfo(parseMasterInfo(data.getJSONObject("masterInfo")));

        // 查询订单地址
        vo.setOrderAddress(queryOrderAddress(queryDTO.getOrderId(), queryDTO.getOrderType()));

        // 解析消息列表
        vo.setList(parseMessages(data.getJSONArray("list")));
    }
    return vo;
}
```

#### 伪代码 - 订单地址查询

```java
private String queryOrderAddress(String orderId, Integer orderType) {
    if (isBlank(orderId)) return null;

    if (orderType == 2) {
        // 专项单：orderId 是 userLevelTaskDetailId
        TaskDetail task = taskDetailService.selectById(Integer.valueOf(orderId));
        return task != null ? task.getServeAddr() : null;
    } else {
        // 日常单：orderId 是 workOrderNo
        WorkOrder workOrder = workOrderService.findByOrderNo(orderId);
        return workOrder != null ? workOrder.getDetailAddress() : null;
    }
}
```

#### 伪代码 - Web 层

```java
@PostMapping("/queryMessageSessionInfoList")
public Result queryMessageSessionInfoList(
        @RequestParam String token,
        @RequestParam String orderId,
        @RequestParam Integer orderType,
        @RequestParam(required = false) String sessionId,
        @RequestParam(required = false) String mobile,
        @RequestParam(required = false) Long messageId,
        @RequestParam(required = false, defaultValue = "10") Integer pageSize,
        @RequestParam(required = false, defaultValue = "false") Boolean loadNewer
) {
    if (isBlank(orderId)) return Result.fail("orderId不能为空");
    if (orderType == null) return Result.fail("orderType不能为空");
    if (isNotBlank(sessionId)) mobile = null;

    EmpInfo empInfo = tokenService.findEmpInfo(token);

    SessionQueryDTO queryDTO = new SessionQueryDTO();
    queryDTO.setMasterId(String.valueOf(empInfo.getEmpId()));
    queryDTO.setOrderId(orderId);
    queryDTO.setOrderType(orderType);
    queryDTO.setSessionId(sessionId);
    queryDTO.setMobile(mobile);
    queryDTO.setMessageId(messageId);
    queryDTO.setPageSize(pageSize);
    queryDTO.setLoadNewer(loadNewer);

    return Result.ok(chatServerService.getMessageSessionList(queryDTO));
}
```

---

### 3.4 消息分页加载（游标分页）

IM 服务使用**游标分页**，比传统 `pageNum/pageSize` 更适合消息场景。

#### 参数

| 参数 | 说明 |
|------|------|
| `messageId` | 游标：某条消息的 ID |
| `loadNewer` | `true` 向上（更新消息），`false` 向下（更旧消息） |

#### 流程图

```
消息时间线（从新到旧）：

  msg30 ← 最新
  ...
  msg20 ← 首次加载返回的最新一条
  ...
  msg11 ← 首次加载返回的最旧一条
  ...
  msg1  ← 最旧

首次加载：  messageId=null,  loadNewer=false
           → 返回 [msg20 ~ msg11]

上拉加载：  messageId=11,    loadNewer=false
           → 返回 [msg10 ~ msg1]

下拉刷新：  messageId=20,    loadNewer=true
           → 返回 [msg30 ~ msg21]
```

#### 前端实现

```javascript
// 首次加载
loadFirst() {
    fetchMessages({ messageId: null, loadNewer: false, pageSize: 10 });
}

// 上拉加载更多（更旧消息）
loadOlder() {
    const oldestId = messages[messages.length - 1].id;
    fetchMessages({ messageId: oldestId, loadNewer: false, pageSize: 10 });
}

// 下拉刷新（更新消息）
loadNewer() {
    const newestId = messages[0].id;
    fetchMessages({ messageId: newestId, loadNewer: true, pageSize: 10 });
}
```

---

### 3.5 发送消息

#### 伪代码

```java
// Service 层
public ChatMessageVO sendMessage(SendMessageDTO sendDTO) {
    String token = getToken();
    if (token == null) return null;

    JSONObject body = new JSONObject();
    body.put("masterId", sendDTO.getMasterId());
    body.put("sessionId", sendDTO.getSessionId());
    body.put("msgType", sendDTO.getMsgType());   // 1文本 2图片 3语音 4视频 5文件
    body.put("content", sendDTO.getContent());

    String response = restTemplate.post(baseUrl + "/message/send", body, token);
    JSONObject result = JSON.parseObject(response);

    if (result.getInteger("code") == 0) {
        JSONObject data = result.getJSONObject("data");
        ChatMessageVO vo = new ChatMessageVO();
        vo.setId(data.getLong("id"));
        vo.setSessionId(data.getString("sessionId"));
        vo.setSenderId(data.getString("senderId"));
        vo.setSenderType(data.getInteger("senderType"));
        vo.setMsgType(data.getInteger("msgType"));
        vo.setContent(data.getString("content"));
        vo.setCreateTimeMs(data.getLong("createTimeMs"));
        return vo;
    }
    return null;
}

// Web 层
@PostMapping("/sendMessage")
public Result sendMessage(
        @RequestParam String token,
        @RequestParam String sessionId,
        @RequestParam Integer msgType,
        @RequestParam String content
) {
    if (isBlank(sessionId)) return Result.fail("sessionId不能为空");
    if (msgType == null) return Result.fail("msgType不能为空");
    if (isBlank(content)) return Result.fail("content不能为空");

    EmpInfo empInfo = tokenService.findEmpInfo(token);

    SendMessageDTO sendDTO = new SendMessageDTO();
    sendDTO.setMasterId(String.valueOf(empInfo.getEmpId()));
    sendDTO.setSessionId(sessionId);
    sendDTO.setMsgType(msgType);
    sendDTO.setContent(content);

    ChatMessageVO result = chatServerService.sendMessage(sendDTO);
    return result != null ? Result.ok(result) : Result.fail("发送失败");
}
```

---

### 3.6 未读消息轮询

#### 伪代码

```java
public List<UnReadSessionDTO> queryUnReadSessionList(String empId) {
    String token = getToken();
    if (token == null) return Collections.emptyList();

    String url = baseUrl + "/session/list/summary?masterId=" + empId;
    String response = restTemplate.get(url, token);
    JSONObject result = JSON.parseObject(response);

    if (result.getInteger("code") == 0) {
        JSONArray data = result.getJSONArray("data");
        List<UnReadSessionDTO> list = new ArrayList<>();
        for (int i = 0; i < data.size(); i++) {
            JSONObject item = data.getJSONObject(i);
            UnReadSessionDTO dto = new UnReadSessionDTO();
            dto.setOrderId(item.getString("orderId"));
            dto.setOrderType(item.getInteger("orderType"));
            dto.setSessionId(item.getString("sessionId"));
            dto.setIsRead(item.getInteger("isRead"));
            dto.setMobile(item.getString("mobile"));
            list.add(dto);
        }
        return list;
    }
    return Collections.emptyList();
}
```

---

## 四、MyBatis Mapper 规范

### 4.1 基础 Mapper vs Extend Mapper

项目使用 MyBatis Generator (MBG) 生成基础 Mapper，自定义查询放到 Extend Mapper。

```
ecej-smemp-service-core/
└── mapper/
    └── SmempAiReminderPOMapper.java      # MBG 生成，不要手动修改

ecej-smemp-service-provider/
└── mapper/
    └── SmempAiReminderPOExtendMapper.java # 自定义查询放这里
```

### 4.2 错误示范

```java
// ❌ 在 MBG 生成的 Mapper 里加自定义方法
public interface SmempAiReminderPOMapper {
    // MBG 生成的基础方法
    int insert(SmempAiReminderPO record);
    List<SmempAiReminderPO> selectByExample(...);

    // ❌ 不应该加在这里
    List<Map<String, Object>> selectUnreadCountByType(Integer empId);
    List<SmempAiReminderPO> selectLatestByType(Integer empId);
}
```

### 4.3 正确做法

```java
// ✅ 基础 Mapper（MBG 生成，不手动修改）
public interface SmempAiReminderPOMapper {
    int insert(SmempAiReminderPO record);
    List<SmempAiReminderPO> selectByExample(...);
    // ...
}

// ✅ 自定义查询放 Extend Mapper
public interface SmempAiReminderPOExtendMapper {
    List<Map<String, Object>> selectUnreadCountByType(Integer empId);
    List<SmempAiReminderPO> selectLatestByType(Integer empId);
}
```

### 4.4 XML 对应关系

```
ecej-smemp-service-core/src/main/resources/mybatis/mapper/
└── SmempAiReminderPOMapper.xml           # 基础 SQL（MBG 生成）

ecej-smemp-service-provider/src/main/resources/mybatis/mapper/
└── SmempAiReminderPOExtendMapper.xml     # 自定义 SQL
```

### 4.5 注入方式

```java
// 基础 Mapper
@Resource
private SmempAiReminderPOMapper smempAiReminderPOMapper;

// 自定义查询 Mapper
@Resource
private SmempAiReminderPOExtendMapper smempAiReminderPOExtendMapper;

// 使用
List<SmempAiReminderPO> list = smempAiReminderPOExtendMapper.selectLatestByType(empId);
```

---

## 五、DTO 定义

### 5.1 入参

```java
// 消息会话查询
@Data
public class SessionQueryDTO implements Serializable {
    private String masterId;
    private String orderId;
    private Integer orderType;         // 1日常单 2专项单
    private String userId;
    private String mobile;
    private String sessionId;
    private Long messageId;            // 游标
    private Integer pageSize = 10;
    private Boolean loadNewer = false;
}

// 发送消息
@Data
public class SendMessageDTO implements Serializable {
    private String masterId;
    private String sessionId;
    private Integer msgType;           // 1文本 2图片 3语音 4视频 5文件
    private String content;
}
```

### 5.2 出参

```java
// 会话信息
@Data
public class SessionInfoVO implements Serializable {
    private String sessionId;
    private UserInfoVO userInfo;
    private MasterInfoVO masterInfo;
    private Boolean allowSendMessage;
    private String orderCategory;
    private String orderAddress;
    private List<ChatMessageVO> list;

    @Data
    public static class UserInfoVO implements Serializable {
        private String userId;
        private String name;
        private String avatar;
    }

    @Data
    public static class MasterInfoVO implements Serializable {
        private String masterId;
        private String name;
        private String avatar;
    }
}

// 消息
@Data
public class ChatMessageVO implements Serializable {
    private Long id;
    private String sessionId;
    private String orderId;
    private String senderId;
    private Integer senderType;        // 1师傅 2客户
    private String receiverId;
    private Integer msgType;
    private String content;
    private Integer isRead;
    private Date readTime;
    private Integer isRecalled;
    private Date createTime;
    private Long createTimeMs;
}
```

---

## 六、踩坑总结

### 6.1 Mapper 方法放错位置

自定义查询方法（如 `selectUnreadCountByType`）放到 MBG 生成的 Mapper 里，下次重新生成时会被覆盖。必须放到 Extend Mapper。

### 6.2 过滤结果未使用

```java
// ❌ 过滤了但后面还在用原始数据
List<DTO> filtered = filter(list);
result.setData(list);  // 应该用 filtered

// ✅ 过滤后替换引用
list = filter(list);
result.setData(list);
```

### 6.3 SimpleDateFormat 解析 ISO 8601

```java
// ❌ 冗长且易错
new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss").parse(createTime.toString())

// ✅ 直接用时间戳
new Date(createTimeMs)

// ✅ 或用项目工具类
DateUtil.parse(createTimeStr)
```

### 6.4 getString 对嵌套 JSONObject 的兼容性

```java
// ❌ 某些 fastjson 版本下 data 是 JSONObject 时 getString 可能返回 null
String dataStr = jsonObject.getString("data");
JSONObject data = JSON.parseObject(dataStr);  // NPE

// ✅ 直接取嵌套对象
JSONObject data = jsonObject.getJSONObject("data");
```

### 6.5 sessionId 和 mobile 互斥

IM 服务的会话查询接口中，`sessionId` 和 `mobile` 不能同时传。有 `sessionId` 时优先用 `sessionId`。

### 6.6 日常单和专项单的 ID 语义不同

| 类型 | orderId 语义 | 查询方法 | 地址字段 |
|------|-------------|---------|---------|
| 日常单 | workOrderNo (String) | findByOrderNo | detailAddress |
| 专项单 | userLevelTaskDetailId (Integer) | selectById | serveAddr |

### 6.7 日志规范

```java
// ❌ error 日志不要用 {} 占位符打多余信息
log.error("查询失败, empId: {}", empId, e);

// ✅ 直接打异常堆栈
log.error("查询失败", e);
```

### 6.8 可选参数不能传 null 给外部服务

```java
// ❌ null 值也会被序列化
body.put("userId", queryDTO.getUserId());

// ✅ 空值不传
if (isNotBlank(queryDTO.getUserId())) {
    body.put("userId", queryDTO.getUserId());
}
```

---

## 七、接口清单

| 接口 | Method | 说明 |
|------|--------|------|
| `/v1/aiReminder/queryMessageSessionInfoList` | POST | 查询消息会话列表 |
| `/v1/aiReminder/sendMessage` | POST | 师傅发送消息 |
| `/v1/aiReminder/queryChatSessionPage` | POST | 会话分页列表 |
| `/v1/aiReminder/queryUnReadSessionList` | POST | 未读会话轮询 |

---

## 八、总结

### 核心设计原则

1. **Token 统一管理**：Redis 缓存 + 提前刷新
2. **Service 层封装**：外部 HTTP 接口封装为 Dubbo 接口
3. **业务数据组装**：IM 返回消息，本地补充订单信息
4. **Web 层参数校验**：必填校验、互斥参数、masterId 从 token 提取
5. **游标分页**：消息场景比传统分页更流畅
6. **Mapper 规范**：基础 CRUD 放 MBG Mapper，自定义查询放 Extend Mapper
7. **时间处理**：优先用时间戳 `createTimeMs`，避免字符串解析
8. **防御性编程**：空值判断、异常捕获、日志追踪

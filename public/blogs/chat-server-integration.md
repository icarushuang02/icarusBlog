---
title: Spring Boot + Dubbo 微服务集成 IM 即时通讯的完整实践
date: 2026-06-04
tags: [Java, Spring Boot, Dubbo, 即时通讯, 架构设计, IM]
categories: 后端开发
---

## 一、需求背景

售后服务场景下，师傅上门服务前需要与用户沟通确认时间、地址等信息。系统需要支持：

1. 师傅查看与用户的对话记录
2. 师傅发送文本/图片/语音消息
3. 未读消息提醒和轮询
4. 消息已读标记

我们对接了一个独立部署的 IM 通讯服务，本文记录了从零集成的完整过程。

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
│  │  - 会话管理    │           │                      │            │
│  └──────────────┘           └──────────────────────┘            │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 模块划分

```
ecej-smemp-service (Dubbo Provider)
├── ecej-smemp-service-api          # 接口定义 + DTO
│   ├── api/requestthird/
│   │   └── ChatServerService.java  # 服务接口
│   └── dto/requestthird/
│       ├── MessageSessionQueryDTO  # 会话查询入参
│       ├── MessageSessionInfoVO    # 会话查询出参
│       ├── ChatMessageVO           # 消息 VO
│       └── SendMessageDTO          # 发送消息入参
│
└── ecej-smemp-service-provider     # 服务实现
    └── impl/requestthird/
        └── ChatServerServiceImpl   # 核心实现

ecej-smemp-web (Spring MVC Consumer)
└── controller/appredesign/
    └── AiReminderController        # HTTP 接口
```

### 2.3 依赖注入关系

```java
// Web 层通过 Dubbo 注入 Service
@Resource
private ChatServerService chatServerService;

// Service 层注入本地业务服务
@Resource
private WorkOrderInfoService workOrderInfoService;      // 工单查询
@Resource
private SvcUserLevelTaskDetailService scSvcUserLevelTaskDetailService;  // 专项单查询

// Service 层注入 IM 服务配置
@Resource
private SmartCompanionProperties smartCompanionProperties;  // baseUrl, appId, appSecret
@Autowired
@Qualifier("restTemplate")
private RestTemplate restTemplate;                          # HTTP 客户端
@Resource
private RedisTemplate<String, String> redisTemplate;        # Token 缓存
```

## 三、功能实现详解

### 3.1 Token 管理

IM 服务使用 Token 鉴权，有效期有限。我们用 Redis 做了缓存，过期前 5 分钟自动刷新。

#### 配置类

```java
@Data
@Component
@ConfigurationProperties(prefix = "im.api")
public class ImProperties {
    private String baseUrl;    // IM 服务地址
    private String appId;      // 应用 ID
    private String appSecret;  // 应用密钥
}
```

#### 完整流程

```
getToken()
    │
    ├── 1. 查 Redis 缓存 (key: "im:token")
    │       ├── 命中 → 直接返回 token
    │       └── 未命中 → 继续
    │
    ├── 2. POST /token 请求 IM 服务
    │       入参: { appId, appSecret }
    │       出参: { token, expiresIn }
    │
    ├── 3. 写入 Redis 缓存
    │       TTL = expiresIn - 300 (提前 5 分钟过期)
    │       兜底: expiresIn 为 null 时 TTL = 3500s
    │
    └── 4. 返回 token
```

#### 伪代码

```java
public String getToken() {
    // 1. 查缓存
    String cachedToken = redis.get("im:token");
    if (cachedToken != null) {
        return cachedToken;
    }

    // 2. 调用 IM 服务
    JSONObject body = new JSONObject();
    body.put("appId", properties.getAppId());
    body.put("appSecret", properties.getAppSecret());

    HttpHeaders headers = new HttpHeaders();
    headers.setContentType(MediaType.APPLICATION_JSON);
    HttpEntity<String> request = new HttpEntity<>(body.toJSONString(), headers);

    ResponseEntity<String> response = restTemplate.exchange(
        properties.getBaseUrl() + "/token", HttpMethod.POST, request, String.class);

    if (response.getStatusCode() == HttpStatus.OK && response.getBody() != null) {
        JSONObject result = JSON.parseObject(response.getBody());
        if (result.getInteger("code") == 0) {
            JSONObject data = result.getJSONObject("data");
            String token = data.getString("token");
            Long expiresIn = data.getLong("expiresIn");

            // 3. 缓存
            long cacheTime = expiresIn != null ? expiresIn - 300 : 3500;
            redis.set("im:token", token, cacheTime, TimeUnit.SECONDS);

            return token;
        }
    }
    return null;
}
```

#### 踩坑记录

| 问题 | 原因 | 解决 |
|------|------|------|
| Token 频繁失效 | 缓存时间 = expiresIn，刚好过期时请求失败 | 提前 5 分钟刷新：`expiresIn - 300` |
| `expiresIn` 为 null | IM 服务版本变更，字段可能不返回 | 兜底默认 3500s |
| Token 缓存 key 冲突 | 多个业务共用 Redis | 加业务前缀 `im:token` |

---

### 3.2 消息会话列表查询

这是最复杂的功能，需要串联 IM 接口和本地业务数据。

#### 完整调用链路

```
前端请求
    │
    │  POST /v1/aiReminder/queryMessageSessionInfoList
    │  入参: token, orderId, orderType, sessionId?, mobile?, messageId?, pageSize?, loadNewer?
    │
    ▼
┌─────────────────────────────────────────────────────────┐
│  Web 层 - AiReminderController                          │
│                                                          │
│  1. 参数校验                                              │
│     - orderId 不能为空                                    │
│     - orderType 不能为空                                  │
│     - sessionId 和 mobile 互斥（有 sessionId 不传 mobile）│
│                                                          │
│  2. 从 token 提取 masterId                               │
│     EmpInfo empInfo = tokenService.findEmpInfo(token);   │
│     String masterId = String.valueOf(empInfo.getEmpId());│
│                                                          │
│  3. 组装 DTO，调用 Service                               │
└──────────────────────────┬──────────────────────────────┘
                           │ Dubbo
                           ▼
┌─────────────────────────────────────────────────────────┐
│  Service 层 - ChatServerServiceImpl.getMessageSessionList│
│                                                          │
│  1. 获取 Token (Redis 缓存)                              │
│                                                          │
│  2. 组装 IM 接口请求参数                                  │
│     { masterId, orderId, orderType, pageSize, ... }      │
│     空值不传，不阻断流程                                   │
│                                                          │
│  3. POST /chat-server/api/.../session/info/list          │
│                                                          │
│  4. 解析 IM 响应                                         │
│     ├── sessionId, allowSendMessage, orderCategory       │
│     ├── userInfo (userId, name, avatar)                  │
│     ├── masterInfo (masterId, name, avatar)              │
│     └── list[] (消息列表)                                │
│                                                          │
│  5. 查询订单地址（本地业务数据）                            │
│     ├── orderType=1 日常单 → findByOrderNo → detailAddr  │
│     └── orderType=2 专项单 → selectById → serveAddr      │
│                                                          │
│  6. 组装返回                                             │
└─────────────────────────────────────────────────────────┘
```

#### 伪代码 - Service 层核心逻辑

```java
public SessionInfoVO getMessageSessionList(SessionQueryDTO queryDTO) {
    SessionInfoVO vo = new SessionInfoVO();
    vo.setAllowSendMessage(false);
    vo.setList(Collections.emptyList());

    // 1. 获取 Token
    String token = getToken();
    if (token == null) {
        log.error("IM token 获取失败");
        return vo;
    }

    try {
        // 2. 组装请求参数
        JSONObject body = new JSONObject();
        body.put("masterId", queryDTO.getMasterId());
        body.put("orderId", queryDTO.getOrderId());
        body.put("orderType", queryDTO.getOrderType());
        body.put("pageSize", queryDTO.getPageSize() != null ? queryDTO.getPageSize() : 10);
        body.put("loadNewer", queryDTO.getLoadNewer() != null ? queryDTO.getLoadNewer() : false);

        // 可选参数：空值不传
        if (isNotBlank(queryDTO.getUserId())) {
            body.put("userId", queryDTO.getUserId());
        }
        // sessionId 和 mobile 互斥
        if (isNotBlank(queryDTO.getSessionId())) {
            body.put("sessionId", queryDTO.getSessionId());
        } else if (isNotBlank(queryDTO.getMobile())) {
            body.put("mobile", queryDTO.getMobile());
        }
        if (queryDTO.getMessageId() != null) {
            body.put("messageId", queryDTO.getMessageId());
        }

        // 3. 调用 IM 服务
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.set("Authorization", "Bearer " + token);
        HttpEntity<String> request = new HttpEntity<>(body.toJSONString(), headers);

        log.info("调用IM消息会话列表接口：入参：{}", body.toJSONString());
        ResponseEntity<String> response = restTemplate.exchange(
            imBaseUrl + "/session/info/list", HttpMethod.POST, request, String.class);

        // 4. 解析响应
        if (response.getStatusCode() == HttpStatus.OK && response.getBody() != null) {
            JSONObject jsonResult = JSON.parseObject(response.getBody());
            log.info("调用IM消息会话列表接口：出参：{}", response.getBody());

            if (jsonResult.getInteger("code") == 0) {
                JSONObject data = jsonResult.getJSONObject("data");
                if (data != null) {
                    // 基础字段
                    vo.setSessionId(data.getString("sessionId"));
                    vo.setAllowSendMessage(data.getBooleanValue("allowSendMessage"));
                    vo.setOrderCategory(data.getString("orderCategory"));

                    // 用户信息
                    JSONObject userInfoObj = data.getJSONObject("userInfo");
                    if (userInfoObj != null) {
                        UserInfoVO userInfo = new UserInfoVO();
                        userInfo.setUserId(userInfoObj.getString("userId"));
                        userInfo.setName(userInfoObj.getString("name"));
                        userInfo.setAvatar(userInfoObj.getString("avatar"));
                        vo.setUserInfo(userInfo);
                    }

                    // 师傅信息
                    JSONObject masterInfoObj = data.getJSONObject("masterInfo");
                    if (masterInfoObj != null) {
                        MasterInfoVO masterInfo = new MasterInfoVO();
                        masterInfo.setMasterId(masterInfoObj.getString("masterId"));
                        masterInfo.setName(masterInfoObj.getString("name"));
                        masterInfo.setAvatar(masterInfoObj.getString("avatar"));
                        vo.setMasterInfo(masterInfo);
                    }

                    // 5. 查询订单地址
                    vo.setOrderAddress(queryOrderAddress(
                        queryDTO.getOrderId(), queryDTO.getOrderType()));

                    // 6. 解析消息列表
                    JSONArray messageList = data.getJSONArray("list");
                    if (messageList != null && !messageList.isEmpty()) {
                        vo.setList(parseMessages(messageList));
                    }
                }
            }
        }
    } catch (Exception e) {
        log.error("调用IM消息会话列表接口异常", e);
    }
    return vo;
}
```

#### 伪代码 - 订单地址查询

```java
private String queryOrderAddress(String orderIdStr, Integer orderType) {
    if (isBlank(orderIdStr)) {
        return null;
    }

    if (orderType == 2) {
        // 专项单：orderId 是 userLevelTaskDetailId
        Integer orderId = Integer.valueOf(orderIdStr);
        TaskDetail task = taskDetailService.selectById(orderId);
        return task != null ? task.getServeAddr() : null;
    } else {
        // 日常单：orderId 是 workOrderNo
        WorkOrder workOrder = workOrderService.findByOrderNo(orderIdStr);
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
        @RequestParam(required = false) String userId,
        @RequestParam(required = false) String mobile,
        @RequestParam(required = false) String sessionId,
        @RequestParam(required = false) Long messageId,
        @RequestParam(required = false, defaultValue = "10") Integer pageSize,
        @RequestParam(required = false, defaultValue = "false") Boolean loadNewer
) {
    // 1. 参数校验
    if (isBlank(orderId)) return Result.fail("orderId不能为空");
    if (orderType == null) return Result.fail("orderType不能为空");

    // 2. sessionId/mobile 互斥
    if (isNotBlank(sessionId)) {
        mobile = null;
    }

    // 3. 从 token 提取 masterId
    EmpInfo empInfo = tokenService.findEmpInfo(token);

    // 4. 组装 DTO
    SessionQueryDTO queryDTO = new SessionQueryDTO();
    queryDTO.setMasterId(String.valueOf(empInfo.getEmpId()));
    queryDTO.setOrderId(orderId);
    queryDTO.setOrderType(orderType);
    queryDTO.setUserId(userId);
    queryDTO.setMobile(mobile);
    queryDTO.setSessionId(sessionId);
    queryDTO.setMessageId(messageId);
    queryDTO.setPageSize(pageSize);
    queryDTO.setLoadNewer(loadNewer);

    // 5. 调用 Service
    SessionInfoVO result = chatServerService.getMessageSessionList(queryDTO);
    return Result.ok(result);
}
```

---

### 3.3 消息分页加载机制（游标分页）

IM 服务使用**游标分页**，比传统 `pageNum/pageSize` 更适合消息场景。

#### 原理

```
传统分页：pageNum=1, pageSize=10 → 第 1~10 条
         pageNum=2, pageSize=10 → 第 11~20 条
         问题：新增消息会导致分页错位

游标分页：以某条消息 ID 为基准，向前或向后取 N 条
         不受新增消息影响，定位精确
```

#### 参数说明

| 参数 | 类型 | 说明 |
|------|------|------|
| `messageId` | Long | 游标：某条消息的 ID |
| `loadNewer` | Boolean | `true` = 向上加载更新消息，`false` = 向下加载更旧消息 |
| `pageSize` | Integer | 每页条数 |

#### 加载流程图

```
消息时间线（从新到旧）：

  msg30 ← 最新
  msg29
  msg28
  msg27
  msg26
  msg25
  msg24
  msg23
  msg22
  msg21
  msg20 ← 首次加载返回的最新一条
  msg19
  msg18
  msg17
  msg16
  msg15
  msg14
  msg13
  msg12
  msg11 ← 首次加载返回的最旧一条
  msg10
  ...
  msg1  ← 最旧

┌─────────────────────────────────────────────────────────────┐
│  首次进入页面                                                 │
│  请求: { messageId: null, loadNewer: false, pageSize: 10 }   │
│  返回: [msg20, msg19, msg18, ..., msg11]                     │
└─────────────────────────────────────────────────────────────┘
                          │
                          │ 用户上拉加载更多
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  加载更旧消息                                                 │
│  请求: { messageId: 11, loadNewer: false, pageSize: 10 }     │
│  返回: [msg10, msg9, msg8, ..., msg1]                        │
└─────────────────────────────────────────────────────────────┘
                          │
                          │ 用户下拉刷新
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  加载更新消息                                                 │
│  请求: { messageId: 20, loadNewer: true, pageSize: 10 }      │
│  返回: [msg30, msg29, msg28, ..., msg21]                     │
└─────────────────────────────────────────────────────────────┘
```

#### 前端实现建议

```javascript
// 首次加载
function loadFirst() {
    fetchMessages({ messageId: null, loadNewer: false, pageSize: 10 });
}

// 上拉加载更多（更旧消息）
function loadOlder() {
    const oldestId = messages[messages.length - 1].id;
    fetchMessages({ messageId: oldestId, loadNewer: false, pageSize: 10 });
}

// 下拉刷新（更新消息）
function loadNewer() {
    const newestId = messages[0].id;
    fetchMessages({ messageId: newestId, loadNewer: true, pageSize: 10 });
}
```

---

### 3.4 发送消息

#### 完整流程

```
前端请求
    │  POST /v1/aiReminder/sendMessage
    │  入参: token, sessionId, msgType, content
    ▼
┌─────────────────────────────────────────────┐
│  Web 层                                      │
│  1. 校验 sessionId, msgType, content 非空    │
│  2. 从 token 提取 masterId                   │
│  3. 组装 SendMessageDTO                      │
└──────────────────┬──────────────────────────┘
                   │ Dubbo
                   ▼
┌─────────────────────────────────────────────┐
│  Service 层                                  │
│  1. 获取 Token                               │
│  2. POST /message/send                       │
│     入参: { masterId, sessionId, msgType, content }│
│  3. 解析返回的 MessageVO                     │
└─────────────────────────────────────────────┘
```

#### 伪代码

```java
// Service 层
public ChatMessageVO sendMessage(SendMessageDTO sendDTO) {
    String token = getToken();
    if (token == null) return null;

    JSONObject body = new JSONObject();
    body.put("masterId", sendDTO.getMasterId());
    body.put("sessionId", sendDTO.getSessionId());
    body.put("msgType", sendDTO.getMsgType());
    body.put("content", sendDTO.getContent());

    // 调用 IM 服务
    ResponseEntity<String> response = restTemplate.exchange(
        imBaseUrl + "/message/send", HttpMethod.POST,
        new HttpEntity<>(body.toJSONString(), headers), String.class);

    if (response.getStatusCode() == HttpStatus.OK && response.getBody() != null) {
        JSONObject result = JSON.parseObject(response.getBody());
        if (result.getInteger("code") == 0) {
            JSONObject data = result.getJSONObject("data");
            // 映射到 VO
            ChatMessageVO vo = new ChatMessageVO();
            vo.setId(data.getLong("id"));
            vo.setSessionId(data.getString("sessionId"));
            vo.setSenderId(data.getString("senderId"));
            vo.setSenderType(data.getInteger("senderType"));
            vo.setMsgType(data.getInteger("msgType"));
            vo.setContent(data.getString("content"));
            vo.setCreateTime(data.getDate("createTime"));
            vo.setCreateTimeMs(data.getLong("createTimeMs"));
            return vo;
        }
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
    // 参数校验
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
    if (result == null) return Result.fail("发送失败");
    return Result.ok(result);
}
```

---

### 3.5 未读消息轮询

前端定时轮询，获取有未读消息的会话列表。

#### 伪代码

```java
// Service 层
public List<UnReadSessionDTO> queryUnReadSessionList(String empId) {
    String token = getToken();
    if (token == null) return Collections.emptyList();

    // GET 请求，masterId 拼在 URL 上
    String url = imBaseUrl + "/session/list/summary?masterId=" + empId;
    ResponseEntity<String> response = restTemplate.exchange(
        url, HttpMethod.GET, new HttpEntity<>(headers), String.class);

    if (response.getStatusCode() == HttpStatus.OK && response.getBody() != null) {
        JSONObject result = JSON.parseObject(response.getBody());
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
    }
    return Collections.emptyList();
}

// Web 层
@PostMapping("/queryUnReadSessionList")
public Result queryUnReadSessionList(@RequestParam String token) {
    EmpInfo empInfo = tokenService.findEmpInfo(token);
    List<UnReadSessionDTO> list = chatServerService.queryUnReadSessionList(
        String.valueOf(empInfo.getEmpId()));
    return Result.ok(list);
}
```

---

### 3.6 消息已读标记

#### 伪代码

```java
// Service 层
public Boolean setMessageRead(String empId, String sessionId) {
    String token = getToken();
    if (token == null) return false;

    Map<String, Object> body = new HashMap<>();
    body.put("masterId", empId);
    if (isNotBlank(sessionId)) {
        body.put("sessionId", sessionId);
    }

    ResponseEntity<String> response = restTemplate.exchange(
        imBaseUrl + "/session/info/read", HttpMethod.POST,
        new HttpEntity<>(JSON.toJSONString(body), headers), String.class);

    if (response.getStatusCode() == HttpStatus.OK && response.getBody() != null) {
        JSONObject result = JSON.parseObject(response.getBody());
        if (result.getInteger("code") == 0) {
            JSONObject data = result.getJSONObject("data");
            return data != null && data.getBoolean("result");
        }
    }
    return false;
}
```

---

## 四、DTO 完整定义

### 4.1 入参 DTO

```java
// 消息会话查询
@Data
public class SessionQueryDTO implements Serializable {
    private String masterId;           // 师傅ID（从 token 获取）
    private String orderId;            // 单号
    private Integer orderType;         // 1日常单 2专项单
    private String userId;             // 用户ID（可选）
    private String mobile;             // 手机号（可选，与 sessionId 互斥）
    private String sessionId;          // 会话ID（可选，与 mobile 互斥）
    private Long messageId;            // 消息ID 游标（可选）
    private Integer pageSize = 10;     // 每页条数
    private Boolean loadNewer = false; // 加载方向
}

// 发送消息
@Data
public class SendMessageDTO implements Serializable {
    private String masterId;    // 师傅ID
    private String sessionId;   // 会话ID
    private Integer msgType;    // 消息类型 1文本 2图片 3语音 4视频 5文件
    private String content;     // 消息内容
}
```

### 4.2 出参 VO

```java
// 会话信息
@Data
public class SessionInfoVO implements Serializable {
    private String sessionId;              // 会话ID
    private UserInfoVO userInfo;           // 用户信息
    private MasterInfoVO masterInfo;       // 师傅信息
    private Boolean allowSendMessage;      // 是否允许发送消息
    private String orderCategory;          // 下单品类
    private String orderAddress;           // 订单地址
    private List<ChatMessageVO> list;      // 消息列表

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
    private Long id;                // 消息ID
    private String sessionId;       // 会话ID
    private String orderId;         // 订单号
    private String senderId;        // 发送者ID
    private Integer senderType;     // 1师傅 2客户
    private String receiverId;      // 接收者ID
    private Integer msgType;        // 1文本 2图片 3语音 4视频 5文件
    private String content;         // 消息内容
    private Integer isRead;         // 0未读 1已读
    private Date readTime;          // 已读时间
    private Integer isRecalled;     // 0否 1是
    private Date createTime;        // 创建时间
    private Long createTimeMs;      // 创建时间戳
}

// 未读会话
@Data
public class UnReadSessionDTO implements Serializable {
    private String orderId;
    private Integer orderType;
    private Integer isRead;
    private String sessionId;
    private String mobile;
}
```

---

## 五、Dubbo 配置

### 5.1 服务端暴露

```xml
<!-- dubbo-provider-smart-companion.xml -->
<dubbo:service interface="com.xxx.api.ChatServerService"
               ref="chatServerService" timeout="10000"/>
```

### 5.2 客户端消费

```java
// DubboCommonConsumerConfiguration.java
@Bean(name = "chatServerService")
public ReferenceBean<ChatServerService> chatServerServiceReferenceBean() {
    ReferenceBean<ChatServerService> referenceBean = new ReferenceBean<>();
    referenceBean.setInterface(ChatServerService.class);
    referenceBean.setCheck(false);
    referenceBean.setTimeout(10000);
    return referenceBean;
}
```

---

## 六、踩坑总结

### 6.1 `@Resource` 注入 Dubbo bean 的 name 匹配

```java
// Dubbo XML 中定义的 bean id
<dubbo:reference id="securitySvcUserLevelTaskDetailService" .../>

// 方式一：field name 和 bean id 一致
@Resource
private SvcUserLevelTaskDetailService securitySvcUserLevelTaskDetailService;

// 方式二：field name 不一致，但同类型只有一个 bean，按 type 匹配也能成功
@Resource
private SvcUserLevelTaskDetailService scSvcUserLevelTaskDetailService;

// 方式三：显式指定 name（最安全）
@Resource(name = "securitySvcUserLevelTaskDetailService")
private SvcUserLevelTaskDetailService scSvcUserLevelTaskDetailService;
```

**建议**：如果同类型有多个 bean，一定要显式指定 name，否则可能注入错误的实现。

### 6.2 过滤逻辑结果未使用

```java
// 错误写法：过滤了但后面还在用原始数据
List<DTO> filtered = filter(list);
if (isEmpty(filtered)) {
    result.setData(list);  // ← 应该用 filtered 或 empty
    return result;
}
for (DTO dto : list) {     // ← 应该用 filtered
    ...
}
result.setData(list);      // ← 应该用 filtered

// 正确写法：过滤后立即替换引用
list = filter(list);
if (isEmpty(list)) {
    result.setData(Collections.emptyList());
    return result;
}
for (DTO dto : list) { ... }
result.setData(list);
```

### 6.3 `getString("data")` 对嵌套 JSONObject 的兼容性

```java
// 某些 fastjson 版本下，data 是 JSONObject 时 getString 可能返回 null
String dataStr = jsonObject.getString("data");    // 可能为 null
JSONObject data = JSON.parseObject(dataStr);       // NPE

// 更稳妥
JSONObject data = jsonObject.getJSONObject("data"); // 直接取嵌套对象
```

### 6.4 sessionId 和 mobile 互斥

IM 服务的会话查询接口中，`sessionId` 和 `mobile` 不能同时传。逻辑：
- 有 `sessionId` → 传 `sessionId`，不传 `mobile`
- 无 `sessionId` → 传 `mobile`

校验在 Web 层做，Service 层也做兜底。

### 6.5 日常单和专项单的 ID 语义不同

| 类型 | orderId 语义 | 查询方法 | 地址字段 |
|------|-------------|---------|---------|
| 日常单 | workOrderNo (String) | findByOrderNo(orderId) | detailAddress |
| 专项单 | userLevelTaskDetailId (Integer) | selectById(orderId) | serveAddr |

不能混用。日常单的 `orderId` 是工单编号（String），专项单的 `orderId` 是任务明细 ID（需要转 Integer）。

### 6.6 可选参数不能传 null 给 IM 服务

```java
// 错误：null 值也会被序列化传给 IM 服务，可能导致异常
body.put("userId", queryDTO.getUserId());      // 可能为 null
body.put("sessionId", queryDTO.getSessionId()); // 可能为 null

// 正确：空值不传
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

1. **Token 统一管理**：Redis 缓存 + 自动刷新，对外部 IM 服务的鉴权对上层透明
2. **Service 层封装**：外部 HTTP 接口统一封装为 Dubbo 接口，上层无需关心通信细节
3. **业务数据组装**：IM 返回消息数据，本地补充订单地址、品类等业务信息
4. **Web 层参数校验**：必填校验、互斥参数处理、masterId 从 token 提取
5. **游标分页**：消息场景下比传统分页更流畅，不受新消息影响
6. **防御性编程**：空值判断、异常捕获、日志追踪，确保链路可定位

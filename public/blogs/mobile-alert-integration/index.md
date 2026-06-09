# 如何实现 JWT 权限放行和前端路由守卫跳过认证

## 1. 背景

在企业级应用中，我们通常使用 JWT（JSON Web Token）+ 统一认证平台（IAM）来实现用户认证。但在某些场景下，需要让特定页面绕过认证机制：

**场景：** 移动端需要直接跳转到告警详情页面，执行一键认领操作，但移动端无法走 IAM 的登录流程。

**需求：**
- 移动端点击"一键认领" → 跳转到告警页面 → 自动弹出认领确认框
- 移动端点击"查看详情" → 跳转到告警页面 → 显示告警详情
- 关闭弹窗后 → 跳转到 IAM 登录页（引导用户正式登录）

## 2. 技术方案

### 2.1 核心思路

1. **路由守卫放行**：检测到特定参数时，跳过登录检查
2. **后端接口隔离**：为移动端提供不需要认证的专用接口
3. **前端逻辑隔离**：根据访问来源，走不同的代码分支

### 2.2 URL 格式设计

```
一键认领：https://app.example.com/alerts/{id}?action=claim&userId={userId}
查看详情：https://app.example.com/alerts/{id}?source=mobile
```

通过 URL 参数区分是否为移动端访问，而不是使用不同的路由路径。

---

## 3. 前端实现

### 3.1 路由守卫放行

**核心原理：** Vue Router 的 `beforeEach` 钩子会在每次路由跳转前执行，我们可以在这里判断是否需要跳过认证。

```javascript
// router/index.js
import { getCasLoginUrl } from '../config/cas'

router.beforeEach(async (to, from, next) => {
  // 1. CAS 回调页面直接放行
  if (to.path === '/cas-callback') {
    return next()
  }

  // 2. 移动端访问：检测特定参数，直接放行
  if (to.name === 'alertDetail' && (to.query.action || to.query.source === 'mobile')) {
    return next()  // 跳过登录检查
  }

  // 3. 正常用户的登录检查
  const userStore = useUserStore()
  if (!userStore.isLoggedIn) {
    userStore.loadUserFromStorage()
  }

  if (to.meta.requiresAuth && !userStore.isLoggedIn) {
    // 未登录 → 跳转 IAM 登录页
    window.location.href = getCasLoginUrl()
  } else if (userStore.isLoggedIn && to.meta.requiresAuth) {
    // 已登录 → 验证 token 是否有效
    try {
      await request.get('/auth/me')
      next()
    } catch (error) {
      userStore.logout()
      window.location.href = getCasLoginUrl()
    }
  } else {
    next()
  }
})
```

**关键逻辑：**
- 判断条件：`to.name === 'alertDetail'` + 有 `action` 或 `source=mobile` 参数
- 满足条件时直接 `next()`，不执行后续的登录检查

---

### 3.2 页面初始化判断

**核心原理：** 在 `onMounted` 生命周期中，根据用户登录状态和 URL 参数，决定走哪条代码分支。

```javascript
// AlertManagement.vue
const isMobileAccess = ref(false)  // 标记是否为移动端访问

onMounted(async () => {
  userStore.loadUserFromStorage()

  // 判断是否为移动端访问
  const hasRouteId = route.params.id
  const hasAction = route.query.action
  const isMobileSource = route.query.source === 'mobile'
  
  // 未登录 + 有告警ID + (有action参数 或 source=mobile) → 移动端访问
  isMobileAccess.value = !userStore.isLoggedIn && hasRouteId && (hasAction || isMobileSource)

  if (!isMobileAccess.value) {
    // 正常登录用户：加载完整数据
    try {
      const res = await request.get('/users')      // 需要认证
      allUsers.value = res.data.data || []
    } catch { /* ignore */ }
    try {
      const res = await request.get('/alerts/systems')  // 需要认证
      systemOptions.value = res.data?.data || []
    } catch { /* ignore */ }
    teamStore.fetchTeams()
    filters.assigneeId = userStore.currentUser?.id ?? null
    fetchData()
  }
  // 移动端访问：跳过上述数据加载，避免 403 错误

  // 加载告警详情
  if (route.params.id) {
    const id = Number(route.params.id)
    if (!isNaN(id)) {
      if (isMobileAccess.value) {
        // 移动端：调用公开接口
        const detailRes = await request.get(`/mobile/alerts/${id}`)
        if (detailRes.data.code === 200) {
          store.currentDetail = detailRes.data.data
          detailDialog.visible = true

          if (route.query.action === 'claim') {
            claimDialog.visible = true  // 弹出认领确认框
          }
        }
      } else {
        // 正常用户：调用原有接口
        await openDetail(id)
      }
    }
  }
})
```

**关键逻辑：**
- `isMobileAccess` 是一个响应式变量，控制整个页面的行为
- 移动端跳过加载 `users`、`teams` 等数据（这些接口需要认证）
- 移动端调用 `/api/mobile/alerts/{id}` 公开接口

---

### 3.3 操作按钮区分

**核心原理：** 根据 `isMobileAccess` 调用不同的接口。

```javascript
// 认领操作
const confirmClaim = async () => {
  claimDialog.loading = true
  try {
    if (isMobileAccess.value) {
      // 移动端：调用公开接口
      const userId = route.query.userId
      const res = await request.get(`/mobile/alerts/${currentRow.value.id}/claim?userId=${userId}`)
      if (res.data.code === 200) {
        ElMessage.success('认领成功')
      } else {
        ElMessage.error(res.data.message || '认领失败')
      }
    } else {
      // 正常用户：调用原有接口
      await store.claim(currentRow.value.id, getCurrentUserId())
      ElMessage.success('认领成功')
      await fetchData()
    }
    claimDialog.visible = false
  } catch (e) {
    claimDialog.visible = false
    ElMessage.error('认领失败')
  } finally {
    claimDialog.loading = false
  }
}
```

---

### 3.4 关闭弹窗后跳转 IAM

**核心原理：** 弹窗的 `@close` 事件触发时，检查是否为移动端访问，如果是则跳转到 IAM 登录页。

```javascript
// 认领弹窗关闭时触发
const handleClaimDialogClose = () => {
  if (isMobileAccess.value) {
    window.location.href = getCasLoginUrl()
  }
}

// 详情弹窗关闭时触发
const handleDetailDialogClose = () => {
  if (isMobileAccess.value) {
    window.location.href = getCasLoginUrl()
  }
}
```

**模板绑定：**
```html
<el-dialog 
  v-model="claimDialog.visible" 
  title="认领告警" 
  @close="handleClaimDialogClose"
  append-to-body>
  ...
</el-dialog>

<el-dialog 
  v-model="detailDialog.visible" 
  title="告警详情" 
  @close="handleDetailDialogClose">
  ...
</el-dialog>
```

**`append-to-body` 的作用：** 确保认领弹窗的 z-index 高于详情弹窗，显示在最上层。

---

## 4. 后端实现

### 4.1 公开接口设计

**核心原理：** 创建独立的 Controller，路径使用 `/api/mobile/**`，在 SecurityConfig 中配置为不需要认证。

```java
@Slf4j
@RestController
@RequestMapping("/api/mobile/alerts")
@RequiredArgsConstructor
public class MobileAlertController {

    private final AlertEventService alertEventService;
    private final UserService userService;

    /**
     * 查看告警详情
     * GET /api/mobile/alerts/{id}
     */
    @GetMapping("/{id}")
    public Result<Map<String, Object>> detail(@PathVariable Long id) {
        log.info("移动端查看告警详情，alertId={}", id);

        AlertEvent alert = alertEventService.getById(id);
        if (alert == null) {
            return Result.error(404, "告警不存在");
        }

        Map<String, Object> data = new LinkedHashMap<>();
        data.put("id", alert.getId());
        data.put("title", alert.getTitle());
        data.put("content", alert.getContent());
        data.put("severity", alert.getSeverity());
        data.put("status", alert.getStatus());
        data.put("source", alert.getSource());
        data.put("createdAt", alert.getCreatedAt());
        data.put("updatedAt", alert.getUpdatedAt());

        if (alert.getAssigneeId() != null) {
            User assignee = userService.getById(alert.getAssigneeId());
            data.put("assigneeId", alert.getAssigneeId());
            data.put("assigneeName", assignee != null ? assignee.getName() : null);
        }

        return Result.success(data);
    }

    /**
     * 一键认领告警
     * GET /api/mobile/alerts/{id}/claim?userId=xxx
     */
    @GetMapping("/{id}/claim")
    public Result<Map<String, Object>> claim(@PathVariable Long id,
                                             @RequestParam Long userId) {
        log.info("移动端认领告警，alertId={}, userId={}", id, userId);

        User user = userService.getById(userId);
        if (user == null) {
            return Result.error(400, "用户不存在");
        }

        alertEventService.claim(id, userId);

        Map<String, Object> data = new LinkedHashMap<>();
        data.put("alertId", id);
        data.put("userId", userId);
        data.put("userName", user.getName());
        data.put("message", "认领成功");

        return Result.success(data);
    }
}
```

---

### 4.2 SecurityConfig 配置

**核心原理：** Spring Security 的 `requestMatchers` 可以配置哪些路径不需要认证。

```java
@Configuration
@EnableWebSecurity
public class SecurityConfig {

    @Bean
    public SecurityFilterChain filterChain(HttpSecurity http) throws Exception {
        http
            .cors(cors -> cors.configurationSource(corsConfigurationSource()))
            .csrf(csrf -> csrf.disable())
            .authorizeHttpRequests(auth ->
                auth
                    // 公开接口 - 不需要登录
                    .requestMatchers("/api/auth/**").permitAll()
                    .requestMatchers("/api/openapi/**").permitAll()
                    .requestMatchers("/api/test/**").permitAll()
                    .requestMatchers("/api/apm/**").permitAll()
                    // 移动端公开接口 - 无需登录
                    .requestMatchers("/api/mobile/**").permitAll()
                    // 其他所有请求需要认证
                    .anyRequest().authenticated()
            )
            .sessionManagement(session ->
                session.sessionCreationPolicy(SessionCreationPolicy.STATELESS)
            )
            .authenticationProvider(authenticationProvider())
            .addFilterBefore(jwtAuthenticationFilter, UsernamePasswordAuthenticationFilter.class);

        return http.build();
    }
}
```

**关键配置：**
- `.requestMatchers("/api/mobile/**").permitAll()` 允许 `/api/mobile/` 开头的所有路径无需认证
- 该配置必须放在 `.anyRequest().authenticated()` 之前

---

## 5. 流程图

```
┌─────────────────────────────────────────────────────────────────┐
│ 移动端点击                                                       │
│ https://app.example.com/alerts/123?action=claim&userId=456      │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ 路由守卫 (router/index.js)                                       │
│                                                                 │
│   if (to.name === 'alertDetail' && to.query.action) {           │
│     return next()  // 跳过登录检查                               │
│   }                                                             │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ 页面初始化 (AlertManagement.vue onMounted)                       │
│                                                                 │
│   isMobileAccess = !userStore.isLoggedIn && hasRouteId           │
│                    && (hasAction || isMobileSource)              │
│                                                                 │
│   if (isMobileAccess) {                                         │
│     // 跳过加载 users/teams 等数据                               │
│     // 调用 /api/mobile/alerts/123 获取详情                      │
│     // 显示详情弹窗 + 认领弹窗                                   │
│   }                                                             │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ 用户操作                                                         │
│                                                                 │
│   if (isMobileAccess) {                                         │
│     // 调用 /api/mobile/alerts/123/claim?userId=456              │
│   } else {                                                      │
│     // 调用 /api/alerts/123/claim                                │
│   }                                                             │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ 弹窗关闭 (@close 事件)                                           │
│                                                                 │
│   if (isMobileAccess) {                                         │
│     window.location.href = getCasLoginUrl()  // 跳转 IAM 登录   │
│   }                                                             │
└─────────────────────────────────────────────────────────────────┘
```

---

## 6. 关键点总结

### 6.1 前端关键点

| 技术点 | 实现方式 |
|--------|----------|
| 路由守卫放行 | 在 `beforeEach` 中检测特定参数，直接 `next()` |
| 状态标记 | 使用 `isMobileAccess` 响应式变量控制整个页面行为 |
| 接口隔离 | 移动端调用 `/api/mobile/**`，正常用户调用 `/api/**` |
| 数据加载 | 移动端跳过加载需要认证的数据，避免 403 错误 |
| 弹窗层级 | 使用 `append-to-body` 确保认领弹窗在详情弹窗上面 |
| 关闭跳转 | 弹窗 `@close` 事件触发时跳转到 IAM 登录页 |

### 6.2 后端关键点

| 技术点 | 实现方式 |
|--------|----------|
| 接口隔离 | 创建独立的 `MobileAlertController`，路径 `/api/mobile/**` |
| 权限配置 | SecurityConfig 中 `.requestMatchers("/api/mobile/**").permitAll()` |
| 返回格式 | 使用统一的 `Result` 包装类，code=200 表示成功 |

### 6.3 安全考虑

1. **接口隔离**：移动端接口与正常接口分离，不影响原有安全机制
2. **参数校验**：后端对接口参数进行校验（如 userId 是否存在）
3. **操作引导**：关闭弹窗后引导用户到 IAM 登录页，完成正式认证
4. **日志记录**：移动端接口调用记录日志，便于审计

---

## 7. 扩展思考

### 7.1 其他应用场景

这种"权限放行"的模式可以应用在以下场景：

- **邮件通知链接**：用户点击邮件中的链接直接查看告警详情
- **钉钉/微信推送**：消息卡片中的操作按钮直接执行操作
- **分享链接**：生成临时访问链接，无需登录即可查看

### 7.2 安全增强

如果需要更高的安全性，可以考虑：

1. **临时 Token**：为移动端生成有时效的临时 Token，通过 URL 参数传递
2. **签名校验**：在 URL 中添加签名参数，防止篡改
3. **IP 白名单**：限制移动端接口的访问来源
4. **操作限制**：限制单个 userId 的操作频率

---

## 8. 总结

通过路由守卫放行 + 接口隔离的方式，我们实现了：

- ✅ 移动端无需登录即可访问特定页面
- ✅ 使用公开接口执行操作，不依赖 IAM 认证
- ✅ 操作完成后引导用户正式登录
- ✅ 不影响原有系统的安全机制

这种方案的核心是**通过 URL 参数识别访问来源**，然后在前端和后端分别做相应的处理。

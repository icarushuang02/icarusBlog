# 告警系统登录统一平台对接流程

## 1. 背景

告警系统需要对接公司统一身份认证平台（IAM），实现单点登录（SSO）。用户通过 IAM 登录后，系统自动完成本地用户匹配和会话建立，无需重复输入账号密码。

**为什么要对接 IAM？**
- 公司有多个系统，用户需要记住多套账号密码
- IAM 实现统一认证，一次登录，全平台通行
- 用户信息统一管理，离职时自动禁用所有系统权限

## 2. 技术方案

- **认证协议**：CAS（Central Authentication Service）
- **会话管理**：JWT（JSON Web Token）
- **前端框架**：Vue 3 + Pinia
- **后端框架**：Spring Boot 3 + Spring Security

## 3. 整体流程

```
┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
│  前端页面  │────→│ IAM 登录页 │────→│  后端接口  │────→│  前端回调  │
│ (未登录)  │     │ (输入密码) │     │ (验证票据) │     │ (保存Token)│
└──────────┘     └──────────┘     └──────────┘     └──────────┘
```

### 详细步骤

1. 用户访问前端页面，路由守卫检测未登录
2. 前端重定向到 IAM 登录页
3. 用户在 IAM 页面完成登录
4. IAM 重定向到后端回调接口，携带票据（ticket）
5. 后端用 ticket 调用 IAM 验证接口获取用户信息
6. 后端根据工号匹配本地用户，生成 JWT Token
7. 后端重定向到前端回调页面，携带 token
8. 前端保存 token，登录完成

## 4. 代码实现

### 4.1 前端配置

#### CAS 配置文件 `config/cas.js`

```javascript
export const CAS_CONFIG = {
  // IAM 登录页地址
  CAS_LOGIN_URL: 'https://iam.example.com/cas/login',
  // IAM 退出地址
  CAS_LOGOUT_URL: 'https://iam.example.com/cas/logout',
  // 本系统域名
  APP_BASE_URL: 'https://app.example.com',
  // 后端回调路径
  CAS_CALLBACK_PATH: '/api/auth/casLogin',
  // 前端回调路径
  FRONTEND_CALLBACK_PATH: '/cas-callback'
}

// 获取登录跳转地址
export function getCasLoginUrl() {
  // service 参数需要 URL 编码，IAM 会验证此地址是否与应用配置一致
  const service = encodeURIComponent(
    `${CAS_CONFIG.APP_BASE_URL}${CAS_CONFIG.CAS_CALLBACK_PATH}`
  )
  return `${CAS_CONFIG.CAS_LOGIN_URL}?service=${service}`
}

// 获取退出地址（清除 IAM 会话后重定向到登录页）
export function getCasLogoutUrl() {
  // 退出后重定向到登录页
  const service = encodeURIComponent(getCasLoginUrl())
  return `${CAS_CONFIG.CAS_LOGOUT_URL}?service=${service}`
}
```

**代码解析：**
- `service` 参数是 IAM 登录成功后的回调地址，必须与 IAM 应用配置的 `serviceId` 完全一致
- 使用 `encodeURIComponent` 编码是因为 service 本身是一个 URL，需要作为参数传递
- 退出时需要调用 IAM 的 `/cas/logout` 接口，否则 IAM 会话不会清除，会自动重新登录

#### 路由守卫 `router/index.js`

```javascript
import { getCasLoginUrl } from '../config/cas'

const router = createRouter({
  routes: [
    {
      path: '/login',
      // /login 路由直接重定向到 IAM 登录页
      redirect: () => {
        window.location.href = getCasLoginUrl()
        return '/'
      }
    },
    {
      path: '/cas-callback',
      // IAM 登录成功后的回调页面
      component: () => import('../views/CasCallback.vue')
    },
    // ... 其他路由
  ]
})

// 路由守卫 - 每次路由跳转前执行
router.beforeEach(async (to, from, next) => {
  // CAS 回调页面直接放行，不需要验证
  if (to.path === '/cas-callback') return next()

  const userStore = useUserStore()

  // 从 localStorage 恢复用户状态（页面刷新时）
  if (!userStore.isLoggedIn) {
    userStore.loadUserFromStorage()
  }

  if (to.meta.requiresAuth && !userStore.isLoggedIn) {
    // 需要登录但未登录 → 跳转 IAM 登录页
    window.location.href = getCasLoginUrl()
  } else if (userStore.isLoggedIn && to.meta.requiresAuth) {
    // 已登录，验证 token 是否仍然有效
    try {
      await request.get('/auth/me')
      next()  // token 有效，放行
    } catch {
      // token 无效（过期或被篡改），清除本地状态，重新登录
      userStore.logout()
      window.location.href = getCasLoginUrl()
    }
  } else {
    next()
  }
})
```

**代码解析：**
- `/cas-callback` 路由必须放行，否则回调时会被路由守卫拦截
- `loadUserFromStorage()` 在页面刷新时从 localStorage 恢复用户状态
- 已登录用户访问需要认证的页面时，会调用 `/auth/me` 验证 token 是否有效
- 如果 token 无效（返回 401），会清除本地状态并跳转到 IAM 登录页

#### 回调页面 `views/CasCallback.vue`

```vue
<script setup>
import { onMounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useUserStore } from '../store/user'
import request from '../utils/request'

const router = useRouter()
const route = useRoute()
const userStore = useUserStore()

onMounted(async () => {
  // 从 URL 参数获取 token 或 error
  const token = route.query.token
  const error = route.query.error

  // 如果后端返回错误（如用户不存在、被禁用）
  if (error) {
    ElMessage.error(decodeURIComponent(error))
    router.push('/')
    return
  }

  if (token) {
    // 1. 先保存 token 到 localStorage
    localStorage.setItem('token', token)

    // 2. 调用后端接口获取用户信息
    // 注意：后端返回的是 Result 包装对象 {code: 1000, data: {...}}
    const { data } = await request.get('/auth/me')
    const user = data.data  // 需要取 data.data 才是真正的用户信息

    // 3. 保存到 Pinia store
    userStore.casLogin(token, {
      id: user.id,
      name: user.name,        // 显示名称
      username: user.name,    // 兼容旧代码
      email: user.email,
      role: user.role,
      icomeAccount: user.icomeAccount
    })

    ElMessage.success('登录成功')
    router.push('/')
  }
})
</script>
```

**代码解析：**
- 后端重定向时会携带 `token` 或 `error` 参数
- 需要先保存 token，再调用接口获取用户信息（因为接口需要 token 认证）
- 后端返回的是 `Result` 包装对象，需要 `response.data.data` 才能获取真正的用户信息
- 同时保存 `name` 和 `username` 是为了兼容不同组件的读取方式

#### 用户状态管理 `store/user.js`

```javascript
export const useUserStore = defineStore('user', {
  state: () => ({
    currentUser: null,
    token: localStorage.getItem('token') || '',
    isLoggedIn: !!localStorage.getItem('token')
  }),

  actions: {
    // CAS 登录：保存 token 和用户信息
    casLogin(token, user) {
      this.token = token
      this.isLoggedIn = true
      this.currentUser = user
      // 持久化到 localStorage
      localStorage.setItem('token', token)
      localStorage.setItem('user', JSON.stringify(user))
    },

    // 退出登录：清除所有状态
    logout() {
      this.token = ''
      this.isLoggedIn = false
      this.currentUser = null
      localStorage.removeItem('token')
      localStorage.removeItem('user')
    },

    // 从 localStorage 恢复状态（页面刷新时调用）
    loadUserFromStorage() {
      const token = localStorage.getItem('token')
      const userStr = localStorage.getItem('user')

      if (token && userStr) {
        this.token = token
        this.currentUser = JSON.parse(userStr)
        this.isLoggedIn = true
      }
    }
  }
})
```

**代码解析：**
- `localStorage` 用于持久化存储，页面刷新后数据不会丢失
- `Pinia store` 用于内存中的状态管理，组件可以响应式地读取用户信息
- 登录时同时保存到两者，退出时同时清除

#### 退出登录 `App.vue`

```javascript
import { getCasLogoutUrl } from './config/cas'

const handleLogout = () => {
  // 1. 清除本地状态
  userStore.logout()
  // 2. 跳转到 IAM 退出接口，清除 IAM 会话
  //    IAM 退出后会重定向到登录页
  window.location.href = getCasLogoutUrl()
}
```

**代码解析：**
- 只清除本地状态是不够的，IAM 会话仍然存在
- 必须调用 IAM 的 `/cas/logout` 接口清除 IAM 会话
- IAM 退出后会重定向到 `service` 参数指定的地址（即登录页）

### 4.2 后端实现

#### CAS 配置类 `CasConfig.java`

```java
@Data
@Configuration
@ConfigurationProperties(prefix = "cas")
public class CasConfig {
    private String serverUrl;            // IAM 服务地址
    private String serviceBaseUrl;       // 本系统域名
    private String serviceCallbackPath;  // 后端回调路径
    private String frontendCallbackPath; // 前端回调路径

    // 获取完整的 service 地址（IAM 回调地址）
    public String getServiceUrl() {
        return serviceBaseUrl + serviceCallbackPath;
    }

    // 获取票据验证地址
    public String getTicketValidateUrl() {
        return serverUrl + "/cas/p3/serviceValidate";
    }

    // 获取前端回调地址
    public String getFrontendCallbackUrl() {
        return serviceBaseUrl + frontendCallbackPath;
    }
}
```

**代码解析：**
- 使用 `@ConfigurationProperties` 绑定 `application.yml` 中的配置
- 环境不同时，`serviceBaseUrl` 不同（如开发环境、测试环境、生产环境）
- 票据验证地址是 IAM 提供的标准接口

#### CAS 回调接口 `AuthController.java`

```java
@GetMapping("/casLogin")
public void casLogin(@RequestParam String ticket,
                     HttpServletResponse response) {
    // ========== 第一步：构建验证 URL ==========
    // service 参数必须与登录时传递的一致，且需要 URL 编码
    String serviceUrl = URLEncoder.encode(
        casConfig.getServiceUrl(), StandardCharsets.UTF_8
    );
    String validateUrl = casConfig.getTicketValidateUrl()
        + "?service=" + serviceUrl
        + "&ticket=" + ticket
        + "&format=JSON";

    // ========== 第二步：调用 IAM 验证接口 ==========
    Request iamRequest = new Request.Builder()
        .url(validateUrl)
        .get()
        .build();
    Response iamResponse = httpClient.newCall(iamRequest).execute();

    // 检查 HTTP 响应
    if (!iamResponse.isSuccessful() || iamResponse.body() == null) {
        response.sendRedirect(
            casConfig.getFrontendCallbackUrl() + "?error=票据验证请求失败"
        );
        return;
    }

    // ========== 第三步：解析 IAM 返回的用户信息 ==========
    String responseBody = iamResponse.body().string();
    JsonNode root = objectMapper.readTree(responseBody);

    // 检查是否验证失败
    JsonNode failure = root.at("/serviceResponse/authenticationFailure");
    if (!failure.isMissingNode()) {
        String desc = failure.get("description").asText();
        response.sendRedirect(
            casConfig.getFrontendCallbackUrl() + "?error=" + desc
        );
        return;
    }

    // 获取用户属性
    JsonNode attrs = root.at(
        "/serviceResponse/authenticationSuccess/attributes"
    );

    // ========== 第四步：提取工号，查找本地用户 ==========
    String employeeNum = getAttr(attrs, "employeeNum");
    User user = userService.getUserByEmployeeId(employeeNum);

    if (user == null) {
        // 用户不存在，没有权限
        response.sendRedirect(
            casConfig.getFrontendCallbackUrl() + "?error=没有权限，不允许登录"
        );
        return;
    }

    if (!user.getEnabled()) {
        // 用户已禁用
        response.sendRedirect(
            casConfig.getFrontendCallbackUrl() + "?error=用户已被禁用"
        );
        return;
    }

    // ========== 第五步：生成 JWT Token ==========
    UserDetails userDetails = new org.springframework.security.core.userdetails.User(
        user.getIcomeAccount(),
        user.getPassword() != null ? user.getPassword() : "",
        Collections.singletonList(
            new SimpleGrantedAuthority("ROLE_" + user.getRole().toUpperCase())
        )
    );
    String token = jwtTokenUtil.generateToken(userDetails);

    // ========== 第六步：重定向到前端 ==========
    response.sendRedirect(
        casConfig.getFrontendCallbackUrl() + "?token=" + token
    );
}

// 辅助方法：从 IAM 属性中提取文本值
private String getAttr(JsonNode attrs, String field) {
    if (attrs != null && attrs.has(field)) {
        JsonNode v = attrs.get(field);
        // IAM 返回的属性是数组格式，取第一个值
        if (v.isArray() && !v.isEmpty()) return v.get(0).asText();
        return v.asText();
    }
    return null;
}
```

**代码解析：**
- `ticket` 是 IAM 登录成功后生成的一次性票据，只能使用一次
- 验证接口返回的用户属性是数组格式，需要取第一个值
- 根据 `employeeNum`（工号）匹配本地用户，而不是用 IAM 的用户 ID
- 如果用户不存在或被禁用，重定向到前端并携带错误信息
- 生成 JWT Token 时，`username` 使用 `icomeAccount`（ICOME 账号）

#### 配置文件 `application.yml`

```yaml
# CAS / IAM 统一认证配置
cas:
  server-url: https://iam.example.com
  service-base-url: https://app.example.com
  service-callback-path: /api/auth/casLogin
  frontend-callback-path: /cas-callback

# JWT 配置
jwt:
  secret: your-secret-key-here  # 密钥，用于签名 Token
  expiration: 86400000          # 过期时间：24小时（毫秒）
```

**环境配置：**

不同环境的 `service-base-url` 不同：

```yaml
# application-dev.yml（开发环境）
cas:
  service-base-url: https://localhost:8080

# application-st.yml（测试环境）
cas:
  service-base-url: https://st-app.example.com

# application-prod.yml（生产环境）
cas:
  service-base-url: https://app.example.com
```

## 5. JWT 原理讲解

### 5.1 什么是 JWT

JWT（JSON Web Token）是一种开放标准（RFC 7519），用于在各方之间安全地传输信息。它由三部分组成，用 `.` 连接：

```
eyJhbGciOiJIUzUxMiJ9.eyJzdWIiOiJ6aGFuZ3NhbiIsImV4cCI6MTc4MDY0MDAxOX0.xxxxx
       ↓                                    ↓                              ↓
    Header                               Payload                      Signature
```

### 5.2 JWT 结构

**Header（头部）**

```json
{
  "alg": "HS512",  // 签名算法：HMAC SHA512
  "typ": "JWT"     // 令牌类型
}
```

**Payload（载荷）**

```json
{
  "sub": "zhangsan",      // 主题（用户名）
  "iat": 1780553619,       // 签发时间（Issued At）
  "exp": 1780640019,       // 过期时间（Expiration）
  "role": "user"           // 自定义声明
}
```

**Signature（签名）**

```
HMACSHA512(
  base64UrlEncode(header) + "." + base64UrlEncode(payload),
  secret
)
```

签名的作用：
- 防止 Token 被篡改
- 验证 Token 的真实性
- 只有拥有密钥的服务端才能生成有效的签名

### 5.3 JWT 工作流程

```
用户登录
    ↓
服务端验证用户名密码
    ↓
验证通过，生成 JWT
  - 写入用户名、过期时间
  - 用密钥签名
    ↓
返回给客户端
    ↓
客户端存储（localStorage）
    ↓
后续请求携带：Authorization: Bearer xxx
    ↓
服务端拦截器拦截请求
    ↓
验证签名是否有效
    ↓
检查是否过期
    ↓
解析出用户名，加载用户信息
    ↓
注入 SecurityContext，完成认证
```

### 5.4 代码示例

**生成 Token**

```java
public String generateToken(UserDetails userDetails) {
    Map<String, Object> claims = new HashMap<>();
    return Jwts.builder()
        .setClaims(claims)
        .setSubject(userDetails.getUsername())  // 写入用户名
        .setIssuedAt(new Date())                 // 写入签发时间
        .setExpiration(new Date(                 // 写入过期时间
            System.currentTimeMillis() + expiration
        ))
        .signWith(signingKey, SignatureAlgorithm.HS512)  // 用密钥签名
        .compact();
}
```

**解析 Token**

```java
public String getUsernameFromToken(String token) {
    Claims claims = Jwts.parserBuilder()
        .setSigningKey(signingKey)  // 用密钥验证签名
        .build()
        .parseClaimsJws(token)      // 解析 Token
        .getBody();
    return claims.getSubject();      // 获取用户名
}
```

**验证 Token**

```java
public Boolean validateToken(String token, UserDetails userDetails) {
    // 1. 从 Token 中提取用户名
    String username = getUsernameFromToken(token);
    // 2. 检查用户名是否匹配
    // 3. 检查是否过期
    return username.equals(userDetails.getUsername())
        && !isTokenExpired(token);
}
```

**请求拦截器 `JwtAuthenticationFilter.java`**

```java
@Override
protected void doFilterInternal(HttpServletRequest request,
                                HttpServletResponse response,
                                FilterChain filterChain) {
    // 1. 从 Header 中提取 Token
    String jwt = getJwtFromRequest(request);

    if (StringUtils.hasText(jwt)) {
        // 2. 从 Token 中解析用户名
        String username = jwtTokenUtil.getUsernameFromToken(jwt);
        // 3. 从数据库加载用户信息
        UserDetails userDetails = userDetailsService.loadUserByUsername(username);

        // 4. 验证 Token 是否有效
        if (jwtTokenUtil.validateToken(jwt, userDetails)) {
            // 5. 创建认证对象，注入 SecurityContext
            UsernamePasswordAuthenticationToken authentication =
                new UsernamePasswordAuthenticationToken(
                    userDetails, null, userDetails.getAuthorities()
                );
            SecurityContextHolder.getContext().setAuthentication(authentication);
        }
    }

    filterChain.doFilter(request, response);
}

private String getJwtFromRequest(HttpServletRequest request) {
    String bearerToken = request.getHeader("Authorization");
    if (StringUtils.hasText(bearerToken) && bearerToken.startsWith("Bearer ")) {
        return bearerToken.substring(7);  // 去掉 "Bearer " 前缀
    }
    return null;
}
```

### 5.5 JWT 的优势

| 特性 | 说明 |
|------|------|
| 无状态 | 服务端不需要存储会话信息，减轻服务器压力 |
| 可扩展 | 天然支持分布式系统，无需共享 Session |
| 跨域 | 可以在不同域名间传递，支持前后端分离 |
| 自包含 | 用户信息在 token 中，无需每次都查询数据库 |

### 5.6 安全注意事项

1. **密钥安全**：密钥不能泄露，建议使用环境变量或配置中心
2. **HTTPS**：生产环境必须使用 HTTPS，防止 Token 被窃取
3. **过期时间**：设置合理的过期时间（建议 24 小时内）
4. **敏感信息**：不要在 Payload 中存放敏感数据（密码等），Payload 只是 Base64 编码，不是加密

## 6. 开发过程中遇到的问题

### 问题 1：登录后右上角显示"用户"而不是真实姓名

**现象：** 登录成功后，右上角显示"用户"而不是"黄振坤"

**原因：** 回调页面保存用户信息时，字段名不匹配

```javascript
// 错误写法：只保存了 username，但界面读取的是 name
userStore.casLogin(token, {
  username: user.name  // 界面读取 currentUser?.name，结果是 undefined
})

// 正确写法：同时保存 name 和 username
userStore.casLogin(token, {
  name: user.name,      // 界面读取这个字段
  username: user.name   // 兼容旧代码
})
```

**解决：** 同时保存 `name` 和 `username` 两个字段

### 问题 2：用户 ID 获取不到，认领操作失败

**现象：** 所有认领操作提示"没有 userId"

**原因：** 后端返回的是 `Result` 包装对象，前端解析错误

```javascript
// 错误写法：response.data 是 Result 对象 {code: 1000, data: {...}}
const userData = response.data
console.log(userData.id)  // undefined

// 正确写法：需要取 response.data.data
const userData = response.data.data
console.log(userData.id)  // 123
```

**解决：** 使用 `response.data.data` 获取真正的用户信息

### 问题 3：退出后自动重新登录

**现象：** 点击退出后，页面显示"登录成功"，又自动登录了

**原因：** 只清除了本地状态，没有清除 IAM 会话

```javascript
// 错误写法：只清除本地状态
const handleLogout = () => {
  userStore.logout()
  router.push('/login')  // 跳转到 /login，触发 IAM 自动登录
}

// 正确写法：调用 IAM 退出接口
const handleLogout = () => {
  userStore.logout()
  window.location.href = getCasLogoutUrl()  // 调用 IAM 退出
}
```

**解决：** 退出时调用 IAM 的 `/cas/logout` 接口清除 IAM 会话

### 问题 4：service 参数验证失败

**现象：** IAM 登录后返回 `INVALID_SERVICE` 错误

**原因：** 传递给 IAM 的 `service` 参数与应用配置的 `serviceId` 不一致

```
// 应用配置的 serviceId
https://app.example.com/api/auth/casLogin

// 错误：没有 URL 编码
https://iam.example.com/cas/login?service=https://app.example.com/api/auth/casLogin

// 正确：URL 编码后
https://iam.example.com/cas/login?service=https%3A%2F%2Fapp.example.com%2Fapi%2Fauth%2FcasLogin
```

**解决：** 确保 `service` 参数使用 `encodeURIComponent` 编码

### 问题 5：用户不存在，无法登录

**现象：** IAM 登录成功，但提示"没有权限，不允许登录"

**原因：** 本地数据库没有该用户，或者工号不匹配

**解决：**
1. 先调用 IAM 账号拉取接口同步用户
2. 确保 `employeeNum` 与本地 `employee_id` 字段一致

## 7. 总结

通过对接 IAM 统一认证平台，实现了：

- **单点登录**：一次登录，全平台通行
- **自动同步**：用户信息自动从 IAM 同步
- **安全会话**：JWT 无状态会话管理
- **统一退出**：一处退出，全平台退出

### 关键点回顾

1. `service` 参数必须与 IAM 应用配置一致，且需要 URL 编码
2. 后端返回的是 `Result` 包装对象，前端需要 `response.data.data` 获取数据
3. 退出时必须调用 IAM 的 `/cas/logout` 接口，否则会自动重新登录
4. JWT Token 存储在 localStorage，页面刷新后不会丢失
5. 用户信息字段名要保持一致，避免显示异常

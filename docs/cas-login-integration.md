# 告警系统登录统一平台对接流程

## 1. 背景

告警系统需要对接公司统一身份认证平台（IAM），实现单点登录（SSO）。用户通过 IAM 登录后，系统自动完成本地用户匹配和会话建立，无需重复输入账号密码。

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

**CAS 配置文件 `config/cas.js`**

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
  const service = encodeURIComponent(
    `${CAS_CONFIG.APP_BASE_URL}${CAS_CONFIG.CAS_CALLBACK_PATH}`
  )
  return `${CAS_CONFIG.CAS_LOGIN_URL}?service=${service}`
}

// 获取退出地址（清除 IAM 会话后重定向到登录页）
export function getCasLogoutUrl() {
  const service = encodeURIComponent(getCasLoginUrl())
  return `${CAS_CONFIG.CAS_LOGOUT_URL}?service=${service}`
}
```

**路由守卫 `router/index.js`**

```javascript
import { getCasLoginUrl } from '../config/cas'

const router = createRouter({
  routes: [
    {
      path: '/login',
      redirect: () => {
        window.location.href = getCasLoginUrl()
        return '/'
      }
    },
    {
      path: '/cas-callback',
      component: () => import('../views/CasCallback.vue')
    },
    // ... 其他路由
  ]
})

// 路由守卫
router.beforeEach(async (to, from, next) => {
  if (to.path === '/cas-callback') return next()

  const userStore = useUserStore()
  if (!userStore.isLoggedIn) {
    userStore.loadUserFromStorage()
  }

  if (to.meta.requiresAuth && !userStore.isLoggedIn) {
    // 未登录，跳转 IAM 登录页
    window.location.href = getCasLoginUrl()
  } else if (userStore.isLoggedIn && to.meta.requiresAuth) {
    // 已登录，验证 token 是否有效
    try {
      await request.get('/auth/me')
      next()
    } catch {
      userStore.logout()
      window.location.href = getCasLoginUrl()
    }
  } else {
    next()
  }
})
```

**回调页面 `views/CasCallback.vue`**

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
  const token = route.query.token
  const error = route.query.error

  if (error) {
    ElMessage.error(decodeURIComponent(error))
    router.push('/')
    return
  }

  if (token) {
    // 保存 token
    localStorage.setItem('token', token)
    // 获取用户信息
    const { data } = await request.get('/auth/me')
    const user = data.data

    // 保存到 store
    userStore.casLogin(token, {
      id: user.id,
      name: user.name,
      username: user.name,
      email: user.email,
      role: user.role,
      icomeAccount: user.icomeAccount
    })

    router.push('/')
  }
})
</script>
```

### 4.2 后端实现

**CAS 配置类 `CasConfig.java`**

```java
@Data
@Configuration
@ConfigurationProperties(prefix = "cas")
public class CasConfig {
    private String serverUrl;        // IAM 服务地址
    private String serviceBaseUrl;   // 本系统域名
    private String serviceCallbackPath;  // 后端回调路径
    private String frontendCallbackPath; // 前端回调路径

    // 获取完整的 service 地址
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

**CAS 回调接口 `AuthController.java`**

```java
@GetMapping("/casLogin")
public void casLogin(@RequestParam String ticket, 
                     HttpServletResponse response) {
    // 1. 构建验证 URL
    String serviceUrl = URLEncoder.encode(
        casConfig.getServiceUrl(), StandardCharsets.UTF_8
    );
    String validateUrl = casConfig.getTicketValidateUrl()
        + "?service=" + serviceUrl
        + "&ticket=" + ticket
        + "&format=JSON";

    // 2. 调用 IAM 验证接口
    Request iamRequest = new Request.Builder()
        .url(validateUrl).get().build();
    Response iamResponse = httpClient.newCall(iamRequest).execute();

    // 3. 解析返回的用户信息
    JsonNode root = objectMapper.readTree(iamResponse.body().string());
    JsonNode attrs = root.at(
        "/serviceResponse/authenticationSuccess/attributes"
    );

    // 4. 提取工号，查找本地用户
    String employeeNum = getAttr(attrs, "employeeNum");
    User user = userService.getUserByEmployeeId(employeeNum);

    if (user == null || !user.getEnabled()) {
        // 用户不存在或已禁用
        response.sendRedirect(
            casConfig.getFrontendCallbackUrl() + "?error=没有权限"
        );
        return;
    }

    // 5. 生成 JWT Token
    UserDetails userDetails = new User(
        user.getIcomeAccount(),
        user.getPassword(),
        Collections.singletonList(
            new SimpleGrantedAuthority("ROLE_" + user.getRole())
        )
    );
    String token = jwtTokenUtil.generateToken(userDetails);

    // 6. 重定向到前端
    response.sendRedirect(
        casConfig.getFrontendCallbackUrl() + "?token=" + token
    );
}
```

**配置文件 `application.yml`**

```yaml
cas:
  server-url: https://iam.example.com
  service-base-url: https://app.example.com
  service-callback-path: /api/auth/casLogin
  frontend-callback-path: /cas-callback

jwt:
  secret: your-secret-key-here
  expiration: 86400000  # 24小时
```

## 5. JWT 原理讲解

### 5.1 什么是 JWT

JWT（JSON Web Token）是一种开放标准（RFC 7519），用于在各方之间安全地传输信息。它由三部分组成，用 `.` 连接：

```
xxxxx.yyyyy.zzzzz
  ↓       ↓       ↓
Header  Payload  Signature
```

### 5.2 JWT 结构

**Header（头部）**

```json
{
  "alg": "HS512",  // 签名算法
  "typ": "JWT"     // 令牌类型
}
```

**Payload（载荷）**

```json
{
  "sub": "zhangsan",      // 主题（用户名）
  "iat": 1780553619,       // 签发时间
  "exp": 1780640019,       // 过期时间
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

### 5.3 JWT 工作流程

```
用户登录
    ↓
服务端验证通过
    ↓
生成 JWT（用密钥签名）
    ↓
返回给客户端
    ↓
客户端存储（localStorage）
    ↓
后续请求携带：Authorization: Bearer xxx
    ↓
服务端验证签名 → 解析用户信息
```

### 5.4 代码示例

**生成 Token**

```java
public String generateToken(UserDetails userDetails) {
    Map<String, Object> claims = new HashMap<>();
    return Jwts.builder()
        .setClaims(claims)
        .setSubject(userDetails.getUsername())  // 用户名
        .setIssuedAt(new Date())                 // 签发时间
        .setExpiration(new Date(                 // 过期时间
            System.currentTimeMillis() + expiration
        ))
        .signWith(signingKey, SignatureAlgorithm.HS512)
        .compact();
}
```

**解析 Token**

```java
public String getUsernameFromToken(String token) {
    Claims claims = Jwts.parserBuilder()
        .setSigningKey(signingKey)
        .build()
        .parseClaimsJws(token)
        .getBody();
    return claims.getSubject();  // 获取用户名
}
```

**验证 Token**

```java
public Boolean validateToken(String token, UserDetails userDetails) {
    String username = getUsernameFromToken(token);
    return username.equals(userDetails.getUsername()) 
        && !isTokenExpired(token);
}
```

### 5.5 JWT 的优势

| 特性 | 说明 |
|------|------|
| 无状态 | 服务端不需要存储会话信息 |
| 可扩展 | 天然支持分布式系统 |
| 跨域 | 可以在不同域名间传递 |
| 自包含 | 用户信息在 token 中，无需查询数据库 |

### 5.6 安全注意事项

1. **密钥安全**：密钥不能泄露，建议使用环境变量
2. **HTTPS**：生产环境必须使用 HTTPS
3. **过期时间**：设置合理的过期时间（建议 24 小时内）
4. **敏感信息**：不要在 Payload 中存放敏感数据（密码等）

## 6. 常见问题

### Q1: 票据验证失败

检查 `service` 参数是否与 IAM 应用配置的 `serviceId` 一致，需要 URL 编码。

### Q2: 用户不存在

确认本地数据库是否有该用户，工号（`employeeNum`）是否匹配 `employee_id` 字段。

### Q3: Token 过期

前端检测到 401 响应后，清除本地存储，跳转到 IAM 登录页重新登录。

### Q4: 退出后自动登录

需要调用 IAM 的退出接口（`/cas/logout`）清除 IAM 会话，否则 IAM 会自动重新认证。

## 7. 总结

通过对接 IAM 统一认证平台，实现了：

- **单点登录**：一次登录，全平台通行
- **自动同步**：用户信息自动从 IAM 同步
- **安全会话**：JWT 无状态会话管理
- **统一退出**：一处退出，全平台退出

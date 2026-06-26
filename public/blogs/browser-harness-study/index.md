# Browser Harness 学习：~1k 行代码连接 LLM 和真实浏览器

> 2026-06-25

## 写在前面

最近在研究 AI Agent 如何控制浏览器，发现了 Browser Use 团队开源的 **Browser Harness**。这个项目的核心理念非常激进：**一层薄薄的 CDP 封装，直接连到你的真实浏览器，中间没有任何东西。Agent 在执行过程中自己写缺失的代码，Harness 每次运行都在自我进化。**

项目地址：https://github.com/browser-use/browser-harness

这篇文章从 Java 工程师的视角，把这个项目的架构、核心代码、设计思想拆解一遍。

---

## 一、为什么需要 Browser Harness？

### 1.1 传统方案的问题

做 Web 自动化，Java 工程师最熟悉的是 Selenium WebDriver：

```java
// Selenium 的方式
WebDriver driver = new ChromeDriver();
driver.get("https://example.com");
WebElement btn = driver.findElement(By.id("submit"));
btn.click();
```

Selenium 的问题：
- **厚抽象**：WebDriver 协议层很厚，每个操作都要经过多次序列化/反序列化
- **选择器脆弱**：页面一改版，`By.id("submit")` 就挂了
- **Agent 无法自我修复**：选择器失效了，Agent 只能报错，不能自己改代码
- **不支持 iframe/shadow DOM 穿透**：跨域 iframe 里的元素很难操作

### 1.2 Browser Harness 的解法

Browser Harness 的思路完全不同：

```
Agent ←→ IPC ←→ Daemon ←→ CDP WebSocket ←→ Chrome
```

**没有中间层。** Agent 直接通过 CDP（Chrome DevTools Protocol）控制浏览器。CDP 是 Chrome 原生的调试协议，Chrome DevTools 用的就是这个。

```python
# Browser Harness 的方式
browser-harness <<'PY'
new_tab("https://example.com")
print(page_info())
click_at_xy(500, 300)  # 直接点坐标，不依赖选择器
PY
```

### 1.3 Java 工程师视角对比

| 维度 | Selenium WebDriver | Browser Harness (CDP) |
|------|-------------------|----------------------|
| 协议 | WebDriver (HTTP) | CDP (WebSocket) |
| 抽象层 | 厚（WebElement、By、ExpectedCondition） | 薄（直接 CDP 命令） |
| 定位方式 | 选择器（id/class/xpath） | 坐标 + JS 执行 |
| iframe 支持 | 需要 switchTo().frame() | compositor 层面穿透 |
| Shadow DOM | 需要 JavaScript 注入 | 坐标点击天然穿透 |
| Agent 自修复 | 不支持 | agent 自己写 helper |
| 性能 | 中等 | 高（WebSocket 长连接） |

---

## 二、架构拆解

### 2.1 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│  Agent (Claude Code / Codex / 任何 LLM)                      │
│  ↓ exec("browser-harness <<'PY' ... PY")                    │
├─────────────────────────────────────────────────────────────┤
│  run.py (CLI 入口)                                           │
│  ↓ ensure_daemon() → 启动 Daemon                            │
│  ↓ exec(code, globals()) → 执行 agent 写的代码              │
├─────────────────────────────────────────────────────────────┤
│  helpers.py (Agent 可调用的函数)                              │
│  click_at_xy / fill_input / js / page_info / new_tab ...    │
│  ↓ IPC 通信                                                  │
├─────────────────────────────────────────────────────────────┤
│  daemon.py (长驻进程，持有 CDP 连接)                          │
│  Daemon 类 → CDPClient → WebSocket → Chrome                 │
│  事件缓冲 / 会话管理 / Tab 切换                              │
├─────────────────────────────────────────────────────────────┤
│  Chrome (CDP endpoint)                                       │
│  chrome://inspect/#remote-debugging                          │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 四个核心文件（~1k 行）

| 文件 | 职责 | 行数 |
|------|------|------|
| `daemon.py` | CDP WebSocket 持有者，IPC 中继 | ~400 |
| `helpers.py` | CDP 封装，浏览器原语 | ~500 |
| `run.py` | CLI 入口，cloud browser 引导 | ~180 |
| `_ipc.py` | IPC 通信（Unix socket / TCP） | ~200 |

### 2.3 IPC 通信机制

Daemon 和 helpers 之间通过 IPC 通信：

```python
# _ipc.py 核心
def sock_addr(name):
    """Unix socket (POSIX) / TCP loopback (Windows)"""
    if sys.platform == "win32":
        return ("127.0.0.1", _port_for_name(name))
    return str(_xdg_home() / f"{name}.sock")

def connect(name, timeout=5.0):
    """连接到 Daemon"""
    addr = sock_addr(name)
    if isinstance(addr, tuple):
        c = socket.create_connection(addr, timeout=timeout)
    else:
        c = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        c.connect(addr)
    # ... token 验证
    return c, token
```

**Java 对比：** 如果用 Java 实现，可以用 Unix Domain Socket（Java 16+）或 Netty 的 Unix socket 支持。Selenium 用的是 HTTP，每次请求都要建立/关闭连接，性能差很多。

---

## 三、核心代码解析

### 3.1 Daemon 类：CDP 连接管理

```python
# daemon.py - Daemon 类核心
class Daemon:
    def __init__(self):
        self.cdp = None          # CDPClient 实例
        self.session = None      # 当前 CDP session
        self.target_id = None    # 当前 tab 的 targetId
        self.events = deque(maxlen=500)  # 事件缓冲
        self.dialog = None       # 原生对话框状态

    async def start(self):
        """启动 Daemon，连接 Chrome"""
        url = get_ws_url()  # 自动发现 Chrome CDP endpoint
        self.cdp = CDPClient(url)
        await self.cdp.start()
        await self.attach_first_page()
        # 注入事件监听器
        self.cdp._event_registry.handle_event = self._tap_events
```

**关键设计：**
- **自动发现**：扫描所有浏览器 profile 的 `DevToolsActivePort` 文件，找到 CDP endpoint
- **事件缓冲**：`deque(maxlen=500)` 缓存最近 500 个 CDP 事件，`drain_events()` 一次性取出
- **会话管理**：每次 `switch_tab` 都要重新 attach 并启用 Page/DOM/Runtime/Network 域

**Java 对比：** 这个设计模式在 Java 里类似 `LinkedBlockingDeque` + 事件监听器。但 Python 的 `asyncio` 比 Java 的 `CompletableFuture` 更轻量，适合 IO 密集型场景。

### 3.2 坐标点击：compositor 层面穿透

```python
# helpers.py - 坐标点击
def click_at_xy(x, y, button="left", clicks=1):
    """直接点坐标，compositor 层面穿透 iframe/shadow DOM"""
    cdp("Input.dispatchMouseEvent", type="mousePressed", x=x, y=y, 
        button=button, clickCount=clicks)
    cdp("Input.dispatchMouseEvent", type="mouseReleased", x=x, y=y, 
        button=button, clickCount=clicks)
```

**为什么用坐标而不是选择器？**

这是 Browser Harness 最核心的设计决策。Selenium 用选择器定位元素：

```java
// Selenium：选择器方式
driver.findElement(By.cssSelector("#login-btn")).click();
```

问题：
1. 选择器依赖 DOM 结构，页面改版就挂
2. 跨域 iframe 里的元素，选择器够不着
3. Shadow DOM 内部的元素，选择器穿透不了

Browser Harness 用坐标点击：

```python
# Browser Harness：坐标方式
click_at_xy(500, 300)  # 直接点屏幕坐标
```

坐标点击在 **compositor 层面** 执行，不经过 DOM，所以：
- iframe 里的元素能点到
- Shadow DOM 里的元素能点到
- 跨域 iframe 也能点到

**Agent 的工作流程：**
```
截图 → 识别按钮位置 → click_at_xy(x, y) → 再截图确认
```

### 3.3 fill_input：框架感知的输入

```python
# helpers.py - 填充输入框
def fill_input(selector, text, clear_first=True, timeout=0.0):
    """填充框架管理的输入框（React controlled, Vue v-model）"""
    # 1. 聚焦元素
    js(f"(()=>{{const e=document.querySelector({json.dumps(selector)});"
       f"if(!e)return false;e.focus();return true;}})()")
    
    # 2. 清空（Ctrl+A + Backspace）
    if clear_first:
        mods = 4 if sys.platform == "darwin" else 2
        select_all = {"key": "a", "code": "KeyA", "modifiers": mods}
        cdp("Input.dispatchKeyEvent", type="rawKeyDown", **select_all)
        cdp("Input.dispatchKeyEvent", type="keyUp", **select_all)
        press_key("Backspace")
    
    # 3. 逐字符输入
    for ch in text:
        press_key(ch)
    
    # 4. 触发框架事件
    js(f"(()=>{{const e=document.querySelector({json.dumps(selector)});"
       f"if(!e)return;"
       f"e.dispatchEvent(new Event('input',{{bubbles:true}}));"
       f"e.dispatchEvent(new Event('change',{{bubbles:true}}));}})();")
```

**为什么要触发框架事件？**

React/Vue 的输入框是"受控组件"，框架通过 `onChange` 监听输入。如果只用 `Input.insertText`，框架看不到变化，提交按钮会一直是禁用状态。

**Java 对比：** Selenium 的 `sendKeys()` 也会触发框架事件，但它是通过 WebDriver 协议间接实现的。Browser Harness 直接 dispatch DOM 事件，更底层、更可控。

### 3.4 wait_for_network_idle：网络空闲等待

```python
# helpers.py - 等待网络空闲
def wait_for_network_idle(timeout=10.0, idle_ms=500):
    """等待所有请求完成，且 idle_ms 内没有新请求"""
    deadline = time.time() + timeout
    last_activity = time.time()
    inflight = set()
    active_session = _send({"meta": "session"}).get("session_id")
    
    while time.time() < deadline:
        for e in drain_events():
            if e.get("session_id") != active_session:
                continue  # 只看当前 tab 的事件
            method = e.get("method", "")
            params = e.get("params", {})
            if method == "Network.requestWillBeSent":
                inflight.add(params.get("requestId"))
                last_activity = time.time()
            elif method in ("Network.loadingFinished", "Network.loadingFailed"):
                inflight.discard(params.get("requestId"))
                last_activity = time.time()
        
        if not inflight and (time.time() - last_activity) * 1000 >= idle_ms:
            return True
        time.sleep(0.1)
    return False
```

**这个设计很精巧：**
- 用 `Network.requestWillBeSent` 和 `Network.loadingFinished/Failed` 追踪请求
- 只看当前 session 的事件（防止后台 tab 干扰）
- `idle_ms=500`：请求完成后等 500ms 确认没有新请求

**Java 对比：** Selenium 没有内置的网络空闲等待。你得用 `WebDriverWait` + 自定义 ExpectedCondition，或者用 Selenium 4 的 BiDi API（但浏览器兼容性不好）。

### 3.5 Tab 管理：马emoji标记

```python
# helpers.py - Tab 切换
def switch_tab(target):
    # 取消旧 tab 的马 emoji 标记
    try:
        cdp("Runtime.evaluate", 
            expression="if(document.title.startsWith('🐴 '))document.title=document.title.slice(3)")
    except Exception: pass
    
    # 激活新 tab
    cdp("Target.activateTarget", target_id=target_id)
    sid = cdp("Target.attachToTarget", target_id=target_id, flatten=True)["sessionId"]
    _send({"meta": "set_session", "session_id": sid, "target_id": target_id})
    
    # 给新 tab 加马 emoji 标记
    _mark_tab()
    return sid
```

**为什么用马 emoji？**

Browser Harness 在 Agent 控制的 tab 标题前加 `🐴` 前缀，这样用户在 Chrome 里一眼就能看到哪个 tab 被 Agent 控制了。这是个很小的细节，但体现了"用户体验"的设计思维。

---

## 四、关键设计思想

### 4.1 Agent 自我进化

这是 Browser Harness 最激进的设计。传统自动化工具的 helper 是固定的，你只能用它提供的 API。

Browser Harness 不同：**Agent 可以在运行时修改 `agent_helpers.py`，添加自己需要的函数。**

```
Agent: 需要上传文件
  ↓
agent_helpers.py: upload_file() 不存在
  ↓
Agent: 自己写一个 upload_file()，保存到 agent_helpers.py
  ↓
下次调用就有了
```

```python
# Agent 自己写的 helper（保存在 agent_helpers.py）
def upload_to_s3(file_path, bucket):
    """Agent 在运行时创建的函数"""
    import boto3
    s3 = boto3.client('s3')
    s3.upload_file(file_path, bucket, os.path.basename(file_path))
    return f"s3://{bucket}/{os.path.basename(file_path)}"
```

**Java 对比：** 这在 Java 里很难实现，因为 Java 是编译型语言。你不能在运行时动态添加方法到一个类里。Python 的动态性让这成为可能。

### 4.2 Domain Skills：可复用的站点知识

```
agent-workspace/domain-skills/
├── github/
│   ├── create-pr.md        # 创建 PR 的步骤
│   └── review-code.md      # Code Review 的技巧
├── linkedin/
│   └── send-message.md     # 发消息的流程
└── amazon/
    └── place-order.md      # 下单的步骤
```

**Domain Skills 是什么？**

当 Agent 在某个网站上搞清楚了怎么操作（比如 GitHub 的 PR 流程），它会把这些知识写成 markdown 文件，存到 `domain-skills/` 目录。下次再访问同一个网站，Agent 会先读这些 skill，不用重新摸索。

**这就是"自我进化"的含义：**
- 第一次访问 GitHub：Agent 花 10 分钟摸索
- Agent 把学到的东西写成 skill
- 第二次访问 GitHub：直接读 skill，1 分钟搞定

### 4.3 状态文件：让 Loop 接得上昨天

```markdown
# STATE.md

## 进行中
- 升级 lodash 到 4.x，本地测试已过，等 CI

## 今天完成
- 修掉登录接口的空指针，已合并

## 卡住了，等人看
- 支付回调偶发超时，复现不稳定，先挂起

## 下一步
- 扫一遍本周新开的 issue，挑能自动改的
```

**为什么需要状态文件？**

Agent 默认是短记忆的，这次会话学到的东西，明天重启就忘光。有句话点得很透：**agent 会忘，但 repo 不会。** 把进度写进文件，loop 才能接着昨天干。

---

## 五、Java 工程师的思考

### 5.1 如果用 Java 实现 Browser Harness

Browser Harness 用 Python 实现，但如果用 Java，会是什么样？

```java
// 概念性的 Java 实现
public class BrowserHarness {
    private final CDPClient cdp;
    private final Daemon daemon;
    
    // 坐标点击
    public void clickAtXY(int x, int y) {
        cdp.send("Input.dispatchMouseEvent", 
            Map.of("type", "mousePressed", "x", x, "y", y));
        cdp.send("Input.dispatchMouseEvent", 
            Map.of("type", "mouseReleased", "x", x, "y", y));
    }
    
    // JS 执行
    public Object js(String expression) {
        var result = cdp.send("Runtime.evaluate", 
            Map.of("expression", expression, "returnByValue", true));
        return result.get("result").get("value");
    }
}
```

**Java 的优势：**
- 类型安全，编译期检查
- 更好的并发支持（Virtual Thread）
- 生态成熟（Selenium、Playwright Java）

**Java 的劣势：**
- 不支持运行时动态添加方法（Agent 自我进化难实现）
- 启动慢（JVM 预热）
- 代码量大（Python 的简洁性无法比拟）

### 5.2 CDP vs WebDriver 协议

| 维度 | CDP | WebDriver |
|------|-----|-----------|
| 通信方式 | WebSocket 长连接 | HTTP 短连接 |
| 性能 | 高（持久连接） | 中（每次请求建连） |
| 浏览器支持 | Chrome/Chromium only | 所有主流浏览器 |
| 功能丰富度 | 极高（Performance、Network、DOM 全覆盖） | 中等 |
| 标准化 | Chrome 私有 | W3C 标准 |

**选择建议：**
- 只控制 Chrome → 用 CDP（Browser Harness）
- 需要多浏览器 → 用 WebDriver（Selenium）或 Playwright

### 5.3 薄封装 vs 厚抽象

Browser Harness 的哲学是**薄封装**：只提供最基本的 CDP 封装，复杂逻辑让 Agent 自己写。

Selenium 的哲学是**厚抽象**：WebElement、ExpectedCondition、WebDriverWait 一大堆封装。

**哪个更好？**

取决于谁在写代码：
- **人写代码** → 厚抽象好（API 丰富，开箱即用）
- **Agent 写代码** → 薄封装好（Agent 能自己组合，不需要你预设所有场景）

Browser Harness 选择了薄封装，因为它假设 Agent 会自己写缺失的部分。这是对 Agent 能力的信任。

---

## 六、实际使用示例

### 6.1 基本操作

```bash
# 安装
uv tool install --python 3.12 --upgrade --force browser-harness

# 测试连接
browser-harness <<'PY'
print(page_info())
PY

# 打开新 tab
browser-harness <<'PY'
new_tab("https://github.com")
print(page_info())
PY

# 截图
browser-harness <<'PY'
capture_screenshot("/tmp/github.png")
PY
```

### 6.2 自动化任务

```bash
# 自动登录（Agent 写的代码）
browser-harness <<'PY'
new_tab("https://example.com/login")
wait_for_load()
# Agent 识别到用户名输入框在 (300, 200)
click_at_xy(300, 200)
type_text("my_username")
# Agent 识别到密码输入框在 (300, 250)
click_at_xy(300, 250)
type_text("my_password")
# Agent 识别到登录按钮在 (300, 300)
click_at_xy(300, 300)
wait_for_load()
print(page_info())
PY
```

### 6.3 Domain Skill 示例

```markdown
# github/create-pr.md

## 创建 PR 的步骤

1. 确保在正确的分支上：`git branch` 检查
2. 推送分支：`git push origin HEAD`
3. 打开 GitHub PR 页面：`new_tab("https://github.com/{owner}/{repo}/compare/{branch}")`
4. 填写标题：`fill_input("input[name='pull_request[title]']", title)`
5. 填写描述：`fill_input("textarea[name='pull_request[body]']", description)`
6. 点击创建：`click_at_xy(...)` (坐标需要每次截图确认)
7. 等待页面加载：`wait_for_load()`

## 常见问题
- 如果 CI 红了，先修再提 PR
- 描述里要写清楚改了什么、为什么改
```

---

## 七、总结

Browser Harness 给我最大的启发是：**Agent 时代的工具设计思路和人写代码时完全不同。**

| 维度 | 人写代码的工具 | Agent 写代码的工具 |
|------|--------------|------------------|
| API 设计 | 丰富、开箱即用 | 薄封装、Agent 自己组合 |
| 错误处理 | try-catch | Agent 自己写修复逻辑 |
| 定位方式 | 选择器 | 坐标 + 截图 |
| 可扩展性 | 插件机制 | Agent 自己写 helper |
| 学习曲线 | 低 | Agent 自己学 |

**一句话：Browser Harness 不是给"人"用的自动化工具，是给"Agent"用的浏览器操作系统。**

项目地址：https://github.com/browser-use/browser-harness

---

*参考：*
- *Browser Harness GitHub — https://github.com/browser-use/browser-harness*
- *Browser Use 官网 — https://browser-use.com*
- *The Bitter Lesson of Agent Harnesses — https://browser-use.com/posts/bitter-lesson-agent-harnesses*
- *Web Agents That Actually Learn — https://browser-use.com/posts/web-agents-that-actually-learn*

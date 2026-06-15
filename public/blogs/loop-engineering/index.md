## 写在前面

最近 AI 圈冒出一个新词：Loop Engineering（循环工程）。点火的是 OpenClaw 作者 Peter Steinberger，定名的是 Google Cloud AI 总监 Addy Osmani，背书的是 Claude Code 创始人 Boris Cherny。三个人在同一周说了同一件事：**别再给 Agent 写 Prompt 了，去设计那个替你写 Prompt 的系统。**

但 Loop Engineering 不是凭空冒出来的。往前捋，是 Prompt Engineering → Context Engineering → Harness Engineering → Loop Engineering 这条线。每个新词的出现，背后都是同一件事：**上一个瓶颈被解决了，新的瓶颈暴露出来了。**

这篇文章把四个阶段掰开揉碎讲清楚，然后重点拆解 Loop Engineering 到底怎么落地。

---

## 一、四个 Engineering，到底在 Engineering 什么？

### 1.1 Prompt Engineering——怎么说

2023 年。模型只会一问一答，你问得好不好直接决定答得好不好。大家研究话术：Role-Playing、Chain-of-Thought、Few-Shot Example。

本质是：**跟一个聪明但一根筋的实习生说话的技巧。** 同一件事换个问法，效果天差地别。这个阶段的瓶颈卡在「怎么说」。

### 1.2 Context Engineering——喂什么

2025 年。模型变强了，开始当 Agent 干活了，光会说话不够用了。你让它改一个 bug，Prompt 写得再漂亮也没用，因为它没看过你的代码、不知道你的规范、不了解之前的讨论。

瓶颈从「怎么问」移到了「喂什么」：把对的代码、文档、Tool、历史记忆，在对的时机塞进 Context Window。Shopify CEO Toby Lütke 和 Karpathy 先后带火了这个说法。

类比：你不再纠结怎么跟实习生说话，而是开始给他准备一桌整理好的资料。

### 1.3 Harness Engineering——在什么环境里干

2026 年初。模型已经能连续干几个小时的活了，这时候卡脖子的不再是材料，而是它干活的「环境」。

它需要 Tool 去执行命令、需要权限边界防止误伤、需要 Sandbox 安全地试错、需要派出 Sub-Agent 分头探索、需要上下文管理机制防止越干越糊涂。这一整套围绕模型搭建的运行装备，业内叫 **Harness**（直译是马具，可以理解成 Agent 的驾驶舱）。

Anthropic、OpenAI、LangChain 几家几乎同时发文章讨论这件事。有个很好记的公式：**Agent = Model + Harness。** 同一个模型，Harness 不一样，能力可以差出几倍。

### 1.4 Loop Engineering——谁来按回车

话术、材料、驾驶舱，三道坎都迈过去了。最后剩下的瓶颈是谁？

**你自己。**

模型在等你布置任务，Harness 在等你启动，材料在等你投喂。整条流水线上，唯一还需要人肉驱动的环节，就是你坐在屏幕前敲下一条 Prompt。你睡觉，它就停工。

Loop Engineering 瞄准的就是这最后一环：设计一个系统，让「下一次回车」不再由你来按。

### 1.5 瓶颈迁移的规律

看出规律了吗？模型每变强一截，瓶颈就往外移一层：从你说的那句话，到你给的那堆材料，到它干活的环境，最后落到你本人身上。

**四个 Engineering，本质是同一场瓶颈迁移。最后一个瓶颈，是坐在键盘前的你。**

---

## 二、Loop Engineering 到底是什么？

Addy Osmani 给的定义：

> Loop Engineering 就是把「亲自给 Agent 写 Prompt 的那个你」替换掉。你转而去设计那个代替你做这件事的系统。

说人话：过去两年，你跟 Coding Agent 的协作方式是回合制的——你写一条 Prompt，读它的输出，再写下一条。Agent 是工具，你全程握着它，一回合都不能松手。

Loop Engineering 说的是：**松手吧。** 你把「发现任务、布置任务、检查结果、决定下一步」这套流程设计成一个能自己运转的循环，然后让循环去握着 Agent。

打个比方。以前你是客服热线的接线员，每个电话都要你亲自接、亲自答；现在你升级成了设计工单系统的人：电话怎么分流、哪类问题转给谁、办结标准是什么、办不了的怎么升级到你，规则定好，系统自己转。

Claude Code 创始人 Boris Cherny 说的那句「我的工作是写 Loop」，真正的重点是：**工作没有变容易，是杠杆的支点移动了。**

以前你写一条好 Prompt，收益是「这一次回答变好」；现在你设计一个好 Loop，收益是「之后每一次循环都变好」。投入从消耗品变成了资产。

**一句话：你不再是 Prompt 的作者，你是 Prompt 生产系统的设计师。**

---

## 三、一个 Loop 由什么组成？

把那些真正跑起来的 Loop 拆开看，零件出奇地一致：**五大件，外加一个记东西的地方。**

### 3.1 Automation——Loop 的心跳

你写了一个很完美的工作流脚本，但每次都要你手动启动，它算 Loop 吗？

**不算。Automation 才让 Loop 成为真正的 Loop，否则它只是一个你跑过一次的任务。**

所以第一件就是定时或事件触发：每天早上自动扫一遍 CI 失败、每次 PR 合并自动跑一轮检查。心跳有了，循环才算活着。

在 Claude Code 里，这对应 `/loop`（按节奏重复跑）、`/goal`（跑到条件为真才停）、Cron 计划任务、Hooks。

### 3.2 Worktree——让并行不变成打架

Loop 一旦跑起来，经常是几个 Agent 同时干活。两个 Agent 同时改同一个文件，就像两个工程师挤在同一台电脑上改同一行代码。

解法是 Git 的 **Worktree** 机制：给每个 Agent 一个独立的工作目录和独立分支，共享同一份仓库历史，但物理上互不干扰。各干各的，最后各开各的 PR。

### 3.3 Skill——治好 Agent 的「金鱼记忆」

Agent 有个天生缺陷：每个会话都是冷启动，你项目里的规范、约定、坑，它一概不知。于是你不得不像对金鱼一样，每个会话把项目重新解释一遍。

**Skill 就是把这些项目知识写成文件放在仓库里，让 Agent 该用的时候自己读。**

没有 Skill，Loop 每个周期都从零重新推导你的项目；有了 Skill，知识是复利的。这就是 Addy Osmani 说的「意图债」（Intent Debt）——你意图里留的任何窟窿，Agent 都会拿一个自信的猜测去填。Skill 把意图写在了外面。

### 3.4 Connector——让 Loop 摸到真实世界

一个只能看见文件系统的 Loop，撑死了算半个 Loop。

真实的工作流不止于代码：要读 Issue 工单、查监控、发消息、开 PR。**Connector（基于 MCP 协议的连接器）就是把这些外部系统接进来的桥。**

接上之后的差别有多大？一个 Agent 只会告诉你「修复方案在这里」，而一个完整的 Loop 会自己开好 PR、关联好工单，等 CI 变绿之后自己去频道里通知人。

### 3.5 Sub-Agent——写的人和查的人必须分开

五大件里最有用的结构性设计，遥遥领先的一条：**把写代码的 Agent 和检查代码的 Agent 分开。**

为什么？理由只有一句话：**写代码的那个模型，给自己的作业打分时，实在太手下留情了。**

让 A 出方案，让一个干净上下文的 B 来挑刺，B 没有「希望自己是对的」的包袱，挑出来的问题才是真问题。

在 Claude Code 里，子 Agent 放在 `.claude/agents/` 目录下，每个都有独立的指令和模型配置。常见的分工是：一个探索，一个实现，一个对着规格说明做验证。

### 3.6 Memory——Loop 的命根子

模型在两次运行之间会忘掉一切。今天的循环干了什么、哪些做完了、哪些卡住了，明天的循环一概不知道。

解法朴素到让人意外：**把记忆放在磁盘上，而不是上下文里。** 一个 Markdown 文件、一个任务看板，什么都行，只要它活在单次对话之外。

Addy Osmani 留了一句很妙的总结：**「Agent 会忘，但 Repo 不会。」**

---

## 四、拼起来之后，一个真实的 Loop 长什么样？

Addy Osmani 在文章里给了一个他自己在用的 Loop，任务是：**每天早上自动把项目里值得修的问题找出来、修好、提交审核。**

1. 每天早晨，Automation 准时触发，调用一个负责 Triage 的 Skill
2. 这个 Skill 去读昨天的 CI 失败记录、还没关闭的 Issue、最近的提交，把「哪些问题值得处理」写进一个状态文件
3. 对每一个值得做的问题，开一个隔离的 Worktree，派一个 Sub-Agent 进去起草修复
4. 第二个 Sub-Agent 登场，对照项目的 Skill 规范和现有测试，把草稿审一遍
5. 审过了，Connector 自动开 PR、更新对应的工单
6. Loop 搞不定的问题，不硬来，丢进一个待办收件箱，等真人来看
7. 所有经过都写回状态文件。明天早上的循环从今天停下的地方继续

整个过程里，**你只设计了一次，中间的任何一步，你都没有写过 Prompt。**

---

## 五、工具已经追上来了，现在就能搭

一年前，搭一个 Loop 意味着写一堆只有你自己看得懂的 Bash 脚本。而现在，五大件全部内置在主流产品里了。

| 部件 | 职责 | Claude Code | Codex |
|------|------|------------|-------|
| Automation | 定时发现和分诊 | `/loop`、Cron、Hooks | Automations 面板 |
| Worktree | 隔离并行任务 | `git worktree`、`isolation: worktree` | 内置 Worktree |
| Skill | 固化项目知识 | `SKILL.md` | Agent Skills |
| Connector | 连接外部工具 | MCP Servers | MCP Connectors |
| Sub-Agent | 写查分离 | `.claude/agents/` | `.codex/agents/` |
| Memory | 追踪进度 | Markdown、MCP 接 Linear | Markdown、接 Linear |

两家产品的部件几乎一一对应。**Loop 的设计正在变得工具无关。** 选 Codex 还是 Claude Code 这种争论的重要性在下降——Loop 的设计图纸是你的资产，画好了，放在哪家产品上都能转。

### 30 秒搭出你的第一个 Loop

拿一个所有人都烦过的场景：你提了个 PR，然后开始等 CI。挂了，切回去看日志、改、推送，再等。一下午切了八次窗口。

在 Claude Code 里，一条命令就能交出去：

```
/loop 10m 检查当前分支 PR 的 CI 状态：有失败的检查就读日志、修复、推送；全部变绿后停下来，给我一句话总结改了什么
```

拆开看，麻雀虽小，Loop 的骨架是全的。`10m` 是心跳，中间是任务，最后一句是停止条件加汇报。敲下去之后你就可以去干别的了。

**部件是一件一件长出来的，不是一天配齐的。** 先让最小的循环转起来，哪天你觉得「它自己改的代码我不放心」，再把检查的 Sub-Agent 加上。

---

## 六、三盆冷水

泼得最狠的不是哪个反对派，恰恰是给概念定名的 Osmani 本人：「现在还早，我是持怀疑态度的。」

### 冷水一：验证仍然归你

Loop 无人值守地运行，听起来很美。但换个角度念这句话：**一个无人值守运行的 Loop，也是一个无人值守犯错的 Loop。**

就算你配了负责检查的 Sub-Agent，也别高兴太早：检查 Agent 嘴里的「Done」，只是一个声明，不是一个证明。

### 冷水二：理解债，越顺滑涨得越快

Loop 交付你没写过的代码越快，「仓库里实际存在的东西」和「你脑子里真正理解的东西」之间的鸿沟就越大。

这叫 **Comprehension Debt（理解债）**。它和技术债不一样：技术债是代码烂，理解债是代码可能不烂，但你不知道它为什么是对的。一个顺滑的 Loop 不会帮你还这笔债，只会让它涨得更快。

### 冷水三：认知投降，最舒服的姿势最危险

Loop 自己转起来之后，你会发现一个特别舒服的姿势：不再对产出有自己的观点，它给什么就收什么。

这叫 **Cognitive Surrender（认知投降）**。Osmani 的原话非常锋利：

> 带着判断力去设计 Loop，它是解药；为了逃避思考去设计 Loop，它是助燃剂。同一个动作，相反的结果。

---

## 总结

三句话：

**第一，** 从 Prompt 到 Context 到 Harness 再到 Loop，四个词是一场瓶颈迁移：模型越强，瓶颈越往外移，最后移到了「亲自按回车的你」身上。

**第二，** 一个 Loop 等于五大件加一份磁盘记忆：Automation 是心跳，Worktree 防打架，Skill 治金鱼记忆，Connector 摸到真实世界，Sub-Agent 写查分离，状态文件让明天接得上今天。

**第三，** Loop 把你的杠杆变长了，但 Comprehension Debt、Cognitive Surrender、验证这三笔账也同时变大了。工具分不出你是在加速还是在逃避，你自己分得出。

最后引用 Osmani 的一段话：

> 两个人可以搭一模一样的 Loop，得到完全相反的结果。一个用它在自己深刻理解的工作上加速，另一个用它彻底逃避理解工作。Loop 分不出区别，你分得出。

---

*参考：*
- *Addy Osmani《Loop Engineering》— https://addyosmani.com/blog/loop-engineering*
- *小林《四个 Engineering 的演进》— https://mp.weixin.qq.com/s/fhx_Lozs5G-sX11b7wnZgg*
- *Peter Steinberger 原帖 — https://x.com/steipete/status/2063697162748260627*
- *Boris Cherny 访谈《Claude Code & the Future of Engineering》*

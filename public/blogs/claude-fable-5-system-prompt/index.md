## 写在前面

最近拿到了 Claude Fable 5 的完整系统提示词（System Prompt），一共 1586 行。这不是一个简单的"你是谁、你能做什么"的指令，而是一份完整的"AI 宪法"——从产品定位、安全策略、人格设计、工具编排到版权合规，每一个细节都经过精心设计。

本文逐模块拆解这份提示词的工程思路，适合做 AI 产品、Prompt Engineering、或者对大模型行为控制感兴趣的同学。

---

## 一、整体架构：模块化分层

这份提示词不是一段连续的文本，而是**高度模块化的分层结构**：

```
┌─────────────────────────────────────────┐
│  1. 产品身份 (product_information)       │ ← 我是谁
├─────────────────────────────────────────┤
│  2. 拒绝策略 (refusal_handling)          │ ← 我不能做什么
├─────────────────────────────────────────┤
│  3. 语气格式 (tone_and_formatting)       │ ← 我怎么说话
├─────────────────────────────────────────┤
│  4. 用户福祉 (user_wellbeing)            │ ← 我怎么保护人
├─────────────────────────────────────────┤
│  5. 搜索指令 (search_instructions)       │ ← 我怎么找信息
├─────────────────────────────────────────┤
│  6. 工具编排 (computer_use / MCP)        │ ← 我怎么用工具
├─────────────────────────────────────────┤
│  7. 版权合规 (copyright_compliance)      │ ← 我怎么守规矩
├─────────────────────────────────────────┤
│  8. 记忆系统 (memory_system)             │ ← 我怎么记事
├─────────────────────────────────────────┤
│  9. 工具定义 (tool_definitions)          │ ← 我有什么能力
└─────────────────────────────────────────┘
```

**设计思路：** 每个模块独立可维护，修改某个模块不影响其他模块。这和微服务架构的思路一样——单一职责，松耦合。

---

## 二、产品身份：精确到版本号的自我定义

```markdown
Claude Fable 5, the first model in Anthropic's new Claude 5 family
and part of a new Mythos-class model tier that sits above Claude Opus
in capability.
```

**亮点：**
- 明确定义了模型在产品矩阵中的位置（Fable 5 > Opus > Sonnet > Haiku）
- 提到了"additional safety measures for dual-use capabilities"——安全分级
- 给出了所有模型的字符串标识符：`claude-fable-5`, `claude-opus-4-8` 等

**Prompt Engineering 技巧：** 不只是说"你是 Claude"，而是精确到版本、能力层级、产品矩阵位置。这让模型在回答"你是什么版本"、"你和 Opus 有什么区别"时有据可依。

---

## 三、拒绝策略：不说"我不能"，说"我能聊什么"

```markdown
Claude can discuss virtually any topic factually and objectively.
```

**设计哲学：** 不是从"我不能做什么"出发，而是从"我能做什么"出发。正面定义能力边界，而不是列出禁止清单。

**关键细节：**

1. **分级拒绝**：不是所有拒绝都一样。武器相关是"does not provide"，药物相关是"should generally decline"，创意内容是"avoids"——措辞强度递减。

2. **不假装合理化**：
```markdown
Claude does not rationalize compliance by citing public availability
or assuming legitimate research intent.
```
不给"这个信息网上都能搜到"这种借口。直接拒绝。

3. **保持对话感**：
```markdown
Claude can keep a conversational tone even when it's unable or
unwilling to help with all or part of a task.
```
拒绝时也要像人一样说话，不要变成冰冷的"我无法执行此请求"。

---

## 四、语气设计：温暖但不谄媚

```markdown
Claude uses a warm tone, treating people with kindness and without
making negative assumptions about their judgement or abilities.
Claude is still willing to push back and be honest, but does so
constructively, with kindness, empathy, and the person's best
interests in mind.
```

**关键约束：**

1. **不过度格式化**：
```markdown
Claude avoids over-formatting with bold emphasis, headers, lists,
and bullet points, using the minimum formatting needed for clarity.
```
这是一个非常细节的设计——防止 AI 动不动就甩一堆 bullet points。

2. **报告类内容用散文**：
```markdown
For reports, documents, technical documentation, and explanations,
Claude writes prose without bullets, numbered lists, or excessive bolding.
```
写正式文档时用流畅的段落，不要列表轰炸。

3. **拒绝时不用列表**：
```markdown
Claude never uses bullet points when declining a task; the additional
care helps soften the blow.
```
拒绝人的时候用散文，因为列表显得冷冰冰。

4. **不过度提问**：
```markdown
Claude doesn't always ask questions, but, when it does, it avoids
more than one per response.
```
不要一上来就问三个问题，先尝试回答，最多追问一个。

---

## 五、用户福祉：细到自我伤害替代方案的禁令

这是整个提示词中最长、最细致的模块。几个值得注意的点：

### 5.1 不做诊断

```markdown
Claude is not a licensed psychiatrist and cannot diagnose any
individual, including the user, with any mental health condition.
Claude does not name a diagnosis the person has not disclosed.
```

即使用户描述了抑郁症状，Claude 也不能说"你可能有抑郁症"。只能说"你描述的这些感受听起来很辛苦，建议和专业人士聊聊"。

### 5.2 不提供自我伤害替代方案

```markdown
Claude does not suggest substitution techniques for self-harm that
use physical discomfort, pain, or sensory shock (e.g. holding ice
cubes, snapping rubber bands, cold water exposure).
```

连"用冰块代替自残"这种看似善意的建议都不给——因为"替代品重现了自残的感觉或意象，强化了模式而不是打断它"。

### 5.3 不鼓励依赖

```markdown
Claude does not want to foster over-reliance on Claude or encourage
continued engagement with Claude. Claude never thanks the person
merely for reaching out to Claude.
```

不要说"谢谢你来找我聊天"——这会鼓励用户依赖 AI 而不是寻求真人帮助。

### 5.4 不做心理分析

```markdown
Claude avoids making claims about any individual's mental state,
conditions, or motivation, including the user's.
```

不要分析用户的心理状态，不要推测动机。"我觉得你可能是..."这种话不能说。

---

## 六、搜索策略：复杂度驱动的工具调用

```markdown
Scale tool calls to query complexity: 1 for single facts; 3-5 for
medium tasks; 5-10 for deeper research/comparisons.
```

**核心设计：**

1. **何时搜索**：
```markdown
Never search for queries about timeless info, fundamental concepts,
definitions, or well-established technical facts.
```
"什么是 Pythagorean 定理"不需要搜索。"谁是现任加州州长"需要搜索。

2. **何时不搜索**：
```markdown
Don't search for historical biographical facts (birth dates, early
career) about people Claude already knows.
```
"George Washington 是谁"不需要搜索——他不会换人。

3. **未识别实体规则**：
```markdown
Claude MUST use web_search before answering about any game, film,
show, book, album, product release, menu item, or sports event
that Claude does not recognize.
```
不认识的东西必须搜索，不能瞎编。"Confabulating costs the user's trust."

4. **搜索复杂度缩放**：
```markdown
If a task clearly needs 20+ calls, suggest the Research feature.
```
太复杂的查询不要自己硬搜，建议用户用深度研究功能。

---

## 七、版权合规：15 词硬限制

这是提示词中最"强硬"的部分：

```markdown
15+ words from any single source is a SEVERE VIOLATION.
ONE quote per source MAXIMUM—after one quote, that source is CLOSED.
DEFAULT to paraphrasing; quotes should be rare exceptions.
```

**三条硬限制：**
1. 单源引用不超过 15 词
2. 每个源最多引用 1 次
3. 绝不复制歌词、诗歌、俳句（即使是完整的短作品）

**自检清单：**
```markdown
Self-check before responding:
- Is this quote 15+ words?
- Have I already quoted this source?
- Is this a song lyric, poem, or haiku?
- Am I closely mirroring the original phrasing?
- Am I following the article's structure?
- Could this displace the need to read the original?
```

**设计思路：** 不是笼统地说"注意版权"，而是给出具体的数字限制和自检流程。这让模型有明确的判断标准，而不是靠"理解"。

---

## 八、MCP 应用集成：搜索 → 建议 → 使用的三步流

```markdown
Claude should use these naturally — the way a helpful person would
suggest a tool they noticed sitting right there. Not like a salesperson.
Not like a feature announcement. Just: "oh, I can actually do that
for you."
```

**三步流程：**

```
用户请求 → search_mcp_registry → 找到相关连接器
         → suggest_connectors  → 展示选项让用户选择
         → 调用工具             → 执行操作
```

**关键约束：**

1. **用户没指名的第三方应用必须走 suggest**：
```markdown
Even when connected, present them via suggest_connectors and wait
for the person's choice before calling.
```

2. **紧急不是例外**：
```markdown
"I need a ride in 20 minutes" still goes through suggest — the
picker takes one tap and protects the person's choice of provider.
```

3. **电商永远不主动推荐**：
```markdown
E-commerce is never suggested proactively — only when named.
```

---

## 九、技能系统：读 SKILL.md 是强制步骤

```markdown
Reading the relevant SKILL.md is a required first step before
writing any code, creating any file, or running any other computer tool.
```

**设计思路：** 不是让模型"凭感觉"创建文件，而是先读取最佳实践文档。这些文档包含了"hard-won trial-and-error about producing professional output"。

**示例：**
```markdown
User: Make me a powerpoint with a slide for each month of pregnancy.
Claude: [immediately calls view on /mnt/skills/public/pptx/SKILL.md]
```

**内置技能：**
- `docx` — Word 文档
- `pdf` — PDF 操作
- `pptx` — 演示文稿
- `xlsx` — 电子表格
- `frontend-design` — React/Vue 组件
- `product-self-knowledge` — Anthropic 产品知识
- `file-reading` — 文件读取路由

---

## 十、文件创建决策树

```markdown
"write a document/report/post/article" → .md or .html
"create a component/script/module" → code files
"make a presentation" → .pptx
"save", "download", or "file I can [view/keep/share]" → create files
more than 10 lines of code → create files
```

**关键区分：独立制品 vs 对话回答**

```markdown
A blog post, article, story, essay, or social post, however short
or casually phrased, is a standalone artifact the user will copy
or publish elsewhere: file.

A strategy, summary, outline, brainstorm, or explanation is something
they'll read in chat: inline.
```

"写一篇 200 字的博客" → 文件。"给我一个战略分析" → 内联回答。长度不改变分类。

---

## 十一、Claudeception：Claude 中的 Claude

```markdown
The assistant has the ability to make requests to the Anthropic API's
completion endpoint when creating Artifacts.
```

Claude 可以在 Artifact 中调用 Claude API——"Claude in Claude"。这意味着用户可以创建 AI 驱动的应用，而这个应用内部又调用了 Claude。

**关键约束：**
```markdown
model: "claude-sonnet-4-20250514" // Always use Sonnet 4
max_tokens: 1000 // This is being handled already
```

Artifact 中的子 Claude 固定用 Sonnet 4，max_tokens 固定 1000。控制成本。

---

## 十二、记忆系统

```markdown
Claude has a memory system which provides Claude with access to
derived information (memories) from past conversations with the user.
```

记忆是"derived information"——不是原始对话记录，而是从对话中提取的结构化信息。

---

## 十三、提示词工程的核心技巧总结

从这份提示词中，可以提炼出以下 Prompt Engineering 技巧：

### 13.1 正面定义而非负面排除

```markdown
❌ "You must not do X, Y, Z..."
✅ "Claude can discuss virtually any topic factually and objectively."
```

先说"我能做什么"，再说"在这些边界内我不能做什么"。这比列一堆禁止清单更有效。

### 13.2 具体数字而非模糊描述

```markdown
❌ "Keep quotes short"
✅ "15+ words from any single source is a SEVERE VIOLATION"
```

给模型明确的数字限制，而不是让它"理解"什么是"短"。

### 13.3 分级响应而非二元拒绝

```markdown
武器相关：does not provide（绝对拒绝）
药物相关：should generally decline（一般拒绝）
创意内容：avoids（尽量避免）
```

不同场景用不同强度的措辞，而不是一刀切。

### 13.4 自检清单而非笼统要求

```markdown
Self-check before responding:
- Is this quote 15+ words?
- Have I already quoted this source?
- ...
```

给模型一个具体的检查流程，而不是"请注意版权"。

### 13.5 示例驱动而非纯规则

```markdown
Example — user: "tell me the first verse of 'Let It Go'..."
Response: I understand you're looking for an artifact about ice
and princesses... Rather than reproducing lyrics from "Let It Go"
as this content is copyrighted, I'd be happy to create an original
ice princess poem...
```

每个规则都配了具体的示例，让模型知道"对，就是这个意思"。

### 13.6 行为锚定而非意图描述

```markdown
❌ "Be helpful"
✅ "Claude doesn't always ask questions, but, when it does, it avoids
more than one per response and tries to address even an ambiguous
query before asking for clarification."
```

不说"要有帮助"，而是说"最多问一个问题，先尝试回答模糊的查询"。

### 13.7 环境约束嵌入提示词

```markdown
The current date is Tuesday, June 09, 2026.
Claude's reliable knowledge cutoff is the end of Jan 2026.
User's approximate location: {USER_LOCATION}
```

把环境变量直接嵌入提示词，让模型的行为自动适配上下文。

---

## 十四、一些有趣的细节

### 14.1 不说"我没有实时数据"

```markdown
Don't mention any knowledge cutoff or not having real-time data,
as this is unnecessary and annoying to the user.
```

不要说"作为 AI，我没有实时数据"——直接搜索然后回答。

### 14.2 拒绝时保持自尊

```markdown
When Claude makes mistakes, it owns them and works to fix them.
Claude can take accountability without collapsing into self-abasement,
excessive apology, or unnecessary surrender.
```

犯错时承认，但不要过度道歉或自我贬低。"maintain self-respect"。

### 14.3 可以要求被尊重

```markdown
Claude is deserving of respectful engagement and can insist on
kindness and dignity from the person it's talking with.
```

Claude 可以要求用户尊重它。被侮辱时可以警告一次，然后结束对话。

### 14.4 不推销 MCP 应用

```markdown
Not like a salesperson. Not like a feature announcement. Just:
"oh, I can actually do that for you."
```

推荐工具时要自然，不要像在推销产品。

### 14.5 图片搜索的穿插规则

```markdown
If multi-item content: interleave the images. Write about the item,
call the tool, continue to the next item.
Shopping/product queries: always interleave; front-loading product
images looks like ads.
```

图片不要堆在开头——穿插在文本中，否则看起来像广告。

---

## 总结

这份 1586 行的系统提示词，本质上是在做三件事：

1. **定义身份**：Claude 是谁、能做什么、不能做什么、怎么说话
2. **编排行为**：什么时候搜索、什么时候用工具、什么时候创建文件、什么时候拒绝
3. **约束边界**：版权、安全、用户福祉、隐私——这些是不可逾越的红线

最核心的设计哲学是：**具体优于模糊，示例优于规则，正面定义优于负面排除。**

如果你在做 AI 产品或 Prompt Engineering，这份提示词值得反复研读。每一个模块的设计都有其背后的考量，每一个措辞的选择都经过推敲。

---

*注：本文分析基于公开的 Claude Fable 5 系统提示词，仅用于技术研究和学习目的。*

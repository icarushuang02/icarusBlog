## 背景

微信公众号文章是一个封闭的内容生态——文章链接是 `mp.weixin.qq.com/s/...`，没有公开 API，也没有 RSS。想要批量获取文章内容，只能通过网页抓取。

最近需要把一些微信公众号的技术文章整理到自己的博客里，研究了一下抓取方案，记录如下。

## 微信文章的页面结构

微信公众号文章是**服务端渲染的 HTML**，文章正文在一个特定的 div 中：

```html
<div id="js_content" class="rich_media_content">
  <!-- 文章正文 HTML -->
  <section>...</section>
  <p>...</p>
</div>
```

这意味着不需要执行 JavaScript，直接请求 HTML 就能拿到内容。

## 抓取方案

### 方案一：Node.js https 模块（推荐）

最简单的方案，不需要任何第三方依赖：

```javascript
const https = require('https');

function fetchWeChatArticle(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        // 提取标题
        const titleMatch = data.match(/<title>(.*?)<\/title>/);
        const title = titleMatch ? titleMatch[1] : '';

        // 提取正文
        const contentMatch = data.match(
          /id="js_content"[^>]*>([\s\S]*?)<\/div>\s*<script/
        );
        if (!contentMatch) {
          reject(new Error('CONTENT_NOT_FOUND'));
          return;
        }

        // 剥离 HTML 标签
        let text = contentMatch[1]
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();

        resolve({ title, content: text });
      });
    }).on('error', reject);
  });
}
```

### 方案二：Python requests + BeautifulSoup

```python
import requests
from bs4 import BeautifulSoup

def fetch_wechat_article(url):
    headers = {'User-Agent': 'Mozilla/5.0'}
    resp = requests.get(url, headers=headers)
    resp.encoding = 'utf-8'

    soup = BeautifulSoup(resp.text, 'html.parser')
    content_div = soup.find(id='js_content')

    if not content_div:
        raise ValueError('CONTENT_NOT_FOUND')

    title = soup.find('title').text
    text = content_div.get_text(separator=' ', strip=True)

    return {'title': title, 'content': text}
```

### 方案三：命令行一行搞定

```bash
curl -s "URL" | grep -oP '(?<=id="js_content"[^>]*>).*?(?=</div>\s*<script)' | sed 's/<[^>]*>//g'
```

## 编码问题

微信文章使用 UTF-8 编码。在 Windows 上使用 PowerShell 的 `Invoke-WebRequest` 时，需要注意编码处理：

```powershell
$r = Invoke-WebRequest -Uri $url -UseBasicParsing
$html = [System.Text.Encoding]::UTF8.GetString($r.RawContentStream.ToArray())
```

直接使用 `$r.Content` 可能会出现乱码，因为 PowerShell 默认使用系统编码（GBK）而不是 UTF-8。

## 微信的反爬机制

微信的反爬相对温和：

1. **User-Agent 检测**：必须设置正常的浏览器 User-Agent
2. **频率限制**：短时间内大量请求会被限流
3. **Cookie 验证**：部分内容需要登录后才能查看
4. **IP 封禁**：极端情况下会封 IP

应对策略：
- 设置合理的请求间隔
- 使用代理池（如果需要批量抓取）
- 保持正常的 User-Agent

## 进阶：使用 wechat-article-exporter

如果需要批量导出某个公众号的所有文章，可以使用开源项目 [wechat-article-exporter](https://github.com/wechat-article/wechat-article-exporter)：

- 支持搜索公众号
- 支持导出 html/json/excel/txt/md/docx 格式
- HTML 格式能 100% 还原排版和样式
- 支持 Docker 部署
- 在线使用：https://down.mptext.top

原理：利用公众号后台写文章时"搜索其他公众号文章"的功能来实现抓取。

## 实际应用

我把这个抓取能力封装成了一个 Skill，当发送微信文章链接时自动触发：

1. 抓取标题和正文
2. 剥离 HTML 标签，保留纯文本
3. 根据需求进行总结、分析或改写为博客

---

**参考：**
- [wechat-article-exporter](https://github.com/wechat-article/wechat-article-exporter)
- [微信文章抓取原理](https://github.com/1061700625/WeChat_Article)

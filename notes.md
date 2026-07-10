# closed-editor-bridge 项目备忘录

## 1. 项目概述

### 1.1 项目目的

本文档详细记录 `closed-editor-bridge` Tampermonkey 用户脚本的技术架构、实现细节和开发维护指南。

**项目定位**: 面向封闭富文本编辑器的通用 Markdown 分段粘贴桥。用户手动上传图片后，脚本按 Markdown 图片标记把正文切成文字段，辅助用户把文字插回图片间隙。

**重要提示**: 每次调整脚本行为、快捷键、Markdown 清洗规则或实测平台表现后，请及时更新此备忘录。

### 1.2 核心价值

封闭富文本编辑器常见痛点：
- 不支持 Markdown 直贴
- 不稳定保留 pasted HTML
- 不保留外链图片，必须手动上传图片
- 平台 DOM、上传控件、图片节点结构差异大，且可能随时变化

本脚本只依赖这类平台稳定共享的能力：
- 用户可以手动把光标放到图片之间的目标位置
- 编辑器可以接收当前光标位置的输入

用户负责视觉定位和图片上传顺序，脚本负责结构化解析、文本清洗和段落队列插入。

---

## 2. 技术架构

### 2.1 整体架构

脚本采用**模块化对象架构**，核心模块如下：

```text
CONFIG
  │
  ├─ SHORTCUTS         快捷键配置
  └─ PREVIEW_CHARS     当前段预览长度

State
  │
  ├─ rawText           用户粘贴的 Markdown 正文
  ├─ gaps              按图片标记切出的文字段队列
  ├─ currentIndex      当前队列指针
  ├─ skippedCount      空 gap 数量
  └─ collapsed         面板折叠状态

Parser
  ├─ parse()           解析 Markdown 正文
  ├─ splitByImages()   按 Markdown 图片标记切分 gap
  ├─ toHtml()          contenteditable HTML 输出
  ├─ toPlainText()     textarea/input 纯文本输出
  └─ inlineClean()     Markdown 行内标记清洗

Storage
  └─ localStorage      持久化输入、队列、进度和折叠状态

Inserter
  ├─ insertCurrent()   在当前光标位置插入当前段
  └─ simulateArrowDown() 插入后推进光标到下一段落

UI
  ├─ create()          创建浮动面板
  ├─ bindEvents()      绑定按钮、输入框和拖拽
  ├─ advance()/prev    队列指针移动，自动跳过空 gap
  └─ render()          渲染状态和预览

Shortcuts
  └─ Alt+K / Alt+J     插入推进 / 回退

Detector
  └─ hasEditor()       检测 contenteditable 或 textarea 后才启用
```

### 2.2 运行策略

`@match *://*/*` 是刻意设计：本脚本是通用底座，不绑定具体平台域名。

启动时用 `Detector.hasEditor()` 检测页面是否含 `[contenteditable]` 或 `textarea`：
- 命中：注入浮动面板和快捷键
- 未命中：静默退出，不干扰普通页面

使用 `@run-at document-idle`，因为需要等页面主体和编辑器节点出现后再做检测型注入。

---

## 3. 输入模型

### 3.1 输入内容

用户应直接粘贴 Markdown 正文。脚本不会识别或剥离任何特定文件头或元数据区。

输入示例：

```markdown
# Section title

Paragraph before the first image.

![image alt](https://example.com/image-1.jpg)

Paragraph between image 1 and image 2.

![image alt](https://example.com/image-2.jpg)

Final paragraph.
```

### 3.2 分段规则

按 Markdown 图片语法 `![alt](url)` 切分正文：

```text
gap-0
image-1
gap-1
image-2
gap-2
...
image-N
gap-N
```

图片标记本身不会插入平台编辑器。用户应先在平台按正文图片顺序手动上传图片，再用脚本逐段插入图片之间的文字 gap。

纯空白 gap 会计入 `skippedCount`，队列移动时自动跳过。

---

## 4. 核心功能实现

### 4.1 Markdown 清洗

清洗目标是稳定插入，而不是完整 Markdown 渲染。

当前处理：
- 去标题标记 `#`
- 去无序/有序列表前缀
- 去引用前缀 `>` / `&gt;`
- 去加粗、斜体、行内代码标记
- Markdown 链接在 HTML 模式转换为 `<a>`，纯文本模式保留链接文字
- HTML 模式先转义 `< > &`，再做 Markdown 标记替换，最后把段内换行转为 `<br>`

注意：HTML 转义顺序不能调换。必须先转义用户正文里的 HTML 特殊字符，再做 Markdown 清洗，否则正文里的尖括号可能被浏览器当成标签。

### 4.2 插入方式

contenteditable 是主路径：

```javascript
document.execCommand('insertHTML', false, wrappedHtml)
```

选择原因：
- 比合成 paste 事件更可能真实改变编辑器内容
- 比直接改 DOM 更接近用户编辑行为
- 更可能进入平台编辑器自己的撤销栈

textarea/input 是纯文本编辑器路径：
- 优先尝试 `execCommand('insertText')`
- 如 `insertText` 没有生效，则直接写入 value 并派发 `input` / `change` 事件

contenteditable 插入失败后不做剪贴板、纯文本、DOM 改写等自动 fallback，避免同一次操作中重复插入。

### 4.3 光标处理

插入前要求用户先把光标放到目标编辑位置。

点击脚本面板按钮后，浏览器焦点可能转移到面板。脚本用 `lastFocusedElement` 记录最后聚焦过的编辑器元素，在执行插入时找回目标。

插入后会：
- 模拟 `ArrowDown` / `ArrowRight`
- 对 contenteditable 使用 Selection API 把光标推进到下一段或空段落

这用于减少连续插入时光标卡在刚插入文本内部的概率。

### 4.4 快捷键

| 快捷键 | 功能 |
|---|---|
| `Alt+K` | 插入当前段并推进 |
| `Alt+J` | 回退到上一段 |

焦点在脚本面板输入框时，快捷键不触发插入或回退。

### 4.5 持久化

使用 `localStorage` 保存：
- `rawText`
- `gaps`
- `currentIndex`
- `skippedCount`
- `collapsed`

刷新页面后可以恢复输入内容、解析结果、当前进度和面板折叠状态。

---

## 5. UI 与交互

### 5.1 面板

面板固定在右上角，可拖拽、可折叠，使用最高层级 `z-index: 2147483647`。

所有 CSS 选择器都使用 `#ceb-*` 前缀，避免污染宿主页面。

用户可见 UI 文案统一使用英文。README 保持中英双语，脚本界面按通用工具处理，不做中文/英文切换。

### 5.2 操作流程

```text
1. 在目标平台按正文顺序上传图片
2. 打开脚本面板
3. 粘贴 Markdown 正文，脚本自动解析
4. 点击第一个图片间隙定位光标
5. 按 Alt+K 插入当前段
6. 点击下一个图片间隙，继续 Alt+K
7. 如队列走错，用 Alt+J 回退内部指针
```

脚本的“上一步”只移动内部队列指针，不会修改平台编辑器内容。页面内容撤销交给平台自己的撤销机制。

---

## 6. 与插件化工具的关系

本项目先实现 userscript，不直接维护 Chrome Extension 代码。

`BASE_PATH_CODING/projects/browser-script-to-extension` 可以自动扫描带 `==UserScript==` 元数据的 `.js` 文件，生成 Manifest V3 插件：

```bash
python build.py /path/to/closed-editor-bridge
```

发布 Chrome Extension 前需要补齐：
- `store_assets/icon.png`
- 1 到 5 张截图
- 需要时添加 `store_assets/upload_config.json`

生成的 `extension/` 和 zip 包属于发布产物，和三个兄弟项目保持同样工作流。

---

## 7. 测试与验证

### 7.1 离线验证

脚本用 IIFE 包裹，`Parser` 不能直接 require。离线测试可用 Node `vm.runInContext()` 注入沙箱并提取 `Parser`。

已验证范围：
- 图片标记切段
- 空 gap 识别
- Markdown 清洗
- HTML 特殊字符转义
- 基础检测型注入逻辑

### 7.2 真站验证

Node 测试不能覆盖真实编辑器行为。发布前重点验证：
- 目标平台编辑器中 `insertHTML` 是否稳定插入
- 连续插入 5 段是否乱序
- 插入后平台草稿保存是否保留文本
- 平台撤销栈是否能撤销最近一次插入
- 图片批量上传顺序与 Markdown 图片顺序是否一致

---

## 8. 维护注意事项

### 8.1 不要轻易改成平台专属脚本

本项目的核心价值是通用底座。平台 adapter 只能作为后续可选增强，不应进入主流程。

检测型注入比写死平台域名更通用。若发布到 Chrome Web Store 后需要收窄权限，可优先把通用 userscript 和商店扩展作为两个发行策略处理，而不是破坏核心代码模型。

### 8.2 不要自动处理图片

脚本不上传图片、不识别图片节点、不判断当前 gap 对应哪张图。图片顺序由用户人工保证。

这是为了避开各平台最不稳定的 DOM 和上传逻辑。

### 8.3 不要增加失败后的多策略自动插入

如果 `insertHTML` 失败，同一次操作内不要自动尝试剪贴板、直接 DOM 改写或其他插入方式。多策略 fallback 很容易导致重复插入，难以恢复。

### 8.4 README 与 notes 的分工

`README.md` 面向用户和发布页面，只保留安装入口、核心用途、使用流程、功能摘要和截图/链接。

`notes.md` 面向维护者和 Agent，记录架构、输入模型、关键实现、测试策略和维护约束。

---

## 9. 发布状态

- Userscript MVP 已可用
- README 的 Greasy Fork / Chrome Web Store / ZIP 链接待发布后回填
- `store_assets/` 待补图标和截图
- `extension/` 待 `browser-script-to-extension` 生成
- git commit / push 待用户授权

---

## 10. 富文本编辑器精准检测算法

针对全网域名匹配时可能发生的“大范围误伤”（如飞书表格单元格编辑器、百度/腾讯/DeepL等在线翻译输入区、维基百科/Github等大型Wiki/Markdown纯文本域），本脚本采用了一套多维度启发式判定算法。

### 10.1 核心算法设计原则

1. **同源 Iframe 隔离判定（高置信度）**：
   - **逻辑**：大多数经典富文本编辑器（如 UEditor, TinyMCE 等）为了样式隔离，都会使用 `iframe` 并将其中的 `body` 设为 `contenteditable`。单行搜索框、聊天框、单元格等非富文本输入绝不会放在 iframe 中。
   - **尺寸宽大处理**：为了兼容 UEditor 在空内容状态下渲染高度仅有 `51px` 的极矮初始状态，对于 iframe 中的编辑器只要求基本可见度（宽度 > 100px 且高度 > 30px）。

2. **主文档 Contenteditable 限制判定（双重保护）**：
   - **逻辑**：直接在主文档中的 `[contenteditable]`（如 wangEditor, ProseMirror, Notion 等）需要与 ChatGPT/Gemini 初始聊天框、飞书表格单元格编辑框（高约 20px）进行区分。
   - **特征条件**：元素尺寸必须 $\ge 80\text{px} \times 80\text{px}$，且必须**包含已知富文本框架指纹类名**，或者页面上**伴随有富文本格式化工具栏（Toolbar）**。这能有效排除 DeepL、百度翻译等虽有大高度但无任何文本排版功能的文本翻译区域。

3. **独立 Textarea 排除原则**：
   - **逻辑**：纯文本 textarea（如维基百科编辑区、Github 评论文本域、腾讯翻译君等）完全支持直接粘贴 Markdown 全文。因此，在没有知名 Markdown 框架包裹或没有 toolbar 伴随的情况下，**无条件排除所有独立原生 textarea**。

### 10.2 算法实现参考 (JavaScript)

```javascript
    const Detector = {
        hasEditor() {
            // 1. 知名编辑器类名指纹匹配
            const knownEditorSelectors = [
                '.tox-tinymce', '.tox-editor-container',
                '.ck-editor', '.ck-content',
                '.ql-container', '.ql-editor',
                '.w-e-text-container', '.w-e-text',
                '.edui-editor', '.edui-body-container',
                '.note-editable',
                '.DraftEditor-editorContainer',
                '.medium-editor-element',
                '.editormd',
                '.CodeMirror',
                '.trix-content'
            ];
            if (document.querySelector(knownEditorSelectors.join(','))) {
                return true;
            }

            // 2. 检测同源 iframe 内部的 contenteditable
            const iframes = document.querySelectorAll('iframe');
            for (const iframe of iframes) {
                try {
                    const doc = iframe.contentDocument || iframe.contentWindow.document;
                    if (doc && doc.querySelector('[contenteditable=""], [contenteditable="true"]')) {
                        if (iframe.clientWidth > 100 && iframe.clientHeight > 30) {
                            return true;
                        }
                    }
                } catch (e) {}
            }

            // 3. 通用 contenteditable 启发式规则
            const editables = document.querySelectorAll('[contenteditable=""], [contenteditable="true"]');
            for (const el of editables) {
                if (el.id === 'ceb-input') continue;
                const rect = el.getBoundingClientRect();
                const height = rect.height || el.clientHeight;
                const width = rect.width || el.clientWidth;
                
                if (width < 80 || height < 80) continue;
                
                // 主文档 contenteditable 必须伴随有排版工具栏，以防止在翻译软件（如 DeepL, 百度翻译，高 200px+）上被误伤
                const hasToolbar = el.closest('[class*="editor"]') || 
                                  el.closest('[id*="editor"]') || 
                                  document.querySelector('[class*="toolbar"]') || 
                                  document.querySelector('[id*="toolbar"]') ||
                                  document.querySelector('[role="toolbar"]');
                if (hasToolbar) {
                    return true;
                }
            }

            // 4. Textarea 启发式规则
            const textareas = document.querySelectorAll('textarea');
            for (const ta of textareas) {
                if (ta.id === 'ceb-input') continue;
                const rect = ta.getBoundingClientRect();
                const height = rect.height || ta.clientHeight;
                const width = rect.width || ta.clientWidth;
                if (height >= 120 || ta.rows >= 8) {
                    const inEditorContainer = ta.closest('[class*="editor"]') || ta.closest('[id*="editor"]');
                    const hasToolbar = document.querySelector('[class*="toolbar"]') || 
                                      document.querySelector('[id*="toolbar"]') || 
                                      document.querySelector('[role="toolbar"]');
                    if (inEditorContainer && hasToolbar) {
                        const name = (ta.name || '').toLowerCase();
                        const id = (ta.id || '').toLowerCase();
                        const placeholder = (ta.placeholder || '').toLowerCase();
                        const ariaLabel = (ta.getAttribute('aria-label') || '').toLowerCase();
                        const isChatOrSearch = /chat|search|reply|comment|send|ask|message|搜索|聊天|评论|回复|提问/i.test(name + id + placeholder + ariaLabel);
                        if (!isChatOrSearch) {
                            return true;
                        }
                    }
                }
            }
            return false;
        }
    };
```

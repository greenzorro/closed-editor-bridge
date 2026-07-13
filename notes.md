# closed-editor-bridge 项目备忘录

## 1. 项目概述

### 1.1 项目目的

本文档详细记录 `closed-editor-bridge` Tampermonkey 用户脚本的技术架构、实现细节和开发维护指南。

**项目定位**: 面向封闭富文本编辑器的通用 Markdown 分段粘贴桥。用户手动上传图片后，脚本按 Markdown 图片标记把正文切成文字段，辅助用户把文字插回图片间隙。

**重要提示**: 每次调整脚本行为、快捷键、Markdown 清洗规则、编辑器检测规则或实测平台表现后，请及时更新此备忘录。

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

### 1.3 设计边界

这些边界来自问题本身，维护时应优先保留：
- 不自动上传图片
- 不识别平台图片节点
- 不判断当前 gap 对应哪张图
- 不绑定具体平台域名
- 不做完整 Markdown 渲染
- 不在 contenteditable 插入失败后自动尝试剪贴板、纯文本或 DOM 改写等多策略 fallback

---

## 2. 技术架构

### 2.1 整体架构

脚本采用**模块化对象架构**，核心模块如下：

```text
CONFIG
  │
  ├─ STORAGE_KEY           localStorage 前缀
  ├─ SHORTCUTS             快捷键配置
  ├─ PREVIEW_CHARS         当前段预览长度
  ├─ DETECT_POLL_MS        SPA 延迟检测轮询间隔
  ├─ DETECT_POLL_MAX_MS    延迟检测最长等待
  ├─ CURSOR_ADVANCE_MS     插入后光标推进延迟
  └─ STYLE_ID              样式节点 id（单例注入）

State
  │
  ├─ rawText           用户粘贴的 Markdown 正文
  ├─ gaps              按图片标记切出的文字段队列
  ├─ currentIndex      当前队列指针
  ├─ skippedCount      空 gap 数量
  └─ collapsed         面板折叠状态

Parser
  ├─ parse()                 解析 Markdown 正文
  ├─ splitByImages()         按图片标记切分 gap（跳过 fenced code）
  ├─ getFencedCodeRanges()   收集 ``` / ~~~ 代码块区间
  ├─ splitParagraphs()       按空行切段落（HTML/纯文本共用）
  ├─ toHtml() / toPlainText()
  ├─ sanitizeHref()          链接协议白名单
  └─ inlineClean()           行内标记清洗

Storage
  └─ localStorage            按 pathname 隔离进度；兼容旧全局 key 读取

Inserter
  ├─ insertCurrent()         在当前光标位置插入当前段
  ├─ scheduleCursorAdvance() 防抖调度光标推进
  └─ simulateArrowDown()     插入后推进光标到下一段落

UI
  ├─ create() / injectStyles()
  ├─ applyParsedInput()      解析输入；可选保留 currentIndex
  ├─ resolvePreservedIndex() 重解析后落点
  ├─ advance()/prev          队列指针移动，自动跳过空 gap
  └─ render()

Shortcuts
  ├─ Alt+K / Alt+J
  └─ bindIframe()            同源 iframe 的 keydown + focusin + load

Detector
  └─ hasEditor()             编辑器指纹与启发式

bootstrap / init
  └─ 立即检测 + 轮询 + MutationObserver，适配 SPA 晚挂载编辑器
```

### 2.2 核心模型

核心数据流：

```text
Markdown 正文
  -> 按 Markdown 图片标记切分（跳过 fenced code block）
  -> gap 队列
  -> 用户逐个定位图片间隙
  -> 脚本插入当前 gap 并推进 currentIndex
```

分段模型：

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

图片标记本身不会插入平台编辑器。纯空白 gap 会计入 `skippedCount`，队列移动时自动跳过。

### 2.3 模块职责

| 模块 | 职责 |
|---|---|
| `Parser` | 切分图片标记、跳过代码块、生成 gap、清洗并输出 HTML/纯文本；链接经协议白名单 |
| `Storage` | 按 `closedEditorBridge:{pathname}` 持久化输入、队列、进度和折叠状态 |
| `Inserter` | 将当前 gap 插入目标编辑器，并防抖推进光标 |
| `UI` | 浮动面板、拖拽折叠、解析输入时尽量保留队列进度 |
| `Shortcuts` | `Alt+K` / `Alt+J`；主文档与同源 iframe（含动态与 load 后）统一监听 |
| `Detector` | 判断当前页面是否值得注入 UI 和快捷键 |
| `bootstrap` | 检测命中后一次性创建 UI 并初始化快捷键；未命中则继续观察 |

### 2.4 运行策略

`@match *://*/*` 是刻意设计：本脚本是通用底座，不绑定具体平台域名。

使用 `@run-at document-idle`。初始化时：

1. 立即调用 `Detector.hasEditor()`；命中则 `bootstrap`（创建面板、恢复进度、绑定快捷键）
2. 未命中则启动轮询（默认 1s）与 `MutationObserver`，最长等待约 60s，以覆盖 SPA 晚挂载编辑器
3. 超时仍未命中则静默退出，不注入 UI

命中后 `bootstrapped` 置位，避免重复注入。

---

## 3. 核心功能实现

### 3.1 Markdown 分段

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

按 Markdown 图片语法 `![alt](url)` 切分正文。fenced code block（`` ``` `` / `~~~`）内的同形字符串不参与切分，避免示例代码误切队列。

用户应先在平台按正文图片顺序手动上传图片，再用脚本逐段插入图片之间的文字 gap。

### 3.2 Markdown 清洗

清洗目标是稳定插入，而不是完整 Markdown 渲染。

当前处理：
- 去标题标记 `#`
- 去无序/有序列表前缀
- 去引用前缀 `>` / `&gt;`
- 去加粗、斜体、行内代码标记
- Markdown 链接：HTML 模式在协议白名单通过后转为 `<a target="_blank" rel="noopener noreferrer">`；不安全协议只保留链接文字；纯文本模式只保留链接文字
- HTML 模式先转义 `< > &`，再做 Markdown 标记替换，最后把段内换行转为 `<br>`
- 段落切分由 `splitParagraphs()` 统一提供给 `toHtml` / `toPlainText`

注意：HTML 转义顺序不能调换。必须先转义用户正文里的 HTML 特殊字符，再做 Markdown 清洗，否则正文里的尖括号可能被浏览器当成标签。

链接 `href` 仅允许 `http(s):`、`mailto:`、站点内路径（`/`、`#`、`./`、`../`）。属性值经 `escapeAttr` 转义，拒绝 `javascript:` 等危险协议。

### 3.3 插入方式

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

### 3.4 光标处理

插入前要求用户先把光标放到目标编辑位置。

点击脚本面板按钮后，浏览器焦点可能转移到面板。脚本用统一的 `handleFocusIn` 记录主文档与同源 iframe 内最后聚焦的可编辑元素（`lastFocusedElement`），在执行插入时找回目标。

插入后通过 `scheduleCursorAdvance` 防抖调度（默认 50ms）：
- 模拟 `ArrowDown` / `ArrowRight`
- 对 contenteditable 使用 Selection API 把光标推进到下一段或空段落

防抖用于避免快速连按 `Alt+K` 时多个定时器抢 selection。

### 3.5 快捷键

| 快捷键 | 功能 |
|---|---|
| `Alt+K` | 插入当前段并推进 |
| `Alt+J` | 回退到上一段 |

焦点在脚本面板输入框时，快捷键不触发插入或回退。

### 3.6 持久化

`localStorage` key 为 `closedEditorBridge:{location.pathname}`，同 origin 不同路径互不覆盖。读取时若新 key 无数据，会尝试旧全局 key `closedEditorBridge` 以兼容历史数据。

保存字段：
- `rawText`
- `gaps`
- `currentIndex`
- `skippedCount`
- `collapsed`

刷新页面后可以恢复输入内容、解析结果、当前进度和面板折叠状态。

### 3.7 解析与队列进度

面板输入框在 `input` 时自动解析。若此前已有 gap 队列，重解析会尽量保留 `currentIndex`（`resolvePreservedIndex`）：

1. 将旧指针钳制到新队列长度内
2. 若该段仍可插入，保持不变
3. 否则向后、再向前寻找最近可插入段

首次解析或清空输入时从首个可插入段开始。清空输入会清除存储。

### 3.8 UI 与交互

面板固定在右上角，可拖拽、可折叠。折叠后显示为圆形浮标，展开后恢复完整队列面板。面板使用最高层级 `z-index: 2147483647`。

样式通过固定 id（`ceb-styles`）单例注入，避免重复 `<style>`。DOM/CSS 选择器统一 `#ceb-*` 前缀。操作按钮使用 `type="button"`。

用户可见 UI 文案统一使用英文。README 保持中英双语，脚本界面按通用工具处理，不做中文/英文切换。

操作流程：

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

## 4. 关键技术要点

### 4.1 富文本编辑器检测

针对全网域名匹配时可能发生的误注入，本脚本采用多层启发式检测。目标是覆盖封闭富文本编辑器，同时排除搜索框、聊天框、表格单元格、翻译输入区和普通 Markdown/纯文本编辑区。

当前判定顺序：

1. **已知编辑器指纹**：页面命中 TinyMCE、CKEditor、Quill、wangEditor、UEditor、Summernote、Draft.js、Medium Editor、Editor.md、CodeMirror 或 Trix 等选择器时启用。
2. **同源 iframe 编辑器**：同源 iframe 内部存在 `[contenteditable]`，且 iframe 宽度大于 100px、高度大于 30px 时启用。
3. **主文档 contenteditable**：主文档中的 `[contenteditable]` 需要至少 80px x 80px，并且页面存在 toolbar 类名、toolbar id 或 `role="toolbar"`。
4. **textarea 编辑区**：原生 textarea 需要高度至少 120px 或 `rows >= 8`，位于 editor 容器内，页面存在 toolbar，并且名称、id、placeholder、aria-label 不像搜索、聊天、评论、回复或提问输入框。

这个检测逻辑优先降低误注入风险。若某个平台被漏检，优先补充高置信度编辑器指纹或更具体的启发式条件，不要退回“只要有 contenteditable 或 textarea 就启用”的宽松策略。

### 4.2 SPA 与延迟注入

许多后台编辑页在 `document-idle` 之后才挂载编辑器。检测未命中时不永久放弃：在最长等待窗口内结合轮询与 DOM 变更观察，一旦命中即 bootstrap。维护时不要改回“只检测一次就退出”。

### 4.3 iframe 焦点与快捷键捕获

同源 iframe 内的编辑器需要：
- 插入时从 iframe 的 `contentDocument.activeElement` 获取真实目标
- 快捷键与 `focusin` 同时绑定主文档和同源 iframe 文档
- iframe 可能尚未 load：`bindIframe` 立即 attach，并在 `load` 后再 attach 一次
- 动态插入的 iframe 由 `MutationObserver` 发现并绑定

快捷键监听使用 capture 阶段，并在命中脚本快捷键后调用 `stopImmediatePropagation()`，避免宿主页面优先吞掉 `Alt+K` / `Alt+J`。

### 4.4 contenteditable 与 textarea 的差异

contenteditable 插入 HTML，以段落结构承载富文本结果；textarea/input 插入纯文本，并用换行包裹当前段。

textarea/input 路径允许在 `insertText` 未生效时直接修改 `value`，因为该路径的内容模型简单且可预测。contenteditable 路径不做同类 fallback，因为平台编辑器 DOM 不稳定，直接改 DOM 容易绕过编辑器内部状态。

### 4.5 为什么不自动处理图片

脚本不上传图片、不识别图片节点、不判断当前 gap 对应哪张图。图片顺序由用户人工保证。

这是为了避开各平台最不稳定的 DOM 和上传逻辑，也是本脚本能保持通用性的前提。

### 4.6 为什么不做多策略自动 fallback

如果 `insertHTML` 失败，同一次操作内不要自动尝试剪贴板、直接 DOM 改写或其他插入方式。多策略 fallback 很容易导致重复插入，难以恢复。

失败时应该让用户重新定位光标、检查目标编辑器或调整检测/插入策略，而不是在一次快捷键操作中叠加多种写入路径。

### 4.7 链接安全

HTML 输出中的链接必须经过 `sanitizeHref`。维护链接相关逻辑时：
- 禁止把原始 URL 直接拼进 `href`
- 保持 `rel="noopener noreferrer"` 与 `target="_blank"` 配套
- 白名单外协议降级为纯文本标签，不生成 `<a>`

---

## 5. 维护指南

### 5.1 常见问题处理

| 问题 | 可能原因 | 解决方案 |
|---|---|---|
| 面板未显示 | 检测窗口内始终未命中 | 检查指纹、同源 iframe、toolbar；必要时延长 `DETECT_POLL_MAX_MS` 或补指纹 |
| 面板误出现在普通页面 | 检测规则过宽 | 收紧启发式，优先排除搜索、聊天、翻译、评论类输入区 |
| `Alt+K` 无响应 | 快捷键被宿主或 iframe 吞掉；iframe 未 load 完 | 确认 capture 已绑到目标文档；检查 `bindIframe` 的 load 路径 |
| 插入位置错误 | 最后聚焦元素不是目标编辑器 | 重新点击目标位置，确认 `lastFocusedElement` |
| 插入后光标停在文本内部 | 平台 selection 行为特殊 | 调整 `simulateArrowDown()`，真站连续插入验证 |
| 改输入后进度跳飞 | `resolvePreservedIndex` 边界 | 检查重解析保留逻辑与空 gap 跳过 |
| Markdown 清洗异常 | 正则覆盖不足或转义顺序错误 | 最小补充规则；保持 HTML 先转义 |
| 代码示例被切成多段 | fenced 识别失败 | 检查 `getFencedCodeRanges` 是否覆盖该 fence 写法 |
| 进度串到同站其他页 | 预期按 pathname 隔离 | 确认 `storageKey()`；同 path 不同 query 仍共享 |

### 5.2 漏检与误注入处理

漏检处理优先级：
1. 补充明确的编辑器框架指纹
2. 补充更具体的 toolbar 或容器判断
3. 确认延迟检测窗口足够覆盖该 SPA
4. 针对可复现平台加入窄条件

误注入处理优先级：
1. 排除搜索、聊天、评论、翻译等输入区
2. 提高尺寸或结构门槛
3. 避免退回单纯 `[contenteditable]` / `textarea` 检测

### 5.3 Markdown 清洗规则调整

清洗规则服务于稳定插入，不追求完整 Markdown 兼容。新增规则时重点检查：
- 是否破坏 HTML 转义顺序
- 是否会误删正文中的普通符号
- HTML 模式和纯文本模式是否需要不同处理
- 链接是否仍走 `sanitizeHref` / `escapeAttr`
- 是否影响列表、引用和行内代码的现有表现
- 是否应在 fenced code 内跳过（与 `splitByImages` 一致）

### 5.4 真站验证清单

Node 测试不能覆盖真实编辑器行为。发布前重点验证：
- 目标平台编辑器中 `insertHTML` 是否稳定插入
- 连续插入 5 段是否乱序；快速连按 `Alt+K` 是否稳定
- 中途修改面板输入后进度是否仍合理
- 插入后平台草稿保存是否保留文本
- 平台撤销栈是否能撤销最近一次插入
- 图片批量上传顺序与 Markdown 图片顺序是否一致
- 含 fenced code 的 Markdown 是否被误切
- 含 `javascript:` 伪链接的正文是否只出文字、不出可点危险链接
- iframe 编辑器中快捷键与焦点恢复是否正常
- SPA 晚出现编辑器时面板是否仍能注入
- 折叠状态、输入内容和当前进度刷新后是否按当前 path 恢复

### 5.5 README 与 notes 同步规则

`README.md` 面向用户和发布页面，只保留安装入口、核心用途、使用流程、功能摘要和截图/链接。

`notes.md` 面向维护者和 Agent，记录架构、核心模型、关键实现、检测策略、测试策略和维护约束。

脚本源文件是 `closed-editor-bridge.js`。Chrome 扩展目录 `extension/` 由打包工具从脚本生成；改行为时以 userscript 为准，再按需重新打包扩展。

---

## 6. 发布与开发规范

### 6.1 Userscript 发布

Userscript 是主发布形态，README 保留 Greasy Fork 安装入口。

发布前检查：
- `@version` 字段
- README 安装链接
- notes 中涉及用户流程、快捷键、检测规则、存储、安全边界和限制的说明

### 6.2 代码风格

- 使用模块化对象组织功能
- 配置集中放在 `CONFIG`
- DOM/CSS 命名统一使用 `ceb` 前缀
- 样式单例注入（`STYLE_ID`）
- 可编辑目标判断集中在 `isEditableTarget` / `handleFocusIn`
- 只在复杂浏览器行为处保留必要注释
- 改动行为、快捷键、检测规则、清洗规则、存储或安全策略时同步更新本文档

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
  └─ hasEditor()       用编辑器指纹和启发式规则判断是否启用
```

### 2.2 核心模型

核心数据流：

```text
Markdown 正文
  -> 按 Markdown 图片标记切分
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
| `Parser` | 切分 Markdown 图片标记，生成 gap 队列，并输出 HTML 或纯文本 |
| `Storage` | 使用 `localStorage` 保存输入、队列、进度和折叠状态 |
| `Inserter` | 将当前 gap 插入目标编辑器，并处理光标推进 |
| `UI` | 创建浮动面板、处理按钮事件、渲染状态和预览 |
| `Shortcuts` | 监听 `Alt+K` / `Alt+J`，并兼容同源 iframe |
| `Detector` | 判断当前页面是否值得注入 UI 和快捷键 |

### 2.4 运行策略

`@match *://*/*` 是刻意设计：本脚本是通用底座，不绑定具体平台域名。

启动时用 `Detector.hasEditor()` 判断页面是否含真正的富文本编辑器或大型编辑区：
- 命中：注入浮动面板和快捷键
- 未命中：静默退出，不干扰普通页面

使用 `@run-at document-idle`，因为需要等页面主体和编辑器节点出现后再做检测型注入。

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

按 Markdown 图片语法 `![alt](url)` 切分正文。用户应先在平台按正文图片顺序手动上传图片，再用脚本逐段插入图片之间的文字 gap。

### 3.2 Markdown 清洗

清洗目标是稳定插入，而不是完整 Markdown 渲染。

当前处理：
- 去标题标记 `#`
- 去无序/有序列表前缀
- 去引用前缀 `>` / `&gt;`
- 去加粗、斜体、行内代码标记
- Markdown 链接在 HTML 模式转换为 `<a>`，纯文本模式保留链接文字
- HTML 模式先转义 `< > &`，再做 Markdown 标记替换，最后把段内换行转为 `<br>`

注意：HTML 转义顺序不能调换。必须先转义用户正文里的 HTML 特殊字符，再做 Markdown 清洗，否则正文里的尖括号可能被浏览器当成标签。

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

点击脚本面板按钮后，浏览器焦点可能转移到面板。脚本用 `lastFocusedElement` 记录最后聚焦过的编辑器元素，在执行插入时找回目标。

插入后会：
- 模拟 `ArrowDown` / `ArrowRight`
- 对 contenteditable 使用 Selection API 把光标推进到下一段或空段落

这用于减少连续插入时光标卡在刚插入文本内部的概率。

### 3.5 快捷键

| 快捷键 | 功能 |
|---|---|
| `Alt+K` | 插入当前段并推进 |
| `Alt+J` | 回退到上一段 |

焦点在脚本面板输入框时，快捷键不触发插入或回退。

### 3.6 持久化

使用 `localStorage` 保存：
- `rawText`
- `gaps`
- `currentIndex`
- `skippedCount`
- `collapsed`

刷新页面后可以恢复输入内容、解析结果、当前进度和面板折叠状态。

### 3.7 UI 与交互

面板固定在右上角，可拖拽、可折叠。折叠后显示为圆形浮标，展开后恢复完整队列面板。面板使用最高层级 `z-index: 2147483647`。

所有 CSS 选择器都使用 `#ceb-*` 前缀，避免污染宿主页面。

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

### 4.2 iframe 焦点与快捷键捕获

同源 iframe 内的编辑器需要额外处理两件事：
- 插入时从 iframe 的 `contentDocument.activeElement` 获取真实目标
- 快捷键监听同时绑定主文档和同源 iframe 文档

快捷键监听使用 capture 阶段，并在命中脚本快捷键后调用 `stopImmediatePropagation()`，避免宿主页面优先吞掉 `Alt+K` / `Alt+J`。

### 4.3 contenteditable 与 textarea 的差异

contenteditable 插入 HTML，以段落结构承载富文本结果；textarea/input 插入纯文本，并用换行包裹当前段。

textarea/input 路径允许在 `insertText` 未生效时直接修改 `value`，因为该路径的内容模型简单且可预测。contenteditable 路径不做同类 fallback，因为平台编辑器 DOM 不稳定，直接改 DOM 容易绕过编辑器内部状态。

### 4.4 为什么不自动处理图片

脚本不上传图片、不识别图片节点、不判断当前 gap 对应哪张图。图片顺序由用户人工保证。

这是为了避开各平台最不稳定的 DOM 和上传逻辑，也是本脚本能保持通用性的前提。

### 4.5 为什么不做多策略自动 fallback

如果 `insertHTML` 失败，同一次操作内不要自动尝试剪贴板、直接 DOM 改写或其他插入方式。多策略 fallback 很容易导致重复插入，难以恢复。

失败时应该让用户重新定位光标、检查目标编辑器或调整检测/插入策略，而不是在一次快捷键操作中叠加多种写入路径。

---

## 5. 维护指南

### 5.1 常见问题处理

| 问题 | 可能原因 | 解决方案 |
|---|---|---|
| 面板未显示 | `Detector.hasEditor()` 未命中 | 检查页面是否有已知编辑器指纹、同源 iframe、toolbar 或 editor 容器 |
| 面板误出现在普通页面 | 检测规则过宽 | 收紧对应启发式，优先排除搜索、聊天、翻译、评论类输入区 |
| `Alt+K` 无响应 | 快捷键被宿主页面或 iframe 吞掉 | 检查 capture 监听是否绑定到目标文档 |
| 插入位置错误 | 最后聚焦元素不是目标编辑器 | 重新点击目标位置，确认 `lastFocusedElement` 指向编辑器 |
| 插入后光标停在文本内部 | 平台编辑器 selection 行为特殊 | 调整 `simulateArrowDown()`，并在真站连续插入验证 |
| Markdown 清洗异常 | 行内正则覆盖不足或顺序错误 | 优先补充最小规则，保持 HTML 先转义 |

### 5.2 漏检与误注入处理

漏检处理优先级：
1. 补充明确的编辑器框架指纹
2. 补充更具体的 toolbar 或容器判断
3. 针对可复现平台加入窄条件

误注入处理优先级：
1. 排除搜索、聊天、评论、翻译等输入区
2. 提高尺寸或结构门槛
3. 避免退回单纯 `[contenteditable]` / `textarea` 检测

### 5.3 Markdown 清洗规则调整

清洗规则服务于稳定插入，不追求完整 Markdown 兼容。新增规则时重点检查：
- 是否破坏 HTML 转义顺序
- 是否会误删正文中的普通符号
- HTML 模式和纯文本模式是否需要不同处理
- 是否影响链接、列表、引用和行内代码的现有表现

### 5.4 真站验证清单

Node 测试不能覆盖真实编辑器行为。发布前重点验证：
- 目标平台编辑器中 `insertHTML` 是否稳定插入
- 连续插入 5 段是否乱序
- 插入后平台草稿保存是否保留文本
- 平台撤销栈是否能撤销最近一次插入
- 图片批量上传顺序与 Markdown 图片顺序是否一致
- iframe 编辑器中的快捷键是否能触发
- 折叠状态、输入内容和当前进度刷新后是否恢复

### 5.5 README 与 notes 同步规则

`README.md` 面向用户和发布页面，只保留安装入口、核心用途、使用流程、功能摘要和截图/链接。

`notes.md` 面向维护者和 Agent，记录架构、核心模型、关键实现、检测策略、测试策略和维护约束。

---

## 6. 发布与开发规范

### 6.1 Userscript 发布

Userscript 是主发布形态，README 保留 Greasy Fork 安装入口。

发布前检查：
- `@version` 字段
- README 安装链接
- notes 中涉及用户流程、快捷键、检测规则和限制的说明

### 6.2 Chrome Extension 生成

本项目先实现 userscript，不直接维护 Chrome Extension 代码。

`BASE_PATH_CODING/projects/browser-script-to-extension` 可以自动扫描带 `==UserScript==` 元数据的 `.js` 文件，生成 Manifest V3 插件：

```bash
python build.py /path/to/closed-editor-bridge
```

发布 Chrome Extension 前需要补齐：
- `store_assets/icon.png`
- 1 到 5 张截图
- 需要时添加 `store_assets/upload_config.json`

### 6.3 发布产物归属

`store_assets/`、`extension/` 和 zip 包属于发布产物，不作为 userscript 主流程的一部分。

生成的 `extension/` 和 zip 包与三个兄弟项目保持同样工作流。

### 6.4 代码风格

- 使用模块化对象组织功能
- 配置集中放在 `CONFIG`
- DOM/CSS 命名统一使用 `ceb` 前缀
- 只在复杂浏览器行为处保留必要注释
- 改动行为、快捷键、检测规则或清洗规则时同步更新本文档

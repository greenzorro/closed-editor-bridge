# closed-editor-bridge

## 定位

`closed-editor-bridge` 是一个通用的 Markdown 分段粘贴工具。它不上传或识别图片；用户按文章顺序手动上传图片，脚本以 Markdown 图片标记为分隔，把文字逐段插入图片间隙。

Userscript 是行为的唯一来源；`extension/` 与 `closed-editor-bridge.zip` 是由它生成的 Chrome 扩展产物。

## 使用模型

```text
Markdown 正文
  -> 按图片标记切分
  -> gap 队列
  -> 用户定位光标
  -> 插入当前 gap
  -> 推进队列
```

图片标记 `![alt](url)` 不会写入目标编辑器。反引号或波浪线围成的 fenced code block 内的同形内容不会参与切分。空白 gap 会统计并在队列移动时跳过。

用户操作：

1. 在目标编辑器中按文章顺序上传图片；
2. 将 Markdown 正文粘贴到面板；
3. 在某个图片间隙中定位光标；
4. 按 `Alt+K`（macOS 为 `Option+K`）插入当前段；
5. 如需调整脚本内部队列，按 `Alt+J` 回退一段。

“上一步”只移动脚本队列，不会撤销页面内容；页面内容撤销由宿主编辑器处理。

## 运行与检测

- `@match *://*/*`：脚本不绑定具体平台域名。
- `@run-at document-idle`：先立即检测编辑器；未命中时以 1 秒轮询和 DOM 观察继续等待，最长 60 秒。
- `@inject-into page`：注入页面 JS 上下文（扩展产物为 `content_scripts.world = MAIN`），以便访问编辑器实例（如 CodeMirror 的 `wrapper.CodeMirror`）。`@grant none`，不依赖 `chrome.*`。
- 已知编辑器（TinyMCE、CKEditor、Quill、wangEditor、UEditor、Summernote、Draft.js、Medium Editor、Editor.md、CodeMirror、Trix）和同源 iframe 编辑器都必须达到 80 × 80 px。
- 一般 `contenteditable` 还要求页面存在工具栏；原生 `textarea` 还要求足够高度、位于编辑器容器中、页面存在工具栏，并排除搜索、聊天、评论等输入框。

检测只负责决定是否显示面板；实际插入目标由最近一次聚焦的可编辑元素确定。

## 插入策略

| 目标 | 写入方式 | 成功判定 |
|---|---|---|
| `contenteditable` | `execCommand('insertHTML')` | 命令返回成功 |
| 普通 `textarea` / `input` | `insertText`，未生效时写入 `value` 并派发输入事件 | 值发生变化 |
| CodeMirror 5 内部 textarea | 编辑器实例 `replaceSelection()` | `getValue()` 发生变化 |

`contenteditable` 不做剪贴板、纯文本或 DOM 改写 fallback，避免一次操作重复插入。普通文本控件和 CodeMirror 使用纯文本；富文本编辑器使用段落 HTML。

插入后的光标推进只用于普通文本控件与 `contenteditable`。CodeMirror 自身维护选择区和光标，因此不再模拟方向键。

## Markdown 清洗与链接安全

清洗服务于稳定插入，并非完整 Markdown 渲染：

- 移除标题、列表、引用、粗体、斜体和行内代码标记；
- HTML 模式先转义正文中的 `&`、`<`、`>`，再处理 Markdown；
- 段内换行转为 `<br>`，空行分隔为段落；
- Markdown 链接在 HTML 模式中只允许 `http(s):`、`mailto:`、`/`、`#`、`./`、`../`，并带 `target="_blank" rel="noopener noreferrer"`；其他协议仅保留链接文字；
- 纯文本模式中的链接仅保留文字。

## 快捷键与 iframe

| 快捷键 | 功能 |
|---|---|
| `Alt+K` / `Option+K` | 插入当前段并推进 |
| `Alt+J` / `Option+J` | 回退到上一段 |

监听器以 capture 阶段绑定在主文档和同源 iframe 中；动态 iframe 与 iframe 的 `load` 事件都会重新绑定。命中快捷键后会阻止宿主页面继续处理。

macOS 的 Option 组合键可能改变 `event.key`，所以匹配时同时检查物理键位 `event.code`（`KeyK` 与 `KeyJ`）。焦点在脚本输入框时，不触发队列快捷键。

## 面板与持久化

- 默认显示在右上角。展开时拖动标题栏；收缩为圆形浮标后直接拖动浮标。
- 点击浮标展开；移动超过 4 px 才视为拖动。
- 展开与收缩始终保持面板右上角位置，避免尺寸变化导致跳位。
- 收缩状态使用私有类名 `ceb-collapsed`，不受宿主页面通用 `.collapsed` 样式影响。
- 按 `closedEditorBridge:{pathname}` 保存输入、解析结果、队列进度、折叠状态和位置；同一站点的不同路径互不覆盖。
- 旧的全局存储键只在当前路径尚无数据时读取，以保留已有用户进度；下一次保存会写入路径隔离的数据。
- 清空输入会清空队列，但保留面板位置和折叠状态；Reset 会清除全部脚本状态。

## 交付前验证

1. `node --check closed-editor-bridge.js`；
2. 重新生成扩展后确认 `extension/content.js` 与脚本逻辑一致，`manifest.json` 与 userscript 的版本一致；
3. 在 contenteditable、CodeMirror 5 和同源 iframe 编辑器中分别验证插入与队列推进；
4. 验证 `Alt` / macOS `Option` 快捷键、展开和收缩拖动、刷新后的状态恢复；
5. 确认含 fenced code、空 gap 和不安全链接的 Markdown 保持上述边界。

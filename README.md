# closed-editor-bridge

*Chrome extension builds of this script are produced with [browser-script-to-extension](https://github.com/greenzorro/browser-script-to-extension).*

Ask an agent to install it (see `# For Agent`). Then use it while pasting articles into closed rich-text editors.

**Paste Markdown articles into closed rich-text editors**

Some platforms require manual image uploads and do not accept Markdown cleanly. This script pastes text back around those images, section by section.

1. Upload images to the target editor in order;
2. Paste your Markdown article into the floating panel;
3. Click between two uploaded images;
4. Press `Alt+K` (`Option+K` on macOS) to insert the next text section;
5. Use `Alt+J` (`Option+J` on macOS) to step back in the queue.

Drag the panel by its title bar. When collapsed, drag the circular button; a click expands it. Position and collapsed state restore per page path.

**将 Markdown 文章粘贴进封闭富文本编辑器**

有些平台要手动传图，也不能干净接收 Markdown。本脚本按图片把文字切段再插回去。

1. 先在目标编辑器里按顺序上传图片；
2. 把 Markdown 贴到浮动面板；
3. 点击两张图之间；
4. `Alt+K`（macOS：`Option+K`）插入下一段；
5. `Alt+J`（`Option+J`）回退。

可拖标题栏；收成浮标后可拖浮标，单击展开。位置与收缩状态按页面路径恢复。

---

Created by [Victor42](https://victor42.work/) & [Agent Vik](https://github.com/agent-vik)

---

# For Agent

Install this helper, verify the floating panel on a target editor page, walk through one Markdown insert cycle, then hand authoring to the human.

`@match` is `*://*/*` (all sites). Prefer testing on the human’s actual closed editor host. Browser tool + page access required; many editors also need a logged-in session.

## Prerequisites

- Chromium-based browser + Tampermonkey or unpacked extension from this repo
- A rich-text editor page where images are uploaded manually

## Steps

1. Install `closed-editor-bridge.js` or https://greasyfork.org/en/scripts/586326-closed-editor-bridge, **or** load `closed-editor-bridge.zip` / `extension/`.
2. **One handoff:** install approval; open/login to the destination editor if needed.
3. On the editor page, confirm the floating panel (or collapsed orb) appears.
4. Primary path once: human/you upload images in order → paste Markdown into the panel → click between images → `Alt+K` (`Option+K` on macOS) inserts the next text chunk; `Alt+J` steps back if needed.
5. Verify text landed in the editor between images. Then stop—article finishing is human work.

## Hand off to the human

- Choosing the CMS/editor and final copy edits
- Any site-specific login

## Red lines

- Do not exfiltrate page content or credentials
- Do not treat “works on one CMS” as license to change global `@match` behavior without being asked
- Behavior/edge cases: `notes.md`
- No republish unless asked

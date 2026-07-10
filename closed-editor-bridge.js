/*
 * File: closed-editor-bridge.js
 * Project: browser-scripts
 * Created: 2026-07-09
 * Author: Victor Cheng
 * Email: hi@victor42.work
 * Description: Bridge Markdown content into closed rich-text editors by inserting text segment-by-segment at the cursor
 */

// ==UserScript==
// @name         closed-editor-bridge
// @namespace    http://tampermonkey.net/
// @version      1.0.1
// @description  Paste Markdown into closed rich-text editors segment by segment, following manually uploaded images
// @author       Victor Cheng
// @match        *://*/*
// @grant        none
// @license      MIT
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

    //=======================================
    // 配置
    //=======================================
    const CONFIG = {
        STORAGE_KEY: 'closedEditorBridge',
        SHORTCUTS: {
            INSERT: { key: 'k', alt: true },   // Alt+K 插入当前段并推进
            PREV: { key: 'j', alt: true }      // Alt+J 回退到上一段
        },
        PREVIEW_CHARS: 200
    };

    //=======================================
    // 状态
    //=======================================
    let state = {
        rawText: '',          // 用户粘贴的原文
        gaps: [],             // 解析后的 gap 列表 [{ text, skipped }]
        currentIndex: 0,      // 当前 gap 指针
        skippedCount: 0,      // 被跳过的空 gap 数
        collapsed: false,     // 面板折叠状态
        lastResult: ''        // 最近一次插入结果提示
    };

    // 记录最后一次聚焦的输入框，用于在点击面板按钮后找回焦点
    let lastFocusedElement = null;

    function log(message, ...args) {
        console.log(`[closed-editor-bridge] ${message}`, ...args);
    }

    // 监听全局聚焦事件，捕获编辑器输入框
    document.addEventListener('focusin', (e) => {
        const el = e.target;
        if (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
            if (el.id !== 'ceb-input') { // 忽略我们自己的面板输入框
                lastFocusedElement = el;
            }
        }
    });

    //=======================================
    // Markdown 解析与清洗
    //=======================================
    const Parser = {
        /**
         * 解析 Markdown 全文，生成 gap 列表
         */
        parse(rawText) {
            const body = rawText.trim();
            const chunks = this.splitByImages(body);
            const gaps = [];
            let skippedCount = 0;

            chunks.forEach((chunk) => {
                const isBlank = !chunk.trim();
                gaps.push({
                    text: chunk,
                    skipped: isBlank
                });
                if (isBlank) skippedCount++;
            });

            return { gaps, skippedCount };
        },

        /**
         * 以 Markdown 图片语法 ![alt](url) 为切割点，把正文切成 N+1 个 gap
         */
        splitByImages(body) {
            const imageRegex = /!\[[^\]]*\]\([^)]+\)/g;
            const chunks = [];
            let lastIndex = 0;
            let match;

            while ((match = imageRegex.exec(body)) !== null) {
                chunks.push(body.slice(lastIndex, match.index));
                lastIndex = match.index + match[0].length;
            }
            chunks.push(body.slice(lastIndex));

            return chunks;
        },

        /**
         * 转换为富文本 HTML（用于 contenteditable）
         */
        toHtml(gapText) {
            const lines = gapText.split('\n');
            const paragraphs = [];
            let current = [];

            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed === '') {
                    if (current.length) {
                        paragraphs.push(current.join('\n'));
                        current = [];
                    }
                } else {
                    current.push(trimmed);
                }
            }
            if (current.length) paragraphs.push(current.join('\n'));

            return paragraphs
                .map(text => `<p>${this.inlineClean(text, true)}</p>`)
                .join('');
        },

        /**
         * 转换为纯文本（用于 textarea/input）
         */
        toPlainText(gapText) {
            const lines = gapText.split('\n');
            const paragraphs = [];
            let current = [];

            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed === '') {
                    if (current.length) {
                        paragraphs.push(current.join('\n'));
                        current = [];
                    }
                } else {
                    current.push(trimmed);
                }
            }
            if (current.length) paragraphs.push(current.join('\n'));

            return paragraphs
                .map(text => this.inlineClean(text, false))
                .join('\n\n');
        },

        /**
         * 行内 Markdown 标记清洗
         */
        inlineClean(text, toHtml = true) {
            if (toHtml) {
                // HTML 转义
                text = text
                    .replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;');
            }
            
            // 剥离 Markdown 语法标记
            text = text.replace(/^#{1,6}\s*/gm, ''); // 标题
            text = text.replace(/^\s*[-*+]\s+/gm, ''); // 无序列表
            text = text.replace(/^\s*\d+\.\s+/gm, ''); // 有序列表
            text = text.replace(/^\s*(?:&gt;|>)\s*/gm, ''); // 引用
            text = text.replace(/\*\*([^*]+)\*\*/g, '$1'); // 加粗
            text = text.replace(/\*([^*]+)\*/g, '$1'); // 斜体
            text = text.replace(/__([^_]+)__/g, '$1');
            text = text.replace(/_([^_]+)_/g, '$1');
            text = text.replace(/`([^`]+)`/g, '$1'); // 行内代码

            if (toHtml) {
                // 将 Markdown 链接转换为带样式的 HTML 链接
                text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" style="color: #2563eb; text-decoration: underline;">$1</a>');
                text = text.replace(/\n/g, '<br>');
            } else {
                // 纯文本模式下剥离链接只保留文本
                text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
            }
            return text;
        }
    };

    //=======================================
    // 存储
    //=======================================
    const Storage = {
        load() {
            try {
                const data = localStorage.getItem(CONFIG.STORAGE_KEY);
                return data ? JSON.parse(data) : null;
            } catch (e) {
                log('读取存储失败:', e);
                return null;
            }
        },

        save() {
            try {
                localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify({
                    rawText: state.rawText,
                    gaps: state.gaps,
                    currentIndex: state.currentIndex,
                    skippedCount: state.skippedCount,
                    collapsed: state.collapsed
                }));
            } catch (e) {
                log('保存存储失败:', e);
            }
        },

        clear() {
            localStorage.removeItem(CONFIG.STORAGE_KEY);
        }
    };

    //=======================================
    // 插入器
    //=======================================
    const Inserter = {
        /**
         * 在当前光标位置插入当前 gap 的内容
         */
        insertCurrent() {
            const gap = state.gaps[state.currentIndex];
            if (!gap) {
                state.lastResult = 'No segment to insert';
                return false;
            }
            if (gap.skipped) {
                state.lastResult = 'Current segment is empty and skipped';
                return false;
            }

            // 优先获取当前活动元素，支持穿透 Iframe 获取其内部的活动焦点
            let target = document.activeElement;
            if (target && target.tagName === 'IFRAME') {
                try {
                    const doc = target.contentDocument || target.contentWindow.document;
                    if (doc && doc.activeElement) {
                        target = doc.activeElement;
                    }
                } catch (e) {
                    // 跨域安全限制
                }
            }

            if (!target || target.id === 'ceb-input' || (!target.isContentEditable && target.tagName !== 'INPUT' && target.tagName !== 'TEXTAREA')) {
                target = lastFocusedElement;
            }

            if (!target) {
                state.lastResult = 'Click inside the editor first';
                return false;
            }

            const doc = target.ownerDocument || document;
            const isTextControl = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';

            if (isTextControl) {
                // 对于 textarea/input 插入纯文本，包装为：回车 + 文本 + 回车
                const plainText = Parser.toPlainText(gap.text);
                if (!plainText) {
                    state.lastResult = 'Current segment is empty after cleanup';
                    return false;
                }
                const wrappedText = '\n' + plainText + '\n';

                target.focus();
                const oldVal = target.value;
                
                // 尝试使用 insertText 保持撤销栈
                let ok = doc.execCommand('insertText', false, wrappedText);
                
                // 如果 insertText 没有生效，直接修改值并派发事件
                if (!ok || target.value === oldVal) {
                    const start = target.selectionStart;
                    const end = target.selectionEnd;
                    const val = target.value;
                    target.value = val.slice(0, start) + wrappedText + val.slice(end);
                    target.selectionStart = target.selectionEnd = start + wrappedText.length;
                    target.dispatchEvent(new Event('input', { bubbles: true }));
                    target.dispatchEvent(new Event('change', { bubbles: true }));
                    ok = true;
                }

                if (ok) {
                    state.lastResult = `✓ Inserted segment ${state.currentIndex + 1}/${state.gaps.length}`;
                    log(`插入成功 gap ${state.currentIndex + 1}`);
                    
                    // 模拟下移方向键
                    setTimeout(() => {
                        this.simulateArrowDown(target);
                    }, 50);
                } else {
                    state.lastResult = `✗ Failed to insert segment ${state.currentIndex + 1}`;
                }
                return ok;

            } else {
                // 对于 contenteditable 插入 HTML，支持 Iframe 文档对象
                // 包装为：空段落(回车) + 文本段落 + 空段落(回车)
                const html = Parser.toHtml(gap.text);
                if (!html) {
                    state.lastResult = 'Current segment is empty after cleanup';
                    return false;
                }
                const wrappedHtml = '<p><br></p>' + html + '<p><br></p>';

                target.focus();
                const ok = doc.execCommand('insertHTML', false, wrappedHtml);
                if (ok) {
                    state.lastResult = `✓ Inserted segment ${state.currentIndex + 1}/${state.gaps.length}`;
                    log(`插入成功 gap ${state.currentIndex + 1}`);
                    
                    // 模拟下移方向键，光标会精确落在插入内容底部的那个空段落 <p><br></p> 中
                    setTimeout(() => {
                        this.simulateArrowDown(target);
                    }, 50);
                } else {
                    state.lastResult = `✗ Failed to insert segment ${state.currentIndex + 1}`;
                }
                return ok;
            }
        },

        /**
         * 模拟键盘向下方向键的动作以移动光标
         */
        simulateArrowDown(element) {
            const doc = element.ownerDocument || document;
            const win = doc.defaultView || window;

            // 1. 触发 KeyboardEvent 键入事件（下方向键 + 右方向键）
            const eventInitDown = { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, which: 40, bubbles: true, cancelable: true };
            element.dispatchEvent(new KeyboardEvent('keydown', eventInitDown));
            element.dispatchEvent(new KeyboardEvent('keyup', eventInitDown));

            const eventInitRight = { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, which: 39, bubbles: true, cancelable: true };
            element.dispatchEvent(new KeyboardEvent('keydown', eventInitRight));
            element.dispatchEvent(new KeyboardEvent('keyup', eventInitRight));

            // 2. 针对 contenteditable 元素，利用 Selection API 强行推进光标至下一段落或新空行，并向右跨过 <br> 边界
            if (element.isContentEditable) {
                try {
                    const selection = win.getSelection();
                    if (selection && selection.rangeCount > 0) {
                        const range = selection.getRangeAt(0);
                        let node = range.startContainer;
                        
                        // 向上查找到编辑器中的最外层块级段落标签 (P, DIV, LI 等)
                        while (node && node !== element && !['P', 'DIV', 'LI', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'].includes(node.tagName)) {
                            node = node.parentNode;
                        }
                        
                        if (node && node !== element) {
                            let next = node.nextElementSibling;
                            // 如果没有下一个邻近段落，则自动创建并追加一个新的空白段落（如 <p><br></p>）
                            if (!next) {
                                next = doc.createElement('p');
                                next.innerHTML = '<br>';
                                node.parentNode.insertBefore(next, node.nextSibling);
                            }
                            if (next) {
                                const newRange = doc.createRange();
                                newRange.selectNodeContents(next);
                                newRange.collapse(false); // 坍缩光标至段落尾部（即跳过内部 <br>），相当于按了一下右键
                                selection.removeAllRanges();
                                selection.addRange(newRange);
                            }
                        }
                    }
                } catch (err) {
                    log('模拟光标下移/右移失败:', err);
                }
            }
        }
    };

    //=======================================
    // UI 面板
    //=======================================
    const UI = {
        panel: null,
        elements: {},

        create() {
            const existing = document.getElementById('ceb-panel');
            if (existing) existing.remove();

            const panel = document.createElement('div');
            panel.id = 'ceb-panel';
            panel.innerHTML = `
                <div id="ceb-header">
                    <span id="ceb-title">Markdown Segment Paste Queue</span>
                    <button id="ceb-collapse" title="Collapse / expand">—</button>
                </div>
                <div id="ceb-body">
                    <textarea id="ceb-input" placeholder="Paste Markdown body here... (image markers will be used as split points)"></textarea>
                    <div id="ceb-actions">
                        <button id="ceb-prev">Previous (Alt+J)</button>
                        <button id="ceb-insert">Insert (Alt+K)</button>
                        <button id="ceb-next">Next</button>
                        <button id="ceb-reset">Reset</button>
                    </div>
                    <div id="ceb-status"></div>
                    <div id="ceb-preview"></div>
                    <div id="ceb-hint"></div>
                </div>
            `;
            document.body.appendChild(panel);

            this.panel = panel;
            this.elements = {
                header: panel.querySelector('#ceb-header'),
                body: panel.querySelector('#ceb-body'),
                collapse: panel.querySelector('#ceb-collapse'),
                input: panel.querySelector('#ceb-input'),
                insert: panel.querySelector('#ceb-insert'),
                prev: panel.querySelector('#ceb-prev'),
                next: panel.querySelector('#ceb-next'),
                reset: panel.querySelector('#ceb-reset'),
                status: panel.querySelector('#ceb-status'),
                preview: panel.querySelector('#ceb-preview'),
                hint: panel.querySelector('#ceb-hint')
            };

            this.injectStyles();
            this.bindEvents();
        },

        injectStyles() {
            const css = `
                #ceb-panel {
                    position: fixed;
                    top: 16px;
                    right: 16px;
                    width: 320px;
                    background: #fff;
                    border: 1px solid #d0d0d0;
                    border-radius: 8px;
                    box-shadow: 0 4px 16px rgba(0,0,0,0.15);
                    z-index: 2147483647;
                    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                    font-size: 13px;
                    color: #222;
                }
                #ceb-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 8px 12px;
                    background: #f5f5f5;
                    border-bottom: 1px solid #e0e0e0;
                    border-radius: 8px 8px 0 0;
                    cursor: move;
                }
                #ceb-title { font-weight: 600; font-size: 13px; }
                #ceb-collapse {
                    border: none; background: none; cursor: pointer;
                    font-size: 16px; color: #666; padding: 0 4px;
                }
                #ceb-body { padding: 10px 12px; }
                #ceb-panel.collapsed {
                    width: 40px !important;
                    height: 40px !important;
                    border-radius: 50% !important;
                    overflow: hidden !important;
                    background: #2563eb !important;
                    border: 1px solid #2563eb !important;
                    box-shadow: 0 4px 12px rgba(37, 99, 235, 0.4) !important;
                    cursor: pointer !important;
                    transition: transform 0.2s ease, background 0.2s ease !important;
                }
                #ceb-panel.collapsed:hover {
                    transform: scale(1.05) !important;
                    background: #1d4ed8 !important;
                    border-color: #1d4ed8 !important;
                }
                #ceb-panel.collapsed #ceb-header {
                    width: 100% !important;
                    height: 100% !important;
                    padding: 0 !important;
                    background: transparent !important;
                    border: none !important;
                    display: flex !important;
                    justify-content: center !important;
                    align-items: center !important;
                    cursor: pointer !important;
                }
                #ceb-panel.collapsed #ceb-title {
                    display: none !important;
                }
                #ceb-panel.collapsed #ceb-collapse {
                    width: 100% !important;
                    height: 100% !important;
                    color: #fff !important;
                    font-size: 18px !important;
                    display: flex !important;
                    justify-content: center !important;
                    align-items: center !important;
                    padding: 0 !important;
                    border: none !important;
                    background: transparent !important;
                }
                #ceb-panel.collapsed #ceb-body {
                    display: none !important;
                }
                #ceb-input {
                    width: 100%; height: 120px;
                    box-sizing: border-box;
                    border: 1px solid #ccc; border-radius: 4px;
                    padding: 6px; font-size: 12px;
                    resize: vertical; font-family: inherit;
                }
                #ceb-actions {
                    display: flex; flex-wrap: wrap; gap: 4px;
                    margin: 8px 0;
                }
                #ceb-panel #ceb-actions button {
                    padding: 4px 8px !important;
                    border: 1px solid #bbb !important;
                    background: #fafafa !important;
                    color: #222 !important;
                    border-radius: 4px !important;
                    cursor: pointer !important;
                    font-size: 12px !important;
                    font-family: inherit !important;
                }
                #ceb-panel #ceb-actions button:hover { background: #e8e8e8 !important; }
                #ceb-panel #ceb-actions button:disabled { opacity: 0.4 !important; cursor: not-allowed !important; background: #fafafa !important; color: #aaa !important; }
                #ceb-panel #ceb-insert { background: #2563eb !important; color: #fff !important; border-color: #2563eb !important; }
                #ceb-panel #ceb-insert:hover { background: #1d4ed8 !important; }
                #ceb-panel #ceb-insert:disabled { background: #cbd5e1 !important; color: #94a3b8 !important; border-color: #cbd5e1 !important; }
                #ceb-status {
                    padding: 6px 8px;
                    background: #f8f8f8;
                    border-radius: 4px;
                    font-size: 12px;
                    color: #444;
                    margin-bottom: 6px;
                }
                #ceb-preview {
                    max-height: 120px;
                    overflow-y: auto;
                    padding: 6px 8px;
                    background: #fafafa;
                    border: 1px solid #eee;
                    border-radius: 4px;
                    font-size: 12px;
                    color: #555;
                    white-space: pre-wrap;
                    margin-bottom: 6px;
                }
                #ceb-hint {
                    font-size: 11px;
                    color: #888;
                }
            `;
            const style = document.createElement('style');
            style.textContent = css;
            document.head.appendChild(style);
        },

        bindEvents() {
            this.elements.collapse.addEventListener('click', () => this.toggleCollapse());
            this.elements.insert.addEventListener('click', () => this.handleInsert());
            this.elements.prev.addEventListener('click', () => this.handlePrev());
            this.elements.next.addEventListener('click', () => this.handleNext());
            this.elements.reset.addEventListener('click', () => this.handleReset());
            
            // 实时自动解析输入框内容
            this.elements.input.addEventListener('input', () => {
                const raw = this.elements.input.value;
                if (!raw.trim()) {
                    state = {
                        rawText: '',
                        gaps: [],
                        currentIndex: 0,
                        skippedCount: 0,
                        collapsed: state.collapsed,
                        lastResult: 'Cleared'
                    };
                    Storage.clear();
                    this.render();
                    return;
                }
                state.rawText = raw;
                const { gaps, skippedCount } = Parser.parse(raw);
                state.gaps = gaps;
                state.skippedCount = skippedCount;
                state.currentIndex = this.findNextInsertableIndex(0, 1);
                state.lastResult = `Auto-parsed ${gaps.length} segments (${skippedCount} empty skipped)`;
                Storage.save();
                this.render();
            });

            this.enableDrag();
        },

        enableDrag() {
            const header = this.elements.header;
            const panel = this.panel;
            let isDragging = false;
            let startX, startY, startLeft, startTop;

            header.addEventListener('mousedown', (e) => {
                if (e.target === this.elements.collapse) return;
                isDragging = true;
                startX = e.clientX;
                startY = e.clientY;
                const rect = panel.getBoundingClientRect();
                startLeft = rect.left;
                startTop = rect.top;
                e.preventDefault();
            });

            document.addEventListener('mousemove', (e) => {
                if (!isDragging) return;
                const newLeft = Math.max(0, startLeft + e.clientX - startX);
                const newTop = Math.max(0, startTop + e.clientY - startY);
                panel.style.left = newLeft + 'px';
                panel.style.top = newTop + 'px';
                panel.style.right = 'auto';
            });

            document.addEventListener('mouseup', () => { isDragging = false; });
        },

        toggleCollapse() {
            state.collapsed = !state.collapsed;
            this.panel.classList.toggle('collapsed', state.collapsed);
            this.elements.collapse.textContent = state.collapsed ? '📝' : '—';
            this.elements.collapse.title = state.collapsed ? 'Expand panel' : 'Collapse panel';
            Storage.save();
        },

        handleInsert() {
            if (document.activeElement === this.elements.input) return;
            const ok = Inserter.insertCurrent();
            if (ok) this.advance();
            Storage.save();
            this.render();
        },

        handlePrev() {
            const prevIndex = this.findNextInsertableIndex(state.currentIndex - 1, -1);
            if (prevIndex !== -1) {
                state.currentIndex = prevIndex;
                state.lastResult = `Back to segment ${state.currentIndex + 1}`;
            }
            Storage.save();
            this.render();
        },

        handleNext() {
            this.advance();
            Storage.save();
            this.render();
        },

        handleReset() {
            state = {
                rawText: '',
                gaps: [],
                currentIndex: 0,
                skippedCount: 0,
                collapsed: false,
                lastResult: 'Reset'
            };
            this.elements.input.value = '';
            this.panel.classList.remove('collapsed');
            Storage.clear();
            this.render();
        },

        advance() {
            const nextIndex = this.findNextInsertableIndex(state.currentIndex + 1, 1);
            if (nextIndex !== -1) {
                state.currentIndex = nextIndex;
                state.lastResult = `Moved to segment ${state.currentIndex + 1}/${state.gaps.length}`;
            } else {
                state.lastResult = 'Already at the last segment';
            }
        },

        findNextInsertableIndex(start, direction) {
            if (!state.gaps.length) return 0;

            for (let i = start; i >= 0 && i < state.gaps.length; i += direction) {
                if (!state.gaps[i].skipped) return i;
            }
            return -1;
        },

        render() {
            const total = state.gaps.length;
            const current = total ? state.currentIndex + 1 : 0;
            this.elements.status.innerHTML = `
                <div>Progress: <b>${current}/${total}</b> | Empty skipped: ${state.skippedCount}</div>
                <div>${state.lastResult || 'Paste content to auto-parse'}</div>
            `;

            const gap = state.gaps[state.currentIndex];
            if (gap) {
                const text = gap.skipped ? '(Empty segment, will be skipped)' : gap.text.trim();
                const preview = text.slice(0, CONFIG.PREVIEW_CHARS);
                this.elements.preview.textContent = `Gap ${state.currentIndex + 1}:\n${preview}${text.length > CONFIG.PREVIEW_CHARS ? '...' : ''}`;
            } else {
                this.elements.preview.textContent = '(No content)';
            }

            this.elements.hint.textContent = 'Click inside the editor, press Alt+K to insert, Alt+J to go back';

            this.elements.prev.disabled = this.findNextInsertableIndex(state.currentIndex - 1, -1) === -1;
            this.elements.next.disabled = this.findNextInsertableIndex(state.currentIndex + 1, 1) === -1;
            this.elements.insert.disabled = !gap || gap.skipped;
        },

        restore() {
            const saved = Storage.load();
            if (saved && saved.gaps && saved.gaps.length) {
                Object.assign(state, saved);
                if (state.gaps[state.currentIndex] && state.gaps[state.currentIndex].skipped) {
                    const nextIndex = this.findNextInsertableIndex(state.currentIndex, 1);
                    state.currentIndex = nextIndex === -1 ? 0 : nextIndex;
                }
                state.lastResult = 'Restored previous progress';
                this.elements.input.value = state.rawText;
            }
            this.panel.classList.toggle('collapsed', !!state.collapsed);
            this.elements.collapse.textContent = state.collapsed ? '📝' : '—';
            this.elements.collapse.title = state.collapsed ? 'Expand panel' : 'Collapse panel';
            this.render();
        }
    };

    const Shortcuts = {
        init() {
            // 清理已存在的全局监听器以防止热重载产生多重触发
            if (window.ceb_keydown_listener) {
                document.removeEventListener('keydown', window.ceb_keydown_listener, true);
                document.querySelectorAll('iframe').forEach(iframe => {
                    try {
                        const doc = iframe.contentDocument || iframe.contentWindow.document;
                        if (doc) {
                            doc.removeEventListener('keydown', window.ceb_keydown_listener, true);
                        }
                    } catch (e) {}
                });
            }

            window.ceb_keydown_listener = (e) => this.handle(e);
            document.addEventListener('keydown', window.ceb_keydown_listener, true);

            const bindIframe = (iframe) => {
                try {
                    const doc = iframe.contentDocument || iframe.contentWindow.document;
                    if (doc) {
                        doc.removeEventListener('keydown', window.ceb_keydown_listener, true);
                        doc.addEventListener('keydown', window.ceb_keydown_listener, true);
                    }
                } catch (e) {
                    // 忽略跨域 iframe 权限限制
                }
            };

            // 绑定现有 iframe
            document.querySelectorAll('iframe').forEach(bindIframe);

            // 监听动态添加的 iframe
            const observer = new MutationObserver((mutations) => {
                mutations.forEach((mutation) => {
                    mutation.addedNodes.forEach((node) => {
                        if (node.tagName === 'IFRAME') {
                            bindIframe(node);
                        } else if (node.querySelectorAll) {
                            node.querySelectorAll('iframe').forEach(bindIframe);
                        }
                    });
                });
            });
            observer.observe(document.body, { childList: true, subtree: true });

            // 绑定 focusin 以捕获最后聚焦的元素
            const handleFocusIn = (e) => {
                const el = e.target;
                if (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
                    if (el.id !== 'ceb-input') {
                        lastFocusedElement = el;
                    }
                }
            };
            
            document.querySelectorAll('iframe').forEach(iframe => {
                try {
                    const doc = iframe.contentDocument || iframe.contentWindow.document;
                    if (doc) doc.addEventListener('focusin', handleFocusIn);
                } catch(e){}
            });
        },

        handle(e) {
            const sc = CONFIG.SHORTCUTS;
            if (e.altKey === sc.INSERT.alt && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === sc.INSERT.key) {
                if (document.activeElement && document.activeElement.id === 'ceb-input') return;
                e.preventDefault();
                e.stopImmediatePropagation();
                UI.handleInsert();
                return;
            }
            if (e.altKey === sc.PREV.alt && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === sc.PREV.key) {
                if (document.activeElement && document.activeElement.id === 'ceb-input') return;
                e.preventDefault();
                e.stopImmediatePropagation();
                UI.handlePrev();
                return;
            }
        }
    };

    //=======================================
    // 编辑器检测
    //=======================================
    // 通用脚本注入全站，靠编辑器指纹和尺寸启发式判断是否启用
    // 未命中富文本编辑器或大型编辑区的页面直接静默退出，零打扰
    const Detector = {
        /**
         * 判断当前页面是否含有真正的富文本编辑器或大型编辑区
         */
        hasEditor() {
            // 1. 知名编辑器类名指纹匹配 (高置信度)
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
                const hasToolbar = document.querySelector('[class*="toolbar"]') || 
                                  document.querySelector('[id*="toolbar"]') || 
                                  document.querySelector('[role="toolbar"]');
                if (hasToolbar) {
                    return true;
                }
            }

            // 4. Textarea 启发式规则 (排除了大部分独立的 plain textarea，除非在编辑器容器内且高度足够并伴随工具栏)
            const textareas = document.querySelectorAll('textarea');
            for (const ta of textareas) {
                if (ta.id === 'ceb-input') continue;
                const rect = ta.getBoundingClientRect();
                const height = rect.height || ta.clientHeight;
                if (height >= 120 || ta.rows >= 8) {
                    // 检查是否在编辑器容器中，且伴随工具栏
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

    //=======================================
    // 初始化
    //=======================================
    function init() {
        // 通用 @match：无编辑器目标的页面静默退出，不注入 UI
        if (!Detector.hasEditor()) {
            return;
        }

        const start = () => {
            UI.create();
            UI.restore();
            Shortcuts.init();
        };

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', start);
        } else {
            start();
        }
        log('已加载（检测到编辑器）');
    }

    init();

})();

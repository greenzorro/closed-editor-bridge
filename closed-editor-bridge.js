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
// @version      1.0.2
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
        PREVIEW_CHARS: 200,
        DETECT_POLL_MS: 1000,
        DETECT_POLL_MAX_MS: 60000,
        CURSOR_ADVANCE_MS: 50,
        STYLE_ID: 'ceb-styles'
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
    let cursorAdvanceTimer = null;
    let bootstrapped = false;

    function log(message, ...args) {
        console.log(`[closed-editor-bridge] ${message}`, ...args);
    }

    function storageKey() {
        return `${CONFIG.STORAGE_KEY}:${location.pathname || '/'}`;
    }

    function isEditableTarget(el) {
        if (!el || el.nodeType !== 1) return false;
        if (el.id === 'ceb-input') return false;
        return !!(el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
    }

    function rememberFocusedElement(el) {
        if (isEditableTarget(el)) {
            lastFocusedElement = el;
        }
    }

    function handleFocusIn(e) {
        rememberFocusedElement(e.target);
    }

    // 主文档聚焦监听（iframe 内在 Shortcuts 中绑定）
    document.addEventListener('focusin', handleFocusIn);

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
         * 收集 fenced code block 区间，避免代码块内的图片语法被误切
         */
        getFencedCodeRanges(body) {
            const ranges = [];
            const fenceRe = /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[ \t]*$/gm;
            let match;
            while ((match = fenceRe.exec(body)) !== null) {
                ranges.push([match.index, match.index + match[0].length]);
            }
            return ranges;
        },

        isInsideRanges(index, ranges) {
            return ranges.some(([start, end]) => index >= start && index < end);
        },

        /**
         * 以 Markdown 图片语法 ![alt](url) 为切割点，把正文切成 N+1 个 gap
         * 跳过 fenced code block 内的匹配
         */
        splitByImages(body) {
            const imageRegex = /!\[[^\]]*\]\([^)]+\)/g;
            const codeRanges = this.getFencedCodeRanges(body);
            const chunks = [];
            let lastIndex = 0;
            let match;

            while ((match = imageRegex.exec(body)) !== null) {
                if (this.isInsideRanges(match.index, codeRanges)) {
                    continue;
                }
                chunks.push(body.slice(lastIndex, match.index));
                lastIndex = match.index + match[0].length;
            }
            chunks.push(body.slice(lastIndex));

            return chunks;
        },

        /**
         * 按空行切成段落
         */
        splitParagraphs(gapText) {
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
            return paragraphs;
        },

        /**
         * 转换为富文本 HTML（用于 contenteditable）
         */
        toHtml(gapText) {
            return this.splitParagraphs(gapText)
                .map(text => `<p>${this.inlineClean(text, true)}</p>`)
                .join('');
        },

        /**
         * 转换为纯文本（用于 textarea/input）
         */
        toPlainText(gapText) {
            return this.splitParagraphs(gapText)
                .map(text => this.inlineClean(text, false))
                .join('\n\n');
        },

        escapeAttr(value) {
            return String(value)
                .replace(/&/g, '&amp;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');
        },

        /**
         * 仅允许安全链接协议，拒绝 javascript: 等
         */
        sanitizeHref(url) {
            const trimmed = String(url || '').trim();
            if (!trimmed) return null;
            if (/^https?:\/\//i.test(trimmed)) return trimmed;
            if (/^mailto:/i.test(trimmed)) return trimmed;
            if (trimmed.startsWith('/') || trimmed.startsWith('#') ||
                trimmed.startsWith('./') || trimmed.startsWith('../')) {
                return trimmed;
            }
            return null;
        },

        /**
         * 行内 Markdown 标记清洗
         */
        inlineClean(text, toHtml = true) {
            if (toHtml) {
                text = text
                    .replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;');
            }

            text = text.replace(/^#{1,6}\s*/gm, '');
            text = text.replace(/^\s*[-*+]\s+/gm, '');
            text = text.replace(/^\s*\d+\.\s+/gm, '');
            text = text.replace(/^\s*(?:&gt;|>)\s*/gm, '');
            text = text.replace(/\*\*([^*]+)\*\*/g, '$1');
            text = text.replace(/\*([^*]+)\*/g, '$1');
            text = text.replace(/__([^_]+)__/g, '$1');
            text = text.replace(/_([^_]+)_/g, '$1');
            text = text.replace(/`([^`]+)`/g, '$1');

            if (toHtml) {
                text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => {
                    const safe = this.sanitizeHref(href);
                    if (!safe) return label;
                    return `<a href="${this.escapeAttr(safe)}" target="_blank" rel="noopener noreferrer" style="color: #2563eb; text-decoration: underline;">${label}</a>`;
                });
                text = text.replace(/\n/g, '<br>');
            } else {
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
                const data = localStorage.getItem(storageKey());
                if (data) return JSON.parse(data);

                // 兼容旧版全局 key
                const legacy = localStorage.getItem(CONFIG.STORAGE_KEY);
                return legacy ? JSON.parse(legacy) : null;
            } catch (e) {
                log('读取存储失败:', e);
                return null;
            }
        },

        save() {
            try {
                localStorage.setItem(storageKey(), JSON.stringify({
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
            try {
                localStorage.removeItem(storageKey());
                localStorage.removeItem(CONFIG.STORAGE_KEY);
            } catch (e) {
                log('清除存储失败:', e);
            }
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

            if (!isEditableTarget(target)) {
                target = lastFocusedElement;
            }

            if (!target) {
                state.lastResult = 'Click inside the editor first';
                return false;
            }

            const doc = target.ownerDocument || document;
            const isTextControl = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';

            if (isTextControl) {
                const plainText = Parser.toPlainText(gap.text);
                if (!plainText) {
                    state.lastResult = 'Current segment is empty after cleanup';
                    return false;
                }
                const wrappedText = '\n' + plainText + '\n';

                target.focus();
                const oldVal = target.value;
                let ok = false;
                try {
                    ok = doc.execCommand('insertText', false, wrappedText);
                } catch (e) {
                    ok = false;
                }

                if (!ok || target.value === oldVal) {
                    const start = target.selectionStart;
                    const end = target.selectionEnd;
                    const val = target.value;
                    target.value = val.slice(0, start) + wrappedText + val.slice(end);
                    target.selectionStart = target.selectionEnd = start + wrappedText.length;
                    target.dispatchEvent(new Event('input', { bubbles: true }));
                    target.dispatchEvent(new Event('change', { bubbles: true }));
                    ok = target.value !== oldVal;
                }

                if (ok) {
                    state.lastResult = `✓ Inserted segment ${state.currentIndex + 1}/${state.gaps.length}`;
                    log(`插入成功 gap ${state.currentIndex + 1}`);
                    this.scheduleCursorAdvance(target);
                } else {
                    state.lastResult = `✗ Failed to insert segment ${state.currentIndex + 1}`;
                }
                return ok;

            } else {
                const html = Parser.toHtml(gap.text);
                if (!html) {
                    state.lastResult = 'Current segment is empty after cleanup';
                    return false;
                }
                const wrappedHtml = '<p><br></p>' + html + '<p><br></p>';

                target.focus();
                let ok = false;
                try {
                    ok = doc.execCommand('insertHTML', false, wrappedHtml);
                } catch (e) {
                    ok = false;
                }

                if (ok) {
                    state.lastResult = `✓ Inserted segment ${state.currentIndex + 1}/${state.gaps.length}`;
                    log(`插入成功 gap ${state.currentIndex + 1}`);
                    this.scheduleCursorAdvance(target);
                } else {
                    state.lastResult = `✗ Failed to insert segment ${state.currentIndex + 1}`;
                }
                return ok;
            }
        },

        scheduleCursorAdvance(element) {
            if (cursorAdvanceTimer) {
                clearTimeout(cursorAdvanceTimer);
            }
            cursorAdvanceTimer = setTimeout(() => {
                cursorAdvanceTimer = null;
                this.simulateArrowDown(element);
            }, CONFIG.CURSOR_ADVANCE_MS);
        },

        /**
         * 模拟键盘向下方向键的动作以移动光标
         */
        simulateArrowDown(element) {
            const doc = element.ownerDocument || document;
            const win = doc.defaultView || window;

            const eventInitDown = { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, which: 40, bubbles: true, cancelable: true };
            element.dispatchEvent(new KeyboardEvent('keydown', eventInitDown));
            element.dispatchEvent(new KeyboardEvent('keyup', eventInitDown));

            const eventInitRight = { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, which: 39, bubbles: true, cancelable: true };
            element.dispatchEvent(new KeyboardEvent('keydown', eventInitRight));
            element.dispatchEvent(new KeyboardEvent('keyup', eventInitRight));

            if (element.isContentEditable) {
                try {
                    const selection = win.getSelection();
                    if (selection && selection.rangeCount > 0) {
                        const range = selection.getRangeAt(0);
                        let node = range.startContainer;

                        while (node && node !== element && !['P', 'DIV', 'LI', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'].includes(node.tagName)) {
                            node = node.parentNode;
                        }

                        if (node && node !== element) {
                            let next = node.nextElementSibling;
                            // 插入包装已带尾部空段；仅在缺失时补一个，避免绕过编辑器模型滥造节点
                            if (!next && node.parentNode && node.parentNode !== element && element.contains(node.parentNode)) {
                                next = node.nextElementSibling;
                            }
                            if (!next && node.parentNode) {
                                next = doc.createElement('p');
                                next.innerHTML = '<br>';
                                node.parentNode.insertBefore(next, node.nextSibling);
                            }
                            if (next) {
                                const newRange = doc.createRange();
                                newRange.selectNodeContents(next);
                                newRange.collapse(false);
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
                    <button type="button" id="ceb-collapse" title="Collapse / expand">—</button>
                </div>
                <div id="ceb-body">
                    <textarea id="ceb-input" placeholder="Paste Markdown body here... (image markers will be used as split points)"></textarea>
                    <div id="ceb-actions">
                        <button type="button" id="ceb-prev">Previous (Alt+J)</button>
                        <button type="button" id="ceb-insert">Insert (Alt+K)</button>
                        <button type="button" id="ceb-next">Next</button>
                        <button type="button" id="ceb-reset">Reset</button>
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
            if (document.getElementById(CONFIG.STYLE_ID)) return;

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
            style.id = CONFIG.STYLE_ID;
            style.textContent = css;
            document.head.appendChild(style);
        },

        bindEvents() {
            this.elements.collapse.addEventListener('click', () => this.toggleCollapse());
            this.elements.insert.addEventListener('click', () => this.handleInsert());
            this.elements.prev.addEventListener('click', () => this.handlePrev());
            this.elements.next.addEventListener('click', () => this.handleNext());
            this.elements.reset.addEventListener('click', () => this.handleReset());

            this.elements.input.addEventListener('input', () => {
                this.applyParsedInput(this.elements.input.value, { preserveIndex: true });
            });

            this.enableDrag();
        },

        /**
         * 解析输入；preserveIndex 时尽量保留当前队列进度
         */
        applyParsedInput(raw, { preserveIndex = false } = {}) {
            const prevIndex = state.currentIndex;
            const hadGaps = state.gaps.length > 0;

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

            if (preserveIndex && hadGaps) {
                state.currentIndex = this.resolvePreservedIndex(prevIndex);
                state.lastResult = `Auto-parsed ${gaps.length} segments (${skippedCount} empty skipped), kept progress`;
            } else {
                const first = this.findNextInsertableIndex(0, 1);
                state.currentIndex = first === -1 ? 0 : first;
                state.lastResult = `Auto-parsed ${gaps.length} segments (${skippedCount} empty skipped)`;
            }

            Storage.save();
            this.render();
        },

        /**
         * 重解析后尽量落在原进度附近的可插入段
         */
        resolvePreservedIndex(prevIndex) {
            if (!state.gaps.length) return 0;

            const clamped = Math.max(0, Math.min(prevIndex, state.gaps.length - 1));
            if (!state.gaps[clamped].skipped) return clamped;

            const forward = this.findNextInsertableIndex(clamped, 1);
            if (forward !== -1) return forward;

            const backward = this.findNextInsertableIndex(clamped, -1);
            if (backward !== -1) return backward;

            return 0;
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
            if (!state.gaps.length) return -1;

            for (let i = start; i >= 0 && i < state.gaps.length; i += direction) {
                if (!state.gaps[i].skipped) return i;
            }
            return -1;
        },

        render() {
            const total = state.gaps.length;
            const current = total && state.currentIndex >= 0 ? state.currentIndex + 1 : 0;
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
        iframeObserver: null,

        init() {
            if (window.ceb_keydown_listener) {
                document.removeEventListener('keydown', window.ceb_keydown_listener, true);
                document.querySelectorAll('iframe').forEach(iframe => {
                    this.unbindIframe(iframe);
                });
            }

            window.ceb_keydown_listener = (e) => this.handle(e);
            document.addEventListener('keydown', window.ceb_keydown_listener, true);

            document.querySelectorAll('iframe').forEach(iframe => this.bindIframe(iframe));

            if (this.iframeObserver) {
                this.iframeObserver.disconnect();
            }
            this.iframeObserver = new MutationObserver((mutations) => {
                mutations.forEach((mutation) => {
                    mutation.addedNodes.forEach((node) => {
                        if (node.nodeType !== 1) return;
                        if (node.tagName === 'IFRAME') {
                            this.bindIframe(node);
                        } else if (node.querySelectorAll) {
                            node.querySelectorAll('iframe').forEach(iframe => this.bindIframe(iframe));
                        }
                    });
                });
            });
            this.iframeObserver.observe(document.documentElement || document.body, {
                childList: true,
                subtree: true
            });
        },

        unbindIframe(iframe) {
            try {
                const doc = iframe.contentDocument || iframe.contentWindow.document;
                if (!doc) return;
                if (window.ceb_keydown_listener) {
                    doc.removeEventListener('keydown', window.ceb_keydown_listener, true);
                }
                doc.removeEventListener('focusin', handleFocusIn);
            } catch (e) {
                // 跨域
            }
        },

        bindIframe(iframe) {
            if (!iframe) return;

            const attach = () => {
                try {
                    const doc = iframe.contentDocument || iframe.contentWindow.document;
                    if (!doc) return;

                    if (window.ceb_keydown_listener) {
                        doc.removeEventListener('keydown', window.ceb_keydown_listener, true);
                        doc.addEventListener('keydown', window.ceb_keydown_listener, true);
                    }
                    doc.removeEventListener('focusin', handleFocusIn);
                    doc.addEventListener('focusin', handleFocusIn);
                } catch (e) {
                    // 忽略跨域 iframe 权限限制
                }
            };

            attach();
            if (iframe.dataset.cebLoadBound !== '1') {
                iframe.dataset.cebLoadBound = '1';
                iframe.addEventListener('load', attach);
            }
        },

        handle(e) {
            const sc = CONFIG.SHORTCUTS;
            const key = (e.key || '').toLowerCase();
            if (e.altKey === sc.INSERT.alt && !e.ctrlKey && !e.metaKey && key === sc.INSERT.key) {
                if (document.activeElement && document.activeElement.id === 'ceb-input') return;
                e.preventDefault();
                e.stopImmediatePropagation();
                UI.handleInsert();
                return;
            }
            if (e.altKey === sc.PREV.alt && !e.ctrlKey && !e.metaKey && key === sc.PREV.key) {
                if (document.activeElement && document.activeElement.id === 'ceb-input') return;
                e.preventDefault();
                e.stopImmediatePropagation();
                UI.handlePrev();
            }
        }
    };

    //=======================================
    // 编辑器检测
    //=======================================
    const Detector = {
        hasEditor() {
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

            const editables = document.querySelectorAll('[contenteditable=""], [contenteditable="true"]');
            for (const el of editables) {
                if (el.id === 'ceb-input') continue;
                const rect = el.getBoundingClientRect();
                const height = rect.height || el.clientHeight;
                const width = rect.width || el.clientWidth;

                if (width < 80 || height < 80) continue;

                const hasToolbar = document.querySelector('[class*="toolbar"]') ||
                                  document.querySelector('[id*="toolbar"]') ||
                                  document.querySelector('[role="toolbar"]');
                if (hasToolbar) {
                    return true;
                }
            }

            const textareas = document.querySelectorAll('textarea');
            for (const ta of textareas) {
                if (ta.id === 'ceb-input') continue;
                const rect = ta.getBoundingClientRect();
                const height = rect.height || ta.clientHeight;
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

    //=======================================
    // 初始化（支持 SPA 延迟出现编辑器）
    //=======================================
    function bootstrap() {
        if (bootstrapped) return false;
        if (!Detector.hasEditor()) return false;

        bootstrapped = true;
        UI.create();
        UI.restore();
        Shortcuts.init();
        log('已加载（检测到编辑器）');
        return true;
    }

    function init() {
        const startWatching = () => {
            if (bootstrap()) return;

            const startedAt = Date.now();
            const pollId = setInterval(() => {
                if (bootstrap() || Date.now() - startedAt >= CONFIG.DETECT_POLL_MAX_MS) {
                    clearInterval(pollId);
                }
            }, CONFIG.DETECT_POLL_MS);

            const observer = new MutationObserver(() => {
                if (bootstrap()) {
                    observer.disconnect();
                    clearInterval(pollId);
                }
            });

            const root = document.documentElement || document.body;
            if (root) {
                observer.observe(root, { childList: true, subtree: true });
            }

            setTimeout(() => {
                observer.disconnect();
            }, CONFIG.DETECT_POLL_MAX_MS);
        };

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', startWatching);
        } else {
            startWatching();
        }
    }

    init();

})();

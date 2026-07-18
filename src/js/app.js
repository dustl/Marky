/* ==============================
   Marky — WYSIWYG Markdown Editor
   ============================== */

(function () {
  'use strict';

  // Override console.log to also write to a debug log file via main process
  var _origLog = console.log.bind(console);
  console.log = function (msg) {
    _origLog(msg);
    try {
      if (window.electronAPI && window.electronAPI.debugLog) {
        window.electronAPI.debugLog(String(msg));
      }
    } catch (_) {}
  };
  console.log('MARKY: app.js loaded, console.log override active');

  // ===== State =====
  var state = {
    currentFile: null,
    isDark: false,
    fileName: 'untitled.md',
    showOutline: true,
    focusMode: false,
    currentFolder: null,
    folderFiles: [],
  };

  // ===== DOM =====
  var editor = document.getElementById('editor');
  var statusWords = document.getElementById('statusWords');
  var statusLines = document.getElementById('statusLines');
  var statusChars = document.getElementById('statusChars');
  var statusReadTime = document.getElementById('statusReadTime');
  var statusFile = document.getElementById('statusFile');
  var statusTheme = document.getElementById('statusTheme');
  var fileNameEl = document.getElementById('fileName');
  var outlineBody = document.getElementById('outlineBody');
  var sidebar = document.getElementById('sidebar');
  var contextMenu = document.getElementById('contextMenu');
  var focusExit = document.getElementById('focusExit');
  var shortcutModal = document.getElementById('shortcutModal');
  var shortcutClose = document.getElementById('shortcutClose');
  var shortcutBackdrop = document.getElementById('shortcutBackdrop');
  var wordcountPopup = document.getElementById('wordcountPopup');
  var popupWords = document.getElementById('popupWords');
  var popupChars = document.getElementById('popupChars');
  var popupCharsNoSpace = document.getElementById('popupCharsNoSpace');
  var popupLines = document.getElementById('popupLines');
  var popupParas = document.getElementById('popupParas');
  var popupReadTime = document.getElementById('popupReadTime');
  var floatToolbar = document.getElementById('floatToolbar');
  var tableGridPicker = document.getElementById('tableGridPicker');
  var tableGrid = document.getElementById('tableGrid');
  var gridLabel = document.getElementById('gridLabel');
  var templateBtn = document.getElementById('templateBtn');
  var templateDropdown = document.getElementById('templateDropdown');
  var toolbarTableBtn = document.getElementById('toolbarTableBtn');

  var _autoSaveTimer = null;
  var _renderTimer = null;
  var _markdown = '';
  var _isRendering = false;
  var _isComposing = false;
  var _skipNextInput = false;

  // ===== History =====
  var _history = [];
  var _historyIdx = -1;
  var _historyGrouping = false;
  var _historyTimer = null;
  var _historyMax = 200;

  // ===== Marked Setup =====
  function setupMarked() {
    if (typeof window.marked === 'undefined') return;
    var renderer = new window.marked.Renderer();
    renderer.code = function (args) {
      var text = args.text;
      if (text === undefined || text === null) text = args; // fallback for older marked
      var lang = args.lang || '';
      var highlighted;
      if (typeof window.hljs !== 'undefined') {
        try {
          if (lang && window.hljs.getLanguage(lang)) {
            highlighted = window.hljs.highlight(text, { language: lang }).value;
          } else {
            highlighted = window.hljs.highlightAuto(text).value;
          }
        } catch (_) {
          highlighted = escapeHtml(text);
        }
      } else {
        highlighted = escapeHtml(text);
      }
      var langAttr = lang ? ' class="language-' + lang + '"' : '';
      var copyBtn = '<button class="code-copy-btn" data-code="' + escapeAttr(text) + '" title="Copy code">'
        + '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">'
        + '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>';
      var langLabel = lang ? '<span class="code-lang-label">' + lang + '</span>' : '';
      return '<div class="code-block-wrap">'
        + '<div class="code-block-header">' + langLabel + copyBtn + '</div>'
        + '<pre><code' + langAttr + '>' + highlighted + '</code></pre></div>';
    };
    window.marked.use({ renderer: renderer });
  }

  function ensureMarked() {
    if (typeof window.marked === 'undefined') return;
    // Only setup once
    if (!window._markyMarkedReady) {
      setupMarked();
      window._markyMarkedReady = true;
    }
  }

  // ===== Robust Cursor Preservation =====
  // Saves cursor by absolute character offset across the editor's text content,
  // which survives block-structure changes (e.g. <p> → <ul><li>).

  function findBlockElement(node) {
    while (node && node !== editor) {
      if (/^(P|H[1-6]|LI|TD|TH|BLOCKQUOTE|PRE)$/.test(node.tagName)) return node;
      node = node.parentNode;
    }
    return null;
  }

  function saveCursor() {
    var sel = window.getSelection();
    if (!sel.rangeCount) return null;
    var range = sel.getRangeAt(0);
    if (!editor.contains(range.startContainer)) return null;

    // Calculate absolute character offset across all text in the editor
    var walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    var absOffset = 0;
    while (walker.nextNode()) {
      if (walker.currentNode === range.startContainer) {
        absOffset += range.startOffset;
        break;
      }
      absOffset += walker.currentNode.textContent.length;
    }
    return { absOffset: absOffset };
  }

  function restoreCursor(ctx) {
    if (!ctx) return;
    // Walk all text nodes in order and place cursor at the saved offset
    var walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    var offset = 0;
    while (walker.nextNode()) {
      var node = walker.currentNode;
      var len = node.textContent.length;
      if (offset + len >= ctx.absOffset) {
        try {
          var range = document.createRange();
          range.setStart(node, Math.min(ctx.absOffset - offset, len));
          range.collapse(true);
          var sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        } catch (e) {
          placeCursorAtEnd(editor);
        }
        return;
      }
      offset += len;
    }
    // Past end → cursor at end
    placeCursorAtEnd(editor);
  }

  function placeCursorAtEnd(block) {
    // Try placing cursor in a text node first
    var walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    var lastText = null;
    while (walker.nextNode()) lastText = walker.currentNode;
    if (lastText) {
      try {
        var range = document.createRange();
        range.setStart(lastText, lastText.textContent.length);
        range.collapse(true);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        return;
      } catch (_) {}
    }
    // No text node — place cursor at start of block (before <br>)
    try {
      var range = document.createRange();
      range.setStart(block, 0);
      range.collapse(true);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (_) {}
  }

  // Place cursor at the end of a paragraph AFTER any code blocks, so the
  // cursor doesn't land inside <pre><code> where it can't escape.
  function placeCursorOutsideCodeBlock() {
    // Find the last <p> in the editor (code blocks contain no <p>)
    var ps = editor.querySelectorAll('p');
    if (ps.length > 0) {
      placeCursorAtEnd(ps[ps.length - 1]);
      return;
    }
    // Fallback: place at the very end — but avoid <pre> text nodes.
    // Append an empty paragraph so the cursor has somewhere to go.
    var p = document.createElement('p');
    p.innerHTML = '<br>';
    editor.appendChild(p);
    placeCursorAtEnd(p);
  }

  // Get character offset of cursor within a block element
  function getTextOffsetInBlock(block, container, nodeOffset) {
    var walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    var offset = 0;
    while (walker.nextNode()) {
      if (walker.currentNode === container) return offset + nodeOffset;
      offset += walker.currentNode.textContent.length;
    }
    return offset;
  }

  // ===== HTML → Markdown Conversion =====
  function htmlToMarkdown(root) {
    var md = '';
    var nodes = root.childNodes;
    for (var i = 0; i < nodes.length; i++) {
      md += nodeToMarkdown(nodes[i]);
    }
    // Normalize multiple newlines
    md = md.replace(/\n{4,}/g, '\n\n\n');
    return md.trim();
  }

  function nodeToMarkdown(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.textContent;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    var tag = node.tagName.toLowerCase();
    var inner = '';
    for (var i = 0; i < node.childNodes.length; i++) {
      inner += nodeToMarkdown(node.childNodes[i]);
    }

    switch (tag) {
      case 'strong': case 'b':
        return '**' + inner + '**';
      case 'em': case 'i':
        return '*' + inner + '*';
      case 's': case 'del': case 'strike':
        return '~~' + inner + '~~';
      case 'u': case 'ins':
        return '<u>' + inner + '</u>';
      case 'code':
        return '`' + inner + '`';
      case 'a':
        var href = node.getAttribute('href') || '';
        return '[' + inner + '](' + href + ')';
      case 'img':
        var alt = node.getAttribute('alt') || '';
        var src = node.getAttribute('src') || '';
        return '![' + alt + '](' + src + ')';
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
        var level = parseInt(tag[1]);
        var prefix = Array(level + 1).join('#');
        return '\n\n' + prefix + ' ' + inner.trim() + '\n\n';
      case 'p':
        var trimmed = inner.trim();
        if (!trimmed) return '\n\n\u00a0\n\n'; // preserve empty paragraph
        return '\n\n' + trimmed + '\n\n';
      case 'br':
        return '\n';
      case 'hr':
        return '\n\n---\n\n';
      case 'ul':
      case 'ol':
        return '\n\n' + inner.trim() + '\n\n';
      case 'li': {
        var parentTag = node.parentNode ? node.parentNode.tagName.toLowerCase() : 'ul';
        var prefix = parentTag === 'ol' ? '1. ' : '- ';
        // Handle task lists
        var cb = node.querySelector('input[type="checkbox"]');
        if (cb) {
          var checked = cb.checked ? '[x]' : '[ ]';
          var textWithoutCB = inner.replace(/^\[.\]\s*/, '');
          return prefix + checked + ' ' + textWithoutCB.trim() + '\n';
        }
        return prefix + inner.trim() + '\n';
      }
      case 'blockquote': {
        var lines = inner.trim().split('\n');
        var quoted = lines.map(function (l) { return '> ' + l; }).join('\n');
        return '\n\n' + quoted + '\n\n';
      }
      case 'pre': {
        // Use node.textContent (not codeEl.textContent) because Chromium's
        // contenteditable may insert typed text as a text node SIBLING of
        // <code> inside <pre>, rather than inside <code>.
        var codeText = node.textContent;
        var lang = '';
        var codeEl = node.querySelector('code');
        if (codeEl) {
          var cls = codeEl.getAttribute('class') || '';
          var m = cls.match(/language-(\w+)/);
          if (m) lang = m[1];
        }
        return '\n\n```' + lang + '\n' + codeText.replace(/\n$/, '') + '\n```\n\n';
      }
      case 'table':
        return tableToMarkdown(node);
      case 'div':
        // Skip code-block-header (UI-only: copy button, lang label).
        // Without this, the lang label text leaks into the markdown and
        // accumulates on each render (e.g. "javascript" paragraphs).
        if (node.classList && node.classList.contains('code-block-header')) return '';
        // For wrapper divs like code-block-wrap
        return '\n\n' + inner.trim() + '\n\n';
      default:
        // Handle KaTeX rendered math — extract LaTeX from annotation element
        if (tag === 'span' && node.classList && node.classList.contains('katex')) {
          var annotation = node.querySelector('annotation[encoding="application/x-tex"]');
          if (annotation && annotation.textContent) {
            var latex = annotation.textContent;
            var isDisplay = node.classList.contains('katex-display');
            return isDisplay ? '\n\n$$' + latex + '$$\n\n' : '$' + latex + '$';
          }
        }
        return inner;
    }
  }

  function tableToMarkdown(table) {
    var rows = table.querySelectorAll('tr');
    var data = [];
    var maxCols = 0;

    for (var ri = 0; ri < rows.length; ri++) {
      var cells = rows[ri].querySelectorAll('td, th');
      var row = [];
      for (var ci = 0; ci < cells.length; ci++) {
        var cell = cells[ci];
        var align = cell.style.textAlign || cell.getAttribute('align') || '';
        // Use htmlToMarkdown for each cell to preserve inline formatting
        var text = htmlToMarkdown(cell).replace(/\n+/g, ' ');
        row.push({ text: text, align: align });
      }
      data.push(row);
      maxCols = Math.max(maxCols, row.length);
    }

    if (data.length === 0) return '';

    // Ensure all rows have same number of columns
    for (var pi = 0; pi < data.length; pi++) {
      while (data[pi].length < maxCols) data[pi].push({ text: '', align: '' });
    }

    // Determine column alignment from header row only
    // (body row alignment should not affect column separator)
    var colAlign = [];
    if (data.length > 0) {
      for (var c = 0; c < maxCols; c++) {
        colAlign[c] = data[0][c].align || '';
      }
    }

    var md = '|';
    for (var j = 0; j < maxCols; j++) md += ' ' + data[0][j].text + ' |';
    md += '\n|';
    for (var j2 = 0; j2 < maxCols; j2++) {
      var a = colAlign[j2];
      if (a === 'center') md += ' :---: |';
      else if (a === 'right') md += ' ---: |';
      else if (a === 'left') md += ' :--- |';
      else md += ' --- |';
    }
    md += '\n';
    for (var ri2 = 1; ri2 < data.length; ri2++) {
      md += '|';
      for (var ci2 = 0; ci2 < maxCols; ci2++) {
        md += ' ' + data[ri2][ci2].text + ' |';
      }
      md += '\n';
    }
    return md;
  }

  // ===== Get Markdown from Editor =====
  function getEditorMarkdown() {
    // If editor is empty, return empty string
    if (!editor.textContent.trim()) return '';
    return htmlToMarkdown(editor);
  }

  // Get markdown for saving — strips \u00a0 placeholders used to preserve
  // empty paragraphs through the re-render cycle.
  function getSaveMarkdown() {
    var md = getEditorMarkdown();
    // Remove non-breaking space placeholders inserted by htmlToMarkdown
    md = md.replace(/\u00a0/g, '');
    // Collapse runs of blank lines to at most two
    md = md.replace(/\n{3,}/g, '\n\n');
    return md.trim();
  }

  // ===== Render Markdown to Editor =====
  function setEditorContent(md) {
    _markdown = md || '';
    if (!_markdown.trim()) {
      console.log('SETCONTENT: empty markdown, clearing editor');
      editor.innerHTML = '';
      return;
    }
    try {
      var html = window.marked.parse(_markdown);
      editor.innerHTML = html;
    } catch (e) {
      console.log('SETCONTENT: marked.parse THREW:', e.message, 'md length:', _markdown.length, 'md start:', _markdown.substring(0, 200));
      editor.textContent = _markdown;
    }
  }

  // ===== Post-render processing (KaTeX, Mermaid) =====
  function postRender() {
    if (typeof window.renderMathInElement !== 'undefined') {
      try {
        window.renderMathInElement(editor, {
          delimiters: [
            { left: '$$', right: '$$', display: true },
            { left: '$', right: '$', display: false },
          ],
          throwOnError: false,
        });
      } catch (_) {}
    }
    if (typeof window.mermaid !== 'undefined') {
      var mermaidDivs = editor.querySelectorAll('.mermaid');
      if (mermaidDivs.length > 0) {
        try {
          window.mermaid.run({ nodes: [].slice.call(mermaidDivs) });
        } catch (_) {}
      }
    }

    // Copy table-cell alignment from attribute (set by marked) to inline style
    var alignedCells = editor.querySelectorAll('td[align], th[align]');
    for (var ai = 0; ai < alignedCells.length; ai++) {
      var av = alignedCells[ai].getAttribute('align');
      alignedCells[ai].style.textAlign = av;
    }
  }

  // ===== Re-render (debounced, cursor-preserving) =====
  // Cursor position is saved as a character offset in the editor's
  // textContent BEFORE the render, then restored at the same offset
  // AFTER the render. This avoids inserting any marker text that
  // could leak through the marked→hljs pipeline into visible content.
  var _savedCursorOffset = -1;

  // Save cursor position as a character offset from the start of the
  // editor's textContent. Returns true if the offset was saved, false
  // if cursor couldn't be determined.
  function _saveCursorOffset() {
    var sel = window.getSelection();
    if (!sel.rangeCount) { _savedCursorOffset = -1; return false; }
    var range = sel.getRangeAt(0);
    if (!editor.contains(range.startContainer)) { _savedCursorOffset = -1; return false; }
    if (!range.collapsed) { _savedCursorOffset = -1; return false; }

    // Skip when text before cursor ends with ``` (fence completion case)
    if (range.startContainer.nodeType === Node.TEXT_NODE) {
      var textBefore = range.startContainer.textContent.substring(0, range.startOffset);
      if (/```$/.test(textBefore)) {
        _savedCursorOffset = -1;
        return false;
      }
    }

    // Walk all text nodes to compute the absolute character offset
    var walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    var offset = 0;
    while (walker.nextNode()) {
      var node = walker.currentNode;
      if (node === range.startContainer) {
        _savedCursorOffset = offset + range.startOffset;
        return true;
      }
      offset += node.textContent.length;
    }
    _savedCursorOffset = -1;
    return false;
  }

  // After re-render, find the text node at the saved character offset
  // and place the cursor there.
  function _restoreCursorAtOffset() {
    if (_savedCursorOffset < 0) {
      console.log('RESTORE: no saved offset, using fallback');
      placeCursorOutsideCodeBlock();
      return;
    }

    var walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    var offset = 0;
    while (walker.nextNode()) {
      var node = walker.currentNode;
      var len = node.textContent.length;
      if (offset + len >= _savedCursorOffset) {
        var pos = Math.min(_savedCursorOffset - offset, len);
        try {
          var range = document.createRange();
          range.setStart(node, pos);
          range.collapse(true);
          var sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          console.log('RESTORE: cursor at offset ' + _savedCursorOffset);
          return;
        } catch (e) {
          console.log('RESTORE: error placing cursor', e);
          placeCursorAtEnd(editor);
          return;
        }
      }
      offset += len;
    }
    console.log('RESTORE: offset ' + _savedCursorOffset + ' out of range');
    placeCursorAtEnd(editor);
  }

  // Auto-complete triple backticks: when user types ``` at the end of a
  // paragraph, immediately create a <pre><code> code block in the DOM so
  // the marked round-trip handles it correctly. The user types code inside,
  // and can exit by pressing ArrowDown past the code block.
  function _tryCompleteFence() {
    var sel = window.getSelection();
    if (!sel.rangeCount) { console.log('FENCE: no selection'); return false; }
    var range = sel.getRangeAt(0);
    if (!editor.contains(range.startContainer)) { console.log('FENCE: outside editor'); return false; }
    if (!range.collapsed) { console.log('FENCE: not collapsed'); return false; }
    if (range.startContainer.nodeType !== Node.TEXT_NODE) { console.log('FENCE: not text node'); return false; }

    var text = range.startContainer.textContent;
    var offset = range.startOffset;
    var before = text.substring(0, offset);
    var after = text.substring(offset);

    // Check we just finished typing ``` (exactly 3 backticks, not more)
    var m = before.match(/(^|[^`])```$/);
    if (!m) { console.log('FENCE: no match before="' + before + '"'); return false; }
    // Must be at end of text (cursor right after the backticks)
    if (after.length > 0) { console.log('FENCE: after not empty="' + after + '"'); return false; }
    // Make sure we're in a block element (p, li, blockquote, heading)
    var block = range.startContainer;
    while (block && block !== editor && !/^(P|LI|BLOCKQUOTE|H[1-6])$/i.test(block.tagName)) {
      block = block.parentNode;
    }
    if (!block || block === editor) { console.log('FENCE: no valid block'); return false; }
    // Only trigger on its own line (block content is just backticks)
    if (block.textContent.trim() !== '```') { console.log('FENCE: block not just backticks, got="' + block.textContent.trim() + '"'); return false; }
    console.log('FENCE: MATCH! Creating code block');

    // Clear any pending render timer from backtick typing before the
    // fence was triggered — prevents a stale doRender() from corrupting
    // the DOM after we've already created the code block.
    clearTimeout(_renderTimer);
    _skipNextInput = true;
    onBeforeEdit();

    // Create real <pre><code> block element — this survives the marked
    // round-trip correctly (htmlToMarkdown converts it to a fenced code
    // block, and marked parses it right back).
    var pre = document.createElement('pre');
    var code = document.createElement('code');
    code.textContent = '';     // empty, cursor placed at start
    pre.appendChild(code);

    // Insert the code block at the right position in the DOM.
    // For list items, place after the entire list; for others, just
    // replace the block inline.
    var insertParent = block.parentNode;
    var insertRef = block.nextSibling;
    if (block.tagName === 'LI') {
      var list = block.parentNode;
      insertParent = list.parentNode;
      insertRef = list.nextSibling;
      // Remove the list item — if list becomes empty, remove it too
      list.removeChild(block);
      if (list.querySelectorAll('li').length === 0) {
        insertParent.removeChild(list);
      }
    } else {
      block.parentNode.removeChild(block);
    }
    insertParent.insertBefore(pre, insertRef);

    // Place cursor inside the <code> element
    placeCursorAtEnd(code);
    return true;
  }

  // Ensure code fences are always paired before marked.parse().
  // If a lone ``` exists without a closing fence, this adds a closing fence
  // plus a trailing empty paragraph so marked doesn't consume content as code
  // and there's always a place for the cursor to land.
  function _ensureClosedFences(md) {
    var lines = md.split('\n');
    var count = 0;
    for (var i = 0; i < lines.length; i++) {
      // Count ANY line starting with ``` — this covers both bare
      // fences (```) and language-tagged opening fences (```javascript).
      // The old regex /^```\s*$/ only matched bare fences, causing an
      // ODD count when language-tagged blocks were present, which
      // appended a bogus closing fence on EVERY render.
      if (/^```/.test(lines[i])) {
        count++;
      }
    }
    if (count % 2 === 1) {
      // Close the lone fence and add a trailing \u00a0 paragraph,
      // so marked produces a proper code block followed by a `<p>`.
      // The \u00a0 gives the cursor somewhere to land.
      // NOTE: the leading \n before the closing fence is critical —
      // without it, the closing fence is concatenated onto the last
      // line of content, corrupting the code block.
      md += '\n```\n\u00a0\n';
    }
    return md;
  }

  function scheduleRender() {
    if (_isRendering) return;
    if (_isComposing) return; // Don't schedule re-render during active IME composition
    clearTimeout(_renderTimer);
    _renderTimer = setTimeout(doRender, 400);
  }

  function doRender() {
    if (_isRendering) { console.log('RENDER: already rendering, skip'); return; }
    if (_isComposing) {
      clearTimeout(_renderTimer);
      _renderTimer = setTimeout(doRender, 400);
      console.log('RENDER: composing, re-schedule');
      return;
    }
    console.log('RENDER: start');
    var scrollTop = editor.scrollTop;
    var hasOffset = _saveCursorOffset();
    console.log('RENDER: hasOffset=' + hasOffset);

    var md = getEditorMarkdown();
    md = _ensureClosedFences(md);
    _markdown = md;
    console.log('RENDER: md length=' + md.length + ' md[:100]="' + md.substring(0, 100).replace(/\n/g, '\\n') + '"');
    console.log('RENDER: fence count=' + md.split('\n').filter(function(l){return /^```/.test(l);}).length);

    _isRendering = true;
    try {
      setEditorContent(md);
    } catch (e) {
      console.log('RENDER: EXCEPTION in setEditorContent:', e.message);
      _isRendering = false;
      throw e;
    }
    _isRendering = false;

    var lastEl = editor.lastElementChild;
    if (lastEl && lastEl.matches('.code-block-wrap')) {
      var p = document.createElement('p');
      p.innerHTML = '<br>';
      editor.appendChild(p);
      console.log('RENDER: appended trailing <p> after code-block-wrap');
    }

    if (hasOffset) {
      _restoreCursorAtOffset();
    } else {
      console.log('RENDER: no offset, using placeCursorOutsideCodeBlock');
      placeCursorOutsideCodeBlock();
    }
    editor.scrollTop = scrollTop;

    updateStatus(md);
    updateOutline();
    postRender();
    resetAutoSave();
    console.log('RENDER: complete');
  }

  // ===== History (Undo/Redo) =====
  function pushHistory() {
    if (_historyGrouping || _isRendering) return;
    var md = getEditorMarkdown();
    // Don't push duplicate
    if (_historyIdx >= 0 && _history[_historyIdx] === md) return;
    // Truncate redo entries
    _history = _history.slice(0, _historyIdx + 1);
    _history.push(md);
    if (_history.length > _historyMax) _history.shift();
    _historyIdx = _history.length - 1;
  }

  function onBeforeEdit() {
    if (_historyGrouping || _isRendering) return;
    pushHistory();
    _historyGrouping = true;
    clearTimeout(_historyTimer);
    _historyTimer = setTimeout(function () {
      _historyGrouping = false;
    }, 500);
  }

  function initHistory() {
    var md = getEditorMarkdown();
    _history = [md || ''];
    _historyIdx = 0;
    _historyGrouping = false;
  }

  function undo() {
    if (_historyIdx <= 0) return;
    if (_historyIdx === _history.length - 1 && !_historyGrouping) {
      pushHistory();
      _historyIdx--;
    }
    _historyIdx--;
    restoreFromHistory(_history[_historyIdx]);
  }

  function redo() {
    if (_historyIdx >= _history.length - 1) return;
    _historyIdx++;
    restoreFromHistory(_history[_historyIdx]);
  }

  function restoreFromHistory(md) {
    _markdown = md;
    _isRendering = true;
    setEditorContent(md);
    _isRendering = false;
    updateStatus(md);
    updateOutline();
    postRender();
    // Place cursor at end of document
    var allBlocks = editor.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, td, th, blockquote, pre, div.code-block-wrap');
    var lastBlock = allBlocks[allBlocks.length - 1];
    if (lastBlock) placeCursorAtEnd(lastBlock);
  }

  // ===== Outline =====
  function updateOutline() {
    var text = _markdown || '';
    if (!text.trim()) {
      outlineBody.innerHTML = '<div class="outline-empty">No headings</div>';
      return;
    }

    var headings = [];
    var lines = text.split('\n');
    for (var i = 0; i < lines.length; i++) {
      var m = lines[i].match(/^(#{1,6})\s+(.+)$/);
      if (m) {
        headings.push({
          level: m[1].length,
          text: m[2].trim(),
          line: i,
        });
      }
    }

    if (headings.length === 0) {
      outlineBody.innerHTML = '<div class="outline-empty">No headings</div>';
      return;
    }

    // Determine active heading by cursor position
    var sel = window.getSelection();
    var activeIdx = -1;
    if (sel.rangeCount) {
      var block = findBlockElement(sel.getRangeAt(0).startContainer);
      // Count how many heading elements come before this block in the DOM
      var headingCount = 0;
      if (block) {
        var el = block;
        while (el = el.previousElementSibling) {
          if (/^H[1-6]$/.test(el.tagName)) headingCount++;
        }
      }
      activeIdx = Math.min(headingCount, headings.length - 1);
    }

    var html = '';
    for (var j = 0; j < headings.length; j++) {
      var cls = 'outline-item' + (j === activeIdx ? ' active' : '');
      html += '<div class="' + cls + '" data-level="' + headings[j].level
        + '" data-line="' + headings[j].line + '">'
        + escapeHtml(headings[j].text) + '</div>';
    }
    outlineBody.innerHTML = html;

    var activeEl = outlineBody.querySelector('.outline-item.active');
    if (activeEl) {
      activeEl.scrollIntoView({ block: 'nearest' });
    }
  }

  function onOutlineClick(e) {
    var item = e.target.closest('.outline-item');
    if (!item) return;
    // Scroll to heading in rendered view
    var lineIdx = parseInt(item.dataset.line);
    if (isNaN(lineIdx)) return;
    // Find the heading element by matching text
    var headingText = item.textContent.trim();
    var headings = editor.querySelectorAll('h1, h2, h3, h4, h5, h6');
    for (var i = 0; i < headings.length; i++) {
      if (headings[i].textContent.trim() === headingText) {
        headings[i].scrollIntoView({ behavior: 'smooth', block: 'center' });
        // Place cursor at start of heading
        var range = document.createRange();
        range.setStart(headings[i], 0);
        range.collapse(true);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        editor.focus();
        break;
      }
    }
  }

  function toggleOutline() {
    state.showOutline = !state.showOutline;
    document.body.classList.toggle('outline-hidden', !state.showOutline);
    if (state.showOutline) {
      // Show the outline panel when toggling on
      setSidebarPanel('outline');
    }
  }

  // ===== Status =====
  function updateStatus(text) {
    var raw = (text || '').replace(/\u00a0/g, ' ');
    var trimmed = raw.trim();
    var words = trimmed ? trimmed.split(/\s+/).length : 0;
    var lines = raw.length ? raw.split('\n').length : 0;
    var chars = raw.length;
    statusWords.textContent = formatNumber(words) + ' word' + (words !== 1 ? 's' : '');
    statusLines.textContent = formatNumber(lines) + ' line' + (lines !== 1 ? 's' : '');
    statusChars.textContent = formatNumber(chars) + ' char' + (chars !== 1 ? 's' : '');
    var readMin = Math.max(1, Math.round(words / 200));
    statusReadTime.textContent = readMin + ' min read';
  }

  // ===== Word count popup =====
  function toggleWordCountPopup(e) {
    var show = wordcountPopup.classList.toggle('hidden');
    if (show) return;
    var text = getEditorMarkdown();
    var trimmed = text.trim();
    var words = trimmed ? trimmed.split(/\s+/).length : 0;
    var chars = text.length;
    var charsNS = text.replace(/\s/g, '').length;
    var lines = text.length ? text.split('\n').length : 0;
    var paras = trimmed ? trimmed.split(/\n{2,}/).length : 0;
    var readMin = Math.max(1, Math.round(words / 200));
    popupWords.textContent = formatNumber(words);
    popupChars.textContent = formatNumber(chars);
    popupCharsNoSpace.textContent = formatNumber(charsNS);
    popupLines.textContent = formatNumber(lines);
    popupParas.textContent = formatNumber(paras);
    popupReadTime.textContent = readMin + ' min';
    var rect = statusWords.getBoundingClientRect();
    wordcountPopup.style.right = (window.innerWidth - rect.right) + 'px';
    setTimeout(function () {
      document.addEventListener('click', hideWordCountPopup);
    }, 10);
  }

  function hideWordCountPopup(e) {
    if (wordcountPopup.contains(e.target) || e.target === statusWords) return;
    wordcountPopup.classList.add('hidden');
    document.removeEventListener('click', hideWordCountPopup);
  }

  // ===== Auto Save =====
  function resetAutoSave() {
    clearTimeout(_autoSaveTimer);
    if (!state.currentFile) return;
    _autoSaveTimer = setTimeout(function () {
      var md = getSaveMarkdown();
      if (md && window.electronAPI && window.electronAPI.saveContent) {
        window.electronAPI.saveContent(md);
      }
    }, 30000);
  }

  // Save current document before leaving it — saves to disk if currentFile
  // exists, otherwise saves draft to localStorage as a fallback.
  function saveCurrentDocument() {
    var md = getSaveMarkdown();
    if (!md) return;
    if (state.currentFile && window.electronAPI && window.electronAPI.saveContent) {
      window.electronAPI.saveContent(md);
    }
    try {
      localStorage.setItem('marky-draft', md);
    } catch (_) {}
  }

  function formatNumber(n) {
    return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function escapeAttr(str) {
    return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ===== Theme =====
  function toggleTheme(dark) {
    state.isDark = dark;
    document.body.classList.remove('theme-light', 'theme-dark');
    document.body.classList.add(dark ? 'theme-dark' : 'theme-light');
    statusTheme.textContent = state.focusMode ? 'Focus' : (dark ? 'Dark' : 'Light');
  }

  // ===== Focus Mode =====
  function toggleFocus() {
    state.focusMode = !state.focusMode;
    document.body.classList.toggle('focus-mode', state.focusMode);
    statusTheme.textContent = state.focusMode ? 'Focus' : (state.isDark ? 'Dark' : 'Light');
    if (state.focusMode) editor.focus();
  }

  // ===== File Operations =====
  function newFile() {
    saveCurrentDocument();
    if (_markdown.trim() !== '' && !confirm('Clear the current document?')) return;
    _markdown = '';
    editor.innerHTML = '';
    updateStatus('');
    outlineBody.innerHTML = '<div class="outline-empty">No headings</div>';
    state.currentFile = null;
    state.fileName = 'untitled.md';
    fileNameEl.textContent = state.fileName;
    statusFile.textContent = state.fileName;
    document.title = state.fileName + ' — Marky';
    initHistory();
    editor.focus();
  }

  function loadContent(text) {
    var md = text || '';
    _markdown = md;
    setEditorContent(md);
    updateStatus(md);
    updateOutline();
    postRender();
    initHistory();
  }

  function onFileOpened(data) {
    saveCurrentDocument();
    loadContent(data.content);
    state.currentFile = data.filePath;
    state.fileName = data.filePath.split('/').pop().split('\\').pop();
    fileNameEl.textContent = state.fileName;
    statusFile.textContent = state.fileName;
    document.title = state.fileName + ' — Marky';
    // If this file is in the current folder, highlight it in the file list
    if (state.currentFolder) {
      var fileInFolder = state.folderFiles.some(function (f) { return f.path === data.filePath; });
      if (fileInFolder) renderFileList();
    }
  }

  function onFileSaved(data) {
    if (data.error) {
      statusFile.textContent = 'Save failed: ' + data.error;
      setTimeout(function () { statusFile.textContent = state.fileName; }, 4000);
      return;
    }
    state.currentFile = data.path;
    state.fileName = data.path.split('/').pop().split('\\').pop();
    fileNameEl.textContent = state.fileName;
    statusFile.textContent = state.fileName + ' — Saved';
    document.title = state.fileName + ' — Marky';
    setTimeout(function () { statusFile.textContent = state.fileName; }, 2000);
  }

  async function exportHtml() {
    ensureMarked();
    var body = window.marked.parse(_markdown);
    var title = state.fileName.replace(/\.md$/i, '');
    var fullHtml = '<!DOCTYPE html>\n<html lang="en">\n<head>\n'
      + '<meta charset="UTF-8">\n'
      + '<meta name="viewport" content="width=device-width, initial-scale=1.0">\n'
      + '<title>' + escapeHtml(title) + '</title>\n'
      + '<style>\n'
      + '  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 800px; margin: 40px auto; padding: 0 24px; line-height: 1.7; color: #333; }\n'
      + '  pre { background: #f5f5f5; padding: 16px 20px; border-radius: 8px; overflow-x: auto; }\n'
      + '  code { background: #f5f5f5; padding: 2px 6px; border-radius: 4px; font-size: 0.9em; font-family: "SF Mono", Monaco, Consolas, monospace; }\n'
      + '  pre code { background: none; padding: 0; }\n'
      + '  img { max-width: 100%; border-radius: 8px; }\n'
      + '  table { border-collapse: collapse; width: 100%; margin: 1em 0; }\n'
      + '  th, td { border: 1px solid #ddd; padding: 10px 14px; text-align: left; }\n'
      + '  th { background: #f9fafb; }\n'
      + '  blockquote { border-left: 4px solid #4a6cf7; margin: 1em 0; padding: 8px 20px; background: #f8f9ff; border-radius: 0 6px 6px 0; }\n'
      + '  h1, h2 { border-bottom: 1px solid #eee; padding-bottom: 0.3em; }\n'
      + '</style>\n</head>\n<body>\n' + body + '\n</body>\n</html>';
    await window.electronAPI.exportHtml(fullHtml);
  }

  // ===== List Indent / Outdent =====
  function indentListItem(li) {
    var parent = li.parentNode;
    var prev = li.previousElementSibling;
    if (!prev) return; // First item can't be indented
    var listTag = parent.tagName; // 'UL' or 'OL'
    // Find or create a nested list in the previous sibling
    var nested = prev.querySelector('ul, ol');
    if (!nested) {
      nested = document.createElement(listTag);
      prev.appendChild(nested);
    }
    nested.appendChild(li);
  }

  function outdentListItem(li) {
    var parentList = li.parentNode;             // UL/OL containing li
    var parentItem = parentList.parentNode;      // LI or editor containing the list
    if (!parentItem || parentItem.tagName !== 'LI') return; // Already top level
    var outerList = parentItem.parentNode;        // UL/OL at outer level
    if (!outerList) return;
    // Move li after the parent list item in the outer list
    outerList.insertBefore(li, parentItem.nextSibling);
    // Clean up empty nested list
    if (!parentList.querySelector('li')) {
      parentItem.removeChild(parentList);
      // If the parent LI is now empty of text and other elements, remove it
      if (!parentItem.textContent.trim()) {
        outerList.removeChild(parentItem);
      }
    }
  }
  function insertTable(rows, cols) {
    onBeforeEdit();

    var table = document.createElement('table');
    var tbody = document.createElement('tbody');

    // Header row
    var thead = document.createElement('thead');
    var headerRow = document.createElement('tr');
    for (var c = 0; c < cols; c++) {
      var th = document.createElement('th');
      th.textContent = 'Header ' + (c + 1);
      th.contentEditable = true;
      headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    // Body rows
    for (var r = 0; r < rows; r++) {
      var tr = document.createElement('tr');
      for (var c2 = 0; c2 < cols; c2++) {
        var td = document.createElement('td');
        td.textContent = 'Cell';
        td.contentEditable = true;
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);

    // Insert at cursor position or end of editor
    var sel = window.getSelection();
    if (sel.rangeCount) {
      var range = sel.getRangeAt(0);
      if (editor.contains(range.startContainer)) {
        // Insert table after current block
        var parentBlock = range.startContainer;
        while (parentBlock && parentBlock !== editor) {
          if (['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'DIV', 'BLOCKQUOTE', 'UL', 'OL', 'PRE', 'HR'].indexOf(parentBlock.tagName) >= 0) {
            parentBlock.parentNode.insertBefore(table, parentBlock.nextSibling);
            // Add a paragraph break after table
            var br = document.createElement('br');
            if (parentBlock.nextSibling) {
              parentBlock.parentNode.insertBefore(br, parentBlock.nextSibling);
            } else {
              parentBlock.parentNode.appendChild(br);
            }
            break;
          }
          parentBlock = parentBlock.parentNode;
        }
        if (parentBlock === editor) {
          editor.appendChild(table);
          editor.appendChild(document.createElement('br'));
        }
      } else {
        editor.appendChild(table);
        editor.appendChild(document.createElement('br'));
      }
    } else {
      editor.appendChild(table);
      editor.appendChild(document.createElement('br'));
    }

    // Focus first cell
    var firstCell = table.querySelector('th, td');
    if (firstCell) {
      var range = document.createRange();
      range.setStart(firstCell, 0);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      editor.focus();
    }

    scheduleRender();
  }

  // ===== Table Editing =====

  function getActiveTableCell() {
    var sel = window.getSelection();
    if (!sel.rangeCount) return null;
    var node = sel.anchorNode;
    while (node && node !== editor) {
      if (node.tagName === 'TD' || node.tagName === 'TH') return node;
      node = node.parentNode;
    }
    return null;
  }

  function tableAddRowAbove(cell) {
    onBeforeEdit();
    var table = cell.closest('table');
    var tr = cell.closest('tr');
    if (!table || !tr) return;
    var tbody = tr.parentNode;
    var newRow = document.createElement('tr');
    var refCells = tr.querySelectorAll('td, th');
    for (var i = 0; i < refCells.length; i++) {
      var newCell = document.createElement(refCells[i].tagName);
      newCell.textContent = 'Cell';
      newCell.contentEditable = true;
      newRow.appendChild(newCell);
    }
    tbody.insertBefore(newRow, tr);
    scheduleRender();
  }

  function tableAddRowBelow(cell) {
    onBeforeEdit();
    var table = cell.closest('table');
    var tr = cell.closest('tr');
    if (!table || !tr) return;
    var tbody = tr.parentNode;
    var newRow = document.createElement('tr');
    var refCells = tr.querySelectorAll('td, th');
    for (var i = 0; i < refCells.length; i++) {
      var newCell = document.createElement(refCells[i].tagName);
      newCell.textContent = 'Cell';
      newCell.contentEditable = true;
      newRow.appendChild(newCell);
    }
    tbody.insertBefore(newRow, tr.nextSibling);
    scheduleRender();
  }

  function tableAddColumnLeft(cell) {
    onBeforeEdit();
    var table = cell.closest('table');
    if (!table) return;
    var tr = cell.closest('tr');
    var colIdx = Array.prototype.indexOf.call(tr.querySelectorAll('td, th'), cell);
    if (colIdx < 0) return;
    var rows = table.querySelectorAll('tr');
    for (var i = 0; i < rows.length; i++) {
      var refCell = rows[i].querySelectorAll('td, th')[colIdx];
      if (refCell) {
        var newCell = document.createElement(refCell.tagName);
        newCell.textContent = 'Cell';
        newCell.contentEditable = true;
        rows[i].insertBefore(newCell, refCell);
      }
    }
    scheduleRender();
  }

  function tableAddColumnRight(cell) {
    onBeforeEdit();
    var table = cell.closest('table');
    if (!table) return;
    var tr = cell.closest('tr');
    var colIdx = Array.prototype.indexOf.call(tr.querySelectorAll('td, th'), cell);
    if (colIdx < 0) return;
    var rows = table.querySelectorAll('tr');
    for (var i = 0; i < rows.length; i++) {
      var refCell = rows[i].querySelectorAll('td, th')[colIdx];
      if (refCell) {
        var newCell = document.createElement(refCell.tagName);
        newCell.textContent = 'Cell';
        newCell.contentEditable = true;
        if (refCell.nextSibling) {
          rows[i].insertBefore(newCell, refCell.nextSibling);
        } else {
          rows[i].appendChild(newCell);
        }
      }
    }
    scheduleRender();
  }

  function tableAlignRow(cell, align) {
    onBeforeEdit();
    var tr = cell.closest('tr');
    if (!tr) return;
    var cells = tr.querySelectorAll('td, th');
    for (var i = 0; i < cells.length; i++) {
      cells[i].style.textAlign = align;
    }
    scheduleRender();
  }

  function tableAlignColumn(cell, align) {
    onBeforeEdit();
    var table = cell.closest('table');
    if (!table) return;
    var tr = cell.closest('tr');
    var colIdx = Array.prototype.indexOf.call(tr.querySelectorAll('td, th'), cell);
    if (colIdx < 0) return;
    var rows = table.querySelectorAll('tr');
    for (var i = 0; i < rows.length; i++) {
      var targetCell = rows[i].querySelectorAll('td, th')[colIdx];
      if (targetCell) {
        targetCell.style.textAlign = align;
      }
    }
    scheduleRender();
  }

  // ===== Table Grid Picker =====
  function setupTableGrid() {
    if (!tableGrid) return;
    tableGrid.innerHTML = '';
    for (var i = 0; i < 100; i++) {
      var cell = document.createElement('div');
      cell.className = 'table-grid-cell';
      cell.dataset.idx = i;
      tableGrid.appendChild(cell);
    }

    tableGrid.addEventListener('mouseover', function (e) {
      var cell = e.target.closest('.table-grid-cell');
      if (!cell) return;
      var idx = parseInt(cell.dataset.idx);
      var cols = (idx % 10) + 1;
      var rows = Math.floor(idx / 10) + 1;
      gridLabel.textContent = rows + ' x ' + cols;
      var cells = tableGrid.querySelectorAll('.table-grid-cell');
      for (var j = 0; j < cells.length; j++) {
        var ci = parseInt(cells[j].dataset.idx);
        var r = Math.floor(ci / 10) + 1;
        var cVal = (ci % 10) + 1;
        cells[j].classList.toggle('selected', r <= rows && cVal <= cols);
      }
    });

    tableGrid.addEventListener('click', function (e) {
      var cell = e.target.closest('.table-grid-cell');
      if (!cell) return;
      var idx = parseInt(cell.dataset.idx);
      var cols = (idx % 10) + 1;
      var rows = Math.floor(idx / 10) + 1;
      tableGridPicker.classList.add('hidden');
      insertTable(rows, cols);
    });
  }

  function showTableGridPicker(x, y) {
    if (!tableGridPicker) return;
    tableGridPicker.style.left = x + 'px';
    tableGridPicker.style.top = y + 'px';
    tableGridPicker.classList.remove('hidden');
    gridLabel.textContent = 'Select size';
    tableGrid.querySelectorAll('.table-grid-cell').forEach(function (c) { c.classList.remove('selected'); });
  }

  function setupTableButton() {
    if (toolbarTableBtn) {
      toolbarTableBtn.addEventListener('click', function (e) {
        var rect = toolbarTableBtn.getBoundingClientRect();
        showTableGridPicker(rect.left, rect.bottom + 4);
      });
    }
  }

  // ===== Code Language Picker =====
  var _codeLangPicker = null;
  var _codeLangPickerX = 0;
  var _codeLangPickerY = 0;

  function showCodeLangPicker(x, y) {
    _codeLangPicker = document.getElementById('codeLangPicker');
    if (!_codeLangPicker) return;
    _codeLangPickerX = x;
    _codeLangPickerY = y;
    _codeLangPicker.style.left = x + 'px';
    _codeLangPicker.style.top = y + 'px';
    _codeLangPicker.classList.remove('hidden');
  }

  function hideCodeLangPicker() {
    if (_codeLangPicker) {
      _codeLangPicker.classList.add('hidden');
    }
  }

  function insertFencedCodeBlock(lang) {
    hideCodeLangPicker();
    var sel = window.getSelection();
    var selectedText = sel.toString().trim();
    var langTag = lang || '';
    onBeforeEdit();

    if (selectedText && sel.rangeCount) {
      var range = sel.getRangeAt(0);
      range.deleteContents();
      range.insertNode(document.createTextNode('\n```' + langTag + '\n' + selectedText + '\n```\n'));
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
      scheduleRender();
    } else {
      loadContent(_markdown + '\n```' + langTag + '\n\n```\n');
    }
  }

  function setupCodeLangPicker() {
    _codeLangPicker = document.getElementById('codeLangPicker');
    if (!_codeLangPicker) return;

    _codeLangPicker.addEventListener('click', function (e) {
      var item = e.target.closest('.code-lang-item');
      if (!item) return;
      var lang = item.dataset.lang || '';
      insertFencedCodeBlock(lang);
    });

    // Hide on click outside
    document.addEventListener('click', function (e) {
      if (_codeLangPicker && !_codeLangPicker.contains(e.target) &&
          !e.target.closest('[data-menu-action="code"]') &&
          !_codeLangPicker.classList.contains('hidden')) {
        _codeLangPicker.classList.add('hidden');
      }
    });
  }

  // ===== Context Menu =====
  var lastContextMenuX = 0;
  var lastContextMenuY = 0;

  function setupContextMenu() {
    editor.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      if (!contextMenu) return;
      lastContextMenuX = e.clientX;
      lastContextMenuY = e.clientY;
      contextMenu.style.left = e.clientX + 'px';
      contextMenu.style.top = e.clientY + 'px';
      contextMenu.classList.remove('hidden');

      // Show/hide table editing items based on cursor context
      var inTable = !!getActiveTableCell();
      var tableItems = contextMenu.querySelectorAll('.table-context-item');
      for (var ti = 0; ti < tableItems.length; ti++) {
        tableItems[ti].classList.toggle('hidden', !inTable);
      }
    });

    document.addEventListener('click', function (e) {
      if (contextMenu && !contextMenu.contains(e.target)) {
        contextMenu.classList.add('hidden');
      }
    });

    if (contextMenu) {
      contextMenu.addEventListener('click', function (e) {
        var action = e.target.closest('[data-menu-action]');
        if (!action) return;
        switch (action.dataset.menuAction) {
          case 'bold':
            contextMenu.classList.add('hidden');
            applyFormat('bold');
            break;
          case 'italic':
            contextMenu.classList.add('hidden');
            applyFormat('italic');
            break;
          case 'underline':
            contextMenu.classList.add('hidden');
            applyFormat('underline');
            break;
          case 'strikethrough':
            contextMenu.classList.add('hidden');
            applyFormat('strikethrough');
            break;
          case 'code':
            contextMenu.classList.add('hidden');
            showCodeLangPicker(lastContextMenuX, lastContextMenuY);
            break;
          case 'insert-link':
            contextMenu.classList.add('hidden');
            showLinkDialog();
            break;
          case 'insert-math':
            contextMenu.classList.add('hidden');
            showMathDialog();
            break;
          case 'insert-table':
            contextMenu.classList.add('hidden');
            var rect = contextMenu.getBoundingClientRect();
            showTableGridPicker(rect.left, rect.top);
            break;
          case 'insert-image':
            contextMenu.classList.add('hidden');
            pickAndInsertImage();
            break;
          case 'add-row-above':
            contextMenu.classList.add('hidden');
            tableAddRowAbove(getActiveTableCell());
            break;
          case 'add-row-below':
            contextMenu.classList.add('hidden');
            tableAddRowBelow(getActiveTableCell());
            break;
          case 'add-column-left':
            contextMenu.classList.add('hidden');
            tableAddColumnLeft(getActiveTableCell());
            break;
          case 'add-column-right':
            contextMenu.classList.add('hidden');
            tableAddColumnRight(getActiveTableCell());
            break;
          case 'align-row-left':
            contextMenu.classList.add('hidden');
            tableAlignRow(getActiveTableCell(), 'left');
            break;
          case 'align-row-center':
            contextMenu.classList.add('hidden');
            tableAlignRow(getActiveTableCell(), 'center');
            break;
          case 'align-column-left':
            contextMenu.classList.add('hidden');
            tableAlignColumn(getActiveTableCell(), 'left');
            break;
          case 'align-column-center':
            contextMenu.classList.add('hidden');
            tableAlignColumn(getActiveTableCell(), 'center');
            break;
        }
      });
    }
  }

  // ===== Template Insertion =====
  function setupTemplates() {
    if (!templateBtn || !templateDropdown) return;

    templateBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      var rect = templateBtn.getBoundingClientRect();
      templateDropdown.style.top = rect.bottom + 4 + 'px';
      templateDropdown.style.left = rect.left + 'px';
      templateDropdown.classList.toggle('hidden');
    });

    templateDropdown.addEventListener('click', function (e) {
      var item = e.target.closest('.template-item');
      if (!item) return;
      templateDropdown.classList.add('hidden');
      insertTemplate(item.dataset.template);
    });

    document.addEventListener('click', function () {
      templateDropdown.classList.add('hidden');
    });
  }

  function insertTemplate(type) {
    var templates = {
      readme: '# Project Name\n\n## Description\n\nA brief description of your project.\n\n## Installation\n\n```bash\nnpm install\n```\n\n## Usage\n\n```javascript\n// Your code here\n```\n\n## License\n\nMIT\n',
      changelog: '# Changelog\n\n## [1.0.0] - ' + new Date().toISOString().slice(0, 10) + '\n\n### Added\n- New feature\n\n### Changed\n- Updated feature\n\n### Fixed\n- Bug fix\n',
      meeting: '# Meeting Notes\n\n**Date:** ' + new Date().toISOString().slice(0, 10) + '\n**Attendees:** \n\n## Agenda\n\n1. \n2. \n3. \n\n## Discussion\n\n\n## Action Items\n\n- [ ] \n',
      blog: '# Blog Post Title\n\n*Published on ' + new Date().toISOString().slice(0, 10) + '*\n\n## Introduction\n\nStart writing here...\n\n## Main Content\n\n\n## Conclusion\n\nSummarize your post here.\n'
    };

    var content = templates[type] || '';
    if (!content) return;
    saveCurrentDocument();
    if (_markdown.trim()) {
      content = _markdown + '\n\n' + content;
    }
    loadContent(content);
  }

  // ===== Math Formula Dialog =====
  var _mathDialog = null;
  var _mathInput = null;
  var _mathPreview = null;

  function showMathDialog() {
    if (!_mathDialog) return;
    _mathInput.value = '';
    _mathPreview.innerHTML = '<span class="math-prompt">Formula preview will appear here</span>';
    _mathDialog.classList.remove('hidden');
    _mathInput.focus();
  }

  function hideMathDialog() {
    if (!_mathDialog) return;
    _mathDialog.classList.add('hidden');
    editor.focus();
  }

  function renderMathPreview() {
    var latex = _mathInput.value.trim();
    if (!latex) {
      _mathPreview.innerHTML = '<span class="math-prompt">Formula preview will appear here</span>';
      return;
    }
    _mathPreview.innerHTML = '$$' + latex + '$$';
    if (typeof window.renderMathInElement !== 'undefined') {
      try {
        window.renderMathInElement(_mathPreview, {
          delimiters: [
            { left: '$$', right: '$$', display: true },
            { left: '$', right: '$', display: false },
          ],
          throwOnError: false,
        });
      } catch (_) {}
    }
  }

  function insertMath(displayMode) {
    var latex = _mathInput.value.trim();
    if (!latex) return;
    var insertText;
    if (displayMode) {
      insertText = '\n\n$$' + latex + '$$\n\n';
    } else {
      insertText = '$' + latex + '$';
    }
    hideMathDialog();
    onBeforeEdit();
    var newContent = _markdown + '\n' + insertText;
    loadContent(newContent);
    scheduleRender();
  }

  function setupMathDialog() {
    _mathDialog = document.getElementById('mathDialog');
    var mathBackdrop = document.getElementById('mathBackdrop');
    var mathClose = document.getElementById('mathClose');
    _mathInput = document.getElementById('mathInput');
    _mathPreview = document.getElementById('mathPreview');
    var mathInline = document.getElementById('mathInsertInline');
    var mathDisplay = document.getElementById('mathInsertDisplay');

    if (!_mathDialog) return;

    mathBackdrop.addEventListener('click', hideMathDialog);
    mathClose.addEventListener('click', hideMathDialog);
    _mathInput.addEventListener('input', renderMathPreview);
    mathInline.addEventListener('click', function () { insertMath(false); });
    mathDisplay.addEventListener('click', function () { insertMath(true); });

    _mathInput.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { hideMathDialog(); }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        insertMath(false);
      }
      if (e.key === 'Enter' && e.shiftKey) {
        e.preventDefault();
        insertMath(true);
      }
    });
  }

  // ===== Link Dialog =====
  var _linkDialog = null;
  var _linkTextInput = null;
  var _linkUrlInput = null;

  function showLinkDialog() {
    if (!_linkDialog) return;
    var sel = window.getSelection();
    var selectedText = sel.toString().trim();
    _linkTextInput.value = selectedText || '';
    _linkUrlInput.value = '';
    _linkDialog.classList.remove('hidden');
    if (_linkTextInput.value) {
      _linkUrlInput.focus();
    } else {
      _linkTextInput.focus();
    }
  }

  function hideLinkDialog() {
    if (!_linkDialog) return;
    _linkDialog.classList.add('hidden');
    editor.focus();
  }

  function doInsertLink() {
    var text = _linkTextInput.value.trim();
    var url = _linkUrlInput.value.trim();
    if (!text || !url) return;
    hideLinkDialog();
    onBeforeEdit();

    var sel = window.getSelection();
    var selectedText = sel.toString().trim();
    var linkMd = '[' + text + '](' + url + ')';

    if (selectedText) {
      var range = sel.getRangeAt(0);
      range.deleteContents();
      range.insertNode(document.createTextNode(linkMd));
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
      scheduleRender();
    } else {
      var newContent = _markdown + '\n' + linkMd;
      loadContent(newContent);
      scheduleRender();
    }
  }

  function setupLinkDialog() {
    _linkDialog = document.getElementById('linkDialog');
    var linkBackdrop = document.getElementById('linkBackdrop');
    var linkClose = document.getElementById('linkClose');
    var linkCancel = document.getElementById('linkCancel');
    var linkInsert = document.getElementById('linkInsert');
    _linkTextInput = document.getElementById('linkTextInput');
    _linkUrlInput = document.getElementById('linkUrlInput');

    if (!_linkDialog) return;

    linkBackdrop.addEventListener('click', hideLinkDialog);
    linkClose.addEventListener('click', hideLinkDialog);
    linkCancel.addEventListener('click', hideLinkDialog);
    linkInsert.addEventListener('click', doInsertLink);

    _linkUrlInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); doInsertLink(); }
      if (e.key === 'Escape') { hideLinkDialog(); }
    });
    _linkTextInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); _linkUrlInput.focus(); }
      if (e.key === 'Escape') { hideLinkDialog(); }
    });
  }

  // ===== Image Insertion =====
  function pickAndInsertImage() {
    if (!window.electronAPI || !window.electronAPI.pickAndSaveImage) {
      // Fallback: use a hidden file input
      var input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.onchange = function () {
        var file = input.files[0];
        if (!file) return;
        var reader = new FileReader();
        reader.onload = function (ev) {
          insertImage(ev.target.result);
        };
        reader.readAsDataURL(file);
      };
      input.click();
      return;
    }
    window.electronAPI.pickAndSaveImage().then(function (imgPath) {
      if (imgPath) insertImage(imgPath);
    });
  }

  function setupImageInsert() {
    var imgBtn = document.getElementById('toolbarImageBtn');
    if (!imgBtn) return;
    imgBtn.addEventListener('click', pickAndInsertImage);
  }

  function insertImage(path) {
    onBeforeEdit();
    var imgMd = '\n![](' + path + ')\n';
    var newContent = _markdown + imgMd;
    loadContent(newContent);
  }

  // ===== Formatting =====
  function applyFormat(format) {
    onBeforeEdit();
    var sel = window.getSelection();
    if (!sel.rangeCount || sel.isCollapsed) {
      // No selection: insert markdown syntax at cursor
      var pairs = {
        bold: ['****', 2],
        italic: ['**', 1],
        underline: ['<u></u>', 3],
        strikethrough: ['~~~~', 2],
        code: ['``', 1],
      };
      var p = pairs[format];
      if (p) {
        var range = sel.getRangeAt(0);
        var textNode = document.createTextNode(p[0]);
        range.deleteContents();
        range.insertNode(textNode);
        range.setStart(textNode, p[1]);
        range.setEnd(textNode, p[1]);
        sel.removeAllRanges();
        sel.addRange(range);
        editor.focus();
        scheduleRender();
      }
      return;
    }

    var range = sel.getRangeAt(0);
    var selectedText = sel.toString();
    if (!selectedText) return;

    // Apply markdown wrapping
    var wrapper = {
      bold: ['**', '**'],
      italic: ['*', '*'],
      underline: ['<u>', '</u>'],
      strikethrough: ['~~', '~~'],
      code: ['`', '`'],
    };

    var w = wrapper[format];
    if (!w) return;

    // Use execCommand for immediate visual feedback
    // This inserts the wrapped text and contenteditable preserves it
    var wrapped = w[0] + selectedText + w[1];
    document.execCommand('insertText', false, wrapped);

    // Select the wrapped content
    var newSel = window.getSelection();
    if (newSel.rangeCount) {
      var newRange = newSel.getRangeAt(0);
      // Move cursor back to before the closing wrapper
      var text = newRange.startContainer.textContent || '';
      if (text.endsWith(w[1])) {
        try {
          newRange.setStart(newRange.startContainer, text.length - w[1].length);
          newRange.collapse(true);
          newSel.removeAllRanges();
          newSel.addRange(newRange);
        } catch (_) {}
      }
    }

    editor.focus();
    scheduleRender();
  }

  // ===== Floating Format Toolbar =====
  var _floatHideTimer = null;

  function setupFloatToolbar() {
    if (!floatToolbar) return;

    editor.addEventListener('mouseup', function () {
      clearTimeout(_floatHideTimer);
      showFloatToolbar();
    });

    editor.addEventListener('keyup', function (e) {
      if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Meta') return;
      clearTimeout(_floatHideTimer);
      showFloatToolbar();
    });

    document.addEventListener('mousedown', function (e) {
      if (floatToolbar.contains(e.target) || editor.contains(e.target)) return;
      hideFloatToolbar();
    });

    floatToolbar.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-format]');
      if (!btn) return;
      var format = btn.dataset.format;
      if (format === 'table') {
        hideFloatToolbar();
        var rect = floatToolbar.getBoundingClientRect();
        showTableGridPicker(rect.left, rect.bottom + 4);
        return;
      }
      if (format === 'link') {
        hideFloatToolbar();
        showLinkDialog();
        return;
      }
      applyFormat(format);
      hideFloatToolbar();
    });

    editor.addEventListener('scroll', hideFloatToolbar);
  }

  function showFloatToolbar() {
    var sel = window.getSelection();
    if (!sel.rangeCount || sel.isCollapsed) {
      hideFloatToolbar();
      return;
    }
    var range = sel.getRangeAt(0);
    if (!editor.contains(range.startContainer)) {
      hideFloatToolbar();
      return;
    }

    var rect = range.getBoundingClientRect();
    if (!rect || rect.width === 0) {
      hideFloatToolbar();
      return;
    }

    floatToolbar.classList.remove('hidden');
    var tbw = floatToolbar.offsetWidth || 200;
    var tbh = floatToolbar.offsetHeight || 36;
    var left = rect.left + rect.width / 2 - tbw / 2;
    var top = rect.top - tbh - 8;

    if (top < 50) {
      top = rect.bottom + 8;
    }
    if (left < 8) left = 8;
    if (left + tbw > window.innerWidth - 8) {
      left = window.innerWidth - tbw - 8;
    }

    floatToolbar.style.left = left + 'px';
    floatToolbar.style.top = top + 'px';
  }

  function hideFloatToolbar() {
    if (!floatToolbar) return;
    floatToolbar.classList.add('hidden');
  }

  // ===== Toolbar (File ops & format) =====
  function setupToolbar() {
    document.querySelectorAll('[data-action]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        try {
          switch (btn.dataset.action) {
            case 'new':
              newFile();
              break;
            case 'open':
              statusFile.textContent = 'Opening...';
              if (window.electronAPI) window.electronAPI.requestOpen();
              else statusFile.textContent = 'ERR: electronAPI not available';
              break;
            case 'save':
              if (window.electronAPI) window.electronAPI.saveContent(getSaveMarkdown());
              else statusFile.textContent = 'ERR: electronAPI not available';
              break;
            case 'outline':
              toggleOutline();
              break;
            case 'theme':
              toggleTheme(!state.isDark);
              break;
            case 'focus':
              toggleFocus();
              break;
          }
        } catch (e) {
          statusFile.textContent = 'Error: ' + e.message;
          console.error('Toolbar error:', e);
        }
      });
    });

    // Format buttons in main toolbar (not in float toolbar)
    document.querySelectorAll('.toolbar-left [data-format], .toolbar-right [data-format]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var format = btn.dataset.format;
        if (format === 'table') {
          var rect = btn.getBoundingClientRect();
          showTableGridPicker(rect.left, rect.bottom + 4);
          return;
        }
        applyFormat(format);
      });
    });
  }

  // ===== Welcome Content =====
  function getWelcomeContent() {
    return '# Welcome to Marky\n'
      + '\n'
      + 'A clean, elegant **WYSIWYG** Markdown editor.\n'
      + '\n'
      + '## Features\n'
      + '\n'
      + '- **Bold** and *italic* render as you type — select text and click **B** or *I* in the toolbar\n'
      + '- **Tables** — click the grid icon to insert a visual table, no pipe syntax needed\n'
      + '- **Outline panel** — document headings on the left\n'
      + '- **Syntax highlighting** — in code blocks\n'
      + '- **Light & Dark themes** — ' + (navigator.platform.includes('Mac') ? 'Cmd' : 'Ctrl') + '+Shift+T\n'
      + '- **Export HTML** — File > Export HTML\n'
      + '\n'
      + '```javascript\n'
      + 'function greet(name) {\n'
      + '  return `Hello, ${name}!`;\n'
      + '}\n'
      + 'console.log(greet("Markdown"));\n'
      + '```\n'
      + '\n'
      + '> "Writing is thinking. To write well is to think clearly."\n'
      + '> — David McCullough\n'
      + '\n'
      + 'Just start typing — everything renders in real-time.\n';
  }

  // ===== Editor Events =====
  function setupEditorEvents() {
    // Task list checkbox toggle
    editor.addEventListener('change', function (e) {
      if (e.target.tagName !== 'INPUT' || e.target.type !== 'checkbox') return;
      // Let scheduleRender capture the change
      scheduleRender();
    });

    // Image paste
    editor.addEventListener('paste', function (e) {
      var items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (var i = 0; i < items.length; i++) {
        if (items[i].type.indexOf('image') === 0) {
          e.preventDefault();
          var file = items[i].getAsFile();
          if (!file) return;
          var reader = new FileReader();
          reader.onload = function (ev) {
            var dataUrl = ev.target.result;
            if (window.electronAPI && window.electronAPI.saveImage) {
              window.electronAPI.saveImage(dataUrl).then(function (imgPath) {
                if (imgPath) {
                  insertImage(imgPath);
                } else {
                  insertImage(dataUrl);
                }
              });
            } else {
              insertImage(dataUrl);
            }
          };
          reader.readAsDataURL(file);
          return;
        }
      }
    });

    // Cmd+Click to open links
    editor.addEventListener('click', function (e) {
      var link = e.target.closest('a');
      if (link && link.href && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (window.electronAPI && window.electronAPI.openExternal) {
          window.electronAPI.openExternal(link.href);
        }
        return;
      }
      // Copy code button
      var copyBtn = e.target.closest('.code-copy-btn');
      if (copyBtn) {
        var code = copyBtn.dataset.code;
        if (code) {
          navigator.clipboard.writeText(code).then(function () {
            copyBtn.classList.add('copied');
            copyBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>';
            setTimeout(function () {
              copyBtn.classList.remove('copied');
              copyBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
            }, 2000);
          });
        }
        return;
      }
    });

    // Mouseup in editor → cancel pending re-render so cursor stays where user clicked
    editor.addEventListener('mouseup', function () {
      clearTimeout(_renderTimer);
    });

    // Drag & drop .md files
    editor.addEventListener('drop', function (e) {
      e.preventDefault();
      var files = e.dataTransfer.files;
      if (!files || !files.length) return;
      for (var i = 0; i < files.length; i++) {
        var name = files[i].name.toLowerCase();
        if (name.endsWith('.md') || name.endsWith('.markdown')) {
          if (window.electronAPI && window.electronAPI.openDroppedFile) {
            window.electronAPI.openDroppedFile(files[i].path);
          }
          return;
        }
      }
    });

    // IME composition handling — prevent re-render mid-composition
    editor.addEventListener('compositionstart', function () {
      _isComposing = true;
    });

    editor.addEventListener('compositionend', function () {
      _isComposing = false;
      // Sync the composed text into markdown state
      onBeforeEdit();
      scheduleRender();
    });

    // Main input handler
    editor.addEventListener('input', function () {
      if (_isRendering) { console.log('INPUT: blocked (_isRendering)'); return; }
      if (_isComposing) { console.log('INPUT: blocked (_isComposing)'); return; }
      if (_skipNextInput) { console.log('INPUT: skipped (_skipNextInput)'); _skipNextInput = false; return; }
      console.log('INPUT: processing');
      if (_tryCompleteFence()) { console.log('INPUT: fence completed, early return'); return; }
      onBeforeEdit();
      scheduleRender();
      resetAutoSave();
      console.log('INPUT: render scheduled');
    });

    // Key handlers: history and special keys
    editor.addEventListener('keydown', function (e) {
      var ctrl = e.ctrlKey || e.metaKey;
      var sel = window.getSelection();

      // Tab → indent/outdent list or insert 2 spaces
      if (e.key === 'Tab' && !_isComposing) {
        var container = sel.rangeCount ? sel.getRangeAt(0).startContainer : null;
        if (container) {
          var li = container.nodeType === Node.TEXT_NODE ? container.parentNode : container;
          li = li.closest ? li.closest('li') : null;
          if (li) {
            e.preventDefault();
            onBeforeEdit();
            if (e.shiftKey) {
              outdentListItem(li);
            } else {
              indentListItem(li);
            }
            scheduleRender();
            return;
          }
        }
        // Not in a list: insert 2 spaces
        e.preventDefault();
        if (!sel.rangeCount) return;
        var range = sel.getRangeAt(0);
        var txt = document.createTextNode('  ');
        range.deleteContents();
        range.insertNode(txt);
        range.setStartAfter(txt);
        range.setEndAfter(txt);
        sel.removeAllRanges();
        sel.addRange(range);
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        return;
      }

      // Handle Enter — fully manual DOM, skip re-render to keep cursor in place
      if (e.key === 'Enter' && !ctrl && !_isComposing) {
        e.preventDefault();
        if (!sel.rangeCount) return;

        var container = sel.getRangeAt(0).startContainer;
        var block = findBlockElement(container);

        // Table cell → soft line break
        if (block && (block.tagName === 'TD' || block.tagName === 'TH')) {
          document.execCommand('insertLineBreak');
          scheduleRender();
          return;
        }

        // Cancel any pending re-render so it doesn't move cursor
        clearTimeout(_renderTimer);
        // Suppress the input event that browser fires after our DOM changes
        _skipNextInput = true;
        // Capture history BEFORE modifying DOM
        onBeforeEdit();

        // Capture text position before any DOM changes
        var textOffset = block ? getTextOffsetInBlock(block, container, sel.getRangeAt(0).startOffset) : 0;
        var totalText = block ? block.textContent : '';
        var beforeText = totalText.substring(0, textOffset);
        var afterText = totalText.substring(textOffset);

        if (block && block.tagName === 'LI') {
          var list = block.parentNode;
          // Empty LI → exit list
          if (!totalText.trim()) {
            var newP = document.createElement('p');
            newP.innerHTML = '<br>';
            list.parentNode.insertBefore(newP, list.nextSibling);
            block.remove();
            if (list.querySelectorAll('li').length === 0) list.remove();
            placeCursorAtEnd(newP);
          } else {
            // Split or extend list
            block.textContent = beforeText.trim();
            var newLi = document.createElement('li');
            newLi.textContent = afterText.trim() || '';
            list.insertBefore(newLi, block.nextSibling);
            placeCursorAtEnd(newLi);
          }
        } else if (block && block.tagName === 'PRE') {
          // Code block: insert newline inside <code>, don't split.
          // This keeps cursor in the gray code-block area.
          var codeEl = block.querySelector('code') || block;
          var range = sel.getRangeAt(0);
          range.deleteContents();
          var nl = document.createTextNode('\n');
          range.insertNode(nl);
          range.setStartAfter(nl);
          range.collapse(true);
          sel.removeAllRanges();
          sel.addRange(range);
        } else {
          // Regular block or heading → create new paragraph
          var newBlock = document.createElement('p');
          if (afterText.trim()) {
            newBlock.textContent = afterText.trim();
          } else {
            newBlock.innerHTML = '<br>';
          }
          if (block) {
            // If the block only has non-text children (e.g. <img>), don't
            // clear its content — textContent would be empty and setting
            // it to '\u00a0' would destroy those elements.
            if (block.textContent.trim()) {
              block.textContent = beforeText.trim() || '\u00a0';
            }
            block.parentNode.insertBefore(newBlock, block.nextSibling);
          } else {
            editor.appendChild(newBlock);
          }
          placeCursorAtEnd(newBlock);
        }

        return;
      }

      // Cmd+B for bold
      if (ctrl && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault();
        applyFormat('bold');
        return;
      }

      // Cmd+I for italic
      if (ctrl && (e.key === 'i' || e.key === 'I')) {
        e.preventDefault();
        applyFormat('italic');
        return;
      }

      // Cmd+U for underline
      if (ctrl && (e.key === 'u' || e.key === 'U')) {
        e.preventDefault();
        applyFormat('underline');
        return;
      }

      if (ctrl && e.key === 's') return;
    });
  }

  // ===== Selection Change =====
  function setupSelectionWatcher() {
    document.addEventListener('selectionchange', function () {
      if (_isRendering) return;
      // Update outline based on cursor position
      clearTimeout(_selectionTimer);
      _selectionTimer = setTimeout(function () {
        updateOutline();
      }, 200);
    });
  }
  var _selectionTimer = null;

  // ===== Global Keys =====
  function setupGlobalKeys() {
    document.addEventListener('keydown', function (e) {
      var ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.shiftKey && (e.key === 'T' || e.key === 't')) {
        e.preventDefault();
        toggleTheme(!state.isDark);
        return;
      }
      if (ctrl && e.shiftKey && (e.key === 'O' || e.key === 'o')) {
        e.preventDefault();
        toggleOutline();
        return;
      }
      if (ctrl && e.shiftKey && (e.key === 'F' || e.key === 'f')) {
        e.preventDefault();
        toggleFocus();
        return;
      }
      if (e.key === 'Escape' && state.focusMode) {
        e.preventDefault();
        toggleFocus();
        return;
      }
      // Undo / Redo
      if (ctrl && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      // Search
      if (ctrl && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        toggleSearch();
        return;
      }
      // Shortcut reference
      if (ctrl && e.key === '/') {
        e.preventDefault();
        toggleShortcuts();
        return;
      }
      // Fullscreen
      if (ctrl && e.shiftKey && e.key === '.') {
        e.preventDefault();
        toggleFullScreen();
        return;
      }
      // Typewriter mode
      if (ctrl && e.shiftKey && e.key === 'W') {
        e.preventDefault();
        toggleTypewriter();
        return;
      }
    });
  }

  // ===== Shortcut Reference =====
  function toggleShortcuts() {
    shortcutModal.classList.toggle('hidden');
  }

  // ===== Search & Replace =====
  var searchBar = document.getElementById('searchBar');
  var searchInput = document.getElementById('searchInput');
  var searchCount = document.getElementById('searchCount');
  var searchPrev = document.getElementById('searchPrev');
  var searchNext = document.getElementById('searchNext');
  var searchClose = document.getElementById('searchClose');
  var searchToggleReplace = document.getElementById('searchToggleReplace');
  var searchReplaceRow = document.getElementById('searchReplaceRow');
  var searchReplaceInput = document.getElementById('searchReplaceInput');
  var searchReplaceOne = document.getElementById('searchReplaceOne');
  var searchReplaceAll = document.getElementById('searchReplaceAll');

  var _searchShowing = false;
  var _searchMatches = [];
  var _searchMatchIdx = -1;

  function toggleSearch() {
    _searchShowing = !_searchShowing;
    searchBar.classList.toggle('hidden', !_searchShowing);
    document.body.classList.toggle('search-visible', _searchShowing);
    if (_searchShowing) {
      searchInput.focus();
      searchInput.select();
      doSearch();
    }
  }

  function doSearch() {
    var query = searchInput.value;
    if (!query) {
      _searchMatches = [];
      _searchMatchIdx = -1;
      searchCount.textContent = '';
      clearSearchHighlight();
      return;
    }

    var text = getEditorMarkdown();
    _searchMatches = [];
    var idx = 0;
    var lowerText = text.toLowerCase();
    var lowerQuery = query.toLowerCase();
    while (idx < text.length) {
      var pos = lowerText.indexOf(lowerQuery, idx);
      if (pos === -1) break;
      _searchMatches.push({ start: pos, end: pos + query.length });
      idx = pos + query.length;
    }

    if (_searchMatches.length > 0) {
      _searchMatchIdx = 0;
      searchCount.textContent = '1/' + _searchMatches.length;
      highlightMatch(0);
    } else {
      _searchMatchIdx = -1;
      searchCount.textContent = 'No results';
      clearSearchHighlight();
    }
  }

  function highlightMatch(matchIdx) {
    if (!_searchMatches.length || matchIdx < 0 || matchIdx >= _searchMatches.length) return;
    var m = _searchMatches[matchIdx];
    searchCount.textContent = (matchIdx + 1) + '/' + _searchMatches.length;
    // Scroll to the match by finding text in rendered DOM
    var text = getEditorMarkdown();
    var beforeMatch = text.substring(0, m.start);
    var matchText = text.substring(m.start, m.end);
    var lineBefore = beforeMatch.split('\n').length;

    // Scroll to approximate position
    var blocks = editor.querySelectorAll('h1, h2, h3, h4, h5, h6, p, li, td, th');
    var targetEl = null;
    for (var i = 0; i < blocks.length; i++) {
      if (blocks[i].textContent.indexOf(matchText) >= 0) {
        targetEl = blocks[i];
        break;
      }
    }
    if (targetEl) {
      targetEl.scrollIntoView({ block: 'center' });
      // Highlight the match
      try {
        var range = document.createRange();
        var textNode = targetEl.firstChild || targetEl;
        var pos = textNode.textContent.indexOf(matchText);
        if (pos >= 0) {
          range.setStart(textNode, pos);
          range.setEnd(textNode, pos + matchText.length);
          var sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        }
      } catch (_) {}
    }
  }

  function clearSearchHighlight() {}

  function searchPrevMatch() {
    if (_searchMatches.length === 0) return;
    _searchMatchIdx = (_searchMatchIdx - 1 + _searchMatches.length) % _searchMatches.length;
    highlightMatch(_searchMatchIdx);
  }

  function searchNextMatch() {
    if (_searchMatches.length === 0) return;
    _searchMatchIdx = (_searchMatchIdx + 1) % _searchMatches.length;
    highlightMatch(_searchMatchIdx);
  }

  function setupSearch() {
    searchInput.addEventListener('input', doSearch);

    searchInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) searchPrevMatch();
        else searchNextMatch();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        toggleSearch();
      }
    });

    searchReplaceInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        replaceOne();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        toggleSearch();
      }
    });

    searchPrev.addEventListener('click', searchPrevMatch);
    searchNext.addEventListener('click', searchNextMatch);
    searchClose.addEventListener('click', toggleSearch);

    searchToggleReplace.addEventListener('click', function () {
      searchReplaceRow.classList.toggle('hidden');
    });

    searchReplaceOne.addEventListener('click', replaceOne);
    searchReplaceAll.addEventListener('click', replaceAll);
  }

  function replaceOne() {
    if (_searchMatches.length === 0 || _searchMatchIdx < 0) return;
    var m = _searchMatches[_searchMatchIdx];
    var replaceText = searchReplaceInput.value;
    var text = getEditorMarkdown();
    var newText = text.substring(0, m.start) + replaceText + text.substring(m.end);
    loadContent(newText);
    doSearch();
  }

  function replaceAll() {
    if (_searchMatches.length === 0) return;
    var replaceText = searchReplaceInput.value;
    var text = getEditorMarkdown();
    // Process in reverse to preserve positions
    var sorted = _searchMatches.slice().sort(function (a, b) { return b.start - a.start; });
    for (var i = 0; i < sorted.length; i++) {
      var m = sorted[i];
      text = text.substring(0, m.start) + replaceText + text.substring(m.end);
    }
    loadContent(text);
    doSearch();
  }

  // ===== Other features =====
  function toggleFullScreen() {
    if (window.electronAPI) {
      window.electronAPI.toggleFullscreen();
    }
  }

  var _typewriterMode = false;

  function toggleTypewriter() {
    _typewriterMode = !_typewriterMode;
    document.body.classList.toggle('typewriter-mode', _typewriterMode);
  }

  // ===== File Browser =====
  function setupFileBrowser() {
    // Sidebar tab switching
    document.querySelectorAll('.sidebar-tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        var panel = this.dataset.panel;
        setSidebarPanel(panel);
      });
    });

    // Open Folder button
    var openBtn = document.getElementById('openFolderBtn');
    if (openBtn) {
      openBtn.addEventListener('click', async function () {
        if (window.electronAPI && window.electronAPI.selectFolder) {
          var result = await window.electronAPI.selectFolder();
          if (result) {
            state.currentFolder = result.folderPath;
            state.folderFiles = result.files;
            renderFileList();
            setSidebarPanel('files');
          }
        }
      });
    }
  }

  function setSidebarPanel(panel) {
    document.querySelectorAll('.sidebar-tab').forEach(function (t) {
      t.classList.toggle('active', t.dataset.panel === panel);
    });
    document.getElementById('fileListPanel').classList.toggle('hidden', panel !== 'files');
    document.getElementById('outlinePanel').classList.toggle('hidden', panel !== 'outline');
  }

  function renderFileList() {
    var container = document.getElementById('fileList');
    if (!container) return;
    if (!state.currentFolder) {
      container.innerHTML = '<div class="file-list-empty">Open a folder to browse files</div>';
      return;
    }
    if (!state.folderFiles.length) {
      container.innerHTML = '<div class="file-list-empty">No .md files in this folder</div>';
      return;
    }
    container.innerHTML = state.folderFiles.map(function (f) {
      var activeClass = state.currentFile === f.path ? ' active' : '';
      return '<div class="file-list-item' + activeClass + '" data-path="' + escapeAttr(f.path) + '">'
        + '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0-2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>'
        + '<span>' + escapeHtml(f.name) + '</span></div>';
    }).join('');

    // Click to open file
    container.querySelectorAll('.file-list-item').forEach(function (item) {
      item.addEventListener('click', function () {
        var filePath = this.dataset.path;
        if (window.electronAPI && window.electronAPI.openDroppedFile) {
          window.electronAPI.openDroppedFile(filePath);
        }
      });
    });
  }

  // ===== Init =====
  async function init() {
    ensureMarked();

    if (typeof window.mermaid !== 'undefined') {
      try {
        window.mermaid.initialize({ startOnLoad: false, theme: 'default' });
      } catch (_) {}
    }

    // Ensure browser creates <p> on Enter, not <div>
    try {
      document.execCommand('defaultParagraphSeparator', false, 'p');
    } catch (_) {}

    // Check for recent folder first — if found, open it instead of loading draft/welcome
    var hasRecentFolder = false;
    if (window.electronAPI) {
      try {
        var recentFolder = await window.electronAPI.getRecentFolder();
        if (recentFolder) {
          state.currentFolder = recentFolder.folderPath;
          state.folderFiles = recentFolder.files;
          hasRecentFolder = true;
        }
      } catch (_) {}
    }

    // No recent folder → start with a blank page
    if (!hasRecentFolder) {
      loadContent('');
    }

    // Events
    setupEditorEvents();
    setupSelectionWatcher();
    setupGlobalKeys();
    setupToolbar();
    setupContextMenu();
    setupCodeLangPicker();
    setupSearch();
    setupFloatToolbar();
    setupTableGrid();
    setupTableButton();
    setupTemplates();
    setupMathDialog();
    setupLinkDialog();
    setupImageInsert();
    setupFileBrowser();

    document.addEventListener('click', function (e) {
      if (tableGridPicker && !tableGridPicker.contains(e.target) && !e.target.closest('[data-menu-action]') && !e.target.closest('[data-format]') && !e.target.closest('#toolbarTableBtn')) {
        tableGridPicker.classList.add('hidden');
      }
    });

    outlineBody.addEventListener('click', onOutlineClick);
    if (focusExit) focusExit.addEventListener('click', function () { if (state.focusMode) toggleFocus(); });
    if (shortcutClose) shortcutClose.addEventListener('click', toggleShortcuts);
    if (shortcutBackdrop) shortcutBackdrop.addEventListener('click', toggleShortcuts);
    if (statusWords) statusWords.addEventListener('click', toggleWordCountPopup);

    // IPC
    if (typeof window.electronAPI === 'undefined') {
      statusTheme.textContent = 'ERR: no API';
      console.error('Marky: electronAPI is undefined');
      return;
    }

    window.electronAPI.onMenuNew(newFile);
    window.electronAPI.onMenuSave(function () { window.electronAPI.saveContent(getSaveMarkdown()); });
    window.electronAPI.onMenuSaveAs(function () { window.electronAPI.saveContentAs(getSaveMarkdown()); });
    window.electronAPI.onFileOpened(onFileOpened);
    window.electronAPI.onFileSaved(onFileSaved);
    window.electronAPI.onToggleTheme(function (d) { toggleTheme(d); });
    window.electronAPI.onCycleMode(function () {});
    window.electronAPI.onExportHtml(exportHtml);

    // Render file list if recent folder was found
    if (hasRecentFolder) {
      renderFileList();
      setSidebarPanel('files');
    }

    // Auto-save on window/tab close or when switching to another app
    window.addEventListener('beforeunload', function () {
      saveCurrentDocument();
    });
    window.addEventListener('blur', function () {
      saveCurrentDocument();
    });

    editor.focus();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();

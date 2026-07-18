/* ==============================
   Marky — WYSIWYG Markdown Editor
   ============================== */

(function () {
  'use strict';

  // ===== State =====
  var state = {
    currentFile: null,
    isDark: false,
    fileName: 'untitled.md',
    showOutline: true,
  };

  // ===== DOM =====
  var editor = document.getElementById('editor');
  var statusWords = document.getElementById('statusWords');
  var statusLines = document.getElementById('statusLines');
  var statusChars = document.getElementById('statusChars');
  var statusFile = document.getElementById('statusFile');
  var statusTheme = document.getElementById('statusTheme');
  var fileNameEl = document.getElementById('fileName');
  var outlineBody = document.getElementById('outlineBody');
  var sidebar = document.getElementById('sidebar');

  // ===== Internal =====
  var _renderer = null;
  var _blocks = [];
  var _activeBlockIdx = 0;
  var _isUpdating = false;
  var _selectionTimer = null;
  var _draftTimer = null;

  // ===== Marked Setup =====
  function setupMarked() {
    if (typeof window.marked === 'undefined') return;
    _renderer = new window.marked.Renderer();
    _renderer.code = function (args) {
      var text = args.text || args;
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
      return '<pre><code' + langAttr + '>' + highlighted + '</code></pre>';
    };
    window.marked.use({ renderer: _renderer });
  }

  function ensureMarked() {
    if (!_renderer) setupMarked();
  }

  // ===== Block Splitting =====
  function splitIntoBlocks(text) {
    if (!text.trim() || typeof window.marked === 'undefined') {
      return text.trim() ? [{ type: 'content', raw: text }] : [];
    }
    var tokens = window.marked.lexer(text);
    var result = [];
    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i];
      if (t.type === 'space') {
        result.push({ type: 'space', raw: t.raw });
      } else {
        result.push({ type: 'content', raw: t.raw });
      }
    }
    return result;
  }

  function rawJoin(blocks) {
    var s = '';
    for (var i = 0; i < blocks.length; i++) s += blocks[i].raw;
    return s;
  }

  // ===== Render Blocks =====
  function renderBlocks(blocks, activeIdx) {
    if (!blocks || blocks.length === 0) {
      return '<div class="block-empty">Start writing in Markdown...</div>';
    }
    var html = '';
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i];
      if (b.type === 'space') {
        html += '<div class="block-space" data-idx="' + i + '"><br></div>';
      } else if (i === activeIdx) {
        html += '<div class="block-source" data-idx="' + i + '" contenteditable="true">'
          + escapeHtml(b.raw) + '</div>';
      } else {
        var rendered = window.marked.parse(b.raw);
        if (rendered.trim()) {
          html += '<div class="block-rendered" data-idx="' + i + '">' + rendered + '</div>';
        } else {
          html += '<div class="block-rendered" data-idx="' + i + '">'
            + escapeHtml(b.raw) + '</div>';
        }
      }
    }
    return html;
  }

  // ===== View Update =====
  function updateView() {
    ensureMarked();
    var raw = rawJoin(_blocks);
    _blocks = splitIntoBlocks(raw);

    // Clamp active index
    if (_blocks.length === 0) {
      _activeBlockIdx = -1;
    } else if (_activeBlockIdx >= _blocks.length || _blocks[_activeBlockIdx].type === 'space') {
      _activeBlockIdx = -1;
      for (var i = 0; i < _blocks.length; i++) {
        if (_blocks[i].type === 'content') { _activeBlockIdx = i; break; }
      }
      if (_activeBlockIdx < 0) _activeBlockIdx = 0;
    }

    _isUpdating = true;
    editor.innerHTML = renderBlocks(_blocks, _activeBlockIdx);
    _isUpdating = false;

    // Focus source block
    var src = editor.querySelector('.block-source');
    if (src) {
      src.focus();
      var sel = window.getSelection();
      var range = document.createRange();
      range.selectNodeContents(src);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    }

    updateStatus(raw);
    updateOutline();
  }

  // ===== Set Active Block =====
  function setActiveBlock(idx) {
    var src = editor.querySelector('.block-source');
    if (src && _blocks[_activeBlockIdx]) {
      _blocks[_activeBlockIdx].raw = src.textContent;
    }
    var raw = rawJoin(_blocks);
    _blocks = splitIntoBlocks(raw);
    if (idx >= _blocks.length) idx = _blocks.length - 1;
    if (idx < 0) idx = 0;
    _activeBlockIdx = idx;
    _isUpdating = true;
    editor.innerHTML = renderBlocks(_blocks, _activeBlockIdx);
    _isUpdating = false;
    var src2 = editor.querySelector('.block-source');
    if (src2) {
      src2.focus();
      var sel = window.getSelection();
      var range = document.createRange();
      range.selectNodeContents(src2);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    updateStatus(raw);
    updateOutline();
  }

  // ===== Find block index from DOM =====
  function findBlockIdx(node) {
    if (!node) return -1;
    var el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    var blockEl = el ? el.closest('[data-idx]') : null;
    return blockEl ? parseInt(blockEl.dataset.idx) : -1;
  }

  // ===== Outline =====
  function updateOutline() {
    var text = rawJoin(_blocks);
    if (!text.trim()) {
      outlineBody.innerHTML = '<div class="outline-empty">No headings</div>';
      return;
    }

    // Scan blocks for headings, store direct block index
    var headings = [];
    for (var bi = 0; bi < _blocks.length; bi++) {
      if (_blocks[bi].type === 'content') {
        var firstLine = _blocks[bi].raw.split('\n')[0];
        var m = firstLine.match(/^(#{1,6})\s+(.+)$/);
        if (m) {
          headings.push({
            blockIdx: bi,
            level: m[1].length,
            text: m[2].trim(),
          });
        }
      }
    }

    if (headings.length === 0) {
      outlineBody.innerHTML = '<div class="outline-empty">No headings</div>';
      return;
    }

    // Highlight active heading
    var activeHeadingIdx = -1;
    for (var k = 0; k < headings.length; k++) {
      if (headings[k].blockIdx === _activeBlockIdx) {
        activeHeadingIdx = k;
        break;
      }
    }

    var html = '';
    for (var j = 0; j < headings.length; j++) {
      var cls = 'outline-item' + (j === activeHeadingIdx ? ' active' : '');
      html += '<div class="' + cls + '" data-level="' + headings[j].level
        + '" data-idx="' + headings[j].blockIdx + '">'
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
    var idx = parseInt(item.dataset.idx);
    if (!isNaN(idx) && idx >= 0 && idx < _blocks.length) {
      setActiveBlock(idx);
    }
  }

  function toggleOutline() {
    state.showOutline = !state.showOutline;
    document.body.classList.toggle('outline-hidden', !state.showOutline);
  }

  // ===== Status =====
  function updateStatus(raw) {
    var text = raw || '';
    var trimmed = text.trim();
    var words = trimmed ? trimmed.split(/\s+/).length : 0;
    var lines = text.length ? text.split('\n').length : 0;
    var chars = text.length;
    statusWords.textContent = formatNumber(words) + ' word' + (words !== 1 ? 's' : '');
    statusLines.textContent = formatNumber(lines) + ' line' + (lines !== 1 ? 's' : '');
    statusChars.textContent = formatNumber(chars) + ' char' + (chars !== 1 ? 's' : '');
  }

  function formatNumber(n) {
    return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ===== Theme =====
  function toggleTheme(dark) {
    state.isDark = dark;
    document.body.classList.remove('theme-light', 'theme-dark');
    document.body.classList.add(dark ? 'theme-dark' : 'theme-light');
    statusTheme.textContent = dark ? 'Dark' : 'Light';
  }

  // ===== File Operations =====
  function newFile() {
    if (rawJoin(_blocks).trim() !== '' && !confirm('Clear the current document?')) return;
    _blocks = [];
    _activeBlockIdx = -1;
    _isUpdating = true;
    editor.innerHTML = '<div class="block-empty">Start writing in Markdown...</div>';
    _isUpdating = false;
    updateStatus('');
    outlineBody.innerHTML = '<div class="outline-empty">No headings</div>';
    state.currentFile = null;
    state.fileName = 'untitled.md';
    fileNameEl.textContent = state.fileName;
    statusFile.textContent = state.fileName;
    document.title = state.fileName + ' — Marky';
  }

  function loadContent(text) {
    _blocks = splitIntoBlocks(text);
    _activeBlockIdx = 0;
    for (var i = 0; i < _blocks.length; i++) {
      if (_blocks[i].type === 'content') { _activeBlockIdx = i; break; }
    }
    updateView();
  }

  function onFileOpened(data) {
    loadContent(data.content);
    state.currentFile = data.filePath;
    state.fileName = data.filePath.split('/').pop().split('\\').pop();
    fileNameEl.textContent = state.fileName;
    statusFile.textContent = state.fileName;
    document.title = state.fileName + ' — Marky';
  }

  function onFileSaved(path) {
    state.currentFile = path;
    state.fileName = path.split('/').pop().split('\\').pop();
    fileNameEl.textContent = state.fileName;
    statusFile.textContent = state.fileName;
    document.title = state.fileName + ' — Marky';
  }

  async function exportHtml() {
    ensureMarked();
    var body = window.marked.parse(rawJoin(_blocks));
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

  // ===== Editor Events =====
  function setupEditorEvents() {
    editor.addEventListener('input', function () {
      if (_isUpdating) return;
      var src = editor.querySelector('.block-source');
      if (!src) return;
      var idx = parseInt(src.dataset.idx);
      if (!isNaN(idx) && _blocks[idx]) {
        _blocks[idx].raw = src.textContent;
      }
      var raw = rawJoin(_blocks);
      updateStatus(raw);
      updateOutline();
      clearTimeout(_draftTimer);
      _draftTimer = setTimeout(function () {
        try { localStorage.setItem('marky-draft', raw); } catch (_) {}
      }, 500);
    });

    editor.addEventListener('keydown', function (e) {
      if (e.key === 'Tab') {
        e.preventDefault();
        var sel = window.getSelection();
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
      if ((e.ctrlKey || e.metaKey) && e.key === 's') return;
    });
  }

  // ===== Selection Change =====
  function setupSelectionWatcher() {
    document.addEventListener('selectionchange', function () {
      if (_isUpdating) return;
      clearTimeout(_selectionTimer);
      _selectionTimer = setTimeout(function () {
        var sel = window.getSelection();
        if (!sel.rangeCount) return;
        var idx = findBlockIdx(sel.getRangeAt(0).startContainer);
        if (idx < 0 || idx === _activeBlockIdx) return;
        var src = editor.querySelector('.block-source');
        if (src) {
          var srcIdx = parseInt(src.dataset.idx);
          if (idx === srcIdx) return;
        }
        if (!_blocks[idx] || _blocks[idx].type === 'space') {
          for (var i = idx; i < _blocks.length; i++) {
            if (_blocks[i] && _blocks[i].type === 'content') { idx = i; break; }
          }
          if (idx < 0 || idx === _activeBlockIdx) return;
        }
        if (src && _blocks[_activeBlockIdx]) {
          _blocks[_activeBlockIdx].raw = src.textContent;
        }
        setActiveBlock(idx);
      }, 150);
    });
  }

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
    });
  }

  // ===== Toolbar =====
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
              if (window.electronAPI) window.electronAPI.saveContent(rawJoin(_blocks));
              else statusFile.textContent = 'ERR: electronAPI not available';
              break;
            case 'outline':
              toggleOutline();
              break;
            case 'theme':
              toggleTheme(!state.isDark);
              break;
          }
        } catch (e) {
          statusFile.textContent = 'Error: ' + e.message;
          console.error('Toolbar error:', e);
        }
      });
    });
  }

  // ===== Welcome Content =====
  function getWelcomeContent() {
    return '# Welcome to Marky\n'
      + '\n'
      + 'A clean, elegant Markdown editor inspired by Typora.\n'
      + '\n'
      + '## Features\n'
      + '\n'
      + '- **WYSIWYG** — Markdown renders as you type\n'
      + '- **Focus editing** — Click any block to show its raw markdown\n'
      + '- **Outline panel** — Document headings on the left\n'
      + '- **Syntax highlighting** — In code blocks\n'
      + '- **Light & Dark themes** — Ctrl+Shift+T\n'
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
      + 'Click on any block above to see its raw markdown syntax!\n';
  }

  // ===== Init =====
  function init() {
    ensureMarked();

    try {
      var draft = localStorage.getItem('marky-draft');
      if (draft && draft.trim() !== '') {
        loadContent(draft);
      } else {
        loadContent(getWelcomeContent());
      }
    } catch (_) {
      loadContent(getWelcomeContent());
    }

    // Events
    setupEditorEvents();
    setupSelectionWatcher();
    setupGlobalKeys();
    setupToolbar();
    outlineBody.addEventListener('click', onOutlineClick);

    // IPC
    if (typeof window.electronAPI === 'undefined') {
      statusTheme.textContent = 'ERR: no API';
      console.error('Marky: electronAPI is undefined');
      return;
    }
    window.electronAPI.onMenuNew(newFile);
    window.electronAPI.onMenuSave(function () { window.electronAPI.saveContent(rawJoin(_blocks)); });
    window.electronAPI.onMenuSaveAs(function () { window.electronAPI.saveContentAs(rawJoin(_blocks)); });
    window.electronAPI.onFileOpened(onFileOpened);
    window.electronAPI.onFileSaved(onFileSaved);
    window.electronAPI.onToggleTheme(function (d) { toggleTheme(d); });
    window.electronAPI.onCycleMode(function () {});
    window.electronAPI.onExportHtml(exportHtml);

    editor.focus();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

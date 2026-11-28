const { Plugin, MarkdownRenderChild, Modal, FuzzySuggestModal, Notice, TFile, Keymap, normalizePath } = require('obsidian');
const PIN_TAG = '#대시보드';

const NOTE_STATUS = ['메모용', '시작 전', '진행 중', '완료', '중단'];
const PROJECT_STATUS = ['시작 안 함', '진행 중', '완료', '중단'];
const TODO_STATUS = ['시작 전', '진행 중'];
const DONE_STATUS = ['완료'];
const CLOSED_STATUS = ['완료', '중단'];
const IGNORE_PREFIX = ['_Templates', '.'];

function asList(v) { if (v == null) return []; return Array.isArray(v) ? v : [v]; }
function linkName(v) { const m = String(v).match(/\[\[([^\]|#]+)/); return m ? m[1].trim() : String(v).trim(); }
function str(v) { return v == null ? '' : String(v).trim(); }
function dayDiff(dateStr) {
  const m = window.moment(dateStr, 'YYYY-MM-DD', true);
  if (!m.isValid()) return null;
  return m.startOf('day').diff(window.moment().startOf('day'), 'days');
}
function ddayLabel(d) {
  if (d == null) return '';
  if (d === 0) return 'D-Day';
  return d > 0 ? `D-${d}` : `D+${-d}`;
}
function ago(ms) {
  const d = Math.floor((Date.now() - ms) / 86400000);
  if (d <= 0) return '오늘';
  if (d === 1) return '어제';
  if (d < 30) return `${d}일 전`;
  if (d < 365) return `${Math.floor(d / 30)}개월 전`;
  return `${Math.floor(d / 365)}년 전`;
}
function ts(it) {
  const m = window.moment(it.end || it.created, 'YYYY-MM-DD', true);
  return m.isValid() ? m.valueOf() : 0;
}
function cts(it) {
  const m = window.moment(it.created, 'YYYY-MM-DD', true);
  return m.isValid() ? m.valueOf() : 0;
}
function statusClass(s) {
  return { '진행 중': 'doing', '시작 전': 'todo', '시작 안 함': 'todo', '완료': 'done', '중단': 'stop', '메모용': 'memo' }[s] || 'memo';
}

class NameModal extends Modal {
  constructor(app, title, onSubmit, value, btnText) { super(app); this.titleText = title; this.onSubmit = onSubmit; this.value = value || ''; this.btnText = btnText || '만들기'; }
  onOpen() {
    this.titleEl.setText(this.titleText);
    const input = this.contentEl.createEl('input', { type: 'text', cls: 'pd-modal-input', attr: { placeholder: '이름' } });
    input.value = this.value;
    const btn = this.contentEl.createEl('button', { text: this.btnText, cls: 'mod-cta pd-modal-btn' });
    const go = () => { const v = input.value.trim(); if (!v) return; this.close(); this.onSubmit(v); };
    btn.onclick = go;
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) go(); });
    setTimeout(() => input.focus(), 30);
  }
  onClose() { this.contentEl.empty(); }
}

class DashboardChild extends MarkdownRenderChild {
  constructor(plugin, el, sourcePath) { super(el); this.plugin = plugin; this.sourcePath = sourcePath; }
  onload() {
    this.render();
    let t = null;
    const re = () => { clearTimeout(t); t = setTimeout(() => this.render(), 700); };
    this.registerEvent(this.plugin.app.metadataCache.on('changed', re));
    this.registerEvent(this.plugin.app.vault.on('rename', re));
    this.registerEvent(this.plugin.app.vault.on('delete', re));
    this.register(() => clearTimeout(t));
  }
  async render() {
    try {
      const data = await this.plugin.collect();
      this.plugin.lastData = data; this.plugin._dataAt = Date.now();
      this.containerEl.empty();
      this.plugin.draw(this.containerEl, data, this.sourcePath);
    } catch (e) {
      console.error(e);
      this.containerEl.setText('대시보드 오류: ' + e.message);
    }
  }
}

const TYPE_LABEL = { note: '노트', project: '프로젝트', area: '영역', resource: '리소스', archive: '아카이브' };
const STATUS_BY_TYPE = {
  note: NOTE_STATUS, project: PROJECT_STATUS, area: ['영역', '아카이브'], resource: ['자원'], archive: ['아카이브'],
};

// 고르기 창. opts.kind 가 있으면 영역·프로젝트를 여기서 바로 만들고(＋), 이름 바꾸고(⌘E), 지울 수(⌘⌫) 있다.
class PickModal extends FuzzySuggestModal {
  constructor(app, items, placeholder, onPick, opts) {
    super(app); this.items = items; this.onPick = onPick; this.opts = opts || {}; this.setPlaceholder(placeholder);
    if (this.opts.kind) {
      const label = this.opts.kindLabel;
      this.setInstructions([
        { command: '↵', purpose: '고르기' },
        { command: '입력 후 ↵', purpose: `새 ${label} 만들기` },
        { command: '⌘E', purpose: '이름 바꾸기' },
        { command: '⌘⌫', purpose: '지우기' },
      ]);
      const cur = () => { const c = this.chooser; const v = c && c.values && c.values[c.selectedItem]; return v && v.item && v.item.name && !v.item.create ? v.item : null; };
      this.scope.register(['Mod'], 'e', (e) => { e.preventDefault(); const it = cur(); if (it) { this.close(); this.opts.onRename(it.name); } return false; });
      this.scope.register(['Mod'], 'Backspace', (e) => { e.preventDefault(); const it = cur(); if (it) { this.close(); this.opts.onDelete(it.name); } return false; });
    }
  }
  getItems() {
    const q = (this.inputEl.value || '').trim();
    if (this.opts.kind && q && !this.items.some((i) => i.name === q)) {
      return [{ create: true, name: q, label: `＋ 새 ${this.opts.kindLabel} 「${q}」 만들기` }, ...this.items];
    }
    return this.items;
  }
  getItemText(it) { return it.label; }
  onChooseItem(it) { this.onPick(it); }
}

class PropModal extends Modal {
  constructor(plugin, item) {
    super(plugin.app); this.plugin = plugin; this.item = item;
    const fm = plugin.app.metadataCache.getFileCache(item.file)?.frontmatter || {};
    this.s = {
      type: str(fm.type) || 'note',
      status: str(fm.status),
      area: asList(fm.area).map(linkName).filter(Boolean),
      project: asList(fm.project).map(linkName).filter(Boolean),
      end: str(fm.end),
      start: str(fm.start),
    };
  }
  onOpen() {
    this.modalEl.addClass('pd-prop-modal');
    this.contentEl.addClass('pd-root');
    this.titleEl.setText(`속성 편집 · ${this.item.name}`);
    this.paint();
  }
  paint() {
    const P = this.plugin, s = this.s, c = this.contentEl;
    c.empty();
    const row = (label) => { const r = c.createDiv({ cls: 'pd-prop-row' }); r.createDiv({ text: label, cls: 'pd-prop-label' }); return r.createDiv({ cls: 'pd-prop-value' }); };

    // type
    const tv = row('type');
    const tsel = tv.createEl('select', { cls: 'dropdown' });
    for (const [k, v] of Object.entries(TYPE_LABEL)) { const o = tsel.createEl('option', { text: `${v} (${k})`, value: k }); if (k === s.type) o.selected = true; }
    if (!TYPE_LABEL[s.type]) { const o = tsel.createEl('option', { text: s.type, value: s.type }); o.selected = true; }
    tsel.onchange = () => {
      s.type = tsel.value;
      const opts = STATUS_BY_TYPE[s.type] || [];
      if (!opts.includes(s.status)) s.status = opts[0] || '';
      this.paint();
    };

    // status
    const sv = row('status');
    const opts = [...(STATUS_BY_TYPE[s.type] || [])];
    if (s.status && !opts.includes(s.status)) opts.unshift(s.status);
    const ssel = sv.createEl('select', { cls: 'dropdown pd-select pd-' + statusClass(s.status) });
    for (const o of opts) { const op = ssel.createEl('option', { text: o, value: o }); if (o === s.status) op.selected = true; }
    ssel.onchange = () => { s.status = ssel.value; ssel.className = 'dropdown pd-select pd-' + statusClass(s.status); };

    // link lists
    const linkField = (key, label, open, hint) => {
      const v = row(label);
      const box = v.createDiv({ cls: 'pd-chips' });
      for (const name of s[key]) {
        const chip = box.createSpan({ cls: 'pd-chip pd-chip-edit', text: name });
        const x = chip.createSpan({ text: ' ✕', cls: 'pd-chip-x' });
        x.onclick = () => { s[key] = s[key].filter((n) => n !== name); this.paint(); };
      }
      const add = box.createEl('button', { text: '+ 추가', cls: 'pd-mini' });
      add.onclick = () => open(false);
      if (hint) v.createDiv({ cls: 'pd-muted pd-prop-scope', text: hint });
    };
    const ARCH = (i) => (i.path.startsWith('4. Archive/') ? ' · 아카이브' : '');
    // area: only for notes / projects / resources (or if already set)
    if (['note', 'project', 'resource'].includes(s.type) || s.area.length) {
      linkField('area', 'area', () => {
        const list = P.scopedAreas(s.project).filter(({ i }) => !s.area.includes(i.name))
          .map(({ i, fromProject }) => ({ name: i.name, label: `${i.name}  · ${TYPE_LABEL[i.type]}${fromProject ? ' · 이 프로젝트의 영역' : ''}${ARCH(i)}` }));
        new PickModal(this.app, list, '영역·리소스 검색 (없으면 입력해서 새로 만들기)', async (it) => {
          if (it.create) it = { name: await P.createPara('area', it.name) };
          s.area.push(it.name); this.paint();
        }, { kind: 'area', kindLabel: '영역', onRename: (n) => P.renamePara(n), onDelete: (n) => P.deletePara(n) }).open();
      }, s.project.length ? '고른 프로젝트의 영역이 맨 위에 나와요' : '');
    }
    // project: only for notes (or if already set), narrowed to the chosen area
    if (s.type === 'note' || s.project.length) {
      const openProj = (showAll) => {
        const sc = P.scopedProjects(showAll ? [] : s.area, s.project);
        const list = sc.list.filter((p) => !s.project.includes(p.name))
          .map((p) => ({ name: p.name, label: `${p.name}${p.status ? '  · ' + p.status : ''}${ARCH(p)}` }));
        if (sc.scoped && sc.rest) list.push({ more: true, label: `… 다른 영역 프로젝트도 보기 (${sc.rest}개)` });
        const ph = sc.scoped ? `[${s.area.join(', ')}] 영역의 프로젝트` : '프로젝트 검색 (진행 중 → 대기 → 아카이브 순)';
        new PickModal(this.app, list, ph + ' (없으면 입력해서 새로 만들기)', async (it) => {
          if (it.more) { setTimeout(() => openProj(true), 0); return; }
          if (it.create) it = { name: await P.createPara('project', it.name) };
          s.project.push(it.name);
          if (!s.area.length) s.area = P.areasOfProject(it.name);
          this.paint();
        }, { kind: 'project', kindLabel: '프로젝트', onRename: (n) => P.renamePara(n), onDelete: (n) => P.deletePara(n) }).open();
      };
      linkField('project', 'project', openProj,
        s.area.length ? `[${s.area.join(', ')}] 영역의 프로젝트만 보여요` : 'area를 먼저 고르면 그 영역의 프로젝트만 보여요');
    }

    // end
    const sv2 = row('start (시작일)');
    const si = sv2.createEl('input', { type: 'date', cls: 'pd-date-input' });
    si.value = /^\d{4}-\d{2}-\d{2}$/.test(s.start) ? s.start : '';
    si.onchange = () => { s.start = si.value; };
    const sclr = sv2.createEl('button', { text: '지우기', cls: 'pd-mini' });
    sclr.onclick = () => { s.start = ''; si.value = ''; };

    const ev = row('end (마감일)');
    const di = ev.createEl('input', { type: 'date', cls: 'pd-date-input' });
    di.value = /^\d{4}-\d{2}-\d{2}$/.test(s.end) ? s.end : '';
    di.onchange = () => { s.end = di.value; };
    const clr = ev.createEl('button', { text: '지우기', cls: 'pd-mini' });
    clr.onclick = () => { s.end = ''; di.value = ''; };

    // footer
    const f = c.createDiv({ cls: 'pd-prop-foot' });
    f.createDiv({ cls: 'pd-muted pd-prop-hint', text: '저장하면 PARA Auto Mover가 몇 초 뒤 알맞은 폴더로 옮겨요.' });
    const openBtn = f.createEl('button', { text: '노트 열기' });
    openBtn.onclick = () => { this.close(); P.open(this.item.file); };
    const save = f.createEl('button', { text: '저장', cls: 'mod-cta' });
    save.onclick = async () => { await this.save(); this.close(); };
  }
  async save() {
    const s = this.s;
    await this.app.fileManager.processFrontMatter(this.item.file, (fm) => {
      fm.type = s.type;
      if (s.status) fm.status = s.status; else delete fm.status;
      fm.area = s.area.map((n) => `[[${n}]]`);
      if (s.type === 'note' || s.project.length || fm.project !== undefined) fm.project = s.project.map((n) => `[[${n}]]`);
      if (s.end) fm.end = s.end; else if (fm.end !== undefined) fm.end = null;
      if (s.start) fm.start = s.start; else if (fm.start !== undefined) delete fm.start;
    });
    new Notice(`속성 저장: ${this.item.name}`);
  }
  onClose() { this.contentEl.empty(); }
}

class PeriodModal extends Modal {
  constructor(plugin, item) { super(plugin.app); this.plugin = plugin; this.item = item; }
  onOpen() {
    const ok = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
    this.modalEl.addClass('pd-period-modal');
    this.contentEl.addClass('pd-root');
    this.titleEl.setText(`기간 · ${this.item.name}`);
    const c = this.contentEl;
    const row = (label) => { const r = c.createDiv({ cls: 'pd-prop-row' }); r.createDiv({ text: label, cls: 'pd-prop-label' }); return r.createDiv({ cls: 'pd-prop-value' }); };
    const si = row('시작일').createEl('input', { type: 'date', cls: 'pd-date-input' });
    si.value = ok(this.item.start) ? this.item.start : '';
    const ei = row('마감일').createEl('input', { type: 'date', cls: 'pd-date-input' });
    ei.value = ok(this.item.end) ? this.item.end : '';
    const quick = row('빠른 선택');
    const m = () => window.moment();
    const setEnd = (d) => { if (!si.value) si.value = m().format('YYYY-MM-DD'); ei.value = d.format('YYYY-MM-DD'); };
    for (const [label, fn] of [['오늘', () => setEnd(m())], ['내일', () => setEnd(m().add(1, 'd'))], ['이번 주', () => setEnd(m().endOf('isoWeek'))], ['1주 뒤', () => setEnd(m().add(7, 'd'))], ['이번 달', () => setEnd(m().endOf('month'))]]) {
      const b = quick.createEl('button', { text: label, cls: 'pd-mini' }); b.onclick = fn;
    }
    const warn = c.createDiv({ cls: 'pd-muted pd-prop-hint pd-period-warn' });
    const foot = c.createDiv({ cls: 'pd-prop-foot' });
    const clr = foot.createEl('button', { text: '기간 지우기' });
    clr.onclick = () => { si.value = ''; ei.value = ''; };
    const save = foot.createEl('button', { text: '저장', cls: 'mod-cta' });
    save.onclick = async () => {
      if (si.value && ei.value && si.value > ei.value) { warn.setText('시작일이 마감일보다 늦어요.'); return; }
      await this.app.fileManager.processFrontMatter(this.item.file, (fm) => {
        if (si.value) fm.start = si.value; else delete fm.start;
        if (ei.value) fm.end = ei.value; else if (fm.end !== undefined) fm.end = null;
      });
      new Notice(`기간 저장: ${this.item.name}`);
      this.close();
    };
  }
  onClose() { this.contentEl.empty(); }
}

class ListModal extends Modal {
  constructor(plugin, title, groups) { super(plugin.app); this.plugin = plugin; this.titleText = title; this.groups = groups; }
  onOpen() {
    const P = this.plugin;
    this.modalEl.addClass('pd-list-modal');
    const total = this.groups.reduce((s, g) => s + g.rows.length, 0);
    this.titleEl.setText(`${this.titleText} · ${total}`);
    this.contentEl.addClass('pd-root');
    const input = this.contentEl.createEl('input', { type: 'search', cls: 'pd-search pd-modal-search', attr: { placeholder: '🔍 목록에서 검색' } });
    const body = this.contentEl.createDiv({ cls: 'pd-modal-body' });
    const openFile = (file, e) => { this.close(); P.open(file, e); };
    const paint = () => {
      body.empty();
      const q = input.value.trim().toLowerCase();
      let shown = 0;
      for (const g of this.groups) {
        const rows = g.rows.filter((r) => {
          if (!q) return true;
          const it = r.item || r.task.item;
          const txt = [r.task ? r.task.text : '', it.name, ...(it.projects || []).map((x) => x.name), ...(it.areas || []).map((x) => x.name)].join(' ').toLowerCase();
          return txt.includes(q);
        });
        if (!rows.length && q) continue;
        const gh = body.createDiv({ cls: 'pd-modal-group' });
        if (g.file) {
          const a = gh.createEl('a', { text: g.title, cls: 'pd-link', href: '#' });
          a.addEventListener('click', (e) => { e.preventDefault(); openFile(g.file.file, e); });
        } else gh.createSpan({ text: g.title });
        gh.createSpan({ text: String(rows.length), cls: 'pd-count' });
        if (!rows.length) { body.createDiv({ text: '없음', cls: 'pd-empty' }); continue; }
        for (const r of rows) {
          shown++;
          const row = body.createDiv({ cls: 'pd-list-row' });
          if (r.task) {
            const lab = row.createEl('label', { cls: 'pd-check' });
            const cb = lab.createEl('input', { type: 'checkbox' });
            lab.createSpan({ text: r.task.text });
            cb.addEventListener('change', async () => { lab.addClass('pd-checked'); await P.toggleTask(r.task); });
            continue;
          }
          const it = r.item;
          const a = row.createEl('a', { text: it.name, cls: 'pd-link', href: '#' });
          a.addEventListener('click', (e) => { e.preventDefault(); openFile(it.file, e); });
          const ctx = (it.projects || [])[0] || (it.areas || [])[0];
          if (ctx) row.createSpan({ text: ctx.name, cls: 'pd-chip' });
          const right = row.createDiv({ cls: 'pd-row-right' });
          if (r.meta) { right.createSpan({ text: r.meta, cls: 'pd-muted' }); if (it.lastInput) right.createSpan({ text: ago(it.lastInput), cls: 'pd-muted' }); P.editBtn(right, it); continue; }
          if (it.end && !CLOSED_STATUS.includes(it.status)) P.dday(right, it.end);
          if (it.type === 'note' || it.type === 'project') P.statusSelect(right, it, it.type === 'project' ? PROJECT_STATUS : NOTE_STATUS);
          P.editBtn(right, it);
        }
      }
      if (q && !shown) body.createDiv({ text: '검색 결과 없음', cls: 'pd-empty' });
    };
    input.addEventListener('input', paint);
    paint();
  }
  onClose() { this.contentEl.empty(); }
}

module.exports = class ParaDashboard extends Plugin {
  async onload() {
    this.registerMarkdownCodeBlockProcessor('para-dashboard', (src, el, ctx) => {
      el.addClass('pd-root');
      ctx.addChild(new DashboardChild(this, el, ctx.sourcePath));
    });
    this.addCommand({ id: 'open-dashboard', name: '대시보드 열기', callback: () => this.app.workspace.openLinkText('PARA 대시보드', '', false) });
    this.addCommand({ id: 'new-note', name: '새 노트 만들기', callback: () => this.newItem('note') });
    this.addCommand({ id: 'new-project', name: '새 프로젝트 만들기', callback: () => this.newItem('project') });
    this.addCommand({ id: 'new-area', name: '새 영역 만들기', callback: () => this.newItem('area') });
    this.addCommand({
      id: 'edit-props', name: '이 노트 PARA 속성 편집',
      checkCallback: (checking) => {
        const f = this.app.workspace.getActiveFile();
        if (!f || f.extension !== 'md') return false;
        if (!checking) this.editProps(f);
        return true;
      },
    });
    this.setupNoteBar();
    this.registerEvent(this.app.workspace.on('file-menu', (menu, f) => {
      if (!(f instanceof TFile) || f.extension !== 'md') return;
      menu.addItem((mi) => mi.setTitle('PARA 속성 편집').setIcon('pencil').onClick(() => this.editProps(f)));
    }));
  }
  async ensureData(force) {
    if (force || !this.lastData || Date.now() - (this._dataAt || 0) > 5000) {
      this.lastData = await this.collect(); this._dataAt = Date.now();
    }
    return this.lastData;
  }
  // ---------- PARA bar on top of each note ----------
  setupNoteBar() {
    const refresh = () => { clearTimeout(this._barT); this._barT = setTimeout(() => this.refreshBars(), 150); };
    this.registerEvent(this.app.workspace.on('layout-change', refresh));
    this.registerEvent(this.app.workspace.on('file-open', refresh));
    this.registerEvent(this.app.metadataCache.on('changed', refresh));
    this.registerEvent(this.app.vault.on('rename', refresh));
    this.app.workspace.onLayoutReady(refresh);
    this.register(() => {
      document.querySelectorAll('.pd-notebar').forEach((e) => e.remove());
      document.querySelectorAll('.pd-has-bar').forEach((e) => e.removeClass('pd-has-bar'));
    });
  }
  refreshBars() {
    this.app.workspace.iterateAllLeaves((leaf) => {
      const v = leaf.view;
      if (v && v.getViewType && v.getViewType() === 'markdown') this.renderBar(v);
    });
  }
  renderBar(view) {
    const f = view.file;
    let bar = view.contentEl.querySelector(':scope > .pd-notebar');
    const fm = f ? this.app.metadataCache.getFileCache(f)?.frontmatter : null;
    const type = fm ? str(fm.type) : '';
    const on = !!f && !!TYPE_LABEL[type] && !IGNORE_PREFIX.some((p) => f.path.startsWith(p));
    view.containerEl.toggleClass('pd-has-bar', on);
    if (!on) { if (bar) bar.remove(); return; }
    if (!bar) { bar = createDiv({ cls: 'pd-notebar pd-root' }); view.contentEl.prepend(bar); }
    bar.empty();
    const names = (v) => asList(v).map(linkName).filter(Boolean).map((name) => ({ name }));
    const it = { file: f, name: f.basename, path: f.path, type, status: str(fm.status), start: str(fm.start), end: str(fm.end), areas: names(fm.area), projects: names(fm.project) };
    bar.createSpan({ cls: 'pd-notebar-label', text: TYPE_LABEL[type] });
    const lc = bar.createDiv({ cls: 'pd-link-chips' });
    if (['note', 'project', 'resource'].includes(type) || it.areas.length) this.linkChip(lc, it, 'area');
    if (type === 'note') this.linkChip(lc, it, 'project');
    if (type === 'note' || type === 'project') this.periodChip(lc, it);
    const r = bar.createDiv({ cls: 'pd-row-right' });
    const opts = STATUS_BY_TYPE[type] || [];
    if (opts.length > 1 || (it.status && !opts.includes(it.status))) this.statusSelect(r, it, opts);
    else if (it.status || opts[0]) this.pill(r, it.status || opts[0]);
    this.editBtn(r, it);
  }
  async editProps(file) {
    await this.ensureData(true);
    new PropModal(this, { file, name: file.basename }).open();
  }

  // ---------- data ----------
  async collect() {
    const app = this.app;
    const files = app.vault.getMarkdownFiles().filter((f) => !IGNORE_PREFIX.some((p) => f.path.startsWith(p)));
    const items = [];
    const byPath = {};
    for (const f of files) {
      const cache = app.metadataCache.getFileCache(f) || {};
      const fm = cache.frontmatter || {};
      const it = {
        file: f, name: f.basename, path: f.path,
        type: str(fm.type), status: str(fm.status),
        end: str(fm.end), start: str(fm.start), created: str(fm.created), mtime: f.stat.mtime,
        pinned: fm.dashboard === true || fm.dashboard === 'true',
        projects: [], areas: [], openTasks: [], doneTasks: 0, totalTasks: 0,
        rawProject: asList(fm.project).map(linkName).filter(Boolean),
        rawArea: asList(fm.area).map(linkName).filter(Boolean),
        cache,
      };
      for (const li of cache.listItems || []) {
        if (li.task == null) continue;
        it.totalTasks++;
        if (li.task === ' ') it.openTasks.push(li); else it.doneTasks++;
      }
      items.push(it); byPath[f.path] = it;
    }
    const resolve = (name, from) => {
      const d = app.metadataCache.getFirstLinkpathDest(name, from.path);
      return d ? byPath[d.path] : null;
    };
    for (const it of items) {
      it.projects = it.rawProject.map((n) => resolve(n, it.file)).filter(Boolean);
      it.areas = it.rawArea.map((n) => resolve(n, it.file)).filter(Boolean);
    }
    // open task text
    const taskFiles = items.filter((i) => i.openTasks.length);
    for (const it of taskFiles) {
      const lines = (await app.vault.cachedRead(it.file)).split('\n');
      it.openTasks = it.openTasks.map((li) => {
        const line = li.position.start.line;
        const text = (lines[line] || '').replace(/^\s*[-*+]\s*\[.\]\s*/, '').replace(/<br\s*\/?>/gi, ' ').replace(/\[\[([^\]|]+\|)?([^\]]+)\]\]/g, '$2').replace(/(\*\*|__|\*|~~|==)/g, '').trim();
        const tagged = text.includes(PIN_TAG);
        return { line, text: text.split(PIN_TAG).join('').replace(/\s+/g, ' ').trim(), tagged, item: it };
      }).filter((t) => t.text);
    }

    const projects = items.filter((i) => i.type === 'project');
    const notes = items.filter((i) => i.type === 'note');
    const areas = items.filter((i) => i.type === 'area');
    for (const p of projects) {
      p.notes = notes.filter((n) => n.projects.includes(p));
      const tracked = p.notes.filter((n) => n.status && n.status !== '메모용');
      const doneNotes = tracked.filter((n) => DONE_STATUS.includes(n.status)).length;
      const allTasks = p.totalTasks + p.notes.reduce((s, n) => s + n.totalTasks, 0);
      const doneTasks = p.doneTasks + p.notes.reduce((s, n) => s + n.doneTasks, 0);
      const total = tracked.length + allTasks;
      p.progressTotal = total;
      p.progressDone = doneNotes + doneTasks;
      p.progress = total ? Math.round((p.progressDone / total) * 100) : null;
      p.lastTouch = Math.max(cts(p), ...p.notes.map((n) => cts(n)));
      p.nextTodo = p.notes.filter((n) => TODO_STATUS.includes(n.status))
        .sort((a, b) => (a.end || '9999').localeCompare(b.end || '9999'))[0] || null;
      p.openTaskCount = p.openTasks.length + p.notes.reduce((s, n) => s + n.openTasks.length, 0);
    }
    for (const a of areas) {
      a.activeProjects = projects.filter((p) => p.areas.includes(a) && !CLOSED_STATUS.includes(p.status));
    }
    // 리소스·아카이브: 링크로 연결됐거나 같은 폴더 안에 있는 노트 수
    const folderOf = (it) => { const i = it.path.lastIndexOf('/'); return i < 0 ? '' : it.path.slice(0, i); };
    const linkedNotes = (x) => {
      const dir = folderOf(x);
      const own = dir.split('/').pop() === x.name;
      return items.filter((n) => n !== x && (n.type === 'note' || n.type === 'subpage') &&
        (n.areas.includes(x) || n.projects.includes(x) || (own && n.path.startsWith(dir + '/'))));
    };
    const fill = (x) => {
      const ln = linkedNotes(x);
      x.noteCount = ln.length;
      // 최근 입력: 자신 또는 연결된 노트 중 가장 최근 created
      x.lastInput = Math.max(cts(x), ...ln.map((n) => cts(n)), 0);
    };
    const resources = items.filter((i) => i.type === 'resource' && !i.path.startsWith('4. Archive/'));
    const archives = items.filter((i) => i.path.startsWith('4. Archive/') && ['project', 'area', 'resource', 'archive'].includes(i.type));
    for (const x of [...areas, ...resources, ...archives]) fill(x);
    const activeAreas = areas.filter((a) => !a.path.startsWith('4. Archive/'));
    const todos = notes.filter((n) => TODO_STATUS.includes(n.status));
    const dated = items.filter((i) => (i.type === 'note' || i.type === 'project') && i.end && !CLOSED_STATUS.includes(i.status) && i.status !== '메모용')
      .map((i) => ({ i, d: dayDiff(i.end) })).filter((x) => x.d != null);
    const inbox = items.filter((i) => i.path.startsWith('0. Inbox/'));
    const recent = items.filter((i) => i.type === 'note' || i.type === 'project')
      .sort((a, b) => cts(b) - cts(a)).slice(0, 8);
    const openTasks = taskFiles.flatMap((i) => i.openTasks);
    const pinnedTasks = openTasks.filter((tk) => tk.item.pinned || tk.tagged);
    const pinnedFiles = items.filter((i) => i.pinned);
    return { activeAreas, resources, archives, items, projects, notes, areas, todos, dated, inbox, recent, openTasks, pinnedTasks, pinnedFiles, taskFiles };
  }

  // ---------- actions ----------
  open(file, evt) {
    const newLeaf = evt ? Keymap.isModEvent(evt) : false;
    this.app.workspace.getLeaf(newLeaf).openFile(file);
  }
  async setStatus(file, status) {
    await this.app.fileManager.processFrontMatter(file, (fm) => { fm.status = status; });
    new Notice(`${file.basename} → ${status}`);
  }

  // ---------- drag & drop ----------
  draggable(el, it) {
    el.setAttr('draggable', 'true');
    el.addClass('pd-draggable');
    el.addEventListener('dragstart', (e) => {
      this._drag = it;
      e.dataTransfer.effectAllowed = 'copyMove';
      e.dataTransfer.setData('text/plain', `[[${it.name}]]`);
      el.addClass('pd-dragging');
      document.body.addClass('pd-drag-on');
    });
    el.addEventListener('dragend', () => {
      this._drag = null;
      el.removeClass('pd-dragging');
      document.body.removeClass('pd-drag-on');
      document.querySelectorAll('.pd-drop-ok').forEach((x) => x.removeClass('pd-drop-ok'));
    });
  }
  dropZone(el, accept, onDrop) {
    el.addClass('pd-dropzone');
    let depth = 0;
    const ok = () => this._drag && accept(this._drag);
    el.addEventListener('dragenter', (e) => { if (!ok()) return; e.preventDefault(); depth++; el.addClass('pd-drop-ok'); });
    el.addEventListener('dragover', (e) => { if (!ok()) return; e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move'; });
    el.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; el.removeClass('pd-drop-ok'); } });
    el.addEventListener('drop', async (e) => {
      depth = 0; el.removeClass('pd-drop-ok');
      const it = this._drag;
      if (!it || !accept(it)) return;
      e.preventDefault(); e.stopPropagation();
      this._drag = null;
      await onDrop(it);
    });
  }
  // ---------- PARA 칸 사이 옮기기 (영역 ↔ 리소스 ↔ 아카이브, 프로젝트 ↔ 아카이브) ----------
  paraCat(it) {
    if (it.path.startsWith('4. Archive/') || it.type === 'archive') return 'archive';
    return ['project', 'area', 'resource'].includes(it.type) ? it.type : null;
  }
  sectionDrop(el, target) {
    this.dropZone(el, (x) => { const c = this.paraCat(x); return !!c && c !== target; }, (x) => this.moveCategory(x, target));
  }
  moveCategory(it, target) {
    const NAME = { project: '진행 중 프로젝트', area: '영역', resource: '리소스', archive: '아카이브' };
    const from = NAME[this.paraCat(it)] || '';
    let choices;
    if (target === 'archive' && it.type === 'project') {
      choices = [{ patch: { status: '완료' }, label: `✓ 완료로 보관 — ${it.name}` }, { patch: { status: '중단' }, label: `⏸ 중단으로 보관 — ${it.name}` }];
    } else {
      const patch = target === 'project' ? { type: 'project', status: '진행 중' }
        : target === 'area' ? { type: 'area', status: '영역' }
        : target === 'resource' ? { type: 'resource', status: '자원' }
        : it.type === 'area' ? { status: '아카이브' } : { type: 'archive', status: '아카이브' };
      choices = [{ patch, label: `→ ${it.name}: ${from} → ${NAME[target]}로 옮기기` }];
    }
    choices.push({ cancel: true, label: '취소' });
    new PickModal(this.app, choices, `${it.name} — ${NAME[target]}로 옮길까요?`, async (c) => {
      if (c.cancel) return;
      await this.app.fileManager.processFrontMatter(it.file, (fm) => Object.assign(fm, c.patch));
      new Notice(`${it.name} → ${NAME[target]} (몇 초 뒤 폴더도 옮겨져요)`);
    }).open();
  }
  // put `name` first in it's area/project (no toggle); project → fills empty area
  async assignLink(it, key, name) {
    let autoArea = [], already = false;
    await this.app.fileManager.processFrontMatter(it.file, (fm) => {
      const now = asList(fm[key]).map(linkName).filter(Boolean);
      already = now[0] === name;
      fm[key] = [name, ...now.filter((n) => n !== name)].map((n) => `[[${n}]]`);
      if (key === 'project' && !asList(fm.area).map(linkName).filter(Boolean).length) {
        autoArea = this.areasOfProject(name);
        if (autoArea.length) fm.area = autoArea.map((n) => `[[${n}]]`);
      }
    });
    if (!already) new Notice(`${it.name} → ${name}${autoArea.length ? ` (영역: ${autoArea.join(', ')})` : ''}`);
  }
  async toggleTask(task) {
    await this.app.vault.process(task.item.file, (data) => {
      const lines = data.split('\n');
      const l = lines[task.line];
      if (l != null && /\[ \]/.test(l)) lines[task.line] = l.replace('[ ]', '[x]');
      return lines.join('\n');
    });
  }
  // ---------- 영역·프로젝트 관리 (고르기 창에서) ----------
  async createPara(kind, name) {
    const safe = name.replace(/[\\/:*?"<>|#^[\]]/g, ' ').trim();
    const folder = normalizePath(`${kind === 'project' ? '1. Projects' : '2. Areas'}/${safe}`);
    const path = normalizePath(`${folder}/${safe}.md`);
    if (this.app.vault.getAbstractFileByPath(path)) return safe;
    const tpl = this.app.vault.getAbstractFileByPath(kind === 'project' ? '_Templates/프로젝트.md' : '_Templates/영역.md');
    let body = tpl instanceof TFile ? await this.app.vault.read(tpl) : `---\ntype: ${kind}\nstatus: ${kind === 'project' ? '시작 안 함' : '영역'}\ncreated: {{date}}\n---\n`;
    body = body.replace(/\{\{date(:[^}]*)?\}\}/g, (m, f) => window.moment().format(f ? f.slice(1) : 'YYYY-MM-DD')).replace(/\{\{title\}\}/g, safe);
    if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
    await this.app.vault.create(path, body);
    new Notice(`새 ${kind === 'project' ? '프로젝트' : '영역'}: ${safe}`);
    return safe;
  }
  findPara(name) {
    const f = this.app.metadataCache.getFirstLinkpathDest(name, '');
    return f instanceof TFile ? f : null;
  }
  renamePara(name, after) {
    const f = this.findPara(name);
    if (!f) { new Notice(`'${name}' 노트를 찾지 못했어요`); return; }
    new NameModal(this.app, `'${name}' 이름 바꾸기`, async (v) => {
      const safe = v.replace(/[\\/:*?"<>|#^[\]]/g, ' ').trim();
      if (!safe || safe === name) return;
      // 폴더 이름이 같으면(1. Projects/이름/이름.md) 폴더도 함께 — 옵시디언이 링크를 모두 고친다
      const parent = f.parent;
      await this.app.fileManager.renameFile(f, normalizePath(`${parent.path}/${safe}.md`));
      if (parent && parent.name === name) await this.app.fileManager.renameFile(parent, normalizePath(`${parent.parent ? parent.parent.path + '/' : ''}${safe}`));
      new Notice(`이름 바꿈: ${name} → ${safe}`);
      if (after) setTimeout(after, 300);
    }, name, '바꾸기').open();
  }
  async deletePara(name, after) {
    const f = this.findPara(name);
    if (!f) { new Notice(`'${name}' 노트를 찾지 못했어요`); return; }
    const linked = (this.app.metadataCache.resolvedLinks ? Object.values(this.app.metadataCache.resolvedLinks).filter((m) => m[f.path]).length : 0);
    if (!window.confirm(`'${name}'을(를) 지울까요?\n이 노트에 연결된 노트 ${linked}개는 그대로 남고, 지운 노트는 옵시디언 휴지통(.trash)에서 되살릴 수 있어요.`)) return;
    await this.app.vault.trash(f, false);
    new Notice(`지움: ${name} (휴지통)`);
    if (after) setTimeout(after, 300);
  }

  newItem(kind, status) {
    const LABEL = { note: '새 노트', project: '새 프로젝트', area: '새 영역' };
    new NameModal(this.app, (LABEL[kind] || '새 노트') + (status ? ` · ${status}` : ''), async (name) => {
      const safe = name.replace(/[\\/:*?"<>|#^[\]]/g, ' ').trim();
      const tplPath = { project: '_Templates/프로젝트.md', area: '_Templates/영역.md' }[kind] || '_Templates/노트.md';
      const tpl = this.app.vault.getAbstractFileByPath(tplPath);
      let body = tpl instanceof TFile ? await this.app.vault.read(tpl) : '';
      const today = window.moment().format('YYYY-MM-DD');
      body = body.replace(/\{\{date(:[^}]*)?\}\}/g, (m, f) => window.moment().format(f ? f.slice(1) : 'YYYY-MM-DD'))
        .replace(/\{\{title\}\}/g, safe).replace(/\{\{time\}\}/g, window.moment().format('HH:mm'));
      if (!body) body = `---\ntype: ${kind}\ncreated: ${today}\n---\n`;
      let folder = kind === 'project' ? `1. Projects/${safe}` : kind === 'area' ? `2. Areas/${safe}` : '0. Inbox';
      const path = normalizePath(`${folder}/${safe}.md`);
      if (this.app.vault.getAbstractFileByPath(path)) { new Notice('같은 이름이 이미 있어요: ' + path); return; }
      if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
      const f = await this.app.vault.create(path, body);
      if (status) await this.app.fileManager.processFrontMatter(f, (fm) => { fm.status = status; });
      await this.app.workspace.getLeaf(false).openFile(f);
      if (kind !== 'area') setTimeout(async () => { await this.ensureData(true); new PropModal(this, { file: f, name: f.basename }).open(); }, 300);
    }).open();
  }

  // ---------- view helpers ----------
  link(parent, it, cls) {
    const a = parent.createEl('a', { text: it.name, cls: 'pd-link ' + (cls || ''), href: '#' });
    a.addEventListener('click', (e) => { e.preventDefault(); this.open(it.file, e); });
    a.addEventListener('mouseover', (e) => this.app.workspace.trigger('hover-link', {
      event: e, source: 'preview', hoverParent: parent, targetEl: a, linktext: it.path,
    }));
    return a;
  }
  pill(parent, s) { return parent.createSpan({ text: s || '상태 없음', cls: 'pd-pill pd-' + statusClass(s) }); }
  statusSelect(parent, it, options) {
    const sel = parent.createEl('select', { cls: 'pd-select pd-' + statusClass(it.status) });
    const opts = options.includes(it.status) || !it.status ? options : [it.status, ...options];
    for (const o of opts) { const op = sel.createEl('option', { text: o, value: o }); if (o === it.status) op.selected = true; }
    sel.addEventListener('click', (e) => e.stopPropagation());
    sel.addEventListener('change', () => this.setStatus(it.file, sel.value));
    return sel;
  }
  dday(parent, end) {
    const d = dayDiff(end);
    if (d == null) return;
    parent.createSpan({ text: ddayLabel(d), cls: 'pd-dday ' + (d < 0 ? 'over' : d <= 3 ? 'soon' : '') });
  }
  section(parent, title, count, cls) {
    const s = parent.createDiv({ cls: 'pd-section ' + (cls || '') });
    const h = s.createDiv({ cls: 'pd-section-head' });
    h.createSpan({ text: title, cls: 'pd-section-title' });
    if (count != null) h.createSpan({ text: String(count), cls: 'pd-count' });
    return s.createDiv({ cls: 'pd-section-body' });
  }
  empty(parent, text) { parent.createDiv({ text, cls: 'pd-empty' }); }
  // 카드 위에서 기간(시작일~마감일) 바로 지정
  periodChip(parent, it) {
    const ok = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
    const f = (d) => window.moment(d, 'YYYY-MM-DD').format('M/D');
    let text = '+ 기간';
    if (ok(it.start) && ok(it.end)) text = `${f(it.start)}~${f(it.end)}`;
    else if (ok(it.end)) text = `~${f(it.end)}`;
    else if (ok(it.start)) text = `${f(it.start)}~`;
    const empty = !ok(it.start) && !ok(it.end);
    const b = parent.createEl('button', { text, cls: 'pd-link-chip pd-link-chip-period' + (empty ? ' is-empty' : ''), attr: { 'aria-label': '기간 지정 (시작일~마감일)' } });
    b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); new PeriodModal(this, it).open(); });
    return b;
  }
  // 카드 위에서 area / project 바로 지정
  linkChip(parent, it, key) {
    const cur = key === 'area' ? it.areas : it.projects;
    const label = key === 'area' ? '영역' : '프로젝트';
    const b = parent.createEl('button', {
      cls: 'pd-link-chip pd-link-chip-' + key + (cur.length ? '' : ' is-empty'),
      text: cur.length ? cur[0].name + (cur.length > 1 ? ` +${cur.length - 1}` : '') : `+ ${label}`,
      attr: { 'aria-label': `${label} 지정${cur.length ? ': ' + cur.map((x) => x.name).join(', ') : ''}` },
    });
    b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); this.pickLink(it, key); });
    return b;
  }
  // ---------- scoped choices (area → its projects, project → its areas) ----------
  projRank(p) { return p.path.startsWith('4. Archive/') ? 3 : p.status === '진행 중' ? 0 : ['시작 안 함', '시작 전', ''].includes(p.status) ? 1 : 2; }
  scopedProjects(areaNames, keep = []) {
    const D = this.lastData;
    const all = [...(D ? D.projects : [])].sort((a, b) => this.projRank(a) - this.projRank(b) || a.name.localeCompare(b.name));
    if (!areaNames.length) return { list: all, rest: 0, scoped: false };
    const list = all.filter((p) => keep.includes(p.name) || p.areas.some((a) => areaNames.includes(a.name)));
    return { list, rest: all.length - list.length, scoped: true };
  }
  scopedAreas(projectNames) {
    const D = this.lastData;
    if (!D) return [];
    const fromProj = new Set();
    for (const p of D.projects) if (projectNames.includes(p.name)) p.areas.forEach((a) => fromProj.add(a.name));
    const live = (i) => !i.path.startsWith('4. Archive/');
    return D.items.filter((i) => i.type === 'area' || i.type === 'resource')
      .map((i) => ({ i, fromProject: fromProj.has(i.name) }))
      .sort((a, b) => b.fromProject - a.fromProject || live(b.i) - live(a.i)
        || (a.i.type === b.i.type ? a.i.name.localeCompare(b.i.name) : a.i.type === 'area' ? -1 : 1));
  }
  areasOfProject(name) {
    const p = (this.lastData ? this.lastData.projects : []).find((x) => x.name === name);
    return p ? p.areas.map((a) => a.name) : [];
  }
  async pickLink(it, key, showAll = false) {
    const D = await this.ensureData();
    if (!D) return;
    const label = key === 'area' ? '영역·리소스' : '프로젝트';
    const curNames = (key === 'area' ? it.areas : it.projects).map((x) => x.name);
    const KIND = { area: '영역', resource: '리소스', project: '프로젝트' };
    const ARCH = (c) => (c.path.startsWith('4. Archive/') ? ' · 아카이브' : '');
    const items = [];
    if (curNames.length > 1) items.push({ clear: true, label: `✕ ${label} 모두 비우기 (지금: ${curNames.join(', ')})` });
    else if (curNames.length) items.push({ clear: true, label: `✕ ${label} 비우기 (지금: ${curNames[0]})` });
    let placeholder;
    if (key === 'area') {
      for (const { i, fromProject } of this.scopedAreas(it.projects.map((p) => p.name))) {
        items.push({ name: i.name, label: `${curNames.includes(i.name) ? '✓ ' : ''}${i.name}  · ${KIND[i.type]}${fromProject ? ' · 이 프로젝트의 영역' : ''}${ARCH(i)}` });
      }
      placeholder = `${it.name} — 영역·리소스 선택 (✓ 항목을 다시 누르면 빠져요)`;
    } else {
      const areaNames = it.areas.map((a) => a.name);
      const sc = this.scopedProjects(showAll ? [] : areaNames, curNames);
      for (const c of sc.list) {
        items.push({ name: c.name, label: `${curNames.includes(c.name) ? '✓ ' : ''}${c.name}${c.status ? '  · ' + c.status : ''}${ARCH(c)}` });
      }
      if (sc.scoped && sc.rest) items.push({ more: true, label: `… 다른 영역 프로젝트도 보기 (${sc.rest}개)` });
      placeholder = (sc.scoped ? `${it.name} — [${areaNames.join(', ')}] 영역의 프로젝트` : `${it.name} — 프로젝트 선택`) + ' (✓ 항목을 다시 누르면 빠져요)';
    }
    const kind = key === 'area' ? 'area' : 'project';
    const again = () => this.pickLink(it, key, showAll);
    new PickModal(this.app, items, placeholder, async (pick) => {
      if (pick.more) { setTimeout(() => this.pickLink(it, key, true), 0); return; }
      if (pick.create) pick = { name: await this.createPara(kind, pick.name) };
      let autoArea = [], removed = false;
      await this.app.fileManager.processFrontMatter(it.file, (fm) => {
        const now = asList(fm[key]).map(linkName).filter(Boolean);
        removed = !pick.clear && now.includes(pick.name);   // ✓ 항목을 다시 고르면 그것만 빼기
        const next = pick.clear ? [] : removed ? now.filter((n) => n !== pick.name) : [pick.name, ...now];
        fm[key] = next.map((n) => `[[${n}]]`);
        // picking a project for a note with no area → take the project's area too
        if (key === 'project' && !pick.clear && !removed && !asList(fm.area).map(linkName).filter(Boolean).length) {
          autoArea = this.areasOfProject(pick.name);
          if (autoArea.length) fm.area = autoArea.map((n) => `[[${n}]]`);
        }
      });
      new Notice(pick.clear ? `${it.name}: ${label} 비움`
        : removed ? `${it.name}: ${pick.name} 뺌`
        : `${it.name} → ${pick.name}${autoArea.length ? ` (영역: ${autoArea.join(', ')})` : ''}`);
    }, { kind, kindLabel: kind === 'area' ? '영역' : '프로젝트',
      onRename: (name) => this.renamePara(name, again), onDelete: (name) => this.deletePara(name, again) }).open();
  }
  editBtn(parent, it) {
    const b = parent.createEl('button', { text: '✎', cls: 'pd-edit', attr: { 'aria-label': '속성 편집 (type·status·area·project·마감일)' } });
    b.addEventListener('click', async (e) => { e.preventDefault(); e.stopPropagation(); await this.ensureData(); new PropModal(this, it).open(); });
    return b;
  }


  // ---------- checklist selection ----------
  async setPinned(file, on) {
    await this.app.fileManager.processFrontMatter(file, (fm) => { if (on) fm.dashboard = true; else delete fm.dashboard; });
    new Notice(on ? `체크리스트에 추가: ${file.basename}` : `체크리스트에서 제외: ${file.basename}`);
  }
  pickChecklist(D) {
    const plugin = this;
    const cands = D.items.filter((i) => !i.pinned)
      .sort((a, b) => b.openTasks.length - a.openTasks.length || b.mtime - a.mtime);
    const M = class extends FuzzySuggestModal {
      getItems() { return cands; }
      getItemText(it) { return it.openTasks.length ? `${it.name}  (☐ ${it.openTasks.length})` : it.name; }
      onChooseItem(it) { plugin.setPinned(it.file, true); }
    };
    const m = new M(this.app);
    m.setPlaceholder('체크리스트를 볼 노트를 고르세요 (☐ = 남은 항목 수)');
    m.open();
  }

  // ---------- draw ----------
  draw(root, D) {
    const today = window.moment();
    const doing = D.projects.filter((p) => p.status === '진행 중');
    const backlog = D.projects.filter((p) => p.status === '시작 안 함' || p.status === '시작 전' || !p.status);
    const overdue = D.dated.filter((x) => x.d < 0).sort((a, b) => a.d - b.d);
    const upcoming = D.dated.filter((x) => x.d >= 0 && x.d <= 14).sort((a, b) => a.d - b.d);

    // header
    const head = root.createDiv({ cls: 'pd-header' });
    const ht = head.createDiv();
    ht.createDiv({ text: today.format('YYYY년 M월 D일 dddd'), cls: 'pd-date' });
    ht.createDiv({ text: '오늘 할 일과 진행 상황', cls: 'pd-sub' });
    const actions = head.createDiv({ cls: 'pd-actions' });
    const b1 = actions.createEl('button', { text: '+ 새 노트', cls: 'mod-cta' });
    b1.onclick = () => this.newItem('note');
    // Rappo 회의 녹음 (Rappo 플러그인이 켜져 있을 때)
    const rappo = this.app.plugins && this.app.plugins.plugins && this.app.plugins.plugins.rappo;
    if (rappo && rappo.openMeeting) {
      const on = rappo.recorder && rappo.recorder.on;
      const bm = actions.createEl('button', { text: on ? '⏹ 회의 끝내기' : '🎙 새 회의', cls: on ? 'pd-rec-on' : '' });
      bm.onclick = () => { rappo.openMeeting(); };
    }
    const b2 = actions.createEl('button', { text: '+ 새 프로젝트' });
    b2.onclick = () => this.newItem('project');
    const b3 = actions.createEl('button', { text: '+ 새 영역' });
    b3.onclick = () => this.newItem('area');

    // KPI
    const kpi = root.createDiv({ cls: 'pd-kpis' });
    const tile = (label, value, cls, hint, groups) => {
      const t = kpi.createDiv({ cls: 'pd-kpi pd-kpi-click ' + (cls || ''), attr: { 'aria-label': '클릭하면 목록 보기' } });
      t.createDiv({ text: String(value), cls: 'pd-kpi-value' });
      t.createDiv({ text: label, cls: 'pd-kpi-label' });
      if (hint) t.createDiv({ text: hint, cls: 'pd-kpi-hint' });
      t.addEventListener('click', () => new ListModal(this, label, groups()).open());
    };
    const byEnd = (a, b) => (a.end || '9999').localeCompare(b.end || '9999');
    const noteRows = (list) => list.map((i) => ({ item: i }));
    const soon7 = D.dated.filter((x) => x.d >= 0 && x.d <= 7).sort((a, b) => a.d - b.d);
    const urgent = overdue.length + soon7.length;
    tile('해야 할 노트', D.todos.length, 'todo', `진행 중 ${D.todos.filter((n) => n.status === '진행 중').length}개 · 시작 전 ${D.todos.filter((n) => n.status === '시작 전').length}개`, () => [
      { title: '진행 중', rows: noteRows(D.todos.filter((n) => n.status === '진행 중').sort(byEnd)) },
      { title: '시작 전', rows: noteRows(D.todos.filter((n) => n.status === '시작 전').sort(byEnd)) },
    ]);
    tile('진행 중 프로젝트', doing.length, 'doing', '지금 진행 중', () => [
      { title: '진행 중', rows: noteRows([...doing].sort((a, b) => b.lastTouch - a.lastTouch)) },
    ]);
    tile('마감 임박', urgent, overdue.length ? 'over' : soon7.length ? 'todo' : '', `지남 ${overdue.length}개 · 7일 내 ${soon7.length}개`, () => [
      { title: '마감 지남', rows: overdue.map((x) => ({ item: x.i })) },
      { title: '7일 내 마감', rows: soon7.map((x) => ({ item: x.i })) },
    ]);
    tile('대기 중 프로젝트', backlog.length, 'wait', '시작 안 함', () => [
      { title: '대기 중 (시작 안 함)', rows: noteRows([...backlog].sort((a, b) => b.lastTouch - a.lastTouch)) },
    ]);
    tile('Inbox 정리', D.inbox.length, D.inbox.length ? 'inbox' : '', '분류가 필요한 노트', () => [
      { title: '0. Inbox', rows: noteRows([...D.inbox].sort((a, b) => b.mtime - a.mtime)) },
    ]);

    // ===== row 1: 할 일 보드 | 최근 추가 + 마감 =====
    const row1 = root.createDiv({ cls: 'pd-row' });
    this.drawBoard(row1.createDiv({ cls: 'pd-col-wide' }), D);
    const r1 = row1.createDiv({ cls: 'pd-col' });

    const rc = this.section(r1, '최근 추가', null);
    for (const n of D.recent) {
      const r = rc.createDiv({ cls: 'pd-list-row' });
      if (n.type === 'note' || n.type === 'project') this.draggable(r, n);
      this.pill(r, n.type === 'project' ? '프로젝트' : n.status).addClass('pd-pill-sm');
      this.link(r, n);
      r.createSpan({ text: cts(n) ? ago(cts(n)) : '', cls: 'pd-muted' });
      this.editBtn(r, n);
    }

    const dl = this.section(r1, '마감 일정', overdue.length + upcoming.length);
    if (!overdue.length && !upcoming.length) this.empty(dl, '2주 안에 마감이 없어요');
    const dlRow = (x) => {
      const r = dl.createDiv({ cls: 'pd-list-row' });
      r.createSpan({ text: ddayLabel(x.d), cls: 'pd-dday ' + (x.d < 0 ? 'over' : x.d <= 3 ? 'soon' : '') });
      this.link(r, x.i);
      r.createSpan({ text: window.moment(x.i.end).format('M/D'), cls: 'pd-muted' });
      this.editBtn(r, x.i);
    };
    if (overdue.length) { dl.createDiv({ text: '지난 마감', cls: 'pd-sublabel over' }); overdue.slice(0, 10).forEach(dlRow); }
    if (upcoming.length) { dl.createDiv({ text: '다가오는 마감', cls: 'pd-sublabel' }); upcoming.forEach(dlRow); }

    this.drawChecklist(r1, D);

    // ===== 진행 중 프로젝트 =====
    const pb = this.section(root, '진행 중 프로젝트', doing.length);
    this.sectionDrop(pb.parentElement, 'project');
    const grid = pb.createDiv({ cls: 'pd-cards' });
    doing.sort((a, b) => b.lastTouch - a.lastTouch);
    if (!doing.length) this.empty(grid, '진행 중인 프로젝트가 없어요');
    for (const p of doing) {
      const c = grid.createDiv({ cls: 'pd-card' });
      c.addEventListener('click', (e) => { if (e.target.closest('a,select,button')) return; this.open(p.file, e); });
      this.draggable(c, p);
      this.dropZone(c, (x) => x.type === 'note', (x) => this.assignLink(x, 'project', p.name));
      const top = c.createDiv({ cls: 'pd-card-top' });
      this.link(top, p, 'pd-card-title');
      const tr = top.createDiv({ cls: 'pd-row-right' });
      this.statusSelect(tr, p, PROJECT_STATUS);
      this.editBtn(tr, p);
      const meta = c.createDiv({ cls: 'pd-card-meta' });
      for (const a of p.areas) meta.createSpan({ text: a.name, cls: 'pd-chip' });
      if (p.end) this.dday(meta, p.end);
      const bar = c.createDiv({ cls: 'pd-progress' });
      bar.createDiv({ cls: 'pd-progress-fill' }).style.width = (p.progress || 0) + '%';
      c.createDiv({ cls: 'pd-progress-label', text: p.progress == null ? '진행률: 연결된 할 일 없음' : `${p.progress}% · ${p.progressDone}/${p.progressTotal} 완료` });
      const foot = c.createDiv({ cls: 'pd-card-foot' });
      foot.createSpan({ text: `노트 ${p.notes.length}` });
      if (p.openTaskCount) foot.createSpan({ text: `☐ ${p.openTaskCount}` });
      if (p.lastTouch) foot.createSpan({ text: `최근 노트 ${ago(p.lastTouch)}` });
      if (p.nextTodo) {
        const nx = c.createDiv({ cls: 'pd-next' });
        nx.createSpan({ text: '다음 할 일 ', cls: 'pd-next-label' });
        this.link(nx, p.nextTodo);
        if (p.nextTodo.end) this.dday(nx, p.nextTodo.end);
      }
    }

    // ===== 영역 / 리소스 / 아카이브: 최근 입력 순 상위 N개 + 전체 보기 =====
    const TOP = 8;
    const kind = { project: '프로젝트', area: '영역', resource: '리소스', archive: '아카이브' };
    const byRecent = (x, y) => y.lastInput - x.lastInput;
    const tileGrid = (title, list, meta, cat) => {
      list = [...list].sort(byRecent);
      const s = root.createDiv({ cls: 'pd-section' });
      this.sectionDrop(s, cat);
      const h = s.createDiv({ cls: 'pd-section-head' });
      h.createSpan({ text: title, cls: 'pd-section-title' });
      h.createSpan({ text: String(list.length), cls: 'pd-count' });
      h.createSpan({ text: '최근 입력 순', cls: 'pd-muted pd-head-hint' });
      if (list.length) {
        const all = h.createEl('button', { text: `전체 보기 · 검색`, cls: 'pd-mini' });
        all.onclick = () => new ListModal(this, title, [{ title: `${title} 전체 (최근 입력 순)`, rows: list.map((i) => ({ item: i, meta: meta(i) })) }]).open();
      }
      const body = s.createDiv({ cls: 'pd-section-body' });
      if (!list.length) { this.empty(body, '없음 · 여기로 끌어다 놓을 수 있어요'); return; }
      const g = body.createDiv({ cls: 'pd-area-grid' });
      for (const it of list.slice(0, TOP)) {
        const t = g.createDiv({ cls: 'pd-area' });
        this.draggable(t, it);
        t.addEventListener('click', (e) => { if (e.target.closest('a,button')) return; this.open(it.file, e); });
        if (it.type === 'area' || it.type === 'resource') {
          this.dropZone(t, (x) => ['note', 'project', 'resource'].includes(x.type) && x !== it, (x) => this.assignLink(x, 'area', it.name));
        }
        const th = t.createDiv({ cls: 'pd-area-head' });
        this.link(th, it, 'pd-area-title');
        this.editBtn(th, it);
        t.createDiv({ text: meta(it), cls: 'pd-muted' });
        if (it.lastInput) t.createDiv({ text: `최근 입력 ${ago(it.lastInput)}`, cls: 'pd-muted pd-faint' });
      }
      if (list.length > TOP) {
        const more = g.createDiv({ cls: 'pd-area pd-area-more', text: `+ ${list.length - TOP}개 더 보기` });
        more.onclick = () => new ListModal(this, title, [{ title: `${title} 전체 (최근 입력 순)`, rows: list.map((i) => ({ item: i, meta: meta(i) })) }]).open();
      }
    };
    tileGrid('영역', D.activeAreas, (a) => `프로젝트 ${a.activeProjects.length} · 노트 ${a.noteCount}`, 'area');
    tileGrid('리소스', D.resources, (r) => `노트 ${r.noteCount}`, 'resource');
    tileGrid('아카이브', D.archives,
      (r) => [kind[r.type] || '', r.type === 'project' ? r.status : '', `노트 ${r.noteCount}`].filter(Boolean).join(' · '), 'archive');
  }

  drawBoard(parent, D) {
    const s = parent.createDiv({ cls: 'pd-section' });
    const h = s.createDiv({ cls: 'pd-section-head' });
    h.createSpan({ text: '할 일 보드', cls: 'pd-section-title' });
    const input = h.createEl('input', { type: 'search', cls: 'pd-search', attr: { placeholder: '🔍 노트·프로젝트·영역 검색' } });
    input.value = this.boardQuery || '';
    const board = s.createDiv({ cls: 'pd-board' });
    const COLS = [
      { key: '시작 전', label: '시작 전', sort: (a, b) => (a.end || '9999').localeCompare(b.end || '9999') },
      { key: '진행 중', label: '진행 중', sort: (a, b) => (a.end || '9999').localeCompare(b.end || '9999') },
      { key: '완료', label: '완료', hint: '최근 2주', sort: (a, b) => ts(b) - ts(a) },
      { key: '메모용', label: '메모용', cls: 'memo', sort: (a, b) => cts(b) - cts(a) },
    ];
    const hay = (n) => [n.name, ...n.projects.map((x) => x.name), ...n.areas.map((x) => x.name)].join(' ').toLowerCase();
    const paint = () => {
      board.empty();
      const q = (this.boardQuery || '').trim().toLowerCase();
      // 메모용은 평소엔 숨기고, 검색할 때만 함께 보여 줌
      board.toggleClass('pd-board-4', !!q);
      for (const c of (q ? COLS : COLS.filter((x) => x.key !== '메모용'))) {
        let list = D.notes.filter((n) => (n.status || '메모용') === c.key);
        if (q) list = list.filter((n) => hay(n).includes(q));
        else if (c.key === '완료') list = list.filter((n) => Date.now() - ts(n) < 14 * 86400000);
        list.sort(c.sort);
        const col = board.createDiv({ cls: 'pd-board-col' });
        this.dropZone(col, (x) => x.type === 'note' && (x.status || '메모용') !== c.key, (x) => this.setStatus(x.file, c.key));
        const ch = col.createDiv({ cls: 'pd-board-head' });
        this.pill(ch, c.label);
        ch.createSpan({ text: String(list.length), cls: 'pd-count' });
        if (c.hint && !q) ch.createSpan({ text: c.hint, cls: 'pd-muted' });
        // 이 칸 상태로 새 노트 만들기
        if (c.key !== '메모용') {
          const add = ch.createEl('button', { text: '+', cls: 'pd-col-add', attr: { 'aria-label': `'${c.label}' 노트 만들기` } });
          add.onclick = () => this.newItem('note', c.key);
        }
        if (!list.length) this.empty(col, q ? '검색 결과 없음' : '없음');
        const limit = q ? 30 : 10;
        for (const n of list.slice(0, limit)) {
          const it = col.createDiv({ cls: 'pd-task-card pd-card-click' });
          this.draggable(it, n);
          // 카드 빈 곳을 눌러도 노트 열기 (상태 선택·편집 버튼·링크는 그대로)
          it.addEventListener('click', (e) => { if (e.target.closest('a,select,button,input,.pd-row-right')) return; this.open(n.file, e); });
          const l1 = it.createDiv({ cls: 'pd-task-line' });
          this.link(l1, n);
          if (n.end && !CLOSED_STATUS.includes(n.status) && n.status !== '메모용') this.dday(l1, n.end);
          const l2 = it.createDiv({ cls: 'pd-task-line pd-task-meta' });
          const lc = l2.createDiv({ cls: 'pd-link-chips' });
          this.linkChip(lc, n, 'area');
          this.linkChip(lc, n, 'project');
          this.periodChip(lc, n);
          const br = l2.createDiv({ cls: 'pd-row-right' });
          this.statusSelect(br, n, NOTE_STATUS);
          this.editBtn(br, n);
        }
        if (list.length > limit) col.createDiv({ text: `+ ${list.length - limit}개 더 (검색으로 찾기)`, cls: 'pd-empty' });
      }
    };
    let timer = null;
    input.addEventListener('input', () => {
      this.boardQuery = input.value;
      clearTimeout(timer); timer = setTimeout(paint, 150);
    });
    paint();
  }

  drawChecklist(parent, D) {
    const s = parent.createDiv({ cls: 'pd-section' });
    const h = s.createDiv({ cls: 'pd-section-head' });
    h.createSpan({ text: '체크리스트', cls: 'pd-section-title' });
    h.createSpan({ text: String(D.pinnedTasks.length), cls: 'pd-count' });
    const add = h.createEl('button', { text: '+ 노트 추가', cls: 'pd-mini' });
    add.onclick = () => this.pickChecklist(D);
    const body = s.createDiv({ cls: 'pd-section-body' });

    const groups = new Map();
    for (const f of D.pinnedFiles) groups.set(f.path, { item: f, tasks: [] });
    for (const t of D.pinnedTasks) {
      if (!groups.has(t.item.path)) groups.set(t.item.path, { item: t.item, tasks: [] });
      groups.get(t.item.path).tasks.push(t);
    }
    if (!groups.size) {
      const e = body.createDiv({ cls: 'pd-empty pd-help' });
      e.createDiv({ text: '보고 싶은 체크리스트만 골라서 여기에 모아 볼 수 있어요.' });
      e.createDiv({ text: '• [+ 노트 추가]로 노트를 고르면 그 노트의 체크 항목이 모두 표시돼요.' });
      e.createDiv({ text: `• 항목 하나만 보고 싶으면 그 줄 끝에 ${PIN_TAG} 태그를 붙이세요.` });
      return;
    }
    const grid = body.createDiv({ cls: 'pd-check-grid' });
    for (const g of [...groups.values()]) {
      const box = grid.createDiv({ cls: 'pd-check-group' });
      const gh = box.createDiv({ cls: 'pd-check-head' });
      this.link(gh, g.item);
      gh.createSpan({ text: String(g.tasks.length), cls: 'pd-count' });
      if (g.item.pinned) {
        const x = gh.createEl('button', { text: '✕', cls: 'pd-x', attr: { 'aria-label': '체크리스트에서 빼기' } });
        x.onclick = () => this.setPinned(g.item.file, false);
      }
      if (!g.tasks.length) this.empty(box, '남은 항목 없음 ✅');
      for (const t of g.tasks.slice(0, 10)) {
        const lab = box.createEl('label', { cls: 'pd-check' });
        const cb = lab.createEl('input', { type: 'checkbox' });
        lab.createSpan({ text: t.text });
        cb.addEventListener('change', async () => { lab.addClass('pd-checked'); await this.toggleTask(t); });
      }
      if (g.tasks.length > 10) box.createDiv({ text: `+ ${g.tasks.length - 10}개 더`, cls: 'pd-empty' });
    }
  }
};

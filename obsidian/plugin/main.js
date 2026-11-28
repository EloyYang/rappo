// Rappo(라포) 대화·통화 검색: 월별 카톡 노트와 통화 노트(요약·전사문)를 한 번에 검색하고, 날짜별로 펼쳐 본다.
// 노트 폴더는 이 플러그인 폴더의 data.json {"base": "..."} (Rappo 설치 프로그램이 적음). 없으면 '2. Areas/통화기록'.
// - ```대화검색``` (또는 ```카톡검색```) 코드블록 → 노트 안에 검색 화면
// - 명령 "대화·통화 검색" / 리본 아이콘 → 어디서나 창으로
const { Plugin, Modal, MarkdownRenderChild, MarkdownView, TFile, Notice, debounce } = require('obsidian');

let BASE = '2. Areas/통화기록';
let CONTACTS = BASE + '/연락처';
let KAKAO = '2. Areas/통화기록/카톡';
let CALLS = '2. Areas/통화기록/통화';
const DAY_RE = /^### (\d{4}-\d{2}-\d{2})/;
const MSG_RE = /^`(\d{2}:\d{2}(?::\d{2})?)` \*\*(.+?)\*\*: ?(.*)$/;
const LINK_RE = /\[\[(?:[^\]|]*\|)?([^\]]+)\]\]/g;
const PAGE = 100;
const CALL_PLAN_RE = /^\s*(?:[-*]\s+)?📅\s*(\d{4}-\d{2}-\d{2})(?:\s+(\d{1,2}:\d{2}))?\s+(.+)$/;
const TODO_RE = /^\s*[-*]\s+\[([ xX])\]\s+(.+)$/;
const DAY_MS = 86400000;
function daysSince(d) { const x = new Date(d + 'T00:00:00'); return isNaN(x) ? 0 : Math.round((new Date(today() + 'T00:00:00') - x) / DAY_MS); }
const WEEK = ['일', '월', '화', '수', '목', '금', '토'];
const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';

// 설명은 접어 두고 ⓘ 를 누르면 펼친다
function helpTip(bar, text) {
  const a = bar.createEl('a', { cls: 'ks-help', text: 'ⓘ', attr: { 'aria-label': '설명 보기' } });
  const box = bar.createDiv({ cls: 'ks-help-text ks-muted', text });
  box.hide();
  a.onclick = () => box.toggle(!box.isShown());
  return a;
}
function clean(t) { return t.replace(/<br\s*\/?>/gi, ' ⏎ '); }
function weekday(d) { const x = new Date(d + 'T00:00:00'); return isNaN(x) ? '' : WEEK[x.getDay()]; }
function pad(v) { return String(v).padStart(2, '0'); }
function today() { const x = new Date(); return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`; }
function when(d, t) {
  const td = today();
  const y = new Date(td + 'T00:00:00'); y.setDate(y.getDate() - 1);
  const yd = `${y.getFullYear()}-${pad(y.getMonth() + 1)}-${pad(y.getDate())}`;
  if (d === td) return `오늘 ${t}`;
  if (d === yd) return `어제 ${t}`;
  if (d.slice(0, 4) === td.slice(0, 4)) return `${d.slice(5).replace('-', '/')} ${t}`;
  return d;
}
// 한글 초성 문자열 (ㅇㅁ → 엄마 같은 초성 검색용)
function chosung(s) {
  let o = '';
  for (const ch of s) {
    const c = ch.charCodeAt(0) - 0xac00;
    o += c >= 0 && c < 11172 ? CHO[Math.floor(c / 588)] : ch;
  }
  return o;
}
function matchName(name, q) {
  if (!q) return true;
  const n = name.toLowerCase().replace(/\s+/g, ''), k = q.toLowerCase().replace(/\s+/g, '');
  if (n.includes(k)) return true;
  return /^[ㄱ-ㅎ]+$/.test(k) && chosung(n).includes(k);
}
// [[엄마 (010-1234-5678)]] → 엄마 , [[010-1234-5678]] → 010-1234-5678
function contactName(v) {
  const s = String(v || '').replace(LINK_RE, '$1').trim();
  return s.replace(/\s*\([0-9-+ ]+\)\s*$/, '') || s;
}

// ---------- 색인 ----------
// 파일마다 {src:'kakao'|'call', room, kind, file, msgs:[{date,time,who,text,line,off?}], call?}
class Index {
  constructor(app) { this.app = app; this.files = new Map(); this.building = null; }

  srcOf(f) {
    if (!(f instanceof TFile) || f.extension !== 'md') return '';
    if (f.path.startsWith(KAKAO + '/') && /\d{4}-\d{2}$/.test(f.basename)) return 'kakao';
    if (f.path.startsWith(CALLS + '/')) return 'call';
    return '';
  }

  async parse(f, src) {
    const text = await this.app.vault.cachedRead(f);
    const fm = this.app.metadataCache.getFileCache(f)?.frontmatter || {};
    const lines = text.split('\n');
    const msgs = [];
    const entry = { mtime: f.stat.mtime, src, file: f, msgs, todos: [], plans: [] };

    if (src === 'kakao') {
      entry.room = String(fm.room || f.parent?.name || f.basename.replace(/ \d{4}-\d{2}$/, ''));
      entry.kind = String(fm.kind || '') === '단체' ? '단체' : '카톡';
      let date = '';
      for (let i = 0; i < lines.length; i++) {
        const d = DAY_RE.exec(lines[i]);
        if (d) { date = d[1]; continue; }
        const m = MSG_RE.exec(lines[i]);
        if (m && date) {
          const who = m[2].replace(LINK_RE, '$1');
          msgs.push({ date, time: m[1], who, text: m[3], lower: m[3].toLowerCase(), line: i });
        }
      }
    } else {
      // 통화 노트: 날짜·시각은 datetime 속성(없으면 파일 이름 "YYYY-MM-DD HHMM ...")
      const fmName = String(fm.name || '').trim();
      const name = fmName && fmName !== '정보 없음' ? fmName
        : String(fm.phone || '') || contactName(fm.contact || f.basename.replace(/^\S+ \d{4} /, ''));
      let dt = String(fm.datetime || '');
      const b = /^(\d{4}-\d{2}-\d{2}) (\d{2})(\d{2})/.exec(f.basename);
      if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(dt) && b) dt = `${b[1]}T${b[2]}:${b[3]}`;
      const date = dt.slice(0, 10), time = dt.slice(11, 16);
      entry.room = name;
      entry.kind = '통화';
      entry.call = { date, time, dur: String(fm.duration || '') };
      let sec = '';
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        if (/^## /.test(l)) { sec = l.slice(3).trim(); continue; }
        if (sec === '요약') {
          const td = TODO_RE.exec(l);
          if (td) entry.todos.push({ done: td[1] !== ' ', text: td[2].trim(), line: i });
          const pl = CALL_PLAN_RE.exec(l);
          if (pl) entry.plans.push({ date: pl[1], time: pl[2] ? pl[2].padStart(5, '0') : '', text: pl[3].trim(), line: i });
          const t = l.replace(/^\s*[-*]\s+/, '').replace(/^\[[ xX]\]\s*/, '').trim();
          if (t && t !== '(요약 없음)') msgs.push({ date, time, who: '요약', text: t, lower: t.toLowerCase(), line: i, off: '' });
        } else if (sec === '전사문') {
          const m = MSG_RE.exec(l);
          if (m) {
            const who = m[2] === '상대' ? name : m[2].replace(LINK_RE, '$1');
            msgs.push({ date, time, who, text: m[3], lower: m[3].toLowerCase(), line: i, off: m[1] });
          }
        }
      }
    }
    this.files.set(f.path, entry);
  }

  async ensure() {
    if (this.building) return this.building;
    this.building = (async () => {
      const targets = [];
      for (const f of this.app.vault.getMarkdownFiles()) { const s = this.srcOf(f); if (s) targets.push([f, s]); }
      const alive = new Set(targets.map(([f]) => f.path));
      for (const p of [...this.files.keys()]) if (!alive.has(p)) this.files.delete(p);
      for (const [f, s] of targets) {
        const c = this.files.get(f.path);
        if (!c || c.mtime !== f.stat.mtime) await this.parse(f, s);
      }
    })();
    try { await this.building; } finally { this.building = null; }
  }

  // 방·연락처 목록: [{name, kinds:Set, last}] — 최근 대화 순
  rooms() {
    const s = new Map();
    for (const c of this.files.values()) {
      const r = s.get(c.room) || { name: c.room, kinds: new Set(), last: '' };
      r.kinds.add(c.kind);
      const last = c.call ? c.call.date : (c.msgs.length ? c.msgs[c.msgs.length - 1].date : '');
      if (last > r.last) r.last = last;
      s.set(c.room, r);
    }
    // 단체방에서 말한 사람도 '사람'으로 (이름으로 고르면 그 사람이 단체방에서 한 말까지 보임)
    for (const c of this.files.values()) {
      if (c.kind !== '단체') continue;
      const seen = new Map();
      for (const m of c.msgs) if (m.who !== '나') seen.set(m.who, m.date);
      for (const [who, d] of seen) {
        const r = s.get(who) || { name: who, kinds: new Set(), last: '' };
        r.kinds.add('사람');
        if (d > r.last) r.last = d;
        s.set(who, r);
      }
    }
    return [...s.values()].sort((a, b) => b.last.localeCompare(a.last) || a.name.localeCompare(b.name, 'ko'));
  }

  // 0: 제외, 1: 그 방·연락처 전체, 2: 단체방에서 그 사람이 한 말만
  pick(c, room, src) {
    if (src && c.src !== src) return 0;
    if (!room || c.room === room) return 1;
    return c.kind === '단체' ? 2 : 0;
  }

  // q: 검색어(공백으로 여러 단어, 모두 포함), room, who, from/to, src('kakao'|'call'|'')
  search({ q, room, who, from, to, src }) {
    const terms = (q || '').toLowerCase().split(/\s+/).filter(Boolean);
    const w = (who || '').trim();
    const out = [];
    for (const c of this.files.values()) {
      const k = this.pick(c, room, src);
      if (!k) continue;
      for (const m of c.msgs) {
        if (k === 2 && m.who !== room) continue;
        if (from && m.date < from) continue;
        if (to && m.date > to) continue;
        if (w && !m.who.includes(w)) continue;
        if (terms.length && !terms.every((t) => m.lower.includes(t) || m.who.toLowerCase().includes(t))) continue;
        out.push({ ...m, room: c.room, file: c.file, src: c.src, call: c.call });
      }
    }
    // 날짜는 최신 순, 같은 날 안에서는 대화 흐름대로(시간 순)
    out.sort((a, b) => b.date.localeCompare(a.date) || a.time.localeCompare(b.time) ||
      (a.file.path === b.file.path ? a.line - b.line : a.file.path.localeCompare(b.file.path)));
    return out;
  }

  // 특정 날짜: 카톡은 방별, 통화는 통화별 묶음 (시간 순)
  day(date, room, src) {
    const groups = [];
    for (const c of this.files.values()) {
      const k = this.pick(c, room, src);
      if (!k) continue;
      if (c.call) {
        if (c.call.date === date) groups.push({ c, msgs: c.msgs, first: c.call.time });
      } else {
        const ms = c.msgs.filter((m) => m.date === date);
        // 단체방은 그 사람이 그날 말했을 때만, 앞뒤 흐름이 보이게 그날 대화 전체를
        if (ms.length && (k === 1 || ms.some((m) => m.who === room))) groups.push({ c, msgs: ms, first: ms[0].time, person: k === 2 ? room : '' });
      }
    }
    return groups.sort((a, b) => a.first.localeCompare(b.first));
  }

  // 대화가 있는 가장 가까운 날 (dir: -1 이전, +1 다음)
  nearestDay(date, dir, room, src) {
    let best = '';
    const see = (d) => {
      if (dir < 0 ? d < date && d > best : d > date && (!best || d < best)) best = d;
    };
    for (const c of this.files.values()) {
      const k = this.pick(c, room, src);
      if (!k) continue;
      if (c.call) see(c.call.date); else for (const m of c.msgs) if (k === 1 || m.who === room) see(m.date);
    }
    return best;
  }

  // 최근 연락: 사람(또는 방)별 마지막 통화·마지막 카톡
  recent() {
    const by = new Map();
    const get = (name) => { if (!by.has(name)) by.set(name, { name, call: null, talk: null, group: false, calls: 0, days: new Set() }); return by.get(name); };
    for (const c of this.files.values()) {
      if (c.call) {
        const e = get(c.room), key = `${c.call.date} ${c.call.time}`;
        e.calls++;
        if (c.call.date) e.days.add(c.call.date);
        if (!e.call || key > e.call.key) {
          const sm = c.msgs.find((m) => m.who === '요약'), first = c.msgs.find((m) => m.who !== '요약');
          e.call = { key, date: c.call.date, time: c.call.time, dur: c.call.dur, file: c.file, line: 0,
            text: sm ? sm.text : first ? `${first.who}: ${first.text}` : '' };
        }
      } else if (c.msgs.length) {
        const m = c.msgs[c.msgs.length - 1], e = get(c.room), key = `${m.date} ${m.time}`;
        if (c.kind === '단체') e.group = true;
        for (const x of c.msgs) if (x.who !== '나') e.days.add(x.date);
        if (!e.talk || key > e.talk.key) e.talk = { key, date: m.date, time: m.time, file: c.file, line: m.line, text: `${m.who}: ${m.text}` };
      }
    }
    return [...by.values()]
      .map((e) => ({ ...e, last: (e.call?.key || '') > (e.talk?.key || '') ? e.call.key : (e.talk?.key || '') }))
      .sort((a, b) => b.last.localeCompare(a.last));
  }

  // 사람·방 한 곳의 관계 요약: 통화 수, 카톡 수, 단체방 발언, 처음·마지막 연락, 연락한 날 수
  stats(room) {
    const st = { calls: 0, talk: 0, group: 0, groups: new Set(), first: '', last: '', days: new Set(), todo: 0 };
    const see = (d) => { if (!d) return; st.days.add(d); if (!st.first || d < st.first) st.first = d; if (d > st.last) st.last = d; };
    for (const c of this.files.values()) {
      const k = this.pick(c, room, '');
      if (k === 1 && c.call) { st.calls++; see(c.call.date); }
      else if (k === 1) { st.talk += c.msgs.length; for (const m of c.msgs) see(m.date); }
      else if (k === 2) for (const m of c.msgs) if (m.who === room) { st.group++; st.groups.add(c.room); see(m.date); }
    }
    return st;
  }

  // 통화 요약에서 나온 할 일 (최신 통화부터)
  todos() {
    const out = [];
    for (const c of this.files.values()) for (const t of c.todos || []) out.push({ ...t, room: c.room, file: c.file, call: c.call });
    return out.sort((a, b) => `${b.call.date} ${b.call.time}`.localeCompare(`${a.call.date} ${a.call.time}`) || a.line - b.line);
  }

  latestDay() {
    let best = '';
    for (const c of this.files.values()) {
      const d = c.call ? c.call.date : (c.msgs.length ? c.msgs[c.msgs.length - 1].date : '');
      if (d > best) best = d;
    }
    return best || today();
  }
}

function kindIcon(kinds) {
  let s = '';
  if (kinds.has('단체')) s += '👥';
  if (kinds.has('카톡')) s += '💬';
  if (kinds.has('통화')) s += '📞';
  if (kinds.has('사람') && !kinds.has('카톡') && !kinds.has('통화')) s += '👤';
  return s;
}

// ---------- 방·연락처 입력 찾기 ----------
class RoomPicker {
  constructor(parent, rooms, value, onPick) {
    this.rooms = rooms; this.onPick = onPick; this.sel = 0; this.items = [];
    const wrap = parent.createDiv({ cls: 'ks-picker' });
    this.input = wrap.createEl('input', { type: 'text', cls: 'ks-room', placeholder: '방·연락처 찾기 (전체)' });
    this.input.value = value;
    this.clear = wrap.createEl('span', { cls: 'ks-clear', text: '✕', attr: { 'aria-label': '전체 보기' } });
    this.clear.toggle(!!value);
    this.list = wrap.createDiv({ cls: 'ks-suggest' });
    this.list.hide();
    this.input.onfocus = () => { this.input.select(); this.show(''); };
    this.input.oninput = () => this.show(this.input.value);
    this.input.onblur = () => setTimeout(() => { this.list.hide(); this.input.value = this.current || ''; }, 150);
    this.input.onkeydown = (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        this.sel = Math.max(0, Math.min(this.items.length - 1, this.sel + (e.key === 'ArrowDown' ? 1 : -1)));
        this.mark();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (this.items[this.sel] !== undefined) this.choose(this.items[this.sel]);
      } else if (e.key === 'Escape') { this.input.blur(); }
    };
    this.clear.onclick = () => this.choose('');
    this.current = value;
  }
  show(q) {
    const l = this.list;
    l.empty();
    const hits = this.rooms.filter((r) => matchName(r.name, q.trim()));
    this.items = q.trim() ? [] : [''];
    this.items.push(...hits.slice(0, 80).map((r) => r.name));
    this.sel = 0;
    if (!this.items.length) l.createDiv({ cls: 'ks-opt ks-muted', text: '일치하는 방·연락처가 없어요' });
    this.items.forEach((name, i) => {
      const r = this.rooms.find((x) => x.name === name);
      const o = l.createDiv({ cls: 'ks-opt' });
      if (!name) o.setText('전체 (모든 방·통화)');
      else if (!r.kinds.has('카톡') && !r.kinds.has('통화') && !r.kinds.has('단체')) {
        o.createSpan({ text: '👤 ', cls: 'ks-opt-icon' });
        o.createSpan({ text: name });
        o.createSpan({ text: ' 단체방 발언', cls: 'ks-muted' });
      }
      else {
        o.createSpan({ text: kindIcon(r.kinds) + ' ', cls: 'ks-opt-icon' });
        o.createSpan({ text: name });
        if (r.last) o.createSpan({ text: ` ${r.last}`, cls: 'ks-muted' });
      }
      o.onmousedown = (e) => { e.preventDefault(); this.choose(name); };
      o.dataset.i = i;
    });
    if (hits.length > 80) l.createDiv({ cls: 'ks-opt ks-muted', text: `… ${hits.length - 80}개 더 (더 입력해서 좁혀 보세요)` });
    this.mark();
    l.show();
  }
  mark() {
    this.list.querySelectorAll('.ks-opt').forEach((o) => o.toggleClass('is-selected', Number(o.dataset.i) === this.sel && o.dataset.i !== undefined));
    const cur = this.list.querySelector('.is-selected');
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  }
  choose(name) {
    this.current = name;
    this.input.value = name;
    this.clear.toggle(!!name);
    this.list.hide();
    this.input.blur();
    this.onPick(name);
  }
}

// ---------- 화면 ----------
class SearchView {
  constructor(plugin, root, opts = {}) {
    this.plugin = plugin;
    this.app = plugin.app;
    this.root = root;
    this.onOpen = opts.onOpen || (() => {});
    this.state = { q: '', room: '', who: '', from: '', to: '', src: '', date: '', mode: 'search', shown: PAGE };
  }

  async render() {
    const r = this.root;
    r.empty();
    r.addClass('ks-root');
    const status = r.createDiv({ cls: 'ks-status', text: '대화·통화 색인 중…' });
    await this.plugin.index.ensure();
    await this.plugin.tasks.load();
    status.remove();
    const idx = this.plugin.index;

    const top = r.createDiv({ cls: 'ks-tabs' });
    const tSearch = top.createEl('button', { text: '🔍 내용으로 찾기' });
    const tDay = top.createEl('button', { text: '📅 날짜로 보기' });
    tSearch.toggleClass('is-active', this.state.mode === 'search');
    tDay.toggleClass('is-active', this.state.mode === 'day');
    tSearch.onclick = () => { this.state.mode = 'search'; this.render(); };
    tDay.onclick = () => { this.state.mode = 'day'; if (!this.state.date) this.state.date = idx.latestDay(); this.render(); };
    top.createDiv({ cls: 'ks-spacer' });
    const seg = top.createDiv({ cls: 'ks-seg' });
    for (const [v, label] of [['', '전체'], ['kakao', '💬 카톡'], ['call', '📞 통화']]) {
      const b = seg.createEl('button', { text: label });
      b.toggleClass('is-active', this.state.src === v);
      b.onclick = () => { this.state.src = v; this.state.shown = PAGE; this.state.shownCall = PAGE; this.render(); };
    }

    const bar = r.createDiv({ cls: 'ks-bar' });
    new RoomPicker(bar, idx.rooms(), this.state.room, (name) => {
      this.state.room = name; this.state.shown = PAGE; this.state.shownCall = PAGE; this.refresh();
    });

    if (this.state.mode === 'search') this.searchBar(bar);
    else this.dayBar(bar);

    this.results = r.createDiv({ cls: 'ks-results' });
    this.refresh();
  }

  searchBar(bar) {
    const q = bar.createEl('input', { type: 'search', cls: 'ks-q', placeholder: '단어 검색 (선택 · 띄어쓰기로 여러 단어)' });
    q.value = this.state.q;
    const who = bar.createEl('input', { type: 'text', cls: 'ks-who', placeholder: '말한 사람' });
    who.value = this.state.who;
    const row = bar.createDiv({ cls: 'ks-range' });
    const from = row.createEl('input', { type: 'date' });
    row.createSpan({ text: '~' });
    const to = row.createEl('input', { type: 'date' });
    from.value = this.state.from; to.value = this.state.to;
    const clear = row.createEl('button', { text: '기간 지우기' });
    const go = debounce(() => {
      Object.assign(this.state, { q: q.value, who: who.value, from: from.value, to: to.value, shown: PAGE, shownCall: PAGE });
      this.refresh();
    }, 250, true);
    q.oninput = go; who.oninput = go; from.onchange = go; to.onchange = go;
    clear.onclick = () => { from.value = ''; to.value = ''; go(); };
  }

  dayBar(bar) {
    const row = bar.createDiv({ cls: 'ks-range' });
    const prev = row.createEl('button', { text: '◀ 이전', cls: 'ks-nav' });
    const date = row.createEl('input', { type: 'date' });
    const next = row.createEl('button', { text: '다음 ▶', cls: 'ks-nav' });
    date.value = this.state.date;
    date.onchange = () => { this.state.date = date.value; this.refresh(); };
    const jump = (dir) => {
      const s = this.state;
      const d = this.plugin.index.nearestDay(s.date, dir, s.room, s.src);
      if (d) { s.date = d; date.value = d; this.refresh(); }
    };
    prev.onclick = () => jump(-1);
    next.onclick = () => jump(1);
  }

  refresh() {
    const box = this.results;
    if (!box) return;
    box.empty();
    if (this.state.mode === 'day') return this.renderDay(box);
    const s = this.state;
    if (!s.q.trim() && !s.who.trim() && !s.from && !s.to && !s.room && !s.src) {
      box.createDiv({ cls: 'ks-hint', text: '방·연락처를 고르면 그 대화 전체가 최신 날짜부터 보여요. 단어를 입력하면 카톡과 통화 내용을 한 번에 찾아요.' });
      return;
    }
    if (s.room) this.personCard(box, s.room);
    const res = this.plugin.index.search(s);
    const calls = res.filter((m) => m.src === 'call'), talks = res.filter((m) => m.src !== 'call');
    const nCall = new Set(calls.map((m) => m.file.path)).size;
    if (!res.length) { box.createDiv({ cls: 'ks-hint', text: '찾은 내용이 없어요.' }); return; }
    const terms = s.q.toLowerCase().split(/\s+/).filter(Boolean);
    // 통화와 카톡을 따로 나눠서 (통화가 적으니 위에)
    if (calls.length) this.section(box, 'call', `📞 통화 ${nCall}건`, `${calls.length.toLocaleString()}줄`, calls, terms, 'shownCall');
    if (talks.length) this.section(box, 'kakao', '💬 카카오톡', `${talks.length.toLocaleString()}개 메시지`, talks, terms, 'shown');
  }

  personCard(box, room) {
    const st = this.plugin.index.stats(room);
    st.todo = (this.plugin.tasks.cache || []).filter((t) => t.status === ' ' && t.who === room).length;
    if (!st.last) return;
    const card = box.createDiv({ cls: 'ks-person' });
    const parts = [];
    if (st.calls) parts.push(`📞 통화 ${st.calls}건`);
    if (st.talk) parts.push(`💬 카톡 ${st.talk.toLocaleString()}개`);
    if (st.group) parts.push(`👥 단체방 ${st.groups.size}곳에서 ${st.group.toLocaleString()}번 발언`);
    card.createDiv({ cls: 'ks-person-stats', text: parts.join(' · ') });
    const gap = daysSince(st.last);
    const line = `처음 ${st.first} · 마지막 ${st.last}` + (gap > 0 ? ` (${gap}일 전)` : ' (오늘)') + ` · 연락한 날 ${st.days.size}일`;
    card.createDiv({ cls: 'ks-muted', text: line + (st.todo ? ` · 남은 할 일 ${st.todo}개` : '') });
  }

  section(box, kind, title, sub, list, terms, key) {
    const s = this.state;
    if (!s[key]) s[key] = PAGE;
    s.open = s.open || {};
    const det = box.createEl('details', { cls: `ks-section is-${kind}` });
    det.open = s.open[kind] !== false;
    det.ontoggle = () => { s.open[kind] = det.open; };
    const sum = det.createEl('summary', { cls: 'ks-section-head' });
    sum.createSpan({ text: title, cls: 'ks-section-title' });
    sum.createSpan({ text: ` ${sub}`, cls: 'ks-muted' });
    let lastDate = '', lastCall = '';
    for (const m of list.slice(0, s[key])) {
      if (m.date !== lastDate) {
        lastDate = m.date; lastCall = '';
        const h = det.createDiv({ cls: 'ks-date' });
        h.createSpan({ text: `${m.date} (${weekday(m.date)})` });
        const b = h.createEl('a', { text: '그날 전체 보기', cls: 'ks-daylink' });
        b.onclick = () => { Object.assign(this.state, { mode: 'day', date: m.date }); this.render(); };
      }
      if (m.src === 'call' && m.file.path !== lastCall) { lastCall = m.file.path; this.callHead(det, m); }
      this.msgRow(det, m, terms, m.src !== 'call' && (!s.room || m.room !== s.room));
    }
    if (list.length > s[key]) {
      const more = det.createEl('button', { text: `더 보기 (${(list.length - s[key]).toLocaleString()}개 남음)`, cls: 'ks-more' });
      more.onclick = () => { s[key] += PAGE; this.refresh(); };
    }
  }

  callHead(parent, m) {
    const h = parent.createDiv({ cls: 'ks-callhead' });
    h.createSpan({ text: `📞 ${m.room} · ${m.call.time}` + (m.call.dur ? ` · ${m.call.dur}` : '') });
    const a = h.createEl('a', { text: '통화 노트', cls: 'ks-daylink' });
    a.onclick = (e) => { e.stopPropagation(); this.open(m.file, 0); };
  }

  renderDay(box) {
    const s = this.state, d = s.date;
    if (!d) return;
    const groups = this.plugin.index.day(d, s.room, s.src);
    box.createDiv({ cls: 'ks-count', text: `${d} (${weekday(d)})` });
    if (!groups.length) {
      box.createDiv({ cls: 'ks-hint', text: '이날은 대화가 없어요. ◀ ▶ 로 대화가 있는 날로 이동할 수 있어요.' });
      return;
    }
    const calls = groups.filter((g) => g.c.call), talks = groups.filter((g) => !g.c.call);
    for (const [kind, title, gs] of [['call', `📞 통화 ${calls.length}건`, calls], ['kakao', `💬 카카오톡 ${talks.length}개 방`, talks]]) {
      if (!gs.length) continue;
      const sec = box.createDiv({ cls: `ks-section is-${kind}` });
      sec.createDiv({ cls: 'ks-section-head', text: title });
      for (const { c, msgs, person } of gs) {
        const det = sec.createEl('details', { cls: 'ks-dayroom' + (c.call ? ' is-call' : '') });
        if (gs.length <= 3 || s.room) det.open = true;
        const sum = det.createEl('summary');
        if (c.call) {
          sum.createSpan({ text: c.room, cls: 'ks-roomname' });
          sum.createSpan({ text: ` ${c.call.time}` + (c.call.dur ? ` · ${c.call.dur}` : ''), cls: 'ks-muted' });
        } else {
          sum.createSpan({ text: (c.kind === '단체' ? '👥 ' : '') + c.room, cls: 'ks-roomname' });
          sum.createSpan({ text: ` ${msgs.length}개`, cls: 'ks-muted' });
          if (person) sum.createSpan({ text: ` · ${person} 님 발언 표시`, cls: 'ks-muted' });
        }
        const open = sum.createEl('a', { text: '노트 열기', cls: 'ks-daylink' });
        open.onclick = (e) => { e.preventDefault(); this.open(c.file, c.call ? 0 : msgs[0].line - 1); };
        if (!msgs.length) det.createDiv({ cls: 'ks-hint', text: '(전사문 없음)' });
        for (const m of msgs) {
          const row = this.msgRow(det, { ...m, room: c.room, file: c.file, src: c.src }, [], false);
          if (person && m.who === person) row.addClass('is-target');
        }
      }
    }
  }

  msgRow(parent, m, terms, showRoom) {
    const isCall = m.src === 'call';
    const row = parent.createDiv({ cls: 'ks-msg' + (m.who === '나' ? ' is-me' : '') + (isCall ? ' is-call' : '') + (m.who === '요약' ? ' is-summary' : '') });
    row.createSpan({ text: isCall ? (m.off || '요약') : m.time, cls: 'ks-time' });
    if (showRoom && !isCall) row.createSpan({ text: m.room, cls: 'ks-roomtag' });
    if (m.who !== '요약') row.createSpan({ text: m.who, cls: 'ks-who-name' });
    const t = row.createSpan({ cls: 'ks-text' });
    this.highlight(t, clean(m.text), terms);
    row.onclick = () => this.open(m.file, m.line);
    return row;
  }

  highlight(el, text, terms) {
    if (!terms.length) { el.setText(text); return; }
    const low = text.toLowerCase();
    let i = 0;
    while (i < text.length) {
      let at = -1, len = 0;
      for (const t of terms) {
        const k = low.indexOf(t, i);
        if (k >= 0 && (at < 0 || k < at)) { at = k; len = t.length; }
      }
      if (at < 0) { el.appendText(text.slice(i)); break; }
      el.appendText(text.slice(i, at));
      el.createEl('mark', { text: text.slice(at, at + len) });
      i = at + len;
    }
  }

  async open(file, line) {
    this.onOpen();
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(file, { eState: { line: Math.max(0, line) } });
  }
}

class SearchModal extends Modal {
  constructor(plugin, preset) { super(plugin.app); this.plugin = plugin; this.preset = preset; }
  onOpen() {
    this.modalEl.addClass('ks-modal');
    this.titleEl.setText('Rappo 대화·통화 검색');
    this.view = new SearchView(this.plugin, this.contentEl, { onOpen: () => this.close() });
    if (this.plugin.lastState) Object.assign(this.view.state, this.plugin.lastState);
    if (this.preset) Object.assign(this.view.state, { q: '', who: '', from: '', to: '', src: '', mode: 'search', shown: PAGE, shownCall: PAGE }, this.preset);
    this.view.render();
  }
  onClose() { this.plugin.lastState = { ...this.view.state }; this.contentEl.empty(); }
}

// ---------- 최근 연락 (카톡·통화 구분 없이) ----------
class RecentView {
  constructor(plugin, root) { this.plugin = plugin; this.app = plugin.app; this.root = root; this.shown = 20; this.groups = false; this.mode = 'recent'; }
  async render() {
    const r = this.root;
    r.empty();
    r.addClass('ks-root');
    const status = r.createDiv({ cls: 'ks-status', text: '최근 연락 정리 중…' });
    await this.plugin.index.ensure();
    status.remove();
    const bar = r.createDiv({ cls: 'ks-recent-bar' });
    const seg = bar.createDiv({ cls: 'ks-seg' });
    for (const [v, label] of []) {
      const b = seg.createEl('button', { text: label });
      b.toggleClass('is-active', this.mode === v);
      b.onclick = () => { this.mode = v; this.shown = 20; this.render(); };
    }
    const lab = bar.createEl('label', { cls: 'ks-check' });
    const cb = lab.createEl('input', { type: 'checkbox' });
    cb.checked = this.groups;
    lab.appendText(' 단체방 포함');
    cb.onchange = () => { this.groups = cb.checked; this.shown = 20; this.render(); };
    helpTip(bar, this.mode === 'care'
      ? `자주 연락했는데 ${CARE_DAYS}일 넘게 연락이 없는 사람이에요. 오래된 순.`
      : '이름을 누르면 그 사람과의 카톡·통화 전체, 📞/💬 를 누르면 그 노트가 열려요.');
    let list = this.plugin.index.recent().filter((e) => this.groups || !e.group);
    if (this.mode === 'care') {
      // 연락한 날이 3일 이상이고, 마지막 연락이 CARE_DAYS일~1년 사이인 사람 — 평소 간격보다 길어진 사람부터
      list = list.map((e) => {
        const d = [...e.days].sort(), gap = daysSince(e.last.slice(0, 10));
        const span = d.length > 1 ? daysSince(d[0]) - gap : 0;
        return { ...e, gap, every: d.length > 1 ? Math.max(1, Math.round(span / (d.length - 1))) : 0 };
      }).filter((e) => e.days.size >= 3 && e.gap > CARE_DAYS && e.gap <= 365)
        .sort((a, b) => b.gap / (b.every || 1) - a.gap / (a.every || 1));
      if (!list.length) box0(r, '챙길 사람이 없어요. 자주 연락하던 사람과 모두 최근에 연락했어요.');
    }
    const box = r.createDiv({ cls: 'ks-recent' });
    for (const e of list.slice(0, this.shown)) {
      const row = box.createDiv({ cls: 'ks-recent-row' });
      const top = row.createDiv({ cls: 'ks-recent-top' });
      const nm = top.createEl('a', { text: (e.group ? '👥 ' : '') + e.name, cls: 'ks-recent-name' });
      nm.onclick = () => new SearchModal(this.plugin, { room: e.name }).open();
      top.createSpan({ text: this.mode === 'care' ? `${e.gap}일째 연락 없음` + (e.every ? ` · 평소 ${e.every}일마다` : '') : when(...e.last.split(' ')), cls: 'ks-recent-when' + (this.mode === 'care' ? ' is-care' : '') });
      const ch = row.createDiv({ cls: 'ks-recent-ch' });
      const latest = (e.call?.key || '') > (e.talk?.key || '') ? 'call' : 'talk';
      for (const [k, icon, v] of [['call', '📞', e.call], ['talk', '💬', e.talk]]) {
        if (!v) continue;
        const b = ch.createEl('a', { cls: 'ks-badge' + (k === latest ? ' is-latest' : '') });
        b.setText(`${icon} ${when(v.date, v.time)}` + (k === 'call' ? (v.dur ? ` · ${v.dur}` : '') + (e.calls > 1 ? ` · ${e.calls}건` : '') : ''));
        b.onclick = () => this.open(v.file, v.line);
      }
      const last = latest === 'call' ? e.call : e.talk;
      if (last?.text) row.createDiv({ cls: 'ks-recent-text', text: clean(last.text) });
    }
    if (list.length > this.shown) {
      const more = box.createEl('button', { text: `더 보기 (${list.length - this.shown}명 남음)`, cls: 'ks-more' });
      more.onclick = () => { this.shown += 20; this.render(); };
    }
  }
  async open(file, line) {
    await this.app.workspace.getLeaf(false).openFile(file, { eState: { line: Math.max(0, line) } });
  }
}

function box0(r, text) { r.createDiv({ cls: 'ks-hint', text }); }
const CARE_DAYS = 30;

// ---------- 할 일 (<base>/할 일.md — 통화·카톡에서 Rappo 가 찾은 것 + 직접 적은 것) ----------
// 한 줄: - [ ] 할 일 ⏫ 📅 2026-12-03 ⏰ 15:00 👤 홍길동 💬 메모 🔗 [[노트|통화 11/3]] 🆔 ab12cd
//   상태 ' ' 남음 · 'x' 끝냄 · '-' 지움(다시 생기지 않게 남겨 둠)
const TASK_LINE = /^(\s*)-\s+\[(.)\]\s+(.*)$/;
const TASK_MARK = /\s*(⏫|🔼|🔽|📅|⏰|👤|💬|🔗|📝|🆔)\s*/gu;
const PRIO_SYM = { 높음: '⏫', 보통: '🔼', 낮음: '🔽' };
const PRIO_OF = { '⏫': '높음', '🔼': '보통', '🔽': '낮음' };
const PRIO_RANK = { 높음: 0, 보통: 1, '': 1, 낮음: 2 };

function parseTask(raw, line) {
  const m = TASK_LINE.exec(raw);
  if (!m) return null;
  const t = { line, raw, status: m[2], text: '', prio: '', due: '', time: '', who: '', ctx: '', link: '', note: '', id: '' };
  const body = m[3], marks = [...body.matchAll(TASK_MARK)];
  t.text = (marks.length ? body.slice(0, marks[0].index) : body).trim();
  marks.forEach((k, i) => {
    const v = body.slice(k.index + k[0].length, i + 1 < marks.length ? marks[i + 1].index : body.length).trim();
    const s = k[1];
    if (PRIO_OF[s]) t.prio = PRIO_OF[s];
    else if (s === '📅') t.due = v; else if (s === '⏰') t.time = v; else if (s === '👤') t.who = v;
    else if (s === '💬') t.ctx = v; else if (s === '🔗') t.link = v; else if (s === '📝') t.note = v; else if (s === '🆔') t.id = v;
  });
  return t;
}
function taskLine(t) {
  const p = [`- [${t.status || ' '}] ${t.text.trim()}`];
  if (t.prio) p.push(PRIO_SYM[t.prio]);
  if (t.due) p.push(`📅 ${t.due}`);
  if (t.due && t.time) p.push(`⏰ ${t.time}`);
  if (t.who) p.push(`👤 ${t.who}`);
  if (t.ctx) p.push(`💬 ${t.ctx}`);
  if (t.link) p.push(`🔗 ${t.link}`);
  if (t.note) p.push(`📝 ${t.note}`);
  if (t.id) p.push(`🆔 ${t.id}`);
  return p.join(' ');
}
function taskSrc(t) { return /통화/.test(t.link) ? 'call' : /카톡/.test(t.link) ? 'kakao' : 'me'; }
const TASKS_HEAD = `---
tags: [할일]
---
# ✅ 할 일

Rappo 가 통화·카톡에서 **내가 하기로 정한 일**과 확정된 약속을 모아요. 대시보드의 ✅ 할 일 칸에서 우선순위를 바꾸거나 고치고 지울 수 있어요.
직접 적어도 돼요: \`- [ ] 할 일 🔼 📅 2026-12-03 👤 홍길동 💬 메모\` (⏫ 높음 · 🔼 보통 · 🔽 낮음)

## 목록
`;

class Tasks {
  constructor(plugin) { this.plugin = plugin; this.app = plugin.app; this.cache = []; }
  get path() { return `${BASE}/할 일.md`; }
  file() { const f = this.app.vault.getAbstractFileByPath(this.path); return f instanceof TFile ? f : null; }
  async load() {
    const f = this.file();
    if (!f) { this.cache = []; return this.cache; }
    const text = await this.app.vault.cachedRead(f);
    this.cache = text.split('\n').map((l, i) => parseTask(l, i)).filter(Boolean);
    // 이어진 PARA 노트가 바뀌면 할 일도 그대로: 상태(완료·중단·되돌림), 마감(end), 할 일 문장(노트의 첫 체크박스)
    for (const t of this.cache) {
      const nf = this.noteFile(t);
      if (!nf) { t.noteStatus = ''; continue; }
      const fm = this.app.metadataCache.getFileCache(nf)?.frontmatter || {};
      const st = String(fm.status || '');
      t.noteStatus = st;
      const ch = {};
      if (st === '완료' && t.status === ' ') ch.status = 'x';
      else if (st === '중단' && t.status !== '-') ch.status = '-';
      else if ((st === '시작 전' || st === '진행 중') && /[xX]/.test(t.status)) ch.status = ' ';
      const end = fm.end ? String(fm.end).slice(0, 10) : '';
      if (/^\d{4}-\d{2}-\d{2}$/.test(end) && end !== t.due) ch.due = end;
      else if (!end && t.due && 'end' in fm) ch.due = '';
      // 할 일 문장 = 노트 제목 (캘린더 일정 제목도 이걸로)
      if (nf.basename && nf.basename !== t.text) ch.text = nf.basename;
      // 누구와 = 노트 속성 with (연락처 링크)
      const withs = [].concat(fm.with || []).map((x) => String(x).replace(/^\[\[|\]\]$/g, '').split('|').pop()).filter(Boolean);
      if (withs.length && withs.join(', ') !== t.who) ch.who = withs.join(', ');
      if (Object.keys(ch).length) { Object.assign(t, ch); await this.update(t, {}); this.changed = true; }
    }
    return this.cache;
  }
  noteFile(t) {
    const m = /\[\[([^\]|]+)/.exec(t.note || '');
    return m ? this.app.metadataCache.getFirstLinkpathDest(m[1], this.path) : null;
  }
  // 할 일을 끝내거나 되돌리면 이어진 노트 상태도 (완료 / 시작 전)
  async setDone(t, done) {
    await this.update(t, { status: done ? 'x' : ' ' });
    const nf = this.noteFile(t);
    if (nf) await this.app.fileManager.processFrontMatter(nf, (fm) => { fm.status = done ? '완료' : (fm.status === '완료' ? '시작 전' : fm.status); });
  }
  // 할 일을 누르면: 이어진 노트가 있으면 노트, 없으면 출처(통화·카톡·회의)
  open(t, e) {
    const nf = this.noteFile(t);
    const leaf = this.app.workspace.getLeaf(e && (e.metaKey || e.ctrlKey) ? 'tab' : false);
    if (nf) return leaf.openFile(nf);
    const lk = /\[\[([^\]|]+)/.exec(t.link || '');
    if (lk) return this.app.workspace.openLinkText(lk[1], this.path, false);
    return leaf.openFile(this.file(), { eState: { line: t.line } });
  }
  // 연락처 노트가 있으면 [[연락처|이름]]
  contactLink(who) {
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (!f.path.startsWith(CONTACTS + '/')) continue;
      const nm = String(this.app.metadataCache.getFileCache(f)?.frontmatter?.name || '');
      if (f.basename === who || nm === who) return f.basename === who ? `[[${who}]]` : `[[${f.basename}|${who}]]`;
    }
    return who;
  }
  // PARA 를 쓰는 볼트면 할 일마다 '시작 전' 노트 (0. Inbox, 자동 이동 플러그인이 프로젝트 폴더로 옮겨 줌)
  async makeNote(t) {
    if (!this.app.vault.getAbstractFileByPath('0. Inbox')) return '';
    const base = safeName(t.text) || '할 일';
    let name = base, n = 2;
    while (this.app.metadataCache.getFirstLinkpathDest(name, '')) name = `${base} (${n++})`;
    const wl = t.who ? this.contactLink(t.who) : '';
    await this.app.vault.create(`0. Inbox/${name}.md`, `---
type: note
status: 시작 전
area: []
project: []
${wl ? `with:\n  - "${wl.startsWith('[[') ? wl : `[[${wl}]]`}"\n` : ''}end: ${t.due || ''}
created: ${today()}
tags: [할일]
---
## 할 일
- [ ] ${t.text}

${t.who ? `- 누구와: ${this.contactLink(t.who)}\n` : ''}${t.ctx ? `- 무슨 일: ${t.ctx}\n` : ''}${t.link ? `- 출처: ${t.link}\n` : ''}- 할 일 목록: [[할 일]]

## 메모

`);
    return `[[${name}]]`;
  }
  // 한 줄 바꾸기 (🆔 로 찾고, 없으면 원래 줄 그대로인 곳)
  async update(t, changes) {
    const f = this.file();
    if (!f) return;
    await this.app.vault.process(f, (text) => {
      const ls = text.split('\n');
      let i = t.id ? ls.findIndex((l) => l.includes(`🆔 ${t.id}`)) : -1;
      if (i < 0) i = ls[t.line] === t.raw ? t.line : ls.indexOf(t.raw);
      if (i >= 0) ls[i] = taskLine({ ...t, ...changes });
      return ls.join('\n');
    });
  }
  async add(t) {
    if (!t.note) { try { t = { ...t, note: await this.makeNote(t) }; } catch (e) { console.warn('Rappo: 할 일 노트', e); } }
    const line = taskLine({ status: ' ', id: Math.random().toString(16).slice(2, 8), ...t });
    const f = this.file();
    if (f) await this.app.vault.process(f, (text) => text.replace(/\n*$/, '\n') + line + '\n');
    else await this.app.vault.create(this.path, TASKS_HEAD + line + '\n');
  }
}

class TaskModal extends Modal {
  constructor(plugin, task, onSave) { super(plugin.app); this.plugin = plugin; this.task = task || {}; this.onSave = onSave; }
  onOpen() {
    const t = this.task, c = this.contentEl;
    this.titleEl.setText(t.text ? '할 일 고치기' : '할 일 추가');
    c.addClass('ks-task-form');
    const field = (label, el) => { const r = c.createDiv({ cls: 'ks-form-row' }); r.createEl('label', { text: label }); r.appendChild(el); return el; };
    const text = field('할 일', createEl('input', { type: 'text', value: t.text || '', attr: { placeholder: '무엇을 할지 (예: 견적서 보내기)' } }));
    const prio = field('우선순위', createEl('select'));
    for (const p of ['높음', '보통', '낮음']) prio.createEl('option', { value: p, text: `${PRIO_SYM[p]} ${p}` });
    prio.value = t.prio || '보통';
    const due = field('마감', createEl('input', { type: 'date', value: t.due || '' }));
    const time = field('시각', createEl('input', { type: 'time', value: t.time || '' }));
    const who = field('누구와', createEl('input', { type: 'text', value: t.who || '', attr: { placeholder: '약속한 사람' } }));
    const ctx = field('메모', createEl('input', { type: 'text', value: t.ctx || '', attr: { placeholder: '무슨 일 때문인지' } }));
    const btns = c.createDiv({ cls: 'ks-guess-btns' });
    const save = btns.createEl('button', { text: '저장', cls: 'mod-cta' });
    btns.createEl('button', { text: '취소' }).onclick = () => this.close();
    save.onclick = async () => {
      if (!text.value.trim()) { text.focus(); return; }
      await this.onSave({ text: text.value.trim(), prio: prio.value, due: due.value, time: due.value ? time.value : '', who: who.value.trim(), ctx: ctx.value.trim() });
      this.close();
    };
    setTimeout(() => text.focus(), 50);
  }
  onClose() { this.contentEl.empty(); }
}

// ---------- PARA 대상 (프로젝트·영역 노트) ----------
function paraTargets(app) {
  const out = [];
  for (const f of app.vault.getMarkdownFiles()) {
    if (f.path.startsWith('4. Archive/')) continue;
    const fm = app.metadataCache.getFileCache(f)?.frontmatter;
    const ty = fm && String(fm.type || '');
    if (ty === 'project' || ty === 'area') out.push({ name: f.basename, type: ty, status: String(fm.status || ''), path: f.path });
  }
  const rank = (x) => (x.type === 'project' ? (x.status === '진행 중' ? 0 : 1) : 2);
  return out.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, 'ko'));
}
// 입력해서 고르는 칸 (datalist) — 값: 노트 이름 또는 ''
function paraInput(parent, app, value) {
  const targets = paraTargets(app);
  const id = 'rappo-para-' + Math.random().toString(16).slice(2, 8);
  const inp = parent.createEl('input', { type: 'text', value: value || '', attr: { list: id, placeholder: '프로젝트·영역 (비우면 연결 안 함)' } });
  const dl = parent.createEl('datalist', { attr: { id } });
  for (const t of targets) dl.createEl('option', { value: t.name, text: `${t.type === 'project' ? '📁 프로젝트' : '🗂 영역'}${t.status ? ' · ' + t.status : ''}` });
  return { inp, pick: () => targets.find((t) => t.name === inp.value.trim()) || null };
}
function paraFm(target) {
  const link = target ? `\n  - "[[${target.name}]]"` : ' []';
  return `area:${target && target.type === 'area' ? link : ' []'}\nproject:${target && target.type === 'project' ? link : ' []'}`;
}
async function ensureFolder(app, path) {
  let cur = '';
  for (const part of path.split('/')) { cur = cur ? `${cur}/${part}` : part; if (!app.vault.getAbstractFileByPath(cur)) await app.vault.createFolder(cur).catch(() => {}); }
}
function safeName(s) { return String(s || '').replace(/[\\/:*?"<>|#^\[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80); }
function hhmm(d) { return `${pad(d.getHours())}${pad(d.getMinutes())}`; }

// ---------- 회의 녹음 ----------
function micError(e) {
  const n = e && e.name;
  new Notice(n === 'NotFoundError' ? '🎤 연결된 마이크를 찾지 못했어요.'
    : n === 'NotAllowedError' || n === 'SecurityError'
      ? '🎤 마이크가 막혀 있어요. 시스템 설정 › 개인정보 보호 및 보안 › 마이크에서 Obsidian 을 켜고, 옵시디언을 다시 열어 주세요.'
      : `🎤 마이크를 열지 못했어요 (${n || e}).`, 12000);
}
// 마이크 권한 요청 — 처음 한 번 macOS 가 '허용' 창을 띄우고, 그 뒤 시스템 설정 마이크 목록에 Obsidian 이 생긴다
async function askMic() {
  try {
    const st = await navigator.mediaDevices.getUserMedia({ audio: true });
    st.getTracks().forEach((t) => t.stop());
    new Notice('🎤 마이크를 쓸 수 있어요. 회의 녹음 준비 완료!');
    return true;
  } catch (e) { micError(e); return false; }
}
class Recorder {
  constructor(plugin) {
    this.plugin = plugin; this.app = plugin.app; this.rec = null;
    this.bar = plugin.addStatusBarItem();
    this.bar.addClass('ks-rec-bar');
    this.bar.hide();
    this.bar.onclick = () => this.stop();
  }
  get on() { return !!this.rec; }
  elapsed() { const s = Math.floor((Date.now() - this.t0) / 1000); return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`; }
  async start(title, target) {
    if (this.rec) return;
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true } }); }
    catch (e) { micError(e); return; }
    const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
    this.stream = stream; this.chunks = []; this.title = safeName(title) || '회의'; this.target = target; this.t0 = new Date();
    this.rec = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 64000 } : undefined);
    this.mime = this.rec.mimeType || mime || 'audio/webm';
    this.rec.ondataavailable = (e) => { if (e.data && e.data.size) this.chunks.push(e.data); };
    this.rec.start(5000);
    this.bar.show();
    this.plugin.app.workspace.trigger('rappo:rec');
    const tick = () => this.bar.setText(`🔴 회의 녹음 ${this.elapsed()} · 눌러서 끝내기`);
    tick(); this.timer = window.setInterval(tick, 1000);
    new Notice(`🔴 회의 녹음을 시작했어요: ${this.title}\n끝낼 때는 아래 상태 막대나 명령 'Rappo 회의 녹음 끝내기'.`);
  }
  async stop() {
    if (!this.rec) return;
    const rec = this.rec;
    await new Promise((r) => { rec.onstop = r; rec.stop(); });
    this.stream.getTracks().forEach((t) => t.stop());
    window.clearInterval(this.timer);
    this.rec = null; this.bar.hide();
    this.plugin.app.workspace.trigger('rappo:rec');
    const d = this.t0, stamp = `${ymd(d)} ${hhmm(d)}`;
    const ext = /mp4/.test(this.mime) ? 'm4a' : 'webm';
    const audioName = `${stamp} ${this.title}.${ext}`;
    await ensureFolder(this.app, `${BASE}/회의/녹음`);
    const buf = await new Blob(this.chunks, { type: this.mime }).arrayBuffer();
    await this.app.vault.createBinary(`${BASE}/회의/녹음/${audioName}`, buf);
    // 프로젝트·영역에서 시작했으면 그 노트가 있는 폴더에 바로 (아니면 <저장 폴더>/회의)
    const dir = this.target ? this.target.path.split('/').slice(0, -1).join('/') : `${BASE}/회의`;
    await ensureFolder(this.app, dir);
    let notePath = `${dir}/${stamp} ${this.title}.md`, n = 2;
    while (this.app.vault.getAbstractFileByPath(notePath)) notePath = `${dir}/${stamp} ${this.title} (${n++}).md`;
    const note = await this.app.vault.create(notePath, `---
type: note
status: 메모용
${paraFm(this.target)}
created: ${ymd(d)}
title: "${this.title}"
meeting_audio: "${audioName}"
tags: [회의록]
---
# ${this.title}

![[${audioName}]]

> [!note] ⏳ Rappo 가 받아 적고 회의록으로 정리하고 있어요
> 끝나면 이 노트에 회의록 · 내 할 일 · 전사문이 채워지고, 내 할 일은 할 일 목록에도 들어가요.
`);
    await this.app.workspace.getLeaf(false).openFile(note);
    const min = Math.round((Date.now() - d) / 60000);
    new Notice(`⏹ 회의 녹음 저장 (${min}분). Rappo 가 곧 회의록으로 정리해요.`);
  }
}

class MeetingModal extends Modal {
  constructor(plugin, target) { super(plugin.app); this.plugin = plugin; this.target = target || null; }
  onOpen() {
    const c = this.contentEl;
    this.titleEl.setText('🎙 회의 녹음');
    c.addClass('ks-task-form');
    const r1 = c.createDiv({ cls: 'ks-form-row' }); r1.createEl('label', { text: '회의 이름' });
    const title = r1.createEl('input', { type: 'text', value: '', attr: { placeholder: '예: 주간 회의' } });
    const r2 = c.createDiv({ cls: 'ks-form-row' }); r2.createEl('label', { text: '연결' });
    const para = paraInput(r2, this.app, this.target ? this.target.name : '');
    c.createDiv({ cls: 'ks-muted', text: '녹음은 이 볼트에 저장되고, Rappo 앱이 이 맥 안에서 받아 적어 회의록을 만들어요. 참석자에게 녹음한다고 알려 주세요.' });
    const btns = c.createDiv({ cls: 'ks-guess-btns' });
    const go = btns.createEl('button', { text: '🔴 녹음 시작', cls: 'mod-cta' });
    btns.createEl('button', { text: '🎤 마이크 확인' }).onclick = () => askMic();
    btns.createEl('button', { text: '취소' }).onclick = () => this.close();
    go.onclick = async () => { this.close(); await this.plugin.recorder.start(title.value || '회의', para.pick() || this.target); };
    setTimeout(() => title.focus(), 50);
  }
  onClose() { this.contentEl.empty(); }
}

// ---------- PARA 노트 안의 회의 칸: ```회의``` ----------
function targetOf(app, file) {
  const fm = file && app.metadataCache.getFileCache(file)?.frontmatter;
  const ty = fm && String(fm.type || '');
  return ty === 'project' || ty === 'area' ? { name: file.basename, type: ty, status: String(fm.status || ''), path: file.path } : null;
}
// name 이 없으면 모든 회의 (PARA 대시보드용)
function meetingsOf(app, name) {
  const out = [];
  for (const f of app.vault.getMarkdownFiles()) {
    const fm = app.metadataCache.getFileCache(f)?.frontmatter;
    if (!fm || !fm.meeting_audio) continue;
    const links = [].concat(fm.project || [], fm.area || []).map((x) => String(x).replace(/^\[\[|\]\]$/g, '').split('|')[0]);
    if (!name || links.includes(name)) out.push({ file: f, done: !!fm.meeting_done, summary: String(fm.summary || ''), created: String(fm.created || ''), title: String(fm.title || f.basename) });
  }
  return out.sort((a, b) => b.file.basename.localeCompare(a.file.basename));
}
class MeetingsChild extends MarkdownRenderChild {
  constructor(plugin, el, sourcePath) { super(el); this.plugin = plugin; this.sourcePath = sourcePath; }
  onload() {
    this.render();
    this.registerEvent(this.plugin.app.workspace.on('rappo:rec', () => this.render()));
    this.registerEvent(this.plugin.app.metadataCache.on('changed', (f) => { if (this.plugin.app.metadataCache.getFileCache(f)?.frontmatter?.meeting_audio) this.render(); }));
    this.registerInterval(window.setInterval(() => { if (this.plugin.recorder.on && this.btn) this.btn.setText(`⏹ 회의 끝내기 · ${this.plugin.recorder.elapsed()}`); }, 1000));
  }
  render() {
    const app = this.plugin.app, el = this.containerEl, rec = this.plugin.recorder;
    el.empty(); el.addClass('ks-root', 'ks-meet');
    const file = app.vault.getAbstractFileByPath(this.sourcePath);
    const target = file instanceof TFile ? targetOf(app, file) : null;
    const bar = el.createDiv({ cls: 'ks-recent-bar' });
    this.btn = bar.createEl('button', { cls: rec.on ? 'ks-rec-on' : 'mod-cta', text: rec.on ? `⏹ 회의 끝내기 · ${rec.elapsed()}` : '🎙 새 회의' });
    this.btn.onclick = () => rec.on ? rec.stop() : new MeetingModal(this.plugin, target).open();
    if (rec.on) bar.createSpan({ cls: 'ks-muted', text: `녹음 중: ${rec.title}` });
    else helpTip(bar, '녹음을 끝내면 Rappo 가 회의록으로 정리하고, 내가 맡은 일은 할 일 목록에 넣어요.');
    // 프로젝트·영역 노트면 그 노트의 회의, 아니면(PARA 대시보드 등) 최근 회의 전체
    const list = meetingsOf(app, target ? target.name : '');
    if (!list.length) { el.createDiv({ cls: 'ks-hint', text: target ? '아직 이 노트에 연결된 회의가 없어요.' : '아직 회의가 없어요. 🎙 새 회의로 시작해 보세요.' }); return; }
    const box = el.createDiv({ cls: 'ks-recent' });
    if (!target) box.createDiv({ cls: 'ks-muted', text: '최근 회의' });
    for (const m of list.slice(0, target ? 20 : 5)) {
      const row = box.createDiv({ cls: 'ks-recent-row' });
      const top = row.createDiv({ cls: 'ks-recent-top' });
      const a = top.createEl('a', { cls: 'ks-recent-name', text: m.title });
      a.onclick = () => app.workspace.getLeaf(false).openFile(m.file);
      top.createSpan({ cls: 'ks-recent-when', text: (m.done ? '✓ 회의록 · ' : '⏳ 정리 중 · ') + m.file.basename.slice(0, 10) });
      if (m.summary) row.createDiv({ cls: 'ks-recent-text', text: m.summary });
    }
  }
}

// ---------- 회의록의 할 일 (담당자별) — ```회의할일``` ----------
class MeetingTasksChild extends MarkdownRenderChild {
  constructor(plugin, el, sourcePath) { super(el); this.plugin = plugin; this.sourcePath = sourcePath; }
  onload() { this.render(); this.registerEvent(this.plugin.app.metadataCache.on('changed', (f) => { if (f.path === this.sourcePath) this.render(); })); }
  async render() {
    const P = this.plugin, app = P.app, el = this.containerEl;
    const f = app.vault.getAbstractFileByPath(this.sourcePath);
    if (!(f instanceof TFile)) return;
    const text = await app.vault.read(f);
    const lines = text.split('\n');
    const items = lines.map((l, i) => parseTask(l, i)).filter((t) => t && /^m/.test(t.id));
    const people = [...new Set([...text.matchAll(/\*\*([^*]+)\*\*:/g)].map((m) => m[1].trim()))].filter((x) => x && x !== '요약');
    const owners = [...new Set(['나', ...people, ...items.map((t) => t.who).filter(Boolean)])].filter((x) => x !== '미정');
    const fm = app.metadataCache.getFileCache(f)?.frontmatter || {};
    const title = String(fm.title || f.basename);
    const added = P.data.meetAdded || {};
    el.empty(); el.addClass('ks-root', 'rd-root', 'mt-root');
    if (!items.length) { el.createDiv({ cls: 'rd-empty', text: '이 회의에서 나온 할 일이 없어요.' }); return; }
    const groups = new Map();
    for (const t of items) { const k = t.who || '미정'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(t); }
    const order = [...groups.keys()].sort((a, b) => (a === '나' ? -1 : b === '나' ? 1 : a === '미정' ? 1 : b === '미정' ? -1 : a.localeCompare(b, 'ko')));
    const head = el.createDiv({ cls: 'rd-section-head' });
    head.createSpan({ cls: 'rd-section-title', text: `✅ 할 일 ${items.length}개 · 담당자별` });
    const nUn = (groups.get('미정') || []).length;
    if (nUn) head.createSpan({ cls: 'sp-check', text: `담당자 정할 일 ${nUn}개` });
    for (const k of order) {
      const box = el.createDiv({ cls: 'rd-body mt-group' });
      box.createDiv({ cls: 'mt-owner', text: k === '나' ? '🙋 나' : k === '미정' ? '❓ 담당자 미정' : `👤 ${k}` });
      for (const t of groups.get(k)) {
        const x = box.createDiv({ cls: 'rd-list-row' });
        const c = x.createEl('input', { type: 'checkbox' });
        c.checked = /[xX]/.test(t.status);
        c.onchange = () => this.updateLine(f, t, { status: c.checked ? 'x' : ' ' });
        x.createSpan({ cls: 'rd-text' + (c.checked ? ' rd-done' : ''), text: t.text });
        if (t.due) { const n = -daysSince(t.due); x.createSpan({ cls: 'rd-dday' + (n < 0 ? ' over' : n <= 3 ? ' soon' : ''), text: n < 0 ? `${-n}일 지남` : n === 0 ? '오늘' : `D-${n}` }); }
        if (k === '나' && added[t.id] !== false) x.createSpan({ cls: 'rd-chip', text: '내 할 일 목록에 있음' });
        const sel = x.createEl('select', { cls: 'dropdown sp-sel' });
        for (const o of [...owners, '미정']) sel.createEl('option', { value: o, text: o === '나' ? '🙋 나' : o === '미정' ? '❓ 미정' : o });
        sel.createEl('option', { value: '__new', text: '＋ 직접 입력…' });
        sel.value = t.who || '미정';
        sel.onchange = async () => {
          let who = sel.value;
          if (who === '__new') { who = await askText(app, '담당자 이름', '예: 홍길동'); if (!who) { sel.value = t.who || '미정'; return; } }
          await this.updateLine(f, t, { who });
          if (who === '나' && !(P.data.meetAdded || {})[t.id]) {
            // 내 할 일 목록에 추가 (이 회의 노트 링크와 함께)
            await P.tasks.add({ text: t.text, prio: '보통', due: t.due, time: '', who: title, ctx: `회의: ${title}`,
              link: `[[${f.basename}|회의 ${f.basename.slice(5, 10).replace('-', '/')}]]` });
            P.data.meetAdded = { ...(P.data.meetAdded || {}), [t.id]: true };
            await P.saveData(P.data);
            new Notice(`🙋 내 할 일로: ${t.text}`);
          }
        };
      }
    }
  }
  async updateLine(f, t, changes) {
    await this.plugin.app.vault.process(f, (text) => {
      const ls = text.split('\n');
      const i = ls.findIndex((l) => l.includes(`🆔 ${t.id}`));
      if (i >= 0) ls[i] = taskLine({ ...t, ...changes });
      return ls.join('\n');
    });
  }
}

// ---------- 할 일 → PARA 노트 ----------
class ParaModal extends Modal {
  constructor(plugin, task, done) { super(plugin.app); this.plugin = plugin; this.task = task; this.done = done; }
  onOpen() {
    const c = this.contentEl, t = this.task;
    this.titleEl.setText('📝 PARA 할 일 노트 만들기');
    c.addClass('ks-task-form');
    const r1 = c.createDiv({ cls: 'ks-form-row' }); r1.createEl('label', { text: '노트 이름' });
    const name = r1.createEl('input', { type: 'text', value: safeName(t.text) });
    const r2 = c.createDiv({ cls: 'ks-form-row' }); r2.createEl('label', { text: '연결' });
    const para = paraInput(r2, this.app, '');
    const r3 = c.createDiv({ cls: 'ks-form-row' }); r3.createEl('label', { text: '마감' });
    const end = r3.createEl('input', { type: 'date', value: t.due || '' });
    c.createDiv({ cls: 'ks-muted', text: "상태 '시작 전'인 노트로 만들어서 PARA 대시보드의 할 일 보드에 나와요. 프로젝트·영역을 고르면 그 폴더로 옮겨져요." });
    const btns = c.createDiv({ cls: 'ks-guess-btns' });
    const go = btns.createEl('button', { text: '만들기', cls: 'mod-cta' });
    btns.createEl('button', { text: '취소' }).onclick = () => this.close();
    go.onclick = async () => {
      const nm = safeName(name.value) || safeName(t.text);
      let path = `0. Inbox/${nm}.md`, n = 2;
      while (this.app.vault.getAbstractFileByPath(path)) path = `0. Inbox/${nm} (${n++}).md`;
      await ensureFolder(this.app, '0. Inbox');
      const lk = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/.exec(t.link || '');
      const f = await this.app.vault.create(path, `---
type: note
status: 시작 전
${paraFm(para.pick())}
end: ${end.value || ''}
created: ${today()}
---
## 할 일
- [ ] ${t.text}

${t.who ? `- 누구와: ${t.who}\n` : ''}${t.ctx ? `- 무슨 일: ${t.ctx}\n` : ''}${lk ? `- 출처: [[${lk[1]}|${lk[2] || lk[1]}]]\n` : ''}- 할 일 목록: [[할 일]]
`);
      await this.done(f.basename, end.value);
      this.close();
      new Notice(`📝 노트를 만들었어요: ${f.basename}`);
    };
  }
  onClose() { this.contentEl.empty(); }
}

class TodoView {
  constructor(plugin, root) { this.plugin = plugin; this.app = plugin.app; this.root = root; this.view = 'open'; this.src = ''; this.shown = 30; }
  async render() {
    const r = this.root;
    r.empty();
    r.addClass('ks-root');
    const tk = this.plugin.tasks;
    const all = await tk.load();
    this.calIds = new Set((await this.plugin.days.calDone())?.ids || []);
    const bar = r.createDiv({ cls: 'ks-recent-bar' });
    const seg = bar.createDiv({ cls: 'ks-seg' });
    const cnt = (s) => all.filter((t) => t.status === s).length;
    for (const [v, label] of [['open', `남은 일 ${cnt(' ')}`], ['done', `끝낸 일 ${cnt('x') + cnt('X')}`], ['del', `지운 일 ${cnt('-')}`]]) {
      const b = seg.createEl('button', { text: label });
      b.toggleClass('is-active', this.view === v);
      b.onclick = () => { this.view = v; this.shown = 30; this.render(); };
    }
    const seg2 = bar.createDiv({ cls: 'ks-seg' });
    for (const [v, label] of [['', '전체'], ['call', '📞 통화'], ['kakao', '💬 카톡'], ['me', '✏️ 직접']]) {
      const b = seg2.createEl('button', { text: label });
      b.toggleClass('is-active', this.src === v);
      b.onclick = () => { this.src = v; this.render(); };
    }
    const add = bar.createEl('button', { text: '＋ 할 일 추가' });
    add.onclick = () => new TaskModal(this.plugin, null, async (v) => { await tk.add(v); this.render(); }).open();
    const st = { open: [' '], done: ['x', 'X'], del: ['-'] }[this.view];
    const list = all.filter((t) => st.includes(t.status) && (!this.src || taskSrc(t) === this.src))
      .sort((a, b) => (PRIO_RANK[a.prio] - PRIO_RANK[b.prio]) || ((a.due || '9999') .localeCompare(b.due || '9999')) || a.line - b.line);
    if (!list.length) {
      r.createDiv({ cls: 'ks-hint', text: this.view === 'open' ? '남은 할 일이 없어요. 통화·카톡에서 내가 하기로 한 일이 생기면 여기에 모여요.' : '없어요.' });
      return;
    }
    const box = r.createDiv({ cls: 'ks-recent' });
    for (const t of list.slice(0, this.shown)) this.row(box, t);
    if (list.length > this.shown) {
      const more = box.createEl('button', { text: `더 보기 (${list.length - this.shown}개)`, cls: 'ks-more' });
      more.onclick = () => { this.shown += 30; this.render(); };
    }
  }
  async toCalendar(t) {
    const go = async (tt) => {
      this.plugin.data.calTasks = { ...(this.plugin.data.calTasks || {}), [tt.id]: true };
      await this.plugin.saveData(this.plugin.data);
      await this.plugin.days.upcoming();          // calendar.json 다시 쓰기 → Rappo 앱이 캘린더에
      new Notice('📅 캘린더에 넣어요 (Rappo 앱이 곧 반영해요)');
      this.render();
    };
    if (t.due) return go(t);
    new Notice('캘린더에 넣으려면 마감 날짜가 필요해요.');
    new TaskModal(this.plugin, t, async (v) => { await this.plugin.tasks.update(t, v); if (v.due) await go({ ...t, ...v }); else this.render(); }).open();
  }
  async syncNote(t, status) {
    const nl = /\[\[([^\]|]+)/.exec(t.note || '');
    const f = nl && this.app.metadataCache.getFirstLinkpathDest(nl[1], this.plugin.tasks.path);
    if (f) await this.app.fileManager.processFrontMatter(f, (fm) => { fm.status = status; });
  }
  row(box, t) {
    const tk = this.plugin.tasks;
    const row = box.createDiv({ cls: 'ks-todo' + (t.status !== ' ' ? ' is-done' : '') });
    const c = row.createEl('input', { type: 'checkbox' });
    c.checked = t.status === 'x' || t.status === 'X';
    c.disabled = t.status === '-';
    c.onchange = async () => {
      await tk.setDone(t, c.checked);
      this.render();
    };
    const body = row.createDiv({ cls: 'ks-todo-body' });
    const top = body.createDiv({ cls: 'ks-todo-top' });
    const pr = top.createEl('a', { cls: `ks-prio is-${{ 높음: 'high', 보통: 'mid', 낮음: 'low' }[t.prio || '보통']}`, text: t.prio || '보통', attr: { 'aria-label': '눌러서 우선순위 바꾸기' } });
    pr.onclick = async () => { const n = { 높음: '보통', 보통: '낮음', 낮음: '높음', '': '높음' }[t.prio]; await tk.update(t, { prio: n }); this.render(); };
    const tx = top.createEl('a', { cls: 'ks-todo-text rd-link', text: t.text, attr: { 'aria-label': t.note ? '노트 열기 (상세 내용 적기)' : '출처 열기' } });
    tx.onclick = (e) => tk.open(t, e);
    if (t.noteStatus === '진행 중') top.createSpan({ cls: 'pa-pill is-doing', text: '진행 중' });
    if (t.due) {
      const d = -daysSince(t.due);
      top.createSpan({ cls: 'ks-dday' + (d < 0 ? ' is-late' : d <= 3 ? ' is-soon' : ''),
        text: (d < 0 ? `${-d}일 지남` : d === 0 ? '오늘까지' : `D-${d}`) + ` · ${t.due.slice(5).replace('-', '/')}` + (t.time ? ` ${t.time}` : '') });
    }
    const meta = body.createDiv({ cls: 'ks-muted ks-todo-meta' });
    if (t.who) { const a = meta.createEl('a', { text: `👤 ${t.who}`, cls: 'ks-daylink' }); a.onclick = () => new SearchModal(this.plugin, { room: t.who }).open(); }
    if (t.ctx) meta.createSpan({ text: `💬 ${t.ctx}` });
    const lk = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/.exec(t.link || '');
    if (lk) { const a = meta.createEl('a', { text: `🔗 ${lk[2] || lk[1]}`, cls: 'ks-daylink' }); a.onclick = () => this.app.workspace.openLinkText(lk[1], this.plugin.tasks.path, false); }
    const act = row.createDiv({ cls: 'ks-todo-act' });
    if (t.status === ' ') {
      const inCal = this.calIds.has(`task:${t.id}`), asked = !!(this.plugin.data.calTasks || {})[t.id] || (this.plugin.data.autoCalTasks !== false && !!t.due && /통화|카톡|회의/.test(t.link || ''));
      const cal = act.createEl('a', { text: inCal ? '📅✓' : asked ? '📅…' : '📅', attr: { 'aria-label': inCal ? '캘린더에 들어감' : asked ? '캘린더에 넣는 중 (Rappo 앱)' : '캘린더에 넣기' } });
      if (!inCal && !asked) cal.onclick = () => this.toCalendar(t);
      const nl = /\[\[([^\]|]+)/.exec(t.note || '');
      const pn = act.createEl('a', { text: nl ? '📝✓' : '📝', attr: { 'aria-label': nl ? 'PARA 노트 열기' : 'PARA 할 일 노트 만들기' } });
      pn.onclick = () => nl ? this.app.workspace.openLinkText(nl[1], tk.path, false)
        : new ParaModal(this.plugin, t, async (name, end) => { await tk.update(t, { note: `[[${name}]]`, due: t.due || end }); this.render(); }).open();
    }
    const ed = act.createEl('a', { text: '✏️', attr: { 'aria-label': '고치기' } });
    ed.onclick = () => new TaskModal(this.plugin, t, async (v) => { await tk.update(t, v); this.render(); }).open();
    if (t.status === '-' && this.calIds.has(`task:${t.id}`)) {
      const rm = act.createEl('a', { cls: 'sp-check', text: '📅 캘린더에서도 지우기', attr: { 'aria-label': '캘린더에 남아 있는 이 일정을 지워요' } });
      rm.onclick = async () => {
        if (!window.confirm(`'${t.text}' 일정을 캘린더에서 지울까요?`)) return;
        this.plugin.data.calRemove = { ...(this.plugin.data.calRemove || {}), [`task:${t.id}`]: true };
        await this.plugin.saveData(this.plugin.data);
        await this.plugin.days.upcoming();
        new Notice('📅 캘린더에서 지워요 (Rappo 앱이 곧 반영해요)');
        this.render();
      };
    }
    if (t.status === '-') {
      const back = act.createEl('a', { text: '↩︎', attr: { 'aria-label': '되살리기' } });
      back.onclick = async () => { await tk.update(t, { status: ' ' }); this.render(); };
    } else {
      const del = act.createEl('a', { text: '🗑', attr: { 'aria-label': '지우기 (잘못 생긴 할 일)' } });
      del.onclick = async () => {
        await tk.update(t, { status: '-' });
        if (this.calIds.has(`task:${t.id}`)) new Notice('캘린더 일정은 그대로 둬요. 지운 일 목록에서 「📅 캘린더에서도 지우기」를 누르면 지워져요.', 8000);
        this.render();
      };
    }
  }
}

class TodoChild extends MarkdownRenderChild {
  constructor(plugin, el) { super(el); this.plugin = plugin; }
  onload() { new TodoView(this.plugin, this.containerEl).render(); }
}

class RecentChild extends MarkdownRenderChild {
  constructor(plugin, el) { super(el); this.plugin = plugin; }
  onload() { new RecentView(this.plugin, this.containerEl).render(); }
}

class BlockChild extends MarkdownRenderChild {
  constructor(plugin, el) { super(el); this.plugin = plugin; }
  onload() { this.containerEl.addClass('ks-block'); new SearchView(this.plugin, this.containerEl).render(); }
}

// ---------- 챙길 날: 생일·기념일·관계별 날 (어버이날, 설·추석 …) ----------
// 직접 적는 곳: <base>/챙길 날.md 의 "- 이름 | 종류 | 날짜" 줄, 또는 연락처 노트의 birthday / relation 속성.
//   - 엄마 | 관계 | 부모          → 어버이날·설·추석에 엄마가 함께 표시
//   - 엄마 | 생일 | 음력 03-15     → 해마다 음력 3월 15일
//   - 홍길동 | 결혼기념일 | 2020-10-03 → 해마다 10월 3일 (몇 주년인지도)
// 카톡에서 "생일 축하" 한 날을 찾아 생일 후보도 보여 주고, 저장하면 위 노트에 한 줄이 생긴다.
const DATE_RE = /^(음력\s*)?(?:(\d{4})[-.\/])?(\d{1,2})[-.\/](\d{1,2})$/;
const LINE_RE = /^\s*[-*]\s+([^|]+?)\s*\|\s*([^|]+?)\s*(?:\|\s*([^|]*?)\s*)?(?:\|\s*(.*?)\s*)?$/;
const CONG_RE = /생일\s*(?:을\s*)?(?:축하|ㅊㅋ)|생축|해피\s*버스?데이|happy\s*birth/i;
const THANK_RE = /고마|고맙|감사|땡큐|ㄳ|ㄱㅅ|thank/i;
// 관계별로 챙길 날: 대화에서 올해 이미 이야기했거나, 2해 이상 그 사람과 그 무렵 연락(언급·통화)한 경우에만
const HOLIDAYS = [
  { label: '어버이날', m: 5, d: 8, lunar: false, kw: /어버이날|카네이션/ },
  { label: '스승의 날', m: 5, d: 15, lunar: false, kw: /스승의\s*날/ },
  { label: '어린이날', m: 5, d: 5, lunar: false, kw: /어린이날/ },
  { label: '설날', m: 1, d: 1, lunar: true, kw: /설날|설\s*연휴|세배|떡국|새해\s*복|명절/ },
  { label: '추석', m: 8, d: 15, lunar: true, kw: /추석|송편|한가위|성묘|명절/ },
];
// 대화 속 일정: 날짜 표현 + 약속 말이 함께 있는 메시지
const PLAN_KW = /보자|봐요|봬요|뵐게|뵙|볼까|만나|만날|약속|예약|미팅|회의|모임|방문|가자|갈게|올게|오기로|가기로|하기로|출발|픽업|데리러|식사|점심|저녁\s*먹|밥\s*먹|일정|잡자|잡을게|진료|병원|시술|상담|면접|수업|레슨/;
const WD = '일월화수목금토';
const AHEAD = 400;
// 음력은 한국 기준(단기력, dangi) — 중국 음력과 하루 다른 해가 있다 (예: 2027 설날은 한국 2/7, 중국 2/6)
const LUNAR = (() => {
  for (const c of ['dangi', 'chinese']) {
    try { const f = new Intl.DateTimeFormat(`ko-KR-u-ca-${c}`, { month: 'numeric', day: 'numeric' }); if (f.resolvedOptions().calendar === c) return f; } catch (e) { /* 다음 */ }
  }
  return null;
})();

function ymd(x) { return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`; }
function lunarOf(x) {
  if (!LUNAR) return null;
  const p = LUNAR.formatToParts(x), m = p.find((v) => v.type === 'month').value, d = p.find((v) => v.type === 'day').value;
  return { leap: /윤|bis/.test(m), m: Number(m.replace(/\D/g, '')), d: Number(d.replace(/\D/g, '')) };
}
// 오늘부터 AHEAD일 동안의 양력·음력 날짜 표 (한 번 만들어 재사용)
let CAL = null, CAL_DAY = '';
function calendar() {
  if (CAL && CAL_DAY === today()) return CAL;
  CAL_DAY = today(); CAL = [];
  const t = new Date(CAL_DAY + 'T12:00:00');
  for (let i = 0; i < AHEAD; i++) {
    const x = new Date(t); x.setDate(t.getDate() + i);
    CAL.push({ i, date: ymd(x), m: x.getMonth() + 1, d: x.getDate(), l: lunarOf(x) });
  }
  return CAL;
}
// 다음에 오는 그날 (없는 날이면 하루 앞당겨: 2/29 → 2/28, 음력 30일 → 29일)
function nextOf(m, d, lunar) {
  const cal = calendar();
  for (const dd of [d, d - 1]) {
    const hit = cal.find((c) => lunar ? c.l && !c.l.leap && c.l.m === m && c.l.d === dd : c.m === m && c.d === dd);
    if (hit) return hit;
  }
  return null;
}
function parseDate(v) {
  const k = DATE_RE.exec(String(v || '').trim());
  return k ? { lunar: !!k[1], year: k[2] ? Number(k[2]) : 0, m: Number(k[3]), d: Number(k[4]) } : null;
}
function mdText(e) { return `${e.lunar ? '음력 ' : ''}${e.m}월 ${e.d}일`; }
function addDays(d, n) { const x = new Date(d + 'T12:00:00'); x.setDate(x.getDate() + n); return ymd(x); }
function validYmd(y, m, d) { const x = new Date(y, m - 1, d, 12); return x.getMonth() === m - 1 && x.getDate() === d ? ymd(x) : ''; }
// 메시지 한 줄에서 날짜·시각 (base: 메시지를 보낸 날)
function planWhen(text, base) {
  const by = Number(base.slice(0, 4));
  let date = '', k;
  if ((k = /(?:(\d{4})년\s*)?(\d{1,2})월\s*(\d{1,2})일/.exec(text))) {
    date = validYmd(k[1] ? Number(k[1]) : by, Number(k[2]), Number(k[3]));
    if (date && !k[1] && date < base) date = validYmd(by + 1, Number(k[2]), Number(k[3]));
  } else if ((k = /(?<![\d.\/:])(\d{1,2})\/(\d{1,2})(?![\d\/])/.exec(text))) {
    date = validYmd(by, Number(k[1]), Number(k[2]));
    if (date && date < base) date = validYmd(by + 1, Number(k[1]), Number(k[2]));
  } else if ((k = /(오늘|내일|낼|모레|글피)/.exec(text))) {
    date = addDays(base, { 오늘: 0, 내일: 1, 낼: 1, 모레: 2, 글피: 3 }[k[1]]);
  } else if ((k = /(이번\s*주|다다음\s*주|다음\s*주|담주)?\s*([월화수목금토일])요일/.exec(text))) {
    const b = new Date(base + 'T12:00:00').getDay(), t = WD.indexOf(k[2]);
    const mon = addDays(base, -((b + 6) % 7));            // 이번 주 월요일
    const off = (t + 6) % 7;                               // 월=0 … 일=6
    const w = (k[1] || '').replace(/\s/g, '');
    if (w === '이번주') date = addDays(mon, off);
    else if (w === '다음주' || w === '담주') date = addDays(mon, 7 + off);
    else if (w === '다다음주') date = addDays(mon, 14 + off);
    else { let n = (t - b + 7) % 7; if (n === 0) n = 7; date = addDays(base, n); }
  }
  if (!date) return null;
  let time = '';
  if ((k = /(오전|오후|아침|점심|저녁|밤|새벽|낮)?\s*(\d{1,2})\s*시(?!간|쯤에?\s*끝)\s*(?:(\d{1,2})\s*분|(반))?/.exec(text))) {
    let h = Number(k[2]); const mm = k[3] ? Number(k[3]) : k[4] ? 30 : 0;
    if (/오후|저녁|밤/.test(k[1] || '') && h < 12) h += 12;
    else if (/점심|낮/.test(k[1] || '') && h <= 5) h += 12;
    else if (!k[1] && h >= 1 && h <= 7) h += 12;
    if (h <= 24 && mm < 60) time = `${pad(h % 24)}:${pad(mm)}`;
  } else if ((k = /(?<!\d)(\d{1,2}):(\d{2})(?!\d)/.exec(text))) {
    if (Number(k[1]) < 24 && Number(k[2]) < 60) time = `${pad(Number(k[1]))}:${k[2]}`;
  }
  return { date, time };
}
// 그해의 음력 날짜 → 양력 (명절 근거 찾기용)
const LUNAR_YEAR = new Map();
function lunarIn(year, m, d) {
  const key = `${year}`;
  if (!LUNAR_YEAR.has(key)) {
    const map = new Map();
    const x = new Date(year, 0, 1, 12);
    while (x.getFullYear() === year) { const l = lunarOf(x); if (l && !l.leap) { const k2 = `${l.m}-${l.d}`; if (!map.has(k2)) map.set(k2, ymd(x)); } x.setDate(x.getDate() + 1); }
    LUNAR_YEAR.set(key, map);
  }
  return LUNAR_YEAR.get(key).get(`${m}-${d}`) || '';
}

class Days {
  constructor(plugin) { this.plugin = plugin; this.app = plugin.app; }
  get notePath() { return `${BASE}/챙길 날.md`; }

  // 노트·연락처 속성에서 사람별 관계와 날짜를 모은다
  async load() {
    const dated = [], dismissed = new Set();
    const f = this.app.vault.getAbstractFileByPath(this.notePath);
    if (f instanceof TFile) {
      const text = await this.app.vault.cachedRead(f);
      // "## 목록" 제목이 있으면 그 아래만 읽는다 (위쪽 설명의 예시는 건너뜀)
      const start = text.split('\n').findIndex((l) => /^##\s*목록/.test(l));
      text.split('\n').forEach((l, line) => {
        if (line < start) return;
        const k = LINE_RE.exec(l);
        if (!k) return;
        const [, name, kind, val = '', memo = ''] = k;
        if (kind === '무시') dismissed.add(`${name}|${val || '생일'}`);
        else { const p = parseDate(val); if (p) dated.push({ name, label: kind, memo, line, ...p }); }
      });
    }
    for (const c of this.app.vault.getMarkdownFiles()) {
      if (!c.path.startsWith(CONTACTS + '/')) continue;
      const fm = this.app.metadataCache.getFileCache(c)?.frontmatter;
      if (!fm) continue;
      const nm = String(fm.name || '').trim();
      const name = nm && nm !== '정보 없음' ? nm : String(fm.phone || c.basename);
      for (const [key, label] of [['birthday', '생일'], ['anniversary', '기념일']]) {
        const p = parseDate(fm[key]);
        if (p && !dated.some((x) => x.name === name && x.label === label)) dated.push({ name, label, memo: '', ...p, file: c });
      }
    }
    return { dated, dismissed };
  }

  // 카톡에서 생일 후보: 1:1 방에서 내가 "생일 축하"한 날, 단체방에서 이름을 불러 축하하거나 축하받고 고마워한 사람
  infer() {
    const hits = new Map();
    const add = (name, date) => { if (!name || name === '나') return; const s = hits.get(name) || new Set(); s.add(date); hits.set(name, s); };
    for (const c of this.plugin.index.files.values()) {
      if (c.src !== 'kakao') continue;
      const byDay = new Map();
      for (const m of c.msgs) { if (!byDay.has(m.date)) byDay.set(m.date, []); byDay.get(m.date).push(m); }
      const people = new Set(c.msgs.map((m) => m.who).filter((w) => w !== '나'));
      for (const [date, ms] of byDay) {
        const cong = ms.filter((m) => CONG_RE.test(m.text));
        if (!cong.length) continue;
        if (c.kind !== '단체') { if (cong.some((m) => m.who === '나')) add(c.room, date); continue; }
        let named = false;
        for (const m of cong) for (const p of people) {
          if (p === m.who) continue;
          const given = p.length >= 3 ? p.slice(1) : '';
          if (m.text.includes(p) || (given && m.text.includes(given))) { add(p, date); named = true; }
        }
        if (named) continue;
        const who = new Set(cong.map((m) => m.who)), first = cong[0].time;
        const thank = new Set(ms.filter((m) => m.time >= first && !who.has(m.who) && THANK_RE.test(m.text)).map((m) => m.who));
        if (thank.size === 1) add([...thank][0], date);
      }
    }
    // 해마다 같은 양력 날인지, 음력 날인지 — 앞뒤 2일 안의 축하를 같은 날로 센다
    const out = [];
    for (const [name, set] of hits) {
      const ds = [...set].sort().map((s) => { const x = new Date(s + 'T12:00:00'); return { s, x, l: lunarOf(x) }; });
      const best = (key, doy) => {
        let top = null;
        for (const a of ds) {
          const k = key(a); if (!k) continue;
          const sup = new Set(ds.filter((b) => { const kb = key(b); return kb && Math.abs(doy(kb) - doy(k)) <= 2; }).map((b) => b.s.slice(0, 4))).size;
          const exact = ds.filter((b) => { const kb = key(b); return kb && kb.m === k.m && kb.d === k.d; }).length;
          if (!top || sup > top.sup || (sup === top.sup && exact > top.exact)) top = { ...k, sup, exact };
        }
        return top;
      };
      const solar = best((a) => ({ m: a.x.getMonth() + 1, d: a.x.getDate() }), (k) => k.m * 31 + k.d);
      const lunar = LUNAR ? best((a) => (a.l && !a.l.leap ? { m: a.l.m, d: a.l.d } : null), (k) => k.m * 30 + k.d) : null;
      const pickL = lunar && solar && lunar.sup > solar.sup;
      const b = pickL ? lunar : solar;
      if (b) out.push({ name, m: b.m, d: b.d, lunar: !!pickL, years: b.sup, last: ds[ds.length - 1].s });
    }
    return out.sort((a, b) => b.years - a.years || b.last.localeCompare(a.last));
  }

  // 명절·기념일마다 근거가 있는 방·사람: {name: {years:Set, planned}}
  holidayWho(h, next) {
    const who = new Map();
    const files = [...this.plugin.index.files.values()];
    let first = today();
    for (const c of files) { const d = c.call ? c.call.date : c.msgs[0]?.date; if (d && d < first) first = d; }
    const occ = [];
    for (let y = Number(first.slice(0, 4)); y <= Number(today().slice(0, 4)); y++) {
      const d = h.lunar ? lunarIn(y, h.m, h.d) : validYmd(y, h.m, h.d);
      if (d && d < today()) occ.push(d);
    }
    const hit = (name, key, val) => { const e = who.get(name) || { years: new Set(), planned: false }; if (key === 'y') e.years.add(val); else e.planned = true; who.set(name, e); };
    for (const c of files) {
      if (c.kind === '단체' && new Set(c.msgs.map((m) => m.who)).size > 8) continue;
      for (const o of occ) {
        const lo = addDays(o, -10), hi = addDays(o, 2);
        if (c.call) { if (c.call.date >= addDays(o, -1) && c.call.date <= addDays(o, 1)) hit(c.room, 'y', o.slice(0, 4)); }
        if (c.msgs.some((m) => m.date >= lo && m.date <= hi && h.kw.test(m.text))) hit(c.room, 'y', o.slice(0, 4));
      }
      // 올해 그날을 앞두고 이미 이야기한 경우
      if (next && c.msgs.some((m) => m.date >= addDays(next.date, -40) && m.date <= today() && h.kw.test(m.text))) hit(c.room, 'p');
    }
    return [...who].filter(([, e]) => e.years.size >= 2 || e.planned);
  }

  // 대화 속 일정 후보: 최근 60일 메시지에서, 오늘~180일 뒤의 날짜
  plans() {
    const td = today(), from = addDays(td, -60), until = addDays(td, 180), out = new Map();
    for (const c of this.plugin.index.files.values()) {
      if (c.src !== 'kakao') continue;
      for (const m of c.msgs) {
        if (m.date < from || !PLAN_KW.test(m.text)) continue;
        const w = planWhen(m.text, m.date);
        if (!w || w.date < td || w.date > until) continue;
        const key = `kakao|${c.room}|${w.date}|${w.time}`;
        const prev = out.get(key);
        if (!prev || `${m.date} ${m.time}` > prev.said) out.set(key, { id: 'plan:' + key, ...w, room: c.room, src: 'kakao', who: m.who, text: m.text, file: c.file, line: m.line, said: `${m.date} ${m.time}` });
      }
    }
    // 할 일 중 날짜·시각이 정해진 약속 (통화·카톡에서 AI 가 찾은 것)
    const tf = this.plugin.tasks.file();
    for (const t of this.plugin.tasks.cache || []) {
      if (t.status !== ' ' || !t.due || !t.time || t.due < td || t.due > until) continue;
      const key = `task|${t.id || t.text}`;
      out.set(key, { id: 'plan:' + key, date: t.due, time: t.time, room: t.who || '나', src: taskSrc(t) === 'call' ? 'call' : 'kakao', text: t.text + (t.ctx ? ` (${t.ctx})` : ''), file: tf, line: t.line, said: '할 일' });
    }
    return [...out.values()].sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
  }

  // 다가오는 날 목록 [{date, dday, title, label, names[], kind, guess?}]
  async upcoming() {
    await this.plugin.index.ensure();
    await this.plugin.tasks.load();
    const { dated, dismissed } = await this.load();
    const ev = [];
    const push = (hit, o) => { if (hit) ev.push({ date: hit.date, dday: hit.i, ...o }); };
    for (const e of dated) {
      const hit = nextOf(e.m, e.d, e.lunar);
      let label = e.label;
      if (e.year && e.label !== '생일' && hit) { const n = Number(hit.date.slice(0, 4)) - e.year; if (n > 0) label += ` ${n}주년`; }
      push(hit, { title: `${e.name} ${label}`, label, names: [e.name], kind: e.label === '생일' ? 'birth' : 'anniv', sub: mdText(e) + (e.memo ? ` · ${e.memo}` : '') });
    }
    // 관계별로 챙길 날 (근거 있는 사람·방만)
    for (const h of HOLIDAYS) {
      if (h.lunar && !LUNAR) continue;
      const next = nextOf(h.m, h.d, h.lunar);
      const who = this.holidayWho(h, next);
      if (!who.length) continue;
      const names = who.map(([n]) => n);
      const why = who.slice(0, 4).map(([n, e]) => `${n}(${e.planned ? '대화에서 이야기함' : e.years.size + '해째'})`).join(', ') + (who.length > 4 ? ` 외 ${who.length - 4}` : '');
      push(next, { title: h.label, label: h.label, names, kind: 'holiday', sub: (h.lunar ? `음력 ${h.m}월 ${h.d}일 · ` : '') + why });
    }
    // 카톡에서 찾은 생일 후보 (저장·무시하지 않은 것)
    const saved = new Set(dated.filter((e) => e.label === '생일').map((e) => e.name));
    const guesses = this.infer().filter((g) => !saved.has(g.name) && !dismissed.has(`${g.name}|생일`));
    for (const g of guesses) push(nextOf(g.m, g.d, g.lunar), { title: `${g.name} 생일`, label: '생일', names: [g.name], kind: 'birth', guess: g, sub: mdText(g) + ' · 카톡에서 추정' });
    ev.sort((a, b) => a.dday - b.dday || a.title.localeCompare(b.title, 'ko'));
    this.writeOut(ev);
    const plans = this.plans();
    this.writeCal(ev, plans);
    return { ev, guesses, plans };
  }

  // 메뉴막대 앱이 읽어 맥 알림을 띄우는 파일 (확정된 날만)
  async writeOut(ev) {
    try {
      const out = ev.filter((e) => !e.guess).map((e) => ({ date: e.date, title: e.title, sub: e.sub || '' }));
      const s = JSON.stringify({ made: today(), events: out }, null, 1);
      const p = `${this.plugin.manifest.dir}/upcoming.json`;
      if (this.lastOut !== s) { await this.app.vault.adapter.write(p, s); this.lastOut = s; }
    } catch (e) { console.warn('Rappo: upcoming.json', e); }
  }

  // 메뉴막대 앱이 읽어 캘린더에 넣는 파일: 확정된 챙길 날(60일 안) + 넣기로 한 대화 일정
  async writeCal(ev, plans) {
    try {
      const st = this.plugin.data.plans || {};
      const auto = !!this.plugin.data.autoPlan;
      const events = ev.filter((e) => !e.guess && e.dday <= 60).map((e) => ({ id: `day:${e.title}:${e.date}`, title: (e.kind === 'birth' ? '🎂 ' : e.kind === 'anniv' ? '💐 ' : '🗓 ') + e.title, date: e.date, time: '', notes: e.sub || '' }));
      for (const p of plans) {
        const s0 = st[p.id];
        if (s0 === 'no' || (!s0 && !(auto && p.time))) continue;
        events.push({ id: p.id, title: `${p.room} · ${clean(p.text).slice(0, 40)}`, date: p.date, time: p.time,
          notes: `${p.src === 'call' ? '통화' : '카톡'} ${p.room} (${p.said})\n${p.who ? p.who + ': ' : ''}${clean(p.text)}` });
      }
      const ct = this.plugin.data.calTasks || {};
      // 통화·카톡·회의에서 찾은 할 일은 마감이 있으면 자동으로 캘린더에 (끌 수 있음: data.autoCalTasks=false)
      const autoT = this.plugin.data.autoCalTasks !== false;
      for (const t of this.plugin.tasks.cache || []) {
        const fromTalk = /통화|카톡|회의/.test(t.link || '');
        if (!(ct[t.id] || (autoT && fromTalk)) || !t.due || t.status === '-') continue;
        // 캘린더 메모 = 할 일 노트 내용 (노트를 고치면 메모도 바뀜)
        let body = '';
        const nf = this.plugin.tasks.noteFile(t);
        if (nf) {
          try {
            body = (await this.app.vault.cachedRead(nf)).replace(/^---\n[\s\S]*?\n---\n?/, '')
              .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2').replace(/\[\[([^\]]+)\]\]/g, '$1')
              .replace(/^- 할 일 목록: 할 일\s*$/m, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 2000);
          } catch (e) { body = ''; }
        }
        events.push({ id: `task:${t.id}`, update: true, title: `✅ ${t.text}`, date: t.due, time: t.time || '',
          notes: body || [t.who && `누구와: ${t.who}`, t.ctx && `무슨 일: ${t.ctx}`].filter(Boolean).join('\n') });
      }
      // 캘린더에서 지우기는 사용자가 확인한 것만 (지운 할 일 → '캘린더에서도 지우기'를 눌렀을 때)
      const remove = Object.keys(this.plugin.data.calRemove || {});
      const s = JSON.stringify({ made: today(), events, remove }, null, 1);
      if (this.lastCal !== s) { await this.app.vault.adapter.write(`${this.plugin.manifest.dir}/calendar.json`, s); this.lastCal = s; }
    } catch (e) { console.warn('Rappo: calendar.json', e); }
  }
  // 앱이 캘린더에 넣은 것 {calendar, ids[]}
  async calDone() {
    try { return JSON.parse(await this.app.vault.adapter.read(`${this.plugin.manifest.dir}/calendar-done.json`)); } catch (e) { return null; }
  }
  async setPlan(id, v) {
    this.plugin.data.plans = this.plugin.data.plans || {};
    this.plugin.data.plans[id] = v;
    await this.plugin.saveData(this.plugin.data);
  }

  async append(line) {
    const p = this.notePath;
    const f = this.app.vault.getAbstractFileByPath(p);
    if (f instanceof TFile) await this.app.vault.process(f, (t) => t.replace(/\n*$/, '\n') + line + '\n');
    else await this.app.vault.create(p, DAYS_NOTE + line + '\n');
  }
  async openNote() {
    let f = this.app.vault.getAbstractFileByPath(this.notePath);
    if (!(f instanceof TFile)) f = await this.app.vault.create(this.notePath, DAYS_NOTE);
    await this.app.workspace.getLeaf(false).openFile(f);
  }
}

const DAYS_NOTE = `---
tags: [대시보드]
---
# 🎂 챙길 날

Rappo 대시보드의 **챙길 날**과 맥 알림이 이 목록을 읽어요. 한 줄에 하나씩 \`- 이름 | 종류 | 날짜(또는 관계)\` 로 적어요.
- 날짜: \`05-03\`, \`음력 03-15\`, 연도를 넣으면 기념일은 몇 주년인지도 보여요 (\`2020-10-03\`).
- 어버이날·설·추석 같은 날은 따로 적지 않아도 돼요. 올해 대화에서 이미 이야기했거나, 2해 이상 그 무렵 그 사람과 연락(이야기·통화)했으면 자동으로 나타나요.

예)
- 엄마 | 생일 | 음력 03-15
- 홍길동 | 결혼기념일 | 2020-10-03 | 꽃 준비

## 목록
`;

class DaysView {
  constructor(plugin, root) { this.plugin = plugin; this.app = plugin.app; this.root = root; this.range = 60; }
  async render() {
    const r = this.root;
    r.empty();
    r.addClass('ks-root');
    const status = r.createDiv({ cls: 'ks-status', text: '챙길 날 찾는 중…' });
    const { ev, guesses, plans } = await this.plugin.days.upcoming();
    const done = await this.plugin.days.calDone();
    status.remove();
    this.planSection(r, plans, done);
    const bar = r.createDiv({ cls: 'ks-recent-bar' });
    const seg = bar.createDiv({ cls: 'ks-seg' });
    for (const [v, label] of [[30, '30일'], [60, '60일'], [AHEAD, '1년']]) {
      const b = seg.createEl('button', { text: label });
      b.toggleClass('is-active', this.range === v);
      b.onclick = () => { this.range = v; this.render(); };
    }
    const add = bar.createEl('button', { text: '✏️ 날짜·관계 적기' });
    add.onclick = () => this.plugin.days.openNote();
    helpTip(bar, '7일·3일·1일 전과 당일에 맥 알림으로 알려 주고, 60일 안의 날은 캘린더에도 넣어요. ✏️ 날짜·관계 적기에서 생일·기념일을 직접 적을 수 있어요.');
    const list = ev.filter((e) => e.dday <= this.range);
    if (!list.length) r.createDiv({ cls: 'ks-hint', text: `앞으로 ${this.range === AHEAD ? '1년' : this.range + '일'} 안에 챙길 날이 없어요. 생일·관계를 적으면 여기 나타나요.` });
    const box = r.createDiv({ cls: 'ks-recent' });
    const recent = new Map(this.plugin.index.recent().map((e) => [e.name, e.last]));
    for (const e of list) {
      const row = box.createDiv({ cls: 'ks-day-row' + (e.guess ? ' is-guess' : '') });
      row.createSpan({ cls: 'ks-dday' + (e.dday <= 7 ? ' is-soon' : ''), text: e.dday === 0 ? '오늘' : `D-${e.dday}` });
      const body = row.createDiv({ cls: 'ks-todo-body' });
      const icon = e.kind === 'birth' ? '🎂' : e.kind === 'anniv' ? '💐' : '🗓';
      body.createDiv({ cls: 'ks-todo-text', text: `${icon} ${e.title}  ` }).createSpan({ cls: 'ks-muted', text: `${e.date.slice(5).replace('-', '/')} (${weekday(e.date)})` });
      const meta = body.createDiv({ cls: 'ks-muted' });
      meta.appendText(e.sub || '');
      if (e.names.length === 1) {
        const last = recent.get(e.names[0]);
        if (last) meta.appendText(` · 마지막 연락 ${daysSince(last.slice(0, 10))}일 전`);
        const a = meta.createEl('a', { text: ' 대화 보기', cls: 'ks-daylink' });
        a.onclick = () => new SearchModal(this.plugin, { room: e.names[0] }).open();
      }
      if (e.guess) this.guessButtons(body, e.guess);
    }
    // 아직 다가오지 않아 위에 없는 후보도 확인할 수 있게
    const later = guesses.filter((g) => !list.some((e) => e.guess === g));
    if (later.length) {
      const det = r.createEl('details', { cls: 'ks-section' });
      det.createEl('summary', { cls: 'ks-section-head', text: `🔎 카톡에서 찾은 생일 후보 ${later.length}명 — 맞으면 저장해 주세요` });
      for (const g of later) {
        const row = det.createDiv({ cls: 'ks-day-row is-guess' });
        const body = row.createDiv({ cls: 'ks-todo-body' });
        body.createDiv({ cls: 'ks-todo-text', text: `🎂 ${g.name} · ${mdText(g)}` });
        body.createDiv({ cls: 'ks-muted', text: `${g.years}해 축하한 기록 · 마지막 ${g.last}` });
        this.guessButtons(body, g);
      }
    }
  }
  // 📅 대화에서 정한 일정 → 캘린더
  planSection(r, plans, done) {
    const st = this.plugin.data.plans || {}, auto = !!this.plugin.data.autoPlan;
    const ids = new Set(done?.ids || []);
    const list = plans.filter((p) => st[p.id] !== 'no');
    const sec = r.createDiv({ cls: 'ks-section is-call' });
    const head = sec.createDiv({ cls: 'ks-recent-bar' });
    head.createSpan({ cls: 'ks-section-title', text: `📅 대화에서 정한 일정 ${list.length}개` });
    const lab = head.createEl('label', { cls: 'ks-check' });
    const cb = lab.createEl('input', { type: 'checkbox' });
    cb.checked = auto;
    lab.appendText(' 시각까지 정해진 일정은 자동으로 캘린더에');
    cb.onchange = async () => { this.plugin.data.autoPlan = cb.checked; await this.plugin.saveData(this.plugin.data); this.render(); };
    head.createSpan({ cls: 'ks-muted', text: done?.calendar ? `→ ${done.calendar}` : '→ Rappo 설정 › 정리·AI·캘린더에서 캘린더를 골라 주세요' });
    if (!list.length) { sec.createDiv({ cls: 'ks-hint', text: '최근 60일 대화에서 앞으로의 약속을 찾지 못했어요.' }); return; }
    for (const p of list.slice(0, this.planShown || 10)) {
      const row = sec.createDiv({ cls: 'ks-day-row' });
      const dd = daysSince(p.date) * -1;
      row.createSpan({ cls: 'ks-dday' + (dd <= 7 ? ' is-soon' : ''), text: dd === 0 ? '오늘' : `D-${dd}` });
      const body = row.createDiv({ cls: 'ks-todo-body' });
      const t = body.createDiv({ cls: 'ks-todo-text', text: `${p.date.slice(5).replace('-', '/')} (${weekday(p.date)})${p.time ? ' ' + p.time : ''} · ${p.room}  ` });
      t.createSpan({ cls: 'ks-muted', text: p.src === 'call' ? '📞 통화 요약' : '💬 카톡' });
      const q = body.createEl('a', { cls: 'ks-muted', text: `${p.who ? p.who + ': ' : ''}${clean(p.text)}` });
      q.onclick = () => this.app.workspace.getLeaf(false).openFile(p.file, { eState: { line: p.line } });
      const btns = body.createDiv({ cls: 'ks-guess-btns' });
      const inCal = ids.has(p.id), want = st[p.id] === 'add' || (auto && p.time);
      if (inCal) btns.createSpan({ cls: 'ks-muted', text: '✅ 캘린더에 들어감' });
      else if (want) btns.createSpan({ cls: 'ks-muted', text: '⏳ 캘린더에 넣는 중 (Rappo 앱)' });
      else {
        const add = btns.createEl('button', { text: '📅 캘린더에 넣기' });
        add.onclick = async () => { await this.plugin.days.setPlan(p.id, 'add'); this.render(); };
      }
      if (!inCal) {
        const no = btns.createEl('button', { text: '일정 아니에요' });
        no.onclick = async () => { await this.plugin.days.setPlan(p.id, 'no'); this.render(); };
      }
    }
    if (list.length > (this.planShown || 10)) {
      const more = sec.createEl('button', { text: `더 보기 (${list.length - (this.planShown || 10)}개)`, cls: 'ks-more' });
      more.onclick = () => { this.planShown = (this.planShown || 10) + 10; this.render(); };
    }
  }

  guessButtons(parent, g) {
    const btns = parent.createDiv({ cls: 'ks-guess-btns' });
    const save = btns.createEl('button', { text: '맞아요, 저장' });
    save.onclick = async () => { await this.plugin.days.append(`- ${g.name} | 생일 | ${g.lunar ? '음력 ' : ''}${pad(g.m)}-${pad(g.d)}`); this.render(); };
    const no = btns.createEl('button', { text: '아니에요' });
    no.onclick = async () => { await this.plugin.days.append(`- ${g.name} | 무시 | 생일`); this.render(); };
  }
}

// ---------- 연락 대시보드: 처음 열면 한 화면에 (```연락대시보드```) ----------
function careList(recent) {
  return recent.filter((e) => !e.group).map((e) => {
    const d = [...e.days].sort(), gap = daysSince(e.last.slice(0, 10));
    const span = d.length > 1 ? daysSince(d[0]) - gap : 0;
    return { ...e, gap, every: d.length > 1 ? Math.max(1, Math.round(span / (d.length - 1))) : 0 };
  }).filter((e) => e.days.size >= 3 && e.gap > CARE_DAYS && e.gap <= 365)
    .sort((a, b) => b.gap / (b.every || 1) - a.gap / (a.every || 1));
}
class ViewModal extends Modal {
  constructor(plugin, title, View) { super(plugin.app); this.plugin = plugin; this.t = title; this.View = View; }
  onOpen() { this.modalEl.addClass('ks-modal'); this.titleEl.setText(this.t); new this.View(this.plugin, this.contentEl).render(); }
  onClose() { this.contentEl.empty(); }
}
class ContactDash {
  constructor(plugin, root) { this.plugin = plugin; this.app = plugin.app; this.root = root; }
  async render() {
    try { await this.draw(); }
    catch (e) {
      console.error('Rappo 라포 홈', e);
      this.root.empty();
      this.root.createDiv({ cls: 'rd-empty', text: `라포 홈을 그리지 못했어요: ${e.message || e}` });
    }
  }
  async draw() {
    const r = this.root, P = this.plugin, app = this.app;
    r.empty(); r.addClass('ks-root', 'rd-root');
    const status = r.createDiv({ cls: 'ks-status', text: '연락 정리 중…' });
    await P.index.ensure();
    const tasks = await P.tasks.load();
    const { ev, plans } = await P.days.upcoming();
    const recent = P.index.recent();
    const pays = await P.spend.load();
    status.remove();
    const td = today(), open = tasks.filter((t) => t.status === ' ');
    // 오늘 일정: 캘린더 · 오늘이 마감인 할 일 · 오늘 약속 · 오늘 챙길 날
    let calToday = [];
    try {
      const cd = JSON.parse(await app.vault.adapter.read(`${P.manifest.dir}/calendar-events.json`));
      calToday = (cd.events || []).filter((e) => e.start.slice(0, 10) === td && !/^✅ /.test(e.title || ''))
        .map((e) => ({ time: e.allDay ? '' : e.start.slice(11, 16), text: `📆 ${e.title}` }));
    } catch (e) { /* 캘린더 연결 전 */ }
    const todayItems = [
      ...calToday,
      ...plans.filter((p) => p.date === td).map((p) => ({ time: p.time || '', text: `📅 ${p.room} · ${clean(p.text).slice(0, 24)}` })),
      ...open.filter((t) => t.due === td).map((t) => ({ time: t.time || '', text: `✅ ${t.text}` })),
      ...ev.filter((e) => e.dday === 0 && !e.guess).map((e) => ({ time: '', text: `${e.kind === 'birth' ? '🎂' : e.kind === 'anniv' ? '💐' : '🗓'} ${e.title}` })),
    ].sort((a, b) => (a.time || '99').localeCompare(b.time || '99'));
    // 이번 달 소비
    const ym = td.slice(0, 7), dayN = Number(td.slice(8));
    const [yy, mm] = ym.split('-').map(Number), pm = `${mm === 1 ? yy - 1 : yy}-${pad(mm === 1 ? 12 : mm - 1)}`;
    const mon = pays.filter((p) => p.date.startsWith(ym)), spent = mon.reduce((a, p) => a + p.amount, 0);
    const lastSame = pays.filter((p) => p.date.startsWith(pm) && Number(p.date.slice(8)) <= dayN).reduce((a, p) => a + p.amount, 0);
    const budget = Number(P.data.budget || 0);
    const late = open.filter((t) => t.due && t.due < td), soon = open.filter((t) => t.due && t.due >= td && -daysSince(t.due) <= 3);
    const days7 = ev.filter((e) => e.dday <= 7 && !e.guess);
    const todayC = recent.filter((e) => e.last.startsWith(td));
    const modal = (title, View) => () => new ViewModal(P, title, View).open();

    // 머리
    const head = r.createDiv({ cls: 'rd-header' });
    const ht = head.createDiv();
    const now = new Date();
    ht.createDiv({ cls: 'rd-date', text: '🏠 라포 홈' });
    ht.createDiv({ cls: 'rd-sub', text: `${now.getMonth() + 1}월 ${now.getDate()}일 ${WEEK[now.getDay()]}요일 · 연락 · 할 일 · 챙길 날 · 소비` });
    const act = head.createDiv({ cls: 'rd-actions' });
    act.createEl('button', { text: '＋ 할 일', cls: 'mod-cta' }).onclick = () => new TaskModal(P, null, async (v) => { await P.tasks.add(v); this.render(); }).open();
    act.createEl('button', { text: '💳 소비' }).onclick = () => this.openSpend();
    act.createEl('button', { text: '📥 이용내역 넣기' }).onclick = async () => {
      const dir = `${P.spend.dir}/가져오기`;
      await ensureFolder(app, dir);
      try { require('electron').shell.openPath(app.vault.adapter.getFullPath(dir)); } catch (e) { /* 모바일 */ }
      new Notice('현대카드 이용내역 파일(.xlsx·.xls·.csv)을 이 폴더에 넣으면 다음 정리 때 들어가요.', 8000);
    };
    const sb = act.createEl('button', { text: this.searchOpen ? '🔍 검색 닫기' : '🔍 대화 검색', cls: this.searchOpen ? 'is-active' : '' });
    sb.onclick = () => { this.searchOpen = !this.searchOpen; this.render(); };

    // 🔍 대화 검색: 버튼을 눌렀을 때만 이 자리에
    if (this.searchOpen) {
      const sp = r.createDiv({ cls: 'rd-search' });
      if (!this.search) this.search = new SearchView(P, sp); else { this.search.root = sp; }
      this.search.render();
    }

    // 숫자 타일
    const kpi = r.createDiv({ cls: 'rd-kpis' });
    const tile = (label, value, cls, hint, onclick) => {
      const t = kpi.createDiv({ cls: `rd-kpi ${cls || ''}`, attr: { 'aria-label': '눌러서 전체 보기' } });
      t.createDiv({ cls: 'rd-kpi-value', text: String(value) });
      t.createDiv({ cls: 'rd-kpi-label', text: label });
      if (hint) t.createDiv({ cls: 'rd-kpi-hint', text: hint });
      t.onclick = onclick;
    };
    tile('남은 할 일', open.length, late.length ? 'over' : soon.length ? 'todo' : '', `마감 지남 ${late.length} · 3일 내 ${soon.length}`, modal('✅ 할 일', TodoView));
    tile('오늘 일정', todayItems.length, todayItems.length ? 'todo' : '', todayItems[0] ? `${todayItems[0].time ? todayItems[0].time + ' ' : ''}${todayItems[0].text}` : '오늘은 정해진 일정이 없어요', modal('🎂 챙길 날 · 일정', DaysView));
    const diffM = lastSame ? Math.round((spent - lastSame) / Math.abs(lastSame) * 100) : null;
    tile('이번 달 지출', won(spent), budget && spent > budget ? 'over' : 'doing',
      [budget ? `예산 ${Math.round(spent / budget * 100)}%` : '', diffM === null ? '' : `지난달보다 ${diffM >= 0 ? diffM + '% 더' : -diffM + '% 덜'}`].filter(Boolean).join(' · ') || '현대카드 결제',
      () => this.openSpend());
    tile('오늘 연락', todayC.length, '', `📞 ${todayC.filter((e) => e.call && e.call.date === td).length} · 💬 ${todayC.filter((e) => e.talk && e.talk.date === td).length}`, modal('🕘 최근 연락', RecentView));

    const section = (parent, title, count, more) => {
      const s = parent.createDiv({ cls: 'rd-section' });
      const h = s.createDiv({ cls: 'rd-section-head' });
      h.createSpan({ cls: 'rd-section-title', text: title });
      if (count !== null && count !== undefined) h.createSpan({ cls: 'rd-count', text: String(count) });
      if (more) { const a = h.createEl('a', { cls: 'rd-more', text: '전체 보기 ›' }); a.onclick = more; }
      return s.createDiv({ cls: 'rd-body' });
    };
    const rowEl = (box) => box.createDiv({ cls: 'rd-list-row' });
    const empty = (box, t) => box.createDiv({ cls: 'rd-empty', text: t });
    const dd = (row, d, extra) => {
      const n = -daysSince(d);
      row.createSpan({ cls: 'rd-dday' + (n < 0 ? ' over' : n <= 3 ? ' soon' : ''), text: n < 0 ? `${-n}일 지남` : n === 0 ? '오늘' : `D-${n}` + (extra || '') });
    };

    // 📆 캘린더 (맥 캘린더·구글 캘린더 — Rappo 앱이 14일치를 calendar-events.json 으로)
    await this.calendarCard(r);

    // 1행: 할 일 | 챙길 날 + 일정 | 이번 달 소비
    const row1 = r.createDiv({ cls: 'rd-row rd-row-3' });
    const tb = section(row1.createDiv({ cls: 'rd-col' }), '✅ 할 일', open.length, modal('✅ 할 일', TodoView));
    const sorted = [...open].sort((a, b) => (PRIO_RANK[a.prio] - PRIO_RANK[b.prio]) || (a.due || '9999').localeCompare(b.due || '9999'));
    const calIds = new Set((await P.days.calDone())?.ids || []);
    const leftover = tasks.filter((t) => t.status === '-' && calIds.has(`task:${t.id}`) && !(P.data.calRemove || {})[`task:${t.id}`]);
    if (leftover.length) {
      const a = tb.createEl('a', { cls: 'rd-hint sp-check-link', text: `📅 지운 할 일 ${leftover.length}개가 캘린더에 남아 있어요 — 확인 ›` });
      a.onclick = () => { const m = new ViewModal(P, '✅ 할 일', TodoView); m.onOpen = function () { this.modalEl.addClass('ks-modal'); this.titleEl.setText('🗑 지운 할 일'); const v = new TodoView(P, this.contentEl); v.view = 'del'; v.render(); }; m.open(); };
    }
    if (!sorted.length) empty(tb, '남은 할 일이 없어요');
    for (const t of sorted.slice(0, 8)) {
      const x = rowEl(tb);
      const c = x.createEl('input', { type: 'checkbox' });
      c.onchange = async () => { await P.tasks.setDone(t, true); this.render(); };
      x.createSpan({ cls: `ks-prio is-${{ 높음: 'high', 보통: 'mid', 낮음: 'low' }[t.prio || '보통']}`, text: t.prio || '보통' });
      const tx = x.createEl('a', { cls: 'rd-text rd-link', text: t.text }); tx.onclick = (e) => P.tasks.open(t, e);
      if (t.noteStatus === '진행 중') x.createSpan({ cls: 'pa-pill is-doing', text: '진행 중' });
      if (t.who) x.createSpan({ cls: 'rd-muted', text: t.who });
      if (t.due) dd(x, t.due);
    }
    const db = section(row1.createDiv({ cls: 'rd-col' }), '🎂 챙길 날 · 📅 일정', ev.filter((e) => !e.guess && e.dday <= 90).length + plans.length, modal('🎂 챙길 날', DaysView));
    const items = [
      ...plans.slice(0, 4).map((p) => ({ d: p.date, icon: '📅', text: `${p.room} · ${clean(p.text).slice(0, 30)}`, sub: p.time })),
      ...ev.filter((e) => e.guess ? e.dday <= 30 : e.dday <= 90).slice(0, 8).map((e) => ({ d: e.date, icon: e.kind === 'birth' ? '🎂' : e.kind === 'anniv' ? '💐' : '🗓', text: e.title + (e.guess ? ' (추정)' : ''), sub: '', guess: e.guess })),
    ].sort((a, b) => a.d.localeCompare(b.d)).slice(0, 8);
    if (!items.length) empty(db, '가까운 챙길 날이 없어요');
    for (const it of items) {
      const x = rowEl(db);
      dd(x, it.d);
      x.createSpan({ cls: 'rd-text' + (it.guess ? ' rd-guess' : ''), text: `${it.icon} ${it.text}` });
      x.createSpan({ cls: 'rd-muted', text: `${it.d.slice(5).replace('-', '/')} (${weekday(it.d)})${it.sub ? ' ' + it.sub : ''}` });
    }
    const guessN = ev.filter((e) => e.guess).length;
    if (guessN) { const a = db.createEl('a', { cls: 'rd-hint', text: `🔎 카톡에서 찾은 생일 후보 ${guessN}명 확인하기 ›` }); a.onclick = modal('🎂 챙길 날', DaysView); }
    // 💳 이번 달 소비 (작게) — 자세히는 소비 대시보드
    const sp = row1.createDiv({ cls: 'rd-col' }).createDiv({ cls: 'rd-section' });
    const sh = sp.createDiv({ cls: 'rd-section-head' });
    sh.createSpan({ cls: 'rd-section-title', text: '💳 이번 달 소비' });
    const so = sh.createEl('a', { cls: 'rd-more', text: '월·년 보기 ›' }); so.onclick = () => this.openSpend();
    const sbd = sp.createDiv({ cls: 'rd-body' });
    if (!mon.length) sbd.createDiv({ cls: 'rd-empty', text: '이번 달 결제가 아직 없어요' });
    else {
      const top = sbd.createDiv({ cls: 'hm-mini' });
      const pct = budget ? Math.min(100, Math.round(spent / budget * 100)) : null;
      if (pct !== null) { const ring = top.createDiv({ cls: 'hm-ring' + (spent > budget ? ' over' : '') }); ring.style.setProperty('--p', `${pct}%`); ring.createEl('b', { text: `${pct}%` }); }
      const tx = top.createDiv();
      tx.createDiv({ cls: 'hm-big', text: budget ? `${won(spent)} / 예산 ${won(budget)}` : won(spent) });
      tx.createDiv({ cls: 'rd-muted', text: (budget ? `남은 돈 ${won(budget - spent)} · ` : '') + `하루 평균 ${won(spent / Math.max(1, dayN))}` });
      const byc = [...mon.reduce((m2, p) => m2.set(p.cat, (m2.get(p.cat) || 0) + p.amount), new Map())].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 3);
      const cm = Math.max(1, ...byc.map(([, v]) => v));
      for (const [c, v] of byc) {
        const xx = sbd.createDiv({ cls: 'sp-cat' });
        const tt = xx.createDiv({ cls: 'sp-cat-top' }); tt.createSpan({ text: catLabel(c) }); tt.createSpan({ cls: 'rd-muted', text: `${won(v)} · ${Math.round(v / Math.max(1, spent) * 100)}%` });
        xx.createDiv({ cls: 'sp-bar' }).createDiv({ cls: 'sp-fill' }).style.width = (v / cm * 100) + '%';
      }
      for (const p of mon.slice(0, 2)) {
        const xx = rowEl(sbd);
        xx.createSpan({ cls: 'rd-muted rd-when', text: `${p.date.slice(5).replace('-', '/')} ${p.time}` });
        xx.createSpan({ cls: 'rd-text', text: p.merchant.replace(/^(주식회사|\(주\)|㈜)\s*/, '').replace(/\s*주식회사$/, '') });
        xx.createSpan({ cls: 'sp-amt', text: won(p.amount) });
      }
      const nCheck = mon.filter((p) => p.check).length;
      if (nCheck) { const a2 = sbd.createEl('a', { cls: 'rd-hint sp-check-link', text: `🔎 분류 확인할 결제 ${nCheck}건 ›` }); a2.onclick = () => this.openSpend(); }
    }

    // 📋 PARA 할 일 보드: 시작 전·진행 중 노트와 진행 중 프로젝트
    this.paraBoard(r);
  }
  async calendarCard(r) {
    const P = this.plugin, app = this.app;
    let data = null;
    try { data = JSON.parse(await app.vault.adapter.read(`${P.manifest.dir}/calendar-events.json`)); } catch (e) { /* 아직 없음 */ }
    const card = r.createDiv({ cls: 'cal-card' });
    const now = new Date(), td = today();
    const left = card.createDiv({ cls: 'cal-month' });
    const right = card.createDiv({ cls: 'cal-list' });
    const evs = ((data && data.events) || []).map((e) => ({ ...e, d: e.start.slice(0, 10), de: e.end.slice(0, 10), t: e.allDay ? '' : e.start.slice(11, 16), te: e.allDay ? '' : e.end.slice(11, 16) }));
    const hm = (t) => `${Number(t.slice(0, 2)) < 12 ? '오전' : '오후'} ${((Number(t.slice(0, 2)) + 11) % 12) + 1}${t.slice(3) === '00' ? '시' : ':' + t.slice(3)}`;
    // 왼쪽: 이번 달 달력 (일~토, 6주)
    const y = now.getFullYear(), m = now.getMonth();
    const mh = left.createDiv({ cls: 'cal-mhead' });
    mh.createSpan({ cls: 'cal-mtitle', text: `${y}년 ${m + 1}월` });
    if (data) { const ad = mh.createEl('a', { cls: 'rd-more', text: '＋ 일정' }); ad.onclick = () => new EventModal(P, null, td, data, () => this.render()).open(); }
    if (!data) mh.createSpan({ cls: 'rd-muted', text: ' · 캘린더 연결 전 (Rappo 설정 › 정리·AI·캘린더 › 접근 허용)' });
    const grid = left.createDiv({ cls: 'cal-grid' });
    WEEK.forEach((w, i) => grid.createDiv({ cls: 'cal-wh' + (i === 0 || i === 6 ? ' is-we' : ''), text: w }));
    const first = new Date(y, m, 1), startD = new Date(y, m, 1 - first.getDay());
    for (let i = 0; i < 42; i++) {
      const d = new Date(startD); d.setDate(startD.getDate() + i);
      const ds = ymd(d), inM = d.getMonth() === m;
      const cell = grid.createDiv({ cls: 'cal-cell' + (inM ? '' : ' is-out') + (ds === td ? ' is-today' : ''), attr: { 'aria-label': data ? '빈 곳을 누르면 이 날 일정 추가' : '' } });
      if (data) cell.onclick = (e) => { if (e.target.closest('.cal-chip')) return; new EventModal(P, null, ds, data, () => this.render()).open(); };
      cell.createDiv({ cls: 'cal-num', text: d.getDate() === 1 && !inM ? `${d.getMonth() + 1}월 1일` : String(d.getDate()) });
      const day = evs.filter((e) => e.allDay ? (e.d <= ds && ds < (e.de > e.d ? e.de : ymd(new Date(new Date(e.d + 'T12:00:00').getTime() + 86400000)))) : e.d === ds);
      for (const e of day.slice(0, 2)) {
        const x = cell.createDiv({ cls: 'cal-chip' + (e.allDay ? ' is-all' : ''), attr: { 'aria-label': `${e.title}${e.allDay ? '' : ' · ' + hm(e.t)}${e.location ? ' · ' + e.location : ''}` } });
        x.style.setProperty('--c', e.color || '#7c5cff');
        x.onclick = () => new EventModal(P, e, e.d, data, () => this.render()).open();
        x.createSpan({ cls: 'cal-chip-t', text: e.title || '(제목 없음)' });
        if (!e.allDay) x.createSpan({ cls: 'cal-chip-h', text: hm(e.t) });
      }
      if (day.length > 2) cell.createDiv({ cls: 'cal-more', text: `+${day.length - 2}` });
    }
    // 오른쪽: 다가오는 일정 (오늘 남은 일정부터, 누르면 편집)
    const nowHM = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const ev = (box, e) => {
      const x = box.createDiv({ cls: 'cal-ev' });
      x.style.setProperty('--c', e.color || '#7c5cff');
      x.onclick = () => new EventModal(P, e, e.d, data, () => this.render()).open();
      x.createDiv({ cls: 'cal-ev-title', text: e.title || '(제목 없음)' });
      if (!e.allDay) x.createDiv({ cls: 'cal-ev-time', text: `${hm(e.t)}~${hm(e.te)}` + (e.location ? ` · ${e.location}` : '') });
    };
    const todays = evs.filter((e) => e.d === td && (e.allDay || e.te > nowHM));
    if (todays.length) { right.createDiv({ cls: 'cal-day', text: '오늘' }); for (const e of todays.slice(0, 3)) ev(right, e); }
    let last = '', shown = 0;
    for (const e of evs.filter((x) => x.d > td && x.d <= ymd(new Date(now.getTime() + 14 * 86400000)))) {
      if (shown >= 6) break;
      if (e.d !== last) { last = e.d; const dd = new Date(e.d + 'T12:00:00'); right.createDiv({ cls: 'cal-day', text: `${dd.getMonth() + 1}월 ${dd.getDate()}일 ${WEEK[dd.getDay()]}요일` }); }
      ev(right, e); shown++;
    }
  }

  paraBoard(r) {
    const app = this.app, td = today();
    const items = [];
    for (const f of app.vault.getMarkdownFiles()) {
      if (f.path.startsWith('4. Archive/') || f.path.startsWith('_')) continue;
      const fm = app.metadataCache.getFileCache(f)?.frontmatter;
      if (!fm || !fm.type) continue;
      const ty = String(fm.type), st = String(fm.status || '');
      const link = (v) => [].concat(v || []).map((x) => String(x).replace(/^\[\[|\]\]$/g, '').split('|')[0]).filter(Boolean);
      const end = fm.end ? String(fm.end).slice(0, 10) : '';
      if (ty === 'note' && (st === '시작 전' || st === '진행 중')) items.push({ f, ty, st, end, ctx: [...link(fm.project), ...link(fm.area)][0] || '' });
      if (ty === 'project' && (st === '진행 중' || st === '시작 안 함' || st === '시작 전' || !st)) items.push({ f, ty, st: st || '시작 안 함', end, ctx: link(fm.area)[0] || '' });
    }
    const byEnd = (a, b) => (a.end || '9999').localeCompare(b.end || '9999') || b.f.stat.mtime - a.f.stat.mtime;
    const notes = items.filter((i) => i.ty === 'note').sort((a, b) => (a.st === '진행 중' ? 0 : 1) - (b.st === '진행 중' ? 0 : 1) || byEnd(a, b));
    const projects = items.filter((i) => i.ty === 'project').sort((a, b) => (a.st === '진행 중' ? 0 : 1) - (b.st === '진행 중' ? 0 : 1) || byEnd(a, b));
    const row = r.createDiv({ cls: 'rd-row' });
    const section = (title, count) => {
      const s2 = row.createDiv({ cls: 'rd-col' }).createDiv({ cls: 'rd-section' });
      const h = s2.createDiv({ cls: 'rd-section-head' });
      h.createSpan({ cls: 'rd-section-title', text: title });
      h.createSpan({ cls: 'rd-count', text: String(count) });
      const dash = app.vault.getAbstractFileByPath('PARA 대시보드.md') || app.vault.getAbstractFileByPath('대시보드.md');
      if (dash) { const m = h.createEl('a', { cls: 'rd-more', text: 'PARA 대시보드 ›' }); m.onclick = () => app.workspace.getLeaf(false).openFile(dash); }
      return s2.createDiv({ cls: 'rd-body' });
    };
    const line = (box, it) => {
      const x = box.createDiv({ cls: 'rd-list-row' });
      x.createSpan({ cls: 'pa-pill ' + (it.st === '진행 중' ? 'is-doing' : 'is-todo'), text: it.st === '시작 안 함' ? '시작 전' : it.st });
      const a = x.createEl('a', { cls: 'rd-text rd-link', text: it.f.basename });
      a.onclick = (e) => app.workspace.getLeaf(e.metaKey || e.ctrlKey ? 'tab' : false).openFile(it.f);
      if (it.ctx) x.createSpan({ cls: 'rd-chip', text: it.ctx });
      if (it.end) {
        const n = -daysSince(it.end);
        x.createSpan({ cls: 'rd-dday' + (n < 0 ? ' over' : n <= 3 ? ' soon' : ''), text: n < 0 ? `${-n}일 지남` : n === 0 ? '오늘' : `D-${n}` });
      }
      // 다음 단계로: 시작 전 → 진행 중 → 완료
      const waiting = it.st === '시작 전' || it.st === '시작 안 함';
      const next = waiting ? '진행 중' : '완료';
      const b = x.createEl('a', { cls: 'pa-next', text: waiting ? '▶' : '✓', attr: { 'aria-label': `${next}(으)로` } });
      b.onclick = async () => { await app.fileManager.processFrontMatter(it.f, (fm) => { fm.status = next; }); new Notice(`${it.f.basename} → ${next}`); setTimeout(() => this.render(), 300); };
    };
    const nb = section('📝 할 일 노트 · 시작 전 · 진행 중', notes.length);
    if (!notes.length) nb.createDiv({ cls: 'rd-empty', text: '시작 전·진행 중인 노트가 없어요' });
    for (const it of notes.slice(0, 10)) line(nb, it);
    if (notes.length > 10) nb.createDiv({ cls: 'rd-empty', text: `+ ${notes.length - 10}개 더 (PARA 대시보드에서)` });
    const pb = section('📁 프로젝트 · 진행 중 · 시작 전', projects.length);
    if (!projects.length) pb.createDiv({ cls: 'rd-empty', text: '진행 중·시작 전 프로젝트가 없어요' });
    for (const it of projects.slice(0, 10)) line(pb, it);
    if (projects.length > 10) pb.createDiv({ cls: 'rd-empty', text: `+ ${projects.length - 10}개 더 (PARA 대시보드에서)` });
  }
  async openSpend() {
    const app = this.app, path = `${BASE}/소비/소비 대시보드.md`;
    let f = app.vault.getAbstractFileByPath(path);
    const body = '---\ncssclasses:\n  - pd-wide\n  - rappo-dash\ntags: [대시보드]\n---\n```소비\n```\n';
    if (!(f instanceof TFile)) { await ensureFolder(app, `${BASE}/소비`); f = await app.vault.create(path, body); }
    else if (!(await app.vault.read(f)).includes('```소비')) await app.vault.modify(f, body);
    await app.workspace.getLeaf(false).openFile(f);
  }
}
// 캘린더 일정 추가·고치기·지우기 — calendar-edits.json 에 적으면 Rappo 앱이 맥 캘린더(구글 캘린더 포함)에 반영
class EventModal extends Modal {
  constructor(plugin, ev, date, data, done) { super(plugin.app); this.plugin = plugin; this.ev = ev; this.date = date; this.data = data || {}; this.done = done; }
  onOpen() {
    const e = this.ev, c = this.contentEl, editable = !e || e.editable !== false;
    this.titleEl.setText(e ? (editable ? '일정 고치기' : '일정 보기') : '새 일정');
    c.addClass('ks-task-form');
    const row = (label, el) => { const r = c.createDiv({ cls: 'ks-form-row' }); r.createEl('label', { text: label }); r.appendChild(el); return el; };
    const title = row('제목', createEl('input', { type: 'text', value: e ? e.title : '' }));
    const date = row('날짜', createEl('input', { type: 'date', value: e ? e.d : this.date }));
    const allWrap = createDiv(); const all = allWrap.createEl('input', { type: 'checkbox' }); allWrap.appendText(' 하루 종일');
    all.checked = e ? !!e.allDay : false;
    row('', allWrap);
    const st = row('시작', createEl('input', { type: 'time', value: e && !e.allDay ? e.t : '10:00' }));
    const en = row('끝', createEl('input', { type: 'time', value: e && !e.allDay ? e.te : '11:00' }));
    const loc = row('장소', createEl('input', { type: 'text', value: e ? e.location || '' : '' }));
    const memo = row('메모', createEl('textarea', { attr: { rows: 3 } }));
    memo.value = e ? (e.notes || '').replace(/\n— Rappo$/, '') : '';
    let calSel = null;
    if (!e && (this.data.calendars || []).length) {
      calSel = row('캘린더', createEl('select', { cls: 'dropdown' }));
      for (const k of this.data.calendars) calSel.createEl('option', { value: k.id, text: k.title });
      if (this.data.defaultCal) calSel.value = this.data.defaultCal;
    }
    if (e) c.createDiv({ cls: 'rd-muted', text: `캘린더: ${e.calendar}${editable ? '' : ' (읽기 전용 — 이 캘린더는 여기서 고칠 수 없어요)'}` });
    const sync = () => { st.disabled = en.disabled = all.checked; };
    all.onchange = sync; sync();
    [title, date, st, en, loc, memo].forEach((x) => { x.disabled = x.disabled || !editable; });
    const btns = c.createDiv({ cls: 'ks-guess-btns' });
    if (editable) {
      const save = btns.createEl('button', { text: '저장', cls: 'mod-cta' });
      save.onclick = async () => {
        if (!title.value.trim() || !date.value) { title.focus(); return; }
        const next = (d) => { const x = new Date(d + 'T12:00:00'); x.setDate(x.getDate() + 1); return ymd(x); };
        const op = { op: e ? 'update' : 'add', id: e ? e.id : undefined, title: title.value.trim(), allDay: all.checked,
          start: all.checked ? `${date.value}T00:00` : `${date.value}T${st.value || '10:00'}`,
          end: all.checked ? `${next(date.value)}T00:00` : `${date.value}T${en.value || st.value || '11:00'}`,
          location: loc.value, notes: memo.value, calId: calSel ? calSel.value : undefined };
        await this.push(op);
        new Notice(e ? '📅 일정을 고쳤어요 (곧 캘린더에 반영)' : '📅 일정을 넣었어요 (곧 캘린더에 반영)');
        this.close();
      };
    }
    if (e && editable) {
      const del = btns.createEl('button', { text: '삭제' });
      del.onclick = async () => {
        if (!window.confirm(`'${e.title}' 일정을 캘린더에서 지울까요?\n구글 캘린더에서도 지워져요.`)) return;
        await this.push({ op: 'delete', id: e.id });
        new Notice('🗑 일정을 지웠어요 (곧 캘린더에 반영)');
        this.close();
      };
    }
    btns.createEl('button', { text: '닫기' }).onclick = () => this.close();
    setTimeout(() => title.focus(), 50);
  }
  async push(op) {
    const ad = this.app.vault.adapter, p = `${this.plugin.manifest.dir}/calendar-edits.json`;
    let ops = [];
    try { ops = JSON.parse(await ad.read(p)); } catch (err) { ops = []; }
    ops.push(op);
    await ad.write(p, JSON.stringify(ops, null, 1));
    if (this.done) setTimeout(this.done, 3000);   // Rappo 앱이 반영하고 새 일정 목록을 쓰면 다시 그림
  }
  onClose() { this.contentEl.empty(); }
}

class ContactDashChild extends MarkdownRenderChild {
  constructor(plugin, el) { super(el); this.plugin = plugin; }
  onload() {
    this.view = new ContactDash(this.plugin, this.containerEl);
    this.view.render();
  }
}

// ---------- 사람 한 명: 약속·할 일·챙길 날·통화 기록 한눈에 (연락처 카드를 누르면) ----------
class PersonView {
  constructor(plugin, root, name) { this.plugin = plugin; this.app = plugin.app; this.root = root; this.name = name; }
  async render() {
    try { await this.draw(); }
    catch (e) {
      console.error('Rappo 사람 상세', e);
      this.root.empty();
      this.root.createDiv({ cls: 'rd-empty', text: `화면을 그리지 못했어요: ${e.message || e}` });
    }
  }
  async draw() {
    const r = this.root, P = this.plugin, app = this.app, name = this.name;
    r.empty(); r.addClass('ks-root', 'rd-root');
    const status = r.createDiv({ cls: 'ks-status', text: '정리 중…' });
    await P.index.ensure();
    const allTasks = await P.tasks.load();
    const { dated } = await P.days.load();
    const { ev } = await P.days.upcoming();
    status.remove();
    // 같은 사람의 다른 이름: 통화는 '홍길동', 카톡 1:1 방은 '길동'처럼 성을 뺀 이름인 경우
    // (그 방에서 이 사람이 말한 기록이 있고, 나 말고 다른 사람이 거의 없는 방일 때만)
    const short = name.length >= 3 ? name.slice(1) : '';
    const okAlias = short && [...P.index.files.values()].some((c) => !c.call && c.room === short && c.msgs.some((m) => m.who === name)
      && new Set(c.msgs.map((m) => m.who).filter((w) => w !== '나')).size <= 2);
    const alias = okAlias ? [name, short] : [name];
    const tasks = allTasks.filter((t) => (t.who || '').split(/,\s*/).some((w) => alias.includes(w)));
    const st = P.index.stats(name);
    for (const a of alias.slice(1)) {
      const s2 = P.index.stats(a);
      st.talk += s2.talk; st.calls += s2.calls;
      for (const d of s2.days) st.days.add(d);
      if (s2.first && (!st.first || s2.first < st.first)) st.first = s2.first;
      if (s2.last > st.last) st.last = s2.last;
    }
    const td = today();
    // 연락처 노트(번호)
    let phone = '', note = null;
    for (const f of app.vault.getMarkdownFiles()) {
      if (!f.path.startsWith(CONTACTS + '/')) continue;
      const fm = app.metadataCache.getFileCache(f)?.frontmatter || {};
      const nm = String(fm.name || '').trim();
      if (nm === name || String(fm.phone || '') === name || f.basename === name) { phone = String(fm.phone || ''); note = f; break; }
    }

    // 머리
    const head = r.createDiv({ cls: 'rd-header' });
    const ht = head.createDiv({ cls: 'rd-person-head' });
    ht.createDiv({ cls: 'rd-avatar rd-avatar-lg', text: (name.match(/[가-힣A-Za-z]/) || ['#'])[0] });
    const nm = ht.createDiv();
    nm.createDiv({ cls: 'rd-date', text: name + (alias.length > 1 ? `  ` : '') }).createSpan({ cls: 'rd-muted', text: alias.length > 1 ? `카톡: ${alias.slice(1).join(', ')}` : '' });
    const gap = st.last ? daysSince(st.last) : null;
    nm.createDiv({ cls: 'rd-sub', text: [phone && phone !== name ? phone : '', st.first ? `처음 ${st.first}` : '', gap !== null ? (gap === 0 ? '오늘 연락' : `마지막 연락 ${gap}일 전`) : ''].filter(Boolean).join(' · ') });
    const act = head.createDiv({ cls: 'rd-actions' });
    act.createEl('button', { cls: 'mod-cta', text: '💬 대화 전체 보기' }).onclick = () => new SearchModal(P, { room: name }).open();
    act.createEl('button', { text: '＋ 할 일' }).onclick = () => new TaskModal(P, { who: name }, async (v) => { await P.tasks.add({ ...v, who: v.who || name }); this.render(); }).open();
    if (note) act.createEl('button', { text: '연락처 노트' }).onclick = () => app.workspace.getLeaf(false).openFile(note);

    // 숫자
    const kpi = r.createDiv({ cls: 'rd-kpis' });
    const tile = (label, value, hint) => { const t = kpi.createDiv({ cls: 'rd-kpi' }); t.createDiv({ cls: 'rd-kpi-value', text: String(value) }); t.createDiv({ cls: 'rd-kpi-label', text: label }); if (hint) t.createDiv({ cls: 'rd-kpi-hint', text: hint }); };
    tile('통화', st.calls, '');
    tile('카톡', st.talk.toLocaleString(), st.group ? `단체방 발언 ${st.group.toLocaleString()}` : '');
    tile('연락한 날', st.days.size, st.first ? `${st.first.slice(0, 7)}부터` : '');
    tile('남은 약속·할 일', tasks.filter((t) => t.status === ' ').length, `끝낸 일 ${tasks.filter((t) => /[xX]/.test(t.status)).length}`);

    const section = (parent, title, count) => {
      const s = parent.createDiv({ cls: 'rd-section' });
      const h = s.createDiv({ cls: 'rd-section-head' });
      h.createSpan({ cls: 'rd-section-title', text: title });
      if (count !== undefined) h.createSpan({ cls: 'rd-count', text: String(count) });
      return s.createDiv({ cls: 'rd-body' });
    };
    const row = (box) => box.createDiv({ cls: 'rd-list-row' });
    const empty = (box, t) => box.createDiv({ cls: 'rd-empty', text: t });
    const dd = (x, d) => { const n = -daysSince(d); x.createSpan({ cls: 'rd-dday' + (n < 0 ? ' over' : n <= 3 ? ' soon' : ''), text: n < 0 ? `${-n}일 지남` : n === 0 ? '오늘' : `D-${n}` }); };

    const row1 = r.createDiv({ cls: 'rd-row' });
    // 약속·할 일 (이 사람과)
    const tb = section(row1.createDiv({ cls: 'rd-col' }), '✅ 약속·할 일', tasks.length);
    const order = { ' ': 0, x: 1, X: 1, '-': 2 };
    const ts = [...tasks].filter((t) => t.status !== '-').sort((a, b) => (order[a.status] - order[b.status]) || (a.due || '9999').localeCompare(b.due || '9999'));
    if (!ts.length) empty(tb, '이 사람과 정한 할 일·약속이 아직 없어요');
    for (const t of ts.slice(0, 12)) {
      const x = row(tb);
      const c = x.createEl('input', { type: 'checkbox' });
      c.checked = t.status !== ' ';
      c.onchange = async () => { await P.tasks.setDone(t, c.checked); this.render(); };
      const tx = x.createEl('a', { cls: 'rd-text rd-link' + (t.status !== ' ' ? ' rd-done' : ''), text: (t.time ? '📅 ' : '') + t.text }); tx.onclick = (e) => P.tasks.open(t, e);
      if (t.due && t.status === ' ') dd(x, t.due);
      else if (t.due) x.createSpan({ cls: 'rd-muted', text: t.due.slice(5).replace('-', '/') });
      const lk = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/.exec(t.link || '');
      if (lk) { const a = x.createEl('a', { cls: 'rd-muted rd-link', text: lk[2] || '출처' }); a.onclick = () => app.workspace.openLinkText(lk[1], P.tasks.path, false); }
    }
    // 챙길 날 (생일·기념일·명절)
    const db = section(row1.createDiv({ cls: 'rd-col' }), '🎂 챙길 날');
    const mine = dated.filter((e) => alias.includes(e.name));
    const hol = ev.filter((e) => e.kind === 'holiday' && e.names.some((n) => alias.includes(n)));
    const guess = mine.some((e) => e.label === '생일') ? [] : ev.filter((e) => e.guess && e.names.some((n) => alias.includes(n)));
    if (!mine.length && !hol.length && !guess.length) empty(db, '저장된 생일·기념일이 없어요');
    for (const e of mine) {
      const hit = nextOf(e.m, e.d, e.lunar);
      const x = row(db);
      if (hit) dd(x, hit.date);
      x.createSpan({ cls: 'rd-text', text: `${e.label === '생일' ? '🎂' : '💐'} ${e.label}${e.year && e.label !== '생일' && hit ? ` ${Number(hit.date.slice(0, 4)) - e.year}주년` : ''}` });
      x.createSpan({ cls: 'rd-muted', text: mdText(e) });
    }
    for (const e of guess) {
      const x = row(db); dd(x, e.date);
      x.createSpan({ cls: 'rd-text rd-guess', text: `🎂 생일 (카톡에서 추정)` });
      x.createSpan({ cls: 'rd-muted', text: e.sub.split(' · ')[0] });
      const b = x.createEl('a', { cls: 'rd-chip rd-chip-link', text: '맞아요' });
      b.onclick = async () => { const g = e.guess; await P.days.append(`- ${name} | 생일 | ${g.lunar ? '음력 ' : ''}${pad(g.m)}-${pad(g.d)}`); this.render(); };
    }
    for (const e of hol) { const x = row(db); dd(x, e.date); x.createSpan({ cls: 'rd-text', text: `🗓 ${e.title}` }); x.createSpan({ cls: 'rd-muted', text: e.date.slice(5).replace('-', '/') }); }
    const add = db.createEl('a', { cls: 'rd-hint', text: '✏️ 생일·기념일 적기 ›' });
    add.onclick = () => P.days.openNote();

    // 히스토리: 통화(요약) · 카톡 · 단체방 — 최신 순
    const hist = [];
    for (const c of P.index.files.values()) {
      if (c.call && alias.includes(c.room)) {
        const sm = c.msgs.find((m) => m.who === '요약');
        hist.push({ d: `${c.call.date} ${c.call.time}`, icon: '📞', text: sm ? sm.text : `통화${c.call.dur ? ' ' + c.call.dur : ''}`, sub: c.call.dur, file: c.file, line: 0 });
      } else if (!c.call && alias.includes(c.room) && c.msgs.length) {
        // 월별 노트 하나 = 그달의 대화 묶음
        const last = c.msgs[c.msgs.length - 1];
        hist.push({ d: `${last.date} ${last.time}`, icon: c.kind === '단체' ? '👥' : '💬', text: `${c.msgs[0].date.slice(0, 7)} 대화 ${c.msgs.length.toLocaleString()}개 · ${last.who}: ${clean(last.text)}`, file: c.file, line: last.line });
      }
    }
    // 할 일도 히스토리에: 출처 통화·카톡·회의 날짜(없으면 마감) 기준, 누르면 할 일 노트
    for (const t of tasks) {
      if (t.status === '-') continue;
      const src = /(\d{4}-\d{2}-\d{2})/.exec(t.link || '') || /(\d{1,2})\/(\d{1,2})/.exec(t.link || '');
      let d = t.due || td;
      if (src && src[1] && src[1].length === 10) d = src[1];
      else if (src) d = `${td.slice(0, 4)}-${pad(src[1])}-${pad(src[2])}`;
      hist.push({ d: `${d} 99:99`, icon: /[xX]/.test(t.status) ? '☑️' : '✅', text: `${t.text}${t.due ? ` (마감 ${t.due.slice(5).replace('-', '/')})` : ''}`, task: t });
    }
    hist.sort((a, b) => b.d.localeCompare(a.d));
    const hb = section(r, '🕘 히스토리', hist.length);
    if (!hist.length) empty(hb, '기록이 없어요');
    for (const h of hist.slice(0, this.more ? 200 : 12)) {
      const x = row(hb);
      x.createSpan({ cls: 'rd-muted rd-when', text: h.d.slice(2, 10).replace(/-/g, '.') });
      const a = x.createEl('a', { cls: 'rd-text rd-link', text: `${h.icon} ${clean(h.text)}` });
      a.onclick = (ev2) => h.task ? P.tasks.open(h.task, ev2) : app.workspace.getLeaf(false).openFile(h.file, { eState: { line: h.line } });
    }
    if (hist.length > 12 && !this.more) { const m = hb.createEl('a', { cls: 'rd-hint', text: `더 보기 (${hist.length - 12}개) ›` }); m.onclick = () => { this.more = true; this.render(); }; }
  }
}
class PersonChild extends MarkdownRenderChild {
  constructor(plugin, el, sourcePath, name) { super(el); this.plugin = plugin; this.sourcePath = sourcePath; this.name = name; }
  onload() {
    const app = this.plugin.app, f = app.vault.getAbstractFileByPath(this.sourcePath);
    const fm = (f && app.metadataCache.getFileCache(f)?.frontmatter) || {};
    const nm = String(fm.name || '').trim();
    const name = this.name || (nm && nm !== '정보 없음' ? nm : String(fm.phone || (f ? f.basename : '')));
    this.containerEl.addClass('rd-person-inline');
    this.view = new PersonView(this.plugin, this.containerEl, name);
    this.view.render();
    this.registerEvent(app.metadataCache.on('changed', (cf) => { if (cf.path === this.plugin.tasks.path) this.view.render(); }));
  }
}

class PersonModal extends Modal {
  constructor(plugin, name) { super(plugin.app); this.plugin = plugin; this.name = name; }
  onOpen() { this.modalEl.addClass('ks-modal', 'rd-person-modal'); new PersonView(this.plugin, this.contentEl, this.name).render(); }
  onClose() { this.contentEl.empty(); }
}

// ---------- 💳 소비: 현대카드 승인 문자·이용내역 파일에서 모은 내역 (```소비```) ----------
const PAY_RE = /^\s*-\s+(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) · (-?[\d,]+)원 · (.*?) · (.*?) · (.*?)(?:\s+#(\S+))?(?:\s+\^([pc])([0-9a-fk]+))?\s*$/;
const CAT_LABEL = { 생활: '🏠 생활', 의료: '💊 의료', 사치: '💎 사치', 여가: '🎬 여가', 사교: '🍻 사교', 기타: '📦 기타' };
// 예전 분류 이름 → 새 분류 (노트의 #태그·설정에 남아 있는 것도 새 이름으로 보여 줌)
const OLD_CAT = { 배달외식: '생활', 식료품: '생활', 생활용품: '생활', 장보기생활: '생활', 쇼핑: '생활', 교통: '생활', 구독디지털: '생활',
  공과금통신: '생활', 패션뷰티: '사치', 사치기호: '사치', 여가문화: '여가', 의료건강: '의료' };
const newCat = (c) => OLD_CAT[c] || c;
// 여러 가지를 파는 곳 — 건마다 무엇을 샀는지 달라서 '분류 확인'을 권한다
const MIXED_RE = /쿠팡|네이버|11번가|G마켓|지마켓|옥션|SSG|알리|테무|롯데온|위메프|티몬|카카오페이|토스|페이코|다이소/;
function askText(app, title, placeholder) {
  return new Promise((res) => {
    const m = new Modal(app);
    m.titleEl.setText(title);
    m.contentEl.addClass('ks-task-form');
    const inp = m.contentEl.createEl('input', { type: 'text', attr: { placeholder } });
    const ok = m.contentEl.createDiv({ cls: 'ks-guess-btns' }).createEl('button', { text: '확인', cls: 'mod-cta' });
    let done = false;
    const fin = (v) => { if (done) return; done = true; m.close(); res(v); };
    ok.onclick = () => fin(inp.value.trim());
    inp.onkeydown = (e) => { if (e.key === 'Enter') fin(inp.value.trim()); };
    m.onClose = () => fin('');
    m.open(); setTimeout(() => inp.focus(), 50);
  });
}
function catLabel(c) { return CAT_LABEL[c] || `🏷 ${c}`; }
const won = (n) => `${n < 0 ? '-' : ''}${Math.abs(Math.round(n)).toLocaleString()}원`;

class Spend {
  constructor(plugin) { this.plugin = plugin; this.app = plugin.app; }
  get dir() { return `${BASE}/소비`; }
  async load() {
    const map = (this.plugin.data.catMap || {}), byId = (this.plugin.data.catById || {});
    const out = [];
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (!f.path.startsWith(this.dir + '/') || !/^\d{4}-\d{2}$/.test(f.basename)) continue;
      const lines = (await this.app.vault.cachedRead(f)).split('\n');
      lines.forEach((l, i) => {
        const m = PAY_RE.exec(l);
        if (!m) return;
        const merchant = m[4].trim();
        out.push({ date: m[1], time: m[2], amount: Number(m[3].replace(/,/g, '')), merchant, item: m[5].trim(), method: m[6].trim(),
          src: m[8] || 'p', key: `${m[8] || 'p'}${m[9] || ''}`, file: f, line: i, raw: l });
        const it = out[out.length - 1];
        // 분류 정하는 순서: 이 결제만 정한 것 > 이 가게 전체로 정한 것 > 자동 분류
        it.cat = newCat(byId[it.key] || map[merchant] || m[7] || '기타');
        it.check = !byId[it.key] && !map[merchant] && MIXED_RE.test(merchant);
      });
    }
    return this.dedupe(out).sort((a, b) => `${b.date} ${b.time}`.localeCompare(`${a.date} ${a.time}`));
  }
  // 같은 결제가 두 곳에서 들어온 경우 하나만: 카카오페이(현대카드로 결제) ↔ 현대카드 내역, 승인 문자 ↔ 이용내역 파일
  dedupe(list) {
    const day = (d) => new Date(d + 'T12:00:00').getTime() / 86400000;
    const near = (a, b) => Math.abs(day(a.date) - day(b.date)) <= 1 && a.amount === b.amount;
    const short = (s) => s.replace(/^(주식회사|\(주\)|㈜)\s*/, '').replace(/\s/g, '').slice(0, 2);
    const cards = list.filter((p) => p.src === 'c');
    const drop = new Set();
    for (const p of list) {
      if (p.src !== 'p' || !/현대카드/.test(p.method)) continue;
      const c = cards.find((x) => !x.matched && near(x, p));
      if (!c) continue;
      c.matched = true; drop.add(p);
      if (!c.item || c.item === '-') c.item = p.item;           // 카카오페이의 상품명을 카드 내역에
      if (/카카오페이|KAKAOPAY|카카오\s*페이/i.test(c.merchant)) c.merchant = p.merchant;
    }
    for (let i = 0; i < cards.length; i++) for (let j = i + 1; j < cards.length; j++) {
      const a = cards[i], b = cards[j];
      if (drop.has(a) || drop.has(b) || a.date !== b.date || a.amount !== b.amount) continue;
      const sameTime = a.time === b.time || a.time === '00:00' || b.time === '00:00';
      if (sameTime && (short(a.merchant) === short(b.merchant) || a.merchant === '현대카드' || b.merchant === '현대카드')) drop.add(a.time === '00:00' ? a : b);
    }
    return list.filter((p) => !drop.has(p));
  }
  // 분류 바꾸기 — scope 'one': 이 결제만 / 'all': 이 가게 결제 모두(앞으로 오는 것도). 노트의 #태그도 함께 바꾼다
  async setCat(p, cat, scope, all) {
    const D = this.plugin.data;
    if (scope === 'one') D.catById = { ...(D.catById || {}), [p.key]: cat };
    else D.catMap = { ...(D.catMap || {}), [p.merchant]: cat };
    await this.plugin.saveData(D);
    const targets = scope === 'one' ? [p] : all.filter((x) => x.merchant === p.merchant && !(D.catById || {})[x.key]);
    for (const f of new Set(targets.map((x) => x.file))) {
      const keys = new Set(targets.filter((x) => x.file === f).map((x) => x.key));
      await this.app.vault.process(f, (t) => t.split('\n').map((l) => {
        const m = PAY_RE.exec(l);
        if (!m || !keys.has(`${m[8] || 'p'}${m[9] || ''}`)) return l;
        return l.replace(/\s+#\S+(?=\s+\^[pc]|\s*$)/, '').replace(/(\s+\^[pc][0-9a-fk]+)?\s*$/, (x) => ` #${cat}${x}`);
      }).join('\n'));
    }
  }
  cats() { return [...Object.keys(CAT_LABEL), ...(this.plugin.data.customCats || [])]; }

}

class SpendView {
  constructor(plugin, root) {
    this.plugin = plugin; this.app = plugin.app; this.root = root;
    this.month = today().slice(0, 7); this.cat = ''; this.shown = 15; this.mode = 'month'; this.year = Number(today().slice(0, 4));
  }
  // 월 / 년 전환 버튼
  modeSeg(act) {
    const seg = act.createDiv({ cls: 'ks-seg' });
    for (const [v, label] of [['month', '월'], ['year', '년']]) {
      const b = seg.createEl('button', { text: label });
      b.toggleClass('is-active', this.mode === v);
      b.onclick = () => { this.mode = v; if (v === 'year') this.year = Number(this.month.slice(0, 4)); this.cat = ''; this.render(); };
    }
  }
  async render() {
    const r = this.root, P = this.plugin;
    r.empty(); r.addClass('ks-root', 'rd-root');
    const all = await P.spend.load();
    if (this.mode === 'year') return this.renderYear(r, all);
    const ym = this.month, [y, m] = ym.split('-').map(Number);
    const prev = `${m === 1 ? y - 1 : y}-${pad(m === 1 ? 12 : m - 1)}`, next = `${m === 12 ? y + 1 : y}-${pad(m === 12 ? 1 : m + 1)}`;
    const cur = all.filter((p) => p.date.startsWith(ym));
    const total = cur.reduce((s, p) => s + p.amount, 0);
    const isNow = ym === today().slice(0, 7);
    const dayN = isNow ? Number(today().slice(8)) : new Date(y, m, 0).getDate();
    // 지난달 같은 날까지와 비교
    const prevSame = all.filter((p) => p.date.startsWith(prev) && Number(p.date.slice(8)) <= dayN).reduce((s, p) => s + p.amount, 0);
    const budget = Number(P.data.budget || 0);

    // 머리
    const head = r.createDiv({ cls: 'rd-header' });
    const ht = head.createDiv();
    ht.createDiv({ cls: 'rd-date', text: `💳 ${y}년 ${m}월 소비` });
    ht.createDiv({ cls: 'rd-sub', text: '현대카드 승인 문자·이용내역 파일에서 모았어요' });
    const act = head.createDiv({ cls: 'rd-actions' });
    this.modeSeg(act);
    act.createEl('button', { text: '◀' }).onclick = () => { this.month = prev; this.cat = ''; this.render(); };
    if (!isNow) act.createEl('button', { text: '이번 달' }).onclick = () => { this.month = today().slice(0, 7); this.cat = ''; this.render(); };
    act.createEl('button', { text: '▶' }).onclick = () => { this.month = next; this.cat = ''; this.render(); };
    act.createEl('button', { text: budget ? `예산 ${won(budget)}` : '＋ 예산 정하기' }).onclick = () => this.askBudget();
    // 현대카드 홈페이지·앱에서 받은 이용내역(엑셀) 넣는 폴더를 Finder 로 열기
    act.createEl('button', { text: '📥 이용내역 넣기' }).onclick = async () => {
      const dir = `${P.spend.dir}/가져오기`;
      await ensureFolder(this.app, dir);
      try { require('electron').shell.openPath(this.app.vault.adapter.getFullPath(dir)); }
      catch (e) { new Notice(`이 폴더에 이용내역 파일을 넣어 주세요: ${dir}`); }
      new Notice('현대카드 이용내역 파일(.xlsx·.xls·.csv)을 이 폴더에 넣으면 다음 정리 때 들어가요.', 8000);
    };

    if (!all.length) {
      r.createDiv({ cls: 'rd-empty', text: '아직 결제 내역이 없어요. 현대카드 홈페이지·앱에서 이용내역(엑셀)을 내려받아 「소비/가져오기」 폴더에 넣거나, 아이폰 문자를 맥으로 전달해 두면 다음 정리 때 여기에 모여요.' });
      return;
    }
    // 숫자 칸
    const kpi = r.createDiv({ cls: 'rd-kpis' });
    const tile = (label, value, cls, hint) => { const t = kpi.createDiv({ cls: `rd-kpi ${cls || ''}` }); t.createDiv({ cls: 'rd-kpi-value', text: value }); t.createDiv({ cls: 'rd-kpi-label', text: label }); if (hint) t.createDiv({ cls: 'rd-kpi-hint', text: hint }); return t; };
    const diff = prevSame ? Math.round((total - prevSame) / Math.abs(prevSame) * 100) : null;
    tile(isNow ? '이번 달 지출' : `${m}월 지출`, won(total), 'doing', diff === null ? '지난달 기록 없음' : `지난달 같은 날까지보다 ${diff >= 0 ? diff + '% 더' : -diff + '% 덜'}`);
    tile('결제', `${cur.filter((p) => p.amount > 0).length}건`, '', `취소·환불 ${cur.filter((p) => p.amount < 0).length}건`);
    tile('하루 평균', won(total / Math.max(1, dayN)), '', `${dayN}일 기준`);
    if (budget) {
      const left = budget - total, t = tile('예산 남음', won(left), left < 0 ? 'over' : total > budget * 0.8 ? 'todo' : '', `${Math.round(total / budget * 100)}% 사용`);
      const bar = t.createDiv({ cls: 'sp-bar' }); bar.createDiv({ cls: 'sp-fill' + (left < 0 ? ' over' : '') }).style.width = Math.min(100, total / budget * 100) + '%';
    } else tile('예산', '—', '', '＋ 예산 정하기로 한 달 예산을 정해요');

    const section = (parent, title, more) => {
      const s = parent.createDiv({ cls: 'rd-section' });
      const h = s.createDiv({ cls: 'rd-section-head' });
      h.createSpan({ cls: 'rd-section-title', text: title });
      if (more) h.appendChild(more);
      return s.createDiv({ cls: 'rd-body' });
    };
    const row1 = r.createDiv({ cls: 'rd-row' });
    // 날짜별 막대
    const db = section(row1.createDiv({ cls: 'rd-col' }), '📊 날짜별');
    const days = new Date(y, m, 0).getDate(), per = new Array(days + 1).fill(0);
    for (const p of cur) if (p.amount > 0) per[Number(p.date.slice(8))] += p.amount;
    const max = Math.max(1, ...per);
    const chart = db.createDiv({ cls: 'sp-chart' });
    for (let d = 1; d <= days; d++) {
      const col = chart.createDiv({ cls: 'sp-col' + (isNow && d === dayN ? ' is-today' : '') + (isNow && d > dayN ? ' is-future' : ''), attr: { 'aria-label': `${m}/${d} ${won(per[d])}` } });
      col.createDiv({ cls: 'sp-colbar' }).style.height = (per[d] ? Math.max(3, per[d] / max * 100) : 0) + '%';
      if (d === 1 || d % 5 === 0) col.createDiv({ cls: 'sp-lab', text: String(d) });
    }
    // 분류별
    const cb = section(row1.createDiv({ cls: 'rd-col' }), '🗂 분류별');
    const bycat = new Map();
    for (const p of cur) bycat.set(p.cat, (bycat.get(p.cat) || 0) + p.amount);
    const cats = [...bycat].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
    if (!cats.length) cb.createDiv({ cls: 'rd-empty', text: '이 달 결제가 없어요' });
    const cmax = Math.max(1, ...cats.map(([, v]) => v));
    for (const [c, v] of cats) {
      const x = cb.createDiv({ cls: 'sp-cat' + (this.cat === c ? ' is-on' : '') });
      x.onclick = () => { this.cat = this.cat === c ? '' : c; this.shown = 15; this.render(); };
      const t = x.createDiv({ cls: 'sp-cat-top' });
      t.createSpan({ text: catLabel(c) });
      t.createSpan({ cls: 'rd-muted', text: `${won(v)} · ${Math.round(v / Math.max(1, total) * 100)}%` });
      x.createDiv({ cls: 'sp-bar' }).createDiv({ cls: 'sp-fill' }).style.width = (v / cmax * 100) + '%';
    }

    const row2 = r.createDiv({ cls: 'rd-row' });
    // 많이 쓴 곳
    const mb = section(row2.createDiv({ cls: 'rd-col' }), '🏪 많이 쓴 곳');
    const bym = new Map();
    for (const p of cur) { const e = bym.get(p.merchant) || { v: 0, n: 0 }; e.v += p.amount; e.n++; bym.set(p.merchant, e); }
    const tops = [...bym].filter(([, e]) => e.v > 0).sort((a, b) => b[1].v - a[1].v).slice(0, 7);
    if (!tops.length) mb.createDiv({ cls: 'rd-empty', text: '이 달 결제가 없어요' });
    for (const [name, e] of tops) {
      const x = mb.createDiv({ cls: 'rd-list-row' });
      x.createSpan({ cls: 'rd-text', text: name.replace(/^(주식회사|\(주\)|㈜)\s*/, '') });
      x.createSpan({ cls: 'rd-muted', text: `${e.n}번` });
      x.createSpan({ cls: 'sp-amt', text: won(e.v) });
    }
    // 결제 내역
    const list = cur.filter((p) => this.cat === '__check' ? p.check : !this.cat || p.cat === this.cat);
    const nCheck = cur.filter((p) => p.check).length;
    let clear = null;
    if (this.cat) { clear = createEl('a', { cls: 'rd-more', text: `${this.cat === '__check' ? '분류 확인할 것' : catLabel(this.cat)} 만 보는 중 · 전체 ›` }); clear.onclick = () => { this.cat = ''; this.render(); }; }
    else if (nCheck) { clear = createEl('a', { cls: 'rd-more sp-check-link', text: `🔎 분류 확인 ${nCheck}건 ›` }); clear.onclick = () => { this.cat = '__check'; this.shown = 50; this.render(); }; }
    const lb = section(row2.createDiv({ cls: 'rd-col' }), `🧾 결제 내역 ${list.length}건`, clear);
    for (const p of list.slice(0, this.shown)) {
      const x = lb.createDiv({ cls: 'rd-list-row sp-row' + (p.amount < 0 ? ' is-cancel' : '') });
      x.createSpan({ cls: 'rd-muted rd-when', text: `${p.date.slice(5).replace('-', '/')} ${p.time}` });
      const t = x.createDiv({ cls: 'rd-text sp-what' });
      t.createSpan({ text: p.merchant.replace(/^(주식회사|\(주\)|㈜)\s*/, '') });
      if (p.item && p.item !== '-') t.createSpan({ cls: 'rd-muted', text: ` · ${p.item}` });
      if (p.check) t.createSpan({ cls: 'sp-check', text: '분류 확인', attr: { 'aria-label': '여러 가지를 파는 곳이에요. 무엇을 샀는지 분류를 골라 주세요' } });
      const sel = x.createEl('select', { cls: 'dropdown sp-sel' });
      for (const k of P.spend.cats()) sel.createEl('option', { value: k, text: catLabel(k) });
      if (!P.spend.cats().includes(p.cat)) sel.createEl('option', { value: p.cat, text: catLabel(p.cat) });
      sel.createEl('option', { value: '__new', text: '＋ 새 분류…' });
      sel.value = p.cat;
      sel.onchange = async () => {
        let cat = sel.value;
        if (cat === '__new') {
          cat = await askText(this.app, '새 분류 이름', '예: 반려동물, 선물, 아이');
          if (!cat) { sel.value = p.cat; return; }
          cat = cat.replace(/[\s#·]+/g, '');
          P.data.customCats = [...new Set([...(P.data.customCats || []), cat])];
          await P.saveData(P.data);
        }
        // 이 결제만? 이 가게 전체?
        const shop = p.merchant.replace(/^(주식회사|\(주\)|㈜)\s*/, '').replace(/\s*주식회사$/, '');
        const n = all.filter((z) => z.merchant === p.merchant).length;
        x.parentElement.querySelectorAll('.sp-scope').forEach((e) => e.remove());
        const bar = createDiv({ cls: 'sp-scope' }); x.after(bar);
        bar.createSpan({ cls: 'rd-muted', text: `${catLabel(cat)} 로 — ` });
        bar.createEl('button', { text: '이 결제만' }).onclick = async () => { await P.spend.setCat(p, cat, 'one', all); this.render(); };
        bar.createEl('button', { cls: 'mod-cta', text: `${shop} 결제 모두 (${n}건·앞으로도)` }).onclick = async () => { await P.spend.setCat(p, cat, 'all', all); new Notice(`${shop} → ${catLabel(cat)} (앞으로도)`); this.render(); };
        bar.createEl('a', { cls: 'rd-more', text: '취소' }).onclick = () => { sel.value = p.cat; bar.remove(); };
      };
      x.createSpan({ cls: 'sp-amt', text: won(p.amount) });
    }
    if (list.length > this.shown) { const mo = lb.createEl('a', { cls: 'rd-hint', text: `더 보기 (${list.length - this.shown}건) ›` }); mo.onclick = () => { this.shown += 30; this.render(); }; }
  }
  // ---------- 연 단위 ----------
  renderYear(r, all) {
    const P = this.plugin, y = this.year, nowY = Number(today().slice(0, 4));
    const isNow = y === nowY;
    const cur = all.filter((p) => p.date.startsWith(`${y}-`));
    const total = cur.reduce((s, p) => s + p.amount, 0);
    const cutMD = isNow ? today().slice(5) : '12-31';
    const lastSame = all.filter((p) => p.date.startsWith(`${y - 1}-`) && p.date.slice(5) <= cutMD).reduce((s, p) => s + p.amount, 0);
    const months = isNow ? Number(today().slice(5, 7)) : 12;
    const byM = new Array(13).fill(0), cnt = new Array(13).fill(0);
    for (const p of cur) { const mm = Number(p.date.slice(5, 7)); byM[mm] += p.amount; if (p.amount > 0) cnt[mm]++; }
    const budget = Number(P.data.budget || 0);
    const man = (v) => (Math.abs(v) >= 10000 ? `${Math.round(v / 10000).toLocaleString()}만` : `${Math.round(v / 1000)}천`);
    const toMonth = (mm) => { this.mode = 'month'; this.month = `${y}-${pad(mm)}`; this.render(); };

    const head = r.createDiv({ cls: 'rd-header' });
    const ht = head.createDiv();
    ht.createDiv({ cls: 'rd-date', text: `💳 ${y}년 소비` });
    ht.createDiv({ cls: 'rd-sub', text: `1월부터 ${isNow ? `오늘(${Number(today().slice(5, 7))}/${Number(today().slice(8))})까지` : '12월까지'}` });
    const act = head.createDiv({ cls: 'rd-actions' });
    this.modeSeg(act);
    act.createEl('button', { text: '◀' }).onclick = () => { this.year--; this.render(); };
    if (!isNow) act.createEl('button', { text: '올해' }).onclick = () => { this.year = nowY; this.render(); };
    act.createEl('button', { text: '▶' }).onclick = () => { this.year++; this.render(); };
    if (!cur.length) { r.createDiv({ cls: 'rd-empty', text: `${y}년 결제 내역이 없어요.` }); return; }

    const kpi = r.createDiv({ cls: 'rd-kpis' });
    const tile = (label, value, cls, hint) => { const t = kpi.createDiv({ cls: `rd-kpi ${cls || ''}` }); t.createDiv({ cls: 'rd-kpi-value', text: value }); t.createDiv({ cls: 'rd-kpi-label', text: label }); if (hint) t.createDiv({ cls: 'rd-kpi-hint', text: hint }); return t; };
    const diff = lastSame ? Math.round((total - lastSame) / Math.abs(lastSame) * 100) : null;
    tile(isNow ? '올해 지출' : `${y}년 지출`, won(total), 'doing', diff === null ? '지난해 기록 없음' : `지난해 같은 기간보다 ${diff >= 0 ? diff + '% 더' : -diff + '% 덜'}`);
    tile('한 달 평균', won(total / Math.max(1, months)), '', `${months}개월 기준`);
    const bestM = byM.reduce((b, v, i) => (i && v > byM[b] ? i : b), 1);
    tile('가장 많이 쓴 달', `${bestM}월`, 'todo', won(byM[bestM]));
    if (budget) { const left = budget * months - total; tile('예산 대비', won(left), left < 0 ? 'over' : '', `한 달 ${won(budget)} × ${months}개월`); }
    else tile('결제', `${cur.filter((p) => p.amount > 0).length}건`, '', `취소·환불 ${cur.filter((p) => p.amount < 0).length}건`);

    const section = (parent, title) => {
      const s = parent.createDiv({ cls: 'rd-section' });
      s.createDiv({ cls: 'rd-section-head' }).createSpan({ cls: 'rd-section-title', text: title });
      return s.createDiv({ cls: 'rd-body' });
    };
    const row1 = r.createDiv({ cls: 'rd-row' });
    // 월별 막대 (누르면 그달로)
    const mb = section(row1.createDiv({ cls: 'rd-col' }), '📊 월별');
    const max = Math.max(1, ...byM.slice(1));
    const chart = mb.createDiv({ cls: 'sp-chart sp-chart-y' });
    for (let mm = 1; mm <= 12; mm++) {
      const col = chart.createDiv({ cls: 'sp-col' + (isNow && mm === months ? ' is-today' : '') + (isNow && mm > months ? ' is-future' : ''), attr: { 'aria-label': `${mm}월 ${won(byM[mm])} · ${cnt[mm]}건` } });
      col.onclick = () => toMonth(mm);
      if (byM[mm] > 0) col.createDiv({ cls: 'sp-val', text: man(byM[mm]) });
      col.createDiv({ cls: 'sp-colbar' }).style.height = (byM[mm] > 0 ? Math.max(3, byM[mm] / max * 100) : 0) + '%';
      col.createDiv({ cls: 'sp-lab', text: `${mm}` });
    }
    // 분류별 (한 해)
    const cb = section(row1.createDiv({ cls: 'rd-col' }), '🗂 분류별');
    const bycat = new Map();
    for (const p of cur) bycat.set(p.cat, (bycat.get(p.cat) || 0) + p.amount);
    const cats = [...bycat].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
    const cmax = Math.max(1, ...cats.map(([, v]) => v));
    for (const [c, v] of cats) {
      const x = cb.createDiv({ cls: 'sp-cat' });
      const t = x.createDiv({ cls: 'sp-cat-top' });
      t.createSpan({ text: catLabel(c) });
      t.createSpan({ cls: 'rd-muted', text: `${won(v)} · ${Math.round(v / Math.max(1, total) * 100)}%` });
      x.createDiv({ cls: 'sp-bar' }).createDiv({ cls: 'sp-fill' }).style.width = (v / cmax * 100) + '%';
    }
    const row2 = r.createDiv({ cls: 'rd-row' });
    // 많이 쓴 곳 (한 해)
    const tb = section(row2.createDiv({ cls: 'rd-col' }), '🏪 많이 쓴 곳');
    const bym = new Map();
    for (const p of cur) { const e = bym.get(p.merchant) || { v: 0, n: 0 }; e.v += p.amount; e.n++; bym.set(p.merchant, e); }
    for (const [name, e] of [...bym].filter(([, e]) => e.v > 0).sort((a, b) => b[1].v - a[1].v).slice(0, 10)) {
      const x = tb.createDiv({ cls: 'rd-list-row' });
      x.createSpan({ cls: 'rd-text', text: name.replace(/^(주식회사|\(주\)|㈜)\s*/, '') });
      x.createSpan({ cls: 'rd-muted', text: `${e.n}번` });
      x.createSpan({ cls: 'sp-amt', text: won(e.v) });
    }
    // 달마다 한 줄 요약 (누르면 그달로)
    const sb = section(row2.createDiv({ cls: 'rd-col' }), '🗓 달마다');
    for (let mm = months; mm >= 1; mm--) {
      if (!byM[mm] && !cnt[mm]) continue;
      const ps = cur.filter((p) => Number(p.date.slice(5, 7)) === mm);
      const top = [...ps.reduce((mp, p) => mp.set(p.cat, (mp.get(p.cat) || 0) + p.amount), new Map())].sort((a, b) => b[1] - a[1])[0];
      const x = sb.createDiv({ cls: 'rd-list-row sp-month-row' });
      x.onclick = () => toMonth(mm);
      x.createSpan({ cls: 'rd-muted rd-when', text: `${mm}월` });
      x.createSpan({ cls: 'rd-text', text: top ? `${catLabel(top[0])} 가장 많이` : '' });
      x.createSpan({ cls: 'rd-muted', text: `${cnt[mm]}건` });
      x.createSpan({ cls: 'sp-amt', text: won(byM[mm]) });
    }
  }

  askBudget() {
    const P = this.plugin, view = this;
    const md = new Modal(this.app);
    md.titleEl.setText('한 달 예산');
    md.contentEl.addClass('ks-task-form');
    const inp = md.contentEl.createEl('input', { type: 'number', value: String(P.data.budget || ''), attr: { placeholder: '예: 800000 (비우면 예산 없음)' } });
    const b = md.contentEl.createDiv({ cls: 'ks-guess-btns' }).createEl('button', { text: '저장', cls: 'mod-cta' });
    b.onclick = async () => { P.data.budget = Number(inp.value) || 0; await P.saveData(P.data); md.close(); view.render(); };
    md.open();
    setTimeout(() => inp.focus(), 50);
  }
}
class SpendChild extends MarkdownRenderChild {
  constructor(plugin, el) { super(el); this.plugin = plugin; }
  onload() { new SpendView(this.plugin, this.containerEl).render(); }
}

// ---------- 👥 연락처: 사람·단체방을 카드로 (```연락처```) ----------
class PeopleView {
  constructor(plugin, root) { this.plugin = plugin; this.app = plugin.app; this.root = root; this.q = ''; this.kind = 'person'; this.sort = 'recent'; this.shown = 24; }
  async render() {
    const r = this.root, P = this.plugin, app = this.app;
    r.empty(); r.addClass('ks-root', 'rd-root');
    const status = r.createDiv({ cls: 'ks-status', text: '연락처 정리 중…' });
    await P.index.ensure();
    status.remove();
    // 연락처 노트: 이름 → 전화번호·노트
    const notes = new Map();
    for (const f of app.vault.getMarkdownFiles()) {
      if (!f.path.startsWith(CONTACTS + '/')) continue;
      const fm = app.metadataCache.getFileCache(f)?.frontmatter || {};
      const nm = String(fm.name || '').trim(), ph = String(fm.phone || '');
      notes.set(nm && nm !== '정보 없음' ? nm : ph || f.basename, { phone: ph, file: f });
    }
    // 한 번에 모아 세기: 통화 수, 1:1·단체방 메시지 수, 단체방에서 그 사람이 한 말, 마지막 연락
    const st = new Map();
    const get = (n) => { if (!st.has(n)) st.set(n, { name: n, group: false, own: false, last: '', calls: 0, talk: 0, gmsg: 0 }); return st.get(n); };
    const seen = (e, d) => { if (d && d > e.last) e.last = d; };
    for (const c of P.index.files.values()) {
      if (c.call) { const e = get(c.room); e.own = true; e.calls++; seen(e, c.call.date); continue; }
      const e = get(c.room); e.own = true; e.talk += c.msgs.length;
      if (c.kind === '단체') e.group = true;
      if (c.msgs.length) seen(e, c.msgs[c.msgs.length - 1].date);
      if (c.kind === '단체') for (const m of c.msgs) if (m.who !== '나') { const w = get(m.who); w.gmsg++; seen(w, m.date); }
    }
    // 1:1 대화나 통화가 있는 사람, 그리고 단체방 (단체방에서만 본 사람은 빼서 목록이 길어지지 않게)
    const all = [...st.values()].filter((e) => e.own).map((e) => ({ ...e, note: notes.get(e.name) }));
    // 제목 줄: 👥 연락처 · 개수 · (오른쪽) 전체 보기 — 챙길 날 칸과 같은 모양
    const head = r.createDiv({ cls: 'rd-section-head rd-people-head' });
    head.createSpan({ cls: 'rd-section-title', text: '👥 연락처' });
    this.countEl = head.createSpan({ cls: 'rd-count' });
    helpTip(head, '카드를 누르면 그 사람과의 약속·할 일, 챙길 날, 통화·카톡 히스토리가 열려요. 단체방 카드는 대화 검색으로 열려요.');
    this.toggleEl = head.createEl('a', { cls: 'rd-more' });
    // 도구 막대
    const bar = r.createDiv({ cls: 'rd-people-bar' });
    const q = bar.createEl('input', { type: 'search', value: this.q, attr: { placeholder: '이름·번호 찾기 (초성도 돼요)' } });
    q.oninput = debounce(() => { this.q = q.value; this.shown = 24; this.draw(grid, all); }, 200, true);
    const seg = bar.createDiv({ cls: 'ks-seg' });
    const cnt = (g) => all.filter((p) => p.group === g).length;
    for (const [v, label] of [['person', `👤 사람 ${cnt(false)}`], ['group', `👥 단체방 ${cnt(true)}`]]) {
      const b = seg.createEl('button', { text: label });
      b.toggleClass('is-active', this.kind === v);
      b.onclick = () => { this.kind = v; this.shown = 24; this.render(); };
    }
    const sel = bar.createEl('select', { cls: 'dropdown' });
    for (const [v, label] of [['recent', '최근 연락 순'], ['many', '연락 많은 순'], ['name', '이름 순']]) sel.createEl('option', { value: v, text: label });
    sel.value = this.sort;
    sel.onchange = () => { this.sort = sel.value; this.draw(grid, all); };
    const grid = r.createDiv();
    this.draw(grid, all);
  }
  draw(grid, all) {
    const P = this.plugin, app = this.app;
    grid.empty();
    let list = all.filter((p) => p.group === (this.kind === 'group'))
      .filter((p) => !this.q.trim() || matchName(p.name, this.q.trim()) || (p.note?.phone || '').replace(/-/g, '').includes(this.q.replace(/\D/g, '') || '@'));
    const score = (p) => p.calls * 20 + p.talk + p.gmsg;
    list.sort(this.sort === 'name' ? (a, b) => a.name.localeCompare(b.name, 'ko')
      : this.sort === 'many' ? (a, b) => score(b) - score(a) : (a, b) => b.last.localeCompare(a.last));
    if (!list.length) { grid.createDiv({ cls: 'rd-empty', text: '찾는 연락처가 없어요.' }); return; }
    // 처음엔 한 줄만 (화면 폭에 맞는 만큼), 찾기 중이거나 펼치면 여러 줄
    const one = !this.open && !this.q.trim();
    if (this.countEl) this.countEl.setText(String(list.length));
    if (this.toggleEl) {
      this.toggleEl.setText(this.open ? '접기 ›' : '전체 보기 ›');
      this.toggleEl.toggle(!this.q.trim());
      this.toggleEl.onclick = () => { this.open = !this.open; this.shown = 24; this.draw(grid, all); };
    }
    const cards = grid.createDiv({ cls: 'rd-cards' + (one ? ' is-one-row' : '') });
    for (const p of list.slice(0, this.shown)) {
      const c = cards.createDiv({ cls: 'rd-card' });
      c.onclick = (e) => { if (e.target.closest('a')) return; p.group ? new SearchModal(P, { room: p.name }).open() : new PersonModal(P, p.name).open(); };
      const top = c.createDiv({ cls: 'rd-card-top' });
      top.createDiv({ cls: 'rd-avatar', text: p.group ? '👥' : (p.name.match(/[가-힣A-Za-z]/) || ['#'])[0] });
      const nm = top.createDiv({ cls: 'rd-card-name' });
      nm.createDiv({ cls: 'rd-card-title', text: p.name });
      if (p.note?.phone && p.note.phone !== p.name) nm.createDiv({ cls: 'rd-muted', text: p.note.phone });
      const gap = p.last ? daysSince(p.last) : null;
      c.createDiv({ cls: 'rd-card-last' + (gap !== null && gap <= 7 ? ' is-fresh' : ''), text: p.last ? (gap === 0 ? '오늘 연락' : `${gap}일 전 · ${p.last.slice(2).replace(/-/g, '.')}`) : '' });
      const meta = c.createDiv({ cls: 'rd-card-meta' });
      if (p.calls) meta.createSpan({ cls: 'rd-chip', text: `📞 ${p.calls}` });
      if (p.talk) meta.createSpan({ cls: 'rd-chip', text: `💬 ${p.talk.toLocaleString()}` });
      if (p.gmsg) meta.createSpan({ cls: 'rd-chip', text: `👥 ${p.gmsg.toLocaleString()}` });
      if (p.note) { const a = meta.createEl('a', { cls: 'rd-chip rd-chip-link', text: '노트' }); a.onclick = () => app.workspace.getLeaf(false).openFile(p.note.file); }
    }
    if (!one && list.length > this.shown) {
      const more = grid.createEl('button', { cls: 'ks-more', text: `더 보기 (${list.length - this.shown}개)` });
      more.onclick = () => { this.shown += 24; this.draw(grid, all); };
    }
  }
}
class PeopleChild extends MarkdownRenderChild {
  constructor(plugin, el) { super(el); this.plugin = plugin; }
  onload() { new PeopleView(this.plugin, this.containerEl).render(); }
}

// 할 일(왼쪽) · 챙길 날(오른쪽)을 한 화면에 — 좁으면 위아래로
class BoardChild extends MarkdownRenderChild {
  constructor(plugin, el) { super(el); this.plugin = plugin; }
  onload() {
    const g = this.containerEl.createDiv({ cls: 'ks-board' });
    const col = (title) => { const c = g.createDiv({ cls: 'ks-board-col' }); c.createDiv({ cls: 'ks-board-title', text: title }); return c.createDiv(); };
    const left = col('✅ 할 일'), right = col('🎂 챙길 날');
    new TodoView(this.plugin, left).render();
    new DaysView(this.plugin, right).render();
  }
}

class DaysChild extends MarkdownRenderChild {
  constructor(plugin, el) { super(el); this.plugin = plugin; }
  onload() { new DaysView(this.plugin, this.containerEl).render(); }
}

module.exports = class RappoSearch extends Plugin {
  async onload() {
    const data = (await this.loadData()) || {};
    this.data = data;
    const base = String(data.base || '2. Areas/통화기록').replace(/\/+$/, '');
    BASE = base; CONTACTS = base + '/연락처'; KAKAO = base + '/카톡'; CALLS = base + '/통화';
    this.index = new Index(this.app);
    this.days = new Days(this);
    this.tasks = new Tasks(this);
    this.spend = new Spend(this);
    const handler = (src, el, ctx) => ctx.addChild(new BlockChild(this, el));
    for (const name of ['대화검색', '카톡검색', 'kakao-search']) this.registerMarkdownCodeBlockProcessor(name, handler);
    this.registerMarkdownCodeBlockProcessor('최근연락', (src, el, ctx) => ctx.addChild(new RecentChild(this, el)));
    this.registerMarkdownCodeBlockProcessor('챙길날', (src, el, ctx) => ctx.addChild(new DaysChild(this, el)));
    this.addCommand({ id: 'days', name: 'Rappo 챙길 날 적기', callback: () => this.days.openNote() });
    this.recorder = new Recorder(this);
    // 할 일 노트(#할일)를 고치면 할 일 목록과 캘린더에 바로 반영
    const syncSoon = debounce(async () => { await this.tasks.load(); await this.days.upcoming(); }, 1500, true);
    this.registerEvent(this.app.metadataCache.on('changed', (f) => {
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
      const tags = [].concat(fm?.tags || []).map(String);
      if (tags.includes('할일') || f.path === this.tasks.path) syncSoon();
    }));
    // 대시보드 노트(PARA 대시보드·연락 대시보드)는 열 때 늘 읽기 모드로 — 편집이 필요하면 그때 전환
    // 읽기 모드로 고정할 노트: PARA 대시보드 · 라포 홈 · 소비 대시보드 (+ 속성 view: reading 인 노트)
    const isDash = (f) => {
      if (!f) return false;
      const fixed = ['PARA 대시보드.md', '대시보드.md', `${BASE}/라포 홈.md`, `${BASE}/통화기록 대시보드.md`, `${BASE}/소비/소비 대시보드.md`];
      if (fixed.includes(f.path)) return true;
      return this.app.metadataCache.getFileCache(f)?.frontmatter?.view === 'reading';
    };
    const forcedPreview = new WeakSet();   // 우리가 읽기 모드로 바꾼 탭
    // 탭마다 '이 파일을 처음 연 순간'에만 읽기 모드로 바꾼다 (그 뒤 직접 편집 모드로 바꾸면 그대로 둠)
    const forced = new WeakMap();
    // 탭의 '보기 상태'로 판단 — 옵시디언이 아직 불러오지 않은 뒤쪽 탭(지연 로딩)도 함께 처리
    const ensureReading = () => {
      this.app.workspace.iterateAllLeaves((leaf) => {
        const st = leaf.getViewState();
        const path = st && st.type === 'markdown' && st.state && st.state.file;
        if (!path || forced.get(leaf) === path) return;
        const f = this.app.vault.getAbstractFileByPath(path);
        if (!(f instanceof TFile) || !this.app.metadataCache.getFileCache(f)) return;   // 아직 색인 전이면 다음 기회에
        // 대시보드에서 같은 탭으로 다른 노트를 열면, 우리가 바꿔 둔 읽기 모드를 편집 모드로 되돌린다
        if (!isDash(f)) {
          forced.set(leaf, path);
          if (forcedPreview.has(leaf) && st.state.mode === 'preview') {
            forcedPreview.delete(leaf);
            leaf.setViewState({ ...st, state: { ...st.state, mode: 'source' } });
          } else forcedPreview.delete(leaf);
          return;
        }
        // 대시보드: 읽기 모드인 걸 '확인'했을 때만 끝난 것으로 (옵시디언이 편집 모드로 덮어쓰는 경우가 있어 몇 번 더 본다)
        forcedPreview.add(leaf);
        if (st.state.mode === 'preview') { forced.set(leaf, path); return; }
        leaf.setViewState({ ...st, state: { ...st.state, mode: 'preview' } });
      });
    };
    const later = () => { for (const t of [0, 150, 500, 1200, 2500]) window.setTimeout(ensureReading, t); };
    this.registerEvent(this.app.workspace.on('file-open', later));
    this.registerEvent(this.app.workspace.on('active-leaf-change', later));
    this.registerEvent(this.app.workspace.on('layout-change', later));
    this.registerEvent(this.app.metadataCache.on('resolved', later));
    // 옵시디언을 켤 때: 대시보드가 아닌데 읽기 모드로 남아 있는 탭은 편집 모드로
    this.app.workspace.onLayoutReady(() => { this.app.workspace.iterateAllLeaves((l) => forcedPreview.add(l)); later(); });
    this.registerMarkdownCodeBlockProcessor('회의', (src, el, ctx) => ctx.addChild(new MeetingsChild(this, el, ctx.sourcePath)));
    this.registerMarkdownCodeBlockProcessor('회의할일', (src, el, ctx) => ctx.addChild(new MeetingTasksChild(this, el, ctx.sourcePath)));
    // 프로젝트·영역 노트 오른쪽 위에 🎙 새 회의 버튼
    const views = new WeakMap();
    const mark = () => {
      this.app.workspace.iterateAllLeaves((leaf) => {
        const v = leaf.view;
        if (!(v instanceof MarkdownView)) return;
        let b = views.get(v);
        if (!b) { b = v.addAction('mic', 'Rappo 새 회의', () => this.recorder.on ? this.recorder.stop() : new MeetingModal(this, targetOf(this.app, v.file)).open()); views.set(v, b); }
        b.toggle(!!targetOf(this.app, v.file) || this.recorder.on);
      });
    };
    this.registerEvent(this.app.workspace.on('layout-change', mark));
    this.registerEvent(this.app.workspace.on('file-open', mark));
    this.registerEvent(this.app.metadataCache.on('changed', mark));
    this.registerEvent(this.app.workspace.on('rappo:rec', mark));
    this.app.workspace.onLayoutReady(mark);
    this.addCommand({ id: 'meeting-block', name: 'Rappo 이 노트에 회의 칸 넣기', editorCallback: (ed) => {
      const t = ed.getValue();
      if (t.includes('```회의')) { new Notice('이미 회의 칸이 있어요'); return; }
      ed.setValue(t.replace(/\n*$/, '\n') + '\n## 회의\n```회의\n```\n');
    } });
    this.addCommand({ id: 'meeting', name: 'Rappo 회의 녹음 시작', callback: () => this.recorder.on ? this.recorder.stop() : new MeetingModal(this).open() });
    this.addCommand({ id: 'mic', name: 'Rappo 마이크 권한 확인', callback: () => askMic() });
    this.addCommand({ id: 'meeting-stop', name: 'Rappo 회의 녹음 끝내기', checkCallback: (chk) => { if (!this.recorder.on) return false; if (!chk) this.recorder.stop(); return true; } });
    this.addRibbonIcon('mic', 'Rappo 회의 녹음', () => this.recorder.on ? this.recorder.stop() : new MeetingModal(this).open());
    this.addCommand({ id: 'task-add', name: 'Rappo 할 일 추가', callback: () => new TaskModal(this, null, (v) => this.tasks.add(v)).open() });
    // 옵시디언을 열면 하루 한 번, 3일 안에 챙길 날을 알림으로 (맥 알림용 upcoming.json 도 이때 새로 씀)
    this.app.workspace.onLayoutReady(() => setTimeout(() => this.dayNotice(), 8000));
    // 대시보드 이름: 통화기록 대시보드 → 라포 홈 (옵시디언이 링크도 함께 고친다)
    this.app.workspace.onLayoutReady(async () => {
      const old = this.app.vault.getAbstractFileByPath(`${BASE}/통화기록 대시보드.md`);
      if (old instanceof TFile && !this.app.vault.getAbstractFileByPath(`${BASE}/라포 홈.md`)) {
        try { await this.app.fileManager.renameFile(old, `${BASE}/라포 홈.md`); } catch (e) { console.warn('Rappo: 이름 변경', e); }
      }
    });
    this.registerMarkdownCodeBlockProcessor('할일', (src, el, ctx) => ctx.addChild(new TodoChild(this, el)));
    this.registerMarkdownCodeBlockProcessor('할일챙길날', (src, el, ctx) => ctx.addChild(new BoardChild(this, el)));
    this.registerMarkdownCodeBlockProcessor('소비', (src, el, ctx) => ctx.addChild(new SpendChild(this, el)));
    // 연락처 노트의 ```사람``` — 그 사람의 약속·할 일·챙길 날·히스토리
    this.registerMarkdownCodeBlockProcessor('사람', (src, el, ctx) => ctx.addChild(new PersonChild(this, el, ctx.sourcePath, src.trim())));
    this.registerMarkdownCodeBlockProcessor('연락처', (src, el, ctx) => ctx.addChild(new PeopleChild(this, el)));
    this.registerMarkdownCodeBlockProcessor('연락대시보드', (src, el, ctx) => ctx.addChild(new ContactDashChild(this, el)));
    this.addCommand({ id: 'open', name: 'Rappo 대화·통화 검색', callback: () => new SearchModal(this).open() });
    this.addRibbonIcon('message-circle', 'Rappo 대화·통화 검색', () => new SearchModal(this).open());
    // 바뀐 파일은 다음 검색 때 다시 읽는다 (mtime 비교)
    this.registerEvent(this.app.vault.on('delete', (f) => this.index.files.delete(f.path)));
    this.registerEvent(this.app.vault.on('rename', (f, old) => this.index.files.delete(old)));
  }
  onunload() { if (this.recorder && this.recorder.on) this.recorder.stop(); }
  // 다른 플러그인(PARA 대시보드 등)에서 부르는 회의 버튼: 녹음 중이면 끝내고, 아니면 새 회의
  openMeeting(target) { if (this.recorder.on) this.recorder.stop(); else new MeetingModal(this, target || null).open(); }
  async dayNotice() {
    try {
      const { ev } = await this.days.upcoming();
      const key = 'rappo-day-notice';
      if (window.localStorage.getItem(key) === today()) return;
      const soon = ev.filter((e) => !e.guess && e.dday <= 3);
      if (!soon.length) return;
      window.localStorage.setItem(key, today());
      new Notice('🎂 Rappo 챙길 날\n' + soon.map((e) => `${e.dday ? 'D-' + e.dday : '오늘'} ${e.title}`).join('\n'), 12000);
    } catch (e) { console.warn('Rappo: 챙길 날', e); }
  }
};

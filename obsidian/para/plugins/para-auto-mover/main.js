const { Plugin, Notice, TFile, TFolder, normalizePath } = require('obsidian');

const DIR = {
  inbox: '0. Inbox',
  projects: '1. Projects',
  areas: '2. Areas',
  resources: '3. Resources',
  archive: '4. Archive',
};
const ACTIVE_PROJECT = ['시작 안 함', '시작 전', '진행 중', ''];
const SKIP_NAMES = ['무제', 'Untitled'];
const IGNORE_PREFIX = ['_Templates', '.'];

function asList(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}
function linkName(v) {
  const m = String(v).match(/\[\[([^\]|#]+)/);
  return m ? m[1].trim() : String(v).trim();
}
function dirOf(path) {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

module.exports = class ParaAutoMover extends Plugin {
  async onload() {
    this.timers = {};
    this.busy = false;
    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(this.app.metadataCache.on('changed', (f) => this.schedule(f)));
      this.registerEvent(this.app.vault.on('rename', (f) => { if (f instanceof TFile) this.schedule(f); }));
    });
    this.addCommand({ id: 'para-move-current', name: '현재 노트 PARA 폴더로 이동', callback: () => {
      const f = this.app.workspace.getActiveFile(); if (f) this.process(f, true);
    }});
    this.addCommand({ id: 'para-move-all', name: '전체 노트 PARA 재분류', callback: () => this.processAll() });
  }

  schedule(file) {
    if (!(file instanceof TFile) || file.extension !== 'md') return;
    clearTimeout(this.timers[file.path]);
    this.timers[file.path] = setTimeout(() => { delete this.timers[file.path]; this.process(file, false); }, 2500);
  }

  async processAll() {
    let n = 0;
    for (const f of this.app.vault.getMarkdownFiles()) if (await this.process(f, false, true)) n++;
    new Notice(`PARA 재분류: ${n}개 이동`);
  }

  resolve(name, from) {
    return this.app.metadataCache.getFirstLinkpathDest(name, from.path);
  }

  // returns {kind:'file'|'folder', target}
  plan(file) {
    if (IGNORE_PREFIX.some((p) => file.path.startsWith(p))) return null;
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    if (!fm || !fm.type) return null;
    const type = String(fm.type).trim();
    const status = fm.status == null ? '' : String(fm.status).trim();
    const name = file.basename;

    const indexTarget = (root) => {
      if (SKIP_NAMES.some((s) => name === s || name.startsWith(s + ' '))) return null;
      return { root, name };
    };

    if (type === 'project') return indexTarget(ACTIVE_PROJECT.includes(status) ? DIR.projects : DIR.archive);
    if (type === 'area') return indexTarget(status === '아카이브' ? DIR.archive : DIR.areas);
    if (type === 'resource') return indexTarget(DIR.resources);
    if (type === 'archive') return indexTarget(DIR.archive);
    if (type !== 'note') return null; // subpage 등은 건드리지 않음

    for (const key of ['project', 'area']) {
      const vals = asList(fm[key]).filter((v) => String(v).trim());
      if (!vals.length) continue;
      const dest = this.resolve(linkName(vals[0]), file);
      if (!dest) return { pending: true }; // 아직 입력 중이거나 없는 링크 → 보류
      return { folder: dirOf(dest.path) };
    }
    return { folder: DIR.inbox };
  }

  async ensureFolder(path) {
    if (!path || this.app.vault.getAbstractFileByPath(path)) return;
    const parent = dirOf(path);
    if (parent) await this.ensureFolder(parent);
    await this.app.vault.createFolder(path);
  }

  async process(file, verbose, quiet) {
    if (this.busy) return false;
    const p = this.plan(file);
    if (!p || p.pending) {
      if (verbose) new Notice(p && p.pending ? '연결한 영역/프로젝트 노트를 찾지 못해 이동하지 않았어요' : 'type이 없거나 이동 대상이 아니에요');
      return false;
    }
    this.busy = true;
    try {
      if (p.root) {
        // 인덱스 노트: "<root>/<name>/<name>.md". 같은 이름 폴더 안에 있으면 폴더째 이동
        const want = normalizePath(`${p.root}/${p.name}/${p.name}.md`);
        if (file.path === want) return false;
        const parent = file.parent;
        if (parent && parent.name === p.name && parent.path !== '/') {
          const target = normalizePath(`${p.root}/${p.name}`);
          if (this.app.vault.getAbstractFileByPath(target)) { new Notice(`이미 있는 폴더라 이동 못함: ${target}`); return false; }
          await this.ensureFolder(p.root);
          await this.app.fileManager.renameFile(parent, target);
        } else {
          if (this.app.vault.getAbstractFileByPath(want)) { new Notice(`이미 있는 파일이라 이동 못함: ${want}`); return false; }
          await this.ensureFolder(dirOf(want));
          await this.app.fileManager.renameFile(file, want);
        }
        if (!quiet) new Notice(`📁 ${p.name} → ${p.root}`);
        return true;
      }
      const target = normalizePath(`${p.folder}/${file.name}`);
      if (dirOf(file.path) === p.folder || file.path === target) return false;
      if (this.app.vault.getAbstractFileByPath(target)) { new Notice(`같은 이름 파일이 있어 이동 못함: ${target}`); return false; }
      await this.ensureFolder(p.folder);
      await this.app.fileManager.renameFile(file, target);
      if (!quiet) new Notice(`📄 ${file.basename} → ${p.folder}`);
      return true;
    } catch (e) {
      console.error('[PARA Auto Mover]', e);
      new Notice('PARA 이동 중 오류: ' + e.message);
      return false;
    } finally {
      this.busy = false;
    }
  }
};

/* ui.js — 渲染与交互 */
(() => {
  'use strict';
  const W = window.WACAA || {};
  const { el, escapeHtml, clampInt } = W;

  /* ---- DOM 引用 ---- */
  const appRoot = document.getElementById('app');
  const topActions = document.getElementById('topActions');
  const toastRoot = document.getElementById('toasts');
  const modalBackdrop = document.getElementById('modalBackdrop');
  const modalTitle = document.getElementById('modalTitle');
  const modalBody = document.getElementById('modalBody');
  const modalFooter = document.getElementById('modalFooter');
  const modalCloseBtn = document.getElementById('modalCloseBtn');

  /* ---- Toast ---- */
  W.toast = function toast(msg) {
    const routeName = W.state?.ui?.route?.name;
    if (routeName === 'multilevel') {
      const s = String(msg || '');
      if (s.includes('胜者组生成') || s.includes('败者组生成') || s.includes('桌子数自动调整') ||
          s.includes('已回收') || s.includes('比赛已开始') || s.includes('继续补桌') ||
          s.includes('已新增：') || s.includes('已添加 ') || s.includes('已忽略重复')) return;
    }
    const dv = document.createElement('div');
    dv.className = 'toast'; dv.textContent = msg;
    toastRoot.appendChild(dv);
    setTimeout(() => { dv.style.opacity = '0'; dv.style.transition = 'opacity .25s ease'; }, 2600);
    setTimeout(() => dv.remove(), 3200);
  };

  /* ---- Modal ---- */
  function closeModal() {
    modalBackdrop.style.display = 'none'; modalTitle.textContent = ''; modalBody.innerHTML = ''; modalFooter.innerHTML = '';
  }
  modalCloseBtn.addEventListener('click', closeModal);
  modalBackdrop.addEventListener('click', (e) => { if (e.target === modalBackdrop) closeModal(); });

  function openModal({ title, bodyEl, footerEl }) {
    modalTitle.textContent = title; modalBody.innerHTML = ''; modalFooter.innerHTML = '';
    if (bodyEl) modalBody.appendChild(bodyEl);
    if (footerEl) modalFooter.appendChild(footerEl);
    modalBackdrop.style.display = 'flex';
  }

  /* ---- 路由 ---- */
  W.setRoute = function setRoute(route) {
    W.state.ui.route = route; W.saveState(); W.render();
  };

  /*
   * 赛情唯一入口：记录来源页，返回时回到刚才的单级别/多级别页面。
   * 单级别、级别卡片、多级别面板都走这一个函数，避免再出现两套参数。
   */
  function openSituation(tournamentId, levelId) {
    const current = W.state.ui && W.state.ui.route ? W.state.ui.route : null;
    let from = { name: 'level', tournamentId, levelId };
    if (current && current.name === 'multilevel') {
      from = {
        name: 'multilevel',
        tournamentId,
        levelIds: Array.isArray(current.levelIds) ? current.levelIds.slice() : [],
      };
    }
    W.setRoute({ name: 'situation', tournamentId, levelId, from });
  }

  /* ---- 事件处理 ---- */
  // C3: 接受 level 参数，避免从路由取错 level
  function processEvents(events, level) {
    if (!events) return;
    for (const evt of events) {
      if (evt.type === 'matchesGenerated') W.toast(`${evt.bracket === 'W' ? '胜者组' : '败者组'}生成 ${evt.count} 场对阵`);
      else if (evt.type === 'tableAdjusted') W.toast(`桌子数自动调整为 ${evt.count} 张`);
      else if (evt.type === 'bye') W.toast(`${evt.name} 轮空直接晋级`);
      else if (evt.type === 'started') W.toast('比赛已开始');
      else if (evt.type === 'stage') {
        showBannerModal(evt.stage === 'top8' ? '前8强诞生' : '前3强诞生',
          evt.stage === 'top8' ? '当前级别已进入前8强阶段。' : '当前级别已进入前三强阶段。');
      }
      else if (evt.type === 'grandFinal') {
        W.toast('进入总决赛阶段（BO3 三局两胜）');
        if (level) showGrandFinalModal(level);
      }
      else if (evt.type === 'gfComplete') {
        // C3 fix: 优先用传入的 level，否则从路由取
        const champ = level?.players?.[evt.winnerId]?.name || '';
        W.toast(`总决赛结束：冠军 ${champ}`);
      }
    }
  }

  /* ---- 渲染入口 ---- */
  W.render = function render() {
    const route = W.state.ui.route || { name: 'home' };
    document.body.classList.toggle('situation-mode', route.name === 'situation');
    renderTopActions(route); appRoot.innerHTML = '';
    if (route.name === 'home') renderHome();
    else if (route.name === 'tournament') renderTournament(route.tournamentId);
    else if (route.name === 'level') renderLevel(route.tournamentId, route.levelId);
    else if (route.name === 'multilevel') renderMultiLevel(route.tournamentId, route.levelIds);
    else if (route.name === 'situation') renderSituation(route.tournamentId, route.levelId);
    else renderHome();
  };

  function renderTopActions(route) {
    topActions.innerHTML = '';
    const div = el('div', { class: 'row' }, []);
    if (route.name !== 'home') div.appendChild(el('button', { class: 'btn small', onclick: () => W.setRoute({ name: 'home' }) }, ['返回主界面']));
    div.appendChild(el('button', { class: 'btn small', onclick: () => openImportExportModal() }, ['导入/导出']));
    // 清空前自动下载 JSON 备份，并连备份键一起清掉
    div.appendChild(el('button', { class: 'btn small danger', onclick: () => {
      if (!confirm('确定清空所有本地数据？\n\n清空前会自动下载一份 JSON 备份到“下载”文件夹。')) return;
      const downloaded = downloadStateJson();
      W.clearAllData();
      W.state = W.loadState(); W.render();
      W.toast(downloaded ? '已清空本地数据，备份已下载' : '已清空本地数据（自动备份下载失败，请手动导出）');
    } }, ['清空全部数据']));
    topActions.appendChild(div);
  }

  /* 把当前状态直接下载为 JSON 文件；返回是否成功 */
  function downloadStateJson() {
    try {
      const d = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
      const blob = new Blob([JSON.stringify(W.state, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `腕力比赛数据-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return true;
    } catch (e) {
      return false;
    }
  }

  /* ==================== 主页 ==================== */
  function renderHome() {
    appRoot.appendChild(el('div', { class: 'page-head' }, [
      el('div', {}, [
        el('div', { class: 'eyebrow' }, ['WACAA · 赛事控制台']),
        el('h1', { class: 'page-title' }, ['赛事总览']),
        el('p', { class: 'page-desc' }, ['管理比赛与级别，实时记录双败淘汰赛程。数据仅保存在本机，离线可用。']),
      ]),
    ]));
    const wrap = el('div', { class: 'grid cols-2' }, []);
    const left = el('div', { class: 'card' }, [
      el('div', { class: 'card-hd' }, [
        el('div', {}, [el('div', { class: 'title' }, ['比赛管理']), el('div', { class: 'subtitle' }, ['双败淘汰｜自动备份｜离线可用'])]),
        el('button', { class: 'btn primary', onclick: () => addTournamentFlow() }, ['新建比赛']),
      ]),
      el('div', { class: 'card-bd' }, [
        W.state.tournaments.length
          ? el('div', { class: 'list' }, W.state.tournaments.slice().sort((a, b) => b.createdAt - a.createdAt).map((t) => renderTournamentCard(t)))
          : el('div', { class: 'empty-state' }, [el('strong', {}, ['还没有比赛']), '点击右上角「新建比赛」开始编排。']),
      ]),
    ]);
    const right = el('div', { class: 'card kpi-card' }, [
      el('div', { class: 'card-hd' }, [el('div', {}, [el('div', { class: 'title' }, ['使用说明']), el('div', { class: 'subtitle' }, ['完全离线，5 分钟自动备份。'])])]),
      el('div', { class: 'card-bd' }, [
        el('div', { class: 'kpi' }, [kpi('已创建比赛', String(W.state.tournaments.length)), kpi('数据存储', 'localStorage'), kpi('赛制', '双败淘汰'), kpi('自动备份', '5分钟')]),
        el('div', { class: 'hr' }), el('div', { class: 'muted' }, ['URL 加 ?reset=1 可重置全部数据。比赛开始后支持退赛（选手列表→右击/长按）。']),
      ]),
    ]);
    wrap.appendChild(left); wrap.appendChild(right); appRoot.appendChild(wrap);
  }

  function kpi(k, v) { return el('div', {}, [el('div', { class: 'k' }, [k]), el('div', { class: 'v' }, [v])]); }

  function renderTournamentCard(t) {
    return el('div', { class: 'list-item clickable', onclick: () => W.setRoute({ name: 'tournament', tournamentId: t.id }) }, [
      el('div', { class: 'stack' }, [el('div', { class: 'name' }, [t.name]), el('div', { class: 'py muted' }, [`级别数：${t.levels.length}`])]),
      el('div', { class: 'row' }, [
        el('button', { class: 'btn small', onclick: (e) => { e.stopPropagation(); editTournamentNameFlow(t.id); } }, ['编辑']),
        el('button', { class: 'btn small danger', onclick: (e) => { e.stopPropagation(); deleteTournamentFlow(t.id); } }, ['删除']),
      ]),
    ]);
  }

  function addTournamentFlow() { const n = prompt('请输入比赛名称', '新建比赛'); if (n !== null) { W.state.tournaments.push(W.createTournament(n)); W.saveState(); W.render(); } }
  function editTournamentNameFlow(id) { const t = W.state.tournaments.find((x) => x.id === id); if (!t) return; const n = prompt('修改比赛名称', t.name); if (n !== null) { t.name = (n || '').trim() || t.name; W.saveState(); W.render(); } }
  function deleteTournamentFlow(id) { const t = W.state.tournaments.find((x) => x.id === id); if (!t) return; if (!confirm(`确定删除"${t.name}"？此操作不可撤销。`)) return; W.state.tournaments = W.state.tournaments.filter((x) => x.id !== id); W.saveState(); W.render(); }

  function openImportExportModal() {
    const body = document.createElement('div');
    body.innerHTML = `<div class="subtitle">导出包含所有比赛数据。导入覆盖本地数据（会先备份）。</div><div class="hr"></div><div class="field"><label>JSON</label><textarea class="input mono" id="jsonArea" placeholder="点击导出生成，或粘贴 JSON 后点击导入"></textarea></div><div class="hint" style="margin-top:10px;">建议定期导出备份。</div>`;
    const ft = document.createElement('div');
    const exp = el('button', { class: 'btn primary', onclick: () => { body.querySelector('#jsonArea').value = JSON.stringify(W.state, null, 2); W.toast('已生成导出 JSON'); } }, ['导出']);
    const imp = el('button', { class: 'btn ok', onclick: () => {
      const txt = body.querySelector('#jsonArea').value.trim();
      if (!txt) { alert('导入失败：内容为空，请先粘贴 JSON'); return; }
      const parsed = W.safeJsonParse(txt);
      if (parsed == null) { alert('导入失败：不是合法的 JSON，请检查文件是否完整'); return; }
      const result = W.normalizeState(parsed);
      if (result.error) { alert('导入失败：' + result.error); return; }
      if (!confirm('导入会覆盖本地全部数据。导入前已自动备份，确定继续？')) return;
      W.backupState();  // 导入前先备份
      W.state = result.state; W.saveState(); closeModal();
      W.toast(result.warnings.length
        ? `导入成功，已自动修正 ${result.warnings.length} 处问题数据`
        : '导入成功');
      W.render();
    } }, ['导入（覆盖）']);
    ft.appendChild(el('button', { class: 'btn', onclick: closeModal }, ['关闭'])); ft.appendChild(exp); ft.appendChild(imp);
    openModal({ title: '导入/导出数据', bodyEl: body, footerEl: ft });
  }

  /* ==================== 比赛页面 ==================== */
  function renderTournament(tournamentId) {
    const t = W.state.tournaments.find((x) => x.id === tournamentId); if (!t) return W.setRoute({ name: 'home' });
    const header = el('div', { class: 'card' }, [
      el('div', { class: 'card-hd' }, [
        el('div', {}, [el('div', { class: 'title' }, [t.name]), el('div', { class: 'subtitle' }, ['级别按左/右手分组。'])]),
        el('div', { class: 'row' }, [el('button', { class: 'btn', onclick: () => editTournamentNameFlow(t.id) }, ['改名']), el('button', { class: 'btn primary', onclick: () => addLevelFlow(t.id) }, ['新增级别'])]),
      ]),
      el('div', { class: 'card-bd' }, [el('div', { class: 'kpi' }, [kpi('级别数', String(t.levels.length)), kpi('左手', String(t.levels.filter((l) => l.name.includes('左')).length)), kpi('右手', String(t.levels.filter((l) => l.name.includes('右')).length)), kpi('其他', String(t.levels.filter((l) => !l.name.includes('左') && !l.name.includes('右')).length))])]),
    ]);
    const grouped = groupLevels(t.levels);
    const listCard = el('div', { class: 'card' }, [
      el('div', { class: 'card-hd' }, [el('div', {}, [el('div', { class: 'title' }, ['级别列表']), el('div', { class: 'subtitle' }, ['点击卡片进入级别。'])]), el('div', { class: 'row' }, [el('button', { class: 'btn ok', onclick: () => openMultiLevelSelectorModal(t.id) }, ['多级别同时开始'])])]),
      el('div', { class: 'card-bd' }, [renderLevelGroup('左手组', grouped.left, t.id), renderLevelGroup('右手组', grouped.right, t.id), renderLevelGroup('其他组', grouped.other, t.id)]),
    ]);
    appRoot.appendChild(el('div', { class: 'grid' }, [header, listCard]));
  }

  function groupLevels(levels) {
    const left = [], right = [], other = [];
    for (const l of levels) { if (l.name.includes('左')) left.push(l); else if (l.name.includes('右')) right.push(l); else other.push(l); }
    const srt = (a, b) => b.createdAt - a.createdAt;
    return { left: left.sort(srt), right: right.sort(srt), other: other.sort(srt) };
  }

  function renderLevelGroup(title, levels, tournamentId) {
    const quickHand = title.includes('左') ? '左手' : title.includes('右') ? '右手' : null;
    const block = el('div', {}, [
      el('div', { class: 'row between', style: 'margin-bottom:10px;margin-top:8px;' }, [
        el('div', { class: 'row' }, [el('div', { class: 'title' }, [title]), quickHand ? el('button', { class: 'btn small primary', onclick: () => addLevelQuickFlow(tournamentId, quickHand) }, ['添加']) : null]),
        el('span', { class: 'badge' }, [`${levels.length} 个`]),
      ]),
    ]);
    if (!levels.length) { block.appendChild(el('div', { class: 'muted', style: 'margin-bottom:8px;' }, ['暂无'])); return block; }
    block.appendChild(el('div', { class: 'grid cols-2' }, levels.map((l) => renderLevelCard(l, tournamentId))));
    block.appendChild(el('div', { class: 'hr' })); return block;
  }

  function addLevelQuickFlow(tournamentId, handLabel) {
    const t = W.state.tournaments.find((x) => x.id === tournamentId); if (!t) return;
    const n = prompt(`新增${handLabel}级别名称`, ''); if (n === null) return;
    const finalName = (n || '').trim() || '未命名级别';
    const lvl = W.createLevel({ name: `${handLabel}${finalName === '未命名级别' ? '' : finalName}`, maxTables: 3 });
    t.levels.push(lvl); W.saveState(); W.render(); W.toast(`已新增：${lvl.name}`);
  }

  function renderLevelCard(level, tournamentId) {
    const alive = W.alivePlayers(level).length;
    const tableWant = W.computeTableCount(level);
    const badge = level.finished ? el('span', { class: 'badge ok' }, ['已结束']) : level.started ? el('span', { class: 'badge warn' }, ['进行中']) : el('span', { class: 'badge' }, ['未开始']);
    return el('div', { class: 'card level-card clickable', onclick: () => W.setRoute({ name: 'level', tournamentId, levelId: level.id }) }, [
      el('div', { class: 'card-hd' }, [el('div', {}, [el('div', { class: 'title' }, [level.name]), el('div', { class: 'subtitle' }, [`存活：${alive}｜桌上限：${level.maxTables}｜自动：${tableWant}`])]), el('div', { class: 'row' }, [badge])]),
      el('div', { class: 'card-bd' }, [el('div', { class: 'row between' }, [el('div', { class: 'muted' }, [level.started ? (level.finished ? '已结束' : '进行中') : '未开始']), el('div', { class: 'row level-card-tools' }, [
        el('button', { class: 'btn small', 'data-action': 'situation', 'data-level-id': level.id, title: '查看本级别赛情位置图', onclick: (e) => { e.stopPropagation(); openSituation(tournamentId, level.id); } }, ['赛情']),
        el('button', { class: 'btn small', 'data-action': 'table-limit', 'data-level-id': level.id, title: '直接修改本级别桌数，不需要改名', onclick: (e) => { e.stopPropagation(); openTableLimitFlow(level); } }, [`桌数 ${level.maxTables}`]),
        el('button', { class: 'btn small', onclick: (e) => { e.stopPropagation(); editLevelFlow(tournamentId, level.id); } }, ['编辑']),
        el('button', { class: 'btn small danger', onclick: (e) => { e.stopPropagation(); deleteLevelFlow(tournamentId, level.id); } }, ['删除']),
      ])])]),
    ]);
  }

  function openMultiLevelSelectorModal(tournamentId) {
    const t = W.state.tournaments.find((x) => x.id === tournamentId); if (!t) return;
    const remembered = W.state.ui?.multiLevelSelection?.[tournamentId] || [];
    const sel = new Set(remembered);
    const body = document.createElement('div');
    body.appendChild(el('div', { class: 'subtitle' }, ['选择要同时进行的级别（每个固定 1 桌）。']));
    body.appendChild(el('div', { class: 'hr' }));
    body.appendChild(el('div', { class: 'list' }, t.levels.slice().sort((a, b) => b.createdAt - a.createdAt).map((lvl) => {
      const cb = el('input', { type: 'checkbox' }); if (sel.has(lvl.id)) cb.checked = true;
      cb.addEventListener('click', (e) => e.stopPropagation());
      cb.addEventListener('change', () => { if (cb.checked) sel.add(lvl.id); else sel.delete(lvl.id); });
      return el('div', { class: 'list-item clickable', onclick: () => { cb.checked = !cb.checked; if (cb.checked) sel.add(lvl.id); else sel.delete(lvl.id); } }, [el('div', { class: 'stack' }, [el('div', { class: 'name' }, [lvl.name]), el('div', { class: 'py muted' }, [`选手：${Object.keys(lvl.players || {}).length}`])]), cb]);
    })));
    const ft = document.createElement('div');
    ft.appendChild(el('button', { class: 'btn', onclick: closeModal }, ['取消']));
    ft.appendChild(el('button', { class: 'btn ok', onclick: () => {
      const ids = Array.from(sel);
      if (ids.length < 2) return W.toast('至少选 2 个');
      W.state.ui.multiLevelSelection ||= {}; W.state.ui.multiLevelSelection[tournamentId] = ids;
      W.saveState(); closeModal(); W.setRoute({ name: 'multilevel', tournamentId, levelIds: ids });
    } }, ['进入多级别']));
    openModal({ title: '选择级别', bodyEl: body, footerEl: ft });
  }

  function addLevelFlow(tournamentId) {
    const t = W.state.tournaments.find((x) => x.id === tournamentId); if (!t) return;
    const type = prompt('请输入类型（左手/右手）', '左手'); if (type === null) return;
    const hand = String(type).includes('左') ? '左手' : String(type).includes('右') ? '右手' : '其他';
    const weight = prompt('体重数字', '65'); if (weight === null) return;
    const w = String(weight).replace(/[^\d]/g, '');
    const rec = hand === '其他' ? `${w || ''}kg` : `${hand}${w || ''}kg`;
    const name = prompt('确认名称', rec || '未命名'); if (name === null) return;
    const maxTables = prompt('桌子数量（1~3）', '3');
    const lvl = W.createLevel({ name, maxTables });
    t.levels.push(lvl); W.saveState(); W.render();
  }

  function editLevelFlow(tournamentId, levelId) {
    const { level } = W.getLevel(tournamentId, levelId); if (!level) return;
    const n = prompt('修改名称', level.name); if (n !== null) level.name = (n || '').trim() || level.name;
    const mt = prompt('桌子数（1~3）', String(level.maxTables)); if (mt !== null) level.maxTables = clampInt(mt, 1, 3);
    W.saveState(); W.render();
  }

  function deleteLevelFlow(tournamentId, levelId) {
    const { tournament, level } = W.getLevel(tournamentId, levelId); if (!tournament || !level) return;
    if (!confirm(`确定删除"${level.name}"？此操作不可撤销。`)) return;
    tournament.levels = tournament.levels.filter((l) => l.id !== levelId);
    W.saveState(); W.render();
  }

  /* 退回赛前设置：只对当前级别生效，二次确认后清除比赛进度但保留选手与设置。 */
  const RESET_LEVEL_CONFIRM = '退回赛前设置后，将清除当前级别的全部比赛进度和比赛结果，但保留选手名单及比赛设置。确定继续吗？';

  function resetLevelFlow(level) {
    if (!level || !level.started) { W.toast('当前已是赛前设置状态'); return; }
    if (!confirm(RESET_LEVEL_CONFIRM)) return;
    if (!W.resetLevelToSetup(level)) return;
    W.saveState();
    W.render();
    W.toast('已退回赛前设置，可补充选手后重新开始');
  }

  /*
   * 跨级别占用冲突提示：只针对旧数据里已经发生的“同一个人同时在两张桌上”。
   * 只提示、不修改任何比赛；新排桌仍由占用表挡住该选手，不会产生新冲突。
   * 传入 onlyLevelId 时只显示与该级别有关的冲突（单级别详情页使用）。
   */
  function renderCrossLevelConflict(conflicts, onlyLevelId) {
    const list = (conflicts || []).filter((c) => !onlyLevelId || c.levelIds.indexOf(onlyLevelId) !== -1);
    if (!list.length) return null;
    const text = list.map((c) => `${c.name}（${c.levelNames.join('、')}）`).join('；');
    return el('section', { class: 'card cross-conflict', role: 'status', 'aria-live': 'polite' }, [
      el('div', { class: 'card-bd' }, [
        el('div', { class: 'row between cross-conflict-row' }, [
          el('div', { class: 'title cross-conflict-title' }, ['跨级别占用冲突']),
          el('span', { class: 'badge danger' }, [`${list.length} 人`]),
        ]),
        el('div', { class: 'hint' }, [`${text} 同时出现在多个级别的比赛中。已保留现有比赛，不会再安排新的冲突对阵；请先处理场上比赛。`]),
      ]),
    ]);
  }

  /* ==================== 多级别模式 ==================== */
  function renderMultiLevel(tournamentId, levelIds) {
    const t = W.state.tournaments.find((x) => x.id === tournamentId); if (!t) return W.setRoute({ name: 'home' });
    const levels = (levelIds || []).map((id) => t.levels.find((l) => l.id === id)).filter(Boolean);
    if (levels.length < 2) return W.setRoute({ name: 'tournament', tournamentId });
    const header = el('div', { class: 'card multi-head' }, [el('div', { class: 'card-hd' }, [el('div', {}, [el('div', { class: 'title' }, ['多级别同时开始']), el('div', { class: 'subtitle' }, ['三桌并行 · 每个级别固定 1 桌'])]), el('div', { class: 'actions' }, [el('button', { class: 'btn', onclick: () => W.setRoute({ name: 'tournament', tournamentId }) }, ['返回'])])])]);
    const gridClass = 'grid multi-grid' + (levels.length === 2 ? ' two-up' : '');
    /*
     * 先统一生成/收桌，再用同一份全局计划排桌并计算「下一组」。
     * 面板只负责渲染：顺序固定为 levelIds 顺序，结果不依赖面板渲染时机，
     * 从单级别详情页返回控制台后重新推导，仍然保持一致。
     */
    let active = false;
    for (const lv of levels) {
      lv.maxTables = Math.max(lv.maxTables, 1);
      if (!lv.tables.length) lv.tables = [{ tableNo: 1, match: null, undo: [] }];
      if (!lv.started || lv.finished) continue;
      processEvents(W.generateMatchesIfNeeded(lv), lv);
      // 多级别固定 1 桌：生成后强制收回多余桌子（比赛回到候场队列，
      // 不删除对阵）；不能放在生成前，否则 adjustTablesToAutoCount 会按
      // maxTables 再次扩桌。
      W.safelyReduceTables(lv, 1);
      active = true;
    }
    const views = active ? W.planMultiLevel(levels) : new Map();
    if (active) W.saveState(); // C4: 生成后保存
    const conflicts = W.crossLevelConflicts(levels);
    appRoot.appendChild(el('div', { class: 'grid multi-console' }, [
      header,
      renderCrossLevelConflict(conflicts),
      el('div', { class: gridClass }, levels.map((lvl) => renderMiniLevelPanel(t.id, lvl.id, views.get(lvl.id)))),
    ]));
  }

  function renderMiniLevelPanel(tournamentId, levelId, view) {
    const { level } = W.getLevel(tournamentId, levelId); if (!level) return el('div', {}, []);
    level.maxTables = Math.max(level.maxTables, 1);
    if (!level.tables.length) level.tables = [{ tableNo: 1, match: null, undo: [] }];
    const alive = W.alivePlayers(level).length;
    const stateText = level.finished ? '已结束' : level.started ? '进行中' : '未开始';
    return el('div', { class: 'card mini-level-card', 'data-level-id': level.id, 'data-level-name': level.name }, [
      el('div', { class: 'card-hd mini-level-hd' }, [
        el('div', { class: 'mini-level-heading' }, [
          el('div', { class: 'row between mini-level-top' }, [
            el('div', { class: 'title mini-level-name' }, [level.name]),
            el('span', { class: 'badge ' + (level.finished ? 'ok' : level.started ? 'warn' : '') }, [stateText]),
          ]),
          el('div', { class: 'subtitle mini-level-stats' }, [`存活 ${alive} · 待赛 ${level.pendingMatches.length} · 已完成 ${level.history.length}`]),
        ]),
        el('div', { class: 'actions mini-level-tools' }, [
          el('button', { class: 'btn small', onclick: () => openPlayerListModal(level) }, ['选手']),
          el('button', { class: 'btn small', 'data-action': 'situation', onclick: () => openSituation(tournamentId, levelId) }, ['赛情']),
          el('button', { class: 'btn small', onclick: () => openRankingModal(level) }, ['名次']),
          el('button', { class: 'btn small', onclick: () => openHistoryModal(level) }, ['历史']),
          (!level.grandFinal || canRecordGrandFinal(level))
            ? el('button', { class: 'btn small', onclick: () => { if (canRecordGrandFinal(level)) showGrandFinalModal(level); else W.toast('未进入总决赛'); } }, ['决赛'])
            : null,
          level.started ? el('button', { class: 'btn small danger', 'data-action': 'reset-level', onclick: () => resetLevelFlow(level) }, ['退回赛前设置']) : null,
          el('button', { class: 'btn small primary', onclick: () => W.setRoute({ name: 'level', tournamentId, levelId }) }, ['进入']),
        ]),
      ]),
      el('div', { class: 'card-bd mini-level-bd' }, [
        renderMiniTableControl(level, 1),
        !level.started ? el('button', { class: 'btn ok block mini-start-btn', 'data-action': 'start-level', 'data-level-id': level.id, onclick: () => {
          // 多级别固定 1 桌；只约束本次开赛，level.maxTables 原值保留，
          // 切回单级别时仍按原设置恢复桌数。
          // 开赛瞬间也可能与另一个正在进行的级别撞人，因此同样带上占用表。
          const t = W.state.tournaments.find((x) => x.id === tournamentId);
          const others = (t?.levels || []).filter((x) => x.id !== level.id);
          processEvents(W.startLevel(level, { maxTables: 1, blocked: W.crossLevelBusyMap(others) }), level);
          W.saveState(); W.render();
        } }, ['开始比赛（1桌）']) : null,
        // 真实比赛桌已显示当前双方，控制台不再重复「当前对阵」，只保留下方下一组区域
        renderMiniNextUp(level, view),
      ]),
    ]);
  }

  function miniPlayerBox(level, p) {
    if (!p) return el('div', { class: 'mini-player' }, [el('div', { class: 'name' }, ['待定'])]);
    const elim = p.losses >= 2 || p.eliminatedAt;
    return el('div', { class: 'mini-player' }, [
      el('div', { class: 'name' }, [p.name]),
      el('div', { class: 'row mini-player-meta' }, [
        el('span', { class: `badge ${elim ? 'danger' : p.losses === 1 ? 'warn' : 'ok'}` }, [W.isWithdrawn(level, p) ? '退赛' : `${Math.min(2, p.losses)}/2`]),
        el('span', { class: 'badge' }, [p.bracket === 'W' ? '胜者组' : '败者组']),
      ]),
    ]);
  }

  function renderMiniTableControl(level, tableNo) {
    const table = level.tables.find((x) => x.tableNo === tableNo);
    const match = table && table.match;
    const p1 = match ? level.players[match.p1] : null;
    const p2 = match ? level.players[match.p2] : null;
    let body;
    if (match && p1 && p2) {
      const winBtn = (p) => el('button', {
        class: 'btn ok block win-btn', 'data-action': 'win',
        'data-level-id': level.id, 'data-table-no': tableNo, 'data-player-id': p.id,
        onclick: () => { processEvents(W.resolveMatch(level, tableNo, p.id), level); W.saveState(); W.render(); },
      }, [`${p.name} 获胜`]);
      body = el('div', { class: 'mini-stage-body' }, [
        el('div', { class: 'mini-players' }, [miniPlayerBox(level, p1), el('span', { class: 'mini-vs' }, ['VS']), miniPlayerBox(level, p2)]),
        el('div', { class: 'win-actions mini-win-actions' }, [winBtn(p1), winBtn(p2)]),
      ]);
    } else if (level.finished) {
      W.computePlacements(level);
      const champ = Object.values(level.players).find((p) => p.placement === 1);
      body = champ
        ? el('div', { class: 'mini-champion' }, [el('span', { class: 'mini-medal' }, ['🥇']), el('strong', {}, [champ.name])])
        : el('div', { class: 'mini-idle' }, ['比赛已结束']);
    } else {
      body = el('div', { class: 'mini-idle' }, [idleTableText(level)]);
    }
    const status = match ? `进行中 · ${bracketLabel(match.bracket)}` : level.finished ? '已结束' : '空闲';
    return el('section', { class: 'mini-stage' + (match ? ' live' : ''), 'data-table-no': tableNo }, [
      el('div', { class: 'mini-stage-hd' }, [
        el('div', { class: 'mini-stage-meta' }, [
          el('span', { class: 'table-no mini-table-no' }, [`桌子 #${tableNo}`]),
          el('span', { class: `badge ${match ? 'warn' : level.finished ? 'ok' : ''}` }, [status]),
        ]),
        el('button', { class: 'btn small', 'data-action': 'undo', 'data-level-id': level.id, 'data-table-no': tableNo, onclick: () => {
          if (!level.started) return W.toast('开始后才能撤回');
          const msg = W.undoLast(level, `table:${tableNo}`);
          if (msg) { W.toast(msg); W.saveState(); W.render(); } else W.toast('没有可撤销的记录');
        } }, ['撤回']),
      ]),
      body,
    ]);
  }

  /* ==================== 赛情位置图 ==================== */
  function renderSituation(tournamentId, levelId) {
    const { tournament, level } = W.getLevel(tournamentId, levelId);
    if (!tournament || !level) return W.setRoute({ name: 'home' });
    const route = W.state.ui.route || {};
    const layout = W.buildSituationLayout(level);
    const page = el('div', {
      class: 'sx-page' + (layout.supported && layout.n >= 16 ? ' is-compact' : ''),
      'data-situation-level-id': level.id,
    }, []);
    page.appendChild(renderSxBar(tournamentId, level, layout, route));
    if (!layout.supported) {
      page.appendChild(el('div', { class: 'sx-unsupported' }, [
        el('div', { class: 'sx-unsupported-mark' }, ['!']),
        el('strong', {}, [layout.message]),
        el('div', { class: 'sx-unsupported-note' }, [
          `当前 ${layout.n} 人。请把本级别调整到 3～20 名选手后重新打开赛情。`,
        ]),
      ]));
      appRoot.appendChild(page);
      return;
    }
    page.appendChild(renderSxCurrent(level, layout));
    const viewport = el('div', { class: 'sx-viewport', 'data-sx-viewport': '1' }, []);
    const wrap = el('div', { class: 'sx-canvas-wrap' }, [renderSxCanvas(level, layout)]);
    viewport.appendChild(wrap);
    page.appendChild(viewport);
    appRoot.appendChild(page);
    setupSxZoom(page, layout);
  }

  function renderSxBar(tournamentId, level, layout, route) {
    const statusText = level.finished ? '已结束' : level.started ? '进行中' : '未开始';
    const statusClass = level.finished ? 'is-done' : level.started ? 'is-live' : 'is-idle';
    const from = route.from && route.from.name && route.from.name !== 'situation'
      ? route.from
      : { name: 'level', tournamentId, levelId: level.id };
    const sub = layout.supported
      ? `${layout.n} 人模板 · 胜者组 ${layout.template.wStages.length} 轮 · 败者组 ${layout.template.lStages.length} 阶段`
        + (layout.template.templateRounds ? ` · Excel ${layout.template.templateRounds} 轮` : '')
      : `当前 ${layout.n} 人 · 仅支持 3～20 人`;
    return el('div', { class: 'sx-bar' }, [
      el('div', { class: 'sx-bar-main' }, [
        el('button', {
          class: 'sx-back', 'data-sx-back': '1', title: '返回刚才的比赛页面',
          onclick: () => W.setRoute(from),
        }, ['← 返回']),
        el('div', { class: 'sx-bar-titles' }, [
          el('div', { class: 'sx-title', title: level.name }, [level.name]),
          el('div', { class: 'sx-sub' }, [sub]),
        ]),
        el('span', { class: `sx-status ${statusClass}` }, [statusText]),
      ]),
      layout.supported ? el('div', { class: 'sx-tools' }, [
        el('button', { type: 'button', class: 'sx-tool sx-zoom-btn', 'data-sx-zoom': 'out', title: '缩小' }, ['−']),
        el('span', { class: 'sx-zoom-label', 'data-sx-zoom-label': '1' }, ['100%']),
        el('button', { type: 'button', class: 'sx-tool sx-zoom-btn', 'data-sx-zoom': 'in', title: '放大' }, ['+']),
        el('button', { type: 'button', class: 'sx-tool', 'data-sx-zoom': 'reset' }, ['100%']),
        el('button', { type: 'button', class: 'sx-tool sx-fit-btn', 'data-sx-zoom': 'fit' }, ['适应屏幕']),
      ]) : null,
    ]);
  }

  function renderSxCurrent(level, layout) {
    const c = layout.current;
    if (!c) {
      return el('div', { class: 'sx-current is-idle', 'aria-live': 'polite' }, [
        el('div', { class: 'sx-current-meta' }, [
          el('span', { class: 'sx-current-kicker' }, ['当前比赛']),
          el('strong', {}, [level.finished ? '比赛已结束' : level.started ? '等待下一场对阵' : '比赛尚未开始']),
        ]),
        el('div', { class: 'sx-current-idle' }, [
          level.finished ? '最终排名已生成。' : level.started ? '当前没有进行中的比赛。' : '开始比赛后，这里显示正在对阵的两名选手。',
        ]),
      ]);
    }
    const player = (p, side) => el('div', {
      class: 'sx-current-player' + (side === 1 ? ' p1' : ' p2'),
      'data-player-id': p.id,
    }, [
      el('div', { class: 'sx-current-player-top' }, [
        el('span', { class: 'sx-current-no' }, [p.no ? `#${p.no}` : '#—']),
        el('span', { class: 'sx-current-pos' }, [p.positionLabel || '']),
      ]),
      el('div', { class: 'sx-current-name', title: p.name }, [p.name]),
      el('div', { class: 'sx-current-sub' }, [`${p.losses} 负`]),
    ]);
    return el('div', {
      class: 'sx-current',
      'data-current-source': c.source,
      'data-table-no': c.tableNo || '',
      'aria-live': 'polite',
    }, [
      el('div', { class: 'sx-current-meta' }, [
        el('span', { class: 'sx-current-kicker' }, ['当前比赛']),
        el('strong', {}, [c.source === 'grandFinal' ? '总决赛 · BO3' : `桌子 #${c.tableNo} · ${c.label}`]),
        c.extraLive ? el('span', { class: 'sx-live-extra' }, [`另有 ${c.extraLive} 场进行中`]) : null,
      ]),
      el('div', { class: 'sx-current-duel' }, [
        player(c.p1, 1),
        el('div', { class: 'sx-current-vs' }, ['VS']),
        player(c.p2, 2),
      ]),
      c.source === 'grandFinal'
        ? el('div', { class: 'sx-current-score' }, [`比分 ${c.wins1} : ${c.wins2}`])
        : null,
    ]);
  }

  function renderSxCanvas(level, layout) {
    const canvas = el('div', {
      class: 'sx-canvas',
      style: `width:${layout.width}px;height:${layout.height}px;`,
    }, []);
    const laneLeft = layout.colX(1) - 14;
    const laneWidth = layout.gf.x - 12 - laneLeft;
    canvas.appendChild(el('div', {
      class: 'sx-lane sx-lane-w',
      style: `left:${laneLeft}px;top:${layout.wLaneTop}px;width:${laneWidth}px;height:${layout.wLaneH}px;`,
    }, []));
    canvas.appendChild(el('div', {
      class: 'sx-lane sx-lane-l',
      style: `left:${laneLeft}px;top:${layout.lLaneTop}px;width:${laneWidth}px;height:${layout.lLaneH}px;`,
    }, []));
    canvas.appendChild(renderSxEdges(layout));
    for (const stageNodes of layout.wNodes) {
      for (const node of stageNodes) canvas.appendChild(renderSxNode(node));
    }
    for (const stageNodes of layout.lNodes) {
      for (const node of stageNodes) canvas.appendChild(renderSxNode(node));
    }
    for (const h of layout.headers) canvas.appendChild(renderSxHeader(h));
    canvas.appendChild(el('div', {
      class: 'sx-side-head',
      style: `left:${layout.entryX}px;top:10px;width:${layout.entryW}px;`,
    }, ['选手 · 编号 · 状态']));
    canvas.appendChild(renderSxRoster(layout));
    canvas.appendChild(renderSxGrandFinal(layout));
    return canvas;
  }

  function renderSxHeader(h) {
    return el('div', {
      class: `sx-col-head ${h.lane === 'W' ? 'is-w' : 'is-l'}`,
      style: `left:${h.x}px;top:${h.y}px;width:${h.w}px;`,
    }, [
      el('span', { class: 'sx-col-title' }, [h.label]),
      h.byes.length ? el('span', { class: 'sx-col-byes' }, h.byes.map((b) => el('span', {
        class: 'sx-bye-chip',
        title: `${b.name} 轮空晋级`,
      }, [`轮空 ${b.no ? `#${b.no}` : ''}${b.name}`]))) : null,
    ]);
  }

  function renderSxNode(node) {
    const empty = !node.p1 && !node.p2;
    const cls = 'sx-match'
      + (node.lane === 'W' ? ' is-w' : ' is-l')
      + (node.current ? ' is-current' : '')
      + (empty ? ' is-empty' : '')
      + (node.status === 'done' ? ' is-done' : '');
    return el('div', {
      class: cls,
      'data-lane': node.lane,
      'data-stage': node.stage,
      'data-match-id': node.matchId || '',
      style: `left:${node.x}px;top:${node.y}px;width:${node.w}px;height:${node.h}px;`,
    }, empty
      ? [el('div', { class: 'sx-match-empty', 'aria-label': '待定', title: '待定' }, [])]
      : [renderSxSeat(node.p1, node.seatH), renderSxSeat(node.p2, node.seatH)]);
  }

  function sxNameClass(base, name) {
    const len = Array.from(String(name || '')).length;
    return base
      + (len >= 13 ? ' is-xxlong' : len >= 9 ? ' is-xlong' : len >= 6 ? ' is-long' : '');
  }

  function sxSeatClass(seat) {
    if (!seat) return 'sx-seat is-empty';
    return 'sx-seat'
      + (seat.current ? ' is-current' : '')
      + (seat.eliminatedHere ? ' is-out' : '')
      + (seat.result === 'win' ? ' is-win' : '')
      + (seat.result === 'loss' ? ' is-loss' : '')
      + (seat.result === 'live' ? ' is-live' : '');
  }

  function sxSeatMeta(seat) {
    if (!seat) return '';
    if (seat.current) return '当前';
    // 总决赛结束后直接显示实际名次（冠军/亚军），不按普通淘汰处理。
    if (seat.bracket === 'GF' && seat.placementShort
      && (seat.result === 'win' || seat.result === 'loss')) {
      return seat.placementShort;
    }
    if (seat.result === 'win') return '胜';
    if (seat.result === 'loss') return seat.eliminatedHere ? '淘汰' : '负';
    if (seat.result === 'live') return '进行';
    if (seat.result === 'waiting') return `${seat.losses}负`;
    return `${seat.losses}负`;
  }

  function renderSxSeat(seat, height) {
    if (!seat) {
      return el('div', { class: 'sx-seat is-empty', style: `height:${height}px;` }, [
        el('span', { class: 'sx-seat-name' }, ['待定']),
      ]);
    }
    const title = [
      `#${seat.no || '—'} ${seat.name}`,
      `${seat.losses} 负`,
      seat.placementLabel ? seat.placementLabel : '',
      seat.eliminatedHere ? '已淘汰' : '',
    ].filter(Boolean).join(' · ');
    return el('div', {
      class: sxSeatClass(seat),
      'data-player-id': seat.id,
      'data-no': seat.no || '',
      style: `height:${height}px;`,
    }, [
      el('span', { class: 'sx-seat-no' }, [seat.no ? `#${seat.no}` : '#—']),
      el('span', { class: sxNameClass('sx-seat-name', seat.name), title }, [seat.name]),
      el('span', { class: 'sx-seat-meta' }, [sxSeatMeta(seat)]),
    ]);
  }

  function renderSxEdges(layout) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'sx-edges');
    svg.setAttribute('width', String(layout.width));
    svg.setAttribute('height', String(layout.height));
    svg.setAttribute('viewBox', `0 0 ${layout.width} ${layout.height}`);
    const defs = document.createElementNS(NS, 'defs');
    const marker = (id, color) => {
      const m = document.createElementNS(NS, 'marker');
      m.setAttribute('id', id);
      m.setAttribute('viewBox', '0 0 8 8');
      m.setAttribute('refX', '7');
      m.setAttribute('refY', '4');
      m.setAttribute('markerWidth', '7');
      m.setAttribute('markerHeight', '7');
      m.setAttribute('orient', 'auto');
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', 'M0,0 L8,4 L0,8 z');
      p.setAttribute('fill', color);
      m.appendChild(p);
      return m;
    };
    defs.appendChild(marker('sx-arrow', '#475569'));
    defs.appendChild(marker('sx-arrow-drop', '#b45309'));
    svg.appendChild(defs);
    for (const edge of layout.edges) {
      const path = document.createElementNS(NS, 'path');
      path.setAttribute('d', edge.d);
      path.setAttribute('class', `sx-edge is-${edge.kind}`);
      path.setAttribute('marker-end', edge.kind === 'drop' ? 'url(#sx-arrow-drop)' : 'url(#sx-arrow)');
      svg.appendChild(path);
    }
    return svg;
  }

  function renderSxRoster(layout) {
    const roster = el('div', {
      class: 'sx-roster',
      style: `left:${layout.entryX}px;top:${layout.rosterTop}px;width:${layout.entryW}px;height:${layout.rosterH}px;`,
    }, []);
    for (const entry of layout.entries) {
      roster.appendChild(el('div', {
        class: 'sx-entry'
          + (entry.current ? ' is-current' : '')
          + (entry.eliminated ? ' is-out' : ''),
        'data-player-id': entry.id,
        style: `top:${entry.y - layout.rosterTop}px;height:${entry.h}px;`,
      }, [
        el('span', { class: 'sx-entry-no' }, [entry.no ? `#${entry.no}` : '—']),
        el('div', { class: 'sx-entry-body' }, [
          el('span', { class: sxNameClass('sx-entry-name', entry.name), title: entry.name }, [entry.name]),
          el('span', { class: 'sx-entry-state' }, [entry.statusLabel]),
        ]),
        el('span', { class: 'sx-entry-loss' }, [`${entry.losses}负`]),
      ]));
    }
    return roster;
  }

  function renderSxGrandFinal(layout) {
    const gf = layout.gf;
    const cls = 'sx-gf'
      + (gf.current ? ' is-current' : '')
      + (gf.completed ? ' is-done' : '')
      + (gf.status === 'empty' ? ' is-empty' : '');
    return el('div', {
      class: cls,
      style: `left:${gf.x}px;top:${gf.y}px;width:${gf.w}px;height:${gf.h}px;`,
    }, [
      el('div', { class: 'sx-gf-hd' }, [
        el('span', { class: 'sx-gf-title' }, [gf.label]),
        gf.status === 'empty' ? null : el('span', { class: 'sx-gf-score' }, [`${gf.wins1} : ${gf.wins2}`]),
      ]),
      gf.status === 'empty'
        ? el('div', { class: 'sx-gf-empty' }, ['待产生'])
        : el('div', { class: 'sx-gf-seats' }, [
          renderSxSeat(gf.p1, layout.seatH),
          renderSxSeat(gf.p2, layout.seatH),
        ]),
    ]);
  }

  function setupSxZoom(page, layout) {
    const viewport = page.querySelector('[data-sx-viewport]');
    if (!viewport) return;
    const wrap = viewport.querySelector('.sx-canvas-wrap');
    const canvas = viewport.querySelector('.sx-canvas');
    const label = page.querySelector('[data-sx-zoom-label]');
    if (!wrap || !canvas) return;
    const clamp = (v) => Math.max(layout.minScale, Math.min(layout.maxScale, v));
    let scale = 1;
    const apply = () => {
      const visualH = layout.height * scale;
      const extra = Math.max(0, (viewport.clientHeight - visualH) / 2 - 10);
      canvas.style.transform = `scale(${scale})`;
      canvas.style.marginTop = `${extra}px`;
      wrap.style.width = `${layout.width * scale}px`;
      wrap.style.height = `${visualH + extra * 2}px`;
      if (label) label.textContent = `${Math.round(scale * 100)}%`;
      viewport.setAttribute('data-sx-scale', scale.toFixed(2));
    };
    const fit = () => {
      const vw = Math.max(1, viewport.clientWidth - 20);
      const vh = Math.max(1, viewport.clientHeight - 20);
      const raw = Math.min(vw / layout.width, vh / layout.height);
      // 20 人时允许横向滚动，但不把姓名缩到不可读。
      scale = clamp(Math.max(layout.fitFloor, raw));
      apply();
    };
    for (const btn of page.querySelectorAll('[data-sx-zoom]')) {
      btn.addEventListener('click', () => {
        const action = btn.getAttribute('data-sx-zoom');
        if (action === 'in') scale = clamp(scale + 0.1);
        else if (action === 'out') scale = clamp(scale - 0.1);
        else if (action === 'reset') scale = 1;
        else if (action === 'fit') { fit(); return; }
        apply();
      });
    }
    fit();
    // 等浏览器完成首次布局后再校正一次，避免首屏宽度为 0。
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(fit);
  }

  function renderSituationHeader(tournamentId, level, model) {
    const t = model.template;
    const status = level.finished ? '已结束' : level.started ? '进行中' : '未开始';
    const subtitle = t.supported
      ? `模板：${t.n}人双败淘汰赛表格 · Excel ${t.templateRounds} 轮 · 位置按实际比赛阶段展开`
      : `当前 ${t.n} 人 · 本阶段仅支持 3–20 人模板`;
    return el('section', { class: 'card sit-hero' }, [
      el('div', { class: 'card-hd sit-hero-hd' }, [
        el('div', {}, [
          el('div', { class: 'eyebrow' }, ['WACAA · 赛情']),
          el('div', { class: 'title sit-hero-title' }, [`${level.name} · 赛情`]),
          el('div', { class: 'subtitle' }, [subtitle]),
        ]),
        el('div', { class: 'row sit-hero-tools' }, [
          el('span', { class: `badge ${level.finished ? 'ok' : level.started ? 'warn' : ''}` }, [status]),
          el('button', { class: 'btn small', onclick: () => W.setRoute({ name: 'level', tournamentId, levelId: level.id }) }, ['返回级别']),
        ]),
      ]),
      el('div', { class: 'card-bd sit-hero-bd' }, [
        el('div', { class: 'sit-hero-stats' }, [
          kpi('编号', level.started ? `1–${model.n}` : '开始后固定'),
          kpi('胜者组', `${model.wStages.length} 轮`),
          kpi('败者组', `${model.lStages.length} 阶段`),
          kpi('已完成', `${level.history.length} 场`),
        ]),
        el('div', { class: 'hint' }, [level.started
          ? '编号在开始比赛时固定；刷新、打开赛情、撤销比赛都不会重新抽签。'
          : '开始比赛后按当前抽签顺序分配 1–N 编号，并固定到本场赛事结束。']),
      ]),
    ]);
  }

  function renderSituationCurrent(model) {
    const c = model.current;
    const player = (p) => el('div', { class: 'sit-current-player', 'data-player-id': p.id }, [
      el('div', { class: 'sit-current-top' }, [
        el('span', { class: 'sit-no' }, [p.no ? `#${p.no}` : '#—']),
        el('span', { class: `badge ${p.losses === 1 ? 'warn' : 'ok'}` }, [`${p.losses}/2`]),
      ]),
      el('div', { class: 'sit-current-name', title: p.name }, [p.name]),
      el('div', { class: 'sit-current-pos' }, [p.positionLabel]),
    ]);
    return el('section', {
      class: 'card sit-current',
      'data-current-source': c.source,
      'data-table-no': c.tableNo || '',
      'aria-live': 'polite',
    }, [
      el('div', { class: 'sit-current-hd' }, [
        el('div', {}, [
          el('div', { class: 'sit-current-kicker' }, ['当前比赛']),
          el('div', { class: 'title sit-current-title' }, [c.source === 'grandFinal' ? '总决赛' : `桌子 #${c.tableNo} · ${c.label}`]),
          c.source !== 'grandFinal' ? el('div', { class: 'subtitle' }, [c.label]) : null,
        ]),
        c.extraLive ? el('span', { class: 'badge warn' }, [`另有 ${c.extraLive} 场进行中`]) : null,
      ]),
      el('div', { class: 'sit-current-duel' }, [player(c.p1), el('div', { class: 'sit-vs' }, ['VS']), player(c.p2)]),
      c.source === 'grandFinal' ? el('div', { class: 'sit-current-score' }, [`BO3 比分 ${c.wins1} : ${c.wins2}`]) : null,
      el('div', { class: 'hint sit-current-note' }, ['本框只提示裁判当前正在对阵的两名选手，不改变胜者组/败者组位置。']),
    ]);
  }

  function situationEntryStatus(row) {
    return 'is-' + (row.status || 'winner');
  }

  function renderSituationEntry(model) {
    return el('section', { class: 'sit-entry-panel', style: 'grid-column:1;grid-row:1 / span 2;' }, [
      el('div', { class: 'sit-panel-hd' }, [
        el('span', { class: 'title' }, ['选手编号']),
        el('span', { class: 'badge' }, [`${model.n} 人`]),
      ]),
      el('div', { class: 'sit-entry-list' }, model.draw.map((row) => el('div', {
        class: 'sit-entry-row ' + situationEntryStatus(row),
        'data-player-id': row.playerId,
      }, [
        el('span', { class: 'sit-no' }, [row.no ? `#${row.no}` : '—']),
        el('span', { class: 'sit-entry-name', title: row.name }, [row.name]),
        el('span', { class: 'sit-entry-state' }, [row.status === 'current' ? '当前' : row.status === 'eliminated' ? '淘汰' : row.label]),
      ]))),
    ]);
  }

  function renderSituationCard(card) {
    const cls = 'sit-card'
      + (card.current ? ' is-current' : '')
      + (card.bye ? ' has-bye' : '');
    return el('div', { class: cls, 'data-player-id': card.id, 'data-no': card.no || '' }, [
      el('div', { class: 'sit-card-top' }, [
        el('span', { class: 'sit-no' }, [card.no ? `#${card.no}` : '#—']),
        el('span', { class: `badge ${card.losses === 1 ? 'warn' : 'ok'}` }, [`${card.losses}/2`]),
      ]),
      el('div', { class: 'sit-card-name', title: card.name }, [card.name]),
      card.current ? el('div', { class: 'sit-card-flag current' }, ['当前比赛']) : null,
      card.bye ? el('div', { class: 'sit-card-flag bye' }, ['轮空晋级']) : null,
      card.result && !card.current && !(card.bye && card.result === 'waiting')
        ? el('div', { class: `sit-card-flag ${card.result}` }, [situationResultLabel(card.result)])
        : null,
      card.eliminatedHere
        ? el('div', { class: 'sit-card-flag out' }, ['已淘汰'])
        : null,
    ]);
  }

  function situationResultLabel(result) {
    if (result === 'win') return '本轮胜';
    if (result === 'loss') return '本轮负';
    if (result === 'live') return '进行中';
    if (result === 'waiting') return '待赛';
    return '';
  }

  function renderSituationStage(lane, stage, model) {
    const isW = lane === 'W';
    const laneLabel = isW ? '胜者组' : '败者组';
    const stageLabel = isW ? `第${stage.stage}轮` : `第${stage.stage}阶段`;
    const byes = model.byes.filter((b) => b.bracket === lane
      && (isW ? b.round === stage.stage : b.stage === stage.stage));
    const slots = stage.slots.map((card) => (card
      ? renderSituationCard(card)
      : el('div', { class: 'sit-slot pending' }, ['待定'])));
    const byeEl = stage.byes
      ? el('div', { class: 'sit-bye-slot' }, byes.length
        ? byes.map((b) => el('div', { class: 'sit-bye-card' }, [
          el('span', { class: 'sit-bye-name' }, [`轮空：${b.name}`]),
          el('span', { class: 'sit-bye-advance' }, [b.advanceLabel]),
        ]))
        : [el('div', { class: 'sit-bye-empty' }, ['轮空位 · 待产生'])])
      : null;
    return el('section', {
      class: `sit-stage ${isW ? 'sit-stage-w' : 'sit-stage-l'}`,
      'data-lane': lane,
      'data-stage': stage.stage,
    }, [
      el('div', { class: 'sit-stage-hd' }, [
        el('span', { class: `sit-lane-tag ${isW ? 'win' : 'lose'}` }, [laneLabel]),
        el('span', { class: 'sit-stage-title' }, [stageLabel]),
        el('span', { class: 'sit-stage-cap' }, [`${stage.capacity} 个位置`]),
      ]),
      el('div', { class: 'sit-slots' }, slots),
      byeEl,
    ]);
  }

  function renderEmptySituationStage(index, isLoser) {
    return el('section', { class: 'sit-stage sit-stage-empty' }, [
      el('div', { class: 'sit-stage-hd' }, [
        el('span', { class: `sit-lane-tag ${isLoser ? 'lose' : 'win'}` }, [isLoser ? '败者组' : '胜者组']),
        el('span', { class: 'sit-stage-title' }, [`阶段 ${index}`]),
      ]),
      el('div', { class: 'sit-empty' }, ['—']),
    ]);
  }

  function renderSituationFinals(model) {
    const gf = model.grandFinal;
    const gfEl = gf
      ? el('div', { class: `sit-gf ${gf.completed ? 'done' : ''}` }, [
        el('div', { class: 'sit-gf-hd' }, [
          el('span', { class: 'sit-lane-tag finals' }, ['总决赛']),
          el('span', { class: `badge ${gf.completed ? 'ok' : 'warn'}` }, [gf.completed ? '已结束' : '进行中']),
        ]),
        el('div', { class: 'sit-gf-names' }, [
          el('div', {}, [el('span', { class: 'sit-no' }, [gf.no1 ? `#${gf.no1}` : '#—']), gf.name1]),
          el('span', { class: 'sit-vs' }, ['VS']),
          el('div', {}, [el('span', { class: 'sit-no' }, [gf.no2 ? `#${gf.no2}` : '#—']), gf.name2]),
        ]),
        el('div', { class: 'sit-gf-score' }, [`BO3 ${gf.wins1} : ${gf.wins2}`]),
        gf.completed ? el('div', { class: 'sit-gf-result' }, [
          `冠军：${model.rankings.find((r) => r.place === 1)?.name || '未决出'}`,
        ]) : null,
      ])
      : el('div', { class: 'sit-gf empty' }, [
        el('div', { class: 'sit-gf-hd' }, [el('span', { class: 'sit-lane-tag finals' }, ['总决赛'])]),
        el('div', { class: 'sit-empty' }, ['待产生']),
      ]);

    const ranks = el('div', { class: 'sit-rank' }, [
      el('div', { class: 'sit-rank-hd' }, [
        el('span', { class: 'title' }, ['最终排名']),
        el('span', { class: 'badge' }, [`${model.rankings.length} 个名次`]),
      ]),
      el('div', { class: 'sit-rank-list' }, model.rankings.map((r) => el('div', {
        class: `sit-rank-row ${r.status === 'decided' ? 'decided' : 'pending'}`,
        'data-place': r.place,
      }, [
        el('span', { class: 'sit-rank-place' }, [r.label]),
        el('span', { class: 'sit-rank-name' }, [r.status === 'decided' ? r.name : '未决出']),
      ]))),
    ]);

    return el('div', {
      class: 'sit-finals-panel',
      style: `grid-column:${model.template.stageColumns + 2};grid-row:1 / span 2;`,
    }, [gfEl, ranks]);
  }

  function renderSituationBoard(model) {
    const stageCount = model.template.stageColumns;
    const gridStyle = `--sit-stages:${stageCount};`;
    const grid = el('div', { class: 'sit-board-grid', style: gridStyle }, []);
    grid.appendChild(renderSituationEntry(model));
    for (let i = 0; i < stageCount; i += 1) {
      const w = model.wStages[i];
      const l = model.lStages[i];
      const wEl = w ? renderSituationStage('W', w, model) : renderEmptySituationStage(i + 1, false);
      const lEl = l ? renderSituationStage('L', l, model) : renderEmptySituationStage(i + 1, true);
      // 胜者组放上半行、败者组放下半行，避免长胜者组把本阶段败者组推到页面底部。
      wEl.style.gridColumn = String(i + 2);
      wEl.style.gridRow = '1';
      lEl.style.gridColumn = String(i + 2);
      lEl.style.gridRow = '2';
      grid.appendChild(wEl);
      grid.appendChild(lEl);
    }
    grid.appendChild(renderSituationFinals(model));
    return el('section', { class: 'card sit-board-card' }, [
      el('div', { class: 'card-hd' }, [
        el('div', {}, [
          el('div', { class: 'title' }, ['位置图']),
          el('div', { class: 'subtitle' }, ['编号位置、胜者组、败者组、各阶段位置、轮空晋级位与最终排名；未产生的未来位置显示「待定」。']),
        ]),
      ]),
      el('div', { class: 'sit-board-scroll' }, [grid]),
    ]);
  }

  function renderSituationEliminated(model) {
    return el('section', { class: 'card sit-elim-card' }, [
      el('div', { class: 'card-hd' }, [
        el('div', {}, [
          el('div', { class: 'title' }, ['淘汰位置']),
          el('div', { class: 'subtitle' }, ['累计两负的选手离开胜/败者组位置，名次沿用既有排名结果。']),
        ]),
        el('span', { class: 'badge' }, [`${model.eliminated.length} 人`]),
      ]),
      el('div', { class: 'card-bd' }, [el('div', { class: 'sit-elim-list' }, model.eliminated.map((row) => el('div', { class: 'sit-elim-row' }, [
        el('span', { class: 'sit-no' }, [row.no ? `#${row.no}` : '—']),
        el('span', { class: 'sit-elim-row-name' }, [row.name]),
        el('span', { class: 'badge' }, [row.label]),
        el('span', { class: 'hint' }, [`${row.losses}/2 负`]),
      ])))]),
    ]);
  }

  function renderSituationByes(model) {
    return el('section', { class: 'card sit-byes-card' }, [
      el('div', { class: 'card-hd' }, [
        el('div', {}, [
          el('div', { class: 'title' }, ['轮空晋级记录']),
          el('div', { class: 'subtitle' }, ['轮空不生成比赛、不增加负场；以下记录来自实际调度。']),
        ]),
      ]),
      el('div', { class: 'card-bd' }, [el('div', { class: 'sit-bye-list' }, model.byes.map((b) => el('div', { class: 'sit-bye-row' }, [
        el('span', { class: 'sit-no' }, [b.no ? `#${b.no}` : '—']),
        el('span', { class: 'sit-bye-row-name' }, [b.name]),
        el('span', { class: 'badge' }, [b.label]),
        el('span', { class: 'hint' }, [b.advanceLabel]),
      ])))]),
    ]);
  }

  /* ==================== 级别页面 ==================== */
  function renderLevel(tournamentId, levelId) {
    const { tournament, level } = W.getLevel(tournamentId, levelId);
    if (!tournament || !level) return W.setRoute({ name: 'home' });
    /*
     * 同一赛事里还有别的级别正在进行时，单级别详情页也必须带上跨级别占用表，
     * 不能因为换了一条渲染路径就绕过限制。
     * 真正独立的单级别赛事没有其他进行中的级别，占用表为空，行为与原来一致；
     * 不同赛事的级别永远不会被传进来。
     */
    const blocked = W.crossLevelBusyMap(
      (tournament.levels || []).filter((l) => l.id !== level.id),
    );
    if (level.started && !level.finished) {
      processEvents(W.generateMatchesIfNeeded(level), level);
      W.fillTables(level, blocked);
      W.finalizeIfDone(level);
      // C4: 生成对阵后保存
      W.saveState();
    }
    const wrap = el('div', { class: 'grid' }, []);
    wrap.appendChild(renderLevelHeader(tournamentId, tournament, level, blocked));
    const conflict = renderCrossLevelConflict(W.crossLevelConflicts(tournament.levels), level.id);
    if (conflict) wrap.appendChild(conflict);
    wrap.appendChild(renderLevelBody(tournamentId, tournament, level, blocked));
    // 比赛区按内容高度展开；页面剩余空白留在文档末尾，不再强行拉高选手卡。
    wrap.classList.add('level-page');
    appRoot.appendChild(wrap);
  }

  function renderLevelHeader(tournamentId, tournament, level, blocked) {
    const alive = W.alivePlayers(level).length, total = Object.keys(level.players).length;
    const done = level.history.length, pending = level.pendingMatches.length + level.tables.filter((t) => t.match).length;
    const pct = Math.round((done / Math.max(1, done + pending)) * 100);
    return el('div', { class: 'card level-hero level-hero-compact' }, [el('div', { class: 'card-bd level-hero-bd' }, [
      el('div', { class: 'level-hero-main' }, [
        el('button', { class: 'btn small ghost level-back-btn', title: '返回赛事', onclick: () => W.setRoute({ name: 'tournament', tournamentId }) }, ['← 返回']),
        el('div', { class: 'level-title-row' }, [
          el('div', { class: 'title level-title' }, [level.name]),
          el('button', { class: 'btn small ghost', title: '改名', 'data-action': 'rename-level', onclick: () => { const n = prompt('修改名称', level.name); if (n !== null) { level.name = (n || '').trim() || level.name; W.saveState(); W.render(); } } }, ['✎']),
          el('span', { class: `badge ${level.finished ? 'ok' : level.started ? 'warn' : ''}` }, [level.finished ? '已结束' : level.started ? '进行中' : '未开始']),
          el('button', {
            class: 'btn small level-table-limit', 'data-action': 'table-limit', title: '桌数上限（只改桌数，不改名称）',
            onclick: () => openTableLimitFlow(level),
          }, [`桌数 ${level.maxTables}`]),
        ]),
        el('div', { class: 'level-hero-stats' }, [
          el('span', { class: 'level-stat' }, [`选手 ${total}`]),
          el('span', { class: 'level-stat' }, [`存活 ${alive}`]),
          el('span', { class: 'level-stat' }, [`完成 ${done}`]),
          el('span', { class: 'level-progress-inline', title: `进度 ${pct}%` }, [el('span', { style: `width:${pct}%` }, [])]),
          el('span', { class: 'level-pct' }, [`${pct}%`]),
        ]),
      ]),
      el('div', { class: 'level-toolbar', role: 'toolbar', 'aria-label': '级别操作' }, [
        el('div', { class: 'level-toolbar-group' }, [
          !level.started
            ? el('button', { class: 'btn primary', 'data-action': 'start-level', onclick: () => { processEvents(W.startLevel(level, { blocked }), level); W.saveState(); W.render(); } }, ['开始比赛'])
            : null,
          el('button', { class: 'btn', onclick: () => openPlayerListModal(level) }, ['选手列表']),
          el('button', { class: 'btn', 'data-action': 'situation', onclick: () => openSituation(tournamentId, level.id) }, ['赛情']),
          el('button', { class: 'btn', onclick: () => openRankingModal(level) }, ['实时名次']),
          el('button', { class: 'btn', onclick: () => { if (!level.started) { W.toast('尚未开始'); return; } const msg = W.undoLast(level, 'global'); if (msg) { W.toast(msg); W.saveState(); W.render(); } else W.toast('没有可撤销的记录'); } }, ['全局撤回']),
          el('button', { class: 'btn', onclick: () => openHistoryModal(level) }, ['比赛历史']),
          (!level.grandFinal || canRecordGrandFinal(level))
            ? el('button', { class: 'btn', onclick: () => { if (canRecordGrandFinal(level)) showGrandFinalModal(level); else W.toast('未进入总决赛'); } }, ['总决赛面板'])
            : null,
        ]),
        el('div', { class: 'level-toolbar-danger-zone', 'aria-label': '危险操作' }, [
          level.started ? el('button', { class: 'btn toolbar-danger', 'data-action': 'reset-level', onclick: () => resetLevelFlow(level) }, ['退回赛前设置']) : null,
          el('button', { class: 'btn toolbar-danger', onclick: () => { if (!confirm('确定清空本级别所有数据？')) return; const keep = { id: level.id, name: level.name, maxTables: level.maxTables, autoShuffle: level.autoShuffle, createdAt: level.createdAt }; const fresh = W.createLevel({ name: keep.name, maxTables: keep.maxTables, autoShuffle: keep.autoShuffle }); Object.assign(level, fresh, keep); W.saveState(); W.render(); } }, ['清空本级别']),
        ]),
      ]),
    ])]);
  }

  function renderLevelBody(tournamentId, tournament, level, blocked) {
    // 已开始：比赛桌优先占据首屏；未开始：先录入选手。
    const tableCount = Math.min(3, Math.max(1, level.tables.length));
    const cls = 'level-layout ' + (level.started ? 'is-started' : 'is-waiting')
      + (level.tables.length >= 3 ? ' three-tables' : '')
      + ` tables-${tableCount}`;
    const parts = level.started ? [renderArena(level, blocked), renderPlayerSidebar(level)] : [renderPlayerSidebar(level), renderArena(level, blocked)];
    return el('div', { class: cls }, parts);
  }

  /* 只改桌数，不经过改名流程；已开始级别会先确认再安全调整 */
  function openTableLimitFlow(level) {
    // 多级别控制台固定每级别 1 桌，不提供桌数设置入口。
    if (W.state.ui?.route?.name === 'multilevel') {
      W.toast('多级别模式每个级别固定 1 桌，请回到单级别页面调整桌数');
      return;
    }
    let selected = clampInt(level.maxTables, 1, 3);
    const body = document.createElement('div');
    body.appendChild(el('div', { class: 'subtitle' }, [`「${level.name}」的桌数上限。只影响本级别，不需要修改名称。`]));
    body.appendChild(el('div', { class: 'hr' }));
    const choices = el('div', { class: 'limit-choices', role: 'group', 'aria-label': '桌数上限' });
    const buttons = [1, 2, 3].map((n) => {
      const btn = el('button', {
        type: 'button', class: 'btn limit-choice' + (n === selected ? ' primary' : ''), 'data-limit': n,
        onclick: () => {
          selected = n;
          for (const b of buttons) {
            const on = Number(b.getAttribute('data-limit')) === selected;
            b.classList.toggle('primary', on);
            b.setAttribute('aria-pressed', String(on));
          }
        },
      }, [`${n} 桌`]);
      btn.setAttribute('aria-pressed', String(n === selected));
      choices.appendChild(btn);
      return btn;
    });
    body.appendChild(choices);
    body.appendChild(el('div', { class: 'hint', style: 'margin-top:12px;' }, [
      `当前设置 ${level.maxTables} 桌` + (level.started ? `｜实际 ${level.tables.length} 桌` : '｜未开始'),
    ]));
    body.appendChild(el('div', { class: 'hint' }, ['自动桌数会按存活人数与上限取较小值；比赛开始前可随时修改。']));
    if (level.started && !level.finished) {
      body.appendChild(el('div', { class: 'hint' }, ['比赛进行中缩减桌数，会把多余桌上的对阵安全退回候场队列，不会清空已完成比赛、不会改判胜负。']));
    }

    const ft = document.createElement('div');
    ft.appendChild(el('button', { class: 'btn', onclick: closeModal }, ['取消']));
    ft.appendChild(el('button', {
      class: 'btn primary', 'data-action': 'save-table-limit', onclick: () => {
        const next = selected;
        if (next === level.maxTables) { closeModal(); return; }
        // 预演缩减后会收回多少场正在进行的比赛，先确认再执行
        let moved = 0;
        if (level.started && !level.finished) {
          const oldMax = level.maxTables;
          level.maxTables = next;
          const target = W.computeTableCount(level);
          level.maxTables = oldMax;
          moved = level.tables.slice(target).filter((t) => t.match).length;
        }
        if (moved > 0 && !confirm(`缩减到 ${next} 桌会把 ${moved} 场正在进行的对阵退回候场队列（不会判负或清空记录）。继续？`)) return;
        W.setTableLimit(level, next);
        W.saveState(); closeModal(); W.render();
        W.toast(`已设置 ${next} 桌` + (level.started ? `（当前实际 ${level.tables.length} 桌）` : ''));
      },
    }, ['保存桌数']));
    openModal({ title: '桌数上限', bodyEl: body, footerEl: ft });
  }

  function renderPlayerSidebar(level) {
    W.computePlacements(level);
    const alive = W.alivePlayers(level), eliminated = Object.values(level.players).filter((p) => p.losses >= 2 || p.eliminatedAt), total = Object.keys(level.players).length;
    const topList = Object.values(level.players).slice().filter((p) => p.name).sort((a, b) => {
      const ap = a.placement, bp = b.placement;
      if (Number.isFinite(ap) && Number.isFinite(bp)) return ap - bp;
      if (Number.isFinite(ap)) return -1; if (Number.isFinite(bp)) return 1;
      if (a.losses !== b.losses) return a.losses - b.losses;
      return a.name.localeCompare(b.name, 'zh');
    });
    const auto = level.autoShuffle !== false;

    const addBox = el('div', { class: 'card player-side-card' }, [
      el('div', { class: 'card-hd' }, [
        el('div', {}, [el('div', { class: 'title' }, ['选手管理']), el('div', { class: 'subtitle' }, ['批量添加，换行/逗号分隔。'])]),
      ]),
      el('div', { class: 'card-bd' }, [
        el('div', { class: 'field' }, [
          el('label', {}, ['批量添加选手']),
          (() => {
            const ta = el('textarea', { class: 'input', placeholder: '例如：\n张三\n李四, Wang Wu' });
            return el('div', {}, [
              ta,
              el('label', { class: 'checkline auto-shuffle-toggle', title: '整批添加完成后只打乱一次' }, [
                (() => {
                  const cb = el('input', { type: 'checkbox', 'data-action': 'auto-shuffle', 'data-level-id': level.id });
                  cb.checked = auto;
                  cb.disabled = !!level.started;
                  // 开关本身即保存，不需要再次点添加
                  cb.addEventListener('change', () => {
                    level.autoShuffle = !!cb.checked;
                    W.saveState();
                    W.toast(level.autoShuffle ? '已开启：录入后自动打乱一次' : '已关闭自动打乱，按录入顺序');
                  });
                  return cb;
                })(),
                el('span', {}, ['录入后自动打乱（整批只打乱一次）']),
              ]),
              el('div', { class: 'row', style: 'margin-top:10px;' }, [
                el('button', { class: 'btn primary', 'data-action': 'add-players', onclick: () => {
                  if (level.started) return W.toast('比赛开始后不可添加选手');
                  const r = W.addPlayers(level, ta.value);
                  if (!r.added) { W.toast(r.dupes.length ? '没有新增选手（可能全部重名）' : '请先输入选手姓名'); return; }
                  if (r.dupes.length) W.toast(`同名已加后缀：${r.dupes.join('、')}`);
                  W.toast(`已添加 ${r.added} 名选手` + (r.shuffled ? '，已自动打乱' : ''));
                  ta.value = ''; W.saveState(); W.render();
                } }, ['添加']),
                // M10: 随机抽签（手动入口保留）
                el('button', { class: 'btn', 'data-action': 'manual-shuffle', onclick: () => {
                  if (level.started) return W.toast('比赛开始后不可抽签');
                  if (!confirm('确定随机打乱选手种子顺序？上一步不可撤销。')) return;
                  if (!W.shufflePlayerOrder(level)) return W.toast('当前无法抽签');
                  W.toast('已随机抽签（种子顺序已打乱）'); W.saveState(); W.render();
                } }, ['随机抽签']),
              ]),
            ]);
          })(),
        ]),
      ]),
    ]);

    // 完整名单放进可折叠滚动区，长名单不会把页面撑高
    // 空级别把名单区展开，清空后首屏能直接看到“暂无选手”的空状态。
    const roster = el('details', { class: 'card roster-card', open: total ? undefined : '' }, [
      el('summary', { class: 'roster-summary' }, [
        el('span', { class: 'title' }, ['完整名单']),
        el('span', { class: 'badge' }, [`${total} 人`]),
      ]),
      el('div', { class: 'roster-list' }, total
        ? Array.from(level.playerOrder || [], (id, i) => {
          const p = level.players[id]; if (!p) return null;
          const isElim = p.losses >= 2 || p.eliminatedAt;
          return el('div', { class: 'roster-item', 'data-player-id': p.id }, [
            el('span', { class: 'roster-no' }, [String(i + 1)]),
            el('span', { class: 'roster-name' }, [p.name]),
            el('span', { class: `badge ${isElim ? 'danger' : p.losses === 1 ? 'warn' : 'ok'}` }, [W.isWithdrawn(level, p) ? '退赛' : isElim ? '淘汰' : `${p.losses}/2`]),
          ]);
        }).filter(Boolean)
        : [el('div', { class: 'empty-state' }, ['暂无选手，请添加选手。'])]),
    ]);

    const summary = el('div', { class: 'card player-state-card' }, [
      el('div', { class: 'card-hd' }, [el('div', {}, [el('div', { class: 'title' }, ['当前状态']), el('div', { class: 'subtitle' }, [`总人数 ${total}｜存活 ${alive.length}｜淘汰 ${eliminated.length}`])])]),
      el('div', { class: 'card-bd' }, [level.started ? el('div', { class: 'list compact-list' }, topList.slice(0, 6).map((p) => renderRankRow(level, p))) : el('div', { class: 'empty-state' }, [el('strong', {}, ['比赛未开始']), '添加选手并抽签后开始。'])]),
    ]);

    return el('div', { class: 'grid player-sidebar' }, [addBox, roster, summary]);
  }

  function renderPlayerRow(level, p) {
    const elim = p.losses >= 2 || p.eliminatedAt;
    return el('div', { class: 'list-item' }, [
      el('div', { class: 'stack' }, [el('div', { class: 'name' }, [p.name]), el('div', { class: 'py' }, [p.pinyin || ''])]),
      el('div', { class: 'row' }, [
        el('button', { class: 'btn small', onclick: () => { const n = prompt('修改姓名', p.name); if (n !== null) { p.name = (n || '').trim() || p.name; p.pinyin = W.getPinyin(p.name); W.saveState(); W.render(); } } }, ['修改']),
        // N5: 开始后允许退赛
        level.started
          ? el('button', { class: 'btn small danger', onclick: () => {
              if (elim) return W.toast('该选手已淘汰/退赛');
              if (!confirm(`确定让"${p.name}"退赛？退赛后可用顶部的「全局撤回」撤销。`)) return;
              W.withdrawPlayer(level, p.id); W.saveState(); W.render();
              W.toast(`${p.name} 已退赛，可用「全局撤回」撤销`);
            } }, ['退赛'])
          : el('button', { class: 'btn small danger', onclick: () => { if (!confirm(`删除"${p.name}"？`)) return; W.deletePlayer(level, p.id); W.saveState(); W.render(); } }, ['删除']),
        el('span', { class: `badge ${elim ? 'danger' : p.losses === 1 ? 'warn' : 'ok'}` }, [W.isWithdrawn(level, p) ? '退赛' : `${Math.min(2, p.losses)}/2`]),
      ]),
    ]);
  }

  function renderRankRow(level, p) {
    const decided = Number.isFinite(p.placement);
    const label = decided ? W.rankingLabel(p.placement) : '未决出';
    return el('div', {
      class: `list-item rank-row ${decided ? 'rank-decided rank-' + p.placement : 'rank-pending'}`,
      'data-place': decided ? p.placement : null,
      'data-status': decided ? 'decided' : 'pending',
    }, [
      el('div', { class: 'stack' }, [
        el('div', { class: 'name rank-line' }, [
          decided
            ? el('span', { class: 'rank-label' }, [label])
            : el('span', { class: 'rank-state' }, [label]),
          el('span', { class: 'rank-player' }, [p.name]),
        ]),
        el('div', { class: 'py' }, [p.pinyin || '']),
      ]),
      el('span', { class: `badge ${p.losses >= 2 || p.eliminatedAt ? 'danger' : p.losses === 1 ? 'warn' : 'ok'}` }, [W.isWithdrawn(level, p) ? '退赛' : `${Math.min(2, p.losses)}/2`]),
    ]);
  }

  /* 「实时名次」的一行：名次名称 + 已确定的选手姓名，或「未决出」。 */
  function renderRankingRow(entry) {
    const decided = entry.status === 'decided';
    const badge = decided
      ? el('span', { class: `badge ${entry.losses >= 2 ? 'danger' : entry.losses === 1 ? 'warn' : 'ok'}` }, [entry.withdrawn ? '退赛' : `${Math.min(2, entry.losses)}/2`])
      : el('span', { class: 'badge rank-pending-badge' }, ['—']);
    return el('div', {
      class: `list-item rank-row ${decided ? 'rank-decided rank-' + entry.place : 'rank-pending'}`,
      role: 'listitem',
      'data-place': entry.place,
      'data-status': entry.status,
      'aria-label': decided ? `${entry.label} ${entry.name}` : `${entry.label} 未决出`,
    }, [
      el('div', { class: 'stack' }, [
        el('div', { class: 'name rank-line' }, [
          el('span', { class: 'rank-label' }, [entry.label]),
          decided
            ? el('span', { class: 'rank-player' }, [entry.name])
            : el('span', { class: 'rank-state' }, ['未决出']),
        ]),
        decided && entry.pinyin ? el('div', { class: 'py' }, [entry.pinyin]) : null,
      ]),
      badge,
    ]);
  }

  function openPlayerListModal(level) {
    const body = document.createElement('div');
    body.appendChild(el('div', { class: 'subtitle' }, [`存活 ${W.alivePlayers(level).length}｜淘汰 ${Object.values(level.players).filter((p) => p.losses >= 2 || p.eliminatedAt).length}`]));
    body.appendChild(el('div', { class: 'hr' }));
    body.appendChild(el('div', { class: 'list' }, Object.values(level.players).slice().sort((a, b) => level.playerOrder.indexOf(a.id) - level.playerOrder.indexOf(b.id)).map((p) => renderPlayerRow(level, p))));
    openModal({ title: '选手列表', bodyEl: body, footerEl: el('div', {}, [el('button', { class: 'btn', onclick: closeModal }, ['关闭'])]) });
  }

  function openRankingModal(level) {
    const rows = W.getRankingView(level);
    const total = rows.length;
    const body = document.createElement('div');
    body.appendChild(el('div', { class: 'subtitle' }, [
      level.finished
        ? '已结束。名次由比赛引擎计算。'
        : level.started
          ? '进行中：已确定的名次显示选手姓名，其余显示「未决出」。'
          : '尚未开始：所有名次均未决出。',
    ]));
    body.appendChild(el('div', { class: 'hr' }));
    if (!total) {
      body.appendChild(el('div', { class: 'empty-state' }, ['暂无选手，请先添加选手。']));
    } else {
      body.appendChild(el('div', { class: 'list ranking-list', role: 'list', 'data-total': total }, rows.map((entry) => renderRankingRow(entry))));
    }
    openModal({ title: '实时名次', bodyEl: body, footerEl: el('div', {}, [el('button', { class: 'btn', onclick: closeModal }, ['关闭'])]) });
  }

  function bracketLabel(bracket) {
    if (bracket === 'L') return '败者组';
    if (bracket === 'GF') return '总决赛';
    return '胜者组';
  }

  function matchupName(level, id) {
    return level.players?.[id]?.name || '待定';
  }

  function matchupMeta(item) {
    if (!item) return '';
    if (item.source === 'grandFinal') return `总决赛 · 比分 ${item.wins1}:${item.wins2}`;
    // 跨级别占用：明确告诉操作员在等谁、等哪个级别的比赛结束。
    if (Array.isArray(item.crossBlocked) && item.crossBlocked.length) {
      return item.crossBlocked.map((b) => `等待${b.name}完成${b.levelName}比赛`).join('、');
    }
    const meta = [item.source === 'table' ? `桌子 #${item.tableNo}` : '候场队列', bracketLabel(item.bracket)];
    if (item.waiting) meta.push('等待当前比赛结束');
    return meta.join(' · ');
  }

  function nextEmptyText(level, view) {
    if (!level.started) return '比赛尚未开始';
    if (level.finished) return '本级别比赛已结束';
    if (view.nextStatus === 'grandFinal') return '总决赛进行中，暂无下一组';
    if (view.nextStatus === 'pendingAfterCurrent') return '下一组待定：当前比赛结束后按赛程生成';
    if (view.nextStatus === 'finished') return '本级别比赛已结束';
    return '本级别暂无下一组';
  }

  /*
   * 三桌控制台专用：真实比赛桌已显示当前双方，这里只放一块独立的「下一组上场」。
   * 数据仍来自 W.getMatchupView(level)，赛程结算后随 W.render() 自动更新。
   */
  function renderMiniNextUp(level, view) {
    // 多级别控制台传入全局计划算出的 view，保证预览与实际排桌同源。
    const v = view || W.getMatchupView(level);
    const item = v.next;
    const cross = !!(item && item.crossBlocked && item.crossBlocked.length);
    const cls = 'mini-next' + (item ? '' : ' empty') + (item && item.waiting ? ' waiting' : '') + (cross ? ' cross-wait' : '');
    return el('section', { class: cls, 'data-next-level-id': level.id }, [
      el('div', { class: 'mini-next-label' }, ['下一组上场']),
      item
        ? el('div', { class: 'mini-next-body' }, [
          el('div', { class: 'mini-next-names' }, [
            el('span', { class: 'mini-next-name', 'data-player-id': item.p1 }, [matchupName(level, item.p1)]),
            el('span', { class: 'mini-next-vs' }, ['VS']),
            el('span', { class: 'mini-next-name', 'data-player-id': item.p2 }, [matchupName(level, item.p2)]),
          ]),
          el('div', { class: 'mini-next-meta' }, [matchupMeta(item)]),
        ])
        : el('div', { class: 'mini-next-empty' }, [nextEmptyText(level, v)]),
    ]);
  }

  /*
   * 单级别页面只保留一条「下一组上场」。
   * 当前比赛已经完整显示在每张桌卡里，不再重复一块「当前对阵」占首屏。
   */
  function renderNextUpBar(level, blocked) {
    // 单级别详情页：同一赛事还有其他进行中的级别时，blocked 非空。
    const view = W.getMatchupView(level, blocked);
    const item = view.next;
    const cross = !!(item && item.crossBlocked && item.crossBlocked.length);
    const cls = 'next-up-bar' + (item ? '' : ' empty') + (item && item.waiting ? ' waiting' : '') + (cross ? ' cross-wait' : '');
    return el('section', { class: cls, 'data-next-level-id': level.id, 'aria-label': '下一组上场', 'aria-live': 'polite' }, [
      el('span', { class: 'next-up-label' }, ['下一组上场']),
      item
        ? el('div', { class: 'next-up-main' }, [
          el('div', { class: 'next-up-names' }, [
            el('span', { class: 'next-up-name', 'data-player-id': item.p1 }, [matchupName(level, item.p1)]),
            el('span', { class: 'next-up-vs' }, ['VS']),
            el('span', { class: 'next-up-name', 'data-player-id': item.p2 }, [matchupName(level, item.p2)]),
          ]),
          el('span', { class: 'next-up-meta' }, [matchupMeta(item)]),
        ])
        : el('div', { class: 'next-up-empty' }, [nextEmptyText(level, view)]),
    ]);
  }

  function renderArena(level, blocked) {
    const tableCount = level.started ? W.computeTableCount(level) : level.maxTables;
    if (!level.tables.length) for (let i = 0; i < Math.min(tableCount, level.maxTables); i++) level.tables.push({ tableNo: i + 1, match: null, undo: [] });
    const busy = level.tables.filter((t) => t.match).length;
    const gridClass = 'arena-grid' + (level.tables.length >= 2 ? ' multi' : ' single');
    return el('div', { class: 'arena-wrap' }, [
      el('div', { class: 'card arena-card' }, [
        el('div', { class: 'card-hd arena-hd' }, [
          el('div', {}, [el('div', { class: 'title' }, ['比赛桌']), el('div', { class: 'subtitle' }, ['获胜按钮在各自选手卡内，点击即结算本桌。'])]),
          el('div', { class: 'row arena-badges' }, [
            el('span', { class: 'badge' }, [`上限 ${level.maxTables}`]),
            el('span', { class: 'badge' + (busy ? ' warn' : '') }, [`进行 ${busy}`]),
            el('span', { class: 'badge' }, [`当前 ${level.tables.length}`]),
          ]),
        ]),
        el('div', { class: 'card-bd arena-bd' }, [el('div', { class: gridClass }, level.tables.map((t) => renderTable(level, t.tableNo)))]),
      ]),
      renderNextUpBar(level, blocked),
    ]);
  }

  function idleTableText(level) {
    return level.started ? '空闲，等待自动排桌。' : '开始比赛后将自动排桌。';
  }

  function renderTable(level, tableNo) {
    const t = level.tables.find((x) => x.tableNo === tableNo), match = t?.match;
    W.computePlacements(level);
    const champ = Object.values(level.players).find((p) => p.placement === 1);
    return el('div', { class: 'card table-card' + (match ? ' live' : ''), 'data-table-no': tableNo }, [
      el('div', { class: 'card-hd table-hd' }, [
        el('div', { class: 'table-heading' }, [
          el('div', { class: 'title table-no' }, [`桌子 #${tableNo}`]),
          el('span', { class: `badge ${match ? 'warn' : level.finished ? 'ok' : ''}` }, [match ? bracketLabel(match.bracket) : level.finished ? '已结束' : '空闲']),
        ]),
        el('button', { class: 'btn small ghost table-undo', 'data-action': 'undo-table', 'data-table-no': tableNo, title: '撤回本桌最近一场比赛', onclick: () => { if (!level.started) return W.toast('开始后才能撤回'); const msg = W.undoLast(level, `table:${tableNo}`); if (msg) { W.toast(msg); W.saveState(); W.render(); } else W.toast('没有可撤销的记录'); } }, ['本桌撤回']),
      ]),
      el('div', { class: 'card-bd' }, [match ? renderMatchPanel(level, tableNo, match) : (level.finished && champ ? renderChampionPanel(champ) : el('div', { class: 'empty-state' }, [idleTableText(level)]))]),
    ]);
  }

  function renderChampionPanel(champ) {
    return el('div', { class: 'champion-panel' }, [
      el('div', { class: 'champion-medal' }, ['🥇']),
      el('div', { class: 'champion-name' }, [champ.name]),
      el('div', { class: 'py' }, [champ.pinyin || '']),
      el('div', { class: 'hr' }),
      el('div', { class: 'hint' }, ['比赛已结束。']),
    ]);
  }

  function renderMatchPanel(level, tableNo, match) {
    const p1 = level.players[match.p1], p2 = level.players[match.p2];
    const duelist = (p) => {
      const elim = p.losses >= 2 || p.eliminatedAt;
      return el('div', { class: 'player-box duelist', 'data-player-id': p.id }, [
        el('div', { class: 'duelist-info' }, [
          el('div', { class: 'name' }, [p.name]),
          el('div', { class: 'py' }, [p.pinyin || '']),
          el('div', { class: 'row duelist-meta' }, [
            el('span', { class: `badge ${elim ? 'danger' : p.losses === 1 ? 'warn' : 'ok'}` }, [W.isWithdrawn(level, p) ? '退赛' : `负场 ${Math.min(2, p.losses)}/2`]),
            el('span', { class: 'badge' }, [p.bracket === 'W' ? '胜者组' : '败者组']),
          ]),
        ]),
        el('button', {
          class: 'btn ok block win-btn', 'data-action': 'win', 'data-player-id': p.id,
          'data-table-no': tableNo, 'data-player-name': p.name, 'aria-label': `${p.name} 获胜`,
          onclick: () => { processEvents(W.resolveMatch(level, tableNo, p.id), level); W.saveState(); W.render(); },
        }, [
          el('span', { class: 'win-btn-name' }, [p.name]),
          el('span', { class: 'win-btn-verb' }, ['获胜']),
        ]),
      ]);
    };
    return el('div', { class: 'match-panel' }, [
      duelist(p1),
      el('div', { class: 'vs', 'aria-hidden': 'true' }, ['VS']),
      duelist(p2),
    ]);
  }

  function openHistoryModal(level) {
    const body = document.createElement('div');
    const rows = level.history.slice().sort((a, b) => b.at - a.at).map((h) => {
      const w = level.players[h.winnerId]?.name || '', l = level.players[h.loserId]?.name || '';
      return `<div class="list-item"><div class="stack"><div class="name">${escapeHtml(w)} 胜</div><div class="py">${escapeHtml(l)} 负</div></div><div class="stack" style="align-items:flex-end;"><div class="badge">${escapeHtml(h.bracket === 'W' ? '胜者组' : '败者组')}｜桌 #${h.tableNo}</div><div class="hint">${escapeHtml(new Date(h.at).toLocaleString())}</div></div></div>`;
    }).join('');
    body.innerHTML = `<div class="subtitle">记录每场比赛的时间、胜者、败者。</div><div class="hr"></div><div class="list">${rows || '<div class="muted">暂无记录</div>'}</div>`;
    openModal({ title: '比赛历史', bodyEl: body, footerEl: el('div', {}, [el('button', { class: 'btn', onclick: closeModal }, ['关闭'])]) });
  }

  function showBannerModal(title, text) {
    const body = document.createElement('div'); body.innerHTML = `<div class="subtitle">${escapeHtml(text)}</div>`;
    openModal({ title, bodyEl: body, footerEl: el('div', {}, [el('button', { class: 'btn primary', onclick: closeModal }, ['我知道了'])]) });
  }

  /* 总决赛是否还能录入局分：未结束，且双方都仍在比赛中。 */
  function canRecordGrandFinal(level) {
    const gf = level.grandFinal;
    if (!gf || gf.completed || level.finished) return false;
    const p1 = W.hasOwn(level.players, gf.p1) ? level.players[gf.p1] : null;
    const p2 = W.hasOwn(level.players, gf.p2) ? level.players[gf.p2] : null;
    return !!p1 && !!p2 && p1.losses < 2 && !p1.eliminatedAt
      && p2.losses < 2 && !p2.eliminatedAt;
  }

  // N3: 总决赛面板加撤回按钮
  function showGrandFinalModal(level) {
    const gf = level.grandFinal; if (!gf) return;
    if (!canRecordGrandFinal(level)) { W.toast('总决赛已结束或无法继续'); return; }
    const p1 = level.players[gf.p1], p2 = level.players[gf.p2];
    const body = document.createElement('div');
    body.innerHTML = `<div class="gf-head"><div class="stack"><div class="title">总决赛（BO3 三局两胜）</div><div class="subtitle">胜者组冠军 vs 败者组冠军</div></div><span class="badge warn">进行中</span></div><div class="grid cols-2"><div class="player-box"><div class="name">${escapeHtml(p1?.name || '')}</div><div class="py">${escapeHtml(p1?.pinyin || '')}</div><div class="hr"></div><div class="row between"><div class="muted">胜局</div><div class="gf-score">${gf.wins1}</div></div><div style="margin-top:12px;"><button class="btn ok block" id="gfP1Win">本局胜利</button></div></div><div class="player-box"><div class="name">${escapeHtml(p2?.name || '')}</div><div class="py">${escapeHtml(p2?.pinyin || '')}</div><div class="hr"></div><div class="row between"><div class="muted">胜局</div><div class="gf-score">${gf.wins2}</div></div><div style="margin-top:12px;"><button class="btn ok block" id="gfP2Win">本局胜利</button></div></div></div><div class="hint" style="margin-top:12px;">先赢 2 局者夺冠。<button class="btn small danger" id="gfUndo" style="margin-left:10px;">撤销上一局</button></div>`;
    openModal({ title: '总决赛开始', bodyEl: body, footerEl: el('div', {}, [el('button', { class: 'btn', onclick: closeModal }, ['稍后再记'])]) });
    body.querySelector('#gfP1Win').onclick = () => { const evt = W.recordGrandFinalWin(level, 1); W.saveState(); closeModal(); W.render(); if (evt?.type === 'gfComplete') W.toast(`冠军 ${level.players[evt.winnerId]?.name || ''}`); else if (canRecordGrandFinal(level)) showGrandFinalModal(level); };
    body.querySelector('#gfP2Win').onclick = () => { const evt = W.recordGrandFinalWin(level, 2); W.saveState(); closeModal(); W.render(); if (evt?.type === 'gfComplete') W.toast(`冠军 ${level.players[evt.winnerId]?.name || ''}`); else if (canRecordGrandFinal(level)) showGrandFinalModal(level); };
    // N3: 撤销上一局
    body.querySelector('#gfUndo').onclick = () => {
      const msg = W.undoGrandFinalPoint(level);
      if (msg) { W.toast(msg); W.saveState(); closeModal(); W.render(); showGrandFinalModal(level); }
      else W.toast('没有可撤销的总局记录');
    };
  }

  window.WACAA = W;
})();

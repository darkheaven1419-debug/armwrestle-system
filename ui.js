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
    renderTopActions(route); appRoot.innerHTML = '';
    if (route.name === 'home') renderHome();
    else if (route.name === 'tournament') renderTournament(route.tournamentId);
    else if (route.name === 'level') renderLevel(route.tournamentId, route.levelId);
    else if (route.name === 'multilevel') renderMultiLevel(route.tournamentId, route.levelIds);
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

  /* ==================== 多级别模式 ==================== */
  function renderMultiLevel(tournamentId, levelIds) {
    const t = W.state.tournaments.find((x) => x.id === tournamentId); if (!t) return W.setRoute({ name: 'home' });
    const levels = (levelIds || []).map((id) => t.levels.find((l) => l.id === id)).filter(Boolean);
    if (levels.length < 2) return W.setRoute({ name: 'tournament', tournamentId });
    const header = el('div', { class: 'card multi-head' }, [el('div', { class: 'card-hd' }, [el('div', {}, [el('div', { class: 'title' }, ['多级别同时开始']), el('div', { class: 'subtitle' }, ['三桌并行 · 每个级别固定 1 桌'])]), el('div', { class: 'actions' }, [el('button', { class: 'btn', onclick: () => W.setRoute({ name: 'tournament', tournamentId }) }, ['返回'])])])]);
    const gridClass = 'grid multi-grid' + (levels.length === 2 ? ' two-up' : '');
    appRoot.appendChild(el('div', { class: 'grid multi-console' }, [header, el('div', { class: gridClass }, levels.map((lvl) => renderMiniLevelPanel(t.id, lvl.id)))]));
  }

  function renderMiniLevelPanel(tournamentId, levelId) {
    const { level } = W.getLevel(tournamentId, levelId); if (!level) return el('div', {}, []);
    level.maxTables = Math.max(level.maxTables, 1);
    if (!level.tables.length) level.tables = [{ tableNo: 1, match: null, undo: [] }];
    // C1: 安全缩减桌子——比赛回收而非丢弃
    W.safelyReduceTables(level, 1);
    if (level.started && !level.finished) {
      processEvents(W.generateMatchesIfNeeded(level), level);
      W.fillTables(level);
      // C4: 生成后保存
      W.saveState();
    }
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
          el('button', { class: 'btn small', onclick: () => openRankingModal(level) }, ['名次']),
          el('button', { class: 'btn small', onclick: () => openHistoryModal(level) }, ['历史']),
          el('button', { class: 'btn small', 'data-action': 'table-limit', 'data-level-id': level.id, onclick: () => openTableLimitFlow(level) }, ['桌数']),
          el('button', { class: 'btn small', onclick: () => { if (level.grandFinal && !level.grandFinal.completed) showGrandFinalModal(level); else W.toast('未进入总决赛'); } }, ['决赛']),
          el('button', { class: 'btn small primary', onclick: () => W.setRoute({ name: 'level', tournamentId, levelId }) }, ['进入']),
        ]),
      ]),
      el('div', { class: 'card-bd mini-level-bd' }, [
        renderMiniTableControl(level, 1),
        el('button', { class: 'btn ok block mini-fill-btn', 'data-action': 'fill', 'data-level-id': level.id, onclick: () => {
          if (!level.started) { processEvents(W.startLevel(level), level); }
          else { processEvents(W.generateMatchesIfNeeded(level), level); W.fillTables(level); }
          W.saveState(); W.render(); // C4
        } }, [level.started ? '补充对阵' : '开始比赛（1桌）']),
        // 真实比赛桌已显示当前双方，控制台不再重复「当前对阵」，只保留下方下一组区域
        renderMiniNextUp(level),
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
      body = el('details', { class: 'mini-details' }, [
        el('summary', {}, ['手动排桌 / 完整桌面']),
        renderTable(level, tableNo, { compact: true }),
      ]);
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

  /* ==================== 级别页面 ==================== */
  function renderLevel(tournamentId, levelId) {
    const { tournament, level } = W.getLevel(tournamentId, levelId);
    if (!tournament || !level) return W.setRoute({ name: 'home' });
    if (level.started && !level.finished) {
      processEvents(W.generateMatchesIfNeeded(level), level);
      W.fillTables(level);
      W.finalizeIfDone(level);
      // C4: 生成对阵后保存
      W.saveState();
    }
    const wrap = el('div', { class: 'grid' }, []);
    wrap.appendChild(renderLevelHeader(tournamentId, tournament, level));
    wrap.appendChild(renderLevelBody(tournamentId, tournament, level));
    appRoot.appendChild(wrap);
  }

  function renderLevelHeader(tournamentId, tournament, level) {
    const alive = W.alivePlayers(level).length, total = Object.keys(level.players).length;
    const done = level.history.length, pending = level.pendingMatches.length + level.tables.filter((t) => t.match).length;
    const pct = Math.round((done / Math.max(1, done + pending)) * 100);
    return el('div', { class: 'card level-hero level-hero-compact' }, [el('div', { class: 'card-bd level-hero-bd' }, [
      el('div', { class: 'level-hero-top' }, [
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
          el('span', {}, [`选手 ${total}`]),
          el('span', {}, [`存活 ${alive}`]),
          el('span', {}, [`完成 ${done}`]),
          el('span', { class: 'level-progress-inline', title: `进度 ${pct}%` }, [el('span', { style: `width:${pct}%` }, [])]),
          el('span', { class: 'level-pct' }, [`${pct}%`]),
        ]),
      ]),
      el('div', { class: 'actions level-hero-actions' }, [
        el('button', { class: 'btn primary', 'data-action': 'start-or-fill', onclick: () => { if (!level.started) { processEvents(W.startLevel(level), level); } else { processEvents(W.generateMatchesIfNeeded(level), level); W.fillTables(level); } W.saveState(); W.render(); } }, [level.started ? '补充对阵' : '开始比赛']),
        el('button', { class: 'btn', onclick: () => openPlayerListModal(level) }, ['选手列表']),
        el('button', { class: 'btn', onclick: () => openRankingModal(level) }, ['实时名次']),
        el('button', { class: 'btn', onclick: () => { if (!level.started) { W.toast('尚未开始'); return; } const msg = W.undoLast(level, 'global'); if (msg) { W.toast(msg); W.saveState(); W.render(); } else W.toast('没有可撤销的记录'); } }, ['全局撤回']),
        el('button', { class: 'btn', onclick: () => openHistoryModal(level) }, ['比赛历史']),
        el('button', { class: 'btn', onclick: () => { if (level.grandFinal && !level.grandFinal.completed) showGrandFinalModal(level); else W.toast('未进入总决赛'); } }, ['总决赛面板']),
        el('button', { class: 'btn danger', onclick: () => { if (!confirm('确定清空本级别所有数据？')) return; const keep = { id: level.id, name: level.name, maxTables: level.maxTables, autoShuffle: level.autoShuffle, createdAt: level.createdAt }; const fresh = W.createLevel({ name: keep.name, maxTables: keep.maxTables, autoShuffle: keep.autoShuffle }); Object.assign(level, fresh, keep); W.saveState(); W.render(); } }, ['清空本级别']),
        el('button', { class: 'btn', onclick: () => W.setRoute({ name: 'tournament', tournamentId }) }, ['返回']),
      ]),
    ])]);
  }

  function renderLevelBody(tournamentId, tournament, level) {
    // 已开始：比赛桌优先占据首屏；未开始：先录入选手。
    const cls = 'level-layout ' + (level.started ? 'is-started' : 'is-waiting') + (level.tables.length >= 3 ? ' three-tables' : '');
    const parts = level.started ? [renderArena(level), renderPlayerSidebar(level)] : [renderPlayerSidebar(level), renderArena(level)];
    return el('div', { class: cls }, parts);
  }

  /* 只改桌数，不经过改名流程；已开始级别会先确认再安全调整 */
  function openTableLimitFlow(level) {
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
    const medal = level.finished ? (p.placement === 1 ? '🥇' : p.placement === 2 ? '🥈' : p.placement === 3 ? '🥉' : '') : '';
    return el('div', { class: 'list-item' }, [
      el('div', { class: 'stack' }, [el('div', { class: 'name' }, [`${Number.isFinite(p.placement) ? '#' + p.placement : '未决出'} ${medal} ${p.name}`]), el('div', { class: 'py' }, [p.pinyin || ''])]),
      el('span', { class: `badge ${p.losses >= 2 || p.eliminatedAt ? 'danger' : p.losses === 1 ? 'warn' : 'ok'}` }, [W.isWithdrawn(level, p) ? '退赛' : `${Math.min(2, p.losses)}/2`]),
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
    W.computePlacements(level);
    const ps = Object.values(level.players).filter((p) => p.name), total = ps.length;
    const byPlace = new Map(); for (const p of ps) { if (Number.isFinite(p.placement)) byPlace.set(p.placement, p); }
    const body = document.createElement('div');
    body.appendChild(el('div', { class: 'subtitle' }, [level.finished ? '已结束。' : `进行中：第1→第${total}名。`]));
    body.appendChild(el('div', { class: 'hr' }));
    const rows = [];
    for (let place = 1; place <= total; place++) { const p = byPlace.get(place); rows.push(p ? renderRankRow(level, p) : el('div', { class: 'list-item' }, [el('div', { class: 'stack' }, [el('div', { class: 'name' }, [`#${place} 未决出`])]), el('span', { class: 'badge' }, ['—'])])); }
    body.appendChild(el('div', { class: 'list' }, rows));
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
  function renderMiniNextUp(level) {
    const view = W.getMatchupView(level);
    const item = view.next;
    const cls = 'mini-next' + (item ? '' : ' empty') + (item && item.waiting ? ' waiting' : '');
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
        : el('div', { class: 'mini-next-empty' }, [nextEmptyText(level, view)]),
    ]);
  }

  /*
   * 单级别页面只保留一条「下一组上场」。
   * 当前比赛已经完整显示在每张桌卡里，不再重复一块「当前对阵」占首屏。
   */
  function renderNextUpBar(level) {
    const view = W.getMatchupView(level);
    const item = view.next;
    const cls = 'next-up-bar' + (item ? '' : ' empty') + (item && item.waiting ? ' waiting' : '');
    return el('section', { class: cls, 'data-next-level-id': level.id, 'aria-label': '下一组上场' }, [
      el('span', { class: 'next-up-label' }, ['下一组']),
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

  function renderArena(level) {
    const tableCount = level.started ? W.computeTableCount(level) : level.maxTables;
    if (!level.tables.length) for (let i = 0; i < Math.min(tableCount, level.maxTables); i++) level.tables.push({ tableNo: i + 1, match: null, undo: [] });
    const busy = level.tables.filter((t) => t.match).length;
    const gridClass = 'arena-grid' + (level.tables.length >= 2 ? ' multi' : ' single');
    return el('div', { class: 'arena-wrap' }, [
      renderNextUpBar(level),
      el('div', { class: 'card arena-card' }, [
        el('div', { class: 'card-hd arena-hd' }, [
          el('div', {}, [el('div', { class: 'title' }, ['多桌并行比赛']), el('div', { class: 'subtitle' }, ['点击获胜结算本桌。'])]),
          el('div', { class: 'row arena-badges' }, [
            el('span', { class: 'badge' }, [`上限 ${level.maxTables}`]),
            el('span', { class: 'badge' + (busy ? ' warn' : '') }, [`进行 ${busy}`]),
            el('span', { class: 'badge' }, [`当前 ${level.tables.length}`]),
          ]),
        ]),
        el('div', { class: 'card-bd arena-bd' }, [el('div', { class: gridClass }, level.tables.map((t) => renderTable(level, t.tableNo)))]),
      ]),
    ]);
  }

  function renderTable(level, tableNo, opts) {
    opts = opts || {};
    const t = level.tables.find((x) => x.tableNo === tableNo), match = t?.match;
    W.computePlacements(level);
    const champ = Object.values(level.players).find((p) => p.placement === 1);
    return el('div', { class: 'card table-card' + (match ? ' live' : ''), 'data-table-no': tableNo }, [
      el('div', { class: 'card-hd table-hd' }, [
        el('div', {}, [el('div', { class: 'title table-no' }, [`桌子 #${tableNo}`]), el('div', { class: 'subtitle' }, [match ? (match.bracket === 'W' ? '胜者组' : '败者组') : '空闲'])]),
        el('div', { class: 'row' }, [el('button', { class: 'btn small ghost', 'data-action': 'undo-table', 'data-table-no': tableNo, onclick: () => { if (!level.started) return W.toast('开始后才能撤回'); const msg = W.undoLast(level, `table:${tableNo}`); if (msg) { W.toast(msg); W.saveState(); W.render(); } else W.toast('没有可撤销的记录'); } }, ['本桌撤回'])]),
      ]),
      el('div', { class: 'card-bd' }, [match ? renderMatchPanel(level, tableNo, match) : (level.finished && champ ? renderChampionPanel(champ) : renderManualAssign(level, tableNo))]),
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
    return el('div', { class: 'match-panel' }, [
      playerBox(level, p1), el('div', { class: 'vs' }, ['VS']), playerBox(level, p2),
      el('div', { class: 'win-actions' }, [
        el('button', { class: 'btn ok block win-btn', 'data-action': 'win', 'data-player-id': p1.id, 'data-table-no': tableNo, 'data-player-name': p1.name, onclick: () => { processEvents(W.resolveMatch(level, tableNo, p1.id), level); W.saveState(); W.render(); } }, [`${p1.name} 获胜`]),
        el('button', { class: 'btn ok block win-btn', 'data-action': 'win', 'data-player-id': p2.id, 'data-table-no': tableNo, 'data-player-name': p2.name, onclick: () => { processEvents(W.resolveMatch(level, tableNo, p2.id), level); W.saveState(); W.render(); } }, [`${p2.name} 获胜`]),
      ]),
    ]);
  }

  function playerBox(level, p) {
    return el('div', { class: 'stack player-box' }, [
      el('div', { class: 'name' }, [p?.name || '']), el('div', { class: 'py' }, [p?.pinyin || '']),
      el('div', { class: 'row', style: 'margin-top:6px;' }, [
        el('span', { class: `badge ${(p.losses >= 2 || p.eliminatedAt) ? 'danger' : p.losses === 1 ? 'warn' : 'ok'}` }, [W.isWithdrawn(level, p) ? '退赛' : `负场 ${Math.min(2, p.losses)}/2`]),
        el('span', { class: 'badge' }, [p.bracket === 'W' ? '胜者组' : '败者组']),
      ]),
    ]);
  }

  // C2: 手动分配自动推断组别
  function renderManualAssign(level, tableNo) {
    const alive = W.alivePlayers(level);
    const opts = alive.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}（${p.bracket === 'W' ? '胜' : '败'}｜${p.losses}/2）</option>`).join('');
    const body = document.createElement('div');
    body.innerHTML = `<div class="subtitle">空闲桌子：手动指定两名存活选手比赛。组别自动根据负场数推断。</div><div class="hr"></div><div class="grid cols-2"><div class="field"><label>选手 A</label><select class="select" id="aSel"><option value="">请选择</option>${opts}</select></div><div class="field"><label>选手 B</label><select class="select" id="bSel"><option value="">请选择</option>${opts}</select></div></div><div class="hint" style="margin-top:10px;">两名选手将以各自当前负场数对应的组别进行比赛（0负→胜者组，1负→败者组）。</div><div style="margin-top:10px;"><button class="btn primary block" id="assignBtn">分配到本桌</button></div>`;
    body.querySelector('#assignBtn').onclick = () => {
      if (!level.started) return W.toast('请先开始比赛');
      const a = body.querySelector('#aSel').value, b = body.querySelector('#bSel').value;
      if (!a || !b || a === b) return W.toast('请选两名不同选手');
      const pa = level.players[a], pb = level.players[b];
      if (!pa || !pb) return;
      if (pa.losses >= 2 || pb.losses >= 2 || pa.eliminatedAt || pb.eliminatedAt) return W.toast('淘汰/退赛选手不可参赛');
      const t = level.tables.find((x) => x.tableNo === tableNo);
      if (!t || t.match) return W.toast('本桌已有比赛，无法分配');
      // C2: 自动推断组别——只有确实分配到本桌时才改选手组别
      const br = (pa.losses === 0 && pb.losses === 0) ? 'W' : 'L';
      if (W.pushUndoSnapshot) { W.pushUndoSnapshot(level, `table:${tableNo}`); W.pushUndoSnapshot(level, 'global'); }
      pa.bracket = br; pb.bracket = br;
      t.match = { id: W.uid(), createdAt: W.now(), bracket: br, p1: a, p2: b, tableNo };
      W.saveState(); W.render();
    };
    return body;
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

  // N3: 总决赛面板加撤回按钮
  function showGrandFinalModal(level) {
    const gf = level.grandFinal; if (!gf) return;
    const p1 = level.players[gf.p1], p2 = level.players[gf.p2];
    const body = document.createElement('div');
    body.innerHTML = `<div class="gf-head"><div class="stack"><div class="title">总决赛（BO3 三局两胜）</div><div class="subtitle">胜者组冠军 vs 败者组冠军</div></div><span class="badge warn">进行中</span></div><div class="grid cols-2"><div class="player-box"><div class="name">${escapeHtml(p1?.name || '')}</div><div class="py">${escapeHtml(p1?.pinyin || '')}</div><div class="hr"></div><div class="row between"><div class="muted">胜局</div><div class="gf-score">${gf.wins1}</div></div><div style="margin-top:12px;"><button class="btn ok block" id="gfP1Win">本局胜利</button></div></div><div class="player-box"><div class="name">${escapeHtml(p2?.name || '')}</div><div class="py">${escapeHtml(p2?.pinyin || '')}</div><div class="hr"></div><div class="row between"><div class="muted">胜局</div><div class="gf-score">${gf.wins2}</div></div><div style="margin-top:12px;"><button class="btn ok block" id="gfP2Win">本局胜利</button></div></div></div><div class="hint" style="margin-top:12px;">先赢 2 局者夺冠。<button class="btn small danger" id="gfUndo" style="margin-left:10px;">撤销上一局</button></div>`;
    openModal({ title: '总决赛开始', bodyEl: body, footerEl: el('div', {}, [el('button', { class: 'btn', onclick: closeModal }, ['稍后再记'])]) });
    body.querySelector('#gfP1Win').onclick = () => { const evt = W.recordGrandFinalWin(level, 1); W.saveState(); closeModal(); W.render(); if (evt?.type === 'gfComplete') W.toast(`冠军 ${level.players[evt.winnerId]?.name || ''}`); else if (!level.grandFinal?.completed) showGrandFinalModal(level); };
    body.querySelector('#gfP2Win').onclick = () => { const evt = W.recordGrandFinalWin(level, 2); W.saveState(); closeModal(); W.render(); if (evt?.type === 'gfComplete') W.toast(`冠军 ${level.players[evt.winnerId]?.name || ''}`); else if (!level.grandFinal?.completed) showGrandFinalModal(level); };
    // N3: 撤销上一局
    body.querySelector('#gfUndo').onclick = () => {
      const msg = W.undoGrandFinalPoint(level);
      if (msg) { W.toast(msg); W.saveState(); closeModal(); W.render(); showGrandFinalModal(level); }
      else W.toast('没有可撤销的总局记录');
    };
  }

  window.WACAA = W;
})();

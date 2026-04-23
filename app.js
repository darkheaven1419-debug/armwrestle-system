/* eslint-disable no-alert */
(() => {
  'use strict';

  // ---------------------------
  // 小工具：ID、深拷贝、随机、存储
  // ---------------------------
  const uid = () => Math.random().toString(16).slice(2) + Date.now().toString(16);
  const now = () => Date.now();
  const deepClone = (x) => JSON.parse(JSON.stringify(x));

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  const STORAGE_KEY = 'wacaa_armwrestle_v1';
  const safeJsonParse = (s) => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };

  function loadState() {
    const reset = new URLSearchParams(location.search).get('reset');
    if (reset === '1') {
      localStorage.removeItem(STORAGE_KEY);
      history.replaceState(null, '', location.pathname);
    }
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? safeJsonParse(raw) : null;
    if (parsed && parsed.version === 1) return parsed;
    return {
      version: 1,
      tournaments: [],
      ui: { route: { name: 'home' } },
    };
  }

  function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  // ---------------------------
  // 拼音：pinyin-pro（带声调）
  // ---------------------------
  function getPinyin(name) {
    const n = (name ?? '').trim();
    if (!n) return '';
    if (!window.pinyinPro?.pinyin) return '';
    return window.pinyinPro.pinyin(n, { toneType: 'symbol', type: 'array' }).join(' ');
  }

  // ---------------------------
  // Toast + Modal
  // ---------------------------
  const toastRoot = document.getElementById('toasts');
  function toast(msg) {
    // 多级别模式下屏蔽“过程噪音”提示（生成对阵/桌子数调整等），避免干扰现场
    const routeName = state?.ui?.route?.name;
    if (routeName === 'multilevel') {
      const s = String(msg || '');
      const noisy =
        s.includes('胜者组生成') ||
        s.includes('败者组生成') ||
        s.includes('桌子数自动调整') ||
        s.includes('已回收多余桌子的比赛') ||
        s.includes('比赛已开始') ||
        s.includes('继续补桌') ||
        s.includes('已新增：') ||
        s.includes('已添加 ') ||
        s.includes('已忽略重复');
      if (noisy) return;
    }
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    toastRoot.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transition = 'opacity .25s ease';
    }, 2600);
    setTimeout(() => el.remove(), 3200);
  }

  const modalBackdrop = document.getElementById('modalBackdrop');
  const modalTitle = document.getElementById('modalTitle');
  const modalBody = document.getElementById('modalBody');
  const modalFooter = document.getElementById('modalFooter');
  const modalCloseBtn = document.getElementById('modalCloseBtn');

  function closeModal() {
    modalBackdrop.style.display = 'none';
    modalTitle.textContent = '';
    modalBody.innerHTML = '';
    modalFooter.innerHTML = '';
  }
  modalCloseBtn.addEventListener('click', closeModal);
  modalBackdrop.addEventListener('click', (e) => {
    if (e.target === modalBackdrop) closeModal();
  });

  function openModal({ title, bodyEl, footerEl }) {
    modalTitle.textContent = title;
    modalBody.innerHTML = '';
    modalFooter.innerHTML = '';
    if (bodyEl) modalBody.appendChild(bodyEl);
    if (footerEl) modalFooter.appendChild(footerEl);
    modalBackdrop.style.display = 'flex';
  }

  // ---------------------------
  // 路由（极简）
  // ---------------------------
  function setRoute(route) {
    state.ui.route = route;
    saveState();
    render();
  }

  // ---------------------------
  // 数据结构
  // ---------------------------
  function createTournament(name) {
    return {
      id: uid(),
      name: (name || '新建比赛').trim() || '新建比赛',
      createdAt: now(),
      levels: [],
    };
  }

  function createLevel({ name, maxTables }) {
    return {
      id: uid(),
      name: (name || '未命名级别').trim() || '未命名级别',
      createdAt: now(),
      maxTables: clampInt(maxTables ?? 1, 1, 3),
      started: false,
      finished: false,
      players: {}, // id -> player
      playerOrder: [], // seeds order (player ids)
      pendingMatches: [], // queue of matches
      tables: [], // current running match per table
      history: [], // completed matches
      undoStack: [], // snapshots (level state)
      banners: { top8Shown: false, top4Shown: false, gfShown: false },
      grandFinal: null, // { p1, p2, wins1, wins2, completed }
    };
  }

  function createPlayer(name) {
    const clean = (name || '').trim();
    return {
      id: uid(),
      name: clean,
      pinyin: getPinyin(clean),
      losses: 0,
      eliminatedAt: null,
      placement: null,
      bracket: 'W', // W/L
    };
  }

  function clampInt(x, a, b) {
    const n = Number.parseInt(String(x), 10);
    if (Number.isNaN(n)) return a;
    return Math.max(a, Math.min(b, n));
  }

  function alivePlayers(level) {
    return Object.values(level.players).filter((p) => p.losses < 2);
  }

  function bracketPlayers(level, bracket) {
    return alivePlayers(level).filter((p) => p.bracket === bracket);
  }

  function computeTableCount(level) {
    const alive = alivePlayers(level).length;
    let want = 1;
    if (alive <= 8) want = 1;
    else if (alive <= 16) want = 2;
    else want = 3;
    return Math.min(level.maxTables, want);
  }

  function normalizeNameKey(name) {
    return (name || '').trim().toLowerCase();
  }

  // ---------------------------
  // 对阵生成：胜者/败者独立“下一轮晋级池”
  // 为简单与可控：每次需要生成时，直接从该组当前存活选手中，
  // 选取“目前未在待赛/在桌子/已被安排轮空”且属于该组的选手进行配对。
  // ---------------------------
  function participantsInUse(level) {
    const used = new Set();
    for (const t of level.tables) {
      if (t?.match?.p1) used.add(t.match.p1);
      if (t?.match?.p2) used.add(t.match.p2);
    }
    for (const m of level.pendingMatches) {
      if (m.p1) used.add(m.p1);
      if (m.p2) used.add(m.p2);
    }
    return used;
  }

  function hasPendingForBracket(level, bracket) {
    return level.pendingMatches.some((m) => m.bracket === bracket);
  }

  function generateMatchesIfNeeded(level) {
    if (!level.started || level.finished) return;

    // 先根据存活人数自动调整桌子数量（并回收多余桌子上的比赛到队列）
    adjustTablesToAutoCount(level);

    // 若总决赛已经创建/进行中，则不再生成常规对阵
    if (level.grandFinal && !level.grandFinal.completed) return;

    const alive = alivePlayers(level);
    if (alive.length <= 1) {
      finalizeIfDone(level);
      return;
    }

    // 检查是否应进入总决赛
    const wAlive = bracketPlayers(level, 'W');
    const lAlive = bracketPlayers(level, 'L');
    if (wAlive.length === 1 && lAlive.length === 1 && !level.grandFinal) {
      startGrandFinal(level, wAlive[0].id, lAlive[0].id);
      return;
    }

    // 生成胜者组对阵
    if (!hasPendingForBracket(level, 'W')) {
      const created = createBracketPairings(level, 'W');
      if (created > 0) toast(`胜者组生成 ${created} 场对阵`);
    }
    // 生成败者组对阵
    if (!hasPendingForBracket(level, 'L')) {
      const created = createBracketPairings(level, 'L');
      if (created > 0) toast(`败者组生成 ${created} 场对阵`);
    }
  }

  function createBracketPairings(level, bracket) {
    const used = participantsInUse(level);
    const candidates = bracketPlayers(level, bracket)
      .map((p) => p.id)
      .filter((id) => !used.has(id));

    if (candidates.length < 2) return 0;
    const pool = shuffle(candidates);

    // 轮空处理：奇数则随机抽一个直接晋级（留在原组，不加负场）
    if (pool.length % 2 === 1) {
      const byeIdx = Math.floor(Math.random() * pool.length);
      const byeId = pool.splice(byeIdx, 1)[0];
      const p = level.players[byeId];
      if (p) toast(`${p.name} 轮空直接晋级`);
    }

    let created = 0;
    for (let i = 0; i < pool.length; i += 2) {
      const p1 = pool[i];
      const p2 = pool[i + 1];
      if (!p1 || !p2) continue;
      level.pendingMatches.push({
        id: uid(),
        createdAt: now(),
        bracket,
        p1,
        p2,
        tableNo: null,
      });
      created++;
    }
    return created;
  }

  function adjustTablesToAutoCount(level) {
    const want = computeTableCount(level);
    const cur = level.tables.length;
    if (cur === want) return;

    // 如果减少桌子，回收多余桌子上的比赛到队列（排队在前）
    if (cur > want) {
      for (let i = want; i < cur; i++) {
        const t = level.tables[i];
        if (t?.match) {
          const m = t.match;
          m.tableNo = null;
          level.pendingMatches.unshift(m);
        }
      }
      level.tables = level.tables.slice(0, want);
      toast(`桌子数自动调整为 ${want} 张（已回收多余桌子的比赛）`);
      return;
    }

    // 如果增加桌子，补空桌
    for (let i = cur; i < want; i++) {
      level.tables.push({ tableNo: i + 1, match: null, undo: [] });
    }
    toast(`桌子数自动调整为 ${want} 张`);
  }

  function fillTables(level) {
    // 为每个空闲桌子补充下一场不冲突的对阵
    for (const t of level.tables) {
      if (t.match) continue;
      const inUse = new Set();
      for (const tt of level.tables) {
        if (!tt.match) continue;
        inUse.add(tt.match.p1);
        inUse.add(tt.match.p2);
      }
      const idx = level.pendingMatches.findIndex((m) => !inUse.has(m.p1) && !inUse.has(m.p2));
      if (idx === -1) continue;
      const m = level.pendingMatches.splice(idx, 1)[0];
      m.tableNo = t.tableNo;
      t.match = m;
    }
  }

  function pushUndoSnapshot(level, scope) {
    // scope: 'global' | `table:${n}`
    level.undoStack.push({
      id: uid(),
      at: now(),
      scope,
      snapshot: deepClone({
        players: level.players,
        pendingMatches: level.pendingMatches,
        tables: level.tables,
        history: level.history,
        finished: level.finished,
        grandFinal: level.grandFinal,
        banners: level.banners,
      }),
    });
    if (level.undoStack.length > 60) level.undoStack.shift();
  }

  function restoreSnapshot(level, snap) {
    level.players = snap.players;
    level.pendingMatches = snap.pendingMatches;
    level.tables = snap.tables;
    level.history = snap.history;
    level.finished = snap.finished;
    level.grandFinal = snap.grandFinal;
    level.banners = snap.banners;
  }

  function resolveMatch(level, tableNo, winnerId) {
    const table = level.tables.find((t) => t.tableNo === tableNo);
    if (!table?.match) return;
    const match = table.match;
    const loserId = match.p1 === winnerId ? match.p2 : match.p1;
    const w = level.players[winnerId];
    const l = level.players[loserId];
    if (!w || !l) return;

    pushUndoSnapshot(level, `table:${tableNo}`);
    pushUndoSnapshot(level, 'global');

    // 记录历史
    level.history.push({
      id: uid(),
      at: now(),
      tableNo,
      bracket: match.bracket,
      p1: match.p1,
      p2: match.p2,
      winnerId,
      loserId,
    });

    // 胜者：保持原组；败者：胜者组掉入败者组，败者组则增加负场
    if (match.bracket === 'W') {
      l.losses += 1;
      if (l.losses >= 2) {
        eliminate(level, l.id);
      } else {
        l.bracket = 'L';
      }
    } else if (match.bracket === 'L') {
      l.losses += 1;
      if (l.losses >= 2) eliminate(level, l.id);
    }

    // 清理淘汰选手在队列中的所有未进行比赛
    cleanupPendingMatches(level);

    // 桌子置空，继续补对阵
    table.match = null;

    // 阶段提示：前8、前4、总决赛（总决赛在 startGrandFinal 中）
    maybeShowStageBanners(level);

    // 生成下一轮并补桌
    generateMatchesIfNeeded(level);
    fillTables(level);
    finalizeIfDone(level);
  }

  function cleanupPendingMatches(level) {
    const alive = new Set(alivePlayers(level).map((p) => p.id));
    level.pendingMatches = level.pendingMatches.filter((m) => alive.has(m.p1) && alive.has(m.p2));
    for (const t of level.tables) {
      if (!t.match) continue;
      if (!alive.has(t.match.p1) || !alive.has(t.match.p2)) {
        t.match = null;
      }
    }
  }

  function eliminate(level, playerId) {
    const p = level.players[playerId];
    if (!p || p.eliminatedAt) return;
    p.eliminatedAt = now();
  }

  function computePlacements(level) {
    const ps = Object.values(level.players);
    const total = ps.length;

    // 先清空“未决出”的名次；只给已经两败淘汰的人结算明确名次
    for (const p of ps) p.placement = null;

    // 关键规则：谁先两败淘汰，名次越低
    // 第一个两败淘汰 = 第 total 名（倒数第一），第二个淘汰 = 第 total-1 名……
    const eliminated = ps
      .filter((p) => p.eliminatedAt)
      .sort((a, b) => a.eliminatedAt - b.eliminatedAt);
    eliminated.forEach((p, idx) => {
      p.placement = total - idx;
    });

    // 如果比赛已结束，再补冠军/亚军（冠军不应被视为淘汰）
    if (level.finished) {
      if (level.grandFinal?.completed && level.grandFinal.winnerId) {
        const champ = level.players[level.grandFinal.winnerId];
        if (champ) champ.placement = 1;
      } else {
        const alive = ps.filter((p) => !p.eliminatedAt);
        if (alive.length === 1) alive[0].placement = 1;
      }
    }
  }

  function finalizeIfDone(level) {
    const alive = alivePlayers(level);
    if (level.grandFinal && level.grandFinal.completed) {
      level.finished = true;
      computePlacements(level);
      return;
    }
    if (alive.length === 1 && level.started) {
      level.finished = true;
      computePlacements(level);
    }
  }

  function maybeShowStageBanners(level) {
    const alive = alivePlayers(level).length;
    if (!level.banners.top8Shown && alive <= 8) {
      level.banners.top8Shown = true;
      showBannerModal('前8强诞生', '当前级别已进入前8强阶段。');
    }
    // 你希望多级别/现场只提示“前八、前三”
    if (!level.banners.top4Shown && alive <= 3) {
      level.banners.top4Shown = true;
      showBannerModal('前3强诞生', '当前级别已进入前三强阶段。');
    }
  }

  function showBannerModal(title, text) {
    const body = document.createElement('div');
    body.innerHTML = `<div class="subtitle">${escapeHtml(text)}</div>`;
    const ft = document.createElement('div');
    const ok = document.createElement('button');
    ok.className = 'btn primary';
    ok.textContent = '我知道了';
    ok.onclick = closeModal;
    ft.appendChild(ok);
    openModal({ title, bodyEl: body, footerEl: ft });
  }

  function startGrandFinal(level, wId, lId) {
    level.banners.gfShown = true;
    level.grandFinal = { p1: wId, p2: lId, wins1: 0, wins2: 0, completed: false, winnerId: null, runnerUpId: null };
    showGrandFinalModal(level);
  }

  function showGrandFinalModal(level) {
    const gf = level.grandFinal;
    if (!gf) return;
    const p1 = level.players[gf.p1];
    const p2 = level.players[gf.p2];
    const body = document.createElement('div');
    body.innerHTML = `
      <div class="row between" style="margin-bottom:10px;">
        <div class="stack">
          <div class="title">总决赛（BO3）</div>
          <div class="subtitle">胜者组冠军 vs 败者组冠军（手动记录每局胜负）</div>
        </div>
        <span class="badge warn">进行中</span>
      </div>
      <div class="grid cols-2">
        <div class="card" style="box-shadow:none;">
          <div class="card-bd">
            <div class="name">${escapeHtml(p1?.name || '')}</div>
            <div class="py">${escapeHtml(p1?.pinyin || '')}</div>
            <div class="hr"></div>
            <div class="row between">
              <div class="muted">胜局</div>
              <div class="title" style="font-size:22px;">${gf.wins1}</div>
            </div>
            <div style="margin-top:10px;">
              <button class="btn ok block" id="gfP1Win">本局胜利</button>
            </div>
          </div>
        </div>
        <div class="card" style="box-shadow:none;">
          <div class="card-bd">
            <div class="name">${escapeHtml(p2?.name || '')}</div>
            <div class="py">${escapeHtml(p2?.pinyin || '')}</div>
            <div class="hr"></div>
            <div class="row between">
              <div class="muted">胜局</div>
              <div class="title" style="font-size:22px;">${gf.wins2}</div>
            </div>
            <div style="margin-top:10px;">
              <button class="btn ok block" id="gfP2Win">本局胜利</button>
            </div>
          </div>
        </div>
      </div>
      <div class="hint" style="margin-top:10px;">先赢 2 局者夺冠。结束后会显示金银铜牌。</div>
    `;

    const ft = document.createElement('div');
    const close = document.createElement('button');
    close.className = 'btn';
    close.textContent = '稍后再记';
    close.onclick = closeModal;
    ft.appendChild(close);

    openModal({ title: '总决赛开始', bodyEl: body, footerEl: ft });

    const p1Btn = body.querySelector('#gfP1Win');
    const p2Btn = body.querySelector('#gfP2Win');
    p1Btn.onclick = () => {
      pushUndoSnapshot(level, 'global');
      gf.wins1 += 1;
      if (gf.wins1 >= 2) finishGrandFinal(level, gf.p1, gf.p2);
      saveState();
      closeModal();
      render();
      if (!gf.completed) showGrandFinalModal(level);
    };
    p2Btn.onclick = () => {
      pushUndoSnapshot(level, 'global');
      gf.wins2 += 1;
      if (gf.wins2 >= 2) finishGrandFinal(level, gf.p2, gf.p1);
      saveState();
      closeModal();
      render();
      if (!gf.completed) showGrandFinalModal(level);
    };
  }

  function finishGrandFinal(level, winnerId, runnerUpId) {
    const w = level.players[winnerId];
    const r = level.players[runnerUpId];
    if (!w || !r) return;
    level.grandFinal.completed = true;
    level.grandFinal.winnerId = winnerId;
    level.grandFinal.runnerUpId = runnerUpId;
    // 亚军视为“最后淘汰”（为排序一致，给 runnerUp 一个 eliminatedAt）
    r.losses = 2;
    eliminate(level, r.id);
    // 冠军保持未淘汰
    level.finished = true;
    computePlacements(level);
    toast(`总决赛结束：冠军 ${w.name}`);
  }

  // ---------------------------
  // 全局 Undo / 仅本桌 Undo
  // ---------------------------
  function undoLast(level, scope) {
    for (let i = level.undoStack.length - 1; i >= 0; i--) {
      const u = level.undoStack[i];
      if (u.scope !== scope) continue;
      level.undoStack.splice(i, 1);
      restoreSnapshot(level, u.snapshot);
      toast(scope === 'global' ? '已撤销最近一场比赛' : '已撤销本桌最近一场比赛');
      return true;
    }
    toast('没有可撤销的记录');
    return false;
  }

  // ---------------------------
  // UI：渲染
  // ---------------------------
  const appRoot = document.getElementById('app');
  const topActions = document.getElementById('topActions');

  function el(tag, attrs = {}, children = []) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') e.className = v;
      else if (k === 'html') e.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else if (v !== undefined && v !== null) e.setAttribute(k, String(v));
    }
    for (const c of children) {
      if (c === null || c === undefined) continue;
      e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return e;
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    })[ch]);
  }

  function renderTopActions(route) {
    topActions.innerHTML = '';
    const left = [];
    const right = [];

    if (route.name !== 'home') {
      right.push(el('button', { class: 'btn small', onclick: () => setRoute({ name: 'home' }) }, ['返回主界面']));
    }

    right.push(el('button', {
      class: 'btn small',
      onclick: () => openImportExportModal(),
    }, ['导入/导出']));

    right.push(el('button', {
      class: 'btn small danger',
      onclick: () => {
        if (confirm('确定清空所有本地数据？')) {
          localStorage.removeItem(STORAGE_KEY);
          state = loadState();
          render();
        }
      },
    }, ['清空全部数据']));

    topActions.appendChild(el('div', { class: 'row' }, left));
    topActions.appendChild(el('div', { class: 'row' }, right));
  }

  function render() {
    const route = state.ui.route || { name: 'home' };
    renderTopActions(route);
    appRoot.innerHTML = '';

    if (route.name === 'home') return renderHome();
    if (route.name === 'tournament') return renderTournament(route.tournamentId);
    if (route.name === 'level') return renderLevel(route.tournamentId, route.levelId);
    if (route.name === 'multilevel') return renderMultiLevel(route.tournamentId, route.levelIds);
    renderHome();
  }

  // ---------------------------
  // 页面：主界面（多赛事）
  // ---------------------------
  function renderHome() {
    const wrap = el('div', { class: 'grid cols-2' }, []);

    const left = el('div', { class: 'card' }, [
      el('div', { class: 'card-hd' }, [
        el('div', {}, [
          el('div', { class: 'title' }, ['比赛（锦标赛）管理']),
          el('div', { class: 'subtitle' }, ['可创建、编辑、删除多个比赛。每个比赛独立管理级别与数据。']),
        ]),
        el('button', { class: 'btn primary', onclick: () => addTournamentFlow() }, ['新建比赛']),
      ]),
      el('div', { class: 'card-bd' }, [
        state.tournaments.length
          ? el('div', { class: 'list' }, state.tournaments
              .slice()
              .sort((a, b) => b.createdAt - a.createdAt)
              .map((t) => renderTournamentCard(t)))
          : el('div', { class: 'muted' }, ['暂无比赛。点击右上角“新建比赛”。']),
      ]),
    ]);

    const right = el('div', { class: 'card' }, [
      el('div', { class: 'card-hd' }, [
        el('div', {}, [
          el('div', { class: 'title' }, ['使用说明（快速开始）']),
          el('div', { class: 'subtitle' }, ['完全离线，自动保存到 localStorage；URL 加 ?reset=1 可重置。']),
        ]),
      ]),
      el('div', { class: 'card-bd' }, [
        el('div', { class: 'kpi' }, [
          kpi('已创建比赛', String(state.tournaments.length)),
          kpi('数据持久化', 'localStorage'),
          kpi('赛制', '双败淘汰'),
          kpi('拼音', 'pinyin-pro'),
        ]),
        el('div', { class: 'hr' }),
        el('div', { class: 'muted' }, [
          '提示：如果你的浏览器禁用了第三方 CDN，拼音会暂时显示为空，但比赛逻辑不受影响。',
        ]),
      ]),
    ]);

    wrap.appendChild(left);
    wrap.appendChild(right);
    appRoot.appendChild(wrap);
  }

  function kpi(k, v) {
    return el('div', {}, [
      el('div', { class: 'k' }, [k]),
      el('div', { class: 'v' }, [v]),
    ]);
  }

  function renderTournamentCard(t) {
    const levelCount = t.levels.length;
    return el('div', { class: 'list-item clickable', onclick: () => setRoute({ name: 'tournament', tournamentId: t.id }) }, [
      el('div', { class: 'stack' }, [
        el('div', { class: 'name' }, [t.name]),
        el('div', { class: 'py muted' }, [`级别数：${levelCount}`]),
      ]),
      el('div', { class: 'row' }, [
        el('button', {
          class: 'btn small',
          onclick: (e) => {
            e.stopPropagation();
            editTournamentNameFlow(t.id);
          },
        }, ['编辑']),
        el('button', {
          class: 'btn small danger',
          onclick: (e) => {
            e.stopPropagation();
            deleteTournamentFlow(t.id);
          },
        }, ['删除']),
      ]),
    ]);
  }

  function addTournamentFlow() {
    const name = prompt('请输入比赛名称（例如：2026 春季锦标赛）', '新建比赛');
    if (name === null) return;
    state.tournaments.push(createTournament(name));
    saveState();
    render();
  }

  function editTournamentNameFlow(tournamentId) {
    const t = state.tournaments.find((x) => x.id === tournamentId);
    if (!t) return;
    const name = prompt('修改比赛名称', t.name);
    if (name === null) return;
    t.name = (name || '').trim() || t.name;
    saveState();
    render();
  }

  function deleteTournamentFlow(tournamentId) {
    const t = state.tournaments.find((x) => x.id === tournamentId);
    if (!t) return;
    if (!confirm(`确定删除比赛“${t.name}”及其所有级别数据？此操作不可撤销。`)) return;
    state.tournaments = state.tournaments.filter((x) => x.id !== tournamentId);
    saveState();
    render();
  }

  // ---------------------------
  // 导入/导出
  // ---------------------------
  function openImportExportModal() {
    const body = document.createElement('div');
    body.innerHTML = `
      <div class="subtitle">导出会包含所有比赛/级别/选手/比赛历史。导入会覆盖本地数据。</div>
      <div class="hr"></div>
      <div class="field">
        <label>JSON</label>
        <textarea class="input mono" id="jsonArea" placeholder="点击“导出”生成，或粘贴 JSON 后点击“导入”"></textarea>
      </div>
      <div class="hint" style="margin-top:10px;">建议比赛现场定期导出备份。</div>
    `;

    const ft = document.createElement('div');
    const exp = document.createElement('button');
    exp.className = 'btn primary';
    exp.textContent = '导出';
    exp.onclick = () => {
      body.querySelector('#jsonArea').value = JSON.stringify(state, null, 2);
      toast('已生成导出 JSON');
    };
    const imp = document.createElement('button');
    imp.className = 'btn ok';
    imp.textContent = '导入（覆盖）';
    imp.onclick = () => {
      const txt = body.querySelector('#jsonArea').value.trim();
      const parsed = safeJsonParse(txt);
      if (!parsed || parsed.version !== 1) {
        alert('JSON 格式不正确或版本不匹配。');
        return;
      }
      if (!confirm('导入会覆盖本地全部数据，确定继续？')) return;
      state = parsed;
      saveState();
      closeModal();
      toast('导入成功');
      render();
    };
    const close = document.createElement('button');
    close.className = 'btn';
    close.textContent = '关闭';
    close.onclick = closeModal;
    ft.appendChild(close);
    ft.appendChild(exp);
    ft.appendChild(imp);
    openModal({ title: '导入/导出数据', bodyEl: body, footerEl: ft });
  }

  // ---------------------------
  // 页面：比赛内（级别管理 + 分组显示 + 多级别同时开始）
  // ---------------------------
  function renderTournament(tournamentId) {
    const t = state.tournaments.find((x) => x.id === tournamentId);
    if (!t) return setRoute({ name: 'home' });

    const header = el('div', { class: 'card' }, [
      el('div', { class: 'card-hd' }, [
        el('div', {}, [
          el('div', { class: 'title' }, [t.name]),
          el('div', { class: 'subtitle' }, ['级别按“左/右”关键字分组显示；新增级别会先问左右手再输入体重。']),
        ]),
        el('div', { class: 'row' }, [
          el('button', { class: 'btn', onclick: () => editTournamentNameFlow(t.id) }, ['修改比赛名']),
          el('button', { class: 'btn primary', onclick: () => addLevelFlow(t.id) }, ['新增级别']),
        ]),
      ]),
      el('div', { class: 'card-bd' }, [
        el('div', { class: 'kpi' }, [
          kpi('级别数', String(t.levels.length)),
          kpi('左手级别', String(t.levels.filter((l) => l.name.includes('左')).length)),
          kpi('右手级别', String(t.levels.filter((l) => l.name.includes('右')).length)),
          kpi('其他', String(t.levels.filter((l) => !l.name.includes('左') && !l.name.includes('右')).length)),
        ]),
      ]),
    ]);

    const grouped = groupLevels(t.levels);

    const listCard = el('div', { class: 'card' }, [
      el('div', { class: 'card-hd' }, [
        el('div', {}, [
          el('div', { class: 'title' }, ['级别列表']),
          el('div', { class: 'subtitle' }, ['点击卡片任意位置进入级别；可勾选多个级别开启“多级别同时开始”（每个级别固定 1 张桌子）。']),
        ]),
        el('div', { class: 'row' }, [
          el('button', {
            class: 'btn ok',
            onclick: () => {
              openMultiLevelSelectorModal(t.id);
            },
          }, ['多级别同时开始']),
        ]),
      ]),
      el('div', { class: 'card-bd' }, [
        renderLevelGroup('左手组', grouped.left, t.id),
        renderLevelGroup('右手组', grouped.right, t.id),
        renderLevelGroup('其他组', grouped.other, t.id),
      ]),
    ]);

    appRoot.appendChild(el('div', { class: 'grid' }, [header, listCard]));
  }

  function groupLevels(levels) {
    const left = [];
    const right = [];
    const other = [];
    for (const l of levels) {
      if (l.name.includes('左')) left.push(l);
      else if (l.name.includes('右')) right.push(l);
      else other.push(l);
    }
    const sort = (a, b) => b.createdAt - a.createdAt;
    return { left: left.sort(sort), right: right.sort(sort), other: other.sort(sort) };
  }

  function renderLevelGroup(title, levels, tournamentId) {
    const quickHand = title.includes('左') ? '左手' : title.includes('右') ? '右手' : null;
    const block = el('div', {}, [
      el('div', { class: 'row between', style: 'margin-bottom:10px;margin-top:8px;' }, [
        el('div', { class: 'row' }, [
          el('div', { class: 'title' }, [title]),
          quickHand ? el('button', {
            class: 'btn small primary',
            onclick: () => addLevelQuickFlow(tournamentId, quickHand),
          }, ['添加级别']) : null,
        ]),
        el('span', { class: 'badge' }, [`${levels.length} 个`]),
      ]),
    ]);
    if (!levels.length) {
      block.appendChild(el('div', { class: 'muted', style: 'margin-bottom:8px;' }, ['暂无']));
      return block;
    }
    const grid = el('div', { class: 'grid cols-2' }, levels.map((l) => renderLevelCard(l, tournamentId)));
    block.appendChild(grid);
    block.appendChild(el('div', { class: 'hr' }));
    return block;
  }

  function addLevelQuickFlow(tournamentId, handLabel) {
    const t = state.tournaments.find((x) => x.id === tournamentId);
    if (!t) return;
    // 只做最少步骤：直接输入名称（可为空）
    const name = prompt(`新增${handLabel}级别：请输入名称（可留空）`, '');
    if (name === null) return;
    const finalName = (name || '').trim() || '未命名级别';
    const level = createLevel({ name: `${handLabel}${finalName === '未命名级别' ? '' : finalName}`, maxTables: 3 });
    t.levels.push(level);
    saveState();
    render();
    toast(`已新增：${level.name}`);
  }

  function renderLevelCard(level, tournamentId) {
    const alive = alivePlayers(level).length;
    const tableWant = computeTableCount(level);
    const startedBadge = level.started ? (level.finished ? el('span', { class: 'badge ok' }, ['已结束']) : el('span', { class: 'badge warn' }, ['进行中'])) : el('span', { class: 'badge' }, ['未开始']);
    return el('div', {
      class: 'card clickable',
      onclick: () => setRoute({ name: 'level', tournamentId, levelId: level.id }),
    }, [
      el('div', { class: 'card-hd' }, [
        el('div', {}, [
          el('div', { class: 'title' }, [level.name]),
          el('div', { class: 'subtitle' }, [
            `存活：${alive}｜桌子上限：${level.maxTables}｜自动桌子：${tableWant}`,
          ]),
        ]),
        el('div', { class: 'row' }, [startedBadge]),
      ]),
      el('div', { class: 'card-bd' }, [
        el('div', { class: 'row between' }, [
          el('div', { class: 'muted' }, [level.started ? (level.finished ? '比赛已结束' : '比赛进行中') : '尚未开始，可添加/删除选手']),
          el('div', { class: 'row' }, [
            el('button', {
              class: 'btn small',
              onclick: (e) => {
                e.stopPropagation();
                editLevelFlow(tournamentId, level.id);
              },
            }, ['编辑']),
            el('button', {
              class: 'btn small danger',
              onclick: (e) => {
                e.stopPropagation();
                deleteLevelFlow(tournamentId, level.id);
              },
            }, ['删除']),
          ]),
        ]),
      ]),
    ]);
  }

  function openMultiLevelSelectorModal(tournamentId) {
    const t = state.tournaments.find((x) => x.id === tournamentId);
    if (!t) return;
    const remembered = state.ui?.multiLevelSelection?.[tournamentId] || [];
    const selection = new Set(remembered);

    const body = document.createElement('div');
    body.appendChild(el('div', { class: 'subtitle' }, ['请选择要同时进行的级别（每个级别固定 1 张桌子）。']));
    body.appendChild(el('div', { class: 'hr' }));

    const list = el('div', { class: 'list' }, t.levels.slice().sort((a, b) => b.createdAt - a.createdAt).map((lvl) => {
      const cb = el('input', { type: 'checkbox' });
      if (selection.has(lvl.id)) cb.checked = true;
      cb.addEventListener('click', (e) => e.stopPropagation());
      cb.addEventListener('change', () => {
        if (cb.checked) selection.add(lvl.id);
        else selection.delete(lvl.id);
      });

      const row = el('div', {
        class: 'list-item clickable',
        onclick: () => {
          cb.checked = !cb.checked;
          if (cb.checked) selection.add(lvl.id);
          else selection.delete(lvl.id);
        },
      }, [
        el('div', { class: 'stack' }, [
          el('div', { class: 'name' }, [lvl.name]),
          el('div', { class: 'py muted' }, [`选手：${Object.keys(lvl.players || {}).length}｜状态：${lvl.finished ? '已结束' : lvl.started ? '进行中' : '未开始'}`]),
        ]),
        cb,
      ]);
      return row;
    }));
    body.appendChild(list);

    const ft = document.createElement('div');
    const cancel = document.createElement('button');
    cancel.className = 'btn';
    cancel.textContent = '取消';
    cancel.onclick = closeModal;
    const go = document.createElement('button');
    go.className = 'btn ok';
    go.textContent = '进入多级别模式';
    go.onclick = () => {
      const ids = Array.from(selection);
      if (ids.length < 2) return toast('请至少选择 2 个级别');
      state.ui.multiLevelSelection ||= {};
      state.ui.multiLevelSelection[tournamentId] = ids;
      saveState();
      closeModal();
      setRoute({ name: 'multilevel', tournamentId, levelIds: ids });
    };
    ft.appendChild(cancel);
    ft.appendChild(go);
    openModal({ title: '选择级别（多级别同时开始）', bodyEl: body, footerEl: ft });
  }

  function addLevelFlow(tournamentId) {
    const t = state.tournaments.find((x) => x.id === tournamentId);
    if (!t) return;
    const type = prompt('新增级别：请输入类型（左手/右手）。也可输入“左/右”。', '左手');
    if (type === null) return;
    const isLeft = String(type).includes('左');
    const isRight = String(type).includes('右');
    const hand = isLeft ? '左手' : isRight ? '右手' : '其他';
    const weight = prompt('请输入体重数字（例如 65）', '65');
    if (weight === null) return;
    const w = String(weight).replace(/[^\d]/g, '');
    const rec = hand === '其他' ? `${w || ''}kg` : `${hand}${w || ''}kg`;
    const name = prompt('确认/修改级别名称', rec || '未命名级别');
    if (name === null) return;
    const maxTables = prompt('该级别桌子数量上限（1~3）', '3');
    const level = createLevel({ name, maxTables });
    t.levels.push(level);
    saveState();
    render();
  }

  function editLevelFlow(tournamentId, levelId) {
    const { level } = getLevel(tournamentId, levelId);
    if (!level) return;
    const name = prompt('修改级别名称', level.name);
    if (name !== null) level.name = (name || '').trim() || level.name;
    const maxTables = prompt('桌子数量上限（1~3）', String(level.maxTables));
    if (maxTables !== null) level.maxTables = clampInt(maxTables, 1, 3);
    saveState();
    render();
  }

  function deleteLevelFlow(tournamentId, levelId) {
    const { tournament, level } = getLevel(tournamentId, levelId);
    if (!tournament || !level) return;
    if (!confirm(`确定删除级别“${level.name}”？此操作不可撤销。`)) return;
    tournament.levels = tournament.levels.filter((l) => l.id !== levelId);
    saveState();
    render();
  }

  function getLevel(tournamentId, levelId) {
    const tournament = state.tournaments.find((x) => x.id === tournamentId);
    const level = tournament?.levels.find((l) => l.id === levelId);
    return { tournament, level };
  }

  // ---------------------------
  // 页面：多级别同时进行（每个级别固定 1 桌）
  // ---------------------------
  function renderMultiLevel(tournamentId, levelIds) {
    const t = state.tournaments.find((x) => x.id === tournamentId);
    if (!t) return setRoute({ name: 'home' });
    const levels = (levelIds || []).map((id) => t.levels.find((l) => l.id === id)).filter(Boolean);
    if (levels.length < 2) return setRoute({ name: 'tournament', tournamentId });

    const header = el('div', { class: 'card' }, [
      el('div', { class: 'card-hd' }, [
        el('div', {}, [
          el('div', { class: 'title' }, ['多级别同时开始（综合视图）']),
          el('div', { class: 'subtitle' }, ['每个级别固定 1 张桌子，左右分屏（移动端自动纵向）。']),
        ]),
        el('div', { class: 'row' }, [
          el('button', { class: 'btn', onclick: () => setRoute({ name: 'tournament', tournamentId }) }, ['返回级别列表']),
        ]),
      ]),
    ]);

    const grid = el('div', { class: 'grid cols-2' }, levels.map((lvl) => renderMiniLevelPanel(t.id, lvl.id)));
    appRoot.appendChild(el('div', { class: 'grid' }, [header, grid]));
  }

  function renderMiniLevelPanel(tournamentId, levelId) {
    const { level } = getLevel(tournamentId, levelId);
    if (!level) return el('div', {}, []);
    // 固定 1 桌
    level.maxTables = Math.max(level.maxTables, 1);
    if (!level.tables.length) level.tables = [{ tableNo: 1, match: null, undo: [] }];
    if (level.tables.length !== 1) level.tables = level.tables.slice(0, 1);

    if (level.started && !level.finished) {
      generateMatchesIfNeeded(level);
      fillTables(level);
    }

    const alive = alivePlayers(level).length;
    const body = el('div', { class: 'card' }, [
      el('div', { class: 'card-hd' }, [
        el('div', {}, [
          el('div', { class: 'title' }, [level.name]),
          el('div', { class: 'subtitle' }, [`存活：${alive}｜待赛：${level.pendingMatches.length}｜历史：${level.history.length}`]),
        ]),
        el('div', { class: 'row' }, [
          el('button', { class: 'btn small', onclick: () => openPlayerListModal(level) }, ['选手']),
          el('button', { class: 'btn small', onclick: () => openRankingModal(level) }, ['名次']),
          el('button', { class: 'btn small', onclick: () => openHistoryModal(level) }, ['历史']),
          el('button', {
            class: 'btn small primary',
            onclick: () => {
              // 让“稍后再记”后仍可随时打开决赛面板
              if (level.grandFinal && !level.grandFinal.completed) showGrandFinalModal(level);
              else toast('未进入总决赛');
            },
          }, ['决赛']),
          el('button', { class: 'btn small primary', onclick: () => setRoute({ name: 'level', tournamentId, levelId }) }, ['进入']),
        ]),
      ]),
      el('div', { class: 'card-bd' }, [
        renderTable(level, 1, { compact: true }),
        el('div', { class: 'hr' }),
        el('div', { class: 'row' }, [
          el('button', {
            class: 'btn ok block',
            onclick: () => {
              if (!level.started) startLevel(level);
              saveState();
              render();
            },
          }, [level.started ? '补充对阵' : '开始比赛（1桌）']),
        ]),
      ]),
    ]);
    return body;
  }

  // ---------------------------
  // 页面：级别比赛管理（选手、桌子、排名、历史）
  // ---------------------------
  function renderLevel(tournamentId, levelId) {
    const { tournament, level } = getLevel(tournamentId, levelId);
    if (!tournament || !level) return setRoute({ name: 'home' });

    if (level.started && !level.finished) {
      generateMatchesIfNeeded(level);
      fillTables(level);
      finalizeIfDone(level);
    }

    const wrap = el('div', { class: 'grid' }, []);
    wrap.appendChild(renderLevelHeader(tournamentId, tournament, level));
    wrap.appendChild(renderLevelBody(tournamentId, tournament, level));
    appRoot.appendChild(wrap);
  }

  function renderLevelHeader(tournamentId, tournament, level) {
    const alive = alivePlayers(level).length;
    const total = Object.keys(level.players).length;
    const done = level.history.length;
    const pending = level.pendingMatches.length + level.tables.filter((t) => t.match).length;
    const denom = Math.max(1, done + pending);
    const pct = Math.round((done / denom) * 100);

    const bar = el('div', { class: 'progress' }, [el('div', { style: `width:${pct}%` }, [])]);

    const titleRow = el('div', { class: 'row between' }, [
      el('div', {}, [
        el('div', { class: 'row', style: 'align-items:center;' }, [
          el('div', { class: 'title' }, [level.name]),
          el('button', {
            class: 'btn small ghost',
            title: '修改级别名称',
            onclick: () => {
              const name = prompt('修改级别名称', level.name);
              if (name === null) return;
              level.name = (name || '').trim() || level.name;
              saveState();
              render();
            },
          }, ['✎']),
        ]),
        el('div', { class: 'subtitle' }, [`比赛：${tournament.name}`]),
      ]),
      el('div', { class: 'row' }, [
        el('span', { class: `badge ${level.finished ? 'ok' : level.started ? 'warn' : ''}` }, [level.finished ? '已结束' : level.started ? '进行中' : '未开始']),
        el('button', { class: 'btn small', onclick: () => setRoute({ name: 'tournament', tournamentId }) }, ['返回级别列表']),
      ]),
    ]);

    const actionRow = el('div', { class: 'row', style: 'margin-top:12px;' }, [
      el('button', {
        class: 'btn ok',
        onclick: () => {
          if (!level.started) startLevel(level);
          else {
            generateMatchesIfNeeded(level);
            fillTables(level);
          }
          saveState();
          render();
        },
      }, [level.started ? '补充对阵' : '开始比赛']),
      el('button', {
        class: 'btn',
        onclick: () => openPlayerListModal(level),
      }, ['选手列表']),
      el('button', {
        class: 'btn',
        onclick: () => openRankingModal(level),
      }, ['实时名次']),
      el('button', {
        class: 'btn',
        onclick: () => {
          if (!level.started) {
            toast('尚未开始，无需撤回');
            return;
          }
          if (undoLast(level, 'global')) {
            saveState();
            render();
          }
        },
      }, ['全局撤回']),
      el('button', {
        class: 'btn',
        onclick: () => openHistoryModal(level),
      }, ['比赛历史']),
      el('button', {
        class: 'btn danger',
        onclick: () => {
          if (!confirm('确定清空本级别所有选手与比赛记录？')) return;
          // 不能重置 level.id，否则当前路由会找不到级别导致跳回主界面
          const keep = { id: level.id, name: level.name, maxTables: level.maxTables, createdAt: level.createdAt };
          const fresh = createLevel({ name: keep.name, maxTables: keep.maxTables });
          Object.assign(level, fresh, keep);
          saveState();
          render();
        },
      }, ['清空本级别数据']),
      el('button', {
        class: 'btn primary',
        onclick: () => {
          if (level.grandFinal && !level.grandFinal.completed) showGrandFinalModal(level);
          else toast('当前未进入总决赛');
        },
      }, ['总决赛面板']),
    ]);

    return el('div', { class: 'card' }, [
      el('div', { class: 'card-bd' }, [
        titleRow,
        el('div', { class: 'hr' }),
        el('div', { class: 'kpi' }, [
          kpi('选手总数', String(total)),
          kpi('存活人数', String(alive)),
          kpi('已完成场次', String(done)),
          kpi('进度（动态）', `${pct}%`),
        ]),
        el('div', { style: 'margin-top:10px;' }, [bar]),
        actionRow,
      ]),
    ]);
  }

  function renderLevelBody(tournamentId, tournament, level) {
    const left = renderPlayerSidebar(level);
    const right = renderArena(level);
    return el('div', { class: 'split' }, [left, right]);
  }

  function renderPlayerSidebar(level) {
    const alive = alivePlayers(level);
    const eliminated = Object.values(level.players).filter((p) => p.losses >= 2);
    computePlacements(level);
    const total = Object.keys(level.players).length;
    // “从最后一名慢慢排到第一名”：先显示已决出的名次（大号名次在前），未决出的放后面并标注
    const topList = Object.values(level.players)
      .slice()
      .filter((p) => p.name)
      .sort((a, b) => {
        const ap = a.placement;
        const bp = b.placement;
        const aKnown = Number.isFinite(ap);
        const bKnown = Number.isFinite(bp);
        if (aKnown && bKnown) return bp - ap; // 先显示名次更低（数字更大）的人
        if (aKnown) return -1;
        if (bKnown) return 1;
        // 未决出：按负场多的靠前，再按名字
        if (b.losses !== a.losses) return b.losses - a.losses;
        return a.name.localeCompare(b.name, 'zh');
      });

    const addBox = el('div', { class: 'card' }, [
      el('div', { class: 'card-hd' }, [
        el('div', {}, [
          el('div', { class: 'title' }, ['选手管理']),
          el('div', { class: 'subtitle' }, ['支持批量添加（换行/中英文逗号分隔），自动去重（忽略大小写和首尾空格）。']),
        ]),
      ]),
      el('div', { class: 'card-bd' }, [
        el('div', { class: 'field' }, [
          el('label', {}, ['批量添加选手']),
          (() => {
            const ta = el('textarea', { class: 'input', placeholder: '例如：\n张三\n李四, Wang Wu，Zhao Liu' });
            const btnRow = el('div', { class: 'row', style: 'margin-top:10px;' }, [
              el('button', {
                class: 'btn primary',
                onclick: () => {
                  if (level.started) return toast('比赛开始后不可添加选手');
                  const text = ta.value;
                  const { added, dupes } = batchAddPlayers(level, text);
                  if (dupes.length) toast(`已忽略重复：${dupes.join('、')}`);
                  toast(`已添加 ${added} 名选手`);
                  ta.value = '';
                  saveState();
                  render();
                },
              }, ['添加']),
              el('button', {
                class: 'btn',
                onclick: () => {
                  if (level.started) return toast('比赛开始后不可抽签');
                  level.playerOrder = shuffle(level.playerOrder);
                  toast('已随机抽签（打乱种子位）');
                  saveState();
                  render();
                },
              }, ['随机抽签']),
            ]);
            const box = el('div', {}, [ta, btnRow]);
            return box;
          })(),
        ]),
      ]),
    ]);

    // 左侧默认仅保留“选手管理”（更适合现场），列表/名次通过按钮弹窗查看
    const summary = el('div', { class: 'card' }, [
      el('div', { class: 'card-hd' }, [
        el('div', {}, [
          el('div', { class: 'title' }, ['当前状态']),
          el('div', { class: 'subtitle' }, [`总人数 ${total}｜存活 ${alive.length}｜淘汰 ${eliminated.length}`]),
        ]),
      ]),
      el('div', { class: 'card-bd' }, [
        level.started
          ? el('div', { class: 'list' }, topList.slice(0, 8).map((p) => renderRankRow(level, p)))
          : el('div', { class: 'muted' }, ['比赛未开始：此处不显示未决出名次。请在上方添加选手并随机抽签后开始比赛。']),
      ]),
    ]);

    return el('div', { class: 'grid' }, [addBox, summary]);
  }

  function renderPlayerRow(level, p) {
    const lossText = `${Math.min(2, p.losses)}/2`;
    const eliminated = p.losses >= 2;
    const badgeCls = eliminated ? 'danger' : p.losses === 1 ? 'warn' : 'ok';
    return el('div', { class: 'list-item' }, [
      el('div', { class: 'stack' }, [
        el('div', { class: 'name' }, [p.name]),
        el('div', { class: 'py' }, [p.pinyin || '']),
      ]),
      el('div', { class: 'row' }, [
        el('button', {
          class: 'btn small',
          onclick: () => {
            const next = prompt('修改选手姓名', p.name);
            if (next === null) return;
            p.name = (next || '').trim() || p.name;
            p.pinyin = getPinyin(p.name);
            saveState();
            render();
          },
        }, ['修改']),
        el('button', {
          class: `btn small danger`,
          onclick: () => {
            if (level.started) return toast('比赛开始后不可删除选手');
            if (!confirm(`确定删除选手“${p.name}”？`)) return;
            deletePlayer(level, p.id);
            saveState();
            render();
          },
        }, ['删除']),
        el('span', { class: `badge ${badgeCls}` }, [eliminated ? `淘汰｜${lossText}` : `负场｜${lossText}`]),
      ]),
    ]);
  }

  function renderRankRow(level, p) {
    const medal = level.finished
      ? p.placement === 1 ? '🥇' : p.placement === 2 ? '🥈' : p.placement === 3 ? '🥉' : ''
      : '';
    const placeText = Number.isFinite(p.placement) ? `#${p.placement}` : '未决出名次';
    return el('div', { class: 'list-item' }, [
      el('div', { class: 'stack' }, [
        el('div', { class: 'name' }, [`${placeText} ${medal} ${p.name}`]),
        el('div', { class: 'py' }, [p.pinyin || '']),
      ]),
      el('span', { class: `badge ${p.losses >= 2 ? 'danger' : p.losses === 1 ? 'warn' : 'ok'}` }, [`${Math.min(2, p.losses)}/2`]),
    ]);
  }

  function openPlayerListModal(level) {
    const body = document.createElement('div');
    const alive = alivePlayers(level).length;
    const eliminated = Object.values(level.players).filter((p) => p.losses >= 2).length;
    const listEl = el('div', { class: 'list' }, Object.values(level.players)
      .slice()
      .sort((a, b) => (level.playerOrder.indexOf(a.id) - level.playerOrder.indexOf(b.id)))
      .map((p) => renderPlayerRow(level, p)));
    body.appendChild(el('div', { class: 'subtitle' }, [`存活 ${alive}｜淘汰 ${eliminated}`]));
    body.appendChild(el('div', { class: 'hr' }));
    body.appendChild(listEl);
    const ft = document.createElement('div');
    const close = document.createElement('button');
    close.className = 'btn';
    close.textContent = '关闭';
    close.onclick = closeModal;
    ft.appendChild(close);
    openModal({ title: '选手列表', bodyEl: body, footerEl: ft });
  }

  function openRankingModal(level) {
    computePlacements(level);
    const ps = Object.values(level.players).filter((p) => p.name);
    const total = ps.length;
    const byPlace = new Map();
    for (const p of ps) {
      if (Number.isFinite(p.placement)) byPlace.set(p.placement, p);
    }
    const body = document.createElement('div');
    body.appendChild(el('div', { class: 'subtitle' }, [
      level.finished
        ? '已结束：名次已全部决出（含金银铜牌）。'
        : `进行中：按“名次槽位”展示（第1名→第${total}名）。未决出的槽位会显示“未决出名次”。`,
    ]));
    body.appendChild(el('div', { class: 'hr' }));
    const rows = [];
    for (let place = 1; place <= total; place++) {
      const p = byPlace.get(place);
      if (p) {
        rows.push(renderRankRow(level, p));
      } else {
        rows.push(el('div', { class: 'list-item' }, [
          el('div', { class: 'stack' }, [
            el('div', { class: 'name' }, [`#${place} 未决出名次`]),
            el('div', { class: 'py' }, ['']),
          ]),
          el('span', { class: 'badge' }, ['—']),
        ]));
      }
    }
    body.appendChild(el('div', { class: 'list' }, rows));
    const ft = document.createElement('div');
    const close = document.createElement('button');
    close.className = 'btn';
    close.textContent = '关闭';
    close.onclick = closeModal;
    ft.appendChild(close);
    openModal({ title: '实时名次', bodyEl: body, footerEl: ft });
  }

  function renderArena(level) {
    const tableCount = level.started ? computeTableCount(level) : level.maxTables;
    // 确保 tables 数组存在但不超过上限（开始后由自动逻辑调整）
    if (!level.tables.length) {
      for (let i = 0; i < Math.min(tableCount, level.maxTables); i++) level.tables.push({ tableNo: i + 1, match: null, undo: [] });
    }

    const tablesCard = el('div', { class: 'card' }, [
      el('div', { class: 'card-hd' }, [
        el('div', {}, [
          el('div', { class: 'title' }, ['多桌并行比赛']),
          el('div', { class: 'subtitle' }, ['点击“获胜”只结算本桌；可为本桌撤回；空桌可手动分配对阵。']),
        ]),
        el('div', { class: 'row' }, [
          el('span', { class: 'badge' }, [`桌子上限：${level.maxTables}`]),
          el('span', { class: 'badge' }, [`当前桌子：${level.tables.length}`]),
        ]),
      ]),
      el('div', { class: 'card-bd' }, [
        el('div', { class: 'grid cols-2' }, level.tables.map((t) => renderTable(level, t.tableNo))),
      ]),
    ]);

    return el('div', { class: 'grid' }, [tablesCard]);
  }

  function renderTable(level, tableNo, opts = {}) {
    const t = level.tables.find((x) => x.tableNo === tableNo);
    const match = t?.match;
    const compact = !!opts.compact;
    computePlacements(level);
    const champ = Object.values(level.players).find((p) => p.placement === 1);
    const card = el('div', { class: 'card', style: compact ? 'box-shadow:none;' : '' }, [
      el('div', { class: 'card-hd' }, [
        el('div', {}, [
          el('div', { class: 'title' }, [`桌子 #${tableNo}`]),
          el('div', { class: 'subtitle' }, [match ? (match.bracket === 'W' ? '胜者组' : match.bracket === 'L' ? '败者组' : '比赛') : '空闲']),
        ]),
        el('div', { class: 'row' }, [
          el('button', {
            class: 'btn small',
            onclick: () => {
              if (!level.started) return toast('比赛开始后才能撤回');
              if (undoLast(level, `table:${tableNo}`)) {
                saveState();
                render();
              }
            },
          }, ['本桌撤回']),
        ]),
      ]),
      el('div', { class: 'card-bd' }, [
        match
          ? renderMatchPanel(level, tableNo, match)
          : level.finished && champ
            ? renderChampionPanel(champ)
            : renderManualAssign(level, tableNo),
      ]),
    ]);
    return card;
  }

  function renderChampionPanel(champ) {
    return el('div', {}, [
      el('div', { class: 'title' }, [`冠军：${champ.name}`]),
      el('div', { class: 'py' }, [champ.pinyin || '']),
      el('div', { class: 'hr' }),
      el('div', { class: 'hint' }, ['比赛已结束。']),
    ]);
  }

  function renderMatchPanel(level, tableNo, match) {
    const p1 = level.players[match.p1];
    const p2 = level.players[match.p2];
    const box = el('div', {}, [
      playerBox(p1),
      el('div', { class: 'hr' }),
      playerBox(p2),
      el('div', { class: 'hr' }),
      el('div', { class: 'row' }, [
        el('button', { class: 'btn ok block', onclick: () => { resolveMatch(level, tableNo, p1.id); saveState(); render(); } }, [`${p1.name} 获胜`]),
        el('button', { class: 'btn ok block', onclick: () => { resolveMatch(level, tableNo, p2.id); saveState(); render(); } }, [`${p2.name} 获胜`]),
      ]),
    ]);
    return box;
  }

  function playerBox(p) {
    return el('div', { class: 'stack' }, [
      el('div', { class: 'name' }, [p?.name || '']),
      el('div', { class: 'py' }, [p?.pinyin || '']),
      el('div', { class: 'row', style: 'margin-top:6px;' }, [
        el('span', { class: `badge ${p.losses >= 2 ? 'danger' : p.losses === 1 ? 'warn' : 'ok'}` }, [`负场 ${Math.min(2, p.losses)}/2`]),
        el('span', { class: 'badge' }, [p.bracket === 'W' ? '胜者组' : '败者组']),
      ]),
    ]);
  }

  function renderManualAssign(level, tableNo) {
    const alive = alivePlayers(level);
    const options = alive.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}（${p.bracket === 'W' ? '胜' : '败'}）</option>`).join('');
    const body = document.createElement('div');
    body.innerHTML = `
      <div class="subtitle">空闲桌子：可手动指定两名选手进行比赛（仅从存活选手中选择）。</div>
      <div class="hr"></div>
      <div class="grid cols-2">
        <div class="field">
          <label>选手 A</label>
          <select class="select" id="aSel"><option value="">请选择</option>${options}</select>
        </div>
        <div class="field">
          <label>选手 B</label>
          <select class="select" id="bSel"><option value="">请选择</option>${options}</select>
        </div>
      </div>
      <div class="field" style="margin-top:10px;">
        <label>组别</label>
        <select class="select" id="brSel">
          <option value="W">胜者组</option>
          <option value="L">败者组</option>
        </select>
      </div>
      <div class="hint" style="margin-top:10px;">注意：手动分配会按所选组别结算输家负场与组别流转。</div>
      <div style="margin-top:10px;">
        <button class="btn primary block" id="assignBtn">分配到本桌</button>
      </div>
    `;
    const btn = body.querySelector('#assignBtn');
    btn.onclick = () => {
      if (!level.started) return toast('请先开始比赛');
      const a = body.querySelector('#aSel').value;
      const b = body.querySelector('#bSel').value;
      const br = body.querySelector('#brSel').value;
      if (!a || !b || a === b) return toast('请选择两名不同选手');
      const pa = level.players[a];
      const pb = level.players[b];
      if (!pa || !pb) return;
      if (pa.losses >= 2 || pb.losses >= 2) return toast('淘汰选手不可参赛');
      // 简单校验：手动指定的组别会覆盖两名选手当前 bracket（避免误操作）
      pa.bracket = br;
      pb.bracket = br;
      const t = level.tables.find((x) => x.tableNo === tableNo);
      if (!t || t.match) return;
      t.match = { id: uid(), createdAt: now(), bracket: br, p1: a, p2: b, tableNo };
      saveState();
      render();
    };
    return body;
  }

  function openHistoryModal(level) {
    const body = document.createElement('div');
    const rows = level.history
      .slice()
      .sort((a, b) => b.at - a.at)
      .map((h) => {
        const w = level.players[h.winnerId]?.name || '';
        const l = level.players[h.loserId]?.name || '';
        const br = h.bracket === 'W' ? '胜者组' : h.bracket === 'L' ? '败者组' : '比赛';
        const dt = new Date(h.at).toLocaleString();
        return `<div class="list-item"><div class="stack"><div class="name">${escapeHtml(w)} 胜</div><div class="py">${escapeHtml(l)} 负</div></div><div class="stack" style="align-items:flex-end;"><div class="badge">${escapeHtml(br)}｜桌 #${h.tableNo}</div><div class="hint">${escapeHtml(dt)}</div></div></div>`;
      })
      .join('');
    body.innerHTML = `
      <div class="subtitle">记录每场比赛的时间、胜者、败者、组别、桌号。</div>
      <div class="hr"></div>
      <div class="list">${rows || '<div class="muted">暂无比赛记录</div>'}</div>
    `;
    const ft = document.createElement('div');
    const close = document.createElement('button');
    close.className = 'btn';
    close.textContent = '关闭';
    close.onclick = closeModal;
    ft.appendChild(close);
    openModal({ title: '比赛历史', bodyEl: body, footerEl: ft });
  }

  // ---------------------------
  // 选手操作
  // ---------------------------
  function batchAddPlayers(level, text) {
    const raw = String(text || '');
    const parts = raw
      .split(/[\n,，]+/g)
      .map((s) => s.trim())
      .filter(Boolean);
    const seenBatch = new Set();
    const existingKeys = new Set(Object.values(level.players).map((p) => normalizeNameKey(p.name)));
    const dupes = [];
    let added = 0;
    for (const name of parts) {
      const key = normalizeNameKey(name);
      if (seenBatch.has(key) || existingKeys.has(key)) {
        dupes.push(name);
        continue;
      }
      seenBatch.add(key);
      existingKeys.add(key);
      const p = createPlayer(name);
      level.players[p.id] = p;
      level.playerOrder.push(p.id);
      added++;
    }
    return { added, dupes };
  }

  function deletePlayer(level, playerId) {
    if (level.started) return;
    delete level.players[playerId];
    level.playerOrder = level.playerOrder.filter((id) => id !== playerId);
  }

  function startLevel(level) {
    const total = Object.keys(level.players).length;
    if (total < 2) return toast('至少需要 2 名选手才能开始');
    level.started = true;
    level.finished = false;
    level.banners = { top8Shown: false, top4Shown: false, gfShown: false };
    // 初始化桌子数量并清空队列/历史
    level.pendingMatches = [];
    level.history = [];
    level.undoStack = [];
    level.grandFinal = null;
    // 重置选手状态
    for (const p of Object.values(level.players)) {
      p.losses = 0;
      p.eliminatedAt = null;
      p.placement = null;
      p.bracket = 'W';
      if (!p.pinyin) p.pinyin = getPinyin(p.name);
    }
    computePlacements(level);
    const want = computeTableCount(level);
    level.tables = [];
    for (let i = 0; i < want; i++) level.tables.push({ tableNo: i + 1, match: null, undo: [] });

    // 首轮对阵：使用抽签顺序（如果未随机则按添加顺序）
    const seeds = level.playerOrder.slice();
    const pool = seeds.length ? seeds : Object.keys(level.players);
    // 首轮对阵使用“抽签后的顺序”作为种子位；不在开始时二次随机打乱
    const firstRound = pool.slice();
    if (firstRound.length % 2 === 1) {
      const byeIdx = Math.floor(Math.random() * firstRound.length);
      const byeId = firstRound.splice(byeIdx, 1)[0];
      const p = level.players[byeId];
      if (p) toast(`${p.name} 轮空直接晋级`);
    }
    for (let i = 0; i < firstRound.length; i += 2) {
      level.pendingMatches.push({ id: uid(), createdAt: now(), bracket: 'W', p1: firstRound[i], p2: firstRound[i + 1], tableNo: null });
    }
    fillTables(level);
    maybeShowStageBanners(level);
    toast('比赛已开始');
  }

  // ---------------------------
  // 初始化
  // ---------------------------
  let state = loadState();
  // 修复旧数据：确保 levels/tables 字段存在
  for (const t of state.tournaments) {
    t.levels ||= [];
    for (const l of t.levels) {
      l.players ||= {};
      l.playerOrder ||= [];
      l.pendingMatches ||= [];
      l.tables ||= [];
      l.history ||= [];
      l.undoStack ||= [];
      l.banners ||= { top8Shown: false, top4Shown: false, gfShown: false };
      if (l.maxTables == null) l.maxTables = 3;
    }
  }

  // 首次渲染
  render();

  // 自动保存兜底（部分浏览器可能拦截同步存储时机）
  window.addEventListener('beforeunload', saveState);
})();


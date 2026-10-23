// ==UserScript==
// @name         桃夭 · B站每日白嫖 & 经验
// @namespace    https://github.com/LHuiMeng/bili-daily-userscript
// @version      1.2.1
// @description  进 B 站自动做每日经验任务（登录/观看/分享/投币）、领大会员每日经验与每月权益、漫画签到、银瓜子换硬币、大会员积分签到。逐项可开关，全部走浏览器登录态，不碰密码。
// @author       LHuiMeng (毁梦)
// @match        https://www.bilibili.com/*
// @match        https://space.bilibili.com/*
// @match        https://t.bilibili.com/*
// @match        https://big.bilibili.com/*
// @updateURL    https://raw.githubusercontent.com/LHuiMeng/bili-daily-userscript/main/bili-daily.user.js
// @downloadURL  https://raw.githubusercontent.com/LHuiMeng/bili-daily-userscript/main/bili-daily.user.js
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      api.bilibili.com
// @connect      api.live.bilibili.com
// @connect      manga.bilibili.com
// @run-at       document-idle
// ==/UserScript==

/*
 * 接口出处（2026-10 实测，非猜测）：
 *   GET  /x/web-interface/nav                        登录态、mid、等级、硬币余额、大会员状态
 *   GET  /x/member/web/exp/reward                    每日任务完成情况 {login,watch,coins,share,...}
 *   GET  /x/web-interface/coin/today/exp             今日投币已获经验（上限 50）
 *   POST /x/click-interface/web/heartbeat            观看上报（aid/played_time 走 query）
 *   POST /x/web-interface/share/add                  分享视频
 *   POST /x/web-interface/coin/add                   投币
 *   GET  /x/web-interface/archive/coins              查自己是否已给该稿件投过币
 *   POST /x/vip/experience/add                       大会员每日 10 经验
 *   GET  /x/vip/privilege/my                         大会员卡券状态
 *   POST /x/vip/privilege/receive?type=&csrf=        大会员权益领取
 *   POST /twirp/activity.v1.Activity/ClockIn         漫画签到（manga.bilibili.com）
 *   GET  /xlive/revenue/v1/wallet/getStatus          直播钱包（银瓜子/剩余兑换次数）
 *   POST /xlive/revenue/v1/wallet/silver2coin        银瓜子换硬币
 *   GET  /xlive/web-ucenter/v1/sign/DoSign           直播签到（官方已下线，返回 code=1）
 *   POST /pgc/activity/score/task/sign2              大会员积分签到（Referer 必须是 big.bilibili.com）
 */

(function () {
  'use strict';

  /* ======================= 配置 ======================= */
  const CONFIG = {
    // 每日经验任务（合计 65 经验）
    watch: true,          // 观看视频 +5
    share: true,          // 分享视频 +5
    coin: true,           // 投币，每枚 +10，每日上限 50
    coinPerRun: 5,        // 单次最多投几枚
    keepCoins: 20,        // 硬币余额低于这个数就不投了
    selectLike: false,    // 投币时是否顺带点赞（会污染你的点赞列表，默认关）

    // 大会员
    vipExp: true,         // 大会员每日 10 经验
    vipPrivilege: true,   // 每月 B 币券 / 福利券
    bigPoint: true,       // 大会员积分签到（仅 big.bilibili.com 页面生效）

    // 其他白嫖
    manga: true,          // 漫画签到
    silver2coin: true,    // 银瓜子换硬币
    liveSign: true,       // 直播签到（官方已下线，留着只为某天复活）

    // 行为
    autoRun: true,        // 进页面自动跑
    autoRunDelay: 2500,   // 自动跑前的等待（毫秒）
    minDelay: 900,        // 请求间隔下限
    maxDelay: 1700,       // 请求间隔上限
    collapseAfter: 15000, // 跑完多久自动收成小条
  };

  const VERSION = '1.2.1';

  const API = 'https://api.bilibili.com';
  const LIVE = 'https://api.live.bilibili.com';
  const MANGA = 'https://manga.bilibili.com';

  const EXP = { login: 5, watch: 5, share: 5, coin: 10 };
  const COIN_EXP_CAP = 50;

  /* ======================= 小工具 ======================= */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
  const gap = () => sleep(rand(CONFIG.minDelay, CONFIG.maxDelay));
  const clip = (s, n = 22) => {
    s = String(s || '').replace(/\s+/g, ' ');
    return s.length > n ? s.slice(0, n) + '…' : s;
  };
  const todayKey = () => {
    const d = new Date();
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  const getCookie = (name) => {
    const m = document.cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : '';
  };

  /* ======================= 面板 ======================= */
  const UI = (() => {
    let host, root, bodyEl, headEl, tipEl, btnEl;
    const rows = new Map();

    function mount() {
      if (document.getElementById('ty-bili-daily-host')) {
        host = document.getElementById('ty-bili-daily-host');
        root = host.shadowRoot;
        bodyEl = root.querySelector('.rows');
        headEl = root.querySelector('.head');
        tipEl = root.querySelector('.tip');
        btnEl = root.querySelector('.rerun');
        return;
      }
      host = document.createElement('div');
      host.id = 'ty-bili-daily-host';
      host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;';
      root = host.attachShadow({ mode: 'open' });
      root.innerHTML = `
        <style>
          * { box-sizing: border-box; }
          .wrap {
            width: 316px; max-height: 62vh; display: flex; flex-direction: column;
            font: 12px/1.5 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
            color: #e9eef5; background: rgba(20, 22, 30, .92);
            border: 1px solid rgba(255,255,255,.10); border-radius: 14px;
            box-shadow: 0 12px 34px rgba(0,0,0,.45); backdrop-filter: blur(14px);
            overflow: hidden; transition: height .2s ease;
          }
          .head {
            display: flex; align-items: center; gap: 8px; padding: 10px 12px;
            cursor: pointer; user-select: none; border-bottom: 1px solid rgba(255,255,255,.07);
          }
          .title { font-weight: 600; font-size: 12.5px; letter-spacing: .2px; }
          .ver { font-weight: 400; font-size: 10.5px; color: #6d7788; margin-left: 2px; }
          .spark { color: #ff7a9c; }
          .count { margin-left: auto; color: #8b96a8; font-size: 11.5px; font-variant-numeric: tabular-nums; }
          .chev { color: #8b96a8; font-size: 11px; transition: transform .18s ease; }
          .wrap.min .chev { transform: rotate(-90deg); }
          .wrap.min .body, .wrap.min .foot { display: none; }
          .body { overflow: auto; padding: 6px 4px 4px; }
          .body::-webkit-scrollbar { width: 6px; }
          .body::-webkit-scrollbar-thumb { background: rgba(255,255,255,.14); border-radius: 3px; }
          .row { display: flex; gap: 8px; padding: 4px 9px; align-items: flex-start; }
          .row .ic { width: 14px; flex: none; text-align: center; font-size: 11px; margin-top: 1px; }
          .row .tx { flex: 1; min-width: 0; }
          .row .lb { color: #dfe6f0; }
          .row .dt { color: #8b96a8; font-size: 11px; word-break: break-all; }
          .st-run  .ic { color: #6ea8ff; }
          .st-ok   .ic { color: #45d19a; }
          .st-skip .ic { color: #77808f; }
          .st-warn .ic { color: #f0b23e; }
          .st-fail .ic { color: #ff6b81; }
          .foot {
            display: flex; align-items: center; gap: 8px; padding: 8px 10px;
            border-top: 1px solid rgba(255,255,255,.07);
          }
          .tip { color: #8b96a8; font-size: 11px; flex: 1; min-width: 0; }
          button {
            font: inherit; font-size: 11px; color: #cfd8e6; cursor: pointer;
            background: rgba(255,255,255,.07); border: 1px solid rgba(255,255,255,.10);
            border-radius: 8px; padding: 4px 9px;
          }
          button:hover { background: rgba(255,255,255,.13); }
          button:disabled { opacity: .45; cursor: default; }
        </style>
        <div class="wrap">
          <div class="head">
            <span class="spark">✦</span>
            <span class="title">桃夭 · B站每日 <span class="ver">v${VERSION}</span></span>
            <span class="count"></span>
            <span class="chev">▾</span>
          </div>
          <div class="body"><div class="rows"></div></div>
          <div class="foot">
            <span class="tip">准备中…</span>
            <button class="rerun">重跑</button>
          </div>
        </div>`;
      document.documentElement.appendChild(host);

      bodyEl = root.querySelector('.rows');
      headEl = root.querySelector('.head');
      tipEl = root.querySelector('.tip');
      btnEl = root.querySelector('.rerun');
      headEl.addEventListener('click', () => root.querySelector('.wrap').classList.toggle('min'));
      btnEl.addEventListener('click', () => {
        if (window.__tyBiliRun) window.__tyBiliRun(true);
      });
    }

    const ICON = { run: '◌', ok: '✓', skip: '–', warn: '!', fail: '✕' };

    function set(key, label, status, detail) {
      rows.set(key, { label, status, detail });
      render();
    }

    function render() {
      if (!bodyEl) return;
      let ok = 0, fail = 0, done = 0;
      const frag = document.createDocumentFragment();
      for (const [, r] of rows) {
        const el = document.createElement('div');
        el.className = 'row st-' + r.status;
        el.innerHTML = `<span class="ic">${ICON[r.status] || '·'}</span>
          <span class="tx"><div class="lb"></div><div class="dt"></div></span>`;
        el.querySelector('.lb').textContent = r.label;
        el.querySelector('.dt').textContent = r.detail || '';
        frag.appendChild(el);
        if (r.status === 'ok') ok++;
        else if (r.status === 'fail') fail++;
        if (r.status !== 'run') done++;
      }
      bodyEl.replaceChildren(frag);
      const c = root.querySelector('.count');
      if (c) c.textContent = ok ? `${ok} 项完成${fail ? ` · ${fail} 失败` : ''}` : '';
    }

    function tip(text) {
      if (tipEl) tipEl.textContent = text;
    }

    function busy(on) {
      if (btnEl) btnEl.disabled = !!on;
    }

    function collapseSoon() {
      setTimeout(() => {
        const w = root && root.querySelector('.wrap');
        if (w) w.classList.add('min');
      }, CONFIG.collapseAfter);
    }

    return { mount, set, tip, busy, collapseSoon, render };
  })();

  /* ======================= 网络层 ======================= */
  let lastErr = '';

  async function request(url, { method = 'GET', body = null, headers = {} } = {}) {
    const init = { method, credentials: 'include', headers: Object.assign({ Accept: 'application/json' }, headers) };
    let payload = null;
    if (body !== null) {
      payload = typeof body === 'string' ? body : new URLSearchParams(body).toString();
      init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      init.body = payload;
    }

    const parse = (text) => {
      try {
        return JSON.parse(text);
      } catch (e) {
        lastErr = '非 JSON 响应：' + String(text).slice(0, 80).replace(/\s+/g, ' ');
        return { code: -1, message: lastErr };
      }
    };

    try {
      const res = await fetch(url, init);
      return parse(await res.text());
    } catch (e) {
      // 跨域/网络被拦时退回 GM_xmlhttpRequest（仍带浏览器 cookie）
      if (typeof GM_xmlhttpRequest !== 'function') {
        lastErr = String(e && e.message || e);
        return { code: -1, message: 'fetch 失败：' + lastErr };
      }
      return await new Promise((resolve) => {
        GM_xmlhttpRequest({
          method,
          url,
          data: payload || undefined,
          headers: init.headers,
          timeout: 15000,
          onload: (r) => resolve(parse(r.responseText)),
          onerror: () => resolve({ code: -1, message: 'GM 请求失败' }),
          ontimeout: () => resolve({ code: -1, message: 'GM 请求超时' }),
        });
      });
    }
  }

  const api = (path, opt) => request(API + path, opt);
  const liveApi = (path, opt) => request(LIVE + path, opt);
  const mangaApi = (path, opt) => request(MANGA + path, opt);

  const getJson = (path, opt) => api(path, opt);
  const post = (path, body) => api(path, { method: 'POST', body });

  /* ======================= 账号状态 ======================= */
  const state = {
    mid: 0,
    csrf: '',
    name: '',
    level: 0,
    money: 0,
    vip: false,
    vipType: 0,
    expBefore: 0,
    expAfter: 0,
    levelBefore: 0,
  };

  async function loadAccount() {
    const nav = await getJson('/x/web-interface/nav');
    if (nav.code !== 0) {
      return { ok: false, reason: nav.code === -101 ? '未登录（先登录 B 站）' : `${nav.code} ${nav.message}` };
    }
    const d = nav.data || {};
    state.mid = d.mid || Number(getCookie('DedeUserID')) || 0;
    state.csrf = getCookie('bili_jct');
    state.name = d.uname || '';
    state.level = (d.level_info && d.level_info.current_level) || 0;
    state.expBefore = (d.level_info && d.level_info.current_exp) || 0;
    state.money = typeof d.money === 'number' ? d.money : 0;
    state.vip = !!(d.vipStatus === 1 || (d.vip && d.vip.status === 1));
    state.vipType = (d.vip && d.vip.type) || 0;
    if (!state.csrf) return { ok: false, reason: '拿不到 bili_jct（csrf），刷新一下页面' };
    return { ok: true };
  }

  async function getDailyStatus() {
    const r = await getJson('/x/member/web/exp/reward');
    if (r.code !== 0) throw new Error(`${r.code} ${r.message}`);
    return r.data || {};
  }

  /* ======================= 任务：观看 ======================= */
  async function pickVideo(exclude) {
    const r = await getJson('/x/web-interface/ranking/v2?rid=0&type=all');
    if (r.code !== 0) throw new Error(`排行榜 ${r.code} ${r.message}`);
    const list = ((r.data && r.data.list) || []).filter(
      (v) => v && v.aid && v.bvid && v.cid && !(exclude && exclude.has(v.aid))
    );
    if (!list.length) throw new Error('排行榜里没有可用视频');
    return list[rand(0, list.length - 1)];
  }

  // 真实客户端播放链路上报（参数取自仍在维护的客户端脚本 + API 文档，非猜测）
  async function heartbeat(v, played, { playType = 0, realtime = played, realPlayed = played } = {}) {
    const body = {
      aid: v.aid,
      bvid: v.bvid,
      cid: v.cid,
      mid: state.mid,
      csrf: state.csrf,
      played_time: played,
      realtime: realtime,
      real_played_time: realPlayed,
      start_ts: Math.floor(Date.now() / 1000),
      type: 3,
      dt: 2,
      play_type: playType,
      jsonp: 'jsonp',
    };
    return post(`/x/click-interface/web/heartbeat?aid=${v.aid}&played_time=${played}`, body);
  }

  async function taskWatch(status, cache) {
    if (!CONFIG.watch) return UI.set('watch', '观看视频', 'skip', '配置已关闭');
    if (status.watch) return UI.set('watch', '观看视频', 'skip', '今天已经看过');

    const v = cache.video || (await pickVideo());
    cache.video = v;
    const dur = Math.max(15, Math.min(Number(v.duration) || 60, 3600));
    const now = () => Math.floor(Date.now() / 1000);
    UI.set('watch', '观看视频', 'run', `看《${clip(v.title)}》（${dur}s）`);

    // 第 1 步：上报「进入视频页」。真实客户端第一步就是这个，只发心跳会被判无效。
    const click = await post('/x/click-interface/click/web/h5', {
      aid: v.aid,
      cid: v.cid,
      part: 1,
      ftime: now(),
      stime: now(),
      jsonp: 'jsonp',
      mid: state.mid,
      csrf: state.csrf,
    });
    await sleep(600);

    // 第 2 步：开始播放
    await heartbeat(v, 0, { playType: 1, realtime: dur, realPlayed: 0 });
    await sleep(5000);

    // 第 3 步：播放中，进度推到接近片尾
    await heartbeat(v, dur - 1, { playType: 0, realtime: dur, realPlayed: dur - 1 });

    let after = await getDailyStatus();
    if (after.watch) {
      return UI.set('watch', '观看视频', 'ok', `+${EXP.watch} 经验 · 播放链路生效 · 《${clip(v.title, 16)}》`);
    }

    // 第 4 步：兜底——写观看记录 + 完播心跳（played_time=-1 表示播放完成）
    await sleep(2000);
    await post('/x/v2/history/report', {
      aid: v.aid,
      cid: v.cid,
      progress: dur - 1,
      platform: 'android',
      csrf: state.csrf,
    });
    await heartbeat(v, -1, { playType: 4, realtime: dur, realPlayed: dur });
    await sleep(2500);

    after = await getDailyStatus();
    if (after.watch) return UI.set('watch', '观看视频', 'ok', `+${EXP.watch} 经验 · 观看记录生效`);
    UI.set(
      'watch',
      '观看视频',
      'warn',
      `点击上报 code ${click.code}，watch 仍是 false（B站可能又改了判定）`
    );
  }

  /* ======================= 任务：分享 ======================= */
  async function taskShare(status, cache) {
    if (!CONFIG.share) return UI.set('share', '分享视频', 'skip', '配置已关闭');
    if (status.share) return UI.set('share', '分享视频', 'skip', '今天已经分享过');

    const v = cache.video || (await pickVideo());
    cache.video = v;
    UI.set('share', '分享视频', 'run', `分享《${clip(v.title)}》`);

    const r = await post('/x/web-interface/share/add', {
      aid: v.aid,
      csrf: state.csrf,
      eab_x: 1,
      ramval: rand(3, 20),
      source: 'web_normal',
      ga: 1,
    });
    await gap();

    if (r.code === 0) {
      // 接口回 0 不代表经验到账，复查一次任务状态
      let ok = false;
      try {
        ok = (await getDailyStatus()).share === true;
      } catch (e) {
        /* 忽略 */
      }
      if (ok) UI.set('share', '分享视频', 'ok', `+${EXP.share} 经验`);
      else UI.set('share', '分享视频', 'warn', '接口回 0，但分享状态没变（经验可能没给）');
    } else if (r.code === -403) UI.set('share', '分享视频', 'warn', '被风控拒绝（-403），今天跳过，别硬刷');
    else UI.set('share', '分享视频', 'fail', `${r.code} ${r.message || ''}`);
  }

  /* ======================= 任务：投币 ======================= */
  async function taskCoin() {
    if (!CONFIG.coin) return UI.set('coin', '投币', 'skip', '配置已关闭');
    UI.set('coin', '投币', 'run', '查今日投币经验…');

    const e = await getJson('/x/web-interface/coin/today/exp');
    const got = e.code === 0 && typeof e.data === 'number' ? e.data : 0;
    const remain = Math.max(0, COIN_EXP_CAP - got);
    if (remain === 0) return UI.set('coin', '投币', 'skip', `今日投币经验已满 ${COIN_EXP_CAP}`);

    const need = Math.min(CONFIG.coinPerRun, Math.ceil(remain / EXP.coin));
    if (state.money - CONFIG.keepCoins < 1) {
      return UI.set('coin', '投币', 'skip', `硬币 ${state.money} 枚，低于保留线 ${CONFIG.keepCoins}`);
    }

    let ok = 0;
    let note = '';
    const used = new Set();
    for (let i = 0; i < need; i++) {
      if (state.money - CONFIG.keepCoins < 1) {
        note = '硬币到保留线，停手';
        break;
      }
      let v;
      try {
        v = await pickVideo(used);
      } catch (err) {
        note = String(err.message || err);
        break;
      }
      used.add(v.aid);

      const already = await getJson(`/x/web-interface/archive/coins?aid=${v.aid}&bvid=${v.bvid}`);
      if (already.code === 0 && already.data && Number(already.data.multiply) > 0) {
        continue;
      }

      const r = await post('/x/web-interface/coin/add', {
        aid: v.aid,
        multiply: 1,
        select_like: CONFIG.selectLike ? 1 : 0,
        cross_domain: 'true',
        csrf: state.csrf,
        eab_x: 2,
        ramval: 3,
        source: 'web_normal',
        ga: 1,
      });

      if (r.code === 0) {
        ok++;
        state.money -= 1;
      } else if ([34002, 34003, 34004, 34005, -400, 10003].includes(r.code)) {
        // 给自己投 / 间隔太短 / 超上限 / 稿件不存在：换下一个视频
        note = `${r.code} ${r.message || ''}`;
      } else {
        note = `${r.code} ${r.message || ''}`;
        break;
      }
      await gap();
    }

    if (ok) UI.set('coin', '投币', 'ok', `投了 ${ok} 枚，+${ok * EXP.coin} 经验${note ? `（${note}）` : ''}`);
    else UI.set('coin', '投币', 'warn', note || '一枚都没投出去');
  }

  /* ======================= 任务：大会员每日经验 ======================= */
  async function taskVipExp() {
    if (!CONFIG.vipExp) return UI.set('vipExp', '大会员每日经验', 'skip', '配置已关闭');
    if (!state.vip) return UI.set('vipExp', '大会员每日经验', 'skip', '不是大会员');

    UI.set('vipExp', '大会员每日经验', 'run', '领取中…');
    const r = await post('/x/vip/experience/add', { csrf: state.csrf });
    await gap();

    if (r.code === 0) UI.set('vipExp', '大会员每日经验', 'ok', '+10 经验');
    else if (r.code === 69198) UI.set('vipExp', '大会员每日经验', 'skip', '今天已经领过');
    else if (r.code === 235007) UI.set('vipExp', '大会员每日经验', 'skip', '大会员已过期');
    else if (r.code === 6034007) UI.set('vipExp', '大会员每日经验', 'warn', '请求太频繁，等会儿再试');
    else UI.set('vipExp', '大会员每日经验', 'fail', `${r.code} ${r.message || ''}`);
  }

  /* ======================= 任务：大会员每月权益 ======================= */
  async function taskVipPrivilege() {
    if (!CONFIG.vipPrivilege) return UI.set('vipPriv', '大会员权益', 'skip', '配置已关闭');
    if (!state.vip) return UI.set('vipPriv', '大会员权益', 'skip', '不是大会员');

    UI.set('vipPriv', '大会员权益', 'run', '查卡券…');
    const my = await getJson('/x/vip/privilege/my');
    if (my.code !== 0) return UI.set('vipPriv', '大会员权益', 'fail', `${my.code} ${my.message || ''}`);

    const list = (my.data && my.data.list) || [];
    const claimable = list.filter(
      (x) => x && [1, 2, 3, 4, 5, 6, 7].includes(Number(x.type)) && Number(x.state) === 0 && Number(x.next_receive_days) === 0
    );
    if (!claimable.length) return UI.set('vipPriv', '大会员权益', 'skip', '这个月该领的都领了');

    const got = [];
    for (const it of claimable) {
      const r = await post(`/x/vip/privilege/receive?type=${it.type}&csrf=${state.csrf}`, '');
      if (r.code === 0) got.push(`type${it.type}`);
      else if (r.code === -101) break;
      await gap();
    }
    if (got.length) UI.set('vipPriv', '大会员权益', 'ok', `领到 ${got.join('、')}`);
    else UI.set('vipPriv', '大会员权益', 'skip', '接口都回「已领过」');
  }

  /* ======================= 任务：漫画签到 ======================= */
  async function taskManga() {
    if (!CONFIG.manga) return UI.set('manga', '漫画签到', 'skip', '配置已关闭');
    UI.set('manga', '漫画签到', 'run', '签到中…');

    let r = await mangaApi(`/twirp/activity.v1.Activity/ClockIn?platform=android&uid=${state.mid}`, {
      method: 'POST',
      body: '',
    });
    if (r.code !== 0 && /uid/i.test(String(r.msg || r.message || ''))) {
      r = await mangaApi('/twirp/activity.v1.Activity/ClockIn?platform=android', { method: 'POST', body: '' });
    }
    await gap();

    const msg = String(r.msg || r.message || '');
    if (Number(r.code) === 0) UI.set('manga', '漫画签到', 'ok', '签到成功');
    else if (/已签到|重复|already|has sign/i.test(msg)) UI.set('manga', '漫画签到', 'skip', '今天已签过');
    else UI.set('manga', '漫画签到', 'warn', `${r.code} ${msg}`);
  }

  /* ======================= 任务：银瓜子换硬币 ======================= */
  async function taskSilver2Coin() {
    if (!CONFIG.silver2coin) return UI.set('silver', '银瓜子换硬币', 'skip', '配置已关闭');
    UI.set('silver', '银瓜子换硬币', 'run', '查钱包…');

    const st = await liveApi('/xlive/revenue/v1/wallet/getStatus');
    if (st.code !== 0) return UI.set('silver', '银瓜子换硬币', 'fail', `${st.code} ${st.message || ''}`);
    const d = st.data || {};
    const left = Number(d.silver_2_coin_left || 0);
    const silver = Number(d.silver || 0);
    if (left <= 0) return UI.set('silver', '银瓜子换硬币', 'skip', `今天次数用完了（银瓜子 ${silver}）`);
    // 700 银瓜子换 1 枚硬币（B站规则），不够就别发请求，省一次 403
    if (silver < 700) {
      return UI.set('silver', '银瓜子换硬币', 'skip', `银瓜子 ${silver}，要 700 才够换 1 枚`);
    }

    const visitId = String(rand(1, 9)) + Math.random().toString(36).slice(2, 12).toLowerCase() + '0';
    const r = await liveApi('/xlive/revenue/v1/wallet/silver2coin', {
      method: 'POST',
      body: { csrf: state.csrf, csrf_token: state.csrf, visit_id: visitId },
    });
    await gap();

    if (r.code === 0) {
      const coin = r.data && r.data.coin;
      UI.set('silver', '银瓜子换硬币', 'ok', `换到 ${coin != null ? coin : 1} 枚硬币`);
    } else if (r.code === -101) {
      UI.set('silver', '银瓜子换硬币', 'fail', '未登录');
    } else if (/余额不足/.test(String(r.message || ''))) {
      UI.set('silver', '银瓜子换硬币', 'skip', '银瓜子余额不足，明天再看');
    } else {
      UI.set('silver', '银瓜子换硬币', 'warn', `${r.code} ${r.message || ''}`);
    }
  }

  /* ======================= 任务：直播签到 ======================= */
  async function taskLiveSign() {
    if (!CONFIG.liveSign) return UI.set('liveSign', '直播签到', 'skip', '配置已关闭');
    UI.set('liveSign', '直播签到', 'run', '签到中…');
    const r = await liveApi('/xlive/web-ucenter/v1/sign/DoSign');
    await gap();

    const msg = String(r.message || '');
    if (r.code === 0) UI.set('liveSign', '直播签到', 'ok', msg || '签到成功');
    else if (/下线/.test(msg)) UI.set('liveSign', '直播签到', 'skip', '官方已下线');
    else UI.set('liveSign', '直播签到', 'warn', `${r.code} ${msg}`);
  }

  /* ======================= 借道执行：需要特定子域页面才能调的接口 ======================= */
  // 原理：在页面里挂一个隐藏 iframe 指向目标子域，脚本会在 iframe 里被注入（本脚本不再 @noframes），
  // 于是那次 fetch 的 Referer 天然就是目标子域，不用伪造、不用你手动切页面。
  // 实测：big.bilibili.com 无 X-Frame-Options / CSP frame-ancestors，也没有 frame-busting。
  const REMOTE_PARAM = 'tybili_task';
  const REMOTE_NONCE = 'tybili_nonce';
  const REMOTE_TIMEOUT = 15000;

  function parseRemoteCall() {
    const qs = new URLSearchParams(location.search);
    const task = qs.get(REMOTE_PARAM) || (location.hash.match(/tybili_task=([a-zA-Z]+)/) || [])[1];
    if (!task) return null;
    return { task, nonce: qs.get(REMOTE_NONCE) || (location.hash.match(/tybili_nonce=([a-z0-9]+)/) || [])[1] || '' };
  }

  // iframe 里的脚本走这条：只做被指派的那一件事，不挂面板、不抢锁
  async function runRemoteTask(call) {
    const out = { source: 'tyBili', task: call.task, nonce: call.nonce, ok: false, detail: '', ts: 0 };
    try {
      const acc = await loadAccount();
      if (!acc.ok) throw new Error(acc.reason);

      if (call.task === 'bigPoint') {
        const r = await post(
          `/pgc/activity/score/task/sign2?mobi_app=android&csrf=${state.csrf}&platform=android`,
          { device: 'phone', t: Date.now(), ts: Math.floor(Date.now() / 1000) }
        );
        if (r.code === 0 && r.data) {
          out.ok = true;
          out.detail = `+${r.data.score || 0} 积分 · 累计 ${r.data.count || 0}/${r.data.duration || 0} 天`;
        } else if (/-401|已签到|重复/.test(`${r.code}${r.message || ''}`)) {
          out.ok = true;
          out.detail = r.message || '今天已签';
        } else {
          out.detail = `${r.code} ${r.message || ''}`;
        }
      } else {
        out.detail = '未知任务 ' + call.task;
      }
    } catch (e) {
      out.detail = String((e && e.message) || e);
    }

    out.ts = Date.now();
    try {
      GM_setValue('tyBiliRemote:' + call.task, JSON.stringify(out));
    } catch (e) {
      /* 忽略 */
    }
    try {
      const target = window.parent && window.parent !== window ? window.parent : window;
      target.postMessage(out, '*');
    } catch (e) {
      /* 忽略 */
    }
  }

  function runInRemoteFrame(task, url, timeout = REMOTE_TIMEOUT) {
    return new Promise((resolve) => {
      const nonce = Math.random().toString(36).slice(2, 10);
      const frame = document.createElement('iframe');
      frame.setAttribute('aria-hidden', 'true');
      frame.style.cssText =
        'position:fixed;left:-9999px;top:0;width:380px;height:640px;opacity:0;border:0;pointer-events:none';
      frame.src = `${url}?${REMOTE_PARAM}=${task}&${REMOTE_NONCE}=${nonce}`;

      let done = false;
      const finish = (r) => {
        if (done) return;
        done = true;
        window.removeEventListener('message', onMsg);
        clearTimeout(timer);
        try {
          frame.remove();
        } catch (e) {
          /* 忽略 */
        }
        resolve(r);
      };

      const onMsg = (ev) => {
        const d = ev.data;
        if (!d || d.source !== 'tyBili' || d.task !== task || d.nonce !== nonce) return;
        finish({ ok: !!d.ok, detail: String(d.detail || '') });
      };

      const timer = setTimeout(() => {
        let cached = null;
        try {
          cached = JSON.parse(GM_getValue('tyBiliRemote:' + task, '') || 'null');
        } catch (e) {
          cached = null;
        }
        if (cached && cached.nonce === nonce) {
          finish({ ok: !!cached.ok, detail: String(cached.detail || '') });
        } else {
          finish({ ok: false, detail: '借道超时，iframe 没回话（可能被浏览器拦了）' });
        }
      }, timeout);

      window.addEventListener('message', onMsg);
      document.documentElement.appendChild(frame);
    });
  }

  /* ======================= 任务：大会员积分签到 ======================= */
  async function taskBigPoint() {
    if (!CONFIG.bigPoint) return UI.set('bigPoint', '大会员积分签到', 'skip', '配置已关闭');
    if (!state.vip) return UI.set('bigPoint', '大会员积分签到', 'skip', '不是大会员');

    // 已经在 big 页面上就直接打
    if (location.hostname === 'big.bilibili.com') {
      UI.set('bigPoint', '大会员积分签到', 'run', '签到中…');
      const r = await post(
        `/pgc/activity/score/task/sign2?mobi_app=android&csrf=${state.csrf}&platform=android`,
        { device: 'phone', t: Date.now(), ts: Math.floor(Date.now() / 1000) }
      );
      await gap();
      if (r.code === 0 && r.data) {
        UI.set('bigPoint', '大会员积分签到', 'ok', `+${r.data.score || 0} 积分 · 累计 ${r.data.count || 0}/${r.data.duration || 0} 天`);
      } else if (/-401|已签到|重复/.test(`${r.code}${r.message || ''}`)) {
        UI.set('bigPoint', '大会员积分签到', 'skip', r.message || '今天已签');
      } else {
        UI.set('bigPoint', '大会员积分签到', 'warn', `${r.code} ${r.message || ''}`);
      }
      return;
    }

    // 不在 big 页面：借一个隐藏 iframe 进去跑（Referer 自动就是 big）
    UI.set('bigPoint', '大会员积分签到', 'run', '借道 big.bilibili.com…');
    const r = await runInRemoteFrame('bigPoint', 'https://big.bilibili.com/mobile/bigPoint/task');
    if (r.ok) UI.set('bigPoint', '大会员积分签到', 'ok', r.detail);
    else if (/超时|没回话/.test(r.detail)) {
      UI.set('bigPoint', '大会员积分签到', 'warn', r.detail + '，可手动去 big.bilibili.com 签');
    } else UI.set('bigPoint', '大会员积分签到', 'warn', r.detail || '借道失败');
  }

  /* ======================= 主流程 ======================= */
  let running = false;

  // 多标签页防重复：GM 存储跨标签页共享，跑之前抢锁
  const LOCK_KEY = 'tyBiliLock';
  const LOCK_TTL = 3 * 60 * 1000;
  let lockToken = '';

  function acquireLock() {
    const now = Date.now();
    const raw = GM_getValue(LOCK_KEY, '');
    const started = Number(String(raw).split(':')[0]);
    if (started && now - started < LOCK_TTL) return false;
    lockToken = `${now}:${Math.random().toString(36).slice(2, 8)}`;
    GM_setValue(LOCK_KEY, lockToken);
    return true;
  }

  function releaseLock() {
    // 只清自己那把，别把别人的锁抹掉
    if (lockToken && GM_getValue(LOCK_KEY, '') === lockToken) GM_setValue(LOCK_KEY, '');
    lockToken = '';
  }

  async function run(force) {
    if (running) return;
    if (!acquireLock()) {
      UI.mount();
      UI.set('lock', '并发保护', 'skip', '另一个标签页正在跑，这里不动手');
      UI.tip('已有标签页在跑，避免重复投币');
      return;
    }
    running = true;
    UI.mount();
    UI.busy(true);
    UI.tip('启动中…');

    const startedAt = Date.now();
    const cache = {};

    try {
      const acc = await loadAccount();
      if (!acc.ok) {
        UI.set('login', '登录态', 'fail', acc.reason);
        UI.tip('没登录，什么都做不了');
        UI.busy(false);
        running = false;
        return;
      }
      state.levelBefore = state.level;
      UI.set(
        'login',
        '登录态',
        'ok',
        `${state.name} · Lv${state.level} · 硬币 ${state.money}${state.vip ? ' · 大会员' : ''}`
      );

      let status = {};
      try {
        status = await getDailyStatus();
        const bits = [
          status.login ? '登录✓' : '登录✗',
          status.watch ? '观看✓' : '观看✗',
          status.share ? '分享✓' : '分享✗',
          `投币经验 ${status.coins != null ? status.coins : '?'}/50`,
        ];
        UI.set('daily', '每日任务', 'ok', bits.join(' · '));
      } catch (e) {
        UI.set('daily', '每日任务', 'warn', '查不到任务状态：' + String(e.message || e));
      }

      const steps = [
        () => taskWatch(status, cache),
        () => taskShare(status, cache),
        () => taskCoin(),
        () => taskVipExp(),
        () => taskVipPrivilege(),
        () => taskManga(),
        () => taskSilver2Coin(),
        () => taskLiveSign(),
        () => taskBigPoint(),
      ];

      for (const step of steps) {
        try {
          await step();
        } catch (e) {
          UI.set('err', '任务异常', 'fail', String((e && e.message) || e));
        }
        await gap();
      }

      // 收尾：再取一次经验和任务状态，刷新顶部那行（开跑前是快照，容易被误读）
      try {
        const nav = await getJson('/x/web-interface/nav');
        if (nav.code === 0) {
          const d = nav.data || {};
          state.expAfter = (d.level_info && d.level_info.current_exp) || 0;
          state.level = (d.level_info && d.level_info.current_level) || state.level;
          state.money = typeof d.money === 'number' ? d.money : state.money;
        }
      } catch (e) {
        /* 忽略 */
      }
      try {
        const fin = await getDailyStatus();
        const bits = [
          fin.login ? '登录✓' : '登录✗',
          fin.watch ? '观看✓' : '观看✗',
          fin.share ? '分享✓' : '分享✗',
          `投币经验 ${fin.coins != null ? fin.coins : '?'}/50`,
        ];
        UI.set('daily', '每日任务（收尾）', 'ok', bits.join(' · '));
      } catch (e) {
        /* 忽略 */
      }

      let gained = state.expAfter - state.expBefore;
      if (state.level > state.levelBefore) gained = -1; // 升级了，差值不可信
      const secs = Math.round((Date.now() - startedAt) / 1000);
      UI.tip(
        gained > 0
          ? `本次经验 +${gained} · 用时 ${secs}s · 硬币剩 ${state.money}`
          : `跑完了 · 用时 ${secs}s · 硬币剩 ${state.money}`
      );

      GM_setValue('tyBiliLastRun', todayKey());
    } finally {
      running = false;
      releaseLock();
      UI.busy(false);
      UI.render();
      UI.collapseSoon();
    }
  }

  window.__tyBiliRun = run;

  /* ======================= 启动 ======================= */
  function boot() {
    // 1) 被父页面借道调用：只做那一件事，不挂面板、不抢锁
    const remote = parseRemoteCall();
    if (remote) {
      runRemoteTask(remote);
      return;
    }
    // 2) 其它 iframe 一律不跑（避免同一套任务在页面内多个 frame 里重复执行）
    if (window.top !== window) return;

    UI.mount();
    const last = GM_getValue('tyBiliLastRun', '');
    const today = todayKey();
    const isToday = last === today;

    if (typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand('立即重跑 B站每日', () => run(true));
      GM_registerMenuCommand('清除「今天已跑」标记', () => {
        GM_setValue('tyBiliLastRun', '');
        UI.tip('已清除，刷新页面就会重跑');
      });
    }

    if (!CONFIG.autoRun) {
      UI.tip('自动运行已关闭，点「重跑」');
      return;
    }
    if (isToday) {
      UI.set('last', '今天已跑过', 'skip', '需要的话点「重跑」');
      UI.tip('今天跑过了，点「重跑」可再跑一次');
      return;
    }
    setTimeout(() => run(false), CONFIG.autoRunDelay);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();

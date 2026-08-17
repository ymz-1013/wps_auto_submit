// ==UserScript==
// @name         WPS问卷自动提交
// @namespace    http://tampermonkey.net/
// @version      3.9
// @description  定时自动填写SKU并提交WPS问卷（v3.9：提交失败自动恢复并重试）
// @author       You
// @match        https://f.wps.cn/ksform/*
// @match        https://f.kdocs.cn/ksform/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    var origAdd = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function(type, fn, opt) {
        if (type === 'beforeunload') return;
        return origAdd.call(this, type, fn, opt);
    };
    Object.defineProperty(window, 'onbeforeunload', {
        get: function() { return null; },
        set: function() {},
        configurable: true
    });
    window.addEventListener('beforeunload', function(e) {
        e.stopImmediatePropagation();
    }, true);

    console.log('[自动提交] 脚本已加载 v3.9');

    // ============ 配置区 ============
    var CONFIG = {
        enabled: true,
        submitTime: "2026-05-25 23:00:00",
        sku: "10080808557579",
        refreshBefore: 10,
        expireAfter: 60,
        pageRenderWait: 0,
        checkInterval: 16,
        waitButtonTimeout: 5000,
        maxRefreshCount: 30,
        timeSyncSamples: 5,
        precisionWindow: 1500,
        // ==== v3.8 自适应耗时校准 ====
        // calibrateStartBefore: 校准开始时刻 = T - 这个值(秒)
        //   值越大 -> 校准样本越早, 离真实开抢时刻越远, 可能低估高负载下的 reload 耗时
        //   值越小 -> 校准样本越贴近真实场景, 但要给 5 轮校准 + 决战刷新预留时间 (≥ 12s)
        //   20s: 5 轮校准约 10s, 完成时距 T 还有 ~10s, 既贴近真实又留足余量
        calibrateStartBefore: 20,
        calibrateRounds: 5,
        calibrateMaxWaitMs: 8000,
        // safetyMarginMs:
        //   = 预计按钮渲染完成相对 T 的偏移
        //   决战刷新点 = T - renderP75 + safetyMarginMs
        //
        //   当前 WPS 场景开抢后再刷新容易进入排队, 所以这里按页面渲染耗时提前刷新,
        //   目标是让按钮在 T 附近完成渲染并尽快点击。
        //   0      -> 预计按钮正好在 T 渲染完成
        //   100~300 -> 预计按钮在 T 后 100~300ms 渲染完成, 降低过早 disabled 风险
        safetyMarginMs: 200,
        finalRenderTimeoutMs: 8000,
        maxFallbackReloads: 5,
        submitResultSettleMs: 800,
        submitResultTimeoutMs: 4000,
        retryIntervalMs: 250,
        retryButtonTimeoutMs: 2000
    };

    var STORAGE_KEY = 'wps_auto_submit_state';
    var SERVER_TIME_DELTA_KEY = 'wps_auto_submit_delta';
    var LOAD_START_KEY = 'wps_auto_submit_load_start';
    var TIMELINE_KEY = 'wps_auto_submit_timeline';

    var serverTimeDelta = 0;

    function saveState(s) { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); }
    function loadState() { try { var s = localStorage.getItem(STORAGE_KEY); return s ? JSON.parse(s) : null; } catch(e) { return null; } }
    function clearState() { localStorage.removeItem(STORAGE_KEY); }

    function saveDelta(d) { try { localStorage.setItem(SERVER_TIME_DELTA_KEY, String(d)); } catch(e) {} }
    function loadDelta() { try { var v = localStorage.getItem(SERVER_TIME_DELTA_KEY); return v ? parseInt(v, 10) : 0; } catch(e) { return 0; } }

    function serverNow() { return Date.now() + serverTimeDelta; }

    // ============ 决战阶段时间线日志 ============
    function tlPad(n, w) { n = String(n); while (n.length < (w || 2)) n = '0' + n; return n; }
    function tlFmt(ts) {
        var d = new Date(ts);
        return tlPad(d.getHours()) + ':' + tlPad(d.getMinutes()) + ':' + tlPad(d.getSeconds()) + '.' + tlPad(d.getMilliseconds(), 3);
    }
    function tlLoad() { try { var s = localStorage.getItem(TIMELINE_KEY); return s ? JSON.parse(s) : []; } catch(e) { return []; } }
    function tlSave(arr) { try { localStorage.setItem(TIMELINE_KEY, JSON.stringify(arr)); } catch(e) {} }
    function tlClear() { try { localStorage.removeItem(TIMELINE_KEY); } catch(e) {} }
    function tlMark(type, extra) {
        var arr = tlLoad();
        var ts = serverNow();
        var ev = { type: type, ts: ts };
        if (extra) ev.extra = extra;
        arr.push(ev);
        tlSave(arr);
        // 实时打印一行可读的简短信息
        var submitTs = new Date(CONFIG.submitTime).getTime();
        var dtT = ts - submitTs;
        var label = TL_LABELS[type] || type;
        var summary = tlSummarize(type, extra);
        var dtColor = dtT < 0 ? 'color:#0a7' : (dtT === 0 ? 'color:#888' : 'color:#d33');
        console.log('%c⏱ ' + tlFmt(ts) + ' %c' + tlFmtDelta(dtT) + '%c  ' + label + (summary ? '  ─  ' + summary : ''),
                    'color:#888', dtColor + ';font-weight:bold', 'color:inherit');
    }
    // 事件类型 → 中文描述
    var TL_LABELS = {
        'schedule-final':        '📋 计划决战刷新',
        'reload-triggered':      '🔄 触发刷新',
        'page-loaded':           '📄 新页面加载完成',
        'button-rendered':       '🔘 提交按钮已渲染',
        'button-clickable':      '✅ 提交按钮可点击',
        'fill-sku-start':        '⌨️  开始填写SKU',
        'fill-sku-done':         '⌨️  SKU填写完成',
        'click-submit':          '👆 点击提交按钮',
        'click-submit-failed':   '❌ 点击提交失败',
        'confirm-shown':         '💬 确认弹窗出现',
        'confirm-clicked':       '👆 点击确认按钮',
        'submit-failed':         '⚠️ 提交失败',
        'submit-retry':          '🔁 重新提交',
        'submit-done':           '🎉 提交流程完成',
        'fallback-reload':       '🆘 兜底刷新',
        'ghost-reload-detected': '👻 检测到第三方刷新',
        'reschedule-final':      '🔁 重新调度刷新',
        'resume-after-submit':   '⏪ 提交后页面恢复'
    };
    // 事件 extra 的简短摘要(显示在右侧)
    function tlSummarize(type, extra) {
        if (!extra) return '';
        try {
            switch (type) {
                case 'schedule-final':
                    return '渲染P75 ' + extra.avg + 'ms, 上行 ' + (extra.uploadMs != null ? extra.uploadMs : '?') + 'ms, 安全余量 ' + extra.safety + 'ms, 等待 ' + extra.waitMs + 'ms';
                case 'reload-triggered':
                    return '阶段=' + extra.phase + (extra.fallback ? ', 兜底#' + extra.fallback : '');
                case 'page-loaded':
                    return 'reload耗时=' + (extra.reloadElapsedMs >= 0 ? extra.reloadElapsedMs + 'ms' : '未知(可能被第三方跳转)') + (extra.fallback ? ', 兜底#' + extra.fallback : '');
                case 'button-rendered':
                    return '可点击=' + (extra.clickable ? '是' : '否') + ', reload至此=' + extra.sinceReloadMs + 'ms';
                case 'button-clickable':
                    return 'reload至此=' + extra.sinceReloadMs + 'ms, 距T=' + extra.msToSubmit + 'ms';
                case 'fallback-reload':
                    return '原因: ' + extra.reason + ', 第' + extra.count + '次';
                case 'ghost-reload-detected':
                    return '距开抢 ' + extra.msToSubmit + 'ms, avg=' + extra.avg + 'ms, 阈值=' + extra.rescheduleMinMs + 'ms';
                case 'reschedule-final':
                    return '模式=' + (extra.mode === 'planned' ? '计划等待' : '立即刷新') + ', 距开抢 ' + extra.msToSubmit + 'ms';
                case 'click-submit-failed':
                    return '原因: ' + extra.reason;
                case 'submit-failed':
                    return '原因: ' + extra.reason + ', 尝试=' + extra.attempt;
                case 'submit-retry':
                    return '第' + extra.attempt + '次尝试';
                case 'confirm-shown':
                case 'confirm-clicked':
                case 'submit-done':
                    return '路径=' + (extra.from === 'mutation' ? 'DOM监听' : '轮询');
                default:
                    return JSON.stringify(extra);
            }
        } catch(e) { return JSON.stringify(extra); }
    }
    // 把毫秒数格式化成右对齐固定宽度的字符串, 方便对齐
    function tlFmtDelta(ms) {
        var sign = ms >= 0 ? '+' : '-';
        var abs = Math.abs(ms);
        var s = '';
        if (abs >= 1000) s = (abs / 1000).toFixed(2) + 's';
        else s = abs + 'ms';
        return sign + s;
    }
    function tlPadRight(s, w) { while (s.length < w) s += ' '; return s; }
    function tlPadLeft(s, w) { while (s.length < w) s = ' ' + s; return s; }
    function tlPrintReport() {
        var arr = tlLoad();
        if (!arr.length) return;
        var submitTs = new Date(CONFIG.submitTime).getTime();
        var firstTs = arr[0].ts;
        var lastTs = arr[arr.length - 1].ts;

        // 实时打印每条事件 (供 tlMark 内部调用替代方案 → 改为只在报告时统一打印)
        // 为了保持原有"实时"行为, tlMark 内仍保留控制台单行输出
        // 这里专注于"报告"格式

        console.log('');
        console.log('%c╔═══════════════════════════════════════════════════════════════════════════╗', 'color:#08c;font-weight:bold');
        console.log('%c║                       决战时间线报告 (WPS 问卷自动提交)                    ║', 'color:#08c;font-weight:bold');
        console.log('%c╚═══════════════════════════════════════════════════════════════════════════╝', 'color:#08c;font-weight:bold');
        console.log('🎯 目标开抢时刻 T = %c' + tlFmt(submitTs), 'color:#0a7;font-weight:bold');
        console.log('📅 时间线起点    = ' + tlFmt(firstTs) + '  (距 T ' + tlFmtDelta(firstTs - submitTs) + ')');
        console.log('🏁 时间线终点    = ' + tlFmt(lastTs)  + '  (距 T ' + tlFmtDelta(lastTs  - submitTs) + ')');
        console.log('⏱  端到端耗时   = ' + (lastTs - firstTs) + 'ms');
        console.log('');
        console.log('  序号 │ 时刻         │ 距上一步   │ 距 T (开抢)  │ 事件                  │ 详情');
        console.log('  ─────┼──────────────┼────────────┼──────────────┼───────────────────────┼─────────────────────────────');

        var prevTs = firstTs;
        for (var i = 0; i < arr.length; i++) {
            var ev = arr[i];
            var dtT = ev.ts - submitTs;
            var step = ev.ts - prevTs;
            var idx = tlPadLeft(String(i + 1), 4);
            var time = tlPadRight(tlFmt(ev.ts), 12);
            var stepStr = tlPadLeft(i === 0 ? '--' : tlFmtDelta(step), 10);
            var dtTStr = tlPadLeft(tlFmtDelta(dtT), 12);
            var label = tlPadRight(TL_LABELS[ev.type] || ev.type, 21);
            var summary = tlSummarize(ev.type, ev.extra);
            // 高亮"距 T" 列: 早 = 绿, 晚 = 红
            var dtColor = dtT < 0 ? 'color:#0a7' : (dtT === 0 ? 'color:#888' : 'color:#d33');
            console.log('%c  ' + idx + ' │ ' + time + ' │ ' + stepStr + ' │ %c' + dtTStr + '%c │ ' + label + ' │ ' + summary,
                        'color:inherit', dtColor + ';font-weight:bold', 'color:inherit');
            prevTs = ev.ts;
        }
        console.log('  ─────┴──────────────┴────────────┴──────────────┴───────────────────────┴─────────────────────────────');

        // ============ 关键阶段耗时统计 ============
        function findEv(type) { for (var i = 0; i < arr.length; i++) if (arr[i].type === type) return arr[i]; return null; }
        function findLastEv(type) { for (var i = arr.length - 1; i >= 0; i--) if (arr[i].type === type) return arr[i]; return null; }
        var evReload = findLastEv('reload-triggered');
        var evPageLoaded = findLastEv('page-loaded');
        var evBtnRendered = null;
        // 找最后一条 button-rendered 且 clickable=true 的; 没有就找最后一条
        for (var k = arr.length - 1; k >= 0; k--) {
            if (arr[k].type === 'button-rendered' && arr[k].extra && arr[k].extra.clickable) { evBtnRendered = arr[k]; break; }
        }
        if (!evBtnRendered) evBtnRendered = findLastEv('button-rendered');
        var evBtnClickable = findLastEv('button-clickable');
        var evClick = findLastEv('click-submit');
        var evConfirmShown = findLastEv('confirm-shown');
        var evConfirmClicked = findLastEv('confirm-clicked');
        var evDone = findLastEv('submit-done');

        console.log('');
        console.log('%c📊 关键阶段耗时:', 'color:#08c;font-weight:bold');
        function showSpan(name, a, b) {
            if (!a || !b) return;
            console.log('   ' + tlPadRight(name, 28) + ' = ' + tlPadLeft(String(b.ts - a.ts), 6) + 'ms');
        }
        showSpan('刷新→页面加载完成',     evReload, evPageLoaded);
        showSpan('页面加载→按钮渲染',     evPageLoaded, evBtnRendered);
        showSpan('按钮渲染→可点击',       evBtnRendered, evBtnClickable);
        showSpan('按钮可点击→点击提交',   evBtnClickable, evClick);
        showSpan('点击提交→弹窗出现',     evClick, evConfirmShown);
        showSpan('弹窗出现→点击确认',     evConfirmShown, evConfirmClicked);
        showSpan('点击确认→提交完成',     evConfirmClicked, evDone);

        // 命中评估
        if (evDone) {
            var lateMs = evDone.ts - submitTs;
            var verdict;
            if (lateMs < 0) verdict = '%c🏆 提前命中! 在开抢前 ' + (-lateMs) + 'ms 完成';
            else if (lateMs < 500) verdict = '%c🥇 极速命中! 在开抢后 ' + lateMs + 'ms 完成 (< 500ms)';
            else if (lateMs < 1500) verdict = '%c🥈 较快命中, 在开抢后 ' + lateMs + 'ms 完成';
            else if (lateMs < 3000) verdict = '%c🥉 偏慢命中, 在开抢后 ' + lateMs + 'ms 完成';
            else verdict = '%c⚠️  显著延迟, 在开抢后 ' + lateMs + 'ms 完成';
            var color = lateMs < 0 ? 'color:#0a7;font-weight:bold;font-size:13px'
                      : lateMs < 500 ? 'color:#0a7;font-weight:bold'
                      : lateMs < 1500 ? 'color:#fa0;font-weight:bold'
                      : 'color:#d33;font-weight:bold';
            console.log('');
            console.log(verdict, color);
        }
        console.log('');
    }

    function syncServerTime(samples, cb) {
        var n = samples || 5;
        var results = [];
        var url = location.origin + '/favicon.ico?_t=' + Math.random();
        var done = 0;

        function once() {
            var t0 = Date.now();
            var xhr = new XMLHttpRequest();
            try {
                xhr.open('HEAD', url, true);
                xhr.timeout = 3000;
                xhr.onreadystatechange = function() {
                    if (xhr.readyState !== 4) return;
                    var t1 = Date.now();
                    var dateHeader = xhr.getResponseHeader('Date');
                    if (dateHeader) {
                        var serverTs = new Date(dateHeader).getTime();
                        var rtt = t1 - t0;
                        var localMid = t0 + Math.floor(rtt / 2);
                        var delta = serverTs - localMid;
                        results.push({ delta: delta, rtt: rtt });
                        console.log('[自动提交] 时间同步样本: rtt=' + rtt + 'ms delta=' + delta + 'ms');
                    }
                    done++;
                    if (done >= n) finish();
                    else setTimeout(once, 50);
                };
                xhr.onerror = function() { done++; if (done >= n) finish(); else setTimeout(once, 50); };
                xhr.ontimeout = function() { done++; if (done >= n) finish(); else setTimeout(once, 50); };
                xhr.send();
            } catch(e) {
                done++;
                if (done >= n) finish();
            }
        }

        function finish() {
            if (results.length === 0) {
                console.log('[自动提交] 时间同步失败, 使用上次缓存');
                serverTimeDelta = loadDelta();
                console.log('[自动提交] 缓存 delta=' + serverTimeDelta + 'ms');
                if (cb) cb();
                return;
            }
            results.sort(function(a, b) { return a.rtt - b.rtt; });
            serverTimeDelta = results[0].delta;
            saveDelta(serverTimeDelta);
            console.log('[自动提交] 时间同步完成: delta=' + serverTimeDelta + 'ms (本地比服务器' + (serverTimeDelta > 0 ? '慢' : '快') + Math.abs(serverTimeDelta) + 'ms, 最佳rtt=' + results[0].rtt + 'ms)');
            if (cb) cb();
        }

        once();
    }

    function isExpired() {
        var deadline = new Date(CONFIG.submitTime).getTime() + CONFIG.expireAfter * 1000;
        return serverNow() > deadline;
    }

    function refineWithEdgeDetection(maxMs, cb) {
        var deadline = Date.now() + (maxMs || 1500);
        var url = location.origin + '/favicon.ico?_e=' + Math.random();
        var lastDateSec = null;
        var lastT0 = 0;
        var probeCount = 0;

        function probe() {
            if (Date.now() >= deadline) {
                console.log('[自动提交] 边沿检测超时, 共发' + probeCount + '次请求未捕获跳变');
                if (cb) cb();
                return;
            }
            var t0 = Date.now();
            var xhr = new XMLHttpRequest();
            try {
                xhr.open('HEAD', url + '&_=' + t0, true);
                xhr.timeout = 1000;
                xhr.onreadystatechange = function() {
                    if (xhr.readyState !== 4) return;
                    var t1 = Date.now();
                    probeCount++;
                    var dateHeader = xhr.getResponseHeader('Date');
                    if (!dateHeader) { setTimeout(probe, 0); return; }
                    var serverSec = Math.floor(new Date(dateHeader).getTime() / 1000);

                    if (lastDateSec !== null && serverSec > lastDateSec) {
                        var edgeLocal = Math.floor((lastT0 + t0) / 2);
                        var edgeServer = serverSec * 1000;
                        var newDelta = edgeServer - edgeLocal;
                        var diff = newDelta - serverTimeDelta;
                        console.log('[自动提交] 🎯 捕获Date跳变! 旧delta=' + serverTimeDelta + 'ms 新delta=' + newDelta + 'ms (调整' + (diff >= 0 ? '+' : '') + diff + 'ms, 探测' + probeCount + '次)');
                        serverTimeDelta = newDelta;
                        saveDelta(serverTimeDelta);
                        if (cb) cb();
                        return;
                    }
                    lastDateSec = serverSec;
                    lastT0 = t0;
                    setTimeout(probe, 0);
                };
                xhr.onerror = function() { setTimeout(probe, 50); };
                xhr.ontimeout = function() { setTimeout(probe, 50); };
                xhr.send();
            } catch(e) {
                setTimeout(probe, 50);
            }
        }
        console.log('[自动提交] 启动边沿检测 (最多' + (maxMs || 1500) + 'ms)...');
        probe();
    }

    function fillSku(val) {
        try {
            console.log('[自动提交] fillSku, val=' + val);
            var inputs = document.querySelectorAll('input, textarea');
            console.log('[自动提交] input/textarea: ' + inputs.length);
            for (var d = 0; d < inputs.length; d++) {
                console.log('[自动提交] [' + d + '] tag=' + inputs[d].tagName + ' type=' + inputs[d].type + ' class=' + (inputs[d].className || '').substring(0, 40) + ' ph=' + (inputs[d].placeholder || '') + ' vis=' + (inputs[d].offsetParent !== null));
            }

            var target = null;
            var i;

            var antInputs = document.querySelectorAll('.ant-input, [class*="ant-input"]');
            console.log('[自动提交] ant-input: ' + antInputs.length);
            for (i = 0; i < antInputs.length; i++) {
                if (antInputs[i].offsetParent !== null) { target = antInputs[i]; break; }
            }

            if (!target) {
                for (i = 0; i < inputs.length; i++) {
                    var ph = inputs[i].placeholder || '';
                    if (ph.indexOf('\u8bf7\u8f93\u5165') >= 0) { target = inputs[i]; break; }
                }
            }

            if (!target) {
                for (i = 0; i < inputs.length; i++) {
                    try {
                        var c = inputs[i].closest('[class*="question"], [class*="item"], [class*="form"], [class*="field"], [class*="write"]');
                        if (c && c.textContent.toLowerCase().indexOf('sku') >= 0) { target = inputs[i]; break; }
                    } catch(e2) {}
                }
            }

            if (!target) {
                for (i = 0; i < inputs.length; i++) {
                    var tp = inputs[i].type || '';
                    if ((tp === '' || tp === 'text') && inputs[i].offsetParent !== null && inputs[i].offsetWidth > 0) { target = inputs[i]; break; }
                }
            }

            if (!target) { console.log('[自动提交] 未找到输入框!'); return false; }

            console.log('[自动提交] 选中: <' + target.tagName + '> type=' + target.type + ' class=' + (target.className || '').substring(0, 50));

            var proto = target.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
            var desc = Object.getOwnPropertyDescriptor(proto, 'value');
            var setter = desc ? desc.set : null;

            target.focus();

            var tracker = target._valueTracker;
            if (tracker) { console.log('[自动提交] 重置_valueTracker'); tracker.setValue(''); }

            if (setter) { setter.call(target, val); console.log('[自动提交] setter完成'); }
            else { target.value = val; console.log('[自动提交] 直接设值'); }

            target.dispatchEvent(new Event('input', { bubbles: true }));
            target.dispatchEvent(new Event('change', { bubbles: true }));

            console.log('[自动提交] 当前值: "' + target.value + '"');

            if (target.value !== val) {
                console.log('[自动提交] setter未生效, execCommand');
                target.focus();
                target.select();
                document.execCommand('insertText', false, val);
                console.log('[自动提交] execCommand后: "' + target.value + '"');
            }

            console.log('[自动提交] fillSku完成');
            return true;
        } catch(err) {
            console.log('[自动提交] fillSku异常: ' + err.message);
            console.log(err.stack);
            return false;
        }
    }

    function findSubmitButton() {
        var btn = document.querySelector('[class*="submitBtn"]');
        if (btn) return btn;

        var antBtns = document.querySelectorAll('.ant-btn-primary, .ksapc-btn-primary');
        for (var i = 0; i < antBtns.length; i++) {
            var t = (antBtns[i].textContent || '').replace(/\s+/g, '');
            if (t.indexOf('\u63d0\u4ea4') >= 0) return antBtns[i];
        }

        var all = document.querySelectorAll('button, [role="button"], div, span, a, [class*="btn"]');
        for (var j = 0; j < all.length; j++) {
            var txt = (all[j].textContent || '').replace(/\s+/g, '');
            if (txt.indexOf('\u63d0\u4ea4') >= 0 && txt.length <= 6 && all[j].offsetParent !== null) return all[j];
        }
        return null;
    }

    function isButtonClickable(btn) {
        if (!btn) return false;
        if (btn.disabled) return false;
        var s = window.getComputedStyle(btn);
        var cls = (typeof btn.className === 'string') ? btn.className.toLowerCase() : '';
        if (cls.indexOf('disabled') >= 0) return false;
        if (s.pointerEvents === 'none') return false;
        if (s.cursor === 'not-allowed') return false;
        return true;
    }

    var submitFlowGeneration = 0;
    var RESULT_SURFACE_SELECTOR =
        '[role="alertdialog"], [role="alert"], .ant-modal, .ant-message-notice, ' +
        '.ant-notification-notice, [class*="toast"], [class*="Toast"], ' +
        '[class*="dialog"], [class*="Dialog"], [class*="modal"], [class*="Modal"], ' +
        '[class*="popup"], [class*="Popup"]';

    function compactText(node) {
        return ((node && node.textContent) || '').replace(/\s+/g, '');
    }

    function isVisibleNode(node) {
        if (!node || !node.isConnected) return false;
        var style = window.getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity || '1') === 0) return false;
        var rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }

    function findResultSurface(node) {
        if (!node || !node.closest) return null;
        return node.closest(RESULT_SURFACE_SELECTOR);
    }

    function snapshotVisibleResultSurfaces() {
        var snapshots = [];
        var surfaces = document.querySelectorAll(RESULT_SURFACE_SELECTOR);
        for (var i = 0; i < surfaces.length; i++) {
            if (!isVisibleNode(surfaces[i])) continue;
            snapshots.push({ node: surfaces[i], text: compactText(surfaces[i]) });
        }
        return snapshots;
    }

    function findVisibleConfirm() {
        var btns = document.querySelectorAll('button, [role="button"], .ant-btn, div, span');
        for (var i = 0; i < btns.length; i++) {
            var text = compactText(btns[i]);
            if (text !== '\u786e\u8ba4' && text !== '\u786e\u5b9a' && text !== 'OK') continue;
            if (!isVisibleNode(btns[i])) continue;
            var cls = (typeof btns[i].className === 'string') ? btns[i].className : '';
            if (cls.indexOf('submitBtn') >= 0) continue;
            return {
                button: btns[i],
                surface: findResultSurface(btns[i]),
                baselineSurfaces: snapshotVisibleResultSurfaces()
            };
        }
        return null;
    }

    function hasVisibleSubmitForm() {
        if (findSubmitButton()) return true;
        var inputs = document.querySelectorAll('input, textarea');
        for (var i = 0; i < inputs.length; i++) {
            if (isVisibleNode(inputs[i]) && !inputs[i].disabled) return true;
        }
        return false;
    }

    function hasSuccessResult() {
        var successTexts = [
            '\u63d0\u4ea4\u6210\u529f',
            '\u95ee\u5377\u5df2\u63d0\u4ea4',
            '\u60a8\u5df2\u63d0\u4ea4',
            '\u63d0\u4ea4\u5b8c\u6210',
            '\u611f\u8c22\u60a8\u7684\u53c2\u4e0e'
        ];
        var nodes = document.querySelectorAll(
            'h1, h2, h3, [class*="success"], [class*="Success"], ' +
            '[class*="result"], [class*="Result"], [class*="finish"], ' +
            '[class*="Finish"], [class*="complete"], [class*="Complete"]'
        );
        for (var i = 0; i < nodes.length; i++) {
            if (!isVisibleNode(nodes[i])) continue;
            var text = compactText(nodes[i]);
            for (var j = 0; j < successTexts.length; j++) {
                if (text.indexOf(successTexts[j]) >= 0) return true;
            }
        }

        if (!hasVisibleSubmitForm()) {
            var bodyText = compactText(document.body);
            for (var k = 0; k < successTexts.length; k++) {
                if (bodyText.indexOf(successTexts[k]) >= 0) return true;
            }
        }
        return false;
    }

    function findVisibleFailureSurface(confirmInfo) {
        var surfaces = document.querySelectorAll(RESULT_SURFACE_SELECTOR);
        for (var i = 0; i < surfaces.length; i++) {
            var surface = surfaces[i];
            if (!isVisibleNode(surface)) continue;
            var unchangedBaseline = false;
            var baseline = (confirmInfo && confirmInfo.baselineSurfaces) || [];
            for (var j = 0; j < baseline.length; j++) {
                if (baseline[j].node === surface && baseline[j].text === compactText(surface)) {
                    unchangedBaseline = true;
                    break;
                }
            }
            if (unchangedBaseline) continue;
            return surface;
        }
        return null;
    }

    function dismissFailureSurface(surface) {
        if (!surface || !isVisibleNode(surface)) return;
        var buttons = surface.querySelectorAll('button, [role="button"], .ant-btn, [class*="close"], [aria-label="Close"], [aria-label="close"]');
        for (var i = 0; i < buttons.length; i++) {
            if (!isVisibleNode(buttons[i])) continue;
            var text = compactText(buttons[i]);
            if (text === '\u786e\u5b9a' || text === '\u786e\u8ba4' ||
                text === '\u77e5\u9053\u4e86' || text === '\u5173\u95ed' ||
                text === 'OK' || text === '') {
                buttons[i].click();
                return;
            }
        }
    }

    function finishSubmission(from, generation) {
        if (generation !== submitFlowGeneration) return;
        submitFlowGeneration++;
        console.log('[自动提交] \u68c0\u6d4b\u5230\u6210\u529f\u9875\u9762, \u63d0\u4ea4\u5b8c\u6210');
        tlMark('submit-done', { from: from });
        tlPrintReport();
        clearState();
        clearReloadTimer();
    }

    function retrySubmission(reason, surface, generation) {
        if (generation !== submitFlowGeneration) return;
        submitFlowGeneration++;
        var retryGeneration = submitFlowGeneration;
        var state = loadState() || {};
        state.submitted = false;
        state.submitStatus = 'retry-wait';
        state.submitAttempt = state.submitAttempt || 1;
        state.lastSubmitFailure = reason;
        saveState(state);
        tlMark('submit-failed', { reason: reason, attempt: state.submitAttempt });
        console.log('[自动提交] \u63d0\u4ea4\u672a\u6210\u529f (' + reason + '), \u51c6\u5907\u91cd\u8bd5');
        dismissFailureSurface(surface);

        var startedAt = Date.now();
        function waitForRetry() {
            if (retryGeneration !== submitFlowGeneration) return;
            if (isExpired()) {
                console.log('[自动提交] \u91cd\u8bd5\u65f6\u95f4\u5df2\u8fc7\u671f, \u505c\u6b62');
                clearState();
                clearReloadTimer();
                return;
            }
            if (Date.now() - startedAt >= CONFIG.retryButtonTimeoutMs) {
                console.log('[自动提交] \u5931\u8d25\u540e\u8868\u5355\u672a\u6062\u590d, \u5237\u65b0\u540e\u7ee7\u7eed');
                var nextState = loadState() || {};
                nextState.submitted = false;
                nextState.submitStatus = 'retry-wait';
                nextState.phase = 'final-reloading';
                nextState.active = true;
                saveState(nextState);
                doRefresh();
                return;
            }
            if (surface && isVisibleNode(surface)) {
                dismissFailureSurface(surface);
                setTimeout(waitForRetry, CONFIG.retryIntervalMs);
                return;
            }

            var button = findSubmitButton();
            if (button && isButtonClickable(button)) {
                tlMark('submit-retry', { attempt: state.submitAttempt + 1 });
                doSubmitNow(button);
                return;
            }
            setTimeout(waitForRetry, CONFIG.retryIntervalMs);
        }
        setTimeout(waitForRetry, CONFIG.retryIntervalMs);
    }

    function watchSubmissionResult(confirmInfo, generation) {
        var startedAt = Date.now();
        var submitButtonBecameUnavailable = false;
        var timer = setInterval(function() {
            if (generation !== submitFlowGeneration) {
                clearInterval(timer);
                return;
            }
            if (isExpired()) {
                clearInterval(timer);
                clearState();
                clearReloadTimer();
                return;
            }
            if (hasSuccessResult()) {
                clearInterval(timer);
                finishSubmission('result-watch', generation);
                return;
            }

            var elapsed = Date.now() - startedAt;
            if (elapsed < CONFIG.submitResultSettleMs) return;

            var failureSurface = findVisibleFailureSurface(confirmInfo);
            if (failureSurface) {
                clearInterval(timer);
                retrySubmission('result-surface-shown', failureSurface, generation);
                return;
            }

            var confirmStillVisible = confirmInfo && confirmInfo.surface && isVisibleNode(confirmInfo.surface);
            var button = findSubmitButton();
            var buttonClickable = button && isButtonClickable(button);
            if (!buttonClickable) submitButtonBecameUnavailable = true;
            if (elapsed >= 800 && submitButtonBecameUnavailable &&
                !confirmStillVisible && buttonClickable) {
                clearInterval(timer);
                retrySubmission('submit-button-restored', null, generation);
                return;
            }

            if (elapsed >= CONFIG.submitResultTimeoutMs && hasVisibleSubmitForm()) {
                clearInterval(timer);
                retrySubmission('result-timeout-on-form', null, generation);
            }
        }, 80);
    }

    function watchForConfirmDialog(generation) {
        console.log('[自动提交] \u76d1\u542c\u4e8c\u6b21\u786e\u8ba4\u5f39\u7a97...');
        var startedAt = Date.now();
        var timer = setInterval(function() {
            if (generation !== submitFlowGeneration) {
                clearInterval(timer);
                return;
            }
            if (hasSuccessResult()) {
                clearInterval(timer);
                finishSubmission('confirm-watch', generation);
                return;
            }

            var confirmInfo = findVisibleConfirm();
            if (confirmInfo) {
                clearInterval(timer);
                tlMark('confirm-shown', { from: 'poll' });
                console.log('[自动提交] \u70b9\u51fb\u4e8c\u6b21\u786e\u8ba4: ' + compactText(confirmInfo.button));
                var state = loadState() || {};
                state.submitStatus = 'awaiting-result';
                saveState(state);
                tlMark('confirm-clicked', { from: 'poll' });
                confirmInfo.button.click();
                watchSubmissionResult(confirmInfo, generation);
                return;
            }

            if (Date.now() - startedAt >= CONFIG.submitResultTimeoutMs) {
                clearInterval(timer);
                retrySubmission('confirm-timeout', null, generation);
            }
        }, 80);
    }

    function doRefresh() {
        console.log('[自动提交] 刷新...');
        var st = loadState() || {};
        if (st.phase === 'final-reloading' || st.phase === 'final') {
            tlMark('reload-triggered', { phase: st.phase, fallback: st.fallbackCount || 0 });
        }
        var inp = document.querySelectorAll('input, textarea');
        for (var i = 0; i < inp.length; i++) { try { inp[i].value = ''; } catch(e) {} }
        try { localStorage.setItem(LOAD_START_KEY, String(serverNow())); } catch(e) {}
        window.location.reload();
    }

    function getReloadElapsedMs() {
        try {
            var raw = localStorage.getItem(LOAD_START_KEY);
            if (!raw) return -1;
            var ts = parseInt(raw, 10);
            if (!ts) return -1;
            return serverNow() - ts;
        } catch(e) { return -1; }
    }

    // 估算本次导航的"HTTP 上行 + 服务器处理 + 首字节"耗时 (ms),
    // 近似为决战刷新触发到"请求到达服务器"的时间
    // 用 PerformanceNavigationTiming.responseStart - fetchStart, 不可用时返回 -1
    function getNavigationUploadMs() {
        try {
            if (typeof performance === 'undefined' || !performance.getEntriesByType) return -1;
            var entries = performance.getEntriesByType('navigation');
            if (!entries || !entries.length) {
                // 老接口 fallback
                if (performance.timing) {
                    var t = performance.timing;
                    if (t.responseStart > 0 && t.fetchStart > 0) return t.responseStart - t.fetchStart;
                }
                return -1;
            }
            var nav = entries[0];
            if (nav.responseStart > 0 && nav.fetchStart >= 0) {
                return Math.max(0, Math.round(nav.responseStart - nav.fetchStart));
            }
            return -1;
        } catch(e) { return -1; }
    }

    function clearReloadTimer() {
        try { localStorage.removeItem(LOAD_START_KEY); } catch(e) {}
    }

    function precisionWaitUntil(targetServerTs, onFire) {
        var nowS = serverNow();
        var remain = targetServerTs - nowS;
        if (remain <= 0) { onFire(); return; }

        if (remain > CONFIG.precisionWindow) {
            var coarse = remain - CONFIG.precisionWindow;
            console.log('[自动提交] 粗等待 ' + Math.floor(coarse / 1000) + 's, 然后进入精准窗口');
            setTimeout(function() {
                if (isExpired()) { console.log('[自动提交] 粗等待结束已过期'); clearState(); return; }
                precisionWaitUntil(targetServerTs, onFire);
            }, coarse);
            return;
        }

        console.log('[自动提交] 进入精准窗口 (' + remain + 'ms), 开始紧密轮询');
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
            console.log('[自动提交] 警告: 当前tab在后台, setTimeout会被节流, 请保持tab前台!');
        }
        var fired = false;
        var iv = setInterval(function() {
            if (fired) return;
            var left = targetServerTs - serverNow();
            if (left <= 0) {
                fired = true;
                clearInterval(iv);
                console.log('[自动提交] 触发! 偏差 ' + left + 'ms (服务器时间为准)');
                onFire();
            }
        }, 2);
    }

    function main() {
        if (!CONFIG.enabled) return;

        if (isExpired()) {
            console.log('[自动提交] 已过期(' + CONFIG.submitTime + '+' + CONFIG.expireAfter + 's), 不执行');
            clearState();
            return;
        }

        console.log('=== WPS问卷自动提交 v3.9 ===');
        console.log('目标: ' + CONFIG.submitTime + ' SKU: ' + CONFIG.sku + ' 过期: +' + CONFIG.expireAfter + 's');

        serverTimeDelta = loadDelta();
        console.log('[自动提交] 加载缓存 delta=' + serverTimeDelta + 'ms (将立即重新校准)');

        syncServerTime(CONFIG.timeSyncSamples, function() {
            refineWithEdgeDetection(1500, function() {
                runFlow();
            });
        });
    }

    function waitForButtonRender(timeoutMs, onResult) {
        var st = Date.now();
        var rafSupported = typeof window.requestAnimationFrame === 'function';
        var elapsedFromReload = getReloadElapsedMs();

        function check() {
            var el = Date.now() - st;
            var btn = findSubmitButton();

            if (btn) {
                var ok = isButtonClickable(btn);
                var totalSinceReload = (elapsedFromReload >= 0) ? (elapsedFromReload + el) : el;
                console.log('[自动提交] ✓ 按钮已渲染 (本轮' + el + 'ms, 自reload起约' + totalSinceReload + 'ms) clickable=' + ok);
                onResult({ ok: true, btn: btn, clickable: ok, elapsedSinceReload: totalSinceReload });
                return;
            }

            if (el >= timeoutMs) {
                console.log('[自动提交] ✗ 按钮渲染超时 ' + el + 'ms');
                onResult({ ok: false, btn: null, clickable: false, elapsedSinceReload: -1 });
                return;
            }

            if (rafSupported) requestAnimationFrame(check);
            else setTimeout(check, CONFIG.checkInterval);
        }
        setTimeout(check, CONFIG.pageRenderWait);
    }

    function doSubmitNow(btn) {
        console.log('[自动提交] 执行提交流程');
        if (isExpired()) {
            console.log('[自动提交] \u63d0\u4ea4\u524d\u5df2\u8fc7\u671f, \u505c\u6b62');
            clearState();
            clearReloadTimer();
            return;
        }
        var generation = ++submitFlowGeneration;
        var st = loadState() || {};
        st.submitted = true;
        st.submitStatus = 'awaiting-confirm';
        st.submitAttempt = (st.submitAttempt || 0) + 1;
        st.active = true;
        saveState(st);
        tlMark('fill-sku-start');
        fillSku(CONFIG.sku);
        tlMark('fill-sku-done');
        watchForConfirmDialog(generation);

        // rAF 自适应等待按钮可点击
        // 原本是固定 setTimeout(150ms) 等 React 把 input 值 commit 进 state, 再点 click
        // 改为: 每帧检查一次 (~16ms), 一旦按钮存在就立即点击; 最长等 80ms
        var clickDeadline = Date.now() + 80;
        var tryClick = function() {
            var sb = findSubmitButton() || btn;
            if (sb) {
                tlMark('click-submit');
                console.log('[自动提交] 点击提交');
                sb.click();
                return;
            }
            if (Date.now() >= clickDeadline) {
                tlMark('click-submit-failed', { reason: 'button-not-found' });
                console.log('[自动提交] 点击前按钮失效 (等待 80ms 仍找不到)');
                return;
            }
            if (typeof requestAnimationFrame === 'function') requestAnimationFrame(tryClick);
            else setTimeout(tryClick, 16);
        };
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(tryClick);
        else setTimeout(tryClick, 16);
    }

    function calibrateRound(roundIdx) {
        var state = loadState() || {};
        state.phase = 'calibrating';
        state.calibrateRound = roundIdx;
        state.active = true;
        saveState(state);

        if (isExpired()) { console.log('[自动提交] 校准时已过期'); clearState(); clearReloadTimer(); return; }

        var submitTs = new Date(CONFIG.submitTime).getTime();
        var msToSubmit = submitTs - serverNow();
        console.log('[自动提交] [校准 ' + (roundIdx + 1) + '/' + CONFIG.calibrateRounds + '] 距开抢' + Math.floor(msToSubmit / 1000) + 's, 即将刷新');

        if (msToSubmit < 8000) {
            console.log('[自动提交] 距开抢过近, 中止校准, 直接进入决战');
            state.phase = 'final';
            state.samples = state.samples || [];
            saveState(state);
            scheduleFinalReload();
            return;
        }

        setTimeout(doRefresh, 50);
    }

    function onCalibrationPageLoaded(state) {
        var roundIdx = state.calibrateRound || 0;
        console.log('[自动提交] 校准刷新返回 (round ' + (roundIdx + 1) + ')');

        // 同步采集本次导航的网络耗时, 不依赖按钮渲染是否成功
        var navMs = getNavigationUploadMs();
        var uploadOneWayMs = navMs > 0 ? Math.round(navMs / 2) : -1;

        waitForButtonRender(CONFIG.calibrateMaxWaitMs, function(res) {
            var samples = state.samples || [];
            if (res.ok && res.elapsedSinceReload > 0) {
                samples.push(res.elapsedSinceReload);
                console.log('[自动提交] [校准 ' + (roundIdx + 1) + '] 渲染耗时样本: ' + res.elapsedSinceReload + 'ms, 累计样本=' + JSON.stringify(samples));
            } else {
                console.log('[自动提交] [校准 ' + (roundIdx + 1) + '] 未取到渲染耗时');
            }
            var uploadSamples = state.uploadSamples || [];
            if (uploadOneWayMs > 0) {
                uploadSamples.push(uploadOneWayMs);
                console.log('[自动提交] [校准 ' + (roundIdx + 1) + '] 上行单程估算: ' + uploadOneWayMs + 'ms (responseStart-fetchStart=' + navMs + 'ms), 累计=' + JSON.stringify(uploadSamples));
            } else {
                console.log('[自动提交] [校准 ' + (roundIdx + 1) + '] PerformanceNavigationTiming 不可用, 跳过上行采样');
            }
            state.samples = samples;
            state.uploadSamples = uploadSamples;
            saveState(state);
            clearReloadTimer();

            var nextRound = roundIdx + 1;
            if (nextRound < CONFIG.calibrateRounds) {
                state.calibrateRound = nextRound;
                saveState(state);
                setTimeout(function() { calibrateRound(nextRound); }, 200);
            } else {
                state.phase = 'final';
                saveState(state);
                console.log('[自动提交] 校准完成, 进入决战调度');
                scheduleFinalReload();
            }
        });
    }

    function computeAvgRenderMs(samples) {
        // 函数名虽叫 "Avg", 实际返回的是 "保守预测的 reload 耗时", 用于决战刷新点 T - avg + safety
        // 设计原则: 开抢后刷新容易进入排队, 因此预测偏向慢的一侧, 让决战刷新尽量提前。
        // 兜底值: 1800ms 接近真实开抢时刻 reload 的典型耗时, 比原来的 1500ms 更保守
        if (!samples || samples.length === 0) return 1800;
        var sorted = samples.slice().sort(function(a, b) { return a - b; });
        var n = sorted.length;
        // (B) 只丢最快的 1 个样本 (通常是缓存命中等离群值), 保留所有较慢的样本
        //     原版同时丢最大最小, 等于主动剔除了最贴近真实开抢负载的样本
        var trimmed = (n >= 3) ? sorted.slice(1) : sorted;
        // (A) 取 P75 分位数而不是平均, 让 "实际耗时 > 预测" 的概率从 50% 降到约 25%
        var p75Idx = Math.ceil(trimmed.length * 0.75) - 1;
        p75Idx = Math.max(0, Math.min(p75Idx, trimmed.length - 1));
        return Math.round(trimmed[p75Idx]);
    }

    // 估算导航的上行单程耗时, 当前仅用于日志辅助判断。
    function computeUploadMs(uploadSamples) {
        if (!uploadSamples || uploadSamples.length === 0) return 50;
        var sorted = uploadSamples.slice().sort(function(a, b) { return a - b; });
        var n = sorted.length;
        var trimmed = (n >= 3) ? sorted.slice(1) : sorted;
        var p75Idx = Math.ceil(trimmed.length * 0.75) - 1;
        p75Idx = Math.max(0, Math.min(p75Idx, trimmed.length - 1));
        return Math.round(trimmed[p75Idx]);
    }

    function scheduleFinalReload() {
        var state = loadState() || {};
        var avg = computeAvgRenderMs(state.samples);
        var uploadMs = computeUploadMs(state.uploadSamples);
        var submitTs = new Date(CONFIG.submitTime).getTime();
        // v3.8 公式: reload 触发时刻 = T - renderP75 + safety
        //   含义: 按最近校准得到的页面渲染耗时提前刷新, 让按钮尽量在 T+safety 附近渲染完成。
        //   适用于开抢后刷新会进入排队的场景。
        var targetReloadTs = submitTs - avg + CONFIG.safetyMarginMs;
        var nowS = serverNow();
        var wait = targetReloadTs - nowS;

        console.log('[自动提交] 渲染耗时P75=' + avg + 'ms, 上行估算=' + uploadMs + 'ms (仅供参考), 安全余量=+' + CONFIG.safetyMarginMs + 'ms');
        console.log('[自动提交] 决战刷新点 = T-renderP75+safety = ' + new Date(targetReloadTs).toLocaleString() + '.' + (targetReloadTs % 1000) + ' (距现在' + wait + 'ms)');
        console.log('[自动提交] 预计按钮渲染完成 ≈ T+' + CONFIG.safetyMarginMs + 'ms');

        tlClear();
        tlMark('schedule-final', { avg: avg, uploadMs: uploadMs, safety: CONFIG.safetyMarginMs, targetReloadTs: targetReloadTs, waitMs: wait });

        if (wait < 0) {
            console.log('[自动提交] 已错过最佳刷新点 ' + (-wait) + 'ms, 立即刷新');
            state.phase = 'final-reloading';
            saveState(state);
            doRefresh();
            return;
        }

        precisionWaitUntil(targetReloadTs, function() {
            if (isExpired()) { console.log('[自动提交] 已过期'); clearState(); return; }
            console.log('[自动提交] 决战时刻到! 服务器时间 ' + new Date(serverNow()).toLocaleString() + ' 偏差' + (serverNow() - targetReloadTs) + 'ms');
            var s = loadState() || {};
            s.phase = 'final-reloading';
            saveState(s);
            doRefresh();
        });
    }

    function onFinalPageLoaded() {
        var state = loadState() || {};

        // ============ 加固: 防止残留 state 把脚本错误拉进决战阶段 ============
        // 触发条件: 距 T 还远超 (calibrateStartBefore + 缓冲), 不应该处于决战
        // 典型场景: 用户中途改了 submitTime, 但没清 localStorage; 或上一次决战后 state 没正常清理
        // 风险: 残留的 fallbackCount 会消耗本次开抢的兜底刷新次数; 决战路径上的逻辑也会跑错
        // 处理: 清掉 state, 回退到 runFlow 重新走"等校准 → 校准 → 决战"流程
        var _submitTs = new Date(CONFIG.submitTime).getTime();
        var _msToSubmit = _submitTs - serverNow();
        var _farThresholdMs = CONFIG.calibrateStartBefore * 1000 + 5000;
        if (_msToSubmit > _farThresholdMs) {
            console.log('[自动提交] [决战] ⚠️ 距 T 还有 ' + _msToSubmit + 'ms (> 阈值 ' + _farThresholdMs + 'ms), 不应在决战阶段, 判定为残留 state, 回退到正常流程');
            tlMark('stale-state-detected', { msToSubmit: _msToSubmit, threshold: _farThresholdMs, oldPhase: state.phase, oldFallbackCount: state.fallbackCount || 0 });
            clearState();
            clearReloadTimer();
            runFlow();
            return;
        }

        var fallbackCnt = state.fallbackCount || 0;
        var reloadElapsedMs = getReloadElapsedMs();
        console.log('[自动提交] 决战页面加载 (兜底刷新次数=' + fallbackCnt + '), 开始等待按钮可点击');
        tlMark('page-loaded', { fallback: fallbackCnt, reloadElapsedMs: reloadElapsedMs });

        // ============ 防御: 检测非本脚本触发的页面跳转 ============
        // 如果 reloadElapsedMs === -1, 说明 LOAD_START_KEY 没被写过, 这次跳转不是 doRefresh 触发的
        // (WPS 排队页/未开始页常常会自己 reload), 我们的精准定时被吹掉了
        // 注意: WPS 的提交按钮不会自动从 disabled 变成 enabled, 所以无论距开抢多远,
        // 留在当前页等都是浪费; 必须重排刷新把控制权抢回来
        if (reloadElapsedMs < 0) {
            var submitTs = new Date(CONFIG.submitTime).getTime();
            var msToSubmit = submitTs - serverNow();
            var avg = computeAvgRenderMs(state.samples);
            var uploadMs = computeUploadMs(state.uploadSamples);
            // v3.8: 重排需要预留一次完整渲染耗时, 否则开抢后刷新可能直接进入排队。
            var rescheduleMinMs = avg + 200;
            tlMark('ghost-reload-detected', { msToSubmit: msToSubmit, avg: avg, uploadMs: uploadMs, rescheduleMinMs: rescheduleMinMs });

            if (msToSubmit > rescheduleMinMs) {
                console.log('[自动提交] ⚠️ 检测到非本脚本触发的页面跳转 (reloadElapsedMs=-1), 距开抢' + msToSubmit + 'ms > ' + rescheduleMinMs + 'ms, 重新调度决战刷新');
                tlMark('reschedule-final', { msToSubmit: msToSubmit, mode: 'planned' });
                clearReloadTimer();
                var s = loadState() || {};
                s.phase = 'final';
                saveState(s);
                scheduleFinalReload();
                return;
            } else {
                // 剩余时间不够再做一次完整决战刷新, 但 WPS 按钮不会自动 enable, 继续等也没意义
                // 立即触发一次刷新, 哪怕略晚也比死等强
                console.log('[自动提交] ⚠️ 非本脚本触发的跳转, 距开抢仅' + msToSubmit + 'ms (<' + rescheduleMinMs + 'ms), WPS按钮不会自动启用, 立即刷新抢回控制权');
                tlMark('reschedule-final', { msToSubmit: msToSubmit, mode: 'immediate' });
                clearReloadTimer();
                var s2 = loadState() || {};
                s2.phase = 'final-reloading';
                saveState(s2);
                doRefresh();
                return;
            }
        }

        var st = Date.now();
        var rafSupported = typeof window.requestAnimationFrame === 'function';
        var elapsedFromReload = reloadElapsedMs;
        var lastLog = 0;
        var triggered = false;
        var btnRenderedMarked = false;

        function fallbackReload(reason) {
            if (triggered) return;
            triggered = true;
            if (fallbackCnt >= CONFIG.maxFallbackReloads) {
                console.log('[自动提交] [决战] 兜底刷新已达上限(' + CONFIG.maxFallbackReloads + '), 停在当前页面持续等待');
                fallbackCnt = CONFIG.maxFallbackReloads;
                triggered = false;
                requestAnimationFrame(check);
                return;
            }
            console.log('[自动提交] [决战] ' + reason + ', 触发第' + (fallbackCnt + 1) + '次兜底刷新');
            tlMark('fallback-reload', { reason: reason, count: fallbackCnt + 1 });
            clearReloadTimer();
            var s = loadState() || {};
            s.phase = 'final-reloading';
            s.fallbackCount = fallbackCnt + 1;
            saveState(s);
            setTimeout(doRefresh, 30);
        }

        function check() {
            if (isExpired()) { console.log('[自动提交] 已过期'); clearState(); clearReloadTimer(); return; }

            var el = Date.now() - st;
            var btn = findSubmitButton();
            var msToSubmit = new Date(CONFIG.submitTime).getTime() - serverNow();

            if (btn) {
                var ok = isButtonClickable(btn);
                var totalSinceReload = (elapsedFromReload >= 0) ? (elapsedFromReload + el) : el;
                if (!btnRenderedMarked) {
                    tlMark('button-rendered', { clickable: ok, sinceReloadMs: totalSinceReload });
                    btnRenderedMarked = true;
                }
                if (el - lastLog > 100) {
                    console.log('[自动提交] [决战] btn=found clickable=' + ok + ' 本轮' + el + 'ms 自reload起' + totalSinceReload + 'ms 距开抢' + msToSubmit + 'ms');
                    lastLog = el;
                }
                if (ok) {
                    tlMark('button-clickable', { sinceReloadMs: totalSinceReload, msToSubmit: msToSubmit });
                    clearReloadTimer();
                    doSubmitNow(btn);
                    return;
                }
                if (msToSubmit < -50 && fallbackCnt < CONFIG.maxFallbackReloads) {
                    fallbackReload('按钮已渲染但仍 disabled (开抢已过' + (-msToSubmit) + 'ms)');
                    return;
                }
            } else {
                if (el - lastLog > 200) {
                    console.log('[自动提交] [决战] 按钮未渲染 ' + el + 'ms 距开抢' + msToSubmit + 'ms');
                    lastLog = el;
                }
            }

            if (el >= CONFIG.finalRenderTimeoutMs && !btn) {
                fallbackReload('页面加载超时');
                return;
            }

            if (rafSupported) requestAnimationFrame(check);
            else setTimeout(check, CONFIG.checkInterval);
        }
        setTimeout(check, CONFIG.pageRenderWait);
    }

    function runFlow() {
        var submitTs = new Date(CONFIG.submitTime).getTime();
        var nowS = serverNow();
        var diff = submitTs - nowS;
        var state = loadState();

        console.log('[自动提交] 服务器当前时间约: ' + new Date(nowS).toLocaleString() + ' 距开始: ' + Math.floor(diff / 1000) + 's');

        if (state && state.active) {
            if (isExpired()) {
                console.log('[自动提交] 有旧状态但已过期, 清除');
                clearState();
                clearReloadTimer();
                return;
            }
            if (state.submitted) {
                tlMark('resume-after-submit');
                var generation = ++submitFlowGeneration;
                if (state.submitStatus === 'awaiting-result') {
                    console.log('[自动提交] \u5df2\u70b9\u51fb\u786e\u8ba4, \u7ee7\u7eed\u7b49\u5f85\u63d0\u4ea4\u7ed3\u679c...');
                    watchSubmissionResult(null, generation);
                } else {
                    console.log('[自动提交] \u5df2\u70b9\u51fb\u63d0\u4ea4, \u7ee7\u7eed\u7b49\u5f85\u786e\u8ba4\u5f39\u7a97...');
                    watchForConfirmDialog(generation);
                }
                return;
            }
            if (state.phase === 'calibrating') {
                onCalibrationPageLoaded(state);
                return;
            }
            if (state.phase === 'final' || state.phase === 'final-reloading') {
                onFinalPageLoaded();
                return;
            }
            console.log('[自动提交] 旧状态phase=' + state.phase + ', 清除重来');
            clearState();
        }

        if (diff <= 0 && !isExpired()) {
            console.log('[自动提交] 时间已过但未过期, 直接进入决战模式');
            saveState({ phase: 'final-reloading', active: true, samples: [] });
            doRefresh();
            return;
        }

        var calibrateStartTs = submitTs - CONFIG.calibrateStartBefore * 1000;

        if (diff > CONFIG.calibrateStartBefore * 1000) {
            var w = calibrateStartTs - serverNow();
            console.log('[自动提交] 距校准开始 ' + Math.floor(w / 1000) + 's, 进入两段式精准定时');
            precisionWaitUntil(calibrateStartTs, function() {
                if (isExpired()) { console.log('[自动提交] 已过期'); clearState(); return; }
                console.log('[自动提交] 校准开始时间到, 启动第一轮');
                saveState({ phase: 'calibrating', calibrateRound: 0, samples: [], active: true });
                calibrateRound(0);
            });
            return;
        }

        console.log('[自动提交] 距开抢仅 ' + Math.floor(diff / 1000) + 's, 启动校准');
        saveState({ phase: 'calibrating', calibrateRound: 0, samples: [], active: true });
        calibrateRound(0);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', main);
    } else {
        main();
    }
})();

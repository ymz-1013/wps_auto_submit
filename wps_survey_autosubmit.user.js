// ==UserScript==
// @name         WPS问卷自动提交
// @namespace    http://tampermonkey.net/
// @version      4.5
// @description  定时自动填写SKU并提交WPS问卷（v4.5：单次预加载和可靠快速重试）
// @author       You
// @match        https://f.wps.cn/ksform/*
// @match        https://f.kdocs.cn/ksform/*
// @grant        none
// @run-at       document-start
// @noframes
// ==/UserScript==

(function() {
    'use strict';

    if (window.top !== window.self) return;
    if (window.__wpsSurveyAutoSubmitLoaded) {
        console.log('[自动提交] 已存在运行实例，跳过重复加载');
        return;
    }
    window.__wpsSurveyAutoSubmitLoaded = true;

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

    console.log('[自动提交] 脚本已加载 v4.5');

    // ============ 配置区 ============
    var CONFIG = {
        enabled: true,
        submitTime: "2026-05-25 23:00:00",
        sku: "10080808557579",
        expireAfter: 60,
        pageRenderWait: 0,
        checkInterval: 16,
        timeSyncSamples: 5,
        precisionWindow: 1500,
        // ==== v4.5 precheck 卡点预加载 ====
        // T-3.5s 只刷新一次；开放校验 precheck 最早在 T+80ms 才真正发出。
        preloadLeadMs: 3500,
        precheckReleaseDelayMs: 80,
        finalRenderTimeoutMs: 8000,
        submitResultSettleMs: 800,
        submitResultTimeoutMs: 4000,
        failureDetectDelayMs: 650,
        retryCooldownMs: 250,
        retryIntervalMs: 80
    };

    var STORAGE_KEY = 'wps_auto_submit_state';
    var SERVER_TIME_DELTA_KEY = 'wps_auto_submit_delta';
    var LOAD_START_KEY = 'wps_auto_submit_load_start';
    var TIMELINE_KEY = 'wps_auto_submit_timeline';

    var serverTimeDelta = 0;
    var mainStarted = false;
    var finalScheduleRegistered = false;

    function saveState(s) { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); }
    function loadState() { try { var s = localStorage.getItem(STORAGE_KEY); return s ? JSON.parse(s) : null; } catch(e) { return null; } }
    function clearState() { localStorage.removeItem(STORAGE_KEY); }

    function saveDelta(d) { try { localStorage.setItem(SERVER_TIME_DELTA_KEY, String(d)); } catch(e) {} }
    function loadDelta() { try { var v = localStorage.getItem(SERVER_TIME_DELTA_KEY); return v ? parseInt(v, 10) : 0; } catch(e) { return 0; } }

    function serverNow() { return Date.now() + serverTimeDelta; }

    function isPrecheckUrl(url) {
        return /\/ksform\/api\/v3\/campaign\/[^/?]+\/precheck(?:[?#]|$)/.test(String(url || ''));
    }

    function getPrecheckReleaseTs(url) {
        if (!isPrecheckUrl(url)) return 0;
        var state = loadState();
        if (!state || !state.active || !state.finalReloadIssued || !state.precheckReleaseTs) return 0;
        return state.precheckReleaseTs;
    }

    function waitForServerTime(targetTs, callback) {
        function check() {
            var left = targetTs - (Date.now() + loadDelta());
            if (left <= 0) {
                callback();
                return;
            }
            setTimeout(check, left > 100 ? Math.min(left - 50, 500) : 2);
        }
        check();
    }

    function installPrecheckGate() {
        var nativeOpen = XMLHttpRequest.prototype.open;
        var nativeSend = XMLHttpRequest.prototype.send;

        XMLHttpRequest.prototype.open = function(_method, url) {
            this.__wpsRequestUrl = String(url || '');
            return nativeOpen.apply(this, arguments);
        };

        XMLHttpRequest.prototype.send = function() {
            var xhr = this;
            var args = Array.prototype.slice.call(arguments);
            var releaseTs = getPrecheckReleaseTs(xhr.__wpsRequestUrl);
            if (!releaseTs || Date.now() + loadDelta() >= releaseTs) {
                return nativeSend.apply(xhr, args);
            }

            var heldAt = Date.now() + loadDelta();
            console.log('[自动提交] precheck 已就绪, 暂存至 T+' + CONFIG.precheckReleaseDelayMs + 'ms');
            tlMark('precheck-held', { waitMs: releaseTs - heldAt });
            waitForServerTime(releaseTs, function() {
                console.log('[自动提交] 到达开放校验时刻, 释放 precheck');
                tlMark('precheck-released', { delayMs: (Date.now() + loadDelta()) - releaseTs });
                try {
                    nativeSend.apply(xhr, args);
                } catch (err) {
                    console.log('[自动提交] precheck 释放失败: ' + err.message);
                }
            });
        };

        if (window.fetch) {
            var nativeFetch = window.fetch;
            window.fetch = function(input) {
                var context = this;
                var args = Array.prototype.slice.call(arguments);
                var url = typeof input === 'string' ? input : (input && input.url);
                var releaseTs = getPrecheckReleaseTs(url);
                if (!releaseTs || Date.now() + loadDelta() >= releaseTs) {
                    return nativeFetch.apply(context, args);
                }
                console.log('[自动提交] fetch precheck 已就绪, 暂存至开放时刻');
                tlMark('precheck-held', { waitMs: releaseTs - (Date.now() + loadDelta()) });
                return new Promise(function(resolve, reject) {
                    waitForServerTime(releaseTs, function() {
                        tlMark('precheck-released', { delayMs: (Date.now() + loadDelta()) - releaseTs });
                        nativeFetch.apply(context, args).then(resolve, reject);
                    });
                });
            };
        }
    }

    serverTimeDelta = loadDelta();
    installPrecheckGate();

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
        'reload-skipped':        '⛔ 跳过重复刷新',
        'precheck-held':         '⏸ 暂存开放校验',
        'precheck-released':     '▶️ 释放开放校验',
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
        'ghost-reload-detected': '👻 检测到第三方刷新',
        'resume-after-submit':   '⏪ 提交后页面恢复'
    };
    // 事件 extra 的简短摘要(显示在右侧)
    function tlSummarize(type, extra) {
        if (!extra) return '';
        try {
            switch (type) {
                case 'schedule-final':
                    return '预加载提前 ' + extra.preloadLeadMs + 'ms, 等待 ' + extra.waitMs + 'ms';
                case 'precheck-held':
                    return '剩余 ' + extra.waitMs + 'ms';
                case 'precheck-released':
                    return '触发偏差 ' + extra.delayMs + 'ms';
                case 'reload-triggered':
                    return '阶段=' + extra.phase + (extra.fallback ? ', 兜底#' + extra.fallback : '');
                case 'reload-skipped':
                    return '原因=' + extra.reason;
                case 'page-loaded':
                    return 'reload耗时=' + (extra.reloadElapsedMs >= 0 ? extra.reloadElapsedMs + 'ms' : '未知(可能被第三方跳转)') + (extra.fallback ? ', 兜底#' + extra.fallback : '');
                case 'button-rendered':
                    return '可点击=' + (extra.clickable ? '是' : '否') + ', reload至此=' + extra.sinceReloadMs + 'ms';
                case 'button-clickable':
                    return 'reload至此=' + extra.sinceReloadMs + 'ms, 距T=' + extra.msToSubmit + 'ms';
                case 'ghost-reload-detected':
                    return '距开抢 ' + extra.msToSubmit + 'ms, 决战刷新已执行=' + (extra.finalReloadIssued ? '是' : '否');
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
        var finished = false;

        function once() {
            if (finished) return;
            var t0 = Date.now();
            var xhr = new XMLHttpRequest();
            var settled = false;
            function completeSample() {
                if (settled || finished) return;
                settled = true;
                done++;
                if (done >= n) finish();
                else setTimeout(once, 50);
            }
            try {
                xhr.open('HEAD', url, true);
                xhr.timeout = 3000;
                xhr.onreadystatechange = function() {
                    if (settled || finished) return;
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
                    completeSample();
                };
                xhr.onerror = completeSample;
                xhr.ontimeout = completeSample;
                xhr.send();
            } catch(e) {
                completeSample();
            }
        }

        function finish() {
            if (finished) return;
            finished = true;
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
        var finished = false;

        function finish() {
            if (finished) return;
            finished = true;
            if (cb) cb();
        }

        function probe() {
            if (finished) return;
            if (Date.now() >= deadline) {
                console.log('[自动提交] 边沿检测超时, 共发' + probeCount + '次请求未捕获跳变');
                finish();
                return;
            }
            var t0 = Date.now();
            var xhr = new XMLHttpRequest();
            try {
                xhr.open('HEAD', url + '&_=' + t0, true);
                xhr.timeout = 1000;
                xhr.onreadystatechange = function() {
                    if (finished) return;
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
                        finish();
                        return;
                    }
                    lastDateSec = serverSec;
                    lastT0 = t0;
                    setTimeout(probe, 0);
                };
                xhr.onerror = function() { if (!finished) setTimeout(probe, 50); };
                xhr.ontimeout = function() { if (!finished) setTimeout(probe, 50); };
                xhr.send();
            } catch(e) {
                if (!finished) setTimeout(probe, 50);
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
        if (!isVisibleNode(btn)) return false;
        if (btn.disabled) return false;
        if (btn.getAttribute('aria-disabled') === 'true') return false;
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
    var SUCCESS_TEXTS = [
        '\u63d0\u4ea4\u6210\u529f',
        '\u95ee\u5377\u5df2\u63d0\u4ea4',
        '\u60a8\u5df2\u63d0\u4ea4',
        '\u63d0\u4ea4\u5b8c\u6210',
        '\u611f\u8c22\u60a8\u7684\u53c2\u4e0e'
    ];

    function compactText(node) {
        return ((node && node.textContent) || '').replace(/\s+/g, '');
    }

    function containsSuccessText(node) {
        var text = compactText(node);
        for (var i = 0; i < SUCCESS_TEXTS.length; i++) {
            if (text.indexOf(SUCCESS_TEXTS[i]) >= 0) return true;
        }
        return false;
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
        var submitButton = findSubmitButton();
        if (submitButton && isVisibleNode(submitButton)) return true;
        var inputs = document.querySelectorAll('input, textarea');
        for (var i = 0; i < inputs.length; i++) {
            if (isVisibleNode(inputs[i]) && !inputs[i].disabled) return true;
        }
        return false;
    }

    function hasSuccessResult() {
        var nodes = document.querySelectorAll(
            'h1, h2, h3, [class*="success"], [class*="Success"], ' +
            '[class*="result"], [class*="Result"], [class*="finish"], ' +
            '[class*="Finish"], [class*="complete"], [class*="Complete"]'
        );
        for (var i = 0; i < nodes.length; i++) {
            if (!isVisibleNode(nodes[i])) continue;
            if (containsSuccessText(nodes[i])) return true;
        }

        if (!hasVisibleSubmitForm()) return containsSuccessText(document.body);
        return false;
    }

    function findVisibleFailureSurface(confirmInfo, ignoreChangedBaseline) {
        var surfaces = document.querySelectorAll(RESULT_SURFACE_SELECTOR);
        for (var i = 0; i < surfaces.length; i++) {
            var surface = surfaces[i];
            if (!isVisibleNode(surface)) continue;
            if (containsSuccessText(surface)) continue;
            var unchangedBaseline = false;
            var baseline = (confirmInfo && confirmInfo.baselineSurfaces) || [];
            for (var j = 0; j < baseline.length; j++) {
                if (baseline[j].node === surface &&
                    (ignoreChangedBaseline || baseline[j].text === compactText(surface))) {
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
        var waitingLogged = false;
        function waitForRetry() {
            if (retryGeneration !== submitFlowGeneration) return;
            if (isExpired()) {
                console.log('[自动提交] \u91cd\u8bd5\u65f6\u95f4\u5df2\u8fc7\u671f, \u505c\u6b62');
                clearState();
                clearReloadTimer();
                return;
            }
            if (surface && isVisibleNode(surface)) {
                dismissFailureSurface(surface);
            }

            var elapsed = Date.now() - startedAt;
            var button = findSubmitButton();
            if (elapsed >= CONFIG.retryCooldownMs && button && isButtonClickable(button)) {
                tlMark('submit-retry', { attempt: state.submitAttempt + 1 });
                doSubmitNow(button);
                return;
            }
            if (!waitingLogged && elapsed >= 2000) {
                waitingLogged = true;
                console.log('[自动提交] 失败后表单尚未恢复，继续原地等待，不刷新页面');
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

            if (elapsed >= CONFIG.failureDetectDelayMs) {
                var failureSurface = findVisibleFailureSurface(
                    confirmInfo,
                    elapsed < CONFIG.submitResultSettleMs
                );
                if (failureSurface) {
                    clearInterval(timer);
                    retrySubmission('result-surface-shown', failureSurface, generation);
                    return;
                }
            }
            if (elapsed < CONFIG.submitResultSettleMs) return;

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
            tlMark('reload-triggered', { phase: st.phase });
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
        if (mainStarted) {
            console.log('[自动提交] main 已启动，忽略重复调用');
            return;
        }
        mainStarted = true;

        if (isExpired()) {
            console.log('[自动提交] 已过期(' + CONFIG.submitTime + '+' + CONFIG.expireAfter + 's), 不执行');
            clearState();
            return;
        }

        console.log('=== WPS问卷自动提交 v4.5 ===');
        console.log('目标: ' + CONFIG.submitTime + ' SKU: ' + CONFIG.sku + ' 过期: +' + CONFIG.expireAfter + 's');

        serverTimeDelta = loadDelta();
        console.log('[自动提交] 加载缓存 delta=' + serverTimeDelta + 'ms (将立即重新校准)');

        var bootState = loadState();
        if (bootState && bootState.active && bootState.phase === 'final-reloading' &&
            bootState.finalReloadIssued) {
            console.log('[自动提交] 决战预加载页已启动，复用已同步时间并立即监听按钮');
            runFlow();
            return;
        }

        syncServerTime(CONFIG.timeSyncSamples, function() {
            refineWithEdgeDetection(1500, function() {
                runFlow();
            });
        });
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

    function scheduleFinalReload() {
        var state = loadState() || {};
        if (state.finalReloadIssued) {
            console.log('[自动提交] 决战刷新已经执行，跳过重复调度');
            tlMark('reload-skipped', { reason: 'final-reload-already-issued' });
            return;
        }
        if (finalScheduleRegistered) {
            console.log('[自动提交] 当前页面已注册决战定时器，跳过重复调度');
            tlMark('reload-skipped', { reason: 'schedule-already-registered' });
            return;
        }
        finalScheduleRegistered = true;

        var preloadLeadMs = CONFIG.preloadLeadMs;
        var submitTs = new Date(CONFIG.submitTime).getTime();
        var targetReloadTs = submitTs - preloadLeadMs;
        var precheckReleaseTs = submitTs + CONFIG.precheckReleaseDelayMs;
        var nowS = serverNow();
        var wait = targetReloadTs - nowS;

        console.log('[自动提交] 固定预加载提前量=' + preloadLeadMs + 'ms');
        console.log('[自动提交] 决战刷新点 = T-' + preloadLeadMs + 'ms; precheck释放点 = T+' + CONFIG.precheckReleaseDelayMs + 'ms');

        tlClear();
        tlMark('schedule-final', {
            preloadLeadMs: preloadLeadMs,
            targetReloadTs: targetReloadTs,
            precheckReleaseTs: precheckReleaseTs,
            waitMs: wait
        });

        state.precheckReleaseTs = precheckReleaseTs;
        state.finalReloadIssued = false;
        saveState(state);

        function issueFinalReload(reason) {
            var latest = loadState() || {};
            if (latest.finalReloadIssued) {
                console.log('[自动提交] ' + reason + '触发时发现决战刷新已执行，跳过');
                tlMark('reload-skipped', { reason: reason + '-already-issued' });
                return;
            }
            latest.phase = 'final-reloading';
            latest.precheckReleaseTs = precheckReleaseTs;
            latest.finalReloadIssued = true;
            saveState(latest);
            doRefresh();
        }

        if (wait < 0) {
            console.log('[自动提交] 已错过最佳刷新点 ' + (-wait) + 'ms, 立即刷新');
            issueFinalReload('过时调度');
            return;
        }

        precisionWaitUntil(targetReloadTs, function() {
            if (isExpired()) { console.log('[自动提交] 已过期'); clearState(); return; }
            console.log('[自动提交] 决战时刻到! 服务器时间 ' + new Date(serverNow()).toLocaleString() + ' 偏差' + (serverNow() - targetReloadTs) + 'ms');
            issueFinalReload('精准定时器');
        });
    }

    function onFinalPageLoaded() {
        var state = loadState() || {};

        // 防止用户修改 submitTime 后，旧的决战状态被错误沿用。
        var _submitTs = new Date(CONFIG.submitTime).getTime();
        var _msToSubmit = _submitTs - serverNow();
        var _farThresholdMs = CONFIG.preloadLeadMs + 5000;
        if (_msToSubmit > _farThresholdMs) {
            console.log('[自动提交] [决战] ⚠️ 距 T 还有 ' + _msToSubmit + 'ms (> 阈值 ' + _farThresholdMs + 'ms), 不应在决战阶段, 判定为残留 state, 回退到正常流程');
            tlMark('stale-state-detected', { msToSubmit: _msToSubmit, threshold: _farThresholdMs, oldPhase: state.phase });
            clearState();
            clearReloadTimer();
            runFlow();
            return;
        }

        var reloadElapsedMs = getReloadElapsedMs();
        console.log('[自动提交] 决战页面加载，开始等待按钮可点击');
        tlMark('page-loaded', { reloadElapsedMs: reloadElapsedMs });

        // 决战刷新已经发出后，即使导航标记因页面跳转丢失，也不能再次刷新。
        if (reloadElapsedMs < 0) {
            var msToSubmit = new Date(CONFIG.submitTime).getTime() - serverNow();
            tlMark('ghost-reload-detected', { msToSubmit: msToSubmit, finalReloadIssued: !!state.finalReloadIssued });
            if (state.finalReloadIssued) {
                console.log('[自动提交] 决战刷新已执行，忽略导航标记缺失并继续等待，禁止二次刷新');
            } else {
                console.log('[自动提交] 决战刷新尚未执行，重新计算唯一一次预加载刷新');
                state.phase = 'final';
                saveState(state);
                scheduleFinalReload();
                return;
            }
        }

        var st = Date.now();
        var rafSupported = typeof window.requestAnimationFrame === 'function';
        var elapsedFromReload = reloadElapsedMs;
        var lastLog = 0;
        var btnRenderedMarked = false;
        var renderTimeoutMarked = false;

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
            } else {
                if (el - lastLog > 200) {
                    console.log('[自动提交] [决战] 按钮未渲染 ' + el + 'ms 距开抢' + msToSubmit + 'ms');
                    lastLog = el;
                }
            }

            if (el >= CONFIG.finalRenderTimeoutMs && !btn && !renderTimeoutMarked) {
                renderTimeoutMarked = true;
                console.log('[自动提交] [决战] 页面加载超时，继续原地等待，不再刷新以避免进入排队');
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
            if (state && (state.phase === 'final' || state.phase === 'final-reloading')) {
                onFinalPageLoaded();
                return;
            }
            if (state) {
                console.log('[自动提交] 旧状态phase=' + state.phase + ', 清除重来');
                clearState();
            }
        }

        if (diff <= 0 && !isExpired()) {
            console.log('[自动提交] 时间已过但未过期, 直接进入决战模式');
            saveState({
                phase: 'final-reloading',
                active: true,
                precheckReleaseTs: submitTs + CONFIG.precheckReleaseDelayMs,
                finalReloadIssued: true
            });
            doRefresh();
            return;
        }

        console.log('[自动提交] 进入单次预加载调度，开抢前不再进行校准刷新');
        saveState({
            phase: 'final',
            active: true,
            precheckReleaseTs: submitTs + CONFIG.precheckReleaseDelayMs,
            finalReloadIssued: false
        });
        scheduleFinalReload();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', main);
    } else {
        main();
    }
})();

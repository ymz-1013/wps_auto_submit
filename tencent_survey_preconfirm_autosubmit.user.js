// ==UserScript==
// @name         腾讯问卷预抢确认框自动提交
// @namespace    http://tampermonkey.net/
// @version      1.3.1
// @description  循环刷新抢提交闪现，提前进入确认框，自动关闭暂未开始提示，开抢时确认
// @author       You
// @match        https://docs.qq.com/form/*
// @match        https://docs.qq.com/v1/form/*
// @match        https://docs.qq.com/wj/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    var CONFIG = {
        enabled: true,
        submitTime: '2026-05-27 14:59:00',
        sku: '10077227290300',

        huntStartBeforeMs: 60000,
        huntStopBeforeMs: 4000,
        fallbackRefreshBeforeMs: 2000,
        confirmAfterTMs: 30,

        pageDwellMs: 900,
        flashPollMs: 2,
        fallbackPollMs: 5,
        confirmPollMs: 10,
        confirmAppearTimeoutMs: 450,
        maxRefreshes: 100,

        timeSyncSamples: 5,
        edgeRefineMaxMs: 1500,
        expireAfterMs: 60000
    };

    var KEY_PREFIX = 'tencent_preconfirm_v1_';
    var STATE_KEY = KEY_PREFIX + 'state';
    var DELTA_KEY = KEY_PREFIX + 'server_delta';
    var LOG_KEY = KEY_PREFIX + 'logs';
    var CONFIG_KEY = CONFIG.submitTime + '|' + CONFIG.sku;
    var SESSION_ID = Date.now();

    var serverDelta = loadNumber(DELTA_KEY, 0);
    var reloadTimer = null;
    var hunterTimer = null;
    var hunterObserver = null;
    var skuTimer = null;
    var confirmTimer = null;
    var confirmObserver = null;
    var noticeTimer = null;
    var noticeObserver = null;
    var noticeLastActionAt = 0;
    var noticeLastMissingAt = 0;
    var submitAttempted = false;
    var confirmScheduled = false;
    var confirmationLocked = false;
    var stopped = false;

    function pad(value, width) {
        var text = String(value);
        while (text.length < (width || 2)) text = '0' + text;
        return text;
    }

    function formatTime(timestamp) {
        var date = new Date(timestamp);
        return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' +
               pad(date.getSeconds()) + '.' + pad(date.getMilliseconds(), 3);
    }

    function submitTimestamp() {
        return new Date(CONFIG.submitTime).getTime();
    }

    function serverNow() {
        return Date.now() + serverDelta;
    }

    function tOffset(timestamp) {
        var offset = Math.round(timestamp - submitTimestamp());
        return 'T' + (offset >= 0 ? '+' : '') + offset + 'ms';
    }

    function log(message) {
        var timestamp = Date.now();
        var line = '[' + formatTime(timestamp) + '][s=' + SESSION_ID + '] ' + message;
        console.log(line);
        try {
            var logs = JSON.parse(localStorage.getItem(LOG_KEY) || '[]');
            logs.push({ timestamp: timestamp, session: SESSION_ID, message: message });
            if (logs.length > 800) logs = logs.slice(logs.length - 800);
            localStorage.setItem(LOG_KEY, JSON.stringify(logs));
        } catch (e) {}
    }

    window.__preconfirmExportLogs = function() {
        var logs;
        try { logs = JSON.parse(localStorage.getItem(LOG_KEY) || '[]'); }
        catch (e) { logs = []; }
        var text = logs.map(function(item) {
            return '[' + formatTime(item.timestamp) + '][s=' + item.session + '] ' + item.message;
        }).join('\n');
        console.log(text);
        return text;
    };

    window.__preconfirmClearLogs = function() {
        localStorage.removeItem(LOG_KEY);
        console.clear();
        console.log('[预抢] 日志已清空');
    };

    function loadNumber(key, fallback) {
        try {
            var value = Number(localStorage.getItem(key));
            return isFinite(value) ? value : fallback;
        } catch (e) {
            return fallback;
        }
    }

    function loadState() {
        try {
            var state = JSON.parse(localStorage.getItem(STATE_KEY) || 'null');
            if (!state || state.configKey !== CONFIG_KEY) return null;
            return state;
        } catch (e) {
            return null;
        }
    }

    function saveState(state) {
        state.configKey = CONFIG_KEY;
        state.updatedAt = serverNow();
        localStorage.setItem(STATE_KEY, JSON.stringify(state));
    }

    function clearState() {
        localStorage.removeItem(STATE_KEY);
    }

    // #region debug-point D:network-diagnostic-helper
    var DEBUG_SERVER_URL = 'http://127.0.0.1:7777/event';
    var DEBUG_SESSION_ID = 'tencent-submit-loss';
    var debugNativeFetch = window.fetch;

    function debugRequestUrl(value) {
        try {
            var parsed = new URL(String(value), location.href);
            return parsed.origin + parsed.pathname;
        } catch (e) {
            return String(value || '').split('?')[0].slice(0, 300);
        }
    }

    function debugResponseText(value) {
        return String(value == null ? '' : value)
            .replace(/\s+/g, ' ')
            .slice(0, 1200);
    }

    function debugNetworkPhase() {
        var state = loadState();
        return state ? state.phase : 'none';
    }

    function shouldDebugNetwork(method, url) {
        var normalizedMethod = String(method || 'GET').toUpperCase();
        if (normalizedMethod === 'GET' || normalizedMethod === 'HEAD') return false;
        if (String(url || '').indexOf(DEBUG_SERVER_URL) === 0) return false;
        return Math.abs(serverNow() - submitTimestamp()) <= 120000 ||
               debugNetworkPhase() === 'submit-pending' ||
               debugNetworkPhase() === 'preconfirmed' ||
               debugNetworkPhase() === 'submitted';
    }

    function reportNetworkDiagnostic(kind, data) {
        var event = {
            sessionId: DEBUG_SESSION_ID,
            runId: 'pre-fix',
            hypothesisId: data.error ? 'E' : 'D',
            location: 'tencent_survey_preconfirm_autosubmit.user.js:network',
            msg: '[DEBUG] Tencent form network ' + kind,
            data: data,
            ts: Date.now()
        };

        try {
            var logs = JSON.parse(localStorage.getItem(LOG_KEY) || '[]');
            logs.push({
                timestamp: event.ts,
                session: SESSION_ID,
                message: '[网络诊断] ' + kind + ' ' + JSON.stringify(data)
            });
            if (logs.length > 800) logs = logs.slice(logs.length - 800);
            localStorage.setItem(LOG_KEY, JSON.stringify(logs));
        } catch (e) {}

        if (typeof debugNativeFetch === 'function') {
            try {
                debugNativeFetch.call(window, DEBUG_SERVER_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(event),
                    keepalive: true
                }).catch(function() {});
            } catch (e2) {}
        }
    }
    // #endregion

    // #region debug-point D:fetch-response
    function installFetchDiagnostics() {
        if (typeof debugNativeFetch !== 'function' ||
            window.fetch.__tencentNetworkDiagnostic) return;

        function diagnosticFetch(input, init) {
            var method = (init && init.method) ||
                (input && input.method) || 'GET';
            var rawUrl = typeof input === 'string'
                ? input
                : (input && input.url) || '';
            if (!shouldDebugNetwork(method, rawUrl)) {
                return debugNativeFetch.apply(this, arguments);
            }

            var startedAt = Date.now();
            var requestUrl = debugRequestUrl(rawUrl);
            var requestArgs = arguments;
            var requestThis = this;
            return debugNativeFetch.apply(requestThis, requestArgs).then(
                function(response) {
                    var common = {
                        method: String(method).toUpperCase(),
                        url: requestUrl,
                        status: response.status,
                        ok: response.ok,
                        durationMs: Date.now() - startedAt,
                        phase: debugNetworkPhase(),
                        serverTime: serverNow(),
                        tOffsetMs: Math.round(serverNow() - submitTimestamp())
                    };
                    try {
                        response.clone().text().then(function(text) {
                            common.response = debugResponseText(text);
                            reportNetworkDiagnostic('fetch-response', common);
                        }).catch(function(error) {
                            common.bodyReadError = String(error && error.message || error);
                            reportNetworkDiagnostic('fetch-response', common);
                        });
                    } catch (error) {
                        common.bodyReadError = String(error && error.message || error);
                        reportNetworkDiagnostic('fetch-response', common);
                    }
                    return response;
                },
                function(error) {
                    reportNetworkDiagnostic('fetch-error', {
                        method: String(method).toUpperCase(),
                        url: requestUrl,
                        durationMs: Date.now() - startedAt,
                        phase: debugNetworkPhase(),
                        serverTime: serverNow(),
                        tOffsetMs: Math.round(serverNow() - submitTimestamp()),
                        error: String(error && error.message || error)
                    });
                    throw error;
                }
            );
        }

        diagnosticFetch.__tencentNetworkDiagnostic = true;
        window.fetch = diagnosticFetch;
    }
    // #endregion

    // #region debug-point D:xhr-response
    function installXhrDiagnostics() {
        if (!window.XMLHttpRequest ||
            XMLHttpRequest.prototype.__tencentNetworkDiagnostic) return;

        var nativeOpen = XMLHttpRequest.prototype.open;
        var nativeSend = XMLHttpRequest.prototype.send;

        XMLHttpRequest.prototype.open = function(method, url) {
            this.__tencentDebugMethod = method;
            this.__tencentDebugUrl = url;
            return nativeOpen.apply(this, arguments);
        };

        XMLHttpRequest.prototype.send = function(body) {
            var xhr = this;
            var method = xhr.__tencentDebugMethod || 'GET';
            var rawUrl = xhr.__tencentDebugUrl || '';
            if (shouldDebugNetwork(method, rawUrl)) {
                var startedAt = Date.now();
                xhr.addEventListener('loadend', function() {
                    var response = '';
                    try {
                        if (!xhr.responseType || xhr.responseType === 'text') {
                            response = xhr.responseText;
                        } else if (xhr.responseType === 'json') {
                            response = JSON.stringify(xhr.response);
                        }
                    } catch (e) {
                        response = '[unreadable response]';
                    }
                    reportNetworkDiagnostic('xhr-response', {
                        method: String(method).toUpperCase(),
                        url: debugRequestUrl(xhr.responseURL || rawUrl),
                        status: xhr.status,
                        durationMs: Date.now() - startedAt,
                        phase: debugNetworkPhase(),
                        serverTime: serverNow(),
                        tOffsetMs: Math.round(serverNow() - submitTimestamp()),
                        requestBodyLength: typeof body === 'string' ? body.length : null,
                        response: debugResponseText(response),
                        error: xhr.status === 0 ? 'network-error-or-abort' : ''
                    });
                }, { once: true });
            }
            return nativeSend.apply(xhr, arguments);
        };

        XMLHttpRequest.prototype.__tencentNetworkDiagnostic = true;
    }
    // #endregion

    function installNetworkDiagnostics() {
        installFetchDiagnostics();
        installXhrDiagnostics();
    }

    function stopReloadTimer() {
        if (reloadTimer !== null) {
            clearTimeout(reloadTimer);
            reloadTimer = null;
        }
    }

    function stopHunter() {
        if (hunterTimer !== null) {
            clearInterval(hunterTimer);
            hunterTimer = null;
        }
        if (hunterObserver) {
            hunterObserver.disconnect();
            hunterObserver = null;
        }
    }

    function stopConfirmationWatcher() {
        if (confirmTimer !== null) {
            clearInterval(confirmTimer);
            confirmTimer = null;
        }
        if (confirmObserver) {
            confirmObserver.disconnect();
            confirmObserver = null;
        }
    }

    function exactText(node) {
        return ((node && node.textContent) || '').replace(/\s+/g, '');
    }

    function isVisible(node) {
        if (!node || node.nodeType !== 1) return false;
        if (node.offsetParent !== null) return true;
        return !!(node.getClientRects && node.getClientRects().length);
    }

    function isDialogNode(node) {
        if (!node || !node.closest) return false;
        return !!node.closest(
            '[role="dialog"],[role="alertdialog"],[class*="dialog"],' +
            '[class*="modal"],[class*="popup"],[class*="overlay"],[class*="mask"]'
        );
    }

    function findSkuInput() {
        var questions = document.querySelectorAll('.question,[data-qid]');
        for (var i = 0; i < questions.length; i++) {
            var question = questions[i];
            var titleNode = question.querySelector(
                '.question-title,[class*="question-title"],[class*="title"]'
            );
            var title = exactText(titleNode).replace(/^\*/, '');
            if (title !== 'SKU' && title !== '01SKU') continue;
            var input = question.querySelector('textarea,input:not([type="hidden"])');
            if (input) return input;
        }

        var inputs = document.querySelectorAll('textarea,input:not([type="hidden"])');
        for (var j = 0; j < inputs.length; j++) {
            var container = inputs[j].closest &&
                inputs[j].closest('.question,[data-qid],[class*="question"]');
            var text = exactText(container);
            if (/^\*?(?:01)?SKU/.test(text)) return inputs[j];
        }
        return null;
    }

    function setNativeValue(input, value) {
        var prototype = input.tagName === 'TEXTAREA'
            ? window.HTMLTextAreaElement.prototype
            : window.HTMLInputElement.prototype;
        var descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
        if (descriptor && descriptor.set) descriptor.set.call(input, value);
        else input.value = value;
    }

    function fillSku(reason) {
        var input = findSkuInput();
        if (!input) return false;
        try {
            input.disabled = false;
            input.readOnly = false;
            input.removeAttribute('disabled');
            input.removeAttribute('readonly');
            if (input.value !== CONFIG.sku) {
                setNativeValue(input, CONFIG.sku);
                try {
                    input.dispatchEvent(new InputEvent('input', {
                        bubbles: true,
                        inputType: 'insertFromPaste',
                        data: CONFIG.sku
                    }));
                } catch (e) {
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                }
                input.dispatchEvent(new Event('change', { bubbles: true }));
                input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: '0' }));
                log('[SKU] 已预填 (' + reason + ')');
            }
            return input.value === CONFIG.sku;
        } catch (e2) {
            log('[SKU] 预填异常: ' + e2.message);
            return false;
        }
    }

    function startSkuKeeper() {
        if (skuTimer !== null) return;
        fillSku('start');
        skuTimer = setInterval(function() {
            if (stopped || serverNow() > submitTimestamp() + 5000) {
                clearInterval(skuTimer);
                skuTimer = null;
                return;
            }
            fillSku('keepalive');
        }, 10);
    }

    function findSubmitButton() {
        var primary = document.querySelectorAll(
            'button,[role="button"],[class*="submit"],[class*="btn"]'
        );
        for (var i = 0; i < primary.length; i++) {
            if (!isVisible(primary[i]) || isDialogNode(primary[i])) continue;
            if (exactText(primary[i]) === '提交') return primary[i];
        }

        var fallback = document.querySelectorAll('div,span,a');
        for (var j = 0; j < fallback.length; j++) {
            if (!isVisible(fallback[j]) || isDialogNode(fallback[j])) continue;
            if (exactText(fallback[j]) === '提交') return fallback[j];
        }
        return null;
    }

    function isSubmitConfirmationText(text) {
        if (!text || text.indexOf('暂未开始') >= 0) return false;
        return text.indexOf('确认提交') >= 0 ||
               text.indexOf('是否提交') >= 0 ||
               text.indexOf('确定提交') >= 0 ||
               (text.indexOf('提交') >= 0 && text.indexOf('结果吗') >= 0);
    }

    function findConfirmationDialog() {
        var selectors =
            '[role="dialog"],[role="alertdialog"],[class*="dialog"],' +
            '[class*="modal"],[class*="popup"],[class*="overlay"],[class*="mask"]';
        var dialogs = document.querySelectorAll(selectors);
        var best = null;
        var bestLength = Infinity;
        var i;

        for (i = 0; i < dialogs.length; i++) {
            var dialogText = exactText(dialogs[i]);
            if (!isVisible(dialogs[i]) || !isSubmitConfirmationText(dialogText)) continue;
            if (dialogText.length < bestLength) {
                best = dialogs[i];
                bestLength = dialogText.length;
            }
        }
        if (best) return best;

        var prompts = document.querySelectorAll('div,section,article,p,span');
        for (i = 0; i < prompts.length; i++) {
            var prompt = prompts[i];
            var promptText = exactText(prompt);
            if (!isVisible(prompt) || promptText.length > 80 ||
                !isSubmitConfirmationText(promptText)) continue;

            var root = prompt;
            while (root.parentElement && root.parentElement !== document.body) {
                var parentText = exactText(root.parentElement);
                if (parentText.length > 300) break;
                root = root.parentElement;
                if (parentText.indexOf('取消') >= 0 &&
                    parentText.indexOf('确认') >= 0) return root;
            }
            return prompt.parentElement || prompt;
        }
        return null;
    }

    function findConfirmButton(scope) {
        var root = scope || document;
        var candidates = root.querySelectorAll(
            'button,[role="button"],[class*="btn"],[class*="button"],a,div,span'
        );
        var best = null;
        var bestScore = -1;
        for (var i = 0; i < candidates.length; i++) {
            var node = candidates[i];
            if (!isVisible(node)) continue;
            var text = exactText(node);
            if (text !== '确认' && text !== '确定' && text !== '确认提交') continue;
            if (!scope && !confirmationLocked && !isDialogNode(node)) continue;

            var score = 0;
            if (node.tagName === 'BUTTON') score += 4;
            if (node.getAttribute('role') === 'button') score += 3;
            var className = String(node.className || '').toLowerCase();
            if (className.indexOf('primary') >= 0) score += 2;
            if (className.indexOf('btn') >= 0 ||
                className.indexOf('button') >= 0) score += 1;
            if (score > bestScore) {
                best = node;
                bestScore = score;
            }
        }
        return best;
    }

    function clickNode(node) {
        try { node.focus(); } catch (e) {}
        try {
            node.dispatchEvent(new MouseEvent('mousedown', {
                bubbles: true, cancelable: true, view: window
            }));
            node.dispatchEvent(new MouseEvent('mouseup', {
                bubbles: true, cancelable: true, view: window
            }));
        } catch (e2) {}
        try { node.click(); }
        catch (e3) {
            node.dispatchEvent(new MouseEvent('click', {
                bubbles: true, cancelable: true, view: window
            }));
        }
    }

    function findNotStartedDialog() {
        var dialogs = document.querySelectorAll(
            '[role="dialog"],[role="alertdialog"],[class*="dialog"],' +
            '[class*="modal"],[class*="popup"]'
        );
        var best = null;
        var bestLength = Infinity;
        for (var i = 0; i < dialogs.length; i++) {
            var dialog = dialogs[i];
            if (!isVisible(dialog)) continue;
            var text = exactText(dialog);
            if (text.indexOf('收集暂未开始') < 0 &&
                text.indexOf('本次收集暂未开始') < 0) continue;
            if (text.length < bestLength) {
                best = dialog;
                bestLength = text.length;
            }
        }
        return best;
    }

    function hasNotStartedContext(node) {
        var current = node;
        var depth = 0;
        while (current && current !== document.body && depth < 12) {
            var text = exactText(current);
            if (text.indexOf('收集暂未开始') >= 0 ||
                text.indexOf('本次收集暂未开始') >= 0) return current;
            current = current.parentElement;
            depth++;
        }
        return null;
    }

    function findNotStartedAction() {
        var actions = document.querySelectorAll(
            'button,[role="button"],[class*="btn"],[class*="button"],a,div,span'
        );
        for (var i = 0; i < actions.length; i++) {
            var node = actions[i];
            if (!isVisible(node)) continue;
            var text = exactText(node);
            if (text !== '好的' && text !== '知道了' && text !== '我知道了') continue;
            if (hasNotStartedContext(node)) return node;
        }
        return null;
    }

    function closeNotStartedDialog(source) {
        var action = findNotStartedAction();
        if (action) {
            var actionNow = Date.now();
            if (actionNow - noticeLastActionAt < 200) return true;
            noticeLastActionAt = actionNow;
            log('[暂未开始弹窗] 点击 "' + exactText(action) + '" source=' + source);
            clickNode(action);
            return true;
        }

        var dialog = findNotStartedDialog();
        if (!dialog) return false;
        var now = Date.now();
        if (now - noticeLastActionAt < 200) return true;

        var closeCandidates = dialog.querySelectorAll(
            '[aria-label="关闭"],[aria-label="close"],[aria-label="Close"],' +
            '[class*="close"]'
        );
        for (var i = 0; i < closeCandidates.length; i++) {
            if (!isVisible(closeCandidates[i])) continue;
            noticeLastActionAt = now;
            log('[暂未开始弹窗] 关闭 X source=' + source);
            clickNode(closeCandidates[i]);
            return true;
        }

        var dialogActions = dialog.querySelectorAll(
            'button,[role="button"],[class*="btn"],[class*="button"],a'
        );
        for (var j = 0; j < dialogActions.length; j++) {
            if (!isVisible(dialogActions[j])) continue;
            var text = exactText(dialogActions[j]);
            if (text !== '好的' && text !== '知道了' && text !== '我知道了') continue;
            noticeLastActionAt = now;
            log('[暂未开始弹窗] 点击 "' + text + '" source=' + source);
            clickNode(dialogActions[j]);
            return true;
        }

        if (now - noticeLastMissingAt >= 1000) {
            noticeLastMissingAt = now;
            log('[暂未开始弹窗] 已识别，但未找到专属关闭控件');
        }
        return false;
    }

    function startNotStartedDialogGuard() {
        if (noticeTimer !== null) return;

        function inspect(source) {
            if (stopped || serverNow() > submitTimestamp() + 5000) {
                if (noticeTimer !== null) {
                    clearInterval(noticeTimer);
                    noticeTimer = null;
                }
                if (noticeObserver) {
                    noticeObserver.disconnect();
                    noticeObserver = null;
                }
                return;
            }
            closeNotStartedDialog(source);
        }

        noticeTimer = setInterval(function() { inspect('poll'); }, 20);
        function attach() {
            var root = document.documentElement;
            if (!root) {
                setTimeout(attach, 1);
                return;
            }
            noticeObserver = new MutationObserver(function() { inspect('mutation'); });
            noticeObserver.observe(root, { childList: true, subtree: true, characterData: true });
            inspect('start');
        }
        attach();
    }

    function scheduleAtServerTime(target, label, callback) {
        function tick() {
            var remaining = target - serverNow();
            if (remaining <= 0) {
                log('[定时] ' + label + ' 到点 ' + formatTime(serverNow()) +
                    ' ' + tOffset(serverNow()));
                callback();
                return;
            }
            var delay;
            if (remaining > 1000) delay = remaining - 500;
            else if (remaining > 50) delay = remaining - 20;
            else delay = Math.max(1, remaining);
            setTimeout(tick, delay);
        }
        tick();
    }

    function lockForConfirmation(dialog, source) {
        if (confirmationLocked) return;
        confirmationLocked = true;
        submitAttempted = true;
        stopReloadTimer();
        stopHunter();

        var state = loadState() || {};
        state.active = true;
        state.phase = 'preconfirmed';
        state.confirmSeenAt = serverNow();
        saveState(state);

        log('[确认框] 已识别并永久停止刷新 source=' + source + ' at=' +
            formatTime(serverNow()) + ' ' + tOffset(serverNow()) +
            ' text="' + exactText(dialog).slice(0, 120) + '"');
    }

    function armConfirmationWatcher() {
        if (confirmTimer !== null || confirmScheduled) return;

        function inspect(source) {
            var dialog = findConfirmationDialog();
            if (dialog) lockForConfirmation(dialog, source);

            var button = dialog
                ? (findConfirmButton(dialog) || findConfirmButton())
                : (confirmationLocked ? findConfirmButton() : null);
            if (!button) return;
            if (!confirmationLocked) {
                lockForConfirmation(dialog || button, source + '-button');
            }
            confirmScheduled = true;

            var state = loadState() || {};
            state.active = true;
            state.phase = 'preconfirmed';
            state.confirmSeenAt = serverNow();
            saveState(state);

            log('[确认框] 已获取 source=' + source + ' at=' +
                formatTime(serverNow()) + ' ' + tOffset(serverNow()));

            stopConfirmationWatcher();
            scheduleAtServerTime(
                submitTimestamp() + CONFIG.confirmAfterTMs,
                '点击二次确认',
                function() {
                    var latest = findConfirmButton() || button;
                    var clickedAt = serverNow();
                    log('[速度] 点击二次确认 at=' + formatTime(clickedAt) +
                        ' ' + tOffset(clickedAt));
                    clickNode(latest);
                    var done = loadState() || {};
                    done.active = false;
                    done.phase = 'submitted';
                    done.confirmClickedAt = clickedAt;
                    saveState(done);
                    stopped = true;
                }
            );
        }

        confirmTimer = setInterval(function() { inspect('poll'); }, CONFIG.confirmPollMs);
        function attach() {
            var root = document.documentElement;
            if (!root) {
                setTimeout(attach, 1);
                return;
            }
            confirmObserver = new MutationObserver(function() { inspect('mutation'); });
            confirmObserver.observe(root, { childList: true, subtree: true, characterData: true });
            inspect('start');
        }
        attach();
    }

    function reloadWithState(state, reason) {
        var dialog = findConfirmationDialog();
        if (dialog) lockForConfirmation(dialog, 'reload-guard');
        if (confirmationLocked || submitAttempted || confirmScheduled ||
            findConfirmButton()) {
            log('[刷新] 已进入提交链路，取消刷新 reason=' + reason);
            return;
        }
        saveState(state);
        log('[刷新] ' + reason + ' count=' + (state.refreshCount || 0) +
            ' at=' + formatTime(serverNow()) + ' ' + tOffset(serverNow()));
        location.reload();
    }

    function scheduleFallback() {
        var existingDialog = findConfirmationDialog();
        if (existingDialog) {
            lockForConfirmation(existingDialog, 'fallback-start');
            armConfirmationWatcher();
            return;
        }
        if (confirmationLocked) {
            armConfirmationWatcher();
            return;
        }
        stopReloadTimer();
        stopHunter();
        var state = loadState() || {};
        state.active = true;
        state.phase = 'fallback-wait';
        saveState(state);

        log('[兜底] T-4s 未获取确认框，停止循环刷新');
        scheduleAtServerTime(
            submitTimestamp() - CONFIG.fallbackRefreshBeforeMs,
            'T-2s 兜底刷新',
            function() {
                var dialog = findConfirmationDialog();
                if (dialog) lockForConfirmation(dialog, 'fallback-guard');
                if (confirmationLocked) return;
                var fallback = loadState() || {};
                fallback.active = true;
                fallback.phase = 'fallback';
                fillSku('before-fallback-refresh');
                reloadWithState(fallback, 'T-2s fallback');
            }
        );
    }

    function verifySubmitResult() {
        setTimeout(function() {
            var dialog = findConfirmationDialog();
            if (dialog) lockForConfirmation(dialog, 'submit-result');
            if (confirmationLocked) {
                armConfirmationWatcher();
                return;
            }

            submitAttempted = false;
            var cutoff = submitTimestamp() - CONFIG.huntStopBeforeMs;
            if (serverNow() < cutoff) {
                var retry = loadState() || {};
                retry.active = true;
                retry.phase = 'hunting';
                retry.refreshCount = (retry.refreshCount || 0) + 1;
                log('[提交] 点击后未出现确认框，继续下一轮');
                reloadWithState(retry, 'submit-no-confirm');
            } else {
                log('[提交] 点击后未出现确认框，已到预抢截止线');
                scheduleFallback();
            }
        }, CONFIG.confirmAppearTimeoutMs);
    }

    function trySubmit(source) {
        if (confirmationLocked || submitAttempted || confirmScheduled || stopped) {
            return false;
        }
        var button = findSubmitButton();
        if (!button) return false;
        if (!fillSku('before-submit')) {
            log('[提交] 看见提交按钮但 SKU 尚未就绪 source=' + source);
            return false;
        }

        submitAttempted = true;
        stopReloadTimer();
        var clickedAt = serverNow();
        var state = loadState() || {};
        state.active = true;
        state.phase = 'submit-pending';
        state.submitClickedAt = clickedAt;
        saveState(state);

        log('[速度] 点击提交按钮 source=' + source + ' at=' +
            formatTime(clickedAt) + ' ' + tOffset(clickedAt));
        armConfirmationWatcher();
        clickNode(button);
        verifySubmitResult();
        return true;
    }

    function startHunter(mode) {
        if (hunterTimer !== null || stopped) return;
        var interval = mode === 'fallback' ? CONFIG.fallbackPollMs : CONFIG.flashPollMs;
        log('[捕手] 启动 mode=' + mode + ' poll=' + interval + 'ms');

        function scan(source) {
            var dialog = findConfirmationDialog();
            if (dialog) {
                lockForConfirmation(dialog, mode + '-' + source);
                armConfirmationWatcher();
                return;
            }
            if (confirmationLocked || confirmScheduled || stopped) return;
            trySubmit(mode + '-' + source);
        }

        hunterTimer = setInterval(function() { scan('poll'); }, interval);
        function attach() {
            var root = document.documentElement;
            if (!root) {
                setTimeout(attach, 1);
                return;
            }
            hunterObserver = new MutationObserver(function() { scan('mutation'); });
            hunterObserver.observe(root, {
                childList: true,
                subtree: true,
                attributes: true,
                characterData: true,
                attributeFilter: ['disabled', 'class', 'style', 'aria-disabled']
            });
            scan('start');
        }
        attach();
    }

    function runHuntPage() {
        var state = loadState() || {};
        var cutoff = submitTimestamp() - CONFIG.huntStopBeforeMs;
        if (serverNow() >= cutoff || (state.refreshCount || 0) >= CONFIG.maxRefreshes) {
            scheduleFallback();
            return;
        }

        state.active = true;
        state.phase = 'hunting';
        saveState(state);
        startHunter('hunting');
        startSkuKeeper();

        var dwell = Math.min(CONFIG.pageDwellMs, Math.max(1, cutoff - serverNow()));
        reloadTimer = setTimeout(function() {
            var dialog = findConfirmationDialog();
            if (dialog) lockForConfirmation(dialog, 'hunt-dwell');
            if (confirmationLocked || submitAttempted || confirmScheduled ||
                findConfirmButton()) return;
            if (serverNow() >= cutoff) {
                scheduleFallback();
                return;
            }
            var next = loadState() || {};
            next.active = true;
            next.phase = 'hunting';
            next.refreshCount = (next.refreshCount || 0) + 1;
            reloadWithState(next, 'hunt-next');
        }, dwell);
    }

    function detectSuccessPage() {
        var text = ((document.body && document.body.innerText) || '').replace(/\s+/g, '');
        if (!text) return false;
        if (text.indexOf('已提交') < 0 && text.indexOf('提交成功') < 0) return false;
        log('[成功] 页面显示已提交 at=' + formatTime(serverNow()) + ' ' + tOffset(serverNow()));
        stopped = true;
        stopReloadTimer();
        stopHunter();
        stopConfirmationWatcher();
        clearState();
        return true;
    }

    function startSuccessObserver() {
        function inspect() { detectSuccessPage(); }
        function attach() {
            var root = document.documentElement;
            if (!root) {
                setTimeout(attach, 5);
                return;
            }
            var observer = new MutationObserver(inspect);
            observer.observe(root, { childList: true, subtree: true, characterData: true });
            inspect();
            setTimeout(function() { observer.disconnect(); }, CONFIG.expireAfterMs + 10000);
        }
        attach();
    }

    async function fetchServerSample() {
        var startedAt = Date.now();
        var url = location.href.split('#')[0];
        url += (url.indexOf('?') >= 0 ? '&' : '?') + '__preconfirm_sync=' +
               Date.now() + '_' + Math.random();
        var response = await fetch(url, {
            method: 'HEAD',
            cache: 'no-store',
            credentials: 'include'
        });
        var finishedAt = Date.now();
        var dateHeader = response.headers.get('Date');
        if (!dateHeader) throw new Error('响应没有 Date 头');
        var serverSecond = Date.parse(dateHeader);
        if (!isFinite(serverSecond)) throw new Error('Date 头无法解析');
        return {
            header: serverSecond,
            midpoint: (startedAt + finishedAt) / 2,
            rtt: finishedAt - startedAt
        };
    }

    function median(values) {
        values.sort(function(a, b) { return a - b; });
        return values[Math.floor(values.length / 2)];
    }

    async function calibrateServerTime() {
        var deltas = [];
        for (var i = 0; i < CONFIG.timeSyncSamples; i++) {
            try {
                var sample = await fetchServerSample();
                deltas.push(sample.header + 500 - sample.midpoint);
                log('[校时] sample=' + (i + 1) + ' rtt=' + sample.rtt +
                    'ms delta≈' + Math.round(deltas[deltas.length - 1]) + 'ms');
            } catch (e) {
                log('[校时] sample=' + (i + 1) + ' 失败: ' + e.message);
            }
        }
        if (deltas.length) serverDelta = Math.round(median(deltas));

        var refineStartedAt = Date.now();
        var previous = null;
        while (Date.now() - refineStartedAt < CONFIG.edgeRefineMaxMs) {
            try {
                var edge = await fetchServerSample();
                if (previous && edge.header > previous.header) {
                    var localBoundary = (previous.midpoint + edge.midpoint) / 2;
                    serverDelta = Math.round(edge.header - localBoundary);
                    log('[校时] 秒边沿精校成功 delta=' + serverDelta +
                        'ms interval=' + Math.round(edge.midpoint - previous.midpoint) + 'ms');
                    break;
                }
                previous = edge;
            } catch (e2) {
                break;
            }
        }

        localStorage.setItem(DELTA_KEY, String(serverDelta));
        log('[校时] 完成 server=' + formatTime(serverNow()) +
            ' delta=' + serverDelta + 'ms');
    }

    function recoverConfirmationState(state) {
        // These flags belong to this document; never reset an in-flight click
        // or a dialog captured by the early hunter while main() is starting.
        if (!state || !state.active || confirmationLocked ||
            submitAttempted || confirmScheduled || stopped) return state;
        if (state.phase !== 'preconfirmed' && state.phase !== 'submit-pending') {
            return state;
        }

        var dialog = findConfirmationDialog();
        if (dialog) {
            lockForConfirmation(dialog, 'resume-live-dialog');
            armConfirmationWatcher();
            return loadState();
        }

        // localStorage survives reloads; the old dialog and its timers do not.
        var previousPhase = state.phase;
        var now = serverNow();
        var target = submitTimestamp();
        if (now < target - CONFIG.huntStartBeforeMs) {
            state.phase = 'scheduled';
        } else if (now < target - CONFIG.huntStopBeforeMs &&
                   (state.refreshCount || 0) < CONFIG.maxRefreshes) {
            state.phase = 'hunting';
        } else if (now < target - CONFIG.fallbackRefreshBeforeMs) {
            state.phase = 'fallback-wait';
        } else {
            // Already reloaded at/after T-2s: monitor this page immediately.
            state.phase = 'fallback';
        }
        delete state.confirmSeenAt;
        delete state.submitClickedAt;
        saveState(state);
        log('[恢复] 新页面无确认框，清除历史状态 ' + previousPhase +
            ' -> ' + state.phase + ' ' + tOffset(now));
        return state;
    }

    function beginStrategy() {
        if (detectSuccessPage()) return;
        var now = serverNow();
        var target = submitTimestamp();
        if (!isFinite(target)) {
            log('[启动] submitTime 无法解析: ' + CONFIG.submitTime);
            return;
        }
        if (now > target + CONFIG.expireAfterMs) {
            log('[启动] 已超过有效期');
            clearState();
            return;
        }

        var state = loadState() || {
            active: true,
            phase: 'new',
            refreshCount: 0
        };

        if (state.phase === 'submitted') return;
        state = recoverConfirmationState(state);
        if (confirmationLocked || submitAttempted || confirmScheduled) {
            armConfirmationWatcher();
            return;
        }
        var existingDialog = findConfirmationDialog();
        if (existingDialog) {
            lockForConfirmation(existingDialog, 'strategy-live-dialog');
            armConfirmationWatcher();
            return;
        }
        if (state.phase === 'fallback') {
            startSkuKeeper();
            startHunter('fallback');
            armConfirmationWatcher();
            return;
        }
        if (state.phase === 'fallback-wait') {
            scheduleFallback();
            return;
        }

        var huntStart = target - CONFIG.huntStartBeforeMs;
        var huntStop = target - CONFIG.huntStopBeforeMs;
        if (now < huntStart) {
            state.active = true;
            state.phase = 'scheduled';
            state.refreshCount = 0;
            saveState(state);
            startSkuKeeper();
            log('[调度] 等待 T-' + CONFIG.huntStartBeforeMs + 'ms 开始循环刷新');
            scheduleAtServerTime(huntStart, '开始预抢循环', function() {
                var scheduled = loadState() || {};
                scheduled.active = true;
                scheduled.phase = 'hunting';
                scheduled.refreshCount = 0;
                reloadWithState(scheduled, 'hunt-start');
            });
            return;
        }
        if (now < huntStop) {
            state.active = true;
            state.phase = 'hunting';
            saveState(state);
            runHuntPage();
            return;
        }
        scheduleFallback();
    }

    async function main() {
        if (!CONFIG.enabled) return;
        var state = loadState();
        if (state && state.active) {
            log('[启动] 刷新恢复 phase=' + state.phase +
                ' count=' + (state.refreshCount || 0) +
                ' cachedDelta=' + serverDelta + 'ms');
            beginStrategy();
            return;
        }

        log('[启动] 首次运行，开始服务端校时');
        await calibrateServerTime();
        beginStrategy();
    }

    function bootEarly() {
        if (!CONFIG.enabled) return;
        startSuccessObserver();
        startNotStartedDialogGuard();
        startSkuKeeper();
        var state = loadState();
        if (!state || !state.active) return;
        var target = submitTimestamp();
        if (!isFinite(target) || serverNow() > target + CONFIG.expireAfterMs) return;
        state = recoverConfirmationState(state);
        if (confirmationLocked || stopped) return;
        if (state.phase === 'hunting') startHunter('hunting');
        if (state.phase === 'fallback') startHunter('fallback');
    }

    installNetworkDiagnostics();
    log('[预抢] standalone v1.3.1 loaded, cachedDelta=' + serverDelta + 'ms');
    bootEarly();

    var mainStarted = false;
    function startMain() {
        if (mainStarted) return;
        mainStarted = true;
        main().catch(function(error) {
            log('[启动] 异常: ' + (error && error.message));
        });
    }

    var bodyTimer = setInterval(function() {
        if (document.body || document.readyState !== 'loading') {
            clearInterval(bodyTimer);
            startMain();
        }
    }, 20);
    document.addEventListener('DOMContentLoaded', startMain);
    window.addEventListener('load', startMain);
})();

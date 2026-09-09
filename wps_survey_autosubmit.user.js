// ==UserScript==
// @name         WPS问卷自动提交
// @namespace    http://tampermonkey.net/
// @version      4.26
// @description  定时自动填写SKU并提交WPS问卷（v4.26：重复提交11001继续串行直提）
// @author       You
// @match        https://f.wps.cn/ksform/*
// @match        https://f.kdocs.cn/ksform/*
// @require      https://cdnjs.cloudflare.com/ajax/libs/crypto-js/4.2.0/crypto-js.min.js
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

    console.log('[自动提交] 脚本已加载 v4.26');

    // ============ 配置区 ============
    var CONFIG = {
        enabled: true,
        submitTime: "2026-09-02 11:39:00",
        sku: "10080808557579",
        expireAfter: 60,
        pageRenderWait: 0,
        checkInterval: 16,
        timeSyncSamples: 5,
        // ==== 首次 precheck 无刷新卡点 ====
        // 首个请求预计在 T+10ms 到达；重复请求依次晚 40ms 释放。
        precheckArrivalDelayMs: 10,
        duplicatePrecheckStepMs: 40,
        fallbackRttMs: 120,
        maxOneWayMs: 150,
        directSubmitEnabled: true,
        directArrivalDelayMs: 10,
        directRequestTimeoutMs: 1500,
        maxDirectAttempts: 30,
        directBusyRetryDelayMs: 250,
        directRateLimitRetryDelayMs: 1000,
        directRetryJitterMs: 100,
        directDecisionGraceMs: 150,
        directSuccessRedirectDelayMs: 80,
        maxDomSubmitAttempts: 5,
        queueDismissPollMs: 25,
        finalRenderTimeoutMs: 8000,
        submitResultSettleMs: 800,
        submitResultTimeoutMs: 4000,
        failureDetectDelayMs: 650
    };

    var STORAGE_KEY = 'wps_auto_submit_state';
    var SERVER_TIME_DELTA_KEY = 'wps_auto_submit_delta';
    var BEST_RTT_KEY = 'wps_auto_submit_best_rtt';
    var TIMELINE_KEY = 'wps_auto_submit_timeline';
    var NETWORK_LOG_KEY = 'wps_auto_submit_network_log';

    var serverTimeDelta = 0;
    var mainStarted = false;
    var precheckRequestCount = 0;
    var networkRequestSeq = 0;
    var nextNetworkSource = null;
    var directNetworkRecordId = '';
    var directSubmitState = CONFIG.directSubmitEnabled ? 'armed' : 'fallback';
    var directReleaseSchedulerStarted = false;
    var directAttemptCount = 0;
    var DIRECT_SKU_QUESTION_TYPES = ['input', 'numberText'];
    var DIRECT_QUEUE_BUSINESS_CODES = [10005, 11001, 13711];
    var DIRECT_TERMINAL_BUSINESS_CODES = [13016];
    var directContext = {
        aesKeyBase64: '',
        campaign: null,
        shareId: '',
        pendingResponses: []
    };

    function saveState(s) { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); }
    function loadState() { try { var s = localStorage.getItem(STORAGE_KEY); return s ? JSON.parse(s) : null; } catch(e) { return null; } }
    function clearState() { localStorage.removeItem(STORAGE_KEY); }

    function saveDelta(d) { try { localStorage.setItem(SERVER_TIME_DELTA_KEY, String(d)); } catch(e) {} }
    function loadDelta() { try { var v = localStorage.getItem(SERVER_TIME_DELTA_KEY); return v ? parseInt(v, 10) : 0; } catch(e) { return 0; } }
    function saveBestRtt(ms) { try { localStorage.setItem(BEST_RTT_KEY, String(ms)); } catch(e) {} }
    function loadBestRtt() {
        try {
            var value = parseInt(localStorage.getItem(BEST_RTT_KEY), 10);
            return isFinite(value) && value > 0 ? value : CONFIG.fallbackRttMs;
        } catch(e) {
            return CONFIG.fallbackRttMs;
        }
    }

    function serverNow() { return Date.now() + serverTimeDelta; }

    function markNextNetworkSource(source) {
        var marker = {
            source: source,
            expiresAt: Date.now() + 1000
        };
        nextNetworkSource = marker;
        setTimeout(function() {
            if (nextNetworkSource === marker) nextNetworkSource = null;
        }, 1000);
    }

    function consumeNetworkSource(method, rawUrl) {
        var marker = nextNetworkSource;
        if (!marker || Date.now() > marker.expiresAt) {
            if (marker) nextNetworkSource = null;
            return 'page';
        }
        var isCampaignSubmit = false;
        try {
            isCampaignSubmit = String(method || '').toUpperCase() === 'POST' &&
                /^\/ksform\/api\/v3\/campaign\/[^/]+$/.test(
                    new URL(String(rawUrl || ''), location.href).pathname
                );
        } catch(e) {}
        if (!isCampaignSubmit) return 'page';
        nextNetworkSource = null;
        return marker.source;
    }

    function calculateReleaseTs(bestRttMs, arrivalDelayMs) {
        var submitTs = new Date(CONFIG.submitTime).getTime();
        var rttMs = Number(bestRttMs);
        if (!isFinite(rttMs) || rttMs <= 0) rttMs = CONFIG.fallbackRttMs;
        var oneWayMs = Math.min(
            CONFIG.maxOneWayMs,
            Math.max(0, Math.round(rttMs / 2))
        );
        return submitTs - oneWayMs + arrivalDelayMs;
    }

    function calculatePrecheckReleaseTs(bestRttMs) {
        return calculateReleaseTs(bestRttMs, CONFIG.precheckArrivalDelayMs);
    }

    function calculateDirectReleaseTs(bestRttMs) {
        return calculateReleaseTs(bestRttMs, CONFIG.directArrivalDelayMs);
    }

    function armInitialPrecheckGate() {
        var submitTs = new Date(CONFIG.submitTime).getTime();
        if (!isFinite(submitTs)) return;
        var now = Date.now() + loadDelta();
        if (now > submitTs + CONFIG.expireAfter * 1000) return;

        var existing = loadState();
        if (existing && existing.active && existing.submitTime === CONFIG.submitTime &&
            (existing.submitted || existing.phase === 'manual-handoff' ||
             existing.phase === 'retry-exhausted' ||
             existing.phase === 'queue-waiting')) {
            return;
        }

        var bestRttMs = loadBestRtt();
        tlClear();
        networkClear();
        saveState({
            phase: 'armed',
            active: true,
            submitted: false,
            submitAttempt: 0,
            submitTime: CONFIG.submitTime,
            armedAt: now,
            bestRttMs: bestRttMs,
            precheckReleaseTs: calculatePrecheckReleaseTs(bestRttMs),
            directReleaseTs: calculateDirectReleaseTs(bestRttMs),
            directAttemptCount: 0
        });
        console.log('[自动提交] 已在 document-start 暂存首次 precheck 方案，页面不会自动刷新');
    }

    function isPrecheckUrl(url) {
        return /\/ksform\/api\/v3\/campaign\/[^/?]+\/precheck(?:[?#]|$)/.test(String(url || ''));
    }

    function getPrecheckReleaseTs(url, requestIndex) {
        if (!isPrecheckUrl(url)) return 0;
        var state = loadState();
        if (!state || !state.active || state.submitTime !== CONFIG.submitTime ||
            !state.precheckReleaseTs) return 0;
        var stepMs = Number(CONFIG.duplicatePrecheckStepMs);
        if (!isFinite(stepMs) || stepMs < 0) stepMs = 0;
        return state.precheckReleaseTs +
            Math.max(0, requestIndex || 0) * stepMs;
    }

    function markPrecheckGateStatus(status, ts) {
        var state = loadState();
        if (!state || state.submitTime !== CONFIG.submitTime) return;
        state.precheckGateStatus = status;
        if (status === 'held') state.precheckHeldAt = ts;
        if (status === 'released') state.precheckReleasedAt = ts;
        saveState(state);
    }

    function waitForPrecheckRelease(url, requestIndex, callback) {
        function check() {
            var targetTs = getPrecheckReleaseTs(url, requestIndex);
            if (!targetTs) {
                callback(0);
                return;
            }
            var left = targetTs - (Date.now() + loadDelta());
            if (left <= 0) {
                callback(targetTs);
                return;
            }
            setTimeout(check, left > 100 ? Math.min(left - 50, 500) : 2);
        }
        check();
    }

    function isDirectContextReady() {
        return !!(directContext.aesKeyBase64 &&
            directContext.campaign &&
            directContext.shareId);
    }

    function scheduleIndependentDirectSubmit() {
        if (directReleaseSchedulerStarted || !isDirectContextReady() ||
            directSubmitState !== 'armed' || !isDirectRunActive()) {
            return;
        }
        directReleaseSchedulerStarted = true;
        var state = loadState() || {};
        tlMark('direct-submit-armed', {
            releaseTs: state.directReleaseTs || 0,
            bestRttMs: state.bestRttMs || loadBestRtt(),
            expectedArrivalDelayMs: CONFIG.directArrivalDelayMs
        });

        function check() {
            if (directSubmitState !== 'armed' || !isDirectRunActive()) return;
            var latest = loadState();
            if (!latest || !latest.directReleaseTs) {
                enableDomFallback('direct-release-target-missing');
                return;
            }
            var left = latest.directReleaseTs - serverNow();
            if (left <= 0) {
                tlMark('direct-submit-released', {
                    delayMs: serverNow() - latest.directReleaseTs,
                    expectedArrivalDelayMs: CONFIG.directArrivalDelayMs
                });
                attemptDirectSubmit('independent-release', false);
                return;
            }
            setTimeout(check, left > 100 ? Math.min(left - 50, 500) : 2);
        }
        check();
    }

    function getHeaderValue(headers, name) {
        if (!headers) return '';
        var expected = String(name || '').toLowerCase();
        for (var key in headers) {
            if (Object.prototype.hasOwnProperty.call(headers, key) &&
                String(key).toLowerCase() === expected) {
                return String(headers[key] || '');
            }
        }
        return '';
    }

    function parseJson(text) {
        try { return JSON.parse(String(text || '')); } catch(e) { return null; }
    }

    function decryptApiBody(bodyText, responseHeaders) {
        var ivBase64 = getHeaderValue(responseHeaders, 'x-encrypt-iv');
        if (!ivBase64) return String(bodyText || '');
        if (!directContext.aesKeyBase64) throw new Error('AES key 尚未就绪');
        if (typeof CryptoJS === 'undefined') throw new Error('CryptoJS 未加载');

        var key = CryptoJS.enc.Base64.parse(directContext.aesKeyBase64);
        var iv = CryptoJS.enc.Base64.parse(ivBase64);
        var cipherParams = CryptoJS.lib.CipherParams.create({
            ciphertext: CryptoJS.enc.Base64.parse(String(bodyText || ''))
        });
        var decrypted = CryptoJS.AES.decrypt(cipherParams, key, {
            iv: iv,
            mode: CryptoJS.mode.OFB,
            padding: CryptoJS.pad.NoPadding
        });
        return CryptoJS.enc.Utf8.stringify(decrypted);
    }

    function encryptApiBody(plainText) {
        if (!directContext.aesKeyBase64) throw new Error('AES key 尚未就绪');
        if (typeof CryptoJS === 'undefined') throw new Error('CryptoJS 未加载');

        var key = CryptoJS.enc.Base64.parse(directContext.aesKeyBase64);
        var iv = CryptoJS.lib.WordArray.random(16);
        var encrypted = CryptoJS.AES.encrypt(
            CryptoJS.enc.Utf8.parse(String(plainText || '')),
            key,
            {
                iv: iv,
                mode: CryptoJS.mode.OFB,
                padding: CryptoJS.pad.NoPadding
            }
        );
        return {
            body: CryptoJS.enc.Base64.stringify(encrypted.ciphertext),
            iv: CryptoJS.enc.Base64.stringify(iv)
        };
    }

    function getCampaignRootMatch(method, rawUrl) {
        if (String(method || '').toUpperCase() !== 'GET') return null;
        try {
            return new URL(String(rawUrl || ''), location.href).pathname.match(
                /^\/ksform\/api\/v3\/campaign\/([^/]+)$/
            );
        } catch(e) {
            return null;
        }
    }

    function isDirectRunActive() {
        if (!CONFIG.enabled || !CONFIG.directSubmitEnabled || isExpired()) return false;
        var state = loadState();
        return !!(state && state.active && !state.submitted &&
            state.phase === 'armed' && state.submitTime === CONFIG.submitTime);
    }

    function storeDirectCampaign(payload, rawUrl) {
        if (!payload || payload.code !== 0 || !payload.data) return;
        var match = getCampaignRootMatch('GET', rawUrl);
        if (!match) return;
        directContext.campaign = payload.data;
        directContext.shareId = payload.data.shareId || match[1];
        console.log('[直提] 动态上下文已就绪: shareId=' +
            directContext.shareId + ', token=' +
            (payload.data.token ? '已获取' : '缺失'));
        tlMark('direct-context-ready', {
            shareId: directContext.shareId,
            tokenReady: !!payload.data.token
        });
        scheduleIndependentDirectSubmit();
    }

    function inspectDirectApiResponse(method, rawUrl, status, responseHeaders, bodyText,
                                      allowPending, networkRecordId) {
        if (!CONFIG.directSubmitEnabled) return;
        var url;
        try { url = new URL(String(rawUrl || ''), location.href); } catch(e) { return; }

        if (url.pathname === '/ksform/api/v3/config') {
            var configPayload = parseJson(bodyText);
            var aesKey = configPayload && configPayload.data &&
                configPayload.data.encrypt && configPayload.data.encrypt.aes_key;
            if (!aesKey) return;
            directContext.aesKeyBase64 = aesKey;
            console.log('[直提] AES 配置已就绪');
            var pending = directContext.pendingResponses.slice();
            directContext.pendingResponses.length = 0;
            for (var i = 0; i < pending.length; i++) {
                inspectDirectApiResponse(
                    pending[i].method,
                    pending[i].url,
                    pending[i].status,
                    pending[i].headers,
                    pending[i].body,
                    false,
                    pending[i].networkRecordId
                );
            }
            scheduleIndependentDirectSubmit();
            return;
        }

        var campaignMatch = getCampaignRootMatch(method, rawUrl);
        var precheck = isPrecheckUrl(rawUrl) &&
            String(method || '').toUpperCase() === 'POST';
        if (!campaignMatch && !precheck) return;

        var decoded;
        try {
            decoded = decryptApiBody(bodyText, responseHeaders);
        } catch(err) {
            if (allowPending !== false && !directContext.aesKeyBase64) {
                directContext.pendingResponses.push({
                    method: method,
                    url: rawUrl,
                    status: status,
                    headers: responseHeaders,
                    body: bodyText,
                    networkRecordId: networkRecordId
                });
                return;
            }
            if (precheck) {
                console.log('[直提] precheck 响应解密失败，不影响独立直提: ' +
                    err.message);
            }
            return;
        }

        var payload = parseJson(decoded);
        if (networkRecordId) {
            networkUpdate(networkRecordId, {
                decryptedResponseBody: decoded,
                businessCode: payload && payload.code,
                businessResult: payload && payload.result
            });
        }
        if (campaignMatch) {
            storeDirectCampaign(payload, rawUrl);
            return;
        }
        if (!precheck) return;

        tlMark('direct-precheck-result', {
            httpStatus: status,
            code: payload && payload.code,
            result: payload && payload.result
        });
        console.log('[直提] precheck 仅作为诊断信号，独立直提不等待该响应');
    }

    function findSkuQuestion(campaign) {
        var questionMap = campaign && campaign.questionMap;
        if (!questionMap) return null;
        var fallback = null;
        for (var qid in questionMap) {
            if (!Object.prototype.hasOwnProperty.call(questionMap, qid)) continue;
            var question = questionMap[qid] || {};
            if (DIRECT_SKU_QUESTION_TYPES.indexOf(question.type) < 0) continue;
            if (!fallback) fallback = { qid: qid, question: question };
            var title = String(question.title || '').toLowerCase();
            if (title.indexOf('sku') >= 0) {
                return { qid: qid, question: question };
            }
        }
        return fallback;
    }

    function buildDirectSubmitPayload() {
        var campaign = directContext.campaign;
        if (!campaign) throw new Error('campaign 数据缺失');
        if (!campaign.token) throw new Error('campaign token 缺失');

        var skuQuestion = findSkuQuestion(campaign);
        if (!skuQuestion) throw new Error('未找到 SKU 输入题');
        var commitConfig = campaign.setting && campaign.setting.baseSetting &&
            campaign.setting.baseSetting.commitConfig;
        var options = commitConfig && commitConfig.options;
        if (!options || !options.length || !options[0].id) {
            throw new Error('提交按钮 optionId 缺失');
        }
        var loadStartedAt = typeof performance !== 'undefined' &&
            performance.timeOrigin ? performance.timeOrigin : Date.now();
        var answers = {};
        answers[skuQuestion.qid] = {
            type: skuQuestion.question.type,
            strValue: String(CONFIG.sku)
        };
        return {
            answerJson: {
                answersProperty: {
                    presetKeyId: '',
                    presetKeyValue: '',
                    commitInfo: {
                        optionId: options[0].id,
                        optionText: ''
                    }
                },
                answers: answers,
                consumeTime: Math.max(0, Math.round(
                    (Date.now() - loadStartedAt) / 1000
                ))
            },
            phoneNumber: '',
            editVersion: Number(campaign.editVersion) || 0,
            token: campaign.token,
            _t: Date.now()
        };
    }

    function enableDomFallback(reason) {
        if (directSubmitState === 'succeeded' ||
            directSubmitState === 'terminal' ||
            directSubmitState === 'fallback') return;
        directSubmitState = 'fallback';
        var state = loadState() || {};
        state.active = true;
        state.submitted = false;
        state.phase = 'armed';
        state.submitStatus = 'dom-fallback';
        state.directFallbackReason = reason;
        saveState(state);
        tlMark('direct-submit-fallback', { reason: reason });
        console.log('[直提] 失败，切换 DOM 兜底: ' + reason);
    }

    function buildDirectSuccessUrl(data) {
        var share = data && data.answerShare;
        var params = new URLSearchParams();
        params.set('time', String(Date.now()));
        params.set('answerId', String(data.aid || ''));
        if (share && share.asid) params.set('answerShareId', String(share.asid));
        if (share && share.expiredTs) params.set('expiredTs', String(share.expiredTs));
        return location.origin + '/ksform/w/write-success/' +
            encodeURIComponent(directContext.shareId) + '?' + params.toString();
    }

    function isDirectQueueResponse(response, payload, decoded) {
        if (response && (response.status === 429 || response.status === 503)) {
            return true;
        }
        var businessCode = Number(payload && payload.code);
        if (DIRECT_QUEUE_BUSINESS_CODES.indexOf(businessCode) >= 0) {
            return true;
        }
        var text = [
            payload && payload.result,
            payload && payload.message,
            payload && payload.msg,
            payload && payload.data && payload.data.result,
            payload && payload.data && payload.data.message,
            payload && payload.data && payload.data.msg,
            decoded
        ].join(' ').replace(/\s+/g, '');
        return text.indexOf('\u8bbf\u95ee\u4eba\u6570\u8f83\u591a') >= 0 ||
            text.indexOf('\u6392\u961f\u7b49\u5f85\u4e2d') >= 0 ||
            text.indexOf('\u670d\u52a1\u7e41\u5fd9\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5') >= 0;
    }

    function isDirectTerminalResponse(payload) {
        return DIRECT_TERMINAL_BUSINESS_CODES.indexOf(
            Number(payload && payload.code)
        ) >= 0;
    }

    function isDirectRateLimitResponse(response, payload, decoded) {
        if (response && response.status === 429) return true;
        if (Number(payload && payload.code) === 13711) return true;
        var text = String(decoded || '').toLowerCase();
        return text.indexOf('qps limit') >= 0 ||
            text.indexOf('\u8bf7\u6c42\u8fc7\u4e8e\u9891\u7e41') >= 0;
    }

    function getDirectQueueRetryDelay(response, payload, decoded) {
        var baseDelay = isDirectRateLimitResponse(response, payload, decoded) ?
            CONFIG.directRateLimitRetryDelayMs :
            CONFIG.directBusyRetryDelayMs;
        var jitter = Math.max(0, Number(CONFIG.directRetryJitterMs) || 0);
        return Math.max(0, Number(baseDelay) || 0) +
            Math.floor(Math.random() * (jitter + 1));
    }

    function stopDirectQueueRetries(reason, response, payload, attemptNo) {
        directSubmitState = 'terminal';
        var state = loadState() || {};
        state.active = true;
        state.submitted = false;
        state.phase = 'manual-handoff';
        state.submitStatus = 'direct-queue-exhausted';
        state.directAttemptCount = attemptNo;
        state.directQueueStopReason = reason;
        state.directLastQueueCode = payload && payload.code;
        state.directLastQueueResult = payload && payload.result;
        saveState(state);
        tlMark('direct-queue-exhausted', {
            attempt: attemptNo,
            maxAttempts: CONFIG.maxDirectAttempts,
            reason: reason,
            httpStatus: response && response.status,
            code: payload && payload.code,
            result: payload && payload.result
        });
        console.log('[直提] 排队直提结束，不切换 DOM: ' + reason);
    }

    function completeDirectSubmit(response, rawBody, startedAt, plainRequest,
                                  attemptNo, networkRecordId) {
        var responseHeaders = headersToObject(response.headers);
        var decoded;
        try {
            decoded = decryptApiBody(rawBody, responseHeaders);
        } catch(err) {
            if (networkRecordId) {
                networkUpdate(networkRecordId, {
                    decryptedRequestBody: plainRequest,
                    decryptedResponseError: err.message
                });
            }
            enableDomFallback('direct-response-decrypt-failed: ' + err.message);
            return;
        }
        var payload = parseJson(decoded);
        if (networkRecordId) {
            networkUpdate(networkRecordId, {
                decryptedRequestBody: plainRequest,
                decryptedResponseBody: decoded,
                businessCode: payload && payload.code,
                businessResult: payload && payload.result,
                directAttempt: attemptNo
            });
        }
        tlMark('direct-submit-response', {
            attempt: attemptNo,
            httpStatus: response.status,
            code: payload && payload.code,
            result: payload && payload.result,
            durationMs: Date.now() - startedAt
        });

        var data = payload && payload.data;
        if (response.ok && payload && payload.code === 0 && data && data.aid) {
            directSubmitState = 'succeeded';
            var state = loadState() || {};
            state.active = true;
            state.submitted = true;
            state.phase = 'direct-succeeded';
            state.submitStatus = 'direct-succeeded';
            state.directAnswerId = data.aid;
            state.directAttemptCount = attemptNo;
            saveState(state);
            tlMark('direct-submit-success', {
                attempt: attemptNo,
                answerId: data.aid,
                durationMs: Date.now() - startedAt
            });
            tlMark('submit-done', { from: 'direct-api', source: 'direct-api' });
            console.log('[直提] 提交成功，答案ID=' + data.aid);
            setTimeout(function() {
                tlPrintReport();
                printNetworkLogs();
                location.assign(buildDirectSuccessUrl(data));
            }, CONFIG.directSuccessRedirectDelayMs);
            return;
        }

        if (isDirectTerminalResponse(payload)) {
            directSubmitState = 'terminal';
            var terminalState = loadState() || {};
            terminalState.active = true;
            terminalState.submitted = false;
            terminalState.phase = 'retry-exhausted';
            terminalState.submitStatus = 'direct-terminal';
            terminalState.directAttemptCount = attemptNo;
            terminalState.directTerminalCode = payload && payload.code;
            terminalState.directTerminalResult = payload && payload.result;
            saveState(terminalState);
            tlMark('direct-submit-terminal', {
                attempt: attemptNo,
                httpStatus: response.status,
                code: payload && payload.code,
                result: payload && payload.result
            });
            console.log('[直提] 服务端返回终态，不再发送无效请求: code=' +
                (payload && payload.code) + ', result=' +
                (payload && payload.result));
            return;
        }

        if (isDirectQueueResponse(response, payload, decoded)) {
            if (attemptNo < CONFIG.maxDirectAttempts && !isExpired()) {
                var retryDelayMs = getDirectQueueRetryDelay(
                    response,
                    payload,
                    decoded
                );
                var retryKind = isDirectRateLimitResponse(
                    response,
                    payload,
                    decoded
                ) ? 'rate-limit' : 'busy';
                directSubmitState = 'retrying';
                var retryState = loadState() || {};
                retryState.active = true;
                retryState.submitted = false;
                retryState.phase = 'direct-submitting';
                retryState.submitStatus = 'direct-queue-retry';
                retryState.directAttemptCount = attemptNo;
                retryState.directLastQueueCode = payload && payload.code;
                retryState.directLastQueueResult = payload && payload.result;
                saveState(retryState);
                tlMark('direct-queue-retry', {
                    completedAttempt: attemptNo,
                    nextAttempt: attemptNo + 1,
                    maxAttempts: CONFIG.maxDirectAttempts,
                    httpStatus: response.status,
                    code: payload && payload.code,
                    result: payload && payload.result,
                    retryKind: retryKind,
                    delayMs: retryDelayMs
                });
                console.log('[直提] 第' + attemptNo +
                    '次返回' + retryKind + '，上一请求已结束，等待' +
                    retryDelayMs +
                    'ms后串行发起第' + (attemptNo + 1) + '次');
                setTimeout(function() {
                    attemptDirectSubmit('queue-response', true);
                }, retryDelayMs);
                return;
            }
            stopDirectQueueRetries(
                isExpired() ? 'expired' : 'max-attempts',
                response,
                payload,
                attemptNo
            );
            return;
        }

        enableDomFallback(
            'direct-business-rejected: HTTP ' + response.status +
            ', code=' + (payload ? payload.code : 'unknown') +
            ', result=' + (payload ? payload.result : decoded)
        );
    }

    function attemptDirectSubmit(trigger, isRetry) {
        var persisted = loadState();
        if (isRetry) {
            if (directSubmitState !== 'retrying' || !persisted ||
                !persisted.active || persisted.submitted ||
                persisted.phase !== 'direct-submitting' ||
                persisted.submitTime !== CONFIG.submitTime || isExpired()) {
                return;
            }
        } else if (directSubmitState !== 'armed' || !isDirectRunActive()) {
            return;
        }
        if (directAttemptCount >= CONFIG.maxDirectAttempts) {
            stopDirectQueueRetries(
                'max-attempts-before-send',
                null,
                null,
                directAttemptCount
            );
            return;
        }
        var payload;
        var encrypted;
        try {
            payload = buildDirectSubmitPayload();
            encrypted = encryptApiBody(JSON.stringify(payload));
        } catch(err) {
            enableDomFallback('direct-build-failed: ' + err.message);
            return;
        }

        var attemptNo = directAttemptCount + 1;
        directAttemptCount = attemptNo;
        directSubmitState = 'sending';
        directNetworkRecordId = '';
        markNextNetworkSource('direct-api');
        var endpoint = 'https://f-api.wps.cn/ksform/api/v3/campaign/' +
            encodeURIComponent(directContext.shareId);
        var startedAt = Date.now();
        var xhr = new XMLHttpRequest();
        var settled = false;
        var networkRecordId = '';
        var plainRequest = JSON.stringify(payload);

        function failDirectRequest(type, reason) {
            if (settled) return;
            settled = true;
            tlMark(type, {
                attempt: attemptNo,
                durationMs: Date.now() - startedAt,
                reason: reason
            });
            if (networkRecordId) {
                networkUpdate(networkRecordId, {
                    decryptedRequestBody: plainRequest,
                    directAttempt: attemptNo,
                    directFailureType: type
                });
            }
            enableDomFallback(reason);
        }

        try {
            xhr.open('POST', endpoint, true);
            xhr.withCredentials = true;
            xhr.timeout = CONFIG.directRequestTimeoutMs;
            xhr.setRequestHeader('Accept', 'application/json, text/plain, */*');
            xhr.setRequestHeader(
                'Content-Type',
                'application/json; charset=utf-8'
            );
            xhr.setRequestHeader('X-Encrypt-ALG', 'aes-128-ofb');
            xhr.setRequestHeader('X-Encrypt-IV', encrypted.iv);
            xhr.onload = function() {
                if (settled) return;
                settled = true;
                var responseHeaders = parseXhrResponseHeaders(
                    xhr.getAllResponseHeaders()
                );
                completeDirectSubmit(
                    {
                        status: xhr.status,
                        ok: xhr.status >= 200 && xhr.status < 300,
                        headers: responseHeaders
                    },
                    xhr.responseText,
                    startedAt,
                    plainRequest,
                    attemptNo,
                    networkRecordId
                );
            };
            xhr.ontimeout = function() {
                failDirectRequest(
                    'direct-xhr-timeout',
                    'direct-xhr-timeout: ' +
                    CONFIG.directRequestTimeoutMs + 'ms'
                );
            };
            xhr.onerror = function() {
                failDirectRequest(
                    'direct-xhr-error',
                    'direct-xhr-error: HTTP ' + xhr.status
                );
            };
            xhr.onabort = function() {
                failDirectRequest(
                    'direct-xhr-abort',
                    'direct-xhr-abort'
                );
            };
            xhr.send(encrypted.body);
        } catch(err) {
            nextNetworkSource = null;
            failDirectRequest(
                'direct-xhr-error',
                'direct-xhr-threw: ' + err.message
            );
            return;
        }
        networkRecordId = directNetworkRecordId;

        var state = loadState() || {};
        state.active = true;
        state.submitted = false;
        state.phase = 'direct-submitting';
        state.submitStatus = 'direct-submitting';
        state.directAttemptCount = attemptNo;
        saveState(state);
        if (networkRecordId) {
            networkUpdate(networkRecordId, {
                decryptedRequestBody: plainRequest,
                directAttempt: attemptNo
            });
        }
        tlMark('direct-submit-start', {
            attempt: attemptNo,
            maxAttempts: CONFIG.maxDirectAttempts,
            trigger: trigger || '',
            endpoint: endpoint,
            qid: Object.keys(payload.answerJson.answers)[0],
            networkRecordId: networkRecordId
        });
        console.log('[直提] 已发起第' + attemptNo + '/' +
            CONFIG.maxDirectAttempts + '次XHR加密提交请求，超时=' +
            CONFIG.directRequestTimeoutMs + 'ms，触发=' +
            (trigger || 'unknown'));
    }

    function networkLoad() {
        try {
            var value = localStorage.getItem(NETWORK_LOG_KEY);
            return value ? JSON.parse(value) : [];
        } catch(e) {
            return [];
        }
    }

    function networkSave(records) {
        var copy = records.slice();
        while (copy.length) {
            try {
                localStorage.setItem(NETWORK_LOG_KEY, JSON.stringify(copy));
                return;
            } catch(e) {
                copy.shift();
            }
        }
        try { localStorage.removeItem(NETWORK_LOG_KEY); } catch(e2) {}
    }

    function networkClear() {
        try { localStorage.removeItem(NETWORK_LOG_KEY); } catch(e) {}
    }

    function networkUpdate(id, patch) {
        var records = networkLoad();
        for (var i = 0; i < records.length; i++) {
            if (records[i].id !== id) continue;
            for (var key in patch) {
                if (Object.prototype.hasOwnProperty.call(patch, key)) {
                    records[i][key] = patch[key];
                }
            }
            networkSave(records);
            return records[i];
        }
        return null;
    }

    function shouldObserveNetwork(method, rawUrl) {
        try {
            var parsed = new URL(String(rawUrl || ''), location.href);
            var isWpsHost = /(^|\.)wps\.cn$/i.test(parsed.hostname) ||
                /(^|\.)kdocs\.cn$/i.test(parsed.hostname);
            if (!isWpsHost) return false;
            if (/\/ksform\/api\//i.test(parsed.pathname)) return true;
            return /^(POST|PUT|PATCH|DELETE)$/i.test(String(method || ''));
        } catch(e) {
            return /\/ksform\/api\//i.test(String(rawUrl || ''));
        }
    }

    function headersToObject(headers) {
        var result = {};
        if (!headers) return result;
        try {
            if (typeof headers.forEach === 'function') {
                headers.forEach(function(value, key) {
                    result[key] = value;
                });
                return result;
            }
            if (Array.isArray(headers)) {
                for (var i = 0; i < headers.length; i++) {
                    result[String(headers[i][0])] = String(headers[i][1]);
                }
                return result;
            }
            for (var key in headers) {
                if (Object.prototype.hasOwnProperty.call(headers, key)) {
                    result[key] = String(headers[key]);
                }
            }
        } catch(e) {
            result.__captureError = e.message;
        }
        return result;
    }

    function parseXhrResponseHeaders(rawHeaders) {
        var result = {};
        String(rawHeaders || '').trim().split(/[\r\n]+/).forEach(function(line) {
            if (!line) return;
            var index = line.indexOf(':');
            if (index <= 0) return;
            result[line.slice(0, index).trim()] = line.slice(index + 1).trim();
        });
        return result;
    }

    function readBody(body) {
        try {
            if (body === undefined) return Promise.resolve('[undefined]');
            if (body === null) return Promise.resolve(null);
            if (typeof body === 'string') return Promise.resolve(body);
            if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
                return Promise.resolve(body.toString());
            }
            if (typeof FormData !== 'undefined' && body instanceof FormData) {
                var entries = [];
                body.forEach(function(value, key) {
                    if (typeof File !== 'undefined' && value instanceof File) {
                        entries.push({
                            key: key,
                            file: {
                                name: value.name,
                                type: value.type,
                                size: value.size,
                                lastModified: value.lastModified
                            }
                        });
                    } else {
                        entries.push({ key: key, value: String(value) });
                    }
                });
                return Promise.resolve(JSON.stringify(entries));
            }
            if (typeof Blob !== 'undefined' && body instanceof Blob) {
                if (typeof body.text === 'function') return body.text();
                return Promise.resolve('[Blob type=' + body.type + ' size=' + body.size + ']');
            }
            if (typeof ArrayBuffer !== 'undefined' && body instanceof ArrayBuffer) {
                return Promise.resolve(JSON.stringify(Array.from(new Uint8Array(body))));
            }
            if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView &&
                ArrayBuffer.isView(body)) {
                return Promise.resolve(JSON.stringify(Array.from(
                    new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
                )));
            }
            if (body && typeof body.then === 'function') {
                return body.then(readBody, function(err) {
                    return '[读取正文失败: ' +
                        (err && err.message ? err.message : String(err)) + ']';
                });
            }
            return Promise.resolve(JSON.stringify(body));
        } catch(e) {
            return Promise.resolve('[读取请求体失败: ' + e.message + ']');
        }
    }

    function beginNetworkRecord(transport, method, rawUrl, headers, body, source) {
        method = String(method || 'GET').toUpperCase();
        var url = String(rawUrl || '');
        if (!shouldObserveNetwork(method, url)) return null;
        try { url = new URL(url, location.href).href; } catch(e) {}

        var id = Date.now().toString(36) + '-' + (++networkRequestSeq);
        var record = {
            id: id,
            transport: transport,
            source: source || 'page',
            method: method,
            url: url,
            requestHeaders: headers || {},
            requestBody: '[读取中]',
            startedAt: serverNow(),
            completedAt: null,
            durationMs: null,
            status: null,
            statusText: '',
            responseUrl: '',
            responseHeaders: {},
            responseBody: '[等待响应]',
            error: ''
        };
        return {
            id: id,
            startedAt: Date.now(),
            record: record,
            body: body
        };
    }

    function commitNetworkStart(meta) {
        if (!meta || meta.committed) return;
        meta.committed = true;
        var records = networkLoad();
        records.push(meta.record);
        networkSave(records);
        tlMark('network-start', {
            id: meta.id,
            transport: meta.record.transport,
            source: meta.record.source,
            method: meta.record.method,
            url: meta.record.url
        });

        readBody(meta.body).then(function(bodyText) {
            var patch = { requestBody: bodyText };
            if (getHeaderValue(meta.record.requestHeaders, 'x-encrypt-iv') &&
                directContext.aesKeyBase64) {
                try {
                    patch.decryptedRequestBody = decryptApiBody(
                        bodyText,
                        meta.record.requestHeaders
                    );
                } catch(e) {
                    patch.decryptedRequestError = e.message;
                }
            }
            networkUpdate(meta.id, patch);
        });
    }

    function finishNetworkRecord(meta, patch, responseBody) {
        if (!meta) return;
        commitNetworkStart(meta);
        patch.completedAt = serverNow();
        patch.durationMs = Date.now() - meta.startedAt;
        readBody(responseBody).then(function(bodyText) {
            patch.responseBody = bodyText;
            if (getHeaderValue(patch.responseHeaders, 'x-encrypt-iv') &&
                directContext.aesKeyBase64) {
                try {
                    patch.decryptedResponseBody = decryptApiBody(
                        bodyText,
                        patch.responseHeaders
                    );
                    var businessPayload = parseJson(patch.decryptedResponseBody);
                    patch.businessCode = businessPayload && businessPayload.code;
                    patch.businessResult = businessPayload && businessPayload.result;
                } catch(e) {
                    patch.decryptedResponseError = e.message;
                }
            }
            var record = networkUpdate(meta.id, patch);
            console.groupCollapsed(
                '[WPS网络] #' + meta.id + ' ' +
                (record ? record.method + ' ' + record.url : '请求完成')
            );
            console.log(record || patch);
            console.groupEnd();
            tlMark('network-end', {
                id: meta.id,
                transport: record ? record.transport : '',
                source: record ? record.source : '',
                method: record ? record.method : '',
                url: record ? record.url : '',
                status: patch.status,
                durationMs: patch.durationMs,
                responsePreview: String(bodyText || '').slice(0, 500)
            });
        });
    }

    function printNetworkLogs() {
        var records = networkLoad();
        console.log('[WPS网络] 共记录 ' + records.length + ' 个表单 API 请求');
        console.table(records.map(function(record) {
            return {
                id: record.id,
                transport: record.transport,
                source: record.source,
                method: record.method,
                url: record.url,
                status: record.status,
                durationMs: record.durationMs,
                error: record.error
            };
        }));
        for (var i = 0; i < records.length; i++) {
            console.groupCollapsed(
                '[WPS网络完整记录] #' + records[i].id + ' ' +
                records[i].method + ' ' + records[i].url
            );
            console.log(records[i]);
            console.groupEnd();
        }
        return records;
    }

    window.__wpsNetworkLog = {
        get: networkLoad,
        print: printNetworkLogs,
        dump: function() {
            return JSON.stringify(networkLoad(), null, 2);
        },
        clear: networkClear
    };

    function installPrecheckGate() {
        var nativeOpen = XMLHttpRequest.prototype.open;
        var nativeSend = XMLHttpRequest.prototype.send;
        var nativeSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

        XMLHttpRequest.prototype.open = function(method, url) {
            this.__wpsRequestMethod = String(method || 'GET').toUpperCase();
            this.__wpsRequestUrl = String(url || '');
            this.__wpsRequestHeaders = {};
            return nativeOpen.apply(this, arguments);
        };

        XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
            if (!this.__wpsRequestHeaders) this.__wpsRequestHeaders = {};
            var key = String(name);
            var oldValue = this.__wpsRequestHeaders[key];
            this.__wpsRequestHeaders[key] = oldValue ?
                oldValue + ', ' + String(value) : String(value);
            return nativeSetRequestHeader.apply(this, arguments);
        };

        XMLHttpRequest.prototype.send = function() {
            var xhr = this;
            var args = Array.prototype.slice.call(arguments);
            function observedSend() {
                var source = consumeNetworkSource(
                    xhr.__wpsRequestMethod,
                    xhr.__wpsRequestUrl
                );
                var meta = beginNetworkRecord(
                    'XHR',
                    xhr.__wpsRequestMethod,
                    xhr.__wpsRequestUrl,
                    xhr.__wpsRequestHeaders || {},
                    args[0],
                    source
                );
                if (meta && source === 'direct-api') {
                    directNetworkRecordId = meta.id;
                }
                if (meta) {
                    var completed = false;
                    xhr.addEventListener('loadend', function() {
                        if (completed) return;
                        completed = true;
                        var responseBody;
                        try {
                            responseBody = xhr.responseType === 'json' ?
                                JSON.stringify(xhr.response) :
                                (xhr.responseType === '' || xhr.responseType === 'text' ?
                                    xhr.responseText : xhr.response);
                        } catch(e) {
                            responseBody = '[读取响应失败: ' + e.message + ']';
                        }
                        var responseHeaders = {};
                        try {
                            responseHeaders = parseXhrResponseHeaders(
                                xhr.getAllResponseHeaders()
                            );
                        } catch(e2) {}
                        inspectDirectApiResponse(
                            xhr.__wpsRequestMethod,
                            xhr.__wpsRequestUrl,
                            xhr.status,
                            responseHeaders,
                            responseBody,
                            true,
                            meta.id
                        );
                        finishNetworkRecord(meta, {
                            status: xhr.status,
                            statusText: xhr.statusText || '',
                            responseUrl: xhr.responseURL || xhr.__wpsRequestUrl,
                            responseHeaders: responseHeaders,
                            error: xhr.status === 0 ? 'network-error-or-abort' : ''
                        }, responseBody);
                    });
                }
                try {
                    var sendResult = nativeSend.apply(xhr, args);
                    commitNetworkStart(meta);
                    return sendResult;
                } catch (err) {
                    if (meta) {
                        completed = true;
                        commitNetworkStart(meta);
                        finishNetworkRecord(meta, {
                            status: 0,
                            statusText: '',
                            responseUrl: xhr.__wpsRequestUrl,
                            responseHeaders: {},
                            error: err.message
                        }, '[send抛出异常]');
                    }
                    throw err;
                }
            }
            var requestIndex = isPrecheckUrl(xhr.__wpsRequestUrl) ?
                precheckRequestCount++ : 0;
            var releaseTs = getPrecheckReleaseTs(xhr.__wpsRequestUrl, requestIndex);
            if (!releaseTs || Date.now() + loadDelta() >= releaseTs) {
                return observedSend();
            }

            var heldAt = Date.now() + loadDelta();
            markPrecheckGateStatus('held', heldAt);
            console.log('[自动提交] precheck #' + (requestIndex + 1) +
                ' 已就绪，等待网络补偿释放时刻');
            tlMark('precheck-held', {
                waitMs: releaseTs - heldAt,
                requestIndex: requestIndex
            });
            waitForPrecheckRelease(xhr.__wpsRequestUrl, requestIndex, function(actualReleaseTs) {
                markPrecheckGateStatus('released', Date.now() + loadDelta());
                console.log('[自动提交] 到达开放校验时刻, 释放 precheck #' +
                    (requestIndex + 1));
                tlMark('precheck-released', {
                    delayMs: actualReleaseTs ? (Date.now() + loadDelta()) - actualReleaseTs : 0,
                    requestIndex: requestIndex
                });
                try {
                    observedSend();
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
                var init = args[1] || {};
                var method = init.method || (input && input.method) || 'GET';
                var requestHeaders = headersToObject(input && input.headers);
                var initHeaders = headersToObject(init.headers);
                for (var headerName in initHeaders) {
                    if (Object.prototype.hasOwnProperty.call(initHeaders, headerName)) {
                        requestHeaders[headerName] = initHeaders[headerName];
                    }
                }
                var requestBody;
                try {
                    requestBody = Object.prototype.hasOwnProperty.call(init, 'body') ?
                        init.body :
                        (input && typeof input.clone === 'function' ?
                            input.clone().text() : undefined);
                } catch (bodyError) {
                    requestBody = '[读取fetch请求体失败: ' + bodyError.message + ']';
                }
                function observedFetch() {
                    var source = consumeNetworkSource(method, url);
                    var meta = beginNetworkRecord(
                        'fetch',
                        method,
                        url,
                        requestHeaders,
                        requestBody,
                        source
                    );
                    if (meta && source === 'direct-api') {
                        directNetworkRecordId = meta.id;
                    }
                    var fetchPromise;
                    try {
                        fetchPromise = nativeFetch.apply(context, args);
                        commitNetworkStart(meta);
                    } catch (err) {
                        commitNetworkStart(meta);
                        finishNetworkRecord(meta, {
                            status: 0,
                            statusText: '',
                            responseUrl: url,
                            responseHeaders: {},
                            error: err.message
                        }, '[fetch抛出异常]');
                        throw err;
                    }
                    if (!meta) return fetchPromise;
                    return fetchPromise.then(function(response) {
                        var responseHeaders = headersToObject(response.headers);
                        var responseClone;
                        try { responseClone = response.clone(); } catch(e) {}
                        var capturedResponse = '[响应无法克隆]';
                        if (responseClone) {
                            try {
                                capturedResponse = responseClone.text();
                            } catch (readError) {
                                capturedResponse = '[读取响应失败: ' +
                                    readError.message + ']';
                            }
                        }
                        readBody(capturedResponse).then(function(bodyText) {
                            inspectDirectApiResponse(
                                method,
                                url,
                                response.status,
                                responseHeaders,
                                bodyText,
                                true,
                                meta && meta.id
                            );
                        });
                        finishNetworkRecord(meta, {
                            status: response.status,
                            statusText: response.statusText || '',
                            responseUrl: response.url || url,
                            responseHeaders: responseHeaders,
                            error: ''
                        }, capturedResponse);
                        return response;
                    }, function(err) {
                        finishNetworkRecord(meta, {
                            status: 0,
                            statusText: '',
                            responseUrl: url,
                            responseHeaders: {},
                            error: err && err.message ? err.message : String(err)
                        }, '[fetch rejected]');
                        throw err;
                    });
                }
                var requestIndex = isPrecheckUrl(url) ? precheckRequestCount++ : 0;
                var releaseTs = getPrecheckReleaseTs(url, requestIndex);
                if (!releaseTs || Date.now() + loadDelta() >= releaseTs) {
                    return observedFetch();
                }
                console.log('[自动提交] fetch precheck #' + (requestIndex + 1) +
                    ' 已就绪, 暂存至开放时刻');
                markPrecheckGateStatus('held', Date.now() + loadDelta());
                tlMark('precheck-held', {
                    waitMs: releaseTs - (Date.now() + loadDelta()),
                    requestIndex: requestIndex
                });
                return new Promise(function(resolve, reject) {
                    waitForPrecheckRelease(url, requestIndex, function(actualReleaseTs) {
                        markPrecheckGateStatus('released', Date.now() + loadDelta());
                        tlMark('precheck-released', {
                            delayMs: actualReleaseTs ? (Date.now() + loadDelta()) - actualReleaseTs : 0,
                            requestIndex: requestIndex
                        });
                        observedFetch().then(resolve, reject);
                    });
                });
            };
        }
    }

    serverTimeDelta = loadDelta();
    armInitialPrecheckGate();
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
        'precheck-armed':        '🛡 首次开放校验已布防',
        'precheck-target-updated':'🎯 更新开放校验时刻',
        'precheck-held':         '⏸ 暂存开放校验',
        'precheck-released':     '▶️ 释放开放校验',
        'network-start':         '🌐 API请求发出',
        'network-end':           '📥 API响应完成',
        'direct-context-ready':  '🔐 直提上下文就绪',
        'direct-submit-armed':   '🎯 独立直提已布防',
        'direct-submit-released':'▶️ 释放独立直提',
        'direct-precheck-result':'🧭 直提开放校验结果',
        'direct-submit-start':   '🚀 发起直提请求',
        'direct-submit-response':'📨 直提响应完成',
        'direct-queue-retry':    '🔁 排队后串行直提',
        'direct-queue-exhausted':'✋ 直提排队转交手动',
        'direct-submit-terminal':'🛑 直提终态响应',
        'direct-xhr-timeout':    '⌛ 直提XHR超时',
        'direct-xhr-error':      '❌ 直提XHR网络错误',
        'direct-xhr-abort':      '⏹ 直提XHR中止',
        'direct-submit-success': '🏁 直提成功',
        'direct-submit-fallback':'↪️ 切换DOM兜底',
        'queue-detected':        '⏳ 检测到排队提示',
        'queue-wait-start':      '👀 等待排队提示消失',
        'queue-dismissed':       '✅ 排队提示已消失',
        'queue-retry-start':     '🔁 立即重试DOM提交',
        'button-rendered':       '🔘 提交按钮已渲染',
        'button-clickable':      '✅ 提交按钮可点击',
        'fill-sku-start':        '⌨️  开始填写SKU',
        'fill-sku-done':         '⌨️  SKU填写完成',
        'click-submit':          '👆 点击提交按钮',
        'click-submit-failed':   '❌ 点击提交失败',
        'confirm-shown':         '💬 确认弹窗出现',
        'confirm-clicked':       '👆 点击确认按钮',
        'submit-failed':         '⚠️ 提交失败',
        'queue-manual-handoff':  '✋ 排队后转交手动提交',
        'submit-exhausted':      '🛑 自动重试结束',
        'submit-done':           '🎉 提交流程完成',
        'resume-after-submit':   '⏪ 提交后页面恢复'
    };
    // 事件 extra 的简短摘要(显示在右侧)
    function tlSummarize(type, extra) {
        if (!extra) return '';
        try {
            switch (type) {
                case 'precheck-held':
                    return '第' + ((extra.requestIndex || 0) + 1) +
                        '个, 剩余 ' + extra.waitMs + 'ms';
                case 'precheck-released':
                    return '第' + ((extra.requestIndex || 0) + 1) +
                        '个, 触发偏差 ' + extra.delayMs + 'ms';
                case 'precheck-armed':
                    return '页面不刷新, 缓存RTT=' + extra.bestRttMs + 'ms';
                case 'precheck-target-updated':
                    return '最佳RTT=' + extra.bestRttMs + 'ms, 释放偏移=' +
                        extra.releaseOffsetMs + 'ms, 预计到达偏移=' +
                        extra.expectedArrivalDelayMs + 'ms';
                case 'network-start':
                    return '#' + extra.id + ' ' + extra.transport + ' ' +
                        '[' + extra.source + '] ' + extra.method + ' ' + extra.url;
                case 'network-end':
                    var responseSummary = String(extra.responsePreview || '')
                        .replace(/\s+/g, ' ').slice(0, 240);
                    return '#' + extra.id + ' ' + extra.transport + ' ' +
                        '[' + extra.source + '] ' + extra.method + ' ' +
                        extra.url + ', HTTP=' +
                        extra.status + ', 耗时=' + extra.durationMs + 'ms' +
                        (responseSummary ? ', 响应=' + responseSummary : '');
                case 'direct-context-ready':
                    return 'shareId=' + extra.shareId + ', token=' +
                        (extra.tokenReady ? '已获取' : '缺失');
                case 'direct-submit-armed':
                    return '最佳RTT=' + extra.bestRttMs +
                        'ms, 预计到达偏移=' +
                        extra.expectedArrivalDelayMs + 'ms';
                case 'direct-submit-released':
                    return '触发偏差=' + extra.delayMs +
                        'ms, 预计到达偏移=' +
                        extra.expectedArrivalDelayMs + 'ms';
                case 'direct-precheck-result':
                    return 'HTTP=' + extra.httpStatus + ', code=' +
                        extra.code + ', result=' + (extra.result || '');
                case 'direct-submit-start':
                    return '第' + extra.attempt + '/' + extra.maxAttempts +
                        '次, 触发=' + extra.trigger + ', qid=' + extra.qid +
                        ', 网络记录#' +
                        (extra.networkRecordId || 'pending');
                case 'direct-submit-response':
                    return '第' + extra.attempt + '次, HTTP=' +
                        extra.httpStatus + ', code=' +
                        extra.code + ', 耗时=' + extra.durationMs + 'ms, result=' +
                        (extra.result || '');
                case 'direct-queue-retry':
                    return '第' + extra.completedAttempt +
                        '次返回' + extra.retryKind + ', ' +
                        extra.delayMs + 'ms后开始第' +
                        extra.nextAttempt +
                        '/' + extra.maxAttempts + '次, code=' + extra.code +
                        ', result=' + (extra.result || '');
                case 'direct-queue-exhausted':
                    return '已完成' + extra.attempt + '/' +
                        extra.maxAttempts + '次, 原因=' + extra.reason +
                        ', code=' + extra.code + ', result=' +
                        (extra.result || '');
                case 'direct-submit-terminal':
                    return '第' + extra.attempt + '次, HTTP=' +
                        extra.httpStatus + ', code=' + extra.code +
                        ', result=' + (extra.result || '');
                case 'direct-xhr-timeout':
                case 'direct-xhr-error':
                case 'direct-xhr-abort':
                    return '第' + extra.attempt + '次, 耗时=' +
                        extra.durationMs + 'ms, 原因=' + extra.reason;
                case 'direct-submit-success':
                    return '第' + extra.attempt + '次, 答案ID=' +
                        extra.answerId + ', 耗时=' +
                        extra.durationMs + 'ms';
                case 'direct-submit-fallback':
                    return '原因=' + extra.reason;
                case 'queue-detected':
                    return '已完成重试=' + extra.completedRetries +
                        ', 提示=' + extra.message;
                case 'queue-wait-start':
                    return '等待第' + extra.retry + '次重试';
                case 'queue-dismissed':
                    return '路径=' + (extra.from === 'mutation' ? 'DOM监听' : extra.from) +
                        ', 即将执行第' + extra.retry + '次重试';
                case 'queue-retry-start':
                    return '第' + extra.retry + '次重试';
                case 'button-rendered':
                    return '可点击=' + (extra.clickable ? '是' : '否') + ', 监听至此=' + extra.sinceMonitorMs + 'ms';
                case 'button-clickable':
                    return '监听至此=' + extra.sinceMonitorMs + 'ms, 距T=' + extra.msToSubmit + 'ms';
                case 'click-submit-failed':
                    return '原因: ' + extra.reason;
                case 'submit-failed':
                    return '原因: ' + extra.reason + ', 尝试=' + extra.attempt +
                        (extra.message ? ', 提示=' + extra.message : '');
                case 'queue-manual-handoff':
                    return '提示=' + extra.message + ', 原因=' +
                        (extra.reason || '') + ', 已重试=' + (extra.retries || 0);
                case 'submit-exhausted':
                    return '已完成' + extra.retries + '次重试, 最后失败=' + extra.reason;
                case 'confirm-shown':
                case 'confirm-clicked':
                case 'submit-done':
                    return '路径=' + (extra.source === 'direct-api' ? '直提API' :
                        (extra.source === 'dom' ? 'DOM提交' :
                            (extra.from === 'mutation' ? 'DOM监听' :
                                (extra.from === 'manual' ? '用户手动' : '轮询'))));
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
        console.log('%c║                       卡点时间线报告 (WPS 问卷自动提交)                    ║', 'color:#08c;font-weight:bold');
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
        var evArmed = findEv('precheck-armed');
        var evPrecheckHeld = findEv('precheck-held');
        var evPrecheckReleased = findEv('precheck-released');
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
        var evDirectReleased = findEv('direct-submit-released');
        var evDirectStart = findLastEv('direct-submit-start');
        var evDirectResponse = findLastEv('direct-submit-response');
        var evDirectSuccess = findLastEv('direct-submit-success');
        var evDone = findLastEv('submit-done');

        console.log('');
        console.log('%c📊 关键阶段耗时:', 'color:#08c;font-weight:bold');
        function showSpan(name, a, b) {
            if (!a || !b) return;
            console.log('   ' + tlPadRight(name, 28) + ' = ' + tlPadLeft(String(b.ts - a.ts), 6) + 'ms');
        }
        showSpan('布防→precheck就绪',     evArmed, evPrecheckHeld);
        showSpan('precheck等待时长',       evPrecheckHeld, evPrecheckReleased);
        showSpan('precheck释放→按钮渲染', evPrecheckReleased, evBtnRendered);
        showSpan('按钮渲染→可点击',       evBtnRendered, evBtnClickable);
        showSpan('按钮可点击→点击提交',   evBtnClickable, evClick);
        showSpan('点击提交→弹窗出现',     evClick, evConfirmShown);
        showSpan('弹窗出现→点击确认',     evConfirmShown, evConfirmClicked);
        showSpan('点击确认→提交完成',     evConfirmClicked, evDone);
        showSpan('独立直提释放→首次请求',
            evDirectReleased, findEv('direct-submit-start'));
        showSpan('直提请求→收到响应',     evDirectStart, evDirectResponse);
        showSpan('直提响应→确认成功',     evDirectResponse, evDirectSuccess);

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
                if (cb) cb(loadBestRtt());
                return;
            }
            results.sort(function(a, b) { return a.rtt - b.rtt; });
            serverTimeDelta = results[0].delta;
            saveDelta(serverTimeDelta);
            saveBestRtt(results[0].rtt);
            console.log('[自动提交] 时间同步完成: delta=' + serverTimeDelta + 'ms (本地比服务器' + (serverTimeDelta > 0 ? '慢' : '快') + Math.abs(serverTimeDelta) + 'ms, 最佳rtt=' + results[0].rtt + 'ms)');
            if (cb) cb(results[0].rtt);
        }

        once();
    }

    function updateArmedPrecheckTarget(bestRttMs) {
        var state = loadState();
        if (!state || !state.active || state.phase !== 'armed' ||
            state.submitTime !== CONFIG.submitTime) return;
        state.bestRttMs = bestRttMs || loadBestRtt();
        state.precheckReleaseTs = calculatePrecheckReleaseTs(state.bestRttMs);
        state.directReleaseTs = calculateDirectReleaseTs(state.bestRttMs);
        saveState(state);
        var submitTs = new Date(CONFIG.submitTime).getTime();
        var releaseOffsetMs = state.precheckReleaseTs - submitTs;
        var directReleaseOffsetMs = state.directReleaseTs - submitTs;
        var estimatedOneWayMs = Math.min(
            CONFIG.maxOneWayMs,
            Math.max(0, Math.round(state.bestRttMs / 2))
        );
        var expectedArrivalDelayMs = releaseOffsetMs + estimatedOneWayMs;
        console.log('[自动提交] precheck释放目标=' +
            (releaseOffsetMs >= 0 ? 'T+' : 'T') + releaseOffsetMs +
            'ms，预计到达偏移=' + expectedArrivalDelayMs + 'ms');
        tlMark('precheck-target-updated', {
            bestRttMs: state.bestRttMs,
            releaseOffsetMs: releaseOffsetMs,
            expectedArrivalDelayMs: expectedArrivalDelayMs,
            directReleaseOffsetMs: directReleaseOffsetMs,
            directExpectedArrivalDelayMs: CONFIG.directArrivalDelayMs
        });
        console.log('[直提] 独立释放目标=' +
            (directReleaseOffsetMs >= 0 ? 'T+' : 'T') +
            directReleaseOffsetMs + 'ms，预计到达偏移=' +
            CONFIG.directArrivalDelayMs + 'ms');
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
    var QUEUE_TEXTS = [
        '\u8bbf\u95ee\u4eba\u6570\u8f83\u591a',
        '\u6392\u961f\u7b49\u5f85\u4e2d'
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

    function containsQueueText(node) {
        var text = compactText(node);
        for (var i = 0; i < QUEUE_TEXTS.length; i++) {
            if (text.indexOf(QUEUE_TEXTS[i]) >= 0) return true;
        }
        return false;
    }

    function findVisibleQueueSurface() {
        var surfaces = document.querySelectorAll(RESULT_SURFACE_SELECTOR);
        for (var i = 0; i < surfaces.length; i++) {
            if (isVisibleNode(surfaces[i]) && containsQueueText(surfaces[i])) {
                return surfaces[i];
            }
        }
        return null;
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

    function finishSubmission(from, generation) {
        if (generation !== submitFlowGeneration) return;
        submitFlowGeneration++;
        console.log('[自动提交] \u68c0\u6d4b\u5230\u6210\u529f\u9875\u9762, \u63d0\u4ea4\u5b8c\u6210');
        tlMark('submit-done', { from: from, source: 'dom' });
        tlPrintReport();
        clearState();
    }

    function handoffQueueToManual(state, reason) {
        state.active = true;
        state.submitted = false;
        state.phase = 'manual-handoff';
        state.submitStatus = 'manual-handoff';
        state.submitTime = CONFIG.submitTime;
        state.queueStopReason = reason;
        saveState(state);
        tlMark('queue-manual-handoff', {
            message: state.queueMessage || '',
            reason: reason,
            retries: state.queueRetryCount || 0
        });
        console.log('[自动提交] 排队自动重试结束，转交手动提交: ' + reason);
        tlPrintReport();
    }

    function waitForQueueDismissal(generation) {
        var observer = null;
        var timer = null;
        var inspectScheduled = false;
        var settled = false;

        function cleanup() {
            if (observer) {
                observer.disconnect();
                observer = null;
            }
            if (timer) {
                clearInterval(timer);
                timer = null;
            }
        }

        function inspect(from) {
            inspectScheduled = false;
            if (settled) return;
            if (generation !== submitFlowGeneration) {
                settled = true;
                cleanup();
                return;
            }
            if (hasSuccessResult()) {
                settled = true;
                cleanup();
                finishSubmission('queue-wait', generation);
                return;
            }
            if (isExpired()) {
                settled = true;
                cleanup();
                var expiredState = loadState() || {};
                handoffQueueToManual(expiredState, 'expired');
                return;
            }
            if (findVisibleQueueSurface()) return;

            var button = findSubmitButton();
            if (!button || !isButtonClickable(button)) return;

            var state = loadState() || {};
            var retries = state.queueRetryCount || 0;
            var attempts = state.submitAttempt || 0;
            if (attempts >= CONFIG.maxDomSubmitAttempts) {
                settled = true;
                cleanup();
                handoffQueueToManual(state, 'max-attempts');
                return;
            }

            settled = true;
            cleanup();
            state.active = true;
            state.submitted = false;
            state.phase = 'armed';
            state.submitStatus = 'queue-dismissed';
            state.queueRetryCount = retries + 1;
            saveState(state);
            tlMark('queue-dismissed', {
                from: from,
                retry: state.queueRetryCount
            });
            tlMark('queue-retry-start', {
                retry: state.queueRetryCount
            });
            console.log('[自动提交] 排队提示已消失且按钮可点击，立即执行第' +
                state.queueRetryCount + '次 DOM 重试');
            doSubmitNow(button);
        }

        function scheduleInspect(from) {
            if (settled || inspectScheduled) return;
            inspectScheduled = true;
            Promise.resolve().then(function() {
                inspect(from);
            });
        }

        observer = new MutationObserver(function() {
            scheduleInspect('mutation');
        });
        observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            characterData: true,
            attributeFilter: [
                'class',
                'style',
                'hidden',
                'aria-hidden',
                'disabled'
            ]
        });
        timer = setInterval(function() {
            scheduleInspect('poll');
        }, CONFIG.queueDismissPollMs);
        var waitState = loadState() || {};
        tlMark('queue-wait-start', {
            retry: (waitState.queueRetryCount || 0) + 1
        });
        scheduleInspect('initial');
    }

    function retrySubmission(reason, surface, generation) {
        if (generation !== submitFlowGeneration) return;
        submitFlowGeneration++;
        var state = loadState() || {};
        state.submitted = false;
        state.submitAttempt = state.submitAttempt || 1;
        state.lastSubmitFailure = reason;
        var surfaceMessage = compactText(surface).slice(0, 80);
        if (containsQueueText(surface)) {
            state.active = true;
            state.phase = 'queue-waiting';
            state.submitStatus = 'waiting-queue-dismiss';
            state.submitTime = CONFIG.submitTime;
            state.queueMessage = compactText(surface).slice(0, 160);
            state.queueRetryCount = state.queueRetryCount || 0;
            saveState(state);
            tlMark('queue-detected', {
                message: state.queueMessage,
                completedRetries: state.queueRetryCount
            });
            console.log('[自动提交] 检测到排队提示，等待提示自然消失后立即重试');
            if (state.submitAttempt >= CONFIG.maxDomSubmitAttempts) {
                handoffQueueToManual(state, 'max-attempts');
                return;
            }
            waitForQueueDismissal(submitFlowGeneration);
            return;
        }
        tlMark('submit-failed', {
            reason: reason,
            attempt: state.submitAttempt,
            message: surfaceMessage
        });
        state.active = true;
        state.phase = 'retry-exhausted';
        state.submitStatus = 'retry-exhausted';
        state.submitTime = CONFIG.submitTime;
        saveState(state);
        tlMark('submit-exhausted', {
            retries: 0,
            reason: reason
        });
        console.log('[自动提交] 首次提交未成功，按单次提交策略停止自动操作');
        tlPrintReport();
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
                return;
            }
            if (hasSuccessResult()) {
                clearInterval(timer);
                finishSubmission('result-watch', generation);
                return;
            }
            var queueSurface = findVisibleQueueSurface();
            if (queueSurface) {
                clearInterval(timer);
                retrySubmission('queue-surface-shown', queueSurface, generation);
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
        var timer = null;
        var observer = null;
        var mutationFrame = 0;
        var settled = false;

        function cleanup() {
            if (timer) {
                clearInterval(timer);
                timer = null;
            }
            if (observer) {
                observer.disconnect();
                observer = null;
            }
            if (mutationFrame) {
                cancelAnimationFrame(mutationFrame);
                mutationFrame = 0;
            }
        }

        function inspect(from) {
            if (settled) return;
            if (generation !== submitFlowGeneration) {
                settled = true;
                cleanup();
                return;
            }
            if (hasSuccessResult()) {
                settled = true;
                cleanup();
                finishSubmission('confirm-watch', generation);
                return;
            }
            var confirmInfo = findVisibleConfirm();
            if (confirmInfo) {
                settled = true;
                cleanup();
                tlMark('confirm-shown', { from: from });
                console.log('[自动提交] 二次确认弹窗已出现，自动确认');
                var state = loadState() || {};
                state.submitStatus = 'awaiting-result';
                saveState(state);
                tlMark('confirm-clicked', { from: from });
                markNextNetworkSource('dom-auto');
                confirmInfo.button.click();
                watchSubmissionResult(confirmInfo, generation);
                return;
            }

            if (Date.now() - startedAt >= CONFIG.submitResultTimeoutMs) {
                settled = true;
                cleanup();
                retrySubmission('confirm-timeout', null, generation);
            }
        }

        observer = new MutationObserver(function() {
            if (settled || mutationFrame) return;
            mutationFrame = requestAnimationFrame(function() {
                mutationFrame = 0;
                inspect('mutation');
            });
        });
        observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'disabled']
        });

        timer = setInterval(function() {
            inspect('poll');
        }, 80);
        inspect('poll');
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

        console.log('=== WPS问卷自动提交 v4.26 ===');
        console.log('目标: ' + CONFIG.submitTime + ' SKU: ' + CONFIG.sku + ' 过期: +' + CONFIG.expireAfter + 's');

        serverTimeDelta = loadDelta();
        console.log('[自动提交] 加载缓存 delta=' + serverTimeDelta + 'ms (将立即重新校准)');

        syncServerTime(CONFIG.timeSyncSamples, function(bestRttMs) {
            updateArmedPrecheckTarget(bestRttMs);
            refineWithEdgeDetection(1500, function() {
                runFlow();
            });
        });
    }

    function doSubmitNow(btn) {
        if (CONFIG.directSubmitEnabled &&
            (directSubmitState === 'armed' ||
             directSubmitState === 'sending' ||
             directSubmitState === 'retrying' ||
             directSubmitState === 'terminal' ||
             directSubmitState === 'succeeded')) {
            console.log('[自动提交] 直提仍在处理，跳过 DOM 提交');
            return;
        }
        console.log('[自动提交] 执行提交流程');
        if (isExpired()) {
            console.log('[自动提交] \u63d0\u4ea4\u524d\u5df2\u8fc7\u671f, \u505c\u6b62');
            clearState();
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

        // 每帧检查按钮，最长等待 80ms。
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

    function monitorArmedPage() {
        var state = loadState() || {};
        if (!state.timelineStarted) {
            state.timelineStarted = true;
            saveState(state);
            tlMark('precheck-armed', {
                bestRttMs: state.bestRttMs || loadBestRtt()
            });
        }

        console.log('[自动提交] 当前页面已布防，等待首次 precheck 返回并渲染提交按钮');
        var st = Date.now();
        var rafSupported = typeof window.requestAnimationFrame === 'function';
        var lastLog = 0;
        var btnRenderedMarked = false;
        var btnClickableMarked = false;
        var buttonDirectWaitStartedAt = 0;
        var renderTimeoutMarked = false;
        var missingPrecheckWarned = false;
        var submitTs = new Date(CONFIG.submitTime).getTime();

        function check() {
            if (isExpired()) { console.log('[自动提交] 已过期'); clearState(); return; }

            var el = Date.now() - st;
            var btn = findSubmitButton();
            var msToSubmit = submitTs - serverNow();
            if (!missingPrecheckWarned && msToSubmit <= -100) {
                var latestState = loadState() || {};
                if (!latestState.precheckHeldAt) {
                    missingPrecheckWarned = true;
                    console.log('[自动提交] 警告: 未捕获首次 precheck；当前页面不会刷新或补发请求');
                }
            }

            if (btn) {
                var ok = isButtonClickable(btn);
                if (!btnRenderedMarked) {
                    tlMark('button-rendered', { clickable: ok, sinceMonitorMs: el });
                    btnRenderedMarked = true;
                }
                if (el - lastLog > 500) {
                    console.log('[自动提交] btn=found clickable=' + ok +
                        ' 监听' + el + 'ms 距开抢' + msToSubmit + 'ms');
                    lastLog = el;
                }
                if (ok && msToSubmit <= 0) {
                    if (!btnClickableMarked) {
                        tlMark('button-clickable', {
                            sinceMonitorMs: el,
                            msToSubmit: msToSubmit
                        });
                        btnClickableMarked = true;
                    }
                    if (directSubmitState === 'armed') {
                        if (!buttonDirectWaitStartedAt) {
                            buttonDirectWaitStartedAt = Date.now();
                            console.log('[直提] 按钮已开放，短暂等待独立直提定时器');
                        }
                        if (Date.now() - buttonDirectWaitStartedAt <
                            CONFIG.directDecisionGraceMs) {
                            if (rafSupported) requestAnimationFrame(check);
                            else setTimeout(check, CONFIG.checkInterval);
                            return;
                        }
                        enableDomFallback('independent-direct-request-not-started');
                    }
                    if (directSubmitState === 'sending' ||
                        directSubmitState === 'retrying') {
                        if (rafSupported) requestAnimationFrame(check);
                        else setTimeout(check, CONFIG.checkInterval);
                        return;
                    }
                    if (directSubmitState === 'succeeded') return;
                    if (directSubmitState === 'terminal') return;
                    doSubmitNow(btn);
                    return;
                }
            } else {
                if (el - lastLog > 1000) {
                    console.log('[自动提交] 按钮未渲染 ' + el + 'ms 距开抢' + msToSubmit + 'ms');
                    lastLog = el;
                }
            }

            if (serverNow() >= submitTs + CONFIG.finalRenderTimeoutMs &&
                !btn && !renderTimeoutMarked) {
                renderTimeoutMarked = true;
                console.log('[自动提交] 开抢后页面仍未渲染按钮，继续原地等待，禁止刷新');
            }

            if (msToSubmit > 2000) {
                setTimeout(check, Math.min(250, msToSubmit - 1500));
            } else if (rafSupported) {
                requestAnimationFrame(check);
            } else {
                setTimeout(check, CONFIG.checkInterval);
            }
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
                return;
            }
            if (state.phase === 'direct-succeeded') {
                console.log('[直提] 本轮已由直提 API 提交成功');
                tlPrintReport();
                printNetworkLogs();
                return;
            }
            if (state.phase === 'direct-submitting') {
                console.log('[直提] 页面在请求期间重载，切换 DOM 兜底');
                directSubmitState = 'fallback';
                state.phase = 'armed';
                state.submitted = false;
                state.submitStatus = 'dom-fallback-after-reload';
                saveState(state);
            }
            if (state.phase === 'queue-waiting') {
                if (state.submitTime === CONFIG.submitTime) {
                    directSubmitState = 'fallback';
                    console.log('[自动提交] 恢复等待排队提示消失的状态');
                    waitForQueueDismissal(++submitFlowGeneration);
                    return;
                }
                console.log('[自动提交] 检测到其他提交时间的排队等待状态，清除重来');
                clearState();
                state = null;
            }
            if (state && state.phase === 'manual-handoff') {
                if (state.submitTime === CONFIG.submitTime) {
                    console.log('[自动提交] 已因排队提示转交手动提交，不再自动操作');
                    return;
                }
                console.log('[自动提交] 检测到其他提交时间的手动接管终态，清除重来');
                clearState();
                state = null;
            }
            if (state && state.phase === 'retry-exhausted') {
                if (state.submitTime === CONFIG.submitTime) {
                    console.log('[自动提交] 本轮首次提交已失败，不再自动提交');
                    return;
                }
                console.log('[自动提交] 检测到其他提交时间的重试终态，清除重来');
                clearState();
                state = null;
            }
            if (state && state.submitted) {
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
            if (state && state.phase === 'armed') {
                monitorArmedPage();
                return;
            }
            if (state) {
                console.log('[自动提交] 旧状态phase=' + state.phase + ', 清除重来');
                clearState();
            }
        }

        var bestRttMs = loadBestRtt();
        console.log('[自动提交] 当前页面进入无刷新布防模式');
        state = {
            phase: 'armed',
            active: true,
            submitted: false,
            submitAttempt: 0,
            submitTime: CONFIG.submitTime,
            armedAt: nowS,
            bestRttMs: bestRttMs,
            precheckReleaseTs: calculatePrecheckReleaseTs(bestRttMs),
            directReleaseTs: calculateDirectReleaseTs(bestRttMs),
            directAttemptCount: 0
        };
        saveState(state);
        if (diff <= 0) {
            console.log('[自动提交] 已过开抢时间，使用当前页面直接等待按钮，仍禁止刷新');
        }
        monitorArmedPage();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', main);
    } else {
        main();
    }
})();

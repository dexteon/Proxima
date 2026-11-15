/**
 * Proxima - Z.ai Engine
 * Runs inside the chat.z.ai BrowserView. The site signs its own requests
 * (x-signature header, built by obfuscated page code), so this engine does NOT
 * call the API directly. It drives the page UI (fill the chat box, click send)
 * and reads the page's own /api/v2/chat/completions SSE stream by wrapping
 * window.fetch. Stream events (verified 2026-11-15):
 *   data: {"type":"chat:completion","data":{"phase":"thinking"|"answer"|"other"|"done",
 *          "delta_content":"...","done":true}}
 * Only phase "answer" deltas are returned; "thinking" is dropped.
 * A "security verification" slider can appear: the engine waits for the user
 * to solve it in the Proxima window.
 */
(function () {
    if (window.__proximaZai) return;

    var TIMEOUT = 360000;
    var CAPTCHA_WAIT = 300000;
    var _needNewChat = false;
    var _current = null; // { text, done, error }

    // Wrap fetch once. Page code calls window.fetch, so this sees every request.
    if (!window.__proximaZaiHooked) {
        window.__proximaZaiHooked = true;
        var _origFetch = window.fetch;
        window.fetch = async function (input, init) {
            var url = typeof input === 'string' ? input : (input && input.url) || '';
            var res = await _origFetch.apply(this, arguments);
            if (/\/api\/v2\/chat\/completions/.test(url) && _current && !_current.bound) {
                _current.bound = true;
                _current.status = res.status;
                _readStream(res.clone(), _current);
            }
            return res;
        };
    }

    async function _readStream(response, state) {
        try {
            var reader = response.body.getReader();
            var decoder = new TextDecoder();
            var buffer = '';
            while (true) {
                var chunk = await reader.read();
                if (chunk.done) break;
                buffer += decoder.decode(chunk.value, { stream: true });
                var lines = buffer.split('\n');
                buffer = lines.pop() || '';
                for (var i = 0; i < lines.length; i++) {
                    var line = lines[i].trim();
                    if (line.indexOf('data:') !== 0) continue;
                    var data = line.slice(5).trim();
                    if (!data || data === '[DONE]') continue;
                    try {
                        var ev = JSON.parse(data);
                        var d = ev && ev.data;
                        if (!d) continue;
                        if (d.phase === 'answer' && typeof d.delta_content === 'string') {
                            state.text += d.delta_content;
                        }
                        if (d.error) state.error = JSON.stringify(d.error).slice(0, 300);
                        if (d.done) state.done = true;
                    } catch (e) { }
                }
            }
        } catch (e) {
            state.error = String(e && e.message || e);
        } finally {
            state.done = true;
        }
    }

    function _sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

    function _captchaUp() {
        return /security verification/i.test(document.body ? document.body.innerText : '');
    }

    function _setInput(text) {
        var ta = document.querySelector('#chat-input') || document.querySelector('textarea');
        if (!ta) throw new Error('Z.ai chat box not found (not on chat.z.ai?)');
        ta.focus();
        var setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        setter.call(ta, text);
        ta.dispatchEvent(new Event('input', { bubbles: true }));
    }

    async function _clickSend() {
        for (var i = 0; i < 20; i++) {
            var btn = document.querySelector('#send-message-button');
            if (btn && !btn.disabled) { btn.click(); return; }
            await _sleep(250);
        }
        throw new Error('Z.ai send button never became enabled');
    }

    async function _startNewChat() {
        var link = document.querySelector('a[href="/"]');
        if (link) { link.click(); await _sleep(1000); }
        _needNewChat = false;
    }

    async function send(message, engine, attachments, sessionId) {
        if (_needNewChat) await _startNewChat();

        var state = { text: '', done: false, error: null, bound: false, status: null };
        _current = state;

        _setInput(message);
        await _clickSend();

        var start = Date.now();
        var captchaSince = 0;
        while (!state.done) {
            await _sleep(300);
            if (_captchaUp()) {
                if (!captchaSince) captchaSince = Date.now();
                if (Date.now() - captchaSince > CAPTCHA_WAIT) {
                    _current = null;
                    throw new Error('Z.ai security verification not solved (open the Z.ai tab in Proxima and finish the slider)');
                }
                start = Date.now(); // do not count solving time against the timeout
                continue;
            }
            captchaSince = 0;
            if (Date.now() - start > TIMEOUT) {
                _current = null;
                throw new Error('Z.ai timed out');
            }
        }
        _current = null;

        if (state.status === 401 || state.status === 403) throw new Error('Not logged in to Z.ai');
        if (state.status === 429) throw new Error('Z.ai rate limited');
        if (state.error && !state.text) throw new Error('Z.ai error: ' + state.error);
        var out = (state.text || '').trim();
        if (!out) throw new Error('Z.ai returned empty response');
        return out;
    }

    function newConversation() { _needNewChat = true; }

    function abort() {
        var stop = document.querySelector('#send-message-button');
        if (_current && stop) { try { stop.click(); } catch (e) { } }
    }

    window.__proximaZai = { send: send, newConversation: newConversation, abort: abort };
    console.log('[Proxima] Z.ai engine loaded');
})();

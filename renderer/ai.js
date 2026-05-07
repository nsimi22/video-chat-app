// Unified AI client — Claude direct (Anthropic API) and OpenRouter.
//
// Both providers go through window.huddle.fetchProxy so requests originate
// from the Electron main process: the renderer's CORS rules don't apply to
// Anthropic's API (which discourages browser-direct calls), and keys never
// leak to a third-party origin via fetch.
//
// Defaults follow Claude API skill guidance:
//   - Anthropic provider: model = `claude-opus-4-7`, adaptive thinking
//   - OpenRouter provider: model = `anthropic/claude-opus-4-7` (same model,
//     billed via OpenRouter — useful for users who already have credits there
//     or want easy fallback to other providers from the same key)
//
// Public surface:
//   - new AiClient({ provider, anthropicKey, openrouterKey, defaultModel })
//   - .isConfigured()
//   - .chat({ system, messages, model }) -> { text, model, usage }
//   - .summarize(channelMessages, instructions) -> { text, model, usage }

(function () {
  const ANTHROPIC_DEFAULT_MODEL = 'claude-opus-4-7';
  const OPENROUTER_DEFAULT_MODEL = 'anthropic/claude-opus-4-7';

  class AiClient {
    constructor({ provider, anthropicKey, openrouterKey, defaultModel } = {}) {
      this.provider = provider === 'openrouter' ? 'openrouter' : 'anthropic';
      this.anthropicKey = anthropicKey || '';
      this.openrouterKey = openrouterKey || '';
      this.defaultModel = defaultModel
        || (this.provider === 'anthropic' ? ANTHROPIC_DEFAULT_MODEL : OPENROUTER_DEFAULT_MODEL);
    }

    isConfigured() {
      return this.provider === 'anthropic' ? !!this.anthropicKey : !!this.openrouterKey;
    }

    /**
     * @param {Object} args
     * @param {string} [args.system] — system prompt
     * @param {Array<{role:'user'|'assistant',content:string}>} args.messages
     * @param {string} [args.model] — override default model
     * @returns {Promise<{text:string, model:string, usage:Object}>}
     */
    async chat({ system, messages, model }) {
      if (!this.isConfigured()) {
        throw new Error('AI provider not configured — open Settings to add an API key.');
      }
      const effectiveModel = model || this.defaultModel;
      return this.provider === 'anthropic'
        ? this._anthropicChat({ system, messages, model: effectiveModel })
        : this._openrouterChat({ system, messages, model: effectiveModel });
    }

    async _anthropicChat({ system, messages, model }) {
      // Adaptive thinking: model decides how much to think per request.
      // 16k max_tokens keeps non-streaming responses under SDK timeouts.
      const body = {
        model,
        max_tokens: 16000,
        thinking: { type: 'adaptive' },
        messages,
        ...(system ? { system } : {}),
      };
      const res = await window.huddle.fetchProxy({
        url: 'https://api.anthropic.com/v1/messages',
        method: 'POST',
        headers: {
          'x-api-key': this.anthropicKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      if (!res || !res.ok) {
        throw new Error(`Anthropic ${res?.status || 0}: ${parseProviderError(res?.body) || res?.error || 'request failed'}`);
      }
      const json = JSON.parse(res.body);
      const text = (json.content || [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      return { text, model, usage: json.usage || null };
    }

    async _openrouterChat({ system, messages, model }) {
      const fullMessages = system ? [{ role: 'system', content: system }, ...messages] : messages;
      const body = { model, messages: fullMessages };
      const res = await window.huddle.fetchProxy({
        url: 'https://openrouter.ai/api/v1/chat/completions',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.openrouterKey}`,
          'content-type': 'application/json',
          // Optional but conventional — helps OpenRouter attribute usage and
          // surfaces the app name in their dashboard.
          'HTTP-Referer': 'https://github.com/nsimi22/video-chat-app',
          'X-Title': 'Huddle',
        },
        body: JSON.stringify(body),
      });
      if (!res || !res.ok) {
        throw new Error(`OpenRouter ${res?.status || 0}: ${parseProviderError(res?.body) || res?.error || 'request failed'}`);
      }
      const json = JSON.parse(res.body);
      const text = json.choices?.[0]?.message?.content || '';
      return { text, model, usage: json.usage || null };
    }

    // Convenience: build a system+user prompt from a list of recent chat
    // messages and ask the model to summarize. The shape lives here (rather
    // than in chat.js) so the prompt stays close to the API surface.
    async summarize(channelMessages, { topicHint } = {}) {
      const system = `You are a meeting / chat summarizer. Produce a tight, scannable summary of recent messages in a team chat. Use bullet points. Capture decisions, open questions, and any action items (with owners if you can infer them). Keep it under 250 words.`;
      const lines = (channelMessages || [])
        .filter((m) => m.text || m.body)
        .map((m) => {
          const ts = new Date(m.ts || m.created_at || Date.now()).toISOString().slice(11, 16);
          const who = m.authorName || m.author_name || 'someone';
          const txt = (m.text ?? m.body ?? '').replace(/\n+/g, ' ');
          return `[${ts}] ${who}: ${txt}`;
        })
        .join('\n');
      const user = (topicHint ? `Topic: ${topicHint}\n\n` : '') + `Transcript:\n${lines || '(no messages)'}`;
      return this.chat({
        system,
        messages: [{ role: 'user', content: user }],
      });
    }
  }

  function parseProviderError(body) {
    if (!body) return '';
    try {
      const j = JSON.parse(body);
      return j.error?.message || j.error?.type || j.message || body.slice(0, 200);
    } catch { return body.slice(0, 200); }
  }

  window.AiClient = AiClient;
  window.AI_DEFAULT_MODELS = {
    anthropic: ANTHROPIC_DEFAULT_MODEL,
    openrouter: OPENROUTER_DEFAULT_MODEL,
  };
})();

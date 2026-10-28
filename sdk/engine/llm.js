/**
 * The optional model behind `json`, `summary` and a prompted `extract`.
 *
 * Backends, in priority when auto-selected:
 *
 * - Nexuss AI Router (NAR): a single endpoint in front of free model providers
 *   with automatic failover. Configured via NAR_BASE_URL / NAR_API_KEY.
 * - Ollama, probed locally. Free, keyless.
 * - An OpenAI-compatible endpoint, when the deployment has a key.
 */

const PROBE_TTL_MS = 60_000;

/** Last answer from `/api/tags`, so a page of scrapes does not probe per page. */
let probe = { at: 0, value: null };

function noModel() {
  return Object.assign(
    new Error('no model is available for this format: start Ollama (ollama serve) and pull a model, or set NAR_BASE_URL/NAR_API_KEY, or set OPENAI_API_KEY; the deterministic formats do not need either'),
    { status: 501, code: 'E_NO_LLM' },
  );
}

async function ollamaModel(config) {
  if (config.llmModel) return config.llmModel;
  if (probe.at && Date.now() - probe.at < PROBE_TTL_MS) return probe.value;

  let model = null;
  try {
    const response = await fetch(`${config.ollamaUrl}/api/tags`, {
      signal: AbortSignal.timeout(1_500),
    });
    if (response.ok) {
      const body = await response.json();
      model = (body.models ?? []).map((entry) => entry?.name).filter(Boolean).sort()[0] ?? null;
    }
  } catch {
    model = null;
  }
  probe = { at: Date.now(), value: model };
  return model;
}

/** Which backend would answer right now, or null. */
export async function describeModel(config = {}) {
  if (config.llmProvider === 'nar' || config.llmProvider === 'nexuss') {
    return config.narBaseUrl ? { provider: 'nar', model: config.narModel || 'auto' } : null;
  }
  if (config.llmProvider === 'openai') {
    return config.openaiApiKey ? { provider: 'openai', model: config.openaiModel } : null;
  }
  if (config.llmProvider === 'ollama') {
    const model = await ollamaModel(config);
    return model ? { provider: 'ollama', model } : null;
  }
  if (config.narBaseUrl) return { provider: 'nar', model: config.narModel || 'auto' };
  const local = await ollamaModel(config);
  if (local) return { provider: 'ollama', model: local };
  if (config.openaiApiKey) return { provider: 'openai', model: config.openaiModel };
  return null;
}

/** Strips a markdown fence, because models wrap JSON in one about half the time. */
function jsonFrom(content) {
  let text = String(content ?? '').trim();
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) text = fence[1].trim();
  try {
    return JSON.parse(text);
  } catch {
    const start = text.search(/[[{]/);
    const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        // Falls through to the error below.
      }
    }
    throw Object.assign(new Error('the model answered with something that is not JSON'), {
      status: 502,
      code: 'E_BAD_MODEL_ANSWER',
    });
  }
}

async function callOllama({ target, messages, schema, config }) {
  const response = await fetch(`${config.ollamaUrl}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: target.model,
      messages,
      stream: false,
      format: schema ?? 'json',
      options: { temperature: 0 },
    }),
    signal: AbortSignal.timeout(config.llmTimeoutMs ?? 90_000),
  });
  if (!response.ok) {
    const text = (await response.text()).slice(0, 300);
    throw Object.assign(new Error(`ollama answered ${response.status}: ${text}`), {
      status: 502,
      code: 'E_LLM_FAILED',
    });
  }
  const body = await response.json();
  return {
    content: body.message?.content ?? '',
    tokensUsed: (body.prompt_eval_count ?? 0) + (body.eval_count ?? 0) || undefined,
  };
}

async function callOpenAI({ target, messages, schema, config }) {
  const base = (config.openaiBaseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const url = `${base}/chat/completions`;
  const headers = { 'content-type': 'application/json' };
  if (config.openaiApiKey) headers.authorization = `Bearer ${config.openaiApiKey}`;
  const send = async (responseFormat) => fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: target.model,
      messages,
      temperature: 0,
      response_format: responseFormat,
    }),
    signal: AbortSignal.timeout(config.llmTimeoutMs ?? 90_000),
  });

  let response = await send(schema
    ? { type: 'json_schema', json_schema: { name: 'result', schema, strict: false } }
    : { type: 'json_object' });
  if (response.status === 400 && schema) {
    response = await send({ type: 'json_object' });
  }
  if (!response.ok) {
    const text = (await response.text()).slice(0, 300);
    throw Object.assign(new Error(`the model endpoint answered ${response.status}: ${text}`), {
      status: 502,
      code: 'E_LLM_FAILED',
    });
  }
  const body = await response.json();
  return {
    content: body.choices?.[0]?.message?.content ?? '',
    tokensUsed: body.usage?.total_tokens,
  };
}

async function callNAR({ target, messages, schema, config }) {
  const base = (config.narBaseUrl || '').replace(/\/+$/, '');
  const url = base.endsWith('/api/v1') ? `${base}/chat/completions` : `${base}/api/v1/chat/completions`;
  const headers = { 'content-type': 'application/json' };
  const key = config.narApiKey || config.openaiApiKey;
  if (key) headers.authorization = `Bearer ${key}`;

  const send = async (responseFormat) => fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: target.model,
      messages,
      temperature: 0,
      response_format: responseFormat,
    }),
    signal: AbortSignal.timeout(config.llmTimeoutMs ?? 90_000),
  });

  let response = await send(schema
    ? { type: 'json_schema', json_schema: { name: 'result', schema, strict: false } }
    : { type: 'json_object' });
  if (response.status === 400 && schema) {
    response = await send({ type: 'json_object' });
  }
  if (!response.ok) {
    const text = (await response.text()).slice(0, 300);
    throw Object.assign(new Error(`NAR answered ${response.status}: ${text}`), {
      status: 502,
      code: 'E_LLM_FAILED',
    });
  }
  const body = await response.json();
  return {
    content: body.choices?.[0]?.message?.content ?? '',
    tokensUsed: body.usage?.total_tokens,
    route: body.route || null,
  };
}

/**
 * One request that must answer with an object.
 */
export async function chatJson({ system, prompt, schema, config = {} }) {
  const target = await describeModel(config);
  if (!target) throw noModel();

  const instruction = schema
    ? `${prompt}\n\nAnswer with a single JSON value that matches this JSON Schema exactly:\n${JSON.stringify(schema)}`
    : prompt;
  const messages = [
    ...(system ? [{ role: 'system', content: system }] : []),
    { role: 'user', content: instruction },
  ];

  const result = target.provider === 'ollama'
    ? await callOllama({ target, messages, schema, config })
    : target.provider === 'nar'
      ? await callNAR({ target, messages, schema, config })
      : await callOpenAI({ target, messages, schema, config });

  return {
    json: jsonFrom(result.content),
    tokensUsed: result.tokensUsed,
    provider: target.provider,
    model: target.model,
  };
}

/** Plain text out, for a summary or a written answer. */
export async function chatText({ system, prompt, config = {} }) {
  const target = await describeModel(config);
  if (!target) throw noModel();

  const messages = [
    ...(system ? [{ role: 'system', content: system }] : []),
    { role: 'user', content: prompt },
  ];

  if (target.provider === 'ollama') {
    const response = await fetch(`${config.ollamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: target.model, messages, stream: false, options: { temperature: 0 } }),
      signal: AbortSignal.timeout(config.llmTimeoutMs ?? 90_000),
    });
    if (!response.ok) {
      const text = (await response.text()).slice(0, 300);
      throw Object.assign(new Error(`ollama answered ${response.status}: ${text}`), { status: 502, code: 'E_LLM_FAILED' });
    }
    const body = await response.json();
    return {
      text: String(body.message?.content ?? '').trim(),
      tokensUsed: (body.prompt_eval_count ?? 0) + (body.eval_count ?? 0) || undefined,
      provider: 'ollama',
      model: target.model,
    };
  }

  if (target.provider === 'nar') {
    const base = (config.narBaseUrl || '').replace(/\/+$/, '');
    const url = base.endsWith('/api/v1') ? `${base}/chat/completions` : `${base}/api/v1/chat/completions`;
    const headers = { 'content-type': 'application/json' };
    const key = config.narApiKey || config.openaiApiKey;
    if (key) headers.authorization = `Bearer ${key}`;
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: target.model, messages, temperature: 0 }),
      signal: AbortSignal.timeout(config.llmTimeoutMs ?? 90_000),
    });
    if (!response.ok) {
      const text = (await response.text()).slice(0, 300);
      throw Object.assign(new Error(`NAR answered ${response.status}: ${text}`), { status: 502, code: 'E_LLM_FAILED' });
    }
    const body = await response.json();
    return {
      text: String(body.choices?.[0]?.message?.content ?? '').trim(),
      tokensUsed: body.usage?.total_tokens,
      provider: 'nar',
      model: target.model,
    };
  }

  const base = (config.openaiBaseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const response = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.openaiApiKey}` },
    body: JSON.stringify({ model: target.model, messages, temperature: 0 }),
    signal: AbortSignal.timeout(config.llmTimeoutMs ?? 90_000),
  });
  if (!response.ok) {
    const text = (await response.text()).slice(0, 300);
    throw Object.assign(new Error(`the model endpoint answered ${response.status}: ${text}`), { status: 502, code: 'E_LLM_FAILED' });
  }
  const body = await response.json();
  return {
    text: String(body.choices?.[0]?.message?.content ?? '').trim(),
    tokensUsed: body.usage?.total_tokens,
    provider: 'openai',
    model: target.model,
  };
}

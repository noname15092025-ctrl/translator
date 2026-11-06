// Посредник для переводчика: хранит ключ OpenRouter и переводит через бесплатные ИИ-модели.
// Вставляется в Cloudflare Worker. Ключ добавляется в настройках воркера как секрет OPENROUTER_KEY.

const ALLOWED_ORIGIN = "https://noname15092025-ctrl.github.io";
const MAX_CHARS = 5000;
const PER_MINUTE = 6; // сколько переводов в минуту можно одному посетителю

// бесплатные модели пробуются по очереди: если одна недоступна, берётся следующая
const MODELS = [
  "google/gemma-4-26b-a4b-it:free", // самая быстрая из хороших бесплатных
  "google/gemma-4-31b-it:free",
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "openrouter/free", // OpenRouter сам выберет любую доступную бесплатную модель
];
const TIMEOUT_MS = 12000; // если модель думает дольше, пробуем следующую

const hits = new Map();

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": origin === ALLOWED_ORIGIN ? origin : ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status, headers: { "Content-Type": "application/json; charset=utf-8", ...cors(origin) },
  });
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "";
    if (req.method === "OPTIONS") return new Response(null, { headers: cors(origin) });
    if (req.method !== "POST") return json({ error: "Только POST" }, 405, origin);
    if (origin !== ALLOWED_ORIGIN) return json({ error: "Чужой сайт" }, 403, origin);

    // простое ограничение частоты по IP
    const ip = req.headers.get("CF-Connecting-IP") || "?";
    const now = Date.now();
    const list = (hits.get(ip) || []).filter(t => now - t < 60000);
    if (list.length >= PER_MINUTE) return json({ error: "limit", wait: 60 }, 429, origin);
    list.push(now); hits.set(ip, list);

    let body;
    try { body = await req.json(); } catch { return json({ error: "Плохой запрос" }, 400, origin); }
    const text = String(body.text || "").slice(0, MAX_CHARS);
    const to = body.to === "ru" ? "Russian" : "English";
    if (!text.trim()) return json({ error: "Пустой текст" }, 400, origin);

    if (!env.OPENROUTER_KEY) return json({ error: "Не задан секрет OPENROUTER_KEY" }, 500, origin);
    let lastError = "";
    for (const model of MODELS) {
      try {
        const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          signal: AbortSignal.timeout(TIMEOUT_MS),
          method: "POST",
          headers: {
            "Authorization": `Bearer ${env.OPENROUTER_KEY}`,
            "Content-Type": "application/json",
            "HTTP-Referer": ALLOWED_ORIGIN,
            "X-Title": "Translator",
          },
          body: JSON.stringify({
            model,
            temperature: 0.2,
            max_tokens: 2000,
            reasoning: { enabled: false, exclude: true }, // без долгих «размышлений»
            messages: [
              { role: "system", content: `You are a professional translator. Translate the user's text into ${to}. Keep meaning, tone, line breaks and formatting. Output only the translation, no comments.` },
              { role: "user", content: text },
            ],
          }),
        });
        if (!r.ok) {
          lastError = `${model}: ${r.status} ${(await r.text()).slice(0, 200)}`;
          if (r.status === 401) return json({ error: "Ключ OpenRouter не подошёл", detail: lastError }, 500, origin);
          continue;
        }
        const d = await r.json();
        let out = d.choices?.[0]?.message?.content || "";
        out = out.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
        if (out) return json({ text: out, model }, 200, origin);
      } catch (e) { lastError = `${model}: ${e}`; }
    }
    return json({ error: "Все бесплатные модели сейчас заняты", detail: lastError }, 503, origin);
  },
};

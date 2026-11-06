// Посредник для переводчика: хранит ключ OpenRouter и переводит через бесплатные модели DeepSeek.
// Вставляется в Cloudflare Worker. Ключ добавляется в настройках воркера как секрет OPENROUTER_KEY.

const ALLOWED_ORIGIN = "https://noname15092025-ctrl.github.io";
const MAX_CHARS = 5000;
const PER_MINUTE = 6; // сколько переводов в минуту можно одному посетителю

// бесплатные модели пробуются по очереди: если одна недоступна, берётся следующая
const MODELS = [
  "deepseek/deepseek-chat-v3-0324:free",
  "deepseek/deepseek-chat-v3.1:free",
  "deepseek/deepseek-r1:free",
  "meta-llama/llama-3.3-70b-instruct:free",
];

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

    for (const model of MODELS) {
      try {
        const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
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
            messages: [
              { role: "system", content: `You are a professional translator. Translate the user's text into ${to}. Keep meaning, tone, line breaks and formatting. Output only the translation, no comments.` },
              { role: "user", content: text },
            ],
          }),
        });
        if (!r.ok) continue;
        const d = await r.json();
        let out = d.choices?.[0]?.message?.content || "";
        out = out.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
        if (out) return json({ text: out, model }, 200, origin);
      } catch { /* пробуем следующую модель */ }
    }
    return json({ error: "Все бесплатные модели сейчас заняты" }, 503, origin);
  },
};

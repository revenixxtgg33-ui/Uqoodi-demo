// Vercel Serverless Function — proxies chat requests to Groq
// Keeps GROQ_API_KEY secret on the server side.
//
// Set GROQ_API_KEY in Vercel → Project Settings → Environment Variables.

export default async function handler(req, res) {
  // CORS (optional, useful if testing from another origin)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { message, lang } = req.body || {};

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'Missing "message" field' });
  }

  const systemPrompt = lang === 'en'
    ? 'You are the AI assistant for "Uqoodi", a platform that generates professional contracts and price quotes for businesses in the Gulf region. When the user describes their project or service, give a very brief preview (3-4 sentences only) of a quote or contract opening, in a professional and direct tone. Do not write a full contract, just an appealing preview, in English.'
    : 'أنت مساعد ذكاء اصطناعي لمنصة "عقودي" المتخصصة في إنشاء عقود وعروض أسعار احترافية لأصحاب الأعمال في الخليج. عندما يصف المستخدم مشروعه أو خدمته، قدّم معاينة مختصرة جداً (3-4 جمل فقط) لعرض سعر أو بداية عقد مناسب، بأسلوب مهني ومباشر. لا تكتب عقداً كاملاً، فقط مقدمة/معاينة جذابة باللغة العربية.';

  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: message }
        ],
        max_tokens: 220,
        temperature: 0.7
      })
    });

    if (!groqRes.ok) {
      const errText = await groqRes.text();
      console.error('Groq error:', errText);
      return res.status(502).json({ error: 'Upstream error' });
    }

    const data = await groqRes.json();
    const reply = data.choices?.[0]?.message?.content?.trim() || '';

    return res.status(200).json({ reply });
  } catch (err) {
    console.error('Chat handler error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

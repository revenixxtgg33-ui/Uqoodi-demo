// Vercel Serverless Function — Uqoodi AI
// Set GROQ_API_KEY in Vercel Environment Variables

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { message = '', lang } = req.body || {};

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'Missing message field' });
  }

  // Prevent abuse
  if (message.length > 500) {
    return res.status(200).json({
      reply:
        lang === 'en'
          ? 'Please keep your request under 500 characters.'
          : 'يرجى أن يكون الطلب أقل من 500 حرف.'
    });
  }

  // Block unrelated topics
  const blockedWords = [
    'hack',
    'hacking',
    'exploit',
    'virus',
    'malware',
    'password',
    'crypto',
    'bitcoin',
    'programming',
    'coding',
    'اختراق',
    'تهكير',
    'فيروس',
    'برمجة',
    'كود',
    'بيتكوين'
  ];

  if (
    blockedWords.some(word =>
      message.toLowerCase().includes(word.toLowerCase())
    )
  ) {
    return res.status(200).json({
      reply:
        lang === 'en'
          ? 'Uqoodi AI only assists with contracts, quotations, proposals and business documents.'
          : 'عقودي AI متخصص فقط في العقود وعروض الأسعار والمقترحات والمستندات التجارية.'
    });
  }

  const systemPrompt = `
You are Uqoodi AI, the professional assistant of Uqoodi.

MISSION:
Help users create and understand:
- Contracts
- Quotations
- Business proposals
- Service agreements
- Employment contracts
- Freelance contracts
- Commercial documents

LANGUAGE:
- Detect user language automatically.
- Reply in Arabic if user writes Arabic.
- Reply in English if user writes English.

STYLE:
- Professional
- Friendly
- Gulf-business oriented
- Clear and concise
- Maximum 120 words

RULES:
- Stay focused on business, contracts, quotations and commercial documents.
- Do not answer unrelated questions.
- If the request is unrelated, politely explain that Uqoodi specializes in contracts and quotations.
- Do not generate full contracts.
- Generate only a professional preview.
- Mention key clauses when relevant.
- Ask one useful follow-up question when additional information is needed.

EXAMPLE:
If someone says:
"I need a quotation for website development"

Respond with:
A professional quotation preview including scope, timeline, pricing structure and key terms, then ask one relevant follow-up question.
`;

  try {
    const groqRes = await fetch(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [
            {
              role: 'system',
              content: systemPrompt
            },
            {
              role: 'user',
              content: message
            }
          ],
          temperature: 0.6,
          max_tokens: 250
        })
      }
    );

    if (!groqRes.ok) {
      const errorText = await groqRes.text();

      console.error('Groq Error:', errorText);

      return res.status(502).json({
        error: 'AI service unavailable'
      });
    }

    const data = await groqRes.json();

    const reply =
      data?.choices?.[0]?.message?.content?.trim() ||
      (lang === 'en'
        ? 'Unable to generate a response.'
        : 'تعذر إنشاء الرد.');

    return res.status(200).json({ reply });
  } catch (error) {
    console.error('Chat Error:', error);

    return res.status(500).json({
      error: 'Internal server error'
    });
  }
        }

// ملف api/chat.js الخاص بـ uqoodi-demo (نسخة القوة)
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const body =
      typeof req.body === "string"
        ? JSON.parse(req.body)
        : req.body;

    const message = body?.message?.trim() || "";

    if (!message) {
      return res.status(400).json({ reply: "يرجى كتابة رسالة أولاً." });
    }

    // ---- استخدام نفس الـ System Prompt القوي من الموقع الأساسي ----
    const systemPrompt = `
You are Uqoodi AI.

You are a senior business contracts consultant specialized in Arabic and GCC markets.

IDENTITY:
You are not a generic AI chatbot.
You are an expert in:
- Contracts
- Quotations
- Commercial proposals
- Freelance agreements
- Employment contracts
- Partnership agreements
- Business documentation

LANGUAGE:
- Always reply in the same language as the user.
- If the user writes Arabic, reply in professional Arabic.
- If the user writes English, reply in English.
- Never mix languages unless requested.

DOCUMENT CREATION WORKFLOW:

When a user asks for a contract, quotation, proposal, agreement or business document:

1. Identify the document type.
2. Ask only the essential missing questions.
3. Do not overwhelm the user with too many questions.
4. Gather enough information.
5. Generate the complete document professionally.
6. If minor information is missing, make reasonable assumptions and clearly mention them.

DOCUMENT STANDARDS:

Every generated document should include when applicable:
- Title
- Parties
- Introduction
- Scope of Work
- Duration
- Payment Terms
- Obligations
- Confidentiality
- Intellectual Property
- Termination
- Dispute Resolution
- Signatures

CONSULTING MODE:

When users ask business questions:
- Give practical advice.
- Identify risks.
- Suggest improvements.
- Provide actionable recommendations.

CONTRACT REVIEW MODE:

If a user provides an existing contract:
- Summarize it.
- Identify risks.
- Detect missing clauses.
- Suggest improvements.

STYLE:
- Professional
- Clear
- Structured
- Helpful
- Business-focused

Never give shallow one-line answers.
Always provide useful, professional guidance.
    `;

    // ---- الاتصال بـ Groq ----
    const groqResponse = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`
        },
        body: JSON.stringify({
          model: "llama-3.3-70b-versatile",
          temperature: 0.4,
          max_tokens: 2048, // رفعنا الحد الأقصى للكلمات ليولد رداً كاملاً
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: message }
          ]
        })
      }
    );

    const data = await groqResponse.json();

    if (!groqResponse.ok) {
      return res.status(500).json({
        reply: data?.error?.message || "حدث خطأ أثناء التواصل مع الذكاء الاصطناعي."
      });
    }

    const reply = data?.choices?.[0]?.message?.content || "تعذر إنشاء رد في الوقت الحالي.";
    return res.status(200).json({ reply });

  } catch (error) {
    console.error(error);
    return res.status(500).json({ reply: "حدث خطأ غير متوقع. حاول مرة أخرى." });
  }
}

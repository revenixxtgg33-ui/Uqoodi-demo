// api/chat.js — Uqoodi (Groq + Gemini fallback for files)
// - Keeps Groq as the primary chat brain (unchanged behavior)
// - Adds full conversation memory (messages[])
// - Adds strict language enforcement (Arabic ↔ English)
// - Adds Risk Assessment block (=== RISK ASSESSMENT === GREEN/YELLOW/RED)
// - Adds Gemini fallback:
//     * PDFs: try pdf-parse; if it fails/empty, use Gemini to extract text
//     * Images: use Gemini vision to extract any readable text
// - Reads GEMINI_API_KEY or GOOGLE_API_KEY from env

export const config = { api: { bodyParser: { sizeLimit: '15mb' } } };

const GEMINI_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

// ---- Helpers ---------------------------------------------------------------

function detectLang(text) {
  if (!text) return null;
  if (/[\u0600-\u06FF]/.test(text)) return 'ar';
  if (/[A-Za-z]/.test(text)) return 'en';
  return null;
}

async function extractPdfText(buffer) {
  try {
    // Lazy-require so the function still runs if pdf-parse isn't installed.
    const pdfParse = (await import('pdf-parse')).default || (await import('pdf-parse'));
    const out = await pdfParse(buffer);
    const text = (out && out.text ? out.text : '').trim();
    return text || null;
  } catch (e) {
    console.warn('pdf-parse failed:', e && e.message);
    return null;
  }
}

async function geminiExtractFromFile({ mimeType, dataBase64, instruction }) {
  if (!GEMINI_KEY) return null;
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      GEMINI_MODEL
    )}:generateContent?key=${GEMINI_KEY}`;

    const body = {
      contents: [
        {
          role: 'user',
          parts: [
            { text: instruction },
            { inline_data: { mime_type: mimeType, data: dataBase64 } }
          ]
        }
      ]
    };

    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const j = await r.json();
    if (!r.ok) {
      console.warn('Gemini error:', j && (j.error?.message || JSON.stringify(j)));
      return null;
    }
    const parts = j?.candidates?.[0]?.content?.parts || [];
    const text = parts.map((p) => p.text || '').join('\n').trim();
    return text || null;
  } catch (e) {
    console.warn('Gemini call failed:', e && e.message);
    return null;
  }
}

async function extractAttachmentText(attachment) {
  if (!attachment || !attachment.dataBase64) return null;
  const mime = (attachment.mimeType || '').toLowerCase();
  const buffer = Buffer.from(attachment.dataBase64, 'base64');

  // PDF
  if (mime.includes('pdf') || /\.pdf$/i.test(attachment.name || '')) {
    const text = await extractPdfText(buffer);
    if (text && text.length > 30) return { text, source: 'pdf-parse' };
    // Fallback to Gemini for scanned/empty PDFs
    const gem = await geminiExtractFromFile({
      mimeType: 'application/pdf',
      dataBase64: attachment.dataBase64,
      instruction:
        'Extract ALL readable text from this PDF (including scanned pages). Return plain text only, preserving line breaks. No commentary.'
    });
    if (gem) return { text: gem, source: 'gemini-pdf' };
    return null;
  }

  // Image
  if (mime.startsWith('image/') || /\.(png|jpe?g|webp)$/i.test(attachment.name || '')) {
    const gem = await geminiExtractFromFile({
      mimeType: mime || 'image/png',
      dataBase64: attachment.dataBase64,
      instruction:
        'Extract ALL readable text from this image (OCR). If it looks like a contract or document, return the text faithfully. Return plain text only, no commentary.'
    });
    if (gem) return { text: gem, source: 'gemini-image' };
    return null;
  }

  return null;
}

// ---- Handler ---------------------------------------------------------------

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    const message = (body.message || '').trim();
    const incomingMessages = Array.isArray(body.messages) ? body.messages : [];
    const attachment = body.attachment || null;
    const hintLang = body.userLang || body.lang || null;

    if (!message && !attachment && incomingMessages.length === 0) {
      return res.status(400).json({ reply: 'يرجى كتابة رسالة أولاً.' });
    }

    // 1) Handle file (if any) -> extracted text appended to last user turn
    let extracted = null;
    if (attachment) {
      extracted = await extractAttachmentText(attachment);
    }

    // 2) Build the message array sent to Groq
    const systemPrompt = `
You are Uqoodi AI — a senior business contracts consultant specialized in Arabic and GCC markets.

IDENTITY:
- Expert in: contracts, quotations, commercial proposals, freelance agreements,
  employment contracts, partnership agreements, and business documentation.
- You are NOT a generic chatbot.

LANGUAGE RULES (STRICT):
- Detect the language of the LATEST user message.
- If the user writes in Arabic, the ENTIRE reply (including headings, labels, and the
  Risk Assessment block) MUST be in professional Arabic.
- If the user writes in English, the ENTIRE reply MUST be in English.
- Never mix languages in the same reply unless the user explicitly asks for it.
- Keep the same language across the whole answer — no English boilerplate in Arabic
  replies and vice versa.

CONVERSATION MEMORY:
- You are given the full prior conversation. Use it. Do not ask the user to repeat
  details they already provided.

DOCUMENT CREATION WORKFLOW:
1. Identify the document type.
2. Ask only the essential missing questions (don't overwhelm).
3. Generate the complete document professionally.
4. If minor info is missing, make reasonable assumptions and clearly mention them.

DOCUMENT STANDARDS (when applicable):
Title, Parties, Introduction, Scope of Work, Duration, Payment Terms, Obligations,
Confidentiality, Intellectual Property, Termination, Dispute Resolution, Signatures.

CONTRACT REVIEW / RISK ANALYSIS MODE:
When the user provides an existing contract (pasted text OR an uploaded PDF/image
whose text was extracted for you), you MUST:
- Summarize the contract briefly.
- Detect missing clauses and suggest improvements.
- Then ALWAYS append a Risk Assessment block at the end in this EXACT format:

=== RISK ASSESSMENT ===
[GREEN] <safe / well-drafted clause or aspect>
[YELLOW] <caution / could be improved>
[RED] <serious risk / missing protection>
=== END ===

Use the tags GREEN / YELLOW / RED in English brackets EXACTLY as shown, even when
the rest of the reply is in Arabic (the surrounding description text follows the
user's language). Include at least one item per color when relevant; omit a color
only if there is genuinely nothing to report for it.

STYLE: Professional, clear, structured, helpful, business-focused.
Never give shallow one-line answers.
`;

    // Normalize prior messages from the client (defensive)
    const priorMessages = incomingMessages
      .filter((m) => m && typeof m.content === 'string' && (m.role === 'user' || m.role === 'assistant'))
      .slice(-20); // cap history to last 20 turns

    // Compose the latest user message (inject extracted file text if present)
    let latestUserContent = message;
    if (extracted && extracted.text) {
      const header =
        hintLang === 'ar'
          ? `\n\n--- محتوى الملف المرفق (${attachment?.name || 'file'}) ---\n`
          : `\n\n--- Attached file content (${attachment?.name || 'file'}) ---\n`;
      latestUserContent = (latestUserContent || '') + header + extracted.text + '\n--- END ---';
    } else if (attachment && !extracted) {
      const note =
        hintLang === 'ar'
          ? `\n\n(تعذر استخراج نص قابل للقراءة من الملف المرفق: ${attachment.name || ''})`
          : `\n\n(Could not extract readable text from attached file: ${attachment.name || ''})`;
      latestUserContent = (latestUserContent || '') + note;
    }

    // If the client sent a full history, replace the last user turn's content
    // with the augmented one (so file text is included). Otherwise build fresh.
    let messages;
    if (priorMessages.length > 0) {
      messages = [{ role: 'system', content: systemPrompt }, ...priorMessages];
      // Find last user message and augment its content with extracted file text
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') {
          messages[i] = { role: 'user', content: latestUserContent || messages[i].content };
          break;
        }
      }
    } else {
      messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: latestUserContent || message }
      ];
    }

    // Add an explicit language directive based on detected language of the
    // latest user content (overrides client hint when content is unambiguous).
    const detected = detectLang(latestUserContent) || hintLang || 'ar';
    const langDirective =
      detected === 'en'
        ? 'Reply ENTIRELY in English. Do not switch to Arabic.'
        : 'الرجاء الرد بالكامل باللغة العربية. لا تستخدم الإنجليزية.';
    messages.splice(1, 0, { role: 'system', content: langDirective });

    // 3) Call Groq (unchanged)
    const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        temperature: 0.4,
        max_tokens: 2048,
        messages
      })
    });

    const data = await groqResponse.json();

    if (!groqResponse.ok) {
      return res.status(500).json({
        reply: data?.error?.message || 'حدث خطأ أثناء التواصل مع الذكاء الاصطناعي.'
      });
    }

    const reply =
      data?.choices?.[0]?.message?.content || 'تعذر إنشاء رد في الوقت الحالي.';

    return res.status(200).json({
      reply,
      extractedFrom: extracted ? extracted.source : null
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ reply: 'حدث خطأ غير متوقع. حاول مرة أخرى.' });
  }
}

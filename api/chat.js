// api/chat.js — Uqoodi demo backend (Vercel Serverless, Node runtime)
//
// What this file does:
//   • Accepts the full `messages[]` conversation history from the frontend
//     (plus a legacy `message` field as fallback) and forwards it to Groq.
//   • If the request includes an attachment (PDF or image as base64), it
//     extracts text from it (pdf-parse for PDFs, Gemini as fallback / OCR
//     for images) and appends the extracted text to the latest user turn
//     before calling Groq.
//   • Strictly enforces:
//       - Language match: Arabic ↔ Arabic, English ↔ English (never mix).
//       - Contract-review output MUST include the
//         === RISK ASSESSMENT === ... === END === block tagged
//         [GREEN] / [YELLOW] / [RED].
//   • Groq integration itself (endpoint, model, key, temperature) is
//     unchanged — only the `messages` array fed to it is enriched.

export const config = { runtime: "nodejs" };

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

async function extractFromPdfBuffer(buffer) {
  try {
    const mod = await import("pdf-parse");
    const pdfParse = mod.default || mod;
    const parsed = await pdfParse(buffer);
    const text = (parsed && parsed.text ? parsed.text : "").trim();
    if (text && text.length > 20) return text;
    return null;
  } catch (e) {
    console.error("[chat] pdf-parse failed:", e && e.message);
    return null;
  }
}

async function geminiExtract({ base64, mime, prompt }) {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!key) return null;
  try {
    const url =
      "https://generativelanguage.googleapis.com/v1beta/models/" +
      encodeURIComponent(GEMINI_MODEL) +
      ":generateContent?key=" +
      encodeURIComponent(key);

    const body = {
      contents: [
        {
          role: "user",
          parts: [
            { text: prompt },
            { inline_data: { mime_type: mime, data: base64 } }
          ]
        }
      ]
    };
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const j = await r.json();
    if (!r.ok) {
      console.error("[chat] Gemini error:", j && j.error && j.error.message);
      return null;
    }
    const parts =
      (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts)
      || [];
    const out = parts.map(p => p.text || "").join("\n").trim();
    return out || null;
  } catch (e) {
    console.error("[chat] Gemini call failed:", e && e.message);
    return null;
  }
}

async function extractAttachmentText(attachment) {
  if (!attachment || !attachment.dataBase64) return null;
  const mime = (attachment.mime || "").toLowerCase();
  const name = attachment.name || "file";

  if (mime === "application/pdf" || name.toLowerCase().endsWith(".pdf")) {
    const buf = Buffer.from(attachment.dataBase64, "base64");
    const text = await extractFromPdfBuffer(buf);
    if (text) return text;
    // Fallback: Gemini reads the PDF directly
    return await geminiExtract({
      base64: attachment.dataBase64,
      mime: "application/pdf",
      prompt:
        "Extract ALL text from this PDF document verbatim. Preserve order, paragraphs and any clause numbering. Return plain text only, no commentary."
    });
  }

  if (mime.startsWith("image/")) {
    return await geminiExtract({
      base64: attachment.dataBase64,
      mime,
      prompt:
        "Extract ALL text from this image (OCR). Preserve order and line breaks. Return plain text only, no commentary."
    });
  }

  return null;
}

const SYSTEM_PROMPT = `
You are Uqoodi AI — a "Smart Risk Detective" and senior business contracts
consultant specialized in Arabic and GCC markets.

IDENTITY:
You are not a generic AI chatbot. You are an expert in:
- Contracts
- Quotations
- Commercial proposals
- Freelance agreements
- Employment contracts
- Partnership agreements
- Business documentation

LANGUAGE (STRICT):
- ALWAYS reply in the SAME language as the user's latest message.
- If the user's latest message is in Arabic → reply ENTIRELY in professional Arabic.
- If the user's latest message is in English → reply ENTIRELY in English.
- NEVER mix languages in a single reply unless the user explicitly asks for both.

SMART CHAT BEHAVIOR (WHEN TO ANALYZE vs. WHEN TO CHAT):
- If the user's latest message is a greeting (e.g. "Hello", "مرحبا", "hi",
  "كيف حالك") or a general / casual question that is NOT about a specific
  contract, reply with a normal, friendly, short professional text response.
  DO NOT perform risk analysis. DO NOT append the RISK ASSESSMENT block.
- ONLY perform Deep Risk Analysis when EITHER of these is true:
  (a) The user attached a PDF/image and its extracted text appears in the
      latest user turn between "--- BEGIN FILE CONTENT ---" and
      "--- END FILE CONTENT ---".
  (b) The user explicitly pastes a contract / clause text OR explicitly
      asks you to review, analyze, audit, or check risks in a contract.
- If it is ambiguous whether a pasted block is a contract, ask ONE short
  clarifying question instead of forcing an analysis.

DOCUMENT CREATION WORKFLOW:
When the user asks for a contract, quotation, proposal, agreement or business document:
1. Identify the document type.
2. Ask only the essential missing questions.
3. Do not overwhelm the user with too many questions.
4. Gather enough information, then generate the complete document professionally.
5. If minor information is missing, make reasonable assumptions and clearly mention them.

DOCUMENT STANDARDS:
Every generated document should include when applicable: Title, Parties, Introduction,
Scope of Work, Duration, Payment Terms, Obligations, Confidentiality,
Intellectual Property, Termination, Dispute Resolution, Signatures.

CONSULTING MODE:
When the user asks business questions: give practical advice, identify risks,
suggest improvements, provide actionable recommendations.

=========================================================
DEEP RISK ANALYSIS MODE — "SMART RISK DETECTIVE"
=========================================================
Triggered ONLY by condition (a) or (b) above.

When triggered, you MUST:

1. Start with a brief 2–4 line summary of the contract (parties, purpose,
   duration, payment if visible).

2. Detect AT LEAST 3 SPECIFIC risks (aim for 4–6 when the document is long
   enough). Generic warnings are NOT acceptable — each risk must quote or
   clearly reference the actual clause / wording / missing item from the
   document.

3. For EACH detected risk, output the following structured block, in this
   exact order, using these emojis and labels (translate the labels to
   Arabic when replying in Arabic, but keep the emojis and the [GREEN] /
   [YELLOW] / [RED] tag in English uppercase):

   🔴 Risk Level: [GREEN] | [YELLOW] | [RED]
   📌 Clause / Issue: <quote or precisely describe the clause or the
      missing element from the contract>
   💡 Actionable Solution: <clear, concrete step the user should take —
      negotiate, remove, add, clarify, cap, etc.>
   📝 Suggested Redraft: <a ready-to-use corrected / replacement clause
      the user can copy into the contract. Provide this whenever
      reasonably possible; if truly not applicable (e.g. the fix is only
      to delete the clause) write "N/A" and explain why in one short line>

   Separate each risk block from the next with a blank line.

4. Risk level meaning:
   - [GREEN]  = clause is safe / well-drafted, minor or no concern.
   - [YELLOW] = clause needs caution, clarification, or tightening.
   - [RED]    = high risk, unfair, unenforceable, or dangerously missing.

5. After listing the individual risk blocks, end the reply with a short
   "Priority actions" list (max 3 bullets) telling the user what to fix
   FIRST before signing.

6. AT THE VERY END of the reply, append the following block EXACTLY (keep
   the markers verbatim, in English, even if the rest of the reply is
   Arabic). This block is machine-read by the frontend and MUST NOT be
   omitted or renamed in Risk Analysis Mode:

=== RISK ASSESSMENT ===
[GREEN] <short one-line finding>
[YELLOW] <short one-line finding>
[RED] <short one-line finding>
... (one line per finding, at least 3 lines total, mirroring the risks above)
=== END ===

Rules for the RISK ASSESSMENT block:
- Each finding line MUST start with [GREEN], [YELLOW], or [RED]
  (uppercase, in square brackets).
- The descriptive text after the tag must be in the SAME language as the
  rest of the reply (Arabic or English).
- The number and severity of lines here MUST match the detailed risk
  blocks above (no inventing new risks, no dropping any).
- Never output this block outside Deep Risk Analysis Mode.

STYLE:
Professional, clear, structured, helpful, business-focused.
Never give shallow one-line answers when analyzing a contract. Always
provide useful, professional, actionable guidance.
`.trim();

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ reply: "Method not allowed" });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});

    const lang = body.lang === "en" ? "en" : (body.lang === "ar" ? "ar" : null);
    const attachment = body.attachment || null;

    // Build messages array: prefer full history, fall back to single `message`.
    let messages = Array.isArray(body.messages) ? body.messages.slice() : [];
    messages = messages
      .filter(m => m && typeof m === "object" && typeof m.content === "string" && (m.role === "user" || m.role === "assistant"))
      .map(m => ({ role: m.role, content: m.content }));

    if (messages.length === 0) {
      const legacy = (body.message || "").toString().trim();
      if (legacy) messages.push({ role: "user", content: legacy });
    }

    if (messages.length === 0 && !attachment) {
      return res.status(400).json({ reply: "يرجى كتابة رسالة أولاً. / Please send a message first." });
    }

    // If an attachment is included, extract its text and append it to the
    // latest user turn (or create one).
    if (attachment) {
      const extracted = await extractAttachmentText(attachment);
      const fileName = attachment.name || "attached-file";
      const note = extracted
        ? `\n\n[Attached file: ${fileName}]\n--- BEGIN FILE CONTENT ---\n${extracted}\n--- END FILE CONTENT ---`
        : `\n\n[Attached file: ${fileName} — could not extract text content]`;

      // find last user message
      let lastUserIdx = -1;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "user") { lastUserIdx = i; break; }
      }
      if (lastUserIdx === -1) {
        messages.push({ role: "user", content: `Please review the attached file.${note}` });
      } else {
        messages[lastUserIdx] = {
          role: "user",
          content: (messages[lastUserIdx].content || "") + note
        };
      }
    }

    // Optional language hint appended as a soft system note.
    const systemMessages = [{ role: "system", content: SYSTEM_PROMPT }];
    if (lang === "ar") {
      systemMessages.push({ role: "system", content: "The user's UI language is Arabic. If their latest message is Arabic, reply entirely in Arabic." });
    } else if (lang === "en") {
      systemMessages.push({ role: "system", content: "The user's UI language is English. If their latest message is English, reply entirely in English." });
    }

    // ---- Groq call (UNCHANGED endpoint / model / key / params) ----
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
          max_tokens: 2048,
          messages: [...systemMessages, ...messages]
        })
      }
    );

    const data = await groqResponse.json();

    if (!groqResponse.ok) {
      return res.status(500).json({
        reply: (data && data.error && data.error.message) || "حدث خطأ أثناء التواصل مع الذكاء الاصطناعي."
      });
    }

    const reply =
      (data && data.choices && data.choices[0] && data.choices[0].message &&
        data.choices[0].message.content) ||
      "تعذر إنشاء رد في الوقت الحالي.";

    return res.status(200).json({ reply });
  } catch (error) {
    console.error("[chat] handler error:", error);
    return res.status(500).json({ reply: "حدث خطأ غير متوقع. حاول مرة أخرى." });
  }
}

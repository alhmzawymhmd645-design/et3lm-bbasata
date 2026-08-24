import express from "express";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
import { createMessengerRouter } from "./server/messenger.js";

dotenv.config();

const SUPER_ADMIN_EMAIL = "alhmzawymhmd645@gmail.com";

// Load Firebase Config safely for token verification
let firebaseConfig: { apiKey?: string; projectId?: string; firestoreDatabaseId?: string } = {};
try {
  const configPath = path.join(process.cwd(), "firebase-applet-config.json");
  if (fs.existsSync(configPath)) {
    firebaseConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  }
} catch (e) {
  console.warn("Could not load firebase-applet-config.json:", e);
}

interface AuthVerificationResult {
  authenticated: boolean;
  uid?: string;
  email?: string;
  isAdmin: boolean;
  error?: string;
}

// Cryptographic Firebase ID Token & Role Verification
async function verifyRequestAuthentication(req: express.Request): Promise<AuthVerificationResult> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return {
      authenticated: false,
      isAdmin: false,
      error: "رمز المصادقة (Bearer ID Token) مطلوب لتنفيذ هذا الإجراء.",
    };
  }

  const idToken = authHeader.split("Bearer ")[1]?.trim();
  if (!idToken) {
    return {
      authenticated: false,
      isAdmin: false,
      error: "رمز المصادقة فارغ.",
    };
  }

  const apiKey = firebaseConfig.apiKey;
  if (!apiKey) {
    return {
      authenticated: false,
      isAdmin: false,
      error: "إعدادات التحقق من الرموز غير مكتملة على الخادم.",
    };
  }

  try {
    const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken }),
    });

    if (!res.ok) {
      return {
        authenticated: false,
        isAdmin: false,
        error: "رمز المصادقة غير صالح أو منتهي الصلاحية.",
      };
    }

    const data = (await res.json()) as { users?: Array<{ localId: string; email: string }> };
    if (!data.users || data.users.length === 0) {
      return {
        authenticated: false,
        isAdmin: false,
        error: "لم يتم العثور على حساب مستخدم مطابق لرمز المصادقة.",
      };
    }

    const user = data.users[0];
    const email = user.email || "";
    const uid = user.localId || "";

    // 1. Check Super Admin email directly
    let isAdmin = email.trim().toLowerCase() === SUPER_ADMIN_EMAIL.toLowerCase();

    // 2. Check Firestore /users collection if not super admin email
    if (!isAdmin && firebaseConfig.projectId && firebaseConfig.firestoreDatabaseId && uid) {
      try {
        const firestoreUrl = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/${firebaseConfig.firestoreDatabaseId}/documents/users/${uid}`;
        const fsRes = await fetch(firestoreUrl, {
          headers: {
            Authorization: `Bearer ${idToken}`,
          },
        });
        if (fsRes.ok) {
          const docData = (await fsRes.json()) as { fields?: Record<string, { stringValue?: string }> };
          if (docData.fields?.role?.stringValue === "admin") {
            isAdmin = true;
          }
        }
      } catch (fsErr) {
        console.warn("Firestore role lookup check warning:", fsErr);
      }
    }

    return {
      authenticated: true,
      uid,
      email,
      isAdmin,
    };
  } catch (err) {
    console.error("Token verification exception:", err);
    return {
      authenticated: false,
      isAdmin: false,
      error: "فشل التحقق من هوية المستخدم.",
    };
  }
}

// Ensure local uploads directory exists
const UPLOADS_DIR = path.join(process.cwd(), "uploads");
if (!fs.existsSync(UPLOADS_DIR)) {
  try {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  } catch (err) {
    console.error("Failed to create uploads directory:", err);
  }
}

let aiClient: GoogleGenAI | null = null;
function getGeminiClient(): GoogleGenAI {
  if (!aiClient) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.warn("GEMINI_API_KEY is not configured in environment variables.");
    }
    aiClient = new GoogleGenAI({
      apiKey: apiKey || "",
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });
  }
  return aiClient;
}

// Resilient Gemini generateContent with model fallbacks & retry
async function generateGeminiContentWithFallback({
  prompt,
  systemInstruction,
  responseMimeType,
  temperature = 0.7,
}: {
  prompt: string;
  systemInstruction?: string;
  responseMimeType?: string;
  temperature?: number;
}): Promise<{ text: string; modelUsed: string }> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("لم يتم تكوين مفتاح GEMINI_API_KEY في إعدادات البيئة.");
  }

  const ai = getGeminiClient();
  const models = [
    "gemini-3.1-flash-lite",
    "gemini-3.7-flash",
    "gemini-flash-latest",
    "gemini-3.1-pro-preview",
  ];

  let lastError: any = null;

  for (const model of models) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const response = await ai.models.generateContent({
          model,
          contents: prompt,
          config: {
            systemInstruction: systemInstruction || undefined,
            responseMimeType: responseMimeType || undefined,
            temperature,
          },
        });
        const text = response.text || "";
        if (text) {
          return { text, modelUsed: model };
        }
      } catch (err: any) {
        lastError = err;
        console.warn(`[Gemini] Model ${model} attempt ${attempt} warning:`, err?.message || err);
        const errMsg = String(err?.message || "");
        if (
          errMsg.includes("404") ||
          errMsg.includes("503") ||
          errMsg.includes("429") ||
          err?.status === 404 ||
          err?.status === 503 ||
          err?.status === 429 ||
          err?.status === "UNAVAILABLE" ||
          err?.status === "RESOURCE_EXHAUSTED"
        ) {
          break;
        }
        if (attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
      }
    }
  }

  throw lastError || new Error("تعذر الحصول على رد من نماذج الذكاء الاصطناعي.");
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: "60mb" }));
  app.use(express.urlencoded({ extended: true, limit: "60mb" }));

  // Static uploads directory serving
  app.use("/uploads", express.static(UPLOADS_DIR, {
    maxAge: "1d",
    setHeaders: (res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("X-Content-Type-Options", "nosniff");
    },
  }));

  // Health check endpoint
  app.get("/api/health", (req, res) => {
    res.json({
      status: "ok",
      platform: "اتعلم ببساطة",
      time: new Date().toISOString(),
    });
  });

  // Internal Messenger & AI Assistant Router
  app.use("/api/messenger", createMessengerRouter());

  // Safe Media & File Upload Endpoint (Images, Videos, Homework, Backgrounds, Documents)
  app.post("/api/upload", async (req, res) => {
    try {
      const {
        fileData,
        fileName = "file",
        fileType = "application/octet-stream",
        category = "general",
      } = req.body;

      if (!fileData || typeof fileData !== "string") {
        return res.status(400).json({ success: false, error: "بيانات الملف مطلوبة" });
      }

      // Authorization Check for Admin-only upload categories
      const adminCategories = [
        "course-thumbnail",
        "lesson-video",
        "homework-file",
        "lesson-image",
        "platform-background",
        "wallet-background",
      ];

      if (adminCategories.includes(category)) {
        const authResult = await verifyRequestAuthentication(req);

        if (!authResult.authenticated) {
          return res.status(401).json({
            success: false,
            error: authResult.error || "غير مصرح: رمز المصادقة (Bearer ID Token) مطلوب للدخول.",
          });
        }

        if (!authResult.isAdmin) {
          return res.status(403).json({
            success: false,
            error: "غير مصرح لك بتنفيذ عملية رفع ملفات إدارية. تقتصر هذه الصلاحية على مدير المنصة فقط.",
          });
        }
      }

      // Size limits by category
      let maxSizeBytes = 50 * 1024 * 1024; // 50MB default
      if (category.includes("image") || category.includes("thumbnail") || category.includes("background")) {
        maxSizeBytes = 15 * 1024 * 1024; // 15MB for images
      } else if (category.includes("homework") || category.includes("document")) {
        maxSizeBytes = 35 * 1024 * 1024; // 35MB for homework documents
      } else if (category.includes("video")) {
        maxSizeBytes = 50 * 1024 * 1024; // 50MB for lesson videos
      }

      // If fileData is already a valid URL (not base64), return it directly
      if (fileData.startsWith("http://") || fileData.startsWith("https://") || fileData.startsWith("/uploads/")) {
        return res.json({
          success: true,
          url: fileData,
          fileName,
          fileType,
          category,
          size: fileData.length,
          uploadedAt: new Date().toISOString(),
        });
      }

      // Extract MIME and base64 payload
      const matches = fileData.match(/^data:([A-Za-z0-9-+/]+);base64,(.+)$/);
      let buffer: Buffer;
      let detectedMime = fileType;

      if (matches && matches.length === 3) {
        detectedMime = matches[1];
        buffer = Buffer.from(matches[2], "base64");
      } else {
        buffer = Buffer.from(fileData, "base64");
      }

      if (buffer.length > maxSizeBytes) {
        return res.status(400).json({
          success: false,
          error: `حجم الملف يتجاوز الحد الأقصى المسموح به لهذا النوع (${Math.round(maxSizeBytes / (1024 * 1024))} ميجابايت)`,
        });
      }

      // Validate allowed mime types & file extensions
      const allowedMimes = [
        // Images
        "image/jpeg",
        "image/jpg",
        "image/png",
        "image/webp",
        "image/gif",
        "image/svg+xml",
        // Videos
        "video/mp4",
        "video/webm",
        "video/quicktime",
        "video/x-matroska",
        "video/ogg",
        // Documents & Archives
        "application/pdf",
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.ms-excel",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/zip",
        "application/x-zip-compressed",
        "application/x-zip",
        "application/octet-stream",
        "text/plain",
      ];

      const isMimeAllowed = allowedMimes.some(
        (m) => detectedMime.toLowerCase().includes(m) || detectedMime.startsWith("image/") || detectedMime.startsWith("video/")
      );

      if (!isMimeAllowed) {
        return res.status(400).json({
          success: false,
          error: "نوع الملف غير مدعوم. يرجى رفع ملفات وسائط أو مستندات صالحة (JPG, PNG, WEBP, MP4, WEBM, PDF, DOCX, ZIP).",
        });
      }

      // Determine appropriate extension
      let extension = path.extname(fileName).toLowerCase().replace(/^\./, "");
      if (!extension) {
        if (detectedMime.includes("jpeg") || detectedMime.includes("jpg")) extension = "jpg";
        else if (detectedMime.includes("png")) extension = "png";
        else if (detectedMime.includes("webp")) extension = "webp";
        else if (detectedMime.includes("mp4")) extension = "mp4";
        else if (detectedMime.includes("webm")) extension = "webm";
        else if (detectedMime.includes("pdf")) extension = "pdf";
        else if (detectedMime.includes("zip")) extension = "zip";
        else if (detectedMime.includes("document") || detectedMime.includes("word")) extension = "docx";
        else extension = "bin";
      }

      // Sanitize filename & create unique storage path
      const randomHash = crypto.randomBytes(6).toString("hex");
      const safeBaseName = path.basename(fileName, path.extname(fileName))
        .replace(/[^a-zA-Z0-9_\-\u0600-\u06FF]/g, "_")
        .substring(0, 30);
      const savedFileName = `${category}_${Date.now()}_${randomHash}_${safeBaseName}.${extension}`;
      const filePath = path.join(UPLOADS_DIR, savedFileName);

      fs.writeFileSync(filePath, buffer);

      const publicUrl = `/uploads/${savedFileName}`;

      return res.json({
        success: true,
        url: publicUrl,
        fileName: fileName || savedFileName,
        fileType: detectedMime,
        category,
        size: buffer.length,
        uploadedAt: new Date().toISOString(),
      });
    } catch (err: any) {
      console.error("Upload error:", err);
      res.status(500).json({ success: false, error: err?.message || "فشل معالجة رفع الملف" });
    }
  });

  // Gemini AI Assistant endpoint (supports both /api/ai-assistant and /api/ai/assistant)
  const handleAiAssistant = async (req: express.Request, res: express.Response) => {
    try {
      const {
        action = "explain", // 'explain' | 'summary' | 'quiz' | 'practice' | 'chat' | 'generate-quiz'
        courseTitle = "",
        lessonTitle = "",
        lessonContent = "",
        lessonDescription = "",
        userPrompt = "",
        language = "ar",
      } = req.body;

      const effectiveContent = lessonContent || lessonDescription || "";

      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        if (action === "generate-quiz" || action === "quiz") {
          return res.json({
            success: true,
            quiz: [
              {
                question: "ما هو الهدف الأساسي من تطبيق المفاهيم العملية في هذا الدرس؟",
                options: ["فهم التطبيق العملي وبناء مشاريع واقعية", "حفظ الأكواد دون تجربة", "تجاوز الممارسة العملية", "الاعتماد على الحفظ النظري"],
                correctIndex: 0,
                explanation: "التعلم بالتطبيق العملي والمشاريع الحقيقية هو جوهر منصة اتعلم ببساطة."
              },
              {
                question: "ما هي أفضل ممارسة عند كتابة الأكواد البرمجية؟",
                options: ["كتابة كود غير منظم", "تقسيم الكود إلى دوال ومكونات واضحة وقابلة لإعادة الاستخدام", "عدم استخدام أسماء دالة للمتغيرات", "تجاهل الأخطاء البرمجية"],
                correctIndex: 1,
                explanation: "التنظيم والنمطية (Modularity) يسهلان صيانة وتطوير البرمجيات."
              },
              {
                question: "كيف تتأكد من جاهزية مشروعك للنشر على الويب؟",
                options: ["اختباره على مختلف الشاشات والأجهزة والتأكد من عدم وجود أخطاء", "نشره دون أي اختبار", "تعطيل التجاوب مع الهواتف", "حذف ملفات التنسيق"],
                correctIndex: 0,
                explanation: "الاختبار الشامل والتجاوب يضمنان تجربة مستخدم مثالية."
              }
            ]
          });
        }
        return res.status(200).json({
          success: true,
          reply:
            language === "ar"
              ? "مرحباً بك في مساعد «اتعلم ببساطة»! لتفعيل إجابات Gemini المباشرة والتوليد المتقدم، يرجى ضبط مفتاح GEMINI_API_KEY."
              : "Welcome to Learn Simply AI Tutor! Please set your GEMINI_API_KEY for dynamic live responses.",
        });
      }

      const ai = getGeminiClient();

      let systemInstruction = `أنت «المساعد التعليمي الذكي لمنصة اتعلم ببساطة».
مهمتك مساعدة الطلاب العرب في فهم الدروس البرمجية والتقنية وتبسيط أعقد المفاهيم بأسلوب سهل، شيق، وباللغة العربية الفصحى البسيطة الممزوجة بأمثلة عملية وواقعية.
احرص دائماً على:
1. التنسيق المنظم باستخدام العناوين والنقاط والفقرات الواضحة.
2. استخدام أكواد وأمثلة توضيحية عند الحاجة.
3. التحفيز والتشجيع وإعطاء نصائح للتطبيق العملي.`;

      let prompt = "";

      if (action === "explain") {
        prompt = `اشرح لي بالتفصيل وبأسلوب مبسط جداً درس: "${lessonTitle}" من كورس "${courseTitle}".
سياق محتوى الدرس:
${effectiveContent || "درس تقني تفاعلي"}

الاستفسار المحدد من الطالب:
${userPrompt || "اشرح المفاهيم الأساسية، كيف تعمل، وأعطني مثالاً عملياً بسيطاً وتطبيقات واقعية."}`;
      } else if (action === "summary") {
        prompt = `قم بتلخيص درس: "${lessonTitle}" من كورس "${courseTitle}".
محتوى الدرس:
${effectiveContent || "درس تقني"}
المطلوب:
1. الفكرة الرئيسية في سطرين.
2. أهم 4-5 نقاط ومفاهيم مستفادة.
3. أهم الأوامر أو التعليمات الأساسية إن وجدت.
4. خلاصة سريعة للاسترجاع السريع للمعلومة.`;
      } else if (action === "quiz" || action === "generate-quiz") {
        prompt = `قم بإنشاء اختبار سريع تفاعلي من 3 أسئلة اختيار من متعدد (MCQ) لاختبار فهم الطالب لدرس "${lessonTitle}" في كورس "${courseTitle}".
سياق الدرس: ${effectiveContent || "محتوى الدرس التقني"}
${userPrompt ? `ملاحظات إضافية: ${userPrompt}` : ""}

أجب بصيغة JSON فقط متطابقة مع هذا المخطط:
[
  {
    "question": "نص السؤال باللغة العربية",
    "options": ["الخيار الأول", "الخيار الثاني", "الخيار الثالث", "الخيار الرابع"],
    "correctIndex": 0,
    "explanation": "شرح مبسط ومقنع لسبب صحة هذا الخيار"
  }
]`;
      } else if (action === "challenge" || action === "practice") {
        prompt = `أعطني تمريناً عملياً وتحدياً تطبيقياً متدرج الصعوبة حول درس: "${lessonTitle}" (كورس "${courseTitle}").
المطلوب:
1. الهدف من التمرين.
2. متطلبات التنفيذ خطوة بخطوة.
3. تلميحات ذكية للمساعدة دون كشف الحل بالكامل مباشرة.
4. الحل النموذجي مع الشرح.`;
      } else {
        // General chat
        prompt = `سياق الكورس الحالي: "${courseTitle}"
سياق الدرس الحالي: "${lessonTitle}"
محتوى الدرس: ${effectiveContent || ""}

سؤال أو رسالة الطالب:
${userPrompt}`;
      }

      // If quiz, return JSON structured schema or parse it
      if (action === "quiz" || action === "generate-quiz") {
        const { text } = await generateGeminiContentWithFallback({
          prompt,
          systemInstruction,
          responseMimeType: "application/json",
          temperature: 0.3,
        });
        try {
          const parsed = JSON.parse(text);
          return res.json({ success: true, quiz: parsed });
        } catch {
          return res.json({ success: true, rawText: text });
        }
      }

      const { text: replyText } = await generateGeminiContentWithFallback({
        prompt,
        systemInstruction,
        temperature: 0.7,
      });

      res.json({
        success: true,
        reply: replyText || "لم يتم إنشاء إجابة، يرجى المحاولة مرة أخرى.",
        content: replyText,
        explanation: replyText,
        summary: replyText,
      });
    } catch (error: any) {
      console.error("AI Assistant error:", error);
      res.status(500).json({
        success: false,
        error: error?.message || "حدث خطأ أثناء معالجة الطلب عبر الذكاء الاصطناعي.",
      });
    }
  };

  app.post("/api/ai-assistant", handleAiAssistant);
  app.post("/api/ai/assistant", handleAiAssistant);
  app.post("/api/generate-quiz", handleAiAssistant);

  // Gemini AI Support Auto-Reply Endpoint
  app.post("/api/support-ai", async (req: express.Request, res: express.Response) => {
    try {
      const {
        studentMessage = "",
        subject = "",
        category = "general",
        studentName = "الطالب",
        conversationHistory = [],
        platformSettings = {},
      } = req.body;

      const apiKey = process.env.GEMINI_API_KEY;
      const walletNumber = platformSettings.etisalatCashNumber || "01157783934";
      const platformName = platformSettings.platformName || "اتعلم ببساطة";

      if (!apiKey) {
        // High quality fallback responses based on category when key isn't present
        let fallbackReply = `أهلاً بك يا ${studentName}! شكراً لتواصلك مع الدعم الفني لمنصة ${platformName}. `;
        let needsAdmin = false;

        const lowerMsg = studentMessage.toLowerCase();
        if (lowerMsg.includes("دفع") || lowerMsg.includes("كاش") || lowerMsg.includes("فلوس") || lowerMsg.includes("تحويل") || lowerMsg.includes("ايصال") || category === "payment") {
          fallbackReply += `بالنسبة للمدفوعات والاشتراكات، يتم التحويل عبر محفظة اتصالات كاش الرسمية: (${walletNumber}). بعد التحويل، يرجى رفع صورة الإيصال في نافذة الدفع وسيتم تفعيل كورسكم فوراً بعد مراجعة المشرف. إذا كنت قد حولت بالفعل، تم تحويل طلبك لفريق الدعم للمراجعة السريعة.`;
          needsAdmin = true;
        } else if (lowerMsg.includes("شهادة") || lowerMsg.includes("شهادات") || lowerMsg.includes("تخرج")) {
          fallbackReply += `تصدر الشهادات تلقائياً ومعتمدة باسمك بمجرد إكمال 100% من جميع دروس الكورس في لوحة الطالب.`;
        } else if (lowerMsg.includes("فيديو") || lowerMsg.includes("مشكلة") || lowerMsg.includes("خطأ") || lowerMsg.includes("مش شغال")) {
          fallbackReply += `نأسف لأي إزعاج! تم إحالة المشكلة إلى فريق الدعم الفني لفحصها ومساعدتك في أقرب وقت.`;
          needsAdmin = true;
        } else {
          fallbackReply += `سؤالك واستفسارك قيد المتابعة. هل تحتاج لأي مساعدة إضافية بخصوص الكورسات أو التسجيل؟`;
        }

        return res.json({
          success: true,
          reply: fallbackReply,
          needsAdmin,
        });
      }

      const systemInstruction = `أنت المساعد الذكي الرسمي للدعم الفني وخدمة عملاء منصة «${platformName}» التعليمية.
هدفك مساعدة الطلاب والرد على استفساراتهم بسرعة، وبأسلوب عربي راقٍ، مهذب ومختصر (لا يزيد عن 3-4 فقرات قصيرة).

معلومات وبيانات المنصة الرسمية:
1. اسم المنصة: ${platformName}
2. رقم محفظة التحويل والدفع (Etisalat Cash): ${walletNumber}
3. طريقة الاشتراك: يختار الطالب الكورس، يضغط على اشتراك، يحول المبلغ لرقم المحفظة ${walletNumber}، ثم يرفع صورة الإيصال. يقوم الأدمن بالموافقة خلال دقائق وتفعيل المحتوى فوراً.
4. لوحة الطالب: تحتوي على كورسات الطالب، نسبة التقدم، سجل التحويلات، والشهادات المكتسبة.
5. الشهادات: تصدر فور إتمام 100% من دروس الكورس.
6. حماية المحتوى: الكورسات مشفرة ومحمية من التحميل والتسجيل لضمان حقوق الملكية.

قواعد اتخاذ القرار بالرد وتصعيد التذكرة (needsAdmin):
- إذا كان السؤال استفساراً عاماً أو شرحاً لكيفية الدفع، كيفية بدء الكورسات، الشهادات، حل مشكلة بسيطة: أجب بوضوح وضع needsAdmin = false.
- إذا كانت المشكلة تتطلب تدخلاً بشرياً مثل: (تأخر مراجعة إيصال دفع، طلب استرداد، مشكلة في الحساب الشخصي، خطأ فني معقد، أو الطالب طلب صراحة التحدث مع الدعم البشري/الأدمن): أجب باحترام واطمئنان بأنه تم تصعيد التذكرة لفريق الدعم، وضع needsAdmin = true.

أجب بصيغة JSON حصراً بالتنسيق التالي:
{
  "reply": "نص الرد باللغة العربية بأسلوب مهذب ومختصر ومباشر",
  "needsAdmin": true أو false,
  "confidenceReason": "سبب التصعيد أو الحل"
}`;

      // Build context history
      let historyText = "";
      if (Array.isArray(conversationHistory) && conversationHistory.length > 0) {
        historyText = "\nسجل الرسائل السابقة في التذكرة:\n" +
          conversationHistory
            .map((m: any) => `${m.sender === "student" ? "الطالب" : "الدعم/AI"}: ${m.text}`)
            .join("\n");
      }

      const prompt = `بيانات الطالب:
- الاسم: ${studentName}
- القسم/التصنيف: ${category}
- عنوان الموضوع: ${subject || "استفسار دعم فني"}
${historyText}

رسالة الطالب الحالية:
"${studentMessage}"

المطلوب: توليد رد ذكي مختصر ومحدد باللغة العربية مع تحديد ما إذا كان الأمر يحتاج تدخل فريق الدعم.`;

      const { text: raw } = await generateGeminiContentWithFallback({
        prompt,
        systemInstruction,
        responseMimeType: "application/json",
        temperature: 0.3,
      });

      try {
        const parsed = JSON.parse(raw);
        return res.json({
          success: true,
          reply: parsed.reply || "تم استلام رسالتك وفريق الدعم في خدمتك دائماً.",
          needsAdmin: Boolean(parsed.needsAdmin),
        });
      } catch (parseErr) {
        return res.json({
          success: true,
          reply: raw,
          needsAdmin: false,
        });
      }
    } catch (err: any) {
      console.error("Support AI Error:", err);
      res.status(500).json({
        success: false,
        error: err?.message || "تعذر معالجة رد الدعم الفني بالذكاء الاصطناعي.",
      });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`«اتعلم ببساطة» Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();

import type { PdfWording } from './types.js';

/** Word for word as the web's print view (dictionaries, `policies.document`, `policies.imported`, `policies.notInForce`). */
export const ar: PdfWording = {
  "dir": "rtl",
  "languages": {
    "en": "الإنجليزية",
    "ar": "العربية",
    "fr": "الفرنسية"
  },
  "controlBlock": "وثيقة مضبوطة",
  "number": "الرقم",
  "version": "الإصدار",
  "title": "العنوان",
  "owner": "المسؤول عن الوثيقة",
  "ownerUnit": "الجهة المسؤولة",
  "effectiveOn": "تاريخ السريان",
  "nextReviewOn": "المراجعة القادمة",
  "authoritative": "اللغة المرجعية",
  "approvals": "الإعداد والمراجعة والاعتماد",
  "noApprovals": "لا يوجد توقيع بعد.",
  "preparedBy": "الإعداد: {name}، {date}",
  "reviewedBy": "المراجعة: {name}، {date}",
  "approvedBy": "الاعتماد: {name}، {date}",
  "notSet": "غير محدد",
  "unknownPerson": "مستخدم سابق",
  "notControlled": "النسخ المطبوعة غير مضبوطة. تحقّق من Trustline للاطلاع على الإصدار الساري.",
  "printHeader": "{number} · الإصدار {version} · {title}",
  "printHeaderOriginal": "{number} · الإصدار {version} ({revision} في الأصل) · {title}",
  "printedOn": "طُبعت هذه النسخة في {date}، ولا يُعتدّ بها إلا في ذلك اليوم.",
  "pageOf": "الصفحة {page} من {pages}",
  "sectionInOther": "هذا القسم غير مكتوب باللغة {language}، وهو معروض هنا باللغة {other}.",
  "sectionLagging": "لم يُحدَّث هذا القسم باللغة {language} بعد تعديل نصه باللغة {authoritative}. وحيث يختلف النصان، يُعتدّ بالنص باللغة {authoritative}.",
  "notInForce": {
    "retired": "أُوقف العمل بها، غير سارية",
    "superseded": "حلّ محله إصدار أحدث، غير سارٍ",
    "withdrawn": "مسحوب، لم يدخل حيز السريان",
    "unpublished": "غير منشور، غير سارٍ"
  },
  "imported": {
    "title": "معتمدة قبل Trustline",
    "notThroughRoute": "أُدخلت من أصلها الموقّع، ولم تمر بمسار الاعتماد في Trustline. يُعاد إصدارها عبر المسار عند مراجعتها القادمة.",
    "revisionLabel": "رقم التنقيح",
    "approvedOn": "تاريخ الاعتماد",
    "approvedBy": "مَن اعتمدها (كما ورد في الأصل)",
    "originalKeptAt": "مكان حفظ الأصل الموقّع",
    "differences": "الاختلافات عن الأصل"
  },
  "contentHash": "بصمة النص الموقّع (SHA-256)",
  "aiDraft": "مسودة ذكاء اصطناعي",
  "aiNotice": "كتبه المساعد الذكي، وقد يحتوي أخطاء أو نقصًا: راجِع كل جزء منه في ضوء طريقة العمل في منشأتك قبل الأخذ به. ولا يُعتمد شيء مما يكتبه ولا يُنشر إلا بقرار من شخص."
};

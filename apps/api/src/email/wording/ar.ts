import type { Wording } from './types.js';

export const ar: Wording = {
  dir: 'rtl',
  greeting: 'مرحبًا،',
  open: 'الفتح في Trustline',
  overdue: 'تجاوز الموعد',
  immediate: {
    incident_reported: {
      subject: 'بلاغ عن حادث خطير: {reference}',
      body: 'ورد بلاغ عن حادث خطير، {reference}، ضمن نطاق تتولى فرز بلاغاته.',
    },
    incident_handed_over: {
      subject: 'أُحيل حادث خطير إلى قسمك: {reference}',
      body: 'أُحيل حادث خطير، {reference}، إلى قسم يقع ضمن نطاق مسؤوليتك.',
    },
    sentinel_flagged: {
      subject: 'أصبح الحادث {reference} حدثًا جسيمًا',
      body: 'حُدِّد الحادث {reference} على أنه حدث جسيم، وسيتطلب إغلاقه اعتماد شخص ثانٍ.',
    },
    incident_assigned: {
      subject: 'كُلِّفتَ بمعالجة الحادث {reference}',
      body: 'تم تكليفك بمعالجة الحادث {reference}.',
    },
    sign_off_requested: {
      subject: 'طلب اعتماد إغلاق: الحادث {reference}',
      body: 'إغلاق الحادث {reference} بانتظار اعتماد من شخص ثانٍ، ويمكنك أنت اعتماده.',
    },
    document_step_review: {
      subject: 'الوثيقة {number} بانتظار مراجعتك',
      body: 'الوثيقة {number}، الإصدار {version}، بانتظار مراجعتك.',
    },
    document_step_approve: {
      subject: 'الوثيقة {number} بانتظار اعتمادك',
      body: 'الوثيقة {number}، الإصدار {version}، بانتظار اعتمادك.',
    },
  },
  weekly: {
    subject: 'إقرارات بالاطلاع متأخرة هذا الأسبوع',
    body: 'لم يُقرّ بعض أفراد فرقك بالاطلاع على وثائق مطلوبة منهم في موعدها.',
    overdue: 'إقرارات بالاطلاع متأخرة: {overdue}',
    people: 'الأشخاص المعنيون: {people}',
    open: 'الاطلاع على التفاصيل في Trustline',
  },
  daily: {
    subject: 'ما ينتظرك في Trustline: {day}',
    intro: 'هذا ما ينتظرك اليوم.',
    acknowledge: 'وثائق مطلوب منك الإقرار بالاطلاع عليها: {count}',
    approve: 'وثائق بانتظار مراجعتك أو اعتمادك: {count}',
    reviews: 'مراجعات دورية مستحقة: {count}',
    incidents: 'حوادث أنت المكلَّف بها: {count}',
    incidentsOverdue: 'منها متأخرة: {count}',
    more: 'و{count} أخرى في Trustline.',
    open: 'فتح Trustline',
  },
  footer: {
    member: 'تصلك هذه الرسالة لأنك من مستخدمي Trustline في {organization}.',
    noDetails: 'لا تتضمن رسائل Trustline أي تفاصيل عن الحادث أو الوثيقة: سجّل الدخول للاطلاع عليها.',
    unsubscribeImmediate: 'إيقاف هذه الرسائل الفورية',
    unsubscribeDigest: 'إيقاف رسائل الملخص هذه',
    preferences: 'تغيير تفضيلات البريد الإلكتروني',
  },
  page: {
    title: 'رسائل البريد الإلكتروني من Trustline',
    confirmImmediate: 'هل تريد إيقاف الرسائل الفورية من Trustline؟',
    confirmDigest: 'هل تريد إيقاف رسائل الملخص اليومية والأسبوعية من Trustline؟',
    button: 'إيقاف هذه الرسائل',
    doneImmediate: 'لن تصلك الرسائل الفورية بعد الآن.',
    doneDigest: 'لن تصلك رسائل الملخص بعد الآن.',
    turnBackOn: 'يمكنك إعادة تفعيلها في Trustline، من تفضيلات الإشعارات.',
    invalid: 'هذا الرابط غير صالح أو انتهت صلاحيته.',
  },
};

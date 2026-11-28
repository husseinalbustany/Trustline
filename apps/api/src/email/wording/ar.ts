import type { Wording } from './types.js';

export const ar: Wording = {
  dir: 'rtl',
  greeting: 'مرحبًا،',
  open: 'افتح في Trustline',
  serious: 'جسيمة',
  overdue: 'متأخر',
  version: 'الإصدار {version}',
  immediate: {
    incident_reported: {
      subject: 'بلاغ عن حادثة جسيمة: {reference}',
      body: 'وردَ بلاغ عن حادثة جسيمة، {reference}، في نطاق يحق لك فرزه.',
    },
    incident_handed_over: {
      subject: 'أُحيلت حادثة جسيمة إلى قسمك: {reference}',
      body: 'أُحيلت حادثة جسيمة، {reference}، إلى قسم تتولى حوادثه.',
    },
    sentinel_flagged: {
      subject: 'أصبحت الحادثة {reference} حدثًا جسيمًا منذرًا',
      body: 'صُنّفت الحادثة {reference} حدثًا جسيمًا منذرًا.',
    },
    incident_assigned: {
      subject: 'أُسندت إليك الحادثة {reference}',
      body: 'أُسندت إليك الحادثة {reference}.',
    },
    sign_off_requested: {
      subject: 'طلب اعتماد إغلاق: الحادثة {reference}',
      body: 'ينتظر إغلاق الحادثة {reference} توقيعًا ثانيًا يحق لك منحه.',
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
    subject: 'إقرارات متأخرة هذا الأسبوع',
    body: 'لدى بعض أفراد فرقك وثائق مطلوب الإقرار بها وقد انقضت مهلتها.',
    overdue: 'إقرارات متأخرة: {overdue}',
    people: 'الأشخاص المعنيون: {people}',
    open: 'اطّلع على التفاصيل في Trustline',
  },
  daily: {
    subject: 'ما ينتظرك في Trustline: {day}',
    intro: 'هذا ما ينتظرك اليوم.',
    acknowledge: 'وثائق مطلوب الإقرار بها: {count}',
    approve: 'وثائق بانتظار مراجعتك أو اعتمادك: {count}',
    reviews: 'مراجعات دورية مستحقة: {count}',
    incidents: 'حوادث مسندة إليك: {count}',
    incidentsOverdue: 'منها متأخرة: {count}',
    more: 'و{count} أخرى في Trustline.',
    open: 'افتح Trustline',
  },
  footer: {
    member: 'تصلك هذه الرسالة بصفتك عضوًا في {organization} على Trustline.',
    noDetails: 'لا تتضمن رسائل Trustline أي تفاصيل: سجّل الدخول للاطلاع عليها.',
    unsubscribeImmediate: 'أوقف هذه الرسائل الفورية',
    unsubscribeDigest: 'أوقف رسائل الملخص هذه',
    preferences: 'غيّر تفضيلات البريد الإلكتروني',
  },
  page: {
    title: 'رسائل Trustline',
    confirmImmediate: 'هل تريد إيقاف الرسائل الفورية من Trustline؟',
    confirmDigest: 'هل تريد إيقاف رسائل الملخص اليومية والأسبوعية من Trustline؟',
    button: 'أوقف هذه الرسائل',
    doneImmediate: 'لن تصلك الرسائل الفورية بعد الآن.',
    doneDigest: 'لن تصلك رسائل الملخص بعد الآن.',
    turnBackOn: 'يمكنك إعادة تفعيلها في Trustline، من تفضيلات الإشعارات.',
    invalid: 'هذا الرابط غير صالح أو منتهي الصلاحية. يمكنك تغيير تفضيلات البريد الإلكتروني في Trustline.',
  },
};

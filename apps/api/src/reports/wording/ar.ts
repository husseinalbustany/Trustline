import type { ReportsWording } from './types.js';

export const ar: ReportsWording = {
  measures: {
    'incidents.time_to_report': 'مدة تقديم البلاغ (الوسيط بالثواني)',
    'incidents.reported': 'البلاغات المقدَّمة',
    'incidents.triaged_on_time': 'الفرز في الموعد',
    'actions.overdue': 'الإجراءات التصحيحية المتأخرة',
    'policies.past_review': 'وثائق فات موعد مراجعتها',
    'policies.acknowledged': 'نسبة الإقرار بالاطلاع',
  },
  csv: {
    month: 'الشهر',
    unit: 'الوحدة',
    unitPath: 'الموضع في الهيكل التنظيمي',
    measure: 'المؤشر',
    value: 'القيمة',
    numerator: 'العدد المحتسب',
    denominator: 'من أصل',
    target: 'الهدف',
    met: 'تحقق الهدف',
    status: 'الحالة',
    method: 'طريقة الحساب',
    revision: 'المراجعة',
    asAt: 'كما في',
    definitionVersion: 'إصدار التعريف',
  },
  organization: 'المنشأة كاملة',
  status: { provisional: 'مؤقت', final: 'نهائي' },
  method: { snapshot: 'مسجَّل في نهاية الشهر', reconstructed: 'معاد بناؤه من السجلات', corrected: 'مصحَّح' },
  yes: 'نعم',
  no: 'لا',
};

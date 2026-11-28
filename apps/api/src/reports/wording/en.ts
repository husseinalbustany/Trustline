import type { ReportsWording } from './types.js';

export const en: ReportsWording = {
  measures: {
    'incidents.time_to_report': 'Time to submit a report (median seconds)',
    'incidents.reported': 'Reports submitted',
    'incidents.triaged_on_time': 'Triaged on time',
    'actions.overdue': 'Overdue corrective actions',
    'policies.past_review': 'Documents past their review date',
    'policies.acknowledged': 'Acknowledgement completion',
  },
  csv: {
    month: 'Month',
    unit: 'Unit',
    unitPath: 'Place in the structure',
    measure: 'Measure',
    value: 'Value',
    numerator: 'Counted',
    denominator: 'Out of',
    target: 'Target',
    met: 'Target met',
    status: 'Status',
    method: 'How it was taken',
    revision: 'Revision',
    asAt: 'As at ({zone})',
    definitionVersion: 'Definition version',
  },
  organization: 'Whole organization',
  status: { provisional: 'Provisional', final: 'Final' },
  method: { snapshot: 'Taken at month end', reconstructed: 'Reconstructed from records', corrected: 'Corrected' },
  yes: 'Yes',
  no: 'No',
};

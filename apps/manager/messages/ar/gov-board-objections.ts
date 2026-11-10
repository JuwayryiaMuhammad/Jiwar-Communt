import type { Translation } from '@jiwar/i18n';
import type en from '../en/gov-board-objections.ts';

const ar: Translation<typeof en> = {
  title: 'الاعتراضات',
  description:
    'للملاك أن يعترضوا على قرار لمجلس الإدارة خلال أيام الاعتراض المحددة في المجمع. يرد المجلس مرة واحدة، بأسبابه، على كل المعترضين؛ وبعدها لا يقبل القرار اعتراضات أخرى.',
  empty: 'لا يوجد قرار يقبل اعتراضات',
  'col.decision': 'القرار',
  'col.decidedOn': 'تاريخ القرار',
  'col.until': 'الاعتراض حتى',
  'col.state': 'الوضع',
  aDecision: 'قرار',
  'state.open': 'يقبل الاعتراضات',
  'state.closed': 'انتهت أيام الاعتراض',
  'state.answered': 'تم الرد',
  ofDecision: 'الاعتراضات على قرار',
  answer: 'رُدّ',
  count: 'عدد الاعتراضات',
  takenUntil: 'تُقبل حتى',
  boardAnswer: 'رد مجلس الإدارة',
  grounds: 'أسباب الاعتراض',
  noObjection: 'لا توجد اعتراضات',
  'col.grounds': 'الأسباب',
  'col.lodged': 'تاريخ التقديم',
  groundsErased: 'حُذفت: حُذف حساب صاحبها.',
  answered: 'تم الرد وأُبلغ كل المعترضين؛ ولا يقبل القرار اعتراضات أخرى.',
  answerTitle: 'رُدّ على الاعتراضات',
  answerDescription: 'مرة واحدة، باسم مجلس الإدارة: يقرؤه كل المعترضين، ولا يقبل القرار بعده اعتراضات أخرى. لا تذكر اسم أحد.',
};

export default ar;

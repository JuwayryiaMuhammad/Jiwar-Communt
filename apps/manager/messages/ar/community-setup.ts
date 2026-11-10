import type { Translation } from '@jiwar/i18n';
import type en from '../en/community-setup.ts';

const ar: Translation<typeof en> = {
  title: 'إعدادات المجتمع',
  description: 'ما يمكن للسكان إرسال اقتراحات عنه، وعدد الضيوف المسموح به عند الرد على فعالية.',
  'tab.topics': 'موضوعات الاقتراحات',
  'tab.rules': 'قواعد الفعاليات',
  events: 'الفعاليات',
  guests: 'أقصى عدد للضيوف في الرد الواحد',
  guestsHint: 'عدد من يمكن أن يصطحبهم الساكن الذي سيحضر. يشغل الضيوف مقاعد مثل غيرهم. يسري التغيير على الردود من الآن.',
  guestsInvalid: 'عدد صحيح من {min} إلى {max}.',
  rulesSaved: 'تم حفظ القواعد.',
  newTopic: 'موضوع جديد',
  editTopic: 'تعديل {name}',
  topicSaved: 'تم حفظ {name}.',
  topicDescription: 'ما يختاره الساكن عند كتابة اقتراح.',
  topicActive: 'متاح للسكان (دون تحديد: متوقف، ويبقى على الاقتراحات التي استخدمته)',
  empty: 'لا توجد موضوعات بعد',
  emptyHint: 'لا يستطيع السكان إرسال اقتراح حتى يوجد موضوع واحد على الأقل.',
  'col.topic': 'الموضوع',
  'col.code': 'الرمز',
  retired: 'متوقف',
};

export default ar;

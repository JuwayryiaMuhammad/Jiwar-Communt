/** Community setup (ADR 0040): app/(dashboard)/community-setup and components/community-setup. */
export default {
  title: 'Community setup',
  description: 'What residents may send suggestions about, and how many guests an answer to an event may bring.',
  'tab.topics': 'Suggestion topics',
  'tab.rules': 'Event rules',
  // Event rules.
  events: 'Events',
  guests: 'Guests per answer, at most',
  guestsHint:
    'How many people a resident who is going may bring. Guests take seats like anyone else. A change applies to answers given from now on.',
  guestsInvalid: 'A whole number from {min} to {max}.',
  rulesSaved: 'The rules are saved.',
  // Suggestion topics.
  newTopic: 'New topic',
  editTopic: 'Edit {name}',
  topicSaved: '{name} is saved.',
  topicDescription: 'What a resident picks when they write a suggestion.',
  topicActive: 'Offered to residents (unticked: retired, kept on the suggestions that used it)',
  empty: 'No topic yet',
  emptyHint: 'Residents cannot send a suggestion until there is one.',
  'col.topic': 'Topic',
  'col.code': 'Code',
  retired: 'Retired',
} as const;

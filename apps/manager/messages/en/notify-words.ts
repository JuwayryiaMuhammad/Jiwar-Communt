/**
 * Words lib/notifications.ts puts inside a notification’s sentence
 * (notify-kinds): a login’s device, a board post’s kind, a field exception.
 */
export default {
  // The coarse device type of a login (the backend's DeviceType).
  'device.ios': 'iPhone or iPad',
  'device.android': 'Android phone',
  'device.desktop_web': 'computer browser',
  'device.mobile_web': 'phone browser',
  'device.other': 'device',
  // The kind of a board post, in words; never its text (ADR 0042).
  'post.lost': 'lost item',
  'post.found': 'found item',
  'post.lend': 'lending offer',
  'post.borrow': 'request to borrow',
  'post.other': 'post',
  // A field exception's kind, inside a sentence (ADR 0056).
  'exception.worker_outside_hours': 'a worker outside their hours',
  'exception.visitor_without_pass': 'a visitor without a pass',
  'exception.unregistered_vehicle': 'an unregistered vehicle',
  'exception.other': 'someone',
} as const;

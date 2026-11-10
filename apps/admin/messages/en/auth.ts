/** Sign-in, the forced password change and the account page: app/login, app/change-password, app/(dashboard)/account, components/password-form. */
export default {
  // Sign-in.
  'login.title': 'Platform sign-in',
  'login.subtitle': 'For Jiwar platform administrators.',
  'login.password': 'Password',
  'login.submit': 'Sign in',
  'login.bandTitle': 'Every compound, one console.',
  'login.bandBody': 'Open compounds, appoint their managers, and watch sign-in security across the platform.',
  'login.point.compounds': 'Compounds and their managers',
  'login.point.events': 'Security events across tenants',
  'login.point.audit': 'Immutable platform audit trail',
  // The forced password change.
  'change.title': 'Set a new password',
  'change.body': 'This password was set at setup. Choose your own before you continue.',
  'change.alert': 'Changing it signs out every other platform session.',
  'change.submit': 'Save and continue',
  'change.back': 'Back to sign-in',
  'change.bandTitle': 'One more step.',
  'change.bandBody': 'The setup password stops working once you save a new one.',
  // The password form.
  'form.current': 'Current password',
  'form.new': 'New password',
  'form.minLength': '{n, plural, one {At least # character.} other {At least # characters.}}',
  'form.repeat': 'Repeat new password',
  'form.mismatch': 'Does not match.',
  // The account page.
  'account.title': 'Account',
  'account.description': 'Your platform administrator sign-in.',
  'account.changeTitle': 'Change password',
  'account.changeSubmit': 'Change password',
  'account.alert': 'Saving signs out every other platform session. This one stays signed in.',
  'account.changed': 'Password changed.',
  'account.lockoutTitle': 'Lockout',
  'account.lockoutBody': 'Repeated wrong passwords lock the account for a while. Each attempt is a security event.',
} as const;

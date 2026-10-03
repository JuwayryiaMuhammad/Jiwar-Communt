/** Why a unit is under review (UnitReviewReason). */
export const REVIEW_TEXT: Record<string, string> = {
  primary_left: 'Primary resident left',
  primary_frozen: 'Primary account frozen',
  primary_deceased: 'Primary resident deceased',
  separation: 'Separation reported',
};

/** Plain words for the permission catalog (backend access/permissions.ts). */
export const PERMISSION_TEXT: Record<string, string> = {
  'units.read': 'See units',
  'units.create': 'Add units',
  'accounts.read': 'See accounts',
  'accounts.manage': 'Create and change accounts',
  'accounts.erase': 'Erase deleted accounts',
  'accounts.legal_hold': 'Place legal holds',
  'residents.read': 'See residents',
  'residents.manage': 'Manage residents and occupancies',
  'roles.read': 'See roles',
  'roles.manage': 'Change role permissions',
  'audit.read': 'Read the audit log',
  'settings.manage': 'Change compound settings',
  'household.manage': 'Manage own household',
  'household.approve': 'Approve household members',
  'household.override': 'Override household decisions',
  'household.delegate': 'Delegate household rights',
  'workers.manage': 'Register domestic workers',
  'workers.review': 'Review domestic workers',
  'workers.ban': 'Ban workers',
  'workers.compliance': 'Handle compliance cases',
  'workers.incidents': 'Handle card incidents',
  'gate.operate': 'Operate the gate',
  'gate.manage': 'Set up gates',
  'gate.read': 'Read gate entries',
  'visitors.invite': 'Invite visitors',
};

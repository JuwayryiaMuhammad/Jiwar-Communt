/** Maintenance setup's field safety (ADR 0067): components/maintenance-setup/safety. */
export default {
  hazardsDescription: 'Its work starts only with an approved permit, not expired, for each of these.',
  published: 'Version {version} published: technicians acknowledge it before they start.',
  instructionsTitle: 'Safety instructions · {name}',
  instructionsDescription:
    'Each change is the next version; a version never changes. A technician acknowledges the current one for each ticket before the work starts or resumes.',
  publish: 'Publish the next version',
  latest: 'Version {version}, {when}: {text}',
  noneYet: 'None yet.',
  inEnglish: 'In English',
  inArabic: 'In Arabic',
  noPermit: 'No permit needed',
  categories: 'Categories',
  emptyCategories: 'No category',
  'col.category': 'Category',
  'col.permit': 'Needs a permit for',
  hazards: 'Hazards',
  instructions: 'Instructions',
  assetTypes: 'Asset types',
  emptyTypes: 'No asset type',
  'col.assetType': 'Asset type',
  hazardsTitle: 'What {name} needs a permit for',
} as const;

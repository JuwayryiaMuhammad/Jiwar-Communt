/** The complaints map (ADR 0081): app/(dashboard)/complaints-map. */
export default {
  title: 'Complaints map',
  description:
    'The tickets of each building’s units and of each common area over the period, cancelled ones left out. No unit, ticket or person is shown here.',
  emptyBuildings: 'No building in the register',
  tickets: 'Tickets',
  open: 'Open',
  fromResidents: 'From residents',
  most: 'Most',
  position: 'Position',
  areasTitle: 'Common areas',
  areasDescription: 'Their own tickets and their assets’.',
  emptyAreas: 'No common area had a ticket in this period',
  area: 'Area',
} as const;

'use client';

import { unwrap, type Schema } from '@jiwar/api';
import { api } from './api';

export type Me = Schema<'MeView'>;
export type Unit = Schema<'UnitView'>;
export type UnitDetail = Schema<'UnitDetailView'>;
export type UnitNeedingReview = Schema<'UnitNeedingReviewView'>;
export type Resident = Schema<'ResidentListItemView'>;
export type ResidentDetail = Schema<'ResidentDetailView'>;
export type Account = Schema<'AccountListItemView'>;
export type Registration = Schema<'PendingRegistrationView'>;
export type RegistrationLink = Schema<'RegistrationLinkResponse'>;
export type PendingMember = Schema<'PendingMemberView'>;
export type Engagement = Schema<'ReviewEngagementView'>;
export type EngagementStatus = Schema<'WorkerEngagementStatus'>;
export type ComplianceCase = Schema<'ComplianceCaseResponse'>;
export type CardIncident = Schema<'CardIncidentResponse'>;
export type Gate = Schema<'GateView'>;
export type Entry = Schema<'EntryListView'>;
export type Role = Schema<'RoleView'>;
export type Permission = Schema<'PermissionView'>;
export type Settings = Schema<'SettingsView'>;
export type AuditEntry = Schema<'AuditEntryView'>;
export type Ticket = Schema<'DispatchTicketView'>;
export type TicketDetail = Schema<'DispatchTicketDetailView'>;
export type TicketSla = Schema<'DispatchTicketSlaView'>;
export type TicketStatus = Schema<'TicketStatus'>;
export type TicketPriority = Schema<'TicketPriority'>;
export type Technician = Schema<'TechnicianOptionView'>;
export type Specialty = Schema<'SpecialtyView'>;
export type CategoryOption = Schema<'CategoryOptionView'>;
export type Visit = Schema<'DispatchVisitView'>;
export type TicketMessage = Schema<'DispatchMessageView'>;
export type Category = Schema<'CategoryView'>;
export type SlaTargets = Schema<'SlaTargetsView'>;
export type PreventiveService = Schema<'PreventiveServiceView'>;
export type MaintenanceSettings = Schema<'MaintenanceSettingsResponse'>;
export type DispatchSettings = Schema<'DispatchSettingsResponse'>;
export type SlaSettings = Schema<'SlaSettingsResponse'>;
export type AccountDetail = Schema<'AccountDetailView'>;
export type Erasure = Schema<'PendingErasureView'>;
export type ErasureScope = Schema<'ErasureScopeView'>;
export type LegalHold = Schema<'LegalHoldResponse'>;
export type Preferences = Schema<'PreferencesView'>;
export type Consent = Schema<'ConsentView'>;
export type DataExport = Schema<'DataExportView'>;
export type DeletionRequest = Schema<'DeletionRequestResponse'>;
export type Parcel = Schema<'ManagerParcelView'>;
export type ParcelStatus = Schema<'ParcelStatus'>;
export type ParcelCarrier = Schema<'ParcelCarrier'>;
export type ParcelSettings = Schema<'ParcelSettingsResponse'>;
export type Notification = Schema<'NotificationView'>;
export type Session = Schema<'SessionView'>;
// Requests to the management (ADR 0039).
export type ManagementRequest = Schema<'StaffRequestListItemView'>;
export type ManagementRequestDetail = Schema<'StaffRequestDetailView'>;
export type ManagementRequestStatus = Schema<'ManagementRequestStatus'>;
export type ManagementRequestType = Schema<'ManagementRequestType'>;
// Community life (ADR 0040).
export type Announcement = Schema<'StaffAnnouncementListItemView'>;
export type AnnouncementDetail = Schema<'StaffAnnouncementView'>;
export type AnnouncementVersion = Schema<'AnnouncementVersionView'>;
export type AnnouncementKind = Schema<'AnnouncementKind'>;
export type Audience = Schema<'AudienceView'>;
export type CommunityAttachment = Schema<'CommunityAttachmentView'>;
export type CommunityEvent = Schema<'StaffEventListItemView'>;
export type CommunityEventDetail = Schema<'StaffEventView'>;
export type Attendee = Schema<'AttendeeView'>;
export type Poll = Schema<'StaffPollView'>;
export type Suggestion = Schema<'StaffSuggestionListItemView'>;
export type SuggestionDetail = Schema<'StaffSuggestionView'>;
export type SuggestionStatus = Schema<'SuggestionStatus'>;
export type SuggestionTopic = Schema<'SuggestionTopicView'>;
export type AnnouncementFilters = { status: Announcement['status'] | ''; kind: AnnouncementKind | '' };
export type EventFilters = { status: CommunityEvent['status'] | '' };
export type PollFilters = { status: Poll['status'] | '' };
export type SuggestionFilters = { status: SuggestionStatus | ''; topicId: string; published: 'true' | 'false' | '' };
export type RequestMessage = Schema<'StaffRequestMessageView'>;
export type RequestTopic = Schema<'TopicView'>;
export type RequestTopicOption = Schema<'TopicOptionView'>;
export type RequestSettings = Schema<'RequestSettingsResponse'>;
export type OfficeWindow = Schema<'OfficeWindowDto'>;
export type Appointment = Schema<'AppointmentView'>;
export type AppointmentItem = Schema<'StaffAppointmentListItemView'>;
export type AppointmentStatus = Schema<'ManagementAppointmentStatus'>;
export type AppointmentMode = Schema<'ManagementAppointmentMode'>;
export type AppointmentSlot = Schema<'StaffAppointmentSlotView'>;
export type RequestRating = Schema<'RatingListItemView'>;
// Neighbours (ADR 0042).
export type Complaint = Schema<'StaffComplaintView'>;
export type ComplaintDetail = Schema<'StaffComplaintDetailView'>;
export type ComplaintStatus = Schema<'NeighbourComplaintStatus'>;
export type ComplaintMessage = Schema<'StaffComplaintMessageView'>;
export type ComplaintCategory = Schema<'ComplaintCategoryView'>;
export type NeighbourPost = Schema<'StaffPostView'>;
export type NeighbourPostKind = Schema<'NeighbourPostKind'>;
export type NeighbourClaim = Schema<'StaffClaimView'>;
export type ConversationReport = Schema<'StaffReportView'>;
export type ReportedMessage = Schema<'ReportedMessageView'>;
export type NeighbourSettings = Schema<'NeighbourSettingsResponse'>;
export type WelcomeTemplate = Schema<'WelcomeTemplateView'>;
// Facilities and bookings, the club (ADR 0044).
export type Facility = Schema<'StaffFacilityView'>;
export type FacilityRules = Schema<'FacilityRulesView'>;
export type FacilityWindow = Schema<'FacilityWindowView'>;
export type FacilityMode = Schema<'FacilityMode'>;
export type CapacityUnit = Schema<'FacilityCapacityUnit'>;
export type StaffBooking = Schema<'StaffBookingView'>;
export type BookingStatus = Schema<'BookingStatus'>;
export type FacilityDay = Schema<'FacilityDayView'>;
export type FacilityClosure = Schema<'FacilityClosureView'>;
export type BookingSuspension = Schema<'BookingSuspensionView'>;
export type FacilitySettings = Schema<'FacilitySettingsResponse'>;
export type ClubPlan = Schema<'ClubPlanView'>;
export type ClubMembership = Schema<'ClubMembershipView'>;
export type ClubMembershipDetail = Schema<'ClubMembershipDetailView'>;
export type ClubPayment = Schema<'ClubPaymentView'>;
export type ClubPerson = Schema<'ClubPersonView'>;
export type ClubUnit = Schema<'ClubUnitView'>;
export type ClubMembershipState = Schema<'ClubMembershipState'>;
// Vehicles and parking (ADR 0045).
export type StaffVehicle = Schema<'StaffVehicleView'>;
export type StaffVehicleDetail = Schema<'StaffVehicleDetailView'>;
export type VehiclePermitStatus = Schema<'VehiclePermitStatus'>;
export type VehicleSettings = Schema<'VehicleSettingsResponse'>;
export type ParkingSlot = Schema<'StaffParkingSlotView'>;
export type VisitorArea = Schema<'VisitorParkingAreaView'>;
export type StaffVisitorParking = Schema<'StaffVisitorParkingBookingView'>;
export type StaffFine = Schema<'StaffFineView'>;
export type FineStatus = Schema<'VehicleFineStatus'>;
export type FinePayment = Schema<'StaffFinePaymentView'>;
export type StaffParkingReport = Schema<'StaffParkingReportView'>;
export type ParkingReportStatus = Schema<'ParkingReportStatus'>;
// Guard shifts and tasks (ADR 0050).
export type RosterSlot = Schema<'RosterSlotView'>;
export type RosterTemplate = Schema<'RosterTemplateView'>;
export type GuardAttendance = Schema<'GuardAttendanceView'>;
export type RosterPosts = Schema<'RosterPostsView'>;
export type RosterGuard = Schema<'RosterGuardView'>;
export type HandoverItem = Schema<'ManagedGuardHandoverItemView'>;
export type StaffHandover = Schema<'StaffGuardHandoverView'>;
export type GuardTask = Schema<'StaffGuardTaskView'>;
export type GuardTaskStatus = Schema<'GuardTaskStatus'>;
export type GuardTaskKind = Schema<'GuardTaskKind'>;
export type GuardSwap = Schema<'StaffGuardSwapView'>;
export type GuardSwapStatus = Schema<'GuardSwapStatus'>;
export type GuardInstruction = Schema<'StaffGuardInstructionView'>;
export type GuardInstructionDetail = Schema<'StaffGuardInstructionDetailView'>;
export type FoundItem = Schema<'StaffFoundItemView'>;
export type FoundItemStatus = Schema<'FoundItemStatus'>;
export type DailyReport = Schema<'DailyReportView'>;
export interface RosterPeriod {
  from: string;
  to: string;
}
export interface SlotFilters extends RosterPeriod {
  guardId?: string;
  gateId?: string;
  zoneId?: string;
}
export interface TaskFilters {
  status?: GuardTaskStatus | '';
  kind?: GuardTaskKind | '';
}

// Emergencies and gate services (ADR 0047).
export type StaffEmergency = Schema<'StaffEmergencyView'>;
export type StaffGateService = Schema<'StaffGateServiceView'>;
export type GateServiceStatus = Schema<'GateServiceStatus'>;
export type GateServiceKind = Schema<'GateServiceKind'>;
export type ManagedPlace = Schema<'ManagedPlaceView'>;
export interface GateServiceFilters {
  status?: GateServiceStatus | '';
  kind?: GateServiceKind | '';
}

// Permits (ADR 0049).
export type StaffPermit = Schema<'StaffPermitView'>;
export type PermitKind = Schema<'UnitPermitKind'>;
export type PermitStatus = Schema<'PermitViewStatus'>;
export type MaterialEntry = Schema<'MaterialEntryView'>;
export type PermitSettings = Schema<'PermitSettingsResponse'>;
export interface PermitFilters {
  status?: PermitStatus | '';
  kind?: PermitKind | '';
  live?: boolean;
}

// Finance (ADR 0046).
export type GatewayView = Schema<'GatewayView'>;
export type GatewayEvent = Schema<'GatewayEventView'>;
export type BillingPlan = Schema<'BillingPlanView'>;
export type BillingOverride = Schema<'BillingOverrideView'>;
export type Invoice = Schema<'InvoiceView'>;
export type InvoiceDetail = Schema<'InvoiceDetailView'>;
export type InvoiceBatch = Schema<'InvoiceBatchView'>;
export type InvoiceKind = Schema<'InvoiceKind'>;
export type Payment = Schema<'PaymentView'>;
export type PaymentDetail = Schema<'PaymentDetailView'>;
export type Statement = Schema<'StatementView'>;
// Finance part 2 (ADR 0048).
export type InstalmentPlan = Schema<'InstalmentPlanView'>;
export type InstalmentPlanDetail = Schema<'InstalmentPlanDetailView'>;
export type StaffDispute = Schema<'StaffDisputeView'>;
export type Refund = Schema<'RefundView'>;
export type LedgerEntry = Schema<'LedgerEntryView'>;
export type AgingReport = Schema<'AgingView'>;
export type CollectionsReport = Schema<'CollectionsView'>;
export type OutstandingReport = Schema<'OutstandingView'>;
export type DailyCashReport = Schema<'DailyCashView'>;
export type LedgerType = LedgerEntry['type'];
export interface LedgerFilters {
  from: string;
  to: string;
  type?: LedgerType | '';
  building?: string;
  unitId?: string;
}
export interface RefundFilters {
  unitId?: string;
  from?: string;
  to?: string;
}
export interface UnitReportFilters {
  groupBy: 'unit' | 'building';
  building?: string;
}
export interface InstalmentPlanFilters {
  status?: 'active' | 'settled' | 'cancelled' | '';
  unitId?: string;
}
export interface InvoiceFilters {
  status?: 'unpaid' | 'partially_paid' | 'overdue' | 'paid' | 'credited' | 'rescheduled' | 'open' | '';
  kind?: InvoiceKind | '';
  unitId?: string;
  building?: string;
  batchId?: string;
  planId?: string;
}
export interface PaymentFilters {
  channel?: 'office' | 'online' | '';
  method?: 'cash' | 'bank_transfer' | 'cheque' | 'card' | 'wallet' | '';
  unitId?: string;
  from?: string;
  to?: string;
}

export interface FineFilters {
  status?: FineStatus | '';
  unitCode?: string;
}

export interface VehicleFilters {
  status?: VehiclePermitStatus | '';
  unitCode?: string;
  plate?: string;
}

export interface StaffBookingFilters {
  status?: BookingStatus | '';
  facilityId?: string;
}

export interface ComplaintFilters {
  status?: ComplaintStatus | '';
  open?: 'true' | 'false' | '';
  categoryId?: string;
  targetUnitId?: string;
  authorId?: string;
}
type ComplaintQuery = { [K in keyof ComplaintFilters]?: Exclude<ComplaintFilters[K], ''> };

export interface NeighbourPostFilters {
  board: NeighbourPost['board'];
  state: NeighbourPost['state'];
}

export interface ManagementRequestFilters {
  status?: ManagementRequestStatus | '';
  type?: ManagementRequestType | '';
  topicId?: string;
  /** An account id, `me`, or `none`. */
  assignee?: string;
  open?: 'true' | '';
  overdue?: 'true' | '';
  escalated?: 'true' | '';
}
type ManagementRequestQuery = { [K in keyof ManagementRequestFilters]?: Exclude<ManagementRequestFilters[K], ''> };

export interface AppointmentFilters {
  status?: AppointmentStatus | '';
  live?: 'true' | '';
  from?: string;
  to?: string;
}
type AppointmentQuery = { [K in keyof AppointmentFilters]?: Exclude<AppointmentFilters[K], ''> };

export interface ParcelFilters {
  status?: ParcelStatus | '';
  carrier?: ParcelCarrier | '';
  unitCode?: string;
}
type ParcelQuery = { [K in keyof ParcelFilters]?: Exclude<ParcelFilters[K], ''> };

export interface TicketFilters {
  status?: TicketStatus | '';
  priority?: TicketPriority | '';
  unassigned?: 'true' | '';
  open?: 'true' | '';
  overdue?: 'true' | '';
  escalated?: 'true' | '';
  technicianId?: string;
  categoryId?: string;
}
/** The same without the empty choices: what reaches the API. */
type TicketQuery = { [K in keyof TicketFilters]?: Exclude<TicketFilters[K], ''> };

/** Query keys: a prefix invalidates everything under it. */
export const keys = {
  me: ['me'] as const,
  units: ['units'] as const,
  unit: (id: string) => ['units', 'detail', id] as const,
  unitsReview: ['units', 'needing-review'] as const,
  residents: ['residents'] as const,
  resident: (id: string) => ['residents', 'detail', id] as const,
  accounts: ['accounts'] as const,
  registrations: ['registrations'] as const,
  registrationLinks: ['registration-links'] as const,
  household: ['household', 'pending'] as const,
  engagements: (status?: string) => ['worker-engagements', status ?? 'all'] as const,
  engagementsAll: ['worker-engagements'] as const,
  compliance: (status: string) => ['compliance-cases', status] as const,
  incidents: (status: string) => ['card-incidents', status] as const,
  gates: ['gates'] as const,
  entries: (filters: object) => ['gate-entries', filters] as const,
  roles: ['roles'] as const,
  permissions: ['permissions'] as const,
  settings: ['settings'] as const,
  audit: (filters: object) => ['audit', filters] as const,
  ticketsAll: ['tickets'] as const,
  tickets: (filters: object) => ['tickets', 'list', filters] as const,
  ticket: (id: string) => ['tickets', 'detail', id] as const,
  ticketPart: (id: string, part: string) => ['tickets', 'detail', id, part] as const,
  technicians: ['technicians'] as const,
  ticketReporters: (unitId: string) => ['units', 'detail', unitId, 'ticket-reporters'] as const,
  specialties: ['specialties'] as const,
  ticketCategories: ['ticket-categories'] as const,
  categories: ['maintenance-categories'] as const,
  preventiveServices: ['preventive-services'] as const,
  maintenanceSettings: ['maintenance-settings'] as const,
  dispatchSettings: ['dispatch-settings'] as const,
  slaSettings: ['sla-settings'] as const,
  account: (id: string) => ['accounts', 'detail', id] as const,
  accountPart: (id: string, part: string) => ['accounts', 'detail', id, part] as const,
  erasures: ['erasures'] as const,
  parcels: (filters: object) => ['parcels', 'list', filters] as const,
  parcel: (id: string) => ['parcels', 'detail', id] as const,
  parcelSettings: ['parcel-settings'] as const,
  engagement: (id: string) => ['worker-engagements', 'detail', id] as const,
  notificationsAll: ['notifications'] as const,
  notifications: (unread: boolean) => ['notifications', 'list', unread ? 'unread' : 'all'] as const,
  unreadCount: ['notifications', 'unread-count'] as const,
  mySessions: ['me', 'sessions'] as const,
  myPreferences: ['me', 'notification-preferences'] as const,
  announcementsAll: ['announcements'] as const,
  announcements: (filters: object) => ['announcements', 'list', filters] as const,
  announcement: (id: string) => ['announcements', 'detail', id] as const,
  announcementPart: (id: string, part: string) => ['announcements', 'detail', id, part] as const,
  communityBuildings: ['community', 'buildings'] as const,
  communitySettings: ['community', 'settings'] as const,
  communityEventsAll: ['community-events'] as const,
  communityEvents: (filters: object) => ['community-events', 'list', filters] as const,
  communityEvent: (id: string) => ['community-events', 'detail', id] as const,
  attendees: (id: string, response: string) => ['community-events', 'detail', id, 'attendees', response] as const,
  pollsAll: ['polls'] as const,
  polls: (filters: object) => ['polls', 'list', filters] as const,
  poll: (id: string) => ['polls', 'detail', id] as const,
  pollAudience: (id: string) => ['polls', 'detail', id, 'audience'] as const,
  suggestionsAll: ['suggestions'] as const,
  suggestions: (filters: object) => ['suggestions', 'list', filters] as const,
  suggestion: (id: string) => ['suggestions', 'detail', id] as const,
  suggestionTopics: ['suggestion-topics'] as const,
  managementAll: ['management-requests'] as const,
  managementRequests: (filters: object) => ['management-requests', 'list', filters] as const,
  managementRequest: (id: string) => ['management-requests', 'detail', id] as const,
  managementRequestPart: (id: string, part: string) => ['management-requests', 'detail', id, part] as const,
  requestAssignees: ['management-requests', 'assignees'] as const,
  requestAuthors: (unitId: string) => ['units', 'detail', unitId, 'request-authors'] as const,
  requestTopicOptions: ['management-request-topic-options'] as const,
  requestTopics: ['management-request-topics'] as const,
  requestSettings: ['management-request-settings'] as const,
  officeHours: ['management-office-hours'] as const,
  appointments: (filters: object) => ['management-requests', 'appointments', filters] as const,
  appointmentSlots: (from: string, days: number) => ['management-requests', 'appointment-slots', from, days] as const,
  requestRatings: ['management-requests', 'ratings'] as const,
  complaintsAll: ['neighbour-complaints'] as const,
  complaints: (filters: object) => ['neighbour-complaints', 'list', filters] as const,
  complaint: (id: string) => ['neighbour-complaints', 'detail', id] as const,
  complaintPart: (id: string, part: string) => ['neighbour-complaints', 'detail', id, part] as const,
  unitComplaintHistory: (unitId: string) => ['neighbour-complaints', 'unit-history', unitId] as const,
  complaintCategories: ['neighbour-complaint-categories'] as const,
  complaintCategoryOptions: ['neighbour-complaint-category-options'] as const,
  neighbourPostsAll: ['neighbour-posts'] as const,
  neighbourPosts: (filters: object) => ['neighbour-posts', 'list', filters] as const,
  neighbourPost: (id: string) => ['neighbour-posts', 'detail', id] as const,
  neighbourClaims: (postId: string) => ['neighbour-posts', 'detail', postId, 'claims'] as const,
  conversationReportsAll: ['neighbour-reports'] as const,
  conversationReports: (status: string) => ['neighbour-reports', 'list', status] as const,
  conversationReport: (id: string) => ['neighbour-reports', 'detail', id] as const,
  conversationReportMessages: (id: string) => ['neighbour-reports', 'detail', id, 'messages'] as const,
  neighbourSettings: ['neighbour-settings'] as const,
  welcomeTemplate: ['neighbour-welcome-template'] as const,
  facilitiesAll: ['facilities'] as const,
  facilities: ['facilities', 'list'] as const,
  facility: (id: string) => ['facilities', 'detail', id] as const,
  facilityClosures: (id: string) => ['facilities', 'detail', id, 'closures'] as const,
  facilityDay: (id: string, date: string) => ['facilities', 'detail', id, 'day', date] as const,
  facilitySettings: ['facility-settings'] as const,
  bookingsAll: ['staff-bookings'] as const,
  bookings: (filters: object) => ['staff-bookings', 'list', filters] as const,
  suspensions: (inForce: string) => ['booking-suspensions', inForce] as const,
  suspensionsAll: ['booking-suspensions'] as const,
  financeGateway: ['finance-gateway'] as const,
  gatewayEvents: (outcome: string) => ['finance-gateway', 'events', outcome] as const,
  billingPlans: ['billing-plans'] as const,
  billingPlan: (id: string) => ['billing-plans', 'detail', id] as const,
  billingOverrides: (id: string) => ['billing-plans', 'overrides', id] as const,
  invoicesAll: ['invoices'] as const,
  invoices: (filters: object) => ['invoices', 'list', filters] as const,
  invoice: (id: string) => ['invoices', 'detail', id] as const,
  paymentsAll: ['payments'] as const,
  payments: (filters: object) => ['payments', 'list', filters] as const,
  payment: (id: string) => ['payments', 'detail', id] as const,
  statement: (unitId: string) => ['invoices', 'statement', unitId] as const,
  instalmentPlans: (filters: object) => ['invoices', 'instalment-plans', filters] as const,
  instalmentPlan: (id: string) => ['invoices', 'instalment-plan', id] as const,
  disputes: (status: string) => ['invoices', 'disputes', status] as const,
  refunds: (filters: object) => ['invoices', 'refunds', filters] as const,
  ledger: (filters: object) => ['invoices', 'ledger', filters] as const,
  report: (name: string, filters: object) => ['invoices', 'report', name, filters] as const,
  dispute: (id: string) => ['invoices', 'dispute', id] as const,
  clubPlans: ['club-plans'] as const,
  clubAll: ['club-memberships'] as const,
  clubMemberships: (state: string) => ['club-memberships', 'list', state] as const,
  clubMembership: (id: string) => ['club-memberships', 'detail', id] as const,
  clubUnitPeople: (unitId: string) => ['club-memberships', 'people', unitId] as const,
  vehiclesAll: ['vehicles'] as const,
  vehicles: (filters: object) => ['vehicles', 'list', filters] as const,
  vehicle: (id: string) => ['vehicles', 'detail', id] as const,
  vehicleSettings: ['vehicle-settings'] as const,
  parkingSlotsAll: ['parking-slots'] as const,
  parkingSlots: (unitCode: string) => ['parking-slots', unitCode] as const,
  visitorAreas: ['visitor-areas'] as const,
  visitorParkingAll: ['visitor-parking'] as const,
  visitorParking: (areaId: string, day: string) => ['visitor-parking', areaId, day] as const,
  finesAll: ['vehicle-fines'] as const,
  fines: (filters: object) => ['vehicle-fines', 'list', filters] as const,
  fine: (id: string) => ['vehicle-fines', 'detail', id] as const,
  parkingReportsAll: ['parking-reports'] as const,
  parkingReports: (status: string) => ['parking-reports', 'list', status] as const,
  parkingReport: (id: string) => ['parking-reports', 'detail', id] as const,
  emergenciesAll: ['emergencies'] as const,
  emergencies: (state: string) => ['emergencies', 'list', state] as const,
  emergency: (id: string) => ['emergencies', 'detail', id] as const,
  gateServicesAll: ['gate-services'] as const,
  gateServices: (filters: object) => ['gate-services', 'list', filters] as const,
  gateService: (id: string) => ['gate-services', 'detail', id] as const,
  places: ['places'] as const,
  permitsAll: ['unit-permits'] as const,
  permits: (filters: object) => ['unit-permits', 'list', filters] as const,
  permit: (id: string) => ['unit-permits', 'detail', id] as const,
  materialEntries: ['unit-permits', 'materials'] as const,
  permitSettings: ['permit-settings'] as const,
  // Guard shifts and tasks (ADR 0050).
  securityPosts: ['security', 'posts'] as const,
  securityGuards: ['security', 'guards'] as const,
  rosterAll: ['security', 'roster'] as const,
  rosterSlots: (f: object) => ['security', 'roster', 'slots', f] as const,
  rosterTemplates: (state: string) => ['security', 'roster', 'templates', state] as const,
  attendance: (f: object) => ['security', 'roster', 'attendance', f] as const,
  handoverItems: ['security', 'handover-items'] as const,
  handoversAll: ['security', 'handovers'] as const,
  handovers: (f: object) => ['security', 'handovers', f] as const,
  guardTasksAll: ['security', 'tasks'] as const,
  guardTasks: (f: object) => ['security', 'tasks', 'list', f] as const,
  guardTask: (id: string) => ['security', 'tasks', 'detail', id] as const,
  swapsAll: ['security', 'swaps'] as const,
  swaps: (status: string) => ['security', 'swaps', 'list', status] as const,
  instructionsAll: ['security', 'instructions'] as const,
  instructions: (state: string) => ['security', 'instructions', 'list', state] as const,
  instruction: (id: string) => ['security', 'instructions', 'detail', id] as const,
  foundItemsAll: ['security', 'found-items'] as const,
  foundItems: (status: string) => ['security', 'found-items', 'list', status] as const,
  dailyReport: (date: string, gateId: string) => ['security', 'daily', date, gateId] as const,
};

/** Empty strings are dropped: the API validates every query value it gets. */
export function clean<T extends object>(filters: T): Partial<T> {
  return Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== '' && v !== undefined)) as Partial<T>;
}

export const fetchers = {
  me: () => unwrap(api.GET('/api/v1/me')),
  units: (cursor?: string, limit = 50) => unwrap(api.GET('/api/v1/units', { params: { query: { cursor, limit } } })),
  unit: (id: string) => unwrap(api.GET('/api/v1/units/{id}', { params: { path: { id } } })),
  unitsReview: (cursor?: string, limit = 50) =>
    unwrap(api.GET('/api/v1/units/needing-review', { params: { query: { cursor, limit } } })),
  residents: (cursor?: string, limit = 50) =>
    unwrap(api.GET('/api/v1/residents', { params: { query: { cursor, limit } } })),
  resident: (id: string) => unwrap(api.GET('/api/v1/residents/{id}', { params: { path: { id } } })),
  accounts: (cursor?: string, limit = 50) =>
    unwrap(api.GET('/api/v1/accounts', { params: { query: { cursor, limit } } })),
  registrations: (cursor?: string, limit = 50) =>
    unwrap(api.GET('/api/v1/registrations', { params: { query: { cursor, limit } } })),
  registrationLinks: (cursor?: string, limit = 50) =>
    unwrap(api.GET('/api/v1/registration-links', { params: { query: { cursor, limit } } })),
  household: (cursor?: string, limit = 50) =>
    unwrap(api.GET('/api/v1/household/pending', { params: { query: { cursor, limit } } })),
  engagements: (status: EngagementStatus | undefined, cursor?: string, limit = 50) =>
    unwrap(api.GET('/api/v1/worker-engagements', { params: { query: { status, cursor, limit } } })),
  compliance: (status: 'open' | 'closed', cursor?: string, limit = 50) =>
    unwrap(api.GET('/api/v1/compliance-cases', { params: { query: { status, cursor, limit } } })),
  incidents: (status: 'open' | 'closed', cursor?: string, limit = 50) =>
    unwrap(api.GET('/api/v1/card-incidents', { params: { query: { status, cursor, limit } } })),
  gates: () => unwrap(api.GET('/api/v1/gates')),
  entries: (
    filters: { gateId?: string; direction?: 'in' | 'out'; subjectType?: Schema<'GateSubjectType'>; from?: string; to?: string },
    cursor?: string,
    limit = 50,
  ) => unwrap(api.GET('/api/v1/gate/entries', { params: { query: { ...clean(filters), cursor, limit } } })),
  roles: () => unwrap(api.GET('/api/v1/roles')),
  permissions: () => unwrap(api.GET('/api/v1/permissions')),
  settings: () => unwrap(api.GET('/api/v1/settings')),
  audit: (filters: { action?: string; targetType?: string; from?: string; to?: string }, cursor?: string, limit = 50) =>
    unwrap(api.GET('/api/v1/audit', { params: { query: { ...clean(filters), cursor, limit } } })),
  tickets: (filters: TicketFilters, cursor?: string, limit = 50) =>
    unwrap(api.GET('/api/v1/maintenance/tickets', { params: { query: { ...(clean(filters) as TicketQuery), cursor, limit } } })),
  ticket: (id: string) => unwrap(api.GET('/api/v1/maintenance/tickets/{id}', { params: { path: { id } } })),
  technicians: () => unwrap(api.GET('/api/v1/maintenance/technicians')),
  ticketReporters: (unitId: string) =>
    unwrap(api.GET('/api/v1/maintenance/units/{unitId}/reporters', { params: { path: { unitId } } })),
  specialties: () => unwrap(api.GET('/api/v1/maintenance/specialties')),
  ticketCategories: () => unwrap(api.GET('/api/v1/ticket-categories')),
  categories: () => unwrap(api.GET('/api/v1/maintenance/categories')),
  preventiveServices: () => unwrap(api.GET('/api/v1/maintenance/preventive-services')),
  maintenanceSettings: () => unwrap(api.GET('/api/v1/maintenance/settings')),
  dispatchSettings: () => unwrap(api.GET('/api/v1/maintenance/dispatch-settings')),
  slaSettings: () => unwrap(api.GET('/api/v1/maintenance/sla-settings')),
  account: (id: string) => unwrap(api.GET('/api/v1/accounts/{id}', { params: { path: { id } } })),
  erasures: (cursor?: string, limit = 50) => unwrap(api.GET('/api/v1/erasures', { params: { query: { cursor, limit } } })),
  legalHolds: (id: string) => unwrap(api.GET('/api/v1/accounts/{id}/legal-holds', { params: { path: { id } } })),
  parcels: (filters: ParcelFilters, cursor?: string, limit = 50) =>
    unwrap(api.GET('/api/v1/parcels', { params: { query: { ...(clean(filters) as ParcelQuery), cursor, limit } } })),
  parcel: (id: string) => unwrap(api.GET('/api/v1/parcels/{id}', { params: { path: { id } } })),
  parcelSettings: () => unwrap(api.GET('/api/v1/parcel-settings')),
  notifications: (unread: boolean, cursor?: string, limit = 30) =>
    unwrap(api.GET('/api/v1/me/notifications', { params: { query: { ...(unread ? { unread: 'true' as const } : {}), cursor, limit } } })),
  unreadCount: () => unwrap(api.GET('/api/v1/me/notifications/unread-count')),
  mySessions: () => unwrap(api.GET('/api/v1/me/sessions')),
  myPreferences: () => unwrap(api.GET('/api/v1/me/notification-preferences')),
  announcements: (filters: AnnouncementFilters, cursor?: string, limit = 50) =>
    unwrap(
      api.GET('/api/v1/community/announcements', {
        params: { query: { ...(clean(filters) as { status?: Announcement['status']; kind?: AnnouncementKind }), cursor, limit } },
      }),
    ),
  announcement: (id: string) => unwrap(api.GET('/api/v1/community/announcements/{id}', { params: { path: { id } } })),
  announcementVersions: (id: string) =>
    unwrap(api.GET('/api/v1/community/announcements/{id}/versions', { params: { path: { id } } })),
  announcementReads: (id: string) => unwrap(api.GET('/api/v1/community/announcements/{id}/reads', { params: { path: { id } } })),
  communityBuildings: () => unwrap(api.GET('/api/v1/community/buildings')),
  communitySettings: () => unwrap(api.GET('/api/v1/community/settings')),
  communityEvents: (filters: EventFilters, cursor?: string, limit = 50) =>
    unwrap(
      api.GET('/api/v1/community/events', {
        params: { query: { ...(clean(filters) as { status?: CommunityEvent['status'] }), cursor, limit } },
      }),
    ),
  communityEvent: (id: string) => unwrap(api.GET('/api/v1/community/events/{id}', { params: { path: { id } } })),
  attendees: (id: string, response: Attendee['response'], cursor?: string, limit = 50) =>
    unwrap(api.GET('/api/v1/community/events/{id}/attendees', { params: { path: { id }, query: { response, cursor, limit } } })),
  polls: (filters: PollFilters, cursor?: string, limit = 50) =>
    unwrap(
      api.GET('/api/v1/community/polls', { params: { query: { ...(clean(filters) as { status?: Poll['status'] }), cursor, limit } } }),
    ),
  poll: (id: string) => unwrap(api.GET('/api/v1/community/polls/{id}', { params: { path: { id } } })),
  pollAudience: (id: string) => unwrap(api.GET('/api/v1/community/polls/{id}/audience', { params: { path: { id } } })),
  suggestions: (filters: SuggestionFilters, cursor?: string, limit = 50) =>
    unwrap(
      api.GET('/api/v1/community/suggestions', {
        params: {
          query: { ...(clean(filters) as { status?: SuggestionStatus; topicId?: string; published?: 'true' | 'false' }), cursor, limit },
        },
      }),
    ),
  suggestion: (id: string) => unwrap(api.GET('/api/v1/community/suggestions/{id}', { params: { path: { id } } })),
  suggestionTopics: () => unwrap(api.GET('/api/v1/community/suggestion-topics')),
  managementRequests: (filters: ManagementRequestFilters, cursor?: string, limit = 50) =>
    unwrap(
      api.GET('/api/v1/management/requests', {
        params: { query: { ...(clean(filters) as ManagementRequestQuery), cursor, limit } },
      }),
    ),
  managementRequest: (id: string) => unwrap(api.GET('/api/v1/management/requests/{id}', { params: { path: { id } } })),
  requestAssignees: () => unwrap(api.GET('/api/v1/management/request-assignees')),
  requestAuthors: (unitId: string) =>
    unwrap(api.GET('/api/v1/management/units/{unitId}/request-authors', { params: { path: { unitId } } })),
  requestTopicOptions: () => unwrap(api.GET('/api/v1/management-request-topics')),
  requestTopics: () => unwrap(api.GET('/api/v1/management/request-topics')),
  requestSettings: () => unwrap(api.GET('/api/v1/management/request-settings')),
  officeHours: () => unwrap(api.GET('/api/v1/management/office-hours')),
  appointments: (filters: AppointmentFilters, cursor?: string, limit = 50) =>
    unwrap(
      api.GET('/api/v1/management/appointments', {
        params: { query: { ...(clean(filters) as AppointmentQuery), cursor, limit } },
      }),
    ),
  appointmentSlots: (from: string | undefined, days: number) =>
    unwrap(api.GET('/api/v1/management/appointment-slots', { params: { query: { from, days } } })),
  requestRating: (id: string) => unwrap(api.GET('/api/v1/management/requests/{id}/rating', { params: { path: { id } } })),
  requestRatings: (cursor?: string, limit = 50) =>
    unwrap(api.GET('/api/v1/management/request-ratings', { params: { query: { cursor, limit } } })),
  complaints: (filters: ComplaintFilters, cursor?: string, limit = 50) =>
    unwrap(api.GET('/api/v1/neighbours/complaints', { params: { query: { ...(clean(filters) as ComplaintQuery), cursor, limit } } })),
  complaint: (id: string) => unwrap(api.GET('/api/v1/neighbours/complaints/{id}', { params: { path: { id } } })),
  unitComplaintHistory: (unitId: string) =>
    unwrap(api.GET('/api/v1/neighbours/units/{unitId}/complaint-history', { params: { path: { unitId } } })),
  complaintCategories: () => unwrap(api.GET('/api/v1/neighbours/complaint-categories')),
  /** The active ones, by name: what a handler may read without `neighbours.manage`. */
  complaintCategoryOptions: () => unwrap(api.GET('/api/v1/neighbour-complaint-categories')),
  neighbourPosts: (filters: NeighbourPostFilters, cursor?: string, limit = 50) =>
    unwrap(api.GET('/api/v1/neighbours/posts', { params: { query: { ...filters, cursor, limit } } })),
  neighbourPost: (id: string) => unwrap(api.GET('/api/v1/neighbours/posts/{id}', { params: { path: { id } } })),
  neighbourClaims: (postId: string) => unwrap(api.GET('/api/v1/neighbours/posts/{id}/claims', { params: { path: { id: postId } } })),
  conversationReports: (status: ConversationReport['status'], cursor?: string, limit = 50) =>
    unwrap(api.GET('/api/v1/neighbours/reports', { params: { query: { status, cursor, limit } } })),
  conversationReport: (id: string) => unwrap(api.GET('/api/v1/neighbours/reports/{id}', { params: { path: { id } } })),
  neighbourSettings: () => unwrap(api.GET('/api/v1/neighbours/settings')),
  welcomeTemplate: () => unwrap(api.GET('/api/v1/neighbours/welcome-template')),
  facilities: () => unwrap(api.GET('/api/v1/staff/facilities')),
  facility: (id: string) => unwrap(api.GET('/api/v1/staff/facilities/{id}', { params: { path: { id } } })),
  facilityClosures: (id: string, cursor?: string, limit = 50) =>
    unwrap(api.GET('/api/v1/staff/facilities/{id}/closures', { params: { path: { id }, query: { cursor, limit } } })),
  facilityDay: (id: string, date: string) =>
    unwrap(api.GET('/api/v1/staff/facilities/{id}/day', { params: { path: { id }, query: { date } } })),
  facilitySettings: () => unwrap(api.GET('/api/v1/staff/facility-settings')),
  bookings: (filters: StaffBookingFilters, cursor?: string, limit = 50) =>
    unwrap(
      api.GET('/api/v1/staff/bookings', {
        params: { query: { ...(clean(filters) as { status?: BookingStatus; facilityId?: string }), cursor, limit } },
      }),
    ),
  suspensions: (inForce: 'true' | 'false', cursor?: string, limit = 50) =>
    unwrap(api.GET('/api/v1/staff/booking-suspensions', { params: { query: { inForce, cursor, limit } } })),
  financeGateway: () => unwrap(api.GET('/api/v1/staff/finance/gateway')),
  gatewayEvents: (outcome: GatewayEvent['outcome'] | '', cursor?: string, limit = 50) =>
    unwrap(
      api.GET('/api/v1/staff/finance/gateway-events', {
        params: { query: { outcome: outcome || undefined, cursor, limit } },
      }),
    ),
  billingPlans: () => unwrap(api.GET('/api/v1/staff/billing-plans')),
  billingOverrides: (id: string) =>
    unwrap(api.GET('/api/v1/staff/billing-plans/{id}/overrides', { params: { path: { id } } })),
  invoices: (filters: InvoiceFilters, cursor?: string, limit = 50) =>
    unwrap(
      api.GET('/api/v1/staff/invoices', {
        params: { query: { ...(clean(filters) as Record<string, never>), cursor, limit } },
      }),
    ),
  invoice: (id: string) => unwrap(api.GET('/api/v1/staff/invoices/{id}', { params: { path: { id } } })),
  payments: (filters: PaymentFilters, cursor?: string, limit = 50) =>
    unwrap(
      api.GET('/api/v1/staff/payments', {
        params: { query: { ...(clean(filters) as Record<string, never>), cursor, limit } },
      }),
    ),
  payment: (id: string) => unwrap(api.GET('/api/v1/staff/payments/{id}', { params: { path: { id } } })),
  statement: (unitId: string) =>
    unwrap(api.GET('/api/v1/staff/units/{unitId}/statement', { params: { path: { unitId } } })),
  instalmentPlans: (filters: InstalmentPlanFilters, cursor?: string, limit = 50) =>
    unwrap(
      api.GET('/api/v1/staff/instalment-plans', {
        params: { query: { ...(clean(filters) as Record<string, never>), cursor, limit } },
      }),
    ),
  instalmentPlan: (id: string) => unwrap(api.GET('/api/v1/staff/instalment-plans/{id}', { params: { path: { id } } })),
  disputes: (status: StaffDispute['status'] | '', cursor?: string, limit = 50) =>
    unwrap(
      api.GET('/api/v1/staff/invoice-disputes', {
        params: { query: { status: status || undefined, cursor, limit } },
      }),
    ),
  dispute: (id: string) => unwrap(api.GET('/api/v1/staff/invoice-disputes/{id}', { params: { path: { id } } })),
  refunds: (filters: RefundFilters, cursor?: string, limit = 50) =>
    unwrap(api.GET('/api/v1/staff/refunds', { params: { query: { ...clean(filters), cursor, limit } } })),
  ledger: (filters: LedgerFilters, cursor?: string, limit = 50) =>
    unwrap(
      api.GET('/api/v1/staff/finance/ledger', {
        params: { query: { ...(clean(filters) as LedgerFilters & { type?: LedgerType }), cursor, limit } },
      }),
    ),
  aging: (filters: UnitReportFilters) =>
    unwrap(api.GET('/api/v1/staff/finance/reports/aging', { params: { query: clean(filters) } })),
  outstanding: (filters: UnitReportFilters) =>
    unwrap(api.GET('/api/v1/staff/finance/reports/outstanding', { params: { query: clean(filters) } })),
  collections: (filters: { from: string; to: string; groupBy: 'day' | 'month' }) =>
    unwrap(api.GET('/api/v1/staff/finance/reports/collections', { params: { query: filters } })),
  dailyCash: (day: string) =>
    unwrap(api.GET('/api/v1/staff/finance/reports/daily-cash', { params: { query: { day } } })),
  clubPlans: () => unwrap(api.GET('/api/v1/staff/club-plans')),
  clubMemberships: (state: ClubMembershipState | '') =>
    unwrap(api.GET('/api/v1/staff/club-memberships', { params: { query: state ? { state } : {} } })),
  clubMembership: (id: string) => unwrap(api.GET('/api/v1/staff/club-memberships/{id}', { params: { path: { id } } })),
  clubUnit: (code: string) => unwrap(api.GET('/api/v1/staff/club/units', { params: { query: { code } } })),
  clubUnitPeople: (unitId: string) =>
    unwrap(api.GET('/api/v1/staff/club/units/{unitId}/people', { params: { path: { unitId } } })),
  vehicles: (filters: VehicleFilters, cursor?: string, limit = 50) =>
    unwrap(
      api.GET('/api/v1/staff/vehicles', {
        params: { query: { ...(clean(filters) as { status?: VehiclePermitStatus; unitCode?: string; plate?: string }), cursor, limit } },
      }),
    ),
  vehicle: (id: string) => unwrap(api.GET('/api/v1/staff/vehicles/{id}', { params: { path: { id } } })),
  vehicleSettings: () => unwrap(api.GET('/api/v1/staff/vehicle-settings')),
  parkingSlots: (unitCode: string, cursor?: string, limit = 50) =>
    unwrap(api.GET('/api/v1/staff/parking-slots', { params: { query: { ...(unitCode ? { unitCode } : {}), cursor, limit } } })),
  visitorAreas: () => unwrap(api.GET('/api/v1/staff/visitor-parking-areas')),
  visitorParking: (areaId: string, day: string) =>
    unwrap(api.GET('/api/v1/staff/visitor-parking-bookings', { params: { query: { ...(areaId ? { areaId } : {}), day } } })),
  fines: (filters: FineFilters, cursor?: string, limit = 50) =>
    unwrap(
      api.GET('/api/v1/staff/vehicle-fines', {
        params: { query: { ...(clean(filters) as { status?: FineStatus; unitCode?: string }), cursor, limit } },
      }),
    ),
  fine: (id: string) => unwrap(api.GET('/api/v1/staff/vehicle-fines/{id}', { params: { path: { id } } })),
  parkingReports: (status: ParkingReportStatus | '', cursor?: string, limit = 50) =>
    unwrap(api.GET('/api/v1/staff/parking-reports', { params: { query: { ...(status ? { status } : {}), cursor, limit } } })),
  parkingReport: (id: string) => unwrap(api.GET('/api/v1/staff/parking-reports/{id}', { params: { path: { id } } })),
  emergencies: (state: 'open' | 'closed', cursor?: string, limit = 50) =>
    unwrap(api.GET('/api/v1/gate/emergencies', { params: { query: { status: state, cursor, limit } } })),
  emergency: (id: string) => unwrap(api.GET('/api/v1/gate/emergencies/{id}', { params: { path: { id } } })),
  gateServices: (filters: GateServiceFilters, cursor?: string, limit = 50) =>
    unwrap(
      api.GET('/api/v1/gate/gate-services', {
        params: { query: { ...(clean(filters) as { status?: GateServiceStatus; kind?: GateServiceKind }), cursor, limit } },
      }),
    ),
  gateService: (id: string) => unwrap(api.GET('/api/v1/gate/gate-services/{id}', { params: { path: { id } } })),
  places: () => unwrap(api.GET('/api/v1/places')),
  permits: (filters: PermitFilters, cursor?: string, limit = 50) =>
    unwrap(
      api.GET('/api/v1/staff/unit-permits', {
        params: {
          query: {
            ...(clean({ status: filters.status, kind: filters.kind }) as { status?: PermitStatus; kind?: PermitKind }),
            ...(filters.live ? { live: true } : {}),
            cursor,
            limit,
          },
        },
      }),
    ),
  permit: (id: string) => unwrap(api.GET('/api/v1/staff/unit-permits/{id}', { params: { path: { id } } })),
  materialEntries: (cursor?: string, limit = 50) =>
    unwrap(api.GET('/api/v1/staff/material-entries', { params: { query: { cursor, limit } } })),
  permitSettings: () => unwrap(api.GET('/api/v1/staff/permit-settings')),
  // Guard shifts and tasks (ADR 0050).
  securityPosts: () => unwrap(api.GET('/api/v1/staff/security/posts')),
  securityGuards: () => unwrap(api.GET('/api/v1/staff/security/guards')),
  rosterSlots: (f: SlotFilters) =>
    unwrap(api.GET('/api/v1/staff/security/roster/slots', { params: { query: clean(f) } })),
  rosterTemplates: (state: 'live' | 'ended' | '') =>
    unwrap(api.GET('/api/v1/staff/security/roster/templates', { params: { query: state ? { state } : {} } })),
  attendance: (f: RosterPeriod & { guardId?: string }) =>
    unwrap(api.GET('/api/v1/staff/security/attendance', { params: { query: clean(f) } })),
  handoverItems: () => unwrap(api.GET('/api/v1/staff/security/handover-items')),
  handovers: (f: RosterPeriod & { state?: 'pending' | 'acknowledged' | '' }) =>
    unwrap(
      api.GET('/api/v1/staff/security/handovers', {
        params: { query: clean(f) as RosterPeriod & { state?: 'pending' | 'acknowledged' } },
      }),
    ),
  guardTasks: (f: TaskFilters, cursor?: string, limit = 50) =>
    unwrap(
      api.GET('/api/v1/staff/security/tasks', {
        params: { query: { ...(clean(f) as { status?: GuardTaskStatus; kind?: GuardTaskKind }), cursor, limit } },
      }),
    ),
  guardTask: (id: string) => unwrap(api.GET('/api/v1/staff/security/tasks/{id}', { params: { path: { id } } })),
  swaps: (status: GuardSwapStatus | '', cursor?: string, limit = 50) =>
    unwrap(api.GET('/api/v1/staff/security/swaps', { params: { query: { ...(status ? { status } : {}), cursor, limit } } })),
  instructions: (state: 'live' | 'archived' | '', cursor?: string, limit = 50) =>
    unwrap(
      api.GET('/api/v1/staff/security/instructions', { params: { query: { ...(state ? { state } : {}), cursor, limit } } }),
    ),
  instruction: (id: string) => unwrap(api.GET('/api/v1/staff/security/instructions/{id}', { params: { path: { id } } })),
  foundItems: (status: FoundItemStatus | '', cursor?: string, limit = 50) =>
    unwrap(api.GET('/api/v1/staff/security/found-items', { params: { query: { ...(status ? { status } : {}), cursor, limit } } })),
  dailyReport: (date: string, gateId: string) =>
    unwrap(
      api.GET('/api/v1/staff/security/reports/daily', {
        params: { query: { ...(date ? { date } : {}), ...(gateId ? { gateId } : {}) } },
      }),
    ),
};

/** "100+" when the first page is full and the API says there is more. */
export function countOf(page: { data: unknown[]; nextCursor?: string | null } | undefined): string {
  if (!page) return '—';
  return page.nextCursor ? `${page.data.length}+` : String(page.data.length);
}

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
};

/** "100+" when the first page is full and the API says there is more. */
export function countOf(page: { data: unknown[]; nextCursor?: string | null } | undefined): string {
  if (!page) return '—';
  return page.nextCursor ? `${page.data.length}+` : String(page.data.length);
}

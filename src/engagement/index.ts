// Public surface of the engagement domain (ADR 0015, 0040): the compound's
// community life. Only governance imports engagement, for the board's
// notices (ADR 0051).
export { EngagementModule } from './engagement.module';
export {
  BoardNotices,
  BOARD_NOTICE_BODY_MAX,
  BOARD_NOTICE_TITLE_MAX,
  type BoardNoticeText,
} from './announcements/board-notices';

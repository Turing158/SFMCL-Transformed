export type NotificationKind = "success" | "error";

export interface Notification {
  id: number;
  kind: NotificationKind;
  message: string;
}

export const NOTIFICATION_LIFETIME = 5000;
export const NOTIFICATION_EXIT_DURATION = 200;

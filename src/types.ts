export type Status = "new" | "follow" | "quoted" | "customer" | "nofit" | "competitor";

export interface Trip {
  state: string;
  name: string;
  startOn: string;
  endOn: string;
  createdAt: string;
  updatedAt: string;
}

export interface Contact {
  id: string;
  name: string;
  role: string;
  phone: string;
  email: string;
  notes: string;
  /** The matching entry in the user's Outlook contacts, once saved there. */
  outlookId?: string;
  outlookStatus?: "pending" | "ok" | "error";
}

export interface Note {
  id: string;
  text: string;
  at: string;
}

export interface Photo {
  id: string;
  at: string;
  /** Set once the picture is stored in OneDrive. */
  uploaded?: boolean;
}

export interface Stop {
  tripId: string;
  name: string;
  kind: string;
  address: string;
  city: string;
  phone: string;
  website: string;
  status: Status;
  visitedOn: string;
  lat?: number;
  lng?: number;
  /** Where lat/lng came from: phone GPS, a street address, or only the town (approximate). */
  geo?: "gps" | "address" | "town";
  contacts: Contact[];
  notes: Note[];
  photos?: Photo[];
  createdAt: string;
  updatedAt: string;
}

/** Calendar link state for a reminder: what we last wrote to (or read from) Outlook. */
export type CalStatus = "pending" | "ok" | "error" | "removed";

export interface Reminder {
  stopId: string;
  tripId: string;
  title: string;
  dueAt: string; // ISO, UTC
  durationMin: number;
  details: string;
  done: boolean;
  eventId?: string;
  calStatus?: CalStatus;
  calSyncedAt?: string;
  /** Device that created it; only that device makes the first Outlook event, so two phones don't both add one. */
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Collections {
  trips: Record<string, Trip>;
  stops: Record<string, Stop>;
  reminders: Record<string, Reminder>;
}
export type ColName = keyof Collections;

export interface Data extends Collections {
  schema: 1;
  /** "col/id" -> deletion time, so a delete on one device wins over an older copy on another. */
  tombstones: Record<string, string>;
}

export const emptyData = (): Data => ({ schema: 1, trips: {}, stops: {}, reminders: {}, tombstones: {} });

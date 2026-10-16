export type ChatThread = {
  id: string;
  customerName?: string | null;
  phone?: string | null;
  status: "open" | "closed";
  lastMessageText?: string | null;
  lastMessageBy?: "customer" | "staff" | null;
  lastMessageAtClientMs?: number | null;
  createdAtClientMs: number;
  unreadForStaff?: number;
  orderId?: string | null;
  source?: string | null;
};

export type ChatMessage = {
  id: string;
  sender: "customer" | "staff";
  text: string;
  staffName?: string | null;
  createdAtClientMs: number;
  respondedAtClientMs?: number | null;
  responseMs?: number | null;
  respondedByProfileId?: string | null;
  respondedByName?: string | null;
  onDutyProfileIdAtArrival?: string | null;
};

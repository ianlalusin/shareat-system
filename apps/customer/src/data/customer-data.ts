import type {
  Bill,
  FeedbackOutcome,
  MenuItem,
  Member,
  Order,
  OrderEvent,
  OrderLine,
  Result,
  SignUpInput,
  TableSession,
} from './types';

/**
 * The one door every diner screen uses to reach data. Today the fixture sits behind it; in P3 a real server does.
 * There is deliberately no method that takes money from the diner.
 */
export interface CustomerData {
  joinByPin(pin: string, deviceId: string): Promise<Result<TableSession>>;
  joinByQr(qrToken: string, deviceId: string): Promise<Result<TableSession>>;
  getMenu(sessionId: string): Promise<Result<MenuItem[]>>;
  placeOrder(sessionId: string, lines: OrderLine[], clientRequestId: string): Promise<Result<Order>>;
  getOrders(sessionId: string): Promise<Result<Order[]>>;
  getBill(sessionId: string): Promise<Result<Bill>>;
  submitFeedback(
    sessionId: string,
    participantId: string,
    rating: number,
    text: string,
  ): Promise<Result<FeedbackOutcome>>;
  requestSignUpCode(phone: string): Promise<Result<{ code: string }>>;
  signUp(input: SignUpInput): Promise<Result<Member>>;
  signIn(phone: string, password: string): Promise<Result<Member>>;
  /** Pushes order changes of one session. Returns the unsubscribe function. */
  subscribe(sessionId: string, listener: (event: OrderEvent) => void): () => void;
}

/** T-589 B4b. The id opened on Branch orders belongs to a sale to a customer: say where it lives instead of "Page not found". */
export const WRONG_LIST_MESSAGE = 'This order is a sale to a customer, so it is listed under Trade orders, not Branch orders.';
export const wrongListHref = (id: string) => `/trade/orders/${id}`;

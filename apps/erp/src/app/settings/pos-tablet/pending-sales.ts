/** T-563 R5 - the sentence on /settings/pos-tablet while this browser's outbox still holds sales. */
export const pendingSalesSentence = (n: number): string =>
  `This tablet still has ${n} unsent ${n === 1 ? 'sale' : 'sales'}. Connect it to the internet and open the POS until they send, then pair again.`;

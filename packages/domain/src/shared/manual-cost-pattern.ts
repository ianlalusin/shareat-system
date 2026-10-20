/** Browser-safe shape shared with the four-decimal cost parser. At least one digit; .5 and 1. are valid. */
export const MANUAL_COST_PATTERN = /^(?=.*\d)\d*(?:\.\d{0,4})?$/;

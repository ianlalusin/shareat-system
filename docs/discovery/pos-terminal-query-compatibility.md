# Terminal sequence query — observed compatibility gap, 22 October
Goal: find the highest receipt number already used before claiming/reclaiming a terminal, without reusing a number.
Local Android/demo Firestore returned FAILED_PRECONDITION, "Firestore does not support descending key scans",
for claim.ts's bare descending document-id range. Firebase CLI15.31.0; no live project queried.
The existing fake's composite-index guard accepts this query and therefore cannot establish SDK/backend compatibility.
Keep document-id prefix ranges and fixed six-digit numbering; reject both catch-and-zero and unrestricted scans.
An ascending existence query at a midpoint gives a monotone predicate over 0..999999, so binary search bounds
work to20 probes even when numbers have gaps. This costs more setup reads than one descending probe but no new
index, stored counter shape or native dependency. Terminal setup is infrequent; sale numbering remains local.
Official query reference: https://firebase.google.com/docs/firestore/query-data/order-limit-data
The bounded ascending shape still requires an actual local SDK/emulator control before implementation is claimed.

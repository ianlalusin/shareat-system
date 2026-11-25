# Ask ERP manual

Plain-words notes for people who use the ERP. Ask ERP reads this file, the glossary and the other approved documents when it answers. If an answer is wrong or missing, fix it here and rebuild the knowledge file (`node scripts/build-ask-knowledge.mjs`).

## What Ask ERP is

Ask ERP answers questions about how the ERP works and about the company's own figures. It answers only from the approved documents and from the screens you are allowed to see. It cannot change anything. It does not show pay, ID numbers, PINs or passwords. If it does not know, it says so. Ask one store and one period at a time for the best answers. Questions may be in English or Taglish.

## Who sees what

Each person sees only the stores they are assigned to, and only the screens their role allows. A manager sees the reports for their own stores. Staff see their own screens. If Ask ERP says it cannot show something, the same screen is closed to you in the ERP: ask an admin if you think you need it. An admin can open a screen for one person, or for a whole position under Position access defaults (/admin/access-defaults).

## Recording an expense

Open Expenses, then New expense (/expenses/new). Choose the store, the date, the supplier and the category, then the amount. An expense that is a bill to pay later is booked to accounts payable. An expense paid by a staff member out of their own pocket is a reimbursement (/expenses/reimbursements). Bills that repeat every month are set up under Recurring expenses (/expenses/recurring) and drafted for you. A budget cap on a category only warns; it never blocks an expense.

## Cash requests

A cash request (/cash-requests) is money given out ahead of a purchase. It must be liquidated afterwards: the receipts are recorded and any change is returned. A cash request not liquidated for a long time shows up in Findings.

## Suppliers and bills

Suppliers are under Accounts payable (/ap/suppliers). The bills still owed are on /ap. Everything the company still owes in one place (bills, loans, other obligations) is on /liabilities/unpaid. Wages are not part of what Ask ERP shows.

## Reading the money: reports

- Income Statement (/reports/income-statement): sales, cost of sales, expenses and profit for the dates you pick, for one store or all of yours.
- Store Comparison (/reports/store-comparison): the income statement of several stores side by side.
- Sales Rollup (/reports/sales-rollup): sales by day, month or store, and by channel (walk-in, Grab, Foodpanda).
- Spending by Item (/reports/expense-items): where the expense money went, by group, category and item. This is the report to ask about cost drivers.
- Balance Sheet, Cash Flow, Trial Balance, AP Aging and AR Aging are under Reports too.
- Budgets (/budgets): the cap per category per period against what was actually spent.

A figure always belongs to a period and a store. When Ask ERP gives a figure it names both.

## Stock

Stock on hand and the moves are under Inventory (/inventory). Low stock (/inventory/low-stock) lists the items at or below their threshold, worst shortage first. An item with no threshold set does not appear there; it shows as a finding so a manager sets one. Physical counts are at /inventory/counts and moves between rooms or stores at /inventory/transfers.

## Cash, till and remittance

The till and its counts are at /till. Cash kept at a store that must be handed over to the office is tracked under Remittance (/remittance). A counted shortage on a closed shift is a finding until someone resolves it.

## Sales days

Each store's sales for a day are recorded and verified under Sales days (/sales-days). A sales day that was changed after it was verified is flagged.

## Findings

Findings (/findings) is the list of things the system noticed: books that do not tie, cash not remitted on time, unusual spending, a store with items that have no reorder threshold, and more. Unusual spending is checked per store: a category far above its usual week, one expense far above its usual, many more expenses than usual, a possible duplicate, an expense approved by the person who recorded it, and spending over a budget cap. These only warn; nothing is blocked. A finding stays on the list while it is still true. Accepting a finding for a while does not make it disappear from the count.

## People and attendance

Staff, attendance and payroll have their own screens (/staff, /attendance, /payroll). Pay and personal details are private and are not available through Ask ERP.

## Settings

Stores, access, business rules and the AI hub are under Settings (/settings). Only a super admin can use the AI hub, which holds the AI keys and the monthly spending cap. The number of questions one person may ask a day is also set there.

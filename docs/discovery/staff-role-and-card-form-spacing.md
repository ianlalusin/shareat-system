# Staff role and card-form corrections — 21 October
Build the smaller repair: reuse roles, assignments and shared form components; no new table or dependency.
Screenshots show four numeric fields squeezed into one row, unequal label/helper heights, and managers labeled Cashier.
The roster currently reads assignments but no active role; an empty replacement silently assigns the default staff position.
Existing person_roles allows one active role per person/org; the assignment unique index permits an empty set.
ERP-rebuild staff identity and POS user types distinguish role from position; CUSTOMER uses shared form controls;
Website has no employment/position editor. No live-data count was read; the supplied two staff cards establish the display failure.
Existing EditableRecord is used on 27 page definitions. Its shared wrapper can give narrow record groups a consistent two-column layout.
Use short visible labels, content-sized inputs and help below controls; pair fields within available card width and stack on phones.
Reference: https://designsystem.parliament.uk/forms/text-input/ supports visible labels and constrained widths.
Open source considered: https://github.com/alphagov/govuk-frontend (MIT); adopting its framework would duplicate this kit, so keep native CSS/React.
Bounded scope: role-first titles, deliberate clearing of privileged-role assignments, form spacing and settlement grouping.
No role/capability matrix changes, automatic production cleanup, payroll computation, new dependency or bible amendment.

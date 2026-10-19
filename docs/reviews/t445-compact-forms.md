FINDINGS: implementation checked locally; browser verification blocked
- Ian approved the 32px sample on 2026-10-19. Fine-pointer desktop fields/buttons are compact; default/coarse-pointer controls retain their 44px minimum, focus and invalid states.
- Shared sizing covers ERP controls and legacy native inputs. Dates, numbers, codes and units have bounded widths; names/pickers retain room for long values; widths shrink to their container.
- Added reusable field rows, width hints and named fieldsets. Item/customer/supplier/invoice/delivery/trade forms and nine further long forms are sectioned; existing grid mode remains compatible.
- Source survey: 146 files with controls, 370 form/editable wrappers, 1,283 control sites; inspected the 32 forms containing >=6 visible control sites, counting each loop once.
- Existing grouped asset, hire, settlement and usage forms retain their groups. Smaller allocation, transfer, cutover, menu-price, separation, remittance, setup, wastage and commissary-line forms retain their existing transaction/row structure and receive shared sizing.
- CHECKED CLEAN: all action bindings, control names, native validation, values/defaults and change handlers match HEAD across the 17 touched screen files (TypeScript AST comparison). No domain or database change.
- Tests were red first (8 failures for missing density/section/width behavior). Final affected run: 11 files, 175 passed, 1 existing skip. Rendered delivery/order tests preserve fields, required receipt, default rates and unsupported-counterparty refusal.
- Production build succeeds with port 9008 stopped. Typecheck passes. No full integration run or CI merge is claimed for this slice.
- Browser gate denied the sample origin, then denied 127.0.0.1:9008 despite Ian's explicit permission. No alternate browser/network workaround was attempted; the synthetic harness was stopped. Visual geometry is not yet verified.
- Incidental source finding logged as DEF-681: existing Number conversions in money displays; unchanged by this slice.
- Background proposal is a separate white/red-arch sample outside the repository; no palette/background changes applied. Existing untracked docs/operations/ is untouched.
FOR IAN: compact forms are implemented locally and automated checks pass. Browser verification and green PR CI remain before release; approve the separate background sample before it is implemented.

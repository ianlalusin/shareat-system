FINDINGS: clean in the two-file lightbox correction; build verification pending
- CHECKED CLEAN: dialog bounds use the dynamic viewport, its content can shrink, the Close row stays visible, and the image fits inside the dialog's content box.
- CHECKED CLEAN: native dialog open/close, Escape, backdrop click, fresh audited file URL on each open, and PDF handling remain intact.
- Original branch: 34 targeted checks passed. After merging deployed main (758a48c): 52 affected UI checks passed; only Lightbox.tsx and its wiring test differ from main.
- Full CI on 8d692b6: unit and all 8,790 PostgreSQL integration tests passed; ERP build failed in Next's Google-font import resolver ("queries have exactly one entry"). No application error is inferred from that compiler diagnostic.
- GitHub's run/job APIs still report in_progress, while the job log contains final cleanup; cancel says completed and rerun says already running. Both lifecycle requests were refused; no green result or merge is claimed.
- This review commit records the evidence and requests fresh PR CI through the ordinary push trigger. The prior failed run remains visible.
- The separate uncommitted T-442 backfill in wt-t403 is excluded and preserved. This isolated checkout does not rewrite that working tree.
- Automated viewport review remains unavailable under the saved browser policy; Ian approved the refreshed compact UI preview separately.
FOR IAN: the compact white UI is already live. The lightbox correction stays held until its complete CI is green.
Model: GPT-6 (Codex).

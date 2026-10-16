# OCR engine research - worklist #17 (row 330: OCR, local first, a person confirms)
Date 2026-10-15. Research only; nothing installed or downloaded. Items marked [unverified] come from memory or a weak source, not a fetched page.

## 1. Recommendation (one path)
**Step 1 engine: PaddleOCR PP-OCRv5 *mobile* models run through ONNX Runtime, in a separate single-job worker process. It returns raw text + line boxes only; our own rules turn text into proposed fields; a person confirms.**
- Node route: `ppu-paddle-ocr` (onnxruntime-node, PP-OCRv5 mobile default, has a receipt CLI) or `@gutenye/ocr-node` (older PP-OCRv4). Both are small community projects - vet them or wrap the ONNX models ourselves. [N1], https://github.com/gutenye/ocr/blob/main/README.md
- Why: best accuracy among the cheap, CPU-friendly engines in the only receipt benchmark found; tiny models (about 2M params for the v5 multilingual model, per the repo README); no Python in our stack if we use ONNX; Apache-2.0.
- Fields: OCR gives text, not fields. TIN, OR number, date, VAT and total are mostly patterns plus arithmetic checks (VAT = vatable x 12%, total = sum of parts) that we can test. Supplier and line items are the weak part: fuzzy-match supplier against the supplier master and show the photo beside the form.
- **Do not run it inside the app process on the 4 GB droplet.** No published RAM numbers exist (section 3). Measure first (section 6). Likely homes, in order: (a) separate worker on the same droplet, one image at a time, memory-capped, queue-fed; (b) a second small droplet or Ian's own PC as the worker; (c) cloud fallback if Ian accepts it (section 4).
- Fallback for hard images (blurry, handwritten, low confidence): **Claude vision API, only if Ian accepts that the image leaves our servers.** Cheap (section 4). Ian's decision.

## 2. Comparison table
| Option | Receipt accuracy (cited) | RAM / CPU on 4 GB | Latency | Licence | Maintenance | Fields or raw text |
|---|---|---|---|---|---|---|
| Tesseract (native or tesseract.js WASM) | Worst of four engines on SROIE: CER 33.6% vs 19.7-28.3% [B1]. Weak on thermal/curved phone photos [unverified] | Smallest. tesseract.js: reuse one worker; v5/v6 cut memory and fixed a leak [T1] | 0.9 s median / 2.3 s p95 per page in vendor run [B1] | Apache-2.0 [T1] | Mature, active | Raw text only |
| PaddleOCR PP-OCRv5 mobile (ONNX) | CER 20.5% on SROIE [B1]; second of four. Vendor-only benchmark, no independent replication | Params tiny (about 2M; PP-OCRv6 tiers 1.5M/7.7M/34.5M) [P1]. Mobile detector ONNX "typically under 10 MB" [unverified]. onnxruntime-node binaries about 258 MB on disk [N1]. **No measured peak RAM found anywhere** | 0.22 s median on RTX 4090 GPU [B1]; CPU figure not published; 5.2x CPU speedup with OpenVINO [P1] | Apache-2.0 [P1] | Very active (3.7.0, 2026-06-11) [P1]; Node wrappers are community-run | Raw text + boxes. Heavier PaddleOCR-VL (0.9B) exists [P1] |
| docTR | CER 19.7% on SROIE, best [B1]; but regex field F1 only 7.7% vs Paddle 32.5% in the same vendor test (format mismatch, not OCR error) [B2] | PyTorch/TensorFlow: heavy for 4 GB [unverified] | 0.15 s median on GPU [B1]; CPU slower | Apache-2.0 [unverified] | Active | Raw text. Python only |
| EasyOCR | CER 28.3% [B1] | PyTorch, heavy | 0.66 s median / 1.4 s p95 on GPU [B1] | Apache-2.0 [unverified] | Slow releases [unverified] | Raw text. Python only |
| Local small VLM (Florence-2 0.23B/0.77B; Qwen2-VL-2B class) | **No published CORD/SROIE number for Florence-2 found.** Qwen2-VL-2B + LoRA on CORD: 90% total exact-match on 60 held-out receipts, 100% valid JSON - self-reported, small sample, needed GPU fine-tuning [Q1]. Untuned base is unreliable [Q2] | Q4 GGUF of a 2B VLM about 1-1.5 GB plus a vision file (mmproj) plus image tokens [Q3]; CPU speed unmeasured. Crowds a 4 GB box shared with the app | Not published for CPU; expect many seconds per image [unverified estimate] | Qwen2-VL-2B Apache-2.0, Florence-2 MIT [unverified] | Fast-moving, model churn | **Can output fields (JSON) directly** - the only local option that does |
| Google Document AI (Expense/Invoice parser) | No public benchmark fetched | None on our box | Seconds, network | Paid API | Google-run | **Fields**. Price/page not retrieved - see https://cloud.google.com/document-ai/pricing |
| AWS Textract AnalyzeExpense | No public benchmark fetched | None | Seconds | Paid API | AWS-run | **Fields** (vendor, date, totals, line items) |
| Claude vision API | No public receipt benchmark fetched. Docs warn of mistakes on low-quality, rotated or tiny images; says verify output [C1] | None | Seconds | Paid API | Anthropic-run | **Fields**, any layout, handwriting best-effort, JSON we define |

Benchmark caveat: every CER number is from ONE vendor's run on SROIE 2019 (English/Malaysian receipts, 361 images) on an RTX 4090 GPU [B1]. On CORD v2 (Indonesian) all engines did far worse, Tesseract CER about 95% [B3]. That is a warning for Philippine receipts (Filipino/English mix, thermal print, phone photos): **published numbers do not transfer. Only our own 30 receipts decide.**

## 3. Memory fit on the 4 GB droplet
- Production host 159.223.46.224 already runs the app. A build already OOMs it (DEF-238).
- Plausibly fits: Tesseract worker; PaddleOCR-ONNX mobile worker (small models; Node ONNX Runtime adds a few hundred MB resident [unverified]).
- Does not fit with confidence: PyTorch stacks (docTR, EasyOCR) and any 1-3B VLM.
- Nobody publishes peak RSS for these. We must measure (section 6, step 3). Rule: if worker peak RSS + app RSS leaves less than about 800 MB free, move the worker off the box.
- Swap hides OOM until the app slows. Test with swap off, or watch for swap use.

## 4. Cloud baseline - cost and privacy
Prices (from fetched pages unless marked):
- AWS Textract AnalyzeExpense: $0.01/page for first 1M pages/month; free tier 100 pages/month for 3 months (new customers). Plain text detect $0.0015/page. Prices shown for US West (Oregon) only. https://aws.amazon.com/textract/pricing/
- Claude vision: tokens = ceil(w/28) x ceil(h/28); standard tier caps at 1568 px / 1568 tokens. A 1000x1000 image = 1296 tokens; at Haiku 4.5 $1 per million input tokens that is about $1.30 per 1,000 images, plus a few hundred output tokens for the JSON. High-resolution models use up to 4784 tokens (docs example: about $5.18 per 1,000 for a 1 MP image at $4/M). Anthropic says images are not stored beyond the request and not used for training. https://platform.claude.com/docs/en/build-with-claude/vision
- Google Document AI: per-page rate not retrieved.
- At a few hundred documents/month, cloud cost is dollars, not the issue. **Privacy is.**
Privacy:
- A TIN is treated as sensitive personal information under the Data Privacy Act (BIR FOI response, seen via search; secondary). The Philippine company stays accountable after sending data abroad; it needs safeguards, a processor contract and probably notice to data subjects. I found no source saying it is forbidden, and could not verify the NPC circular details. Needs Philippine counsel before any cloud use. https://ndvlaw.com/how-do-philippine-companies-comply-with-cross-border-data-transfers/ , https://privacy.gov.ph
- Receipts from sole proprietors/individuals carry personal data; staff photos may include faces or IDs by accident.
- If cloud is ever allowed: send only low-confidence images, crop/redact, log every call, keep an env-flag kill switch, never the default.

## 5. What we are NOT adopting, and why
- **Tesseract as main engine**: worst CER in the one benchmark (33.6%), known to struggle with thermal photos. Keep only as an optional cross-check.
- **docTR / EasyOCR**: Python + PyTorch runtime; heavy for the box and adds a second language to deploy and patch. docTR had the best raw CER but no field advantage [B2]; EasyOCR is slower and less accurate [B1].
- **Local VLM (Florence-2 / Qwen2-VL-2B) in step 1**: only local option that outputs fields, but no trustworthy accuracy number without GPU fine-tuning, RAM too tight, speed unknown. Revisit only if we get a GPU/other host AND the 30-receipt test shows rules-on-OCR-text fail on line items.
- **Cloud as default**: privacy/compliance burden, and row 330 says local first. Kept in reserve as a switch Ian controls.
- **Handwritten delivery receipts**: no local engine here reads handwriting reliably. Plan: OCR proposes little or nothing; person types. Measure it separately so nobody expects otherwise.
- **Building or running a model server on the droplet**: DEF-238 stands. Models are files shipped in the deploy artifact; no compile step there.

## 6. Measurement plan (30 real Shareat receipts from Ian)
Inputs: 30 photos as staff take them (not rescanned). Suggested mix: 10 thermal POS receipts, 8 BIR official receipts/sales invoices (printed), 6 supplier invoices, 6 handwritten delivery receipts; include 5 deliberately bad photos (angle, glare, folded). A person writes the truth per document: supplier, date, OR/invoice number, TIN, VAT amount, total, line items (name, qty, amount). Keep images and truth sheet out of git (customer data).
Steps:
1. Same preprocessing for all engines: auto-rotate, grayscale, long edge about 1600 px. Record it.
2. Run candidates on all 30: PaddleOCR-ONNX (v5 mobile) and Tesseract (eng, plus fil if available); and Claude vision with a fixed JSON prompt only if Ian allows those images to be sent. Save raw output per image.
3. Resource run on the real droplet spec (or a 4 GB / 2 vCPU VM, swap off) with the app running: peak RSS (`/usr/bin/time -v`), time per image cold and warm.
4. Score per field and per document type, exact match after normalising (digits only for TIN/OR number, ISO date, amounts in cents). Also count "wrong but proposed" separately from "nothing proposed": wrong-and-confident is the dangerous case because a person may confirm it unseen.
5. Add the rule layer: TIN pattern (###-###-###-###), date formats, amount parsing (commas, "P"/PHP), VAT arithmetic check. Score again.
6. Proposed pass bar (Ian rules): TIN, OR number, date, total each correct on >= 85% of printed documents with rules on; zero silent wrong totals (each wrong total must be caught by the arithmetic check or low confidence); worker peak RSS <= 1.2 GB; <= 10 s per image warm. Handwritten reported separately, no bar.
7. Decision: bar met -> adopt Paddle. Met except line items -> adopt for header fields, line items manual. TIN/total bar failed -> ask Ian about the Claude-vision fallback (section 4 conditions) or a VLM on a GPU host.
Effort: about one working day for a builder; no production change.

## 7. What I need from Ian
1. 30 receipt photos + truth sheet (or who prepares it).
2. Yes/no: may a test subset be sent to the Claude API for the cloud baseline number?
3. Rough monthly volume of receipts + invoices.
4. Worker home if the droplet RAM test fails: second small droplet, or Ian's PC.
5. Whether Philippine counsel has already ruled on sending TIN-bearing documents abroad.

## Sources
- [B1] https://imagetotable.ai/references/receipt-ocr-benchmark-results (CER, latency; vendor-run, GPU)
- [B2] https://imagetotable.ai/references/tesseract-vs-paddleocr-receipt-benchmark and https://imagetotable.ai/references/regex-vs-llm-field-extraction (field F1; via search summary only)
- [B3] same vendor, CORD v2 results, via search summary
- [P1] https://github.com/PaddlePaddle/PaddleOCR (Apache-2.0, ONNX, params, 3.7.0)
- [P2] https://www.paddleocr.ai/latest/version3.x/algorithm/PP-OCRv5/PP-OCRv5.html (benchmark setup; latency table not retrieved)
- [T1] https://github.com/naptha/tesseract.js (Apache-2.0, memory notes)
- [N1] https://github.com/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr ; https://medium.com/@awalariansyah7/deterministic-ocr-in-javascript-paddleocr-for-node-bun-deno-and-the-browser-4c5c3c3e7512 (maintainer's own 99.22% claim - not relied on)
- [Q1] https://huggingface.co/chai1me/qwen2vl-receipt-lora (self-reported, 60 receipts)
- [Q2] https://huggingface.co/saliousk/qwen2vl-cord-lora ; https://www.iunera.com/kraken/enterprise-ai/best-qwen-model-for-receipt-extraction-0-8b-vs-3b/ (anecdotal; page not retrievable)
- [Q3] https://www.promptlayer.com/models/qwen2-vl-2b-instruct-gguf ; https://dev.to/mrzaizai2k/run-qwen2-vl-on-cpu-using-gguf-model-llamacpp-bli
- [C1] https://platform.claude.com/docs/en/build-with-claude/vision
- AWS pricing https://aws.amazon.com/textract/pricing/ ; Google pricing https://cloud.google.com/document-ai/pricing (rate not retrieved)
- Privacy: https://ndvlaw.com/how-do-philippine-companies-comply-with-cross-border-data-transfers/ ; https://privacy.gov.ph
- Florence-2 sizes: https://huggingface.co/GuiAworld/Florence-2-large (no receipt benchmark found)

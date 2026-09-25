# AI model lifecycle, provenance & licences

## Registered models (pinned in `apps/ai-worker/src/models/manifest.ts`)

| Task | Code @ version | Artefact (source URL) | SHA-256 | Licence | Verified here |
|---|---|---|---|---|---|
| OBJECT_DETECTION | `yolox-s-coco@0.1.1rc0` | `yolox_s.onnx` — https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_s.onnx | `c5c2d13e59ae883e6af3b45daea64af4833a4951c92d116ec270d9ddbe998063` | Apache-2.0 | yes — persons, cars, trucks, motorcycles, umbrellas, handbags on CC0/PD street photos |
| PERSON_DETECTION | `yolox-s-person@0.1.1rc0` | same artefact, `person` only | same | Apache-2.0 | yes — ≥ 8 persons on a PD crowd photo |
| FACE_DETECTION | `yunet-face@2023mar` | `face_detection_yunet_2023mar.onnx` — https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx | `8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4` | MIT | yes — 1 face (conf > 0.85) on a PD portrait, 0 on a plate close-up |
| FACE_RECOGNITION | `sface-recognition@2021dec` | `face_recognition_sface_2021dec.onnx` — https://github.com/opencv/opencv_zoo/raw/main/models/face_recognition_sface/face_recognition_sface_2021dec.onnx | `0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79` | Apache-2.0 | yes — same face rescaled cos > 0.6 (measured 0.99), other faces < 0.363; watchlist match end-to-end |
| ANPR | `anpr-yolov9t-cct@oim-assets-384+cct-s-v1` | detector `yolo-v9-t-384-license-plates-end2end.onnx` — https://github.com/ankandrew/open-image-models/releases/download/assets/yolo-v9-t-384-license-plates-end2end.onnx; OCR `cct_s_v1_global.onnx` — https://github.com/ankandrew/fast-plate-ocr/releases/download/arg-plates/cct_s_v1_global.onnx | det `888397b96d761c89db40bc9c305838e8652660f5e282c2cadebbe8d2951a77a8`; OCR `5c95b3231fff415b05cb48a3a39fab7c009364c2ee441bef092e0162ab75ea74` | MIT (both repositories) — see risk note | yes — reads `IJZ8992` exactly on a CC0 photo; VEHICLE watchlist hit |
| CLASSIFICATION | `ksp-evidence-tagger@1.0.0` | `builtin:evidence-tagger/v1` (rules; SHA-256 of the rules JSON) | `sha256(JSON(TAGGER_RULES))` | project code | yes — person / vehicle / crowd tags end-to-end |

Metrics stored with each row are **upstream** figures (marked `source: upstream`); none has been re-evaluated on
KSP body-worn footage — that is a required step before production activation (see below).

### Licence risks

* **ANPR detector**: the open-image-models repository is MIT and publishes the weights under it, but the detector is a
  YOLOv9 derivative; the original YOLOv9 code (WongKinYiu) is **GPL-3.0**. Whether GPL obligations attach to exported
  weights is a legal question — **legal review required before production**; alternative: retrain a plate detector
  with an Apache-2.0 architecture (e.g. YOLOX) using exported, reviewed ANPR data (training-export pipeline below).
* fast-plate-ocr's `cct_s_v1_global` model is trained on a "global" plate set; accuracy on Indian (KA) plates is
  **UNVERIFIED**. Fine-tuning on reviewed KSP data is recommended.
* No AGPL (Ultralytics) components are used.
* Face recognition is biometric processing: deployment requires the applicable legal basis/DPIA; the system limits
  harm by only emitting matches against authorised watchlists, never storing identities for unmatched faces, dual
  human approval, and full audit.

### Test imagery (downloaded by the tests, SHA-256 pinned in `apps/ai-worker/test/media.ts`)

| File | Licence | SHA-256 |
|---|---|---|
| Traffic and pedestrians on Calle Velásquez … Porlamar, Venezuela (Wikimedia Commons) | CC0 | `2c97420ab515eda95204755d114c64a7f8a4acf47e7670e104e85a9cea5feca3` |
| Busy street with pedestrians in Dhaka, Bangladesh (Wikimedia Commons) | Public domain | `dd352bcdc4250f1bf5e525b4036ce6bb5bf287cc1f0940f6952c1aac270147c4` |
| President Barack Obama.jpg (official portrait, Wikimedia Commons) | Public domain (US Gov) | `744dd848fbb0584229169e01c4944664957c62495fb9e8af514a088ebca43e19` |
| UK (Northern Ireland) Number Plate IJZ 8992 … Ford Fiesta (Wikimedia Commons) | CC0 | `964896827eaee3528c68cdbb320022ef11a893dc1cc456c0575f6d939441771a` |

If a download fails the image-dependent tests are skipped with the reason printed (never faked).

## Lifecycle

```
 evaluate offline ──► register STAGED (+metrics) ──► activate ──► (serve) ──► retire
        ▲                                               │ previous ACTIVE version of the same code is RETIRED
        └──── training export of reviewed detections ◄──┘ rollback = activate the retired version again
```

1. **Evaluate** a candidate on a held-out, human-labelled KSP set (use a training export of a period *not* used for
   training). Record at least precision/recall (per class) and the dataset id.
2. **Register** (`POST /ai/models`, ai:models_manage) → `STAGED`. Required: `code`, `version`, `task`,
   `artifactUri` (`models://<file>` under `AI_MODELS_DIR` — arbitrary paths are rejected), `artifactSha256`,
   `defaultThreshold`, `config.architecture` (`yolox | yunet | sface | yolov9-plate+cct-ocr | rules`) plus
   preprocessing parameters, `metrics`. Copy the artefact to every AI host's `AI_MODELS_DIR` first.
3. **Activate** (`POST /ai/models/:id/activate`) — refused (422) without metrics. Atomically retires the current
   ACTIVE version of the same task+code (DB partial unique index `ai_models_one_active_per_task`). Audit
   `AI_MODEL_RETIRED` + `AI_MODEL_ACTIVATED`. New jobs snapshot the new model id; running jobs keep theirs; every
   detection records `model_id, model_code, model_version, threshold` (enforced by the DB guard).
4. **Tune** thresholds / notes / metrics with `PATCH /ai/models/:id` (audit `AI_MODEL_UPDATED`, old threshold logged).
5. **Retire** (`POST /ai/models/:id/retire`). A task without an ACTIVE model is reported unavailable by `GET /ai/tasks`
   and rejected by `POST /ai/evidence/:id/jobs` (422).
6. **Face recognition version change**: watchlist embeddings are model-specific; after activating a new recognition
   model the worker re-embeds entries whose `model_id` differs; until then those entries are not compared.

The worker verifies the SHA-256 of every artefact before loading (mismatch ⇒ job FAILED, nothing is inferred).

## Retraining data (training exports)

`POST /ai/training-exports {task, modelId?, from, to}` (ai:models_manage) → queue `ai.training_export` → worker job
`apps/worker/src/jobs/ai-training/`. Scope: detections of evidence inside the requester's ai:models_manage
jurisdiction (not disposed), created in `[from, to)`:

* **positives**: `APPROVED`, and any detection with a reviewer `corrected_label` (label = corrected label);
* **negatives**: `REJECTED` without correction.

Written to the reports bucket `ai-training/<exportId>/`: `dataset.jsonl` (one sample per line: detection id, evidence id,
task, label, original label, positive/negative, review status, confidence, threshold, model, frame time, normalised
bbox, attributes, crop path), `coco.json` (images = crops; annotations for positives; categories), `crops/<id>.jpg`,
`manifest.json` (filter, counts, SHA-256 + size of every file). Embeddings are never exported. Audit
`AI_TRAINING_EXPORT_REQUESTED`, then `AI_TRAINING_EXPORTED` once per evidence item (custody trail) and once overall.
Crops are evidence-derived personal data — handle exports under the data-protection policy; downloads are restricted
to the requesting user.

Training itself happens offline (outside this system); the result re-enters via step 2.

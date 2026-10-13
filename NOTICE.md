# Credits and licenses

| Component | Source | License |
|---|---|---|
| App code (this repository) | Hasr | AGPL-3.0 (LICENSE) |
| `models/general-n.onnx`, `models/general-s.onnx.*` | Ultralytics YOLO26n / YOLO26s, COCO-pretrained, exported end-to-end to ONNX | AGPL-3.0 |
| `models/sheep-race-2.onnx` | Ultralytics YOLO26n fine-tuned (single class "sheep") on frames of night-time unloading videos from two discharge sites supplied by the user; labels made with YOLOE-26 visual prompts, cleaned by perspective size and track consistency | AGPL-3.0 |
| `models/sheep-top.onnx` | AUTH-Sheep HBB model (YOLOv8n, single class "sheep", trained on UAV imagery): github.com/idmt-odoll/AUTH-Sheep | CC BY 4.0 (dataset/annotations); trained with Ultralytics (AGPL-3.0) |
| `vendor/ort/*` | ONNX Runtime Web 1.30.0, Microsoft | MIT |
| `fonts/*` | Readex Pro, via @fontsource/readex-pro | SIL Open Font License 1.1 (fonts/OFL.txt) |

AUTH-Sheep: "AUTH-Sheep: An Annotated Video Dataset for Detection and Tracking of Sheep in UAV Imagery", Fraunhofer IDMT, 2024 (IEEE). Funded by HORIZON Europe (SPADE, 101060778).

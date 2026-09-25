import * as ort from 'onnxruntime-node';
const dir = process.argv[2];
for (const f of ['yolox_tiny.onnx', 'yolox_s.onnx', 'yunet.onnx', 'sface.onnx', 'plate_det.onnx', 'plate_ocr.onnx']) {
  const s = await ort.InferenceSession.create(`${dir}/${f}`);
  const meta = (names, m) => names.map((n) => `${n}:${JSON.stringify(m?.find?.((x) => x.name === n)?.shape ?? m?.[n]?.dimensions ?? '?')}:${m?.find?.((x) => x.name === n)?.type ?? ''}`);
  console.log(f, 'IN', meta(s.inputNames, s.inputMetadata), 'OUT', meta(s.outputNames, s.outputMetadata));
}

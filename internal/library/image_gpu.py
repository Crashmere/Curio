"""Private NDJSON worker for Curio's opaque NVIDIA image previews."""

import gc
import json
import os
import select
import sys

import cvcuda
import numpy as np
from nvidia import nvimgcodec


def emit(**event):
    print(json.dumps(event), flush=True)


def read_ppm(path):
    with open(path, "rb") as source:
        tokens = []
        while len(tokens) < 4:
            line = source.readline()
            if not line:
                raise ValueError("Incomplete RGB staging image")
            tokens.extend(line.split(b"#", 1)[0].split())
        if tokens[0] != b"P6" or tokens[3] != b"255":
            raise ValueError("Expected 8-bit RGB staging pixels")
        width, height = int(tokens[1]), int(tokens[2])
        if width * height > 80_000_000:
            raise ValueError("GPU image working-set limit exceeded")
        return np.fromfile(source, dtype=np.uint8).reshape(height, width, 3)


def process(request, decoder, encoder, stream):
    if request.get("rgb"):
        decoded = nvimgcodec.as_image(read_ppm(request["rgb"])).cuda()
    else:
        source = nvimgcodec.CodeStream(request["source"])
        if source.width * source.height > 80_000_000:
            raise ValueError("GPU image working-set limit exceeded")
        decoded = decoder.decode(source, params=nvimgcodec.DecodeParams(apply_exif_orientation=True))
        if decoded is None:
            raise ValueError("Unsupported GPU image decoder")
    tensor = cvcuda.as_tensor(decoded, "HWC")
    height, width, channels = tensor.shape
    if channels != 3:
        raise ValueError("Expected opaque RGB pixels")
    for step, maximum, quality in (("preview", 2560, 92), ("thumbnail", 640, 85)):
        scale = min(1.0, maximum / max(width, height))
        size = (max(1, round(height * scale)), max(1, round(width * scale)))
        with stream:
            resized = cvcuda.hq_resize(tensor, size, interpolation=cvcuda.Interp.LANCZOS, antialias=True)
            image = nvimgcodec.as_image(resized.cuda(), cuda_stream=stream.handle)
            output = request[step]
            result = encoder.write(output, image, params=nvimgcodec.EncodeParams(
                quality_type=nvimgcodec.QualityType.QUALITY,
                quality_value=quality,
                chroma_subsampling=(nvimgcodec.ChromaSubsampling.CSS_444 if quality >= 90 else nvimgcodec.ChromaSubsampling.CSS_420),
            ), cuda_stream=stream.handle)
        if result is None or not os.path.getsize(output):
            raise ValueError("NVIDIA encoder produced no image")
        emit(step=step)
    emit(done=True)


def main():
    backends = [nvimgcodec.BackendKind.GPU_ONLY, nvimgcodec.BackendKind.HYBRID_CPU_GPU]
    decoder = nvimgcodec.Decoder(backends=backends, max_num_cpu_threads=2)
    encoder = nvimgcodec.Encoder(backends=backends, max_num_cpu_threads=2)
    stream = cvcuda.Stream()
    while select.select([sys.stdin], [], [], 30)[0]:
        line = sys.stdin.readline()
        if not line:
            break
        try:
            process(json.loads(line), decoder, encoder, stream)
        except Exception as error:
            emit(done=True, error=str(error))
        finally:
            gc.collect()
            cvcuda.clear_cache()


if __name__ == "__main__":
    main()

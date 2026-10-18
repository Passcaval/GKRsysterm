"""Encode the generated 4x2 rowing sheet as a local, silent VP8/WebM loop.

Requires Pillow, numpy and opencv-python. No network or external video service.
Keep the original generated PNG unchanged; cell extraction happens in memory.
"""
from pathlib import Path
import cv2
import numpy as np
from PIL import Image

root = Path(__file__).resolve().parent.parent
sheet = Image.open(root / 'src/assets/rowing-sheet.png').convert('RGBA')
cell_width, cell_height = sheet.width // 4, sheet.height // 2
output = root / 'src/assets/rowing.webm'
size, fps, frames_per_pose, loops = 320, 30, 6, 2
writer = cv2.VideoWriter(str(output), cv2.VideoWriter_fourcc(*'VP80'), fps, (size, size))
if not writer.isOpened():
    raise RuntimeError('This OpenCV build cannot encode VP8/WebM')
try:
    for _ in range(loops):
        for pose in range(8):
            x, y = pose % 4 * cell_width, pose // 4 * cell_height
            frame = sheet.crop((x, y, x + cell_width, y + cell_height))
            frame.thumbnail((size, size), Image.Resampling.LANCZOS)
            canvas = Image.new('RGB', (size, size), '#141e2d')
            canvas.paste(frame, ((size-frame.width)//2, (size-frame.height)//2), frame)
            pixels = cv2.cvtColor(np.asarray(canvas), cv2.COLOR_RGB2BGR)
            for _ in range(frames_per_pose):
                writer.write(pixels)
finally:
    writer.release()
capture = cv2.VideoCapture(str(output))
ok, _ = capture.read()
count = capture.get(cv2.CAP_PROP_FRAME_COUNT)
rate = capture.get(cv2.CAP_PROP_FPS)
capture.release()
if not ok or count != fps * 3.2:
    raise RuntimeError('Video encode/decode validation failed')
print(f'{output}: {size}x{size}, {rate:g}fps, {count/rate:g}s, {output.stat().st_size} bytes')

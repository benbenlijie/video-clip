import json
import math
import sys

import cv2


def sample_indexes(frame_count, limit):
    if frame_count <= limit:
        return list(range(frame_count))
    return sorted({round(index * (frame_count - 1) / max(1, limit - 1)) for index in range(limit)})


def main():
    if len(sys.argv) < 2:
        raise SystemExit("usage: style-face-detect.py VIDEO [MAX_SAMPLES]")
    video_path = sys.argv[1]
    limit = max(1, min(60, int(sys.argv[2]) if len(sys.argv) > 2 else 12))
    capture = cv2.VideoCapture(video_path)
    if not capture.isOpened():
        raise RuntimeError("cannot open video for face detection")
    fps = float(capture.get(cv2.CAP_PROP_FPS) or 30)
    frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    if frame_count <= 0:
        raise RuntimeError("video has no decodable frames")
    cascade_path = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
    cascade = cv2.CascadeClassifier(cascade_path)
    if cascade.empty():
        raise RuntimeError("OpenCV face cascade is unavailable")
    frames = []
    for index in sample_indexes(frame_count, limit):
        capture.set(cv2.CAP_PROP_POS_FRAMES, index)
        ok, frame = capture.read()
        if not ok or frame is None:
            continue
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        height, width = gray.shape[:2]
        minimum = max(24, min(width, height) // 12)
        faces = cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5, minSize=(minimum, minimum))
        boxes = [
            {
                "x": round(float(x) / width, 6),
                "y": round(float(y) / height, 6),
                "width": round(float(w) / width, 6),
                "height": round(float(h) / height, 6),
            }
            for (x, y, w, h) in faces
        ]
        frames.append({"timeMs": round(index / max(1.0, fps) * 1000), "boxes": boxes})
    capture.release()
    print(json.dumps(frames, ensure_ascii=False))


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
ClearDock receiving station.

Captures one still frame from a fixed USB camera and sends it (plus an optional
weight) to the ClearDock server for the given order.

    pip install opencv-python requests pyserial
    python station.py --order ord_1001                 # SPACE = capture, Q = quit
    python station.py --order ord_1001 --scale /dev/ttyUSB0
    python station.py --order ord_1001 --fake-weight 1500  # sent as simulated=true

Rules from the brief:
- Deliberate snapshots only. Never stream video to the AI.
- Hardware failures must be visible (we print and show them, never hide them).
- Simulated readings are labelled (simulated=true).

TODO(hardware): auto-capture when the scale reading settles; status light
(green = ready_for_review, red = discrepancy/needs_info).
"""
import argparse
import os
import sys
import time

import cv2
import requests


def read_scale(port: str, timeout: float = 2.0):
    """Read one weight in grams from a serial scale that prints a number per line."""
    import serial  # pyserial

    with serial.Serial(port, 9600, timeout=timeout) as s:
        deadline = time.time() + timeout
        while time.time() < deadline:
            line = s.readline().decode(errors="ignore").strip()
            try:
                return float(line.split()[0])
            except (ValueError, IndexError):
                continue
    raise RuntimeError(f"No reading from scale on {port}")


def send(server: str, token: str, order: str, jpeg: bytes, grams, simulated: bool, mock: str | None):
    data = {"orderId": order}
    if grams is not None:
        data["weightGrams"] = str(grams)
        data["simulated"] = "true" if simulated else "false"
    if mock:
        data["mockScenario"] = mock
    r = requests.post(
        f"{server}/api/station/captures",
        headers={"x-station-token": token},
        data=data,
        files={"image": ("capture.jpg", jpeg, "image/jpeg")},
        timeout=60,
    )
    body = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
    if not r.ok:
        raise RuntimeError(f"Server {r.status_code}: {body.get('error', r.text[:200])}")
    return body["order"]["order"]


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--order", required=True)
    p.add_argument("--server", default=os.environ.get("CLEARDOCK_SERVER", "http://localhost:3001"))
    p.add_argument("--token", default=os.environ.get("STATION_TOKEN", "change-me"))
    p.add_argument("--camera", type=int, default=0)
    p.add_argument("--scale", help="serial port of the scale, e.g. /dev/ttyUSB0 or COM3")
    p.add_argument("--fake-weight", type=float, help="send this weight labelled as simulated")
    p.add_argument("--mock", choices=["match", "core", "unreadable"], help="mock scan result (MOCK mode only)")
    a = p.parse_args()

    cam = cv2.VideoCapture(a.camera)
    if not cam.isOpened():
        sys.exit(f"CAMERA ERROR: cannot open camera {a.camera}")

    print("SPACE = capture, Q = quit")
    while True:
        ok, frame = cam.read()
        if not ok:
            print("CAMERA ERROR: frame read failed", file=sys.stderr)
            time.sleep(0.5)
            continue
        cv2.imshow("ClearDock station", frame)
        key = cv2.waitKey(30) & 0xFF
        if key in (ord("q"), 27):
            break
        if key != ord(" "):
            continue

        grams, simulated = None, False
        if a.scale:
            try:
                grams = read_scale(a.scale)
            except Exception as e:  # visible failure, still send the photo
                print(f"SCALE ERROR: {e}", file=sys.stderr)
        elif a.fake_weight is not None:
            grams, simulated = a.fake_weight, True

        ok, jpeg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 90])
        try:
            order = send(a.server, a.token, a.order, jpeg.tobytes(), grams, simulated, a.mock)
            print(f"-> {order['status']}: {order['comparison']['summary']}")
        except Exception as e:
            print(f"SEND ERROR: {e}", file=sys.stderr)

    cam.release()
    cv2.destroyAllWindows()


if __name__ == "__main__":
    main()

// Magnetic filings: a grid of short white strokes that align toward the cursor.
// Ported as-is from the SecuroServ v2 design handoff (filings.js), typed.
export function mountFilings(canvas: HTMLCanvasElement, opts: { spacing?: number; length?: number } = {}) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return { destroy() {} };
  const S = opts.spacing || 30,
    LEN = opts.length || 11;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let W = 0,
    H = 0,
    dpr = 1,
    pts: { x: number; y: number; a: number }[] = [],
    raf = 0;
  const t0 = performance.now();
  const ptr = { x: 0, y: 0, in: false },
    tgt = { x: 0, y: 0 };

  const resize = () => {
    dpr = Math.min(devicePixelRatio || 1, 2);
    W = canvas.clientWidth;
    H = canvas.clientHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    pts = [];
    const ox = (W % S) / 2 + S / 2,
      oy = (H % S) / 2 + S / 2;
    for (let y = oy; y < H; y += S) for (let x = ox; x < W; x += S) pts.push({ x, y, a: Math.atan2(H / 2 - y, W / 2 - x) });
    tgt.x = W / 2;
    tgt.y = H / 2;
  };
  const onMove = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    ptr.x = e.clientX - r.left;
    ptr.y = e.clientY - r.top;
    ptr.in = ptr.x >= 0 && ptr.y >= 0 && ptr.x <= r.width && ptr.y <= r.height;
  };
  const onLeave = () => (ptr.in = false);

  const frame = (now: number) => {
    raf = requestAnimationFrame(frame);
    const t = (now - t0) / 1000;
    const gx = ptr.in ? ptr.x : W * (0.5 + 0.28 * Math.sin(t * 0.13)),
      gy = ptr.in ? ptr.y : H * (0.45 + 0.22 * Math.cos(t * 0.1));
    tgt.x += (gx - tgt.x) * 0.08;
    tgt.y += (gy - tgt.y) * 0.08;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.lineCap = "round";
    ctx.lineWidth = 1.4;
    const ease = reduce ? 1 : 0.1;
    for (const p of pts) {
      const dx = tgt.x - p.x,
        dy = tgt.y - p.y,
        ta = Math.atan2(dy, dx);
      let d = ta - p.a;
      d = (((d + Math.PI / 2) % Math.PI) + Math.PI) % Math.PI - Math.PI / 2;
      p.a += d * ease;
      const dist = Math.hypot(dx, dy),
        near = Math.max(0, 1 - dist / 220);
      const al = 0.22 + near * 0.3,
        l = LEN * (0.85 + near * 0.3);
      const cx = (Math.cos(p.a) * l) / 2,
        cy = (Math.sin(p.a) * l) / 2;
      ctx.strokeStyle = `rgba(255,255,255,${al.toFixed(3)})`;
      ctx.beginPath();
      ctx.moveTo(p.x - cx, p.y - cy);
      ctx.lineTo(p.x + cx, p.y + cy);
      ctx.stroke();
    }
  };

  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();
  addEventListener("pointermove", onMove, { passive: true });
  document.addEventListener("pointerleave", onLeave);
  raf = requestAnimationFrame(frame);
  canvas.style.opacity = "1";
  return {
    destroy() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerleave", onLeave);
      canvas.style.opacity = "0";
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    },
  };
}

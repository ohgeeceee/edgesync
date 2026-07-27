/**
 * EdgeSync — SignaturePad
 * ----------------------------------------------------------------------------
 * Pointer-events-only signature capture.  No dependencies, no images, no
 * external fonts.  Renders an HTMLCanvas and produces a PNG dataURL.
 *
 * Why not an <img> with scribble?  Because canvas gives us proper
 * anti-aliased strokes without a library, and the dataURL can be
 * stored inline in the manifest row (small enough — under 5 KB after
 * trim, since the pad is intentionally small).
 */

import { h } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";

export interface SignaturePadProps {
  width?: number;
  height?: number;
  /** Called whenever a stroke completes; the dataURL is sent. */
  onChange?: (pngDataUrl: string | null) => void;
}

export function SignaturePad({ width = 360, height = 120, onChange }: SignaturePadProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawingRef = useRef(false);
  const [hasInk, setHasInk] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.strokeStyle = "#0f172a";
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
  }, [width, height]);

  function pos(e: PointerEvent): { x: number; y: number } {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function down(e: PointerEvent) {
    drawingRef.current = true;
    const ctx = canvasRef.current!.getContext("2d")!;
    const { x, y } = pos(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
    (e.target as Element).setPointerCapture(e.pointerId);
  }

  function move(e: PointerEvent) {
    if (!drawingRef.current) return;
    const ctx = canvasRef.current!.getContext("2d")!;
    const { x, y } = pos(e);
    ctx.lineTo(x, y);
    ctx.stroke();
  }

  function up() {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    const dataUrl = canvasRef.current!.toDataURL("image/png");
    setHasInk(true);
    onChange?.(dataUrl);
  }

  /**
   * Pointer was canceled (iOS scroll, browser interrupt, etc).  Don't
   * finalize the partial stroke as a signature — audit H8.  Just stop
   * drawing silently; the user can lift the pointer again to commit.
   */
  function cancel() {
    drawingRef.current = false;
  }

  function clear() {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    setHasInk(false);
    onChange?.(null);
  }

  return (
    <div class="es-sigpad">
      <canvas
        ref={canvasRef}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={cancel}
        style={{ touchAction: "none", border: "1px solid #cbd5e1", borderRadius: 6 }}
      />
      <div class="es-sigpad-actions">
        <button type="button" onClick={clear} disabled={!hasInk}>Clear</button>
        <span class="es-sigpad-hint">
          {hasInk ? "✓ signature captured" : "Sign above"}
        </span>
      </div>
    </div>
  );
}

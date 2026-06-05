/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef } from "react";

interface SpeedChartProps {
  history: number[]; // Speed values in Bytes per second over time
  maxRange?: number; // Optional peak to scale the Y-axis
}

export default function SpeedChart({ history, maxRange }: SpeedChartProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Handle high DPI screens
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const width = rect.width;
    const height = rect.height;

    // Clear background
    ctx.clearRect(0, 0, width, height);

    // If history is empty, draw a dashed placeholder line
    if (history.length < 2) {
      ctx.beginPath();
      ctx.setLineDash([5, 5]);
      ctx.strokeStyle = "rgba(100, 116, 139, 0.2)";
      ctx.lineWidth = 1;
      ctx.moveTo(0, height / 2);
      ctx.lineTo(width, height / 2);
      ctx.stroke();
      ctx.setLineDash([]);
      
      ctx.fillStyle = "rgba(100, 116, 139, 0.4)";
      ctx.font = "11px monospace";
      ctx.textAlign = "center";
      ctx.fillText("Waiting for active P2P chunk stream...", width / 2, height / 2 + 15);
      return;
    }

    // Determine Y scale
    const padding = 15;
    const graphHeight = height - padding * 2;
    const maxVal = Math.max(...history, maxRange || 1024 * 1024); // benchmark to at least 1MB/s

    // Generate points
    const points = history.map((val, idx) => {
      const x = (idx / (history.length - 1)) * width;
      // Invert Y axis
      const y = height - padding - (val / maxVal) * graphHeight;
      return { x, y };
    });

    // Draw grid lines
    ctx.beginPath();
    ctx.strokeStyle = "rgba(148, 163, 184, 0.05)";
    ctx.lineWidth = 1;
    for (let i = 1; i <= 3; i++) {
      const gridY = padding + (graphHeight / 4) * i;
      ctx.moveTo(0, gridY);
      ctx.lineTo(width, gridY);
    }
    ctx.stroke();

    // Create gradient fill underneath the curve
    const fillGrd = ctx.createLinearGradient(0, padding, 0, height - padding);
    fillGrd.addColorStop(0, "rgba(99, 102, 241, 0.15)"); // Indigo glow
    fillGrd.addColorStop(1, "rgba(99, 102, 241, 0.0)");

    // Begin path for fill
    ctx.beginPath();
    ctx.moveTo(0, height);
    ctx.lineTo(points[0].x, points[0].y);

    // Draw bezier curves
    for (let i = 0; i < points.length - 1; i++) {
      const xc = (points[i].x + points[i + 1].x) / 2;
      const yc = (points[i].y + points[i + 1].y) / 2;
      ctx.quadraticCurveTo(points[i].x, points[i].y, xc, yc);
    }
    // Curve to last point
    ctx.lineTo(points[points.length - 1].x, points[points.length - 1].y);
    ctx.lineTo(width, height);
    ctx.closePath();
    ctx.fillStyle = fillGrd;
    ctx.fill();

    // Draw stroke curve
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 0; i < points.length - 1; i++) {
      const xc = (points[i].x + points[i + 1].x) / 2;
      const yc = (points[i].y + points[i + 1].y) / 2;
      ctx.quadraticCurveTo(points[i].x, points[i].y, xc, yc);
    }
    ctx.lineTo(points[points.length - 1].x, points[points.length - 1].y);
    ctx.strokeStyle = "rgb(99, 102, 241)"; // Indigo premium line Accent
    ctx.lineWidth = 2.5;
    ctx.shadowColor = "rgba(99, 102, 241, 0.4)";
    ctx.shadowBlur = 8;
    ctx.stroke();
    ctx.shadowBlur = 0; // reset shadow

    // Draw active dot at the last point
    const lastPoint = points[points.length - 1];
    ctx.beginPath();
    ctx.arc(lastPoint.x, lastPoint.y, 5, 0, Math.PI * 2);
    ctx.fillStyle = "#6366f1";
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "#ffffff";
    ctx.stroke();

    // Draw max throughput value label
    ctx.fillStyle = "rgba(100, 116, 139, 0.6)";
    ctx.font = "10px monospace";
    ctx.textAlign = "right";
    const k = 1024;
    const isMB = maxVal >= k * k;
    const formattedPeak = isMB 
      ? `${(maxVal / (k * k)).toFixed(1)} MB/s`
      : `${(maxVal / k).toFixed(0)} KB/s`;
    ctx.fillText(`Peak: ${formattedPeak}`, width - 10, padding - 2);

  }, [history, maxRange]);

  return (
    <div className="relative w-full h-full bg-slate-950/20 rounded-xl overflow-hidden border border-slate-500/10 p-1">
      <canvas ref={canvasRef} className="w-full h-full block" />
    </div>
  );
}

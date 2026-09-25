/**
 * Adapted from Hand-to-TeX web/src/logic/inference.ts at cf27b992950eba3b1d3600bf18be44868d217917.
 * Copyright (c) 2026 Projekt: Deep Learning 2026. MIT; see THIRD_PARTY_NOTICES.md.
 * Keep feature order and normalization identical to the pretrained model.
 */
import type { TracePoint } from "./MathRecognition";
export interface InferenceFeatures { flatData: Float32Array; numPoints: number; numFeatures: number }
const EPS = 1e-6;

export function extractFeatures(traces: readonly TracePoint[][]): InferenceFeatures {
    if (traces.length === 0) return { flatData: new Float32Array(0), numPoints: 0, numFeatures: 12 };

    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let minT = Infinity, maxT = -Infinity;

    for (const trace of traces) {
        for (const pt of trace) {
            const [x, y, t] = pt;
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
            if (t < minT) minT = t; if (t > maxT) maxT = t;
        }
    }

    const xyRange = Math.max(maxX - minX, maxY - minY) + EPS;
    const tRange = maxT - minT + EPS;
    const exprYSpan = (maxY - minY) + EPS;

    const featuresList: number[][] = [];

    for (const trace of traces) {
        let traceMinY = Infinity, traceMaxY = -Infinity;
        for (const pt of trace) {
            if (pt[1] < traceMinY) traceMinY = pt[1];
            if (pt[1] > traceMaxY) traceMaxY = pt[1];
        }
        const traceYCenter = 0.5 * (traceMinY + traceMaxY);
        const traceYSpan = traceMaxY - traceMinY;

        const speeds: number[] = [], uxs: number[] = [], uys: number[] = [], dists: number[] = [];

        for (let i = 0; i < trace.length; i++) {
            const pt = trace[i]!;
            const xNorm = (pt[0] - minX) / xyRange;
            const yNorm = (pt[1] - minY) / xyRange;
            const tNorm = (pt[2] - minT) / tRange;
            const yCenterRel = (traceYCenter - minY) / exprYSpan;
            const ySpanRel = traceYSpan / exprYSpan;

            let dx = 0, dy = 0, dt = 0, speed = 0, dist = 0, ux = 0, uy = 0;

            if (i > 0) {
                const prevPt = trace[i - 1]!;
                const prevXNorm = (prevPt[0] - minX) / xyRange;
                const prevYNorm = (prevPt[1] - minY) / xyRange;
                const prevTNorm = (prevPt[2] - minT) / tRange;

                dx = xNorm - prevXNorm;
                dy = yNorm - prevYNorm;
                dt = tNorm - prevTNorm;
                dist = Math.hypot(dx, dy);
                speed = dt > EPS ? dist / dt : 0;
                ux = dist > EPS ? dx / dist : 0;
                uy = dist > EPS ? dy / dist : 0;
            }

            speeds.push(speed); uxs.push(ux); uys.push(uy); dists.push(dist);

            let curve = 0, accTan = 0;
            if (i > 0) {
                const prevSpeed = speeds[i - 1]!;
                accTan = dt > EPS ? (speed - prevSpeed) / dt : 0;
                if (i > 1) {
                    const prevUx = uxs[i - 1]!, prevUy = uys[i - 1]!;
                    const dTheta = Math.atan2(prevUx * uy - prevUy * ux, prevUx * ux + prevUy * uy);
                    curve = dist > EPS ? dTheta / dist : 0;
                }
            }

            const isStrokeStart = i === 0 ? 1.0 : 0.0;
            featuresList.push([xNorm, yNorm, tNorm, dx, dy, dt, speed, curve, accTan, isStrokeStart, yCenterRel, ySpanRel]);
        }
    }

    const colsToNorm = [3, 4, 5, 6, 7, 8];
    for (const col of colsToNorm) {
        let sum = 0;
        for (const row of featuresList) sum += row[col]!;
        const mean = sum / featuresList.length;

        let varianceSum = 0;
        for (const row of featuresList) varianceSum += Math.pow(row[col]! - mean, 2);
        const std = Math.sqrt(varianceSum / featuresList.length) + EPS;

        for (const row of featuresList) {
            row[col] = Math.max(-5.0, Math.min(5.0, (row[col]! - mean) / std));
        }
    }

    const numPoints = featuresList.length;
    const flatFeatures = new Float32Array(numPoints * 12);
    let ptr = 0;
    for (const row of featuresList) {
        for (const val of row) flatFeatures[ptr++] = val;
    }

    return { flatData: flatFeatures, numPoints, numFeatures: 12 };
}

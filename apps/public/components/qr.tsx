'use client';

import qrcode from 'qrcode-generator';
import { useMemo } from 'react';

const QUIET = 4;

/**
 * The pass's QR, drawn here from the payload the API returned: it is never
 * sent anywhere to be rendered. One SVG path, no inline style.
 */
export function Qr({ payload, label }: { payload: string; label: string }) {
  const { size, path } = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(payload);
    qr.make();
    const count = qr.getModuleCount();
    let d = '';
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count; col++) {
        if (qr.isDark(row, col)) d += `M${col + QUIET} ${row + QUIET}h1v1h-1z`;
      }
    }
    return { size: count + QUIET * 2, path: d };
  }, [payload]);

  return (
    <svg className="qr" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}

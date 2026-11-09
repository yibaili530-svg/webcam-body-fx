// Single source of truth for screen <-> source mapping (object-fit: cover + mirror).
// Screen: x right, y down, normalized to the viewport. Source: unmirrored video frame,
// x right, y down, normalized. Video, person mask and hand matte all use it.

/** Visible sub-rectangle of the source, in normalized source coordinates. */
export function coverCrop(srcW, srcH, dstW, dstH) {
  if (!(srcW > 0 && srcH > 0 && dstW > 0 && dstH > 0)) return { x: 0, y: 0, w: 1, h: 1 };
  const srcAspect = srcW / srcH;
  const dstAspect = dstW / dstH;
  if (srcAspect > dstAspect) {
    const w = dstAspect / srcAspect;
    return { x: (1 - w) / 2, y: 0, w, h: 1 };
  }
  const h = srcAspect / dstAspect;
  return { x: 0, y: (1 - h) / 2, w: 1, h };
}

export function screenToSource(x, y, crop) {
  return { x: crop.x + (1 - x) * crop.w, y: crop.y + y * crop.h };
}

export function sourceToScreen(x, y, crop) {
  return { x: 1 - (x - crop.x) / crop.w, y: (y - crop.y) / crop.h };
}

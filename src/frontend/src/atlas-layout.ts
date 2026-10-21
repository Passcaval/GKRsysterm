export type AtlasPoint = { x: number; y: number };

/** Pixel positions. Catalogue coordinates are often identical placeholders, so
 * browsing positions are assigned locally and never imply admission risk. */
export function layoutAtlas(
  schools: ReadonlyArray<{ id: string }>,
  viewportWidth: number,
  viewportHeight: number,
  reserveBoat = true,
) {
  const width = Math.max(240, viewportWidth);
  const viewport = Math.max(180, viewportHeight);
  const padding = 12;
  const columns = Math.max(1, Math.floor((width - padding * 2) / 164));
  const cellWidth = (width - padding * 2) / columns;
  const nodeWidth = Math.min(220, cellWidth - 24);
  const nodeHeight = 104;
  const rowHeight = 144;
  const boat = {
    x: padding + cellWidth * (Math.floor((columns - 1) / 2) + 0.5),
    y: Math.max(columns === 1 ? 238 : 94, viewport - 100),
  };
  const positions = new Map<string, AtlasPoint>();
  let slot = 0;
  let height = Math.max(viewport, reserveBoat ? boat.y + 96 : 0);
  for (const school of schools) {
    if (positions.has(school.id)) continue;
    let point: AtlasPoint;
    do {
      const column = slot % columns;
      const row = Math.floor(slot / columns);
      // Small, deterministic offsets keep the constellation airy while leaving
      // a full label-sized gap. Appending a page never moves earlier schools.
      const offset = ((slot * 7) % 5) - 2;
      point = {
        x: padding + cellWidth * (column + 0.5) + offset * 3,
        y: 68 + row * rowHeight + offset * 5,
      };
      slot++;
    } while (
      reserveBoat &&
      Math.abs(point.x - boat.x) < nodeWidth / 2 + 76 &&
      Math.abs(point.y - boat.y) < nodeHeight / 2 + 86
    );
    positions.set(school.id, point);
    height = Math.max(height, point.y + nodeHeight / 2 + 24);
  }
  return { width, height, nodeWidth, nodeHeight, positions, boat };
}

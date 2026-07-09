// GeoJSON geometry -> WKT serialiser. Mirrors govscraper/geo/coords.py geom_to_wkt.
//
// Used by the GovMap scraper to emit a `geometry_wkt` column in the CSV with
// full ITM (EPSG:6991) coordinates — matching the Main scraper's CSV format
// so downstream tooling (QGIS "Add Delimited Text Layer", CKAN, scripts) sees
// the same shape regardless of which side produced the file.

function coordStr(c) {
  return `${c[0]} ${c[1]}`;
}

export function geomToWkt(geom) {
  if (!geom) return '';
  const t = geom.type;
  const coords = geom.coordinates;
  if (!coords) return '';

  switch (t) {
    case 'Point':
      return `POINT(${coordStr(coords)})`;
    case 'MultiPoint':
      return 'MULTIPOINT(' + coords.map(c => `(${coordStr(c)})`).join(', ') + ')';
    case 'LineString':
      return 'LINESTRING(' + coords.map(coordStr).join(', ') + ')';
    case 'MultiLineString':
      return 'MULTILINESTRING(' + coords.map(
        line => '(' + line.map(coordStr).join(', ') + ')'
      ).join(', ') + ')';
    case 'Polygon':
      return 'POLYGON(' + coords.map(
        ring => '(' + ring.map(coordStr).join(', ') + ')'
      ).join(', ') + ')';
    case 'MultiPolygon':
      return 'MULTIPOLYGON(' + coords.map(
        poly => '(' + poly.map(
          ring => '(' + ring.map(coordStr).join(', ') + ')'
        ).join(', ') + ')'
      ).join(', ') + ')';
    default:
      return '';
  }
}

// OrientedTubeGlyph.js
// Flat unlit pass for CPU-generated vector-field tube glyphs.
//
// Geometry is built by OrientedTubeGlyphField.ts. Color is packed per vertex:
//   texture1 = (r, g)
//   texture2 = (b, a)
// Every vertex in a tube receives the same packed color, so each glyph renders
// as one solid palette swatch while neighboring tubes may differ.

output_vec3 transformedPosition;
output_vec3 transformedNormal;
output_vec4 vertexColor;

void main() {
    vec3 pos = system.getSurfacePositionObjectSpace();
    vec3 normal = normalize(system.getSurfaceNormalObjectSpace());
    vec2 colorRG = system.getSurfaceUVCoord1();
    vec2 colorBA = system.getSurfaceUVCoord2();
    vec3 rgb = clamp(vec3(colorRG.x, colorRG.y, colorBA.x), 0.0, 1.0);
    float alpha = clamp(colorBA.y, 0.0, 1.0);

    transformedPosition = pos;
    transformedNormal = normal;
    vertexColor = vec4(rgb * alpha, alpha);
}

// CarFlowRibbonGlyph.js
// Dedicated GPU animation shader for the aerodynamic slice's lightweight
// ribbon glyphs. CPU builds the glyph mesh only when the slice changes.
//
// Packed attributes from CarFlowStreamlines.ts:
//   texture0 = (alongGlyph, phase)
//   texture1 = (r, g)
//   texture2 = (b, a)

input_float Time;
input_float PhaseSpeed;
input_float PulseStrength;
input_float TemporalBend;

output_vec3 transformedPosition;
output_vec3 transformedNormal;
output_vec4 vertexColor;

void main() {
    vec3 pos = system.getSurfacePositionObjectSpace();
    vec3 normal = normalize(system.getSurfaceNormalObjectSpace());
    vec2 uv0 = system.getSurfaceUVCoord0();
    vec2 colorRG = system.getSurfaceUVCoord1();
    vec2 colorBA = system.getSurfaceUVCoord2();

    vec3 rgb = clamp(vec3(colorRG.x, colorRG.y, colorBA.x), 0.0, 1.0);
    float alpha = clamp(colorBA.y, 0.0, 1.0);

    transformedPosition = pos;
    transformedNormal = normal;
    vertexColor = vec4(rgb, alpha);
}

// ArtemisPathProgress.js
// Dedicated unlit pass for the Artemis II completion path.
//
// Geometry packs normalized path progress in texture0.x. The material drives
// Progress from 0..1 so the full mesh can stay static while alpha reveals the
// flown portion.

input_vec4 BaseColor;
input_float Progress;
input_float Feather;

output_vec3 transformedPosition;
output_vec4 vertexColor;

void main() {
    vec3 pos = system.getSurfacePositionObjectSpace();
    vec2 uv = system.getSurfaceUVCoord0();
    float pathT = clamp(uv.x, 0.0, 1.0);
    float progress = clamp(Progress, 0.0, 1.0);
    float feather = max(0.001, Feather);
    vec4 color = clamp(BaseColor, 0.0, 1.0);

    float reveal = 1.0 - smoothstep(progress, progress + feather, pathT);
    float alpha = color.a * reveal;

    transformedPosition = pos;
    vertexColor = vec4(color.rgb * alpha, alpha);
}

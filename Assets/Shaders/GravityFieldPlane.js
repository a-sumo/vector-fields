// GravityFieldPlane.js
// GPU gravity field visualization on a flat XZ plane.
// The plane is a stable potential surface: color and contour rings describe
// potential, while separate tube glyph geometry carries field direction.

input_vec3 EarthPos;
input_vec3 MoonPos;
input_float EarthMass;
input_float MoonMass;
input_float Softening;
input_float WellDepth;
input_float DepthScale;
input_float ContourCount;
input_float ContourThickness;
input_float FlowSpeed;
input_float FlowScale;
input_vec4 ContourColor;
input_vec4 ColorLow;
input_vec4 ColorHigh;
input_vec4 EarthTint;
input_vec4 MoonTint;
input_float OpacityScale;
input_vec4 FieldLineColor;
input_float FieldLineDensity;
input_float FieldLineWidth;

output_vec3 transformedPosition;
output_vec4 vertexColor;

void main() {
    vec3 pos = system.getSurfacePositionObjectSpace();
    vec3 sampleP = vec3(pos.x, 0.0, pos.z);

    // Softening avoids 1/0 at the body center. Moon gets a tighter core so its
    // well stays sharp despite being far smaller than Earth's.
    float soft = max(Softening, 0.01);
    float softE2 = soft * soft;
    float softM2 = soft * soft * 0.45 * 0.45;

    vec3 dE = sampleP - EarthPos;
    vec3 dM = sampleP - MoonPos;
    float rE = sqrt(dot(dE, dE) + softE2);
    float rM = sqrt(dot(dM, dM) + softM2);

    float potE = EarthMass / rE;
    float potM = MoonMass / rM;
    float potential = potE + potM;

    // Vertical displacement = scaled potential. Negative Y dips down into the well.
    float displacement = -potential * WellDepth * DepthScale;
    transformedPosition = vec3(pos.x, displacement, pos.z);

    // Field vector for tube alignment (XZ only, force = sum of mass*(body-pos)/r^3).
    float invE3 = 1.0 / (rE * rE * rE);
    float invM3 = 1.0 / (rM * rM * rM);
    vec2 fieldXZ = vec2(EarthPos.x - sampleP.x, EarthPos.z - sampleP.z) * EarthMass * invE3
                 + vec2(MoonPos.x - sampleP.x,  MoonPos.z  - sampleP.z) * MoonMass  * invM3;
    float fieldMag = length(fieldXZ);
    vec2 fieldDir = (fieldMag > 0.0001) ? fieldXZ / fieldMag : vec2(1.0, 0.0);

    // Heatmap by potential intensity. The log keeps the Earth well readable
    // while preserving the Moon's smaller field. The low end is widened so the
    // tint reaches across the whole plane instead of clustering at the cores.
    float logPotential = log(1.0 + potential * 0.6);
    float intensity = smoothstep(0.18, 2.45, logPotential);
    intensity = pow(clamp(intensity, 0.0, 1.0), 1.2);
    vec3 baseColor = mix(ColorLow.rgb, ColorHigh.rgb, intensity);

    // Formal iso-potential contours. Keep these static and crisp: they are the
    // red/orange scalar-field layer, not an atmospheric glow.
    float isoMetric = 1.0 / (0.35 + potential);
    float isoPhase = isoMetric * ContourCount * 1.4;
    float isoDist = abs(fract(isoPhase) - 0.5) * 2.0;
    float isoWidth = clamp(ContourThickness, 0.01, 0.45);
    float isoCore = 1.0 - smoothstep(isoWidth * 0.62, isoWidth, isoDist);
    float isoRim = 1.0 - smoothstep(isoWidth, min(1.0, isoWidth * 1.55), isoDist);
    float contourMask = clamp(isoCore + isoRim * 0.16, 0.0, 1.0) * ContourColor.a;

    // Lightweight reference lines. These are intentionally anchored to plane
    // coordinates instead of local field direction; directional field glyphs
    // are the tube layer. The old local-direction stripe method sheared into
    // large crescent bands near wells because direction changes per pixel.
    vec2 gridPhase = vec2(sampleP.x, sampleP.z) * max(FieldLineDensity, 0.05);
    vec2 gridDist = abs(fract(gridPhase) - 0.5) * 2.0;
    float fieldLineDist = min(gridDist.x, gridDist.y);
    float fieldLineWidth = clamp(FieldLineWidth, 0.005, 0.45);
    float fieldLineMask = (1.0 - smoothstep(fieldLineWidth * 0.52, fieldLineWidth, fieldLineDist))
                        * FieldLineColor.a
                        * 0.45;

    vec3 finalColor = baseColor;
    finalColor = mix(finalColor, ContourColor.rgb, contourMask);
    finalColor = mix(finalColor, FieldLineColor.rgb, fieldLineMask);
    finalColor = finalColor + ContourColor.rgb * (isoRim * 0.04);
    finalColor = clamp(finalColor * 1.15, 0.0, 1.0);

    float alpha = clamp(OpacityScale, 0.0, 1.0);
    vertexColor = vec4(finalColor * alpha, alpha);
}

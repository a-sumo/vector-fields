# Vector Fields

A Lens Studio project for exploring vector fields in augmented reality on Spectacles.

It visualizes gravitational fields, magnetic dipoles, Earth winds, aerodynamic airflow, and expansion, vortex, and wave patterns.

## What's Inside

The experience is organized as a guided course with two chapters.

### Theory

The opening chapter teaches how to read a vector field before you start playing with one.

- **Definition** introduces what a vector field is and how direction and magnitude are drawn at each point in space.
- **Field Metrics** shows the quantities that describe a field: divergence, curl, and magnitude.
- **Analytical Examples** lets you step through canonical patterns to build intuition, including expansion, contraction, curl, and motion.

### Real-World Examples

The second chapter drops you into four physical fields you can grab and rearrange.

- **Gravitational Fields** place the Earth and Moon in a shared gravity field, with an optional Artemis II overlay that carries the crewed Orion path through the field.
- **Magnetism** lets you move dipole magnets and watch the field lines recompute from their dipole moments, shown as flow lines, particles, or arrows.
- **Earth Winds** wrap real forecast wind data around a globe, with streamlines and storm markers you can inspect.
- **Aerodynamics** runs a wind-tunnel style flow around a car, with a draggable cross-section slice that reveals how the airflow compresses, separates, and curls around the body.

Throughout the examples you can switch the rendering mode between flow lines, particles, and arrows, and recolor the field with the Jet, Viridis, and Plasma color maps.

## Open The Project

1. Install Lens Studio 5.15 or newer.
2. Open `Vector-Fields.esproj`.
3. Run the scene from the included `Assets/Scene.scene`.

The Spectacles Interaction Kit and UIKit packages required by the project are included in `Packages/`.

## Included

- `Assets/` contains the Lens scene, scripts, prefabs, shaders, materials, meshes, textures, and baked data used by the project.
- `Packages/` contains the Lens Studio packages the project references.
- `Support/` contains editor type declarations for local TypeScript tooling.
- `Vector-Fields.esproj` is the Lens Studio project file.

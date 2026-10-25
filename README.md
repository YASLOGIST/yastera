# Orbital Earth 🌍

A physically based, real-time **Orbital Earth** render. Everything you see is solved
per pixel from real NASA imagery and standard atmospheric physics — there is no baked
lighting in the maps, and no placeholders anywhere in the scene.

Built with **Three.js**, hand-written **GLSL ES 3.00** shaders, and **Vite**.

---

## 🌟 What the renderer actually does

### 1. Four-layer planet

| Layer | Radius | What it is |
| --- | --- | --- |
| Surface | `1.000` | land + ocean, shaded per pixel |
| Cloud deck | `1.0022` | tropospheric clouds (~14 km) |
| Cirrus deck | `1.0041` | procedural high ice clouds (~26 km) |
| Atmosphere | `1.028` | single-scattering limb (~178 km) |

**Surface** — the albedo map is deliberately un-lit; relief, ocean optics, cloud
shadows and haze are all computed in the fragment shader.

- Terrain relief from the SRTM/GEBCO height field (tangent-space normals, with the
  grazing-angle accentuation that makes mountain ranges pop near the terminator).
- **Ocean shading**: depth-stratified water colour, Schlick–Fresnel sky term
  (gated to the day side — the night ocean stays pitch black), and a Cook–Torrance
  GGX sun glitter whose roughness widens with altitude.
- **Real sunlight colour**: sunlight is transmitted through the atmosphere per pixel,
  so the terminator reddens on its own instead of being painted on.
- **Urban detail on descent**: the Black Marble city map drives procedurally generated
  street grids, district masks and farmland mosaic — detail appears only when a texel
  still covers several pixels, so it never aliases.
- **Night side**: Black Marble emission with the sensor's airglow pedestal removed,
  cloud occlusion and the underglow that clouds over a city catch in real ISS photos.

**Cloud deck** — lit like a participating medium rather than a white sprite:

- Shading normal derived from the density gradient (analytic tangent frame).
- Three-tap march toward the sun for self-shadowing, so cumulus cores fall into
  shade and edges glow.
- Henyey–Greenstein forward phase → silver lining when backlit.
- Sub-texel structure fades with the screen footprint of a texel (no aliasing).

**Cirrus deck** — generated on the sphere *at render time*: a second texture tap
would inherit the source mosaic's latitude stretch and its tile seams. Fibrous,
jet-stream-stretched, independently drifting.

**Atmosphere** — a real single-scattering march:

- Only rays that *miss* the planet are integrated; rays that hit the surface get
  their airlight from the surface shader (otherwise the scattering is counted twice
  and the disc turns milky).
- The sample points concentrate around the ray's closest approach, because Earth's
  atmosphere is only 0.5 % of the radius — uniform sampling steps straight over it.
- Real Rayleigh (680/550/440 nm) and Mie coefficients with per-sample sun
  transmittance, plus a faint O I airglow band on the night limb.

### 2. Deep space

- ~9 000 stars with a real spectral-class colour distribution and a power-law
  magnitude distribution, concentrated toward the galactic plane.
- Procedural **Milky Way** band: star clouds, dust lanes and a Sagittarius bulge.
- Diffraction spikes only on the brightest stars; no twinkle (there is no air).

### 3. Orbital-to-city navigation

- Logarithmic depth buffer: 13 380 km down to 50 km with no clipping or z-fighting.
- Quintic-eased camera arcs to 12 hubs, with live telemetry cards.
- Click the globe near a hub to fly there, or use the ribbon.

### 4. Light and smooth

- HDR render target with 4× MSAA (falls back to FXAA when the GPU can't do
  multisampled half-float).
- Adaptive resolution: drops pixel ratio when the frame budget slips, recovers
  when there is headroom. `?msaa=0` forces the FXAA path.
- Shaders are precompiled during the loader, so the first frame after load is
  already smooth.

---

## 🚀 Getting started

```bash
npm install
npm run dev          # http://localhost:5173
```

The dev server binds `0.0.0.0` and accepts proxied preview hosts.

### Textures

`public/textures/` ships with five 4096×2048 maps. `predev` / `prebuild` verify
them and skip the pipeline when they are valid:

| File | Contents |
| --- | --- |
| `earth_day.jpg` | True-colour land albedo + neutral deep-water base |
| `earth_night.jpg` | Black Marble emission, airglow pedestal removed |
| `earth_specular.jpg` | Anti-aliased ocean mask |
| `earth_topology.jpg` | Continuous height field (bathymetry + SRTM) |
| `earth_clouds.jpg` | Cloud optical density, median-filtered |

```bash
npm run fetch-assets           # rebuild anything missing
npm run fetch-assets -- --force  # rebuild all five
```

The cloud map is repaired during generation (5×5 median then a vertical pass) because
the source mosaic carries salt-and-pepper noise and swath seams that are clearly
visible from 50 km.

### Verification

```bash
npm run check:shaders
```

Composes every shader the way the app does, resolves three's `#include` chunks,
parses and validates each stage with [naga](https://github.com/gfx-rs/wgpu) (the wgpu
shader compiler), and cross-checks that every uniform a shader declares is actually
supplied by the JavaScript. It runs without a GPU, so it works in CI.

### Production

```bash
npm run build
npm run preview
```

---

## 🎛️ Live controls (Studio panel)

| Group | Controls |
| --- | --- |
| Solar & Ephemeris | real-UTC sync, manual sun lat/lon, intensity |
| Atmosphere & Scattering | Rayleigh density, city emission |
| Ocean & Terrain | sun glitter, sea roughness, wave detail, terrain detail, relief |
| Cloud Decks | zonal drift, density, cumulus relief |
| Orbital Dynamics | auto-spin, spin velocity |
| Optics & Post | exposure, bloom strength/radius/threshold, stars, Milky Way |

---

## 🛠️ Tech stack

- **Three.js** — renderer, OrbitControls, EffectComposer, UnrealBloomPass
- **GLSL ES 3.00** — surface, cloud, atmosphere, star and Milky Way shaders
- **Vite** — dev server and bundler
- **lil-gui** — studio controls
- **jpeg-js / pngjs** — the offline texture pipeline

---

## 📄 License

MIT.

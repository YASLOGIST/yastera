# Orbital Earth 🌍

A physically based, real-time **Orbital Earth** simulation. Earth illumination, cloud
shading and atmospheric scattering are rendered from Earth imagery and analytic
approximations rather than baked scene lighting. Mission overlays such as the LEO
tracker are clearly labeled simulations unless they are connected to a live data source.

Built with **Three.js**, hand-written **GLSL ES 3.00** shaders, and **Vite**.

---

## 🌟 What the renderer actually does

### 1. Four-layer planet

| Layer | Radius | What it is |
| --- | --- | --- |
| Surface | `1.0000` | land + ocean, shaded per pixel |
| Cloud tops | `1.0020` | shaped tropospheric clouds (~13 km) |
| Upper cloud veil | `1.0027` | high anvils / cirrus approximation (~17 km) |
| Atmosphere | `1.0280` | single-scattering limb (~178 km) |

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

**Cloud deck** — the redundant lower shell was removed: it repeated the same
2D coverage map and added opacity without adding observed cloud-height data.
The remaining main deck and upper veil each have a distinct role:

- Coverage stays soft in orbit, then resolves into cloud puffs and clear gaps on
  descent instead of magnifying into grey smoke.
- Shading normals follow the cloud-density gradient; a three-tap, latitude-aware
  sunward march adds self-shadowing without distorting longitude/latitude distances.
- The high veil is restricted to dense storm systems and uses a faster upper-level
  drift plus globe-local ice filaments. Rare, soft night flashes are tied to dense
  storm cells rather than placed randomly across the globe. These are approximations,
  not a separate satellite-observed cloud-height map.
- Screen-footprint LOD filters procedural detail to avoid UV seams, polar pinching
  and sub-pixel shimmer. Studio controls expose microdetail and let you compare
  the main deck, high veil and atmospheric limb independently.

**Atmosphere** — a real single-scattering march:

- Only rays that *miss* the planet are integrated; rays that hit the surface get
  their airlight from the surface shader (otherwise the scattering is counted twice
  and the disc turns milky).
- Twenty deterministic squared-distance samples span the complete atmospheric
  chord and cluster around closest approach, resolving dense air without adding
  grain or increasing the march budget.
- Rayleigh and aerosol extinction use their separate scale heights; each sample
  includes both Sun-to-sample and sample-to-camera transmittance, plus a faint
  ~95 km O I airglow band on the night limb.

### 2. Deep space

- ~9 000 stars with a real spectral-class colour distribution and a power-law
  magnitude distribution, concentrated toward the galactic plane.
- Procedural **Milky Way** band: star clouds, dust lanes and a Sagittarius bulge.
- Diffraction spikes only on the brightest stars; no twinkle (there is no air).

### 3. Orbital-to-city navigation

- Logarithmic depth buffer: 13 380 km down to 50 km with no clipping or z-fighting.
- Quintic-eased camera arcs to 12 hubs, with live telemetry cards and local times
  derived from IANA time zones (including daylight-saving changes).
- Click the globe near a hub to fly there, or use the ribbon. Dismissing a city
  card leaves a persistent route back to orbital view.

### 4. Simulated low-Earth-orbit mission overlay

- A deterministic, ISS-class circular orbit at 420 km altitude and 51.6° inclination,
  calculated from the standard Earth gravitational parameter. Its period and speed
  are derived from the same orbital model.
- A moving satellite marker, orbital path, Earth-fixed ground point, changing
  latitude/longitude, orbit phase, and a simplified cylindrical Earth-shadow status.
- Adjust simulation time from paused to 240× in Studio, hide/show the overlay, or
  have the camera follow the marker. The ground point accounts for the rotating
  Earth, not just the orbital plane.
- This is an educational visualization, **not live spacecraft telemetry**. The
  orbit uses Earth-normalized scale; its billboard marker is enlarged for legibility.
  Orbit time warp is independent of the globe's visual spin. No satellite feed or
  external tracking service is queried.

### 5. Rendering budget and quality

- HDR render target with 4× MSAA on eligible small desktop buffers; constrained,
  high-DPR and large-buffer cases use FXAA. `?msaa=0` forces the FXAA path.
- Adaptive resolution lowers the pixel ratio when measured frame time falls behind
  the display's observed refresh rate, and recovers when headroom returns.
- Shaders are compiled during the loader to avoid first-use shader compilation in
  the active scene. This does not imply a particular device frame rate.
- The Studio panel is code-split and fetched only when opened; its controls do
  not add to the initial JavaScript request.

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
npm run check
```

Runs shader/compiler and uniform-contract checks, static JavaScript runtime
checks, city-directory/time-zone invariants, LEO orbit geometry, and DPR-aware
post-processing sizing tests. The shader check composes each
program the way the app does, resolves Three.js `#include` chunks, parses and
validates each stage with [naga](https://github.com/gfx-rs/wgpu) (the wgpu shader
compiler), and cross-checks that every declared uniform is supplied by JavaScript.
It runs without a GPU, so it works in CI. Use `npm run check:shaders` to run only
the shader validation.

### Production

```bash
npm run build
npm run preview
```

### Performance profile

```bash
npm run profile:rendering
```

This reports asset/geometry and post-processing target memory estimates for phone,
tablet, Retina and 1× desktop profiles. For live device measurements, open the app
with `?profile=1`: the HUD shows RAF FPS/frame time, render calls/triangles, Three.js
texture/geometry counts, an estimated GPU allocation, and CPU render-submit time
(the latter is not a GPU timer). The app caps physical render pixels and reserves
4× HDR MSAA for small, fine-pointer targets; constrained/high-DPR cases use FXAA.

---

## 🎛️ Live controls (Studio panel)

| Group | Controls |
| --- | --- |
| Solar & Ephemeris | real-UTC sync, manual sun lat/lon, intensity |
| Atmosphere & Scattering | Rayleigh density, limb visibility, city emission |
| Ocean & Terrain | sun glitter, sea roughness, wave detail, terrain detail, relief |
| Cloud Decks | zonal drift, density, relief, microdetail, night-flash intensity, main/high-layer visibility |
| Orbital Dynamics | auto-spin, spin velocity, simulated LEO visibility, 0–240× orbit time warp |
| Optics & Post | exposure, bloom strength/radius/threshold, stars, Milky Way |

The satellite icon in the upper-right opens its telemetry panel. Its **Track Satellite**
button follows the illustrative marker and yields cleanly to city flights and orbit reset.

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

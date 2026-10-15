# Orbital Earth Simulation 🌍✨

A cinema-grade, physically based **Orbital Earth Simulation** matching NASA Blue Marble / Black Marble reference photography and high-dynamic-range (HDR) orbital renders (120 FPS target, zero placeholders, zero runtime errors).

Built with **Three.js**, custom **GLSL 3.0 shaders**, and **Vite**.

![Orbital Earth](https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/textures/planets/earth_atmos_2048.jpg)

---

## 🌟 Key Features & Optical Physics

### 1. 3-Sphere Planetary Architecture
- **Planetary Surface (r = 1.000)**:
  - **Tangent-Space Terrain Relief**: Central-differences normal perturbation on SRTM/GEBCO elevation data with grazing angle accentuation along the terminator.
  - **Cook-Torrance GGX Specular Glint**: Realistic microfacet ocean solar reflections with Schlick-Fresnel water reflectance and cloud shadow masking.
  - **Authentic Rayleigh Aerial Perspective**: Physical air-mass radiative transfer ($m = \frac{1}{\cos\theta + 0.06}$) providing crisp central contrast and realistic limb aerial haze.
  - **NASA Black Marble 2016 Night Lights**: Multi-tier color spectrum (2100K sodium-vapor amber, 2700K suburban gold, 4500K LED core white) with HDR filament enhancement and cloud underglow. Pure pitch-black oceans (`#000000`).
- **Volumetric-Feel Cloud Shell (r = 1.0022)**:
  - **Forward Mie Scattering**: Henyey-Greenstein phase function creating radiant silver-lining coronas when backlit by the Sun.
  - **High-Altitude Sunset Illumination**: Terminator storm clouds catch setting sunlight longer than terrain, glowing in peach and gold.
  - **Sub-Cloud Shadows**: Sun-projected shadows cast onto the planetary surface.
- **Outer Atmospheric Scattering Halo (r = 1.016)**:
  - **Physical Kármán Line Scale (~102 km)**: Razor-thin, brilliant electric-cyan atmospheric skin hugging the globe.
  - **Stratospheric Ozone Absorption**: Deep indigo/violet tint in upper layers transitioning to fiery crimson-gold along the terminator.

### 2. Deep Orbital-to-City Zoom & City Intelligence Engine
- **Logarithmic Depth Buffer**: Smooth descent from deep space (13,380 km) down to urban flight altitude (50 km) with zero near-plane clipping and zero z-fighting.
- **Anti-Pixelation Hermite Sampling**: 4-tap continuous Hermite sub-texel filter prevents blurry square pixelation.
- **Zoom-Adaptive Micro-Detail Synthesis**: Procedural multi-scale urban street grid arteries, micro-relief, and water ripples injected seamlessly as the camera descends.
- **Interactive City Navigation & Fly-To**:
  - Horizontal glass ribbon with 12 global hubs: Cairo, Riyadh, Dubai, Tokyo, New York, London, Paris, Singapore, Shanghai, Los Angeles, Rio de Janeiro, Cape Town.
  - Smooth quintic-eased spherical camera arc transitions (`flyToCity`).
  - Real-time telemetry cards: Coordinates, live local time, population, elevation, climate, and key landmarks.

### 3. Real-Time Solar Synchronization
- Live UTC ephemeris calculation matching the real subsolar point on Earth.
- Manual solar override with interactive studio controls.
- UnrealBloomPass post-processing calibrated for HDR glints without washing out continents.

---

## 🚀 Getting Started

### Prerequisites
- Node.js (v18+)
- npm or yarn

### Installation
```bash
# Clone the repository
git clone https://github.com/YASLOGIST/orbital-earth.git
cd orbital-earth

# Install dependencies
npm install

# Start the development server (automatically checks and verifies 4K NASA textures)
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) in your browser.

### Production Build
```bash
npm run build
npm run preview
```

---

## 🛠️ Tech Stack
- **Three.js** (Core 3D WebGL Engine, OrbitControls, EffectComposer)
- **GLSL 3.0** (Custom PBR surface, cloud, and halo shaders)
- **Vite** (Next-generation frontend tooling)
- **lil-gui** (Interactive telemetry and graphics studio controls)

---

## 📄 License
MIT License. Created for high-fidelity planetary visualization.
